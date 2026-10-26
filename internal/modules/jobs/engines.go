package jobs

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/httpjson"
	"github.com/DebakelOrakel/casas-eternas/internal/token"
)

// THE PIPELINE BUILDS (docs/decisions/engine-releases.md, fork 5): the
// files of a pipeline's release — the job worker's pipeline module, the
// native engine per platform, the WASM build — for a worker that runs another
// pipeline than the one it was shipped with. GET
// /v1/jobs/engines/{pipeline}/{file} answers with a link to the file in the
// artifact store. On a miss it downloads the file from the release of the
// pipeline (releaseTag: `engine-<pipeline>`, .github/workflows/
// engine-release.yml; a history's `history-<version>`),
// checks it against the release's SHA256SUMS, and stores it first. A
// worker never talks to the release's host.

// PipelineFiles keeps the files of the releases. cmd/ composes it over the
// artifact store (artifacts.PipelineWorld).
type PipelineFiles interface {
	// Link answers a URL that reads the file, or ErrNoPipelineFile.
	Link(ctx context.Context, pipeline, file string) (string, error)
	// Put stores the file, whole.
	Put(ctx context.Context, pipeline, file string, body []byte) error
}

// ErrNoPipelineFile is PipelineFiles.Link's answer for a file it does not
// keep.
var ErrNoPipelineFile = errors.New("no such pipeline file")

// releaseFile is what a file of a release may be called: the names the
// release action gives them.
var releaseFile = regexp.MustCompile(`^(pipeline\.mjs|casas-(engine|history)-[a-z0-9]+-[a-z0-9]+\.node|casas-engine-wasm\.tar\.gz|constants\.json|pipeline\.json)$`)

// historyPipeline is what a history's version is (casas-history
// HISTORY_VERSION, `h1-…`): the pipeline of a history's tasks
// (ScopeHistory), whose release is `history-<version>`
// (.github/workflows/history-release.yml) and holds the history's native
// build beside the engine's.
var historyPipeline = regexp.MustCompile(`^h[0-9]+-`)

// releaseTag is the release of a pipeline: `engine-<pipeline>`, or
// `history-<version>` for a history's.
func releaseTag(pipeline string) string {
	if historyPipeline.MatchString(pipeline) {
		return "history-" + pipeline
	}
	return "engine-" + pipeline
}

const (
	// The largest file of a release that is downloaded: a native engine is
	// about 3 MB (2026-10-22).
	maxReleaseFile = 128 << 20
	// The largest SHA256SUMS: one line per file.
	maxReleaseSums = 64 << 10
	// How long one download may take.
	releaseFetchTimeout = 5 * time.Minute
)

// errNoRelease: the release, or the file in it, is not there.
var errNoRelease = errors.New("no such release file")

// AnonymousReads names the requests of this module that need no caller:
// the pipeline builds, which everyone reads (artifacts.PipelineWorld), and
// the work per pipeline, which a launcher asks before it has a token. cmd/
// hands it to server.Gate with the other modules'.
func AnonymousReads(r *http.Request) bool {
	return r.Method == http.MethodGet && (strings.HasPrefix(r.URL.Path, "/v1/jobs/engines/") || r.URL.Path == "/v1/jobs/pipelines")
}

// pipelinesResponse is GET /v1/jobs/pipelines: the open work per pipeline.
type pipelinesResponse struct {
	Pipelines map[string]int `json:"pipelines"`
}

func (m *Module) handlePipelines(w http.ResponseWriter, _ *http.Request) {
	work := map[string]int{}
	if m.coord != nil {
		work = m.coord.pipelineWork()
	}
	httpjson.Write(w, http.StatusOK, pipelinesResponse{Pipelines: work})
}

func (m *Module) handleEngineFile(w http.ResponseWriter, r *http.Request) {
	pipeline, file := r.PathValue("pipeline"), r.PathValue("file")
	if !pipelinePattern.MatchString(pipeline) || !releaseFile.MatchString(file) {
		httpjson.ClientError(w, http.StatusNotFound, "no such pipeline file")
		return
	}
	if m.cfg.PipelineFiles == nil {
		httpjson.ClientError(w, http.StatusServiceUnavailable, "pipeline builds need an artifact store")
		return
	}
	link, err := m.pipelineFileLink(r.Context(), pipeline, file)
	switch {
	case errors.Is(err, errNoRelease):
		httpjson.ClientError(w, http.StatusNotFound, fmt.Sprintf("the release %s has no %s", releaseTag(pipeline), file))
		return
	case err != nil:
		slog.Warn("jobs: a pipeline file", "pipeline", pipeline, "file", file, "err", err)
		httpjson.ClientError(w, http.StatusBadGateway, "the pipeline file could not be got from its release")
		return
	}
	// A link is valid for minutes; a cached redirect would outlive it.
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, link, http.StatusFound)
}

// pipelineFileLink is the link to a stored file, downloaded first when it
// is not stored. One download at a time: a second caller for the same file
// waits, and then finds it stored.
func (m *Module) pipelineFileLink(ctx context.Context, pipeline, file string) (string, error) {
	link, err := m.cfg.PipelineFiles.Link(ctx, pipeline, file)
	if !errors.Is(err, ErrNoPipelineFile) {
		return link, err
	}
	m.fetchMu.Lock()
	defer m.fetchMu.Unlock()
	link, err = m.cfg.PipelineFiles.Link(ctx, pipeline, file)
	if !errors.Is(err, ErrNoPipelineFile) {
		return link, err
	}
	body, err := fetchReleaseFile(ctx, m.cfg.EngineSource, pipeline, file)
	if err != nil {
		return "", err
	}
	if err := m.cfg.PipelineFiles.Put(ctx, pipeline, file, body); err != nil {
		return "", err
	}
	slog.Info("jobs: pipeline file stored", "pipeline", pipeline, "file", file, "bytes", len(body))
	return m.cfg.PipelineFiles.Link(ctx, pipeline, file)
}

// fetchReleaseFile downloads one file of the release of `pipeline` and
// checks it against the release's SHA256SUMS.
func fetchReleaseFile(ctx context.Context, source, pipeline, file string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, releaseFetchTimeout)
	defer cancel()
	base := strings.TrimRight(source, "/") + "/" + releaseTag(pipeline) + "/"
	rawSums, err := download(ctx, base+"SHA256SUMS", maxReleaseSums)
	if err != nil {
		return nil, err
	}
	want, ok := parseSums(rawSums)[file]
	if !ok {
		return nil, errNoRelease
	}
	body, err := download(ctx, base+file, maxReleaseFile)
	if err != nil {
		return nil, err
	}
	got := sha256.Sum256(body)
	if hex.EncodeToString(got[:]) != want {
		return nil, fmt.Errorf("%s of %s does not match its SHA256SUMS", file, releaseTag(pipeline))
	}
	return body, nil
}

// download reads a URL whole, up to `limit` bytes. A 404 is errNoRelease.
func download(ctx context.Context, url string, limit int64) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer func() { _ = response.Body.Close() }()
	switch {
	case response.StatusCode == http.StatusNotFound:
		return nil, errNoRelease
	case response.StatusCode != http.StatusOK:
		return nil, fmt.Errorf("GET %s: %s", url, response.Status)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > limit {
		return nil, fmt.Errorf("GET %s: more than %d bytes", url, limit)
	}
	return body, nil
}

// parseSums reads `sha256sum` output: "<hex>  <name>" per line.
func parseSums(raw []byte) map[string]string {
	sums := map[string]string{}
	scanner := bufio.NewScanner(bytes.NewReader(raw))
	for scanner.Scan() {
		hash, name, ok := strings.Cut(scanner.Text(), "  ")
		if ok {
			sums[strings.TrimPrefix(name, "*")] = strings.ToLower(hash)
		}
	}
	return sums
}

// THE SHIPPED RELEASE (docs/decisions/engine-releases.md, step 4): an image
// built on a pipeline's release carries the release's files with their
// SHA256SUMS in engine/ beside the worker bundle (deploy/Dockerfile). At its
// start the module puts each one the artifact store lacks into it, after
// checking it against the SHA256SUMS: then the store has the server's own
// pipeline without the release's host. Without a SHA256SUMS (a build from
// the tree, ENGINE=source) nothing goes in: such a file under the pipeline's
// name need not be the release's bytes.
const shippedRelease = "engine"

// seedPipelineFiles is that, for the release in `dir`. It says what it did
// and what failed, and fails nothing.
func seedPipelineFiles(ctx context.Context, dir string, files PipelineFiles) {
	rawSums, err := os.ReadFile(filepath.Join(dir, "SHA256SUMS"))
	if errors.Is(err, fs.ErrNotExist) {
		return
	}
	if err != nil {
		slog.Warn("jobs: the shipped release", "dir", dir, "err", err)
		return
	}
	sums := parseSums(rawSums)
	read := func(name string) ([]byte, error) {
		body, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return nil, err
		}
		got := sha256.Sum256(body)
		if want, ok := sums[name]; !ok || hex.EncodeToString(got[:]) != want {
			return nil, fmt.Errorf("%s does not match the SHA256SUMS beside it", name)
		}
		return body, nil
	}
	raw, err := read("pipeline.json")
	if err != nil {
		slog.Warn("jobs: the shipped release", "dir", dir, "err", err)
		return
	}
	var versions struct {
		PipelineVersion string `json:"pipelineVersion"`
	}
	if err := json.Unmarshal(raw, &versions); err != nil || !pipelinePattern.MatchString(versions.PipelineVersion) {
		slog.Warn("jobs: the shipped release names no pipeline", "dir", dir)
		return
	}
	pipeline := versions.PipelineVersion
	stored := 0
	for name := range sums {
		if !releaseFile.MatchString(name) {
			continue
		}
		if _, err := files.Link(ctx, pipeline, name); !errors.Is(err, ErrNoPipelineFile) {
			if err != nil {
				slog.Warn("jobs: the shipped release", "file", name, "err", err)
			}
			continue
		}
		body, err := read(name)
		if err == nil {
			err = files.Put(ctx, pipeline, name, body)
		}
		if err != nil {
			slog.Warn("jobs: the shipped release", "file", name, "err", err)
			continue
		}
		stored++
	}
	if stored > 0 {
		slog.Info("jobs: the shipped release stored", "pipeline", pipeline, "files", stored)
	}
}

// httpPipelineFiles is PipelineFiles over the artifacts module's API
// (Config.ArtifactsURL), for a jobs module whose process does not run the
// artifacts target: the split of a cluster (deploy/helm, compute and
// stores). It writes as a module, with the pipeline builds' own credential
// (token.AudiencePipelineFiles), the file and then its meta.json, as every
// writer does; the meta is the store's writers' contract
// (src/world/meshArtifacts.ts writes the same).
type httpPipelineFiles struct {
	base   string
	tokens *token.Tokens
}

// How long the credential of one request holds.
const pipelineFilesTokenTTL = 5 * time.Minute

func (h httpPipelineFiles) request(ctx context.Context, method, url string, body []byte) (*http.Response, error) {
	request, err := http.NewRequestWithContext(ctx, method, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/octet-stream")
	}
	if h.tokens != nil {
		credential, _, err := h.tokens.IssuePipelineFiles("jobs", pipelineFilesTokenTTL)
		if err != nil {
			return nil, err
		}
		request.Header.Set("Authorization", "Bearer "+credential)
	}
	return http.DefaultClient.Do(request)
}

// resolve is the artifact of a release file: its uid and its files, or
// ErrNoPipelineFile.
func (h httpPipelineFiles) resolve(ctx context.Context, pipeline, file string, create bool) (string, []string, error) {
	body, _ := json.Marshal(map[string]any{"worldId": "pipeline", "pipelineVersion": pipeline, "stage": file, "create": create})
	response, err := h.request(ctx, http.MethodPost, h.base+"/artifacts/resolve", body)
	if err != nil {
		return "", nil, err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode == http.StatusNotFound {
		return "", nil, ErrNoPipelineFile
	}
	if response.StatusCode != http.StatusOK {
		return "", nil, fmt.Errorf("resolve %s/%s: %s", pipeline, file, response.Status)
	}
	var resolved struct {
		ArtifactUID string   `json:"artifactUid"`
		Files       []string `json:"files"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&resolved); err != nil {
		return "", nil, err
	}
	return resolved.ArtifactUID, resolved.Files, nil
}

// Link is the artifact's read route, which answers with a link to the
// bytes; the URL is the artifacts module's as this server reaches it (the
// launcher puts its own `api` in, launcher.go).
func (h httpPipelineFiles) Link(ctx context.Context, pipeline, file string) (string, error) {
	uid, files, err := h.resolve(ctx, pipeline, file, false)
	if err != nil {
		return "", err
	}
	for _, name := range files {
		if name == "meta.json" {
			return h.base + "/artifacts/" + uid + "/" + file, nil
		}
	}
	return "", ErrNoPipelineFile
}

func (h httpPipelineFiles) Put(ctx context.Context, pipeline, file string, body []byte) error {
	uid, _, err := h.resolve(ctx, pipeline, file, true)
	if err != nil {
		return err
	}
	meta, _ := json.Marshal(map[string]any{
		"key":       map[string]string{"worldId": "pipeline", "pipelineVersion": pipeline, "stage": file},
		"label":     releaseTag(pipeline) + " " + file,
		"createdAt": time.Now().UnixMilli(),
	})
	for _, part := range []struct {
		name string
		body []byte
	}{{file, body}, {"meta.json", meta}} {
		response, err := h.request(ctx, http.MethodPut, h.base+"/artifacts/"+uid+"/"+part.name, part.body)
		if err != nil {
			return err
		}
		_ = response.Body.Close()
		if response.StatusCode != http.StatusNoContent {
			return fmt.Errorf("PUT %s of %s/%s: %s", part.name, pipeline, file, response.Status)
		}
	}
	return nil
}
