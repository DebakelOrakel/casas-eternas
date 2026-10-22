package jobs

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/httpjson"
)

// THE PIPELINE BUILDS (docs/decisions/engine-releases.md, fork 5): the
// files of a pipeline's release — the job worker's pipeline module, the
// native engine per platform, the WASM build — for a worker that runs another
// pipeline than the one it was shipped with. GET
// /v1/jobs/engines/{pipeline}/{file} answers with a link to the file in the
// artifact store. On a miss it downloads the file from the release of the
// pipeline (`engine-<pipeline>`, .github/workflows/engine-release.yml),
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
var releaseFile = regexp.MustCompile(`^(pipeline\.mjs|casas-engine-[a-z0-9]+-[a-z0-9]+\.node|casas-engine-wasm\.tar\.gz|constants\.json|pipeline\.json)$`)

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
		httpjson.ClientError(w, http.StatusServiceUnavailable, "pipeline builds need the artifacts target in this process")
		return
	}
	link, err := m.pipelineFileLink(r.Context(), pipeline, file)
	switch {
	case errors.Is(err, errNoRelease):
		httpjson.ClientError(w, http.StatusNotFound, fmt.Sprintf("the release engine-%s has no %s", pipeline, file))
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
	base := strings.TrimRight(source, "/") + "/engine-" + pipeline + "/"
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
		return nil, fmt.Errorf("%s of engine-%s does not match its SHA256SUMS", file, pipeline)
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
