// Package artifacts is the ARTIFACT store: derived data such as the mesh
// level bakes and, later, their tiles.
//
// Named for what it HOLDS, not for being a cache — the client's OPFS copy is a
// cache, this one is the shared authoritative copy. What both do share is the
// property its counterpart internal/modules/world does NOT have: everything here is a
// deterministic function of a world plus a pipeline version, so it can be
// dropped at any time and recomputed. That is why the two are separate modules
// with deliberately different delete affordances in the UI.
//
// Addressing (2026-08-12): an artifact is a minted uuid; the LOGICAL key —
// worldUid, worldId, pipelineVersion, stage — appears in exactly one request,
// `resolve`, which translates it to the uid every other route uses. The
// mapping is carried by each entry's own meta.json, so the disk layout says
// nothing a schema change could break. See the store's header for the whole
// argument.
package artifacts

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/access"
	"github.com/DebakelOrakel/casas-eternas/internal/blob"
	"github.com/DebakelOrakel/casas-eternas/internal/config"
	"github.com/DebakelOrakel/casas-eternas/internal/httpjson"
	"github.com/DebakelOrakel/casas-eternas/internal/identity"
)

// UploadLimit caps one artifact file. An amplified elevation raster is ~17 MB
// at 4096 and ~67 MB at 8192; this leaves room for the resolutions above that
// without letting a single request run away. A candidate for a flag once a
// deployment has an opinion. Exported because it also bounds the dir
// backend's PUT links (NewLinkSigner).
const UploadLimit = 512 << 20 // 512 MiB

// LinkBase is the path under which the dir backend serves its own links
// (DEC-0038, fork 5): `GET /v1/artifacts/blob/<key>?exp=…&sig=…`. In this
// module's namespace; the link is the authorization, so the gate lets a
// request with a valid one through without credentials (SignedRequest).
const LinkBase = "/v1/artifacts/blob/"

// Config carries the full configuration tree (every module holds it whole —
// decided 2026-08-12). No viper here by design; the module reads Global and
// its OWN section (`artifacts.*`), nothing else.
type Config struct {
	All config.Config
	// Bucket is where the bytes are: a blob.Dir or a blob.S3, opened by
	// cmd/ from artifacts.storage (cmd/storage.go). A Dir that signs links
	// (blob.OpenDir with NewLinkSigner) makes this module serve them.
	Bucket blob.Bucket
	// Identity answers who a request comes from — the one resolver cmd/
	// builds and every module shares.
	Identity *identity.Resolver
	// WorldAccess ranks a caller (by their forwarded Authorization header)
	// against a world — artifacts INHERIT their world's visibility, which is
	// why reading one is not "informational". Injected by cmd/: a closure
	// over the co-resident world module, or an HTTP lookup of the world
	// service's meta endpoint, whose answer carries the level. In the local
	// mode the closure answers Admin, which is the none-mode short circuit.
	WorldAccess func(ctx context.Context, worldUID, bearer string) (exists bool, level access.Level)
}

// Module serves the artifact store.
type Module struct {
	cfg   Config
	store *Store
	// signer checks the dir backend's links; nil on s3, whose links the
	// provider checks.
	signer *blob.LinkSigner
	// readTTL is the lifetime of a read link (artifacts.read-link-ttl).
	readTTL time.Duration
}

// signing is what a Dir that makes its own links offers.
type signing interface{ Signer() *blob.LinkSigner }

// NewLinkSigner makes the signer of the dir backend's links from
// artifacts.link-key (DEC-0038, fork 4). Without a key file the key is
// ephemeral and the links die at restart, which is logged.
func NewLinkSigner(cfg config.Config) (*blob.LinkSigner, error) {
	key, ephemeral, err := blob.ReadLinkKey(cfg.Artifacts.LinkKey)
	if err != nil {
		return nil, fmt.Errorf("artifacts.link-key: %w", err)
	}
	if ephemeral {
		slog.Warn("artifacts.link-key is not set: the artifact links use an ephemeral key and stop working at restart")
	}
	return blob.NewLinkSigner(LinkBase, UploadLimit, key)
}

// BucketOptions are what the store asks of an s3 bucket. CORS, because the
// browser follows the 302 of a read to the bucket's origin. The allowed
// origin is "*", with no credentials: a presigned GET is a capability URL
// (the right was checked when it was issued, DEC-0038, fork 5), and anyone
// who holds it can use it outside a browser, so a narrower origin protects
// nothing. "*" also covers the `Origin: null` a browser sends after a
// redirect from a third origin (the API on another host than the page), and
// it needs no setting.
//
// Every request header is allowed: the browser sends the read with the
// session's Authorization header, and on the redirect to the bucket it
// drops the header but still asks for it in the preflight (measured in
// Safari 26.6, 2026-10-16: OPTIONS with Access-Control-Request-Headers:
// authorization, then a GET without it). A rule that does not allow it
// fails the read.
func BucketOptions() blob.OpenOptions {
	return blob.OpenOptions{CORS: []blob.CORSRule{{
		AllowedOrigins: []string{"*"},
		AllowedMethods: []string{http.MethodGet, http.MethodHead},
		AllowedHeaders: []string{"*"},
		ExposeHeaders:  []string{"ETag", "Content-Length"},
		MaxAge:         time.Hour,
	}}}
}

// New prepares the store and builds its index from the bucket, so a bucket
// that cannot be read fails at startup rather than on first request.
func New(ctx context.Context, cfg Config) (*Module, error) {
	if cfg.Identity == nil || cfg.WorldAccess == nil || cfg.Bucket == nil {
		return nil, fmt.Errorf("artifacts needs its bucket, identity and world-access wiring; that is cmd/'s job")
	}
	capBytes, err := config.ParseByteSize(cfg.All.Artifacts.Cap)
	if err != nil {
		return nil, fmt.Errorf("artifacts.cap: %w", err)
	}
	readTTL := cfg.All.Artifacts.ReadLinkTTL
	if readTTL <= 0 || readTTL > blob.MaxLinkTTL {
		return nil, fmt.Errorf("artifacts.read-link-ttl: %v must be in (0, %v]", readTTL, blob.MaxLinkTTL)
	}
	store, err := NewStore(ctx, cfg.Bucket, capBytes)
	if err != nil {
		return nil, fmt.Errorf("artifacts.storage: %w", err)
	}
	m := &Module{cfg: cfg, store: store, readTTL: readTTL}
	if d, ok := cfg.Bucket.(signing); ok {
		m.signer = d.Signer()
	}
	return m, nil
}

// Name identifies the module in logs and errors.
func (m *Module) Name() string { return "artifacts" }

// Store is the module's store, for a co-resident module's injected lookup
// (the jobs coordinator's ArtifactPresent, composed in cmd/) — the same
// handing-out the world module does.
func (m *Module) Store() *Store { return m.store }

// Mount claims the artifact routes.
func (m *Module) Mount(mux *http.ServeMux) error {
	mux.HandleFunc("POST /v1/artifacts/resolve", m.handleResolve)
	mux.HandleFunc("GET /v1/artifacts", m.handleList)
	mux.HandleFunc("GET /v1/artifacts/levels", m.handleLevels)
	mux.HandleFunc("DELETE /v1/artifacts", m.handleClear)
	mux.HandleFunc("DELETE /v1/artifacts/{artifactUID}", m.handleRemove)
	// `{name...}` rather than `{name}` so a future tile layout ("tiles/12_7")
	// needs no new route; every segment is validated in the store, which is
	// what keeps the flexibility from becoming a path traversal.
	mux.HandleFunc("GET /v1/artifacts/{artifactUID}/{name...}", m.handleGet)
	mux.HandleFunc("PUT /v1/artifacts/{artifactUID}/{name...}", m.handlePut)
	// The dir backend's own links. More specific than the route above, so
	// the mux sends /v1/artifacts/blob/… here (no uid is "blob": uids are
	// minted uuids). Not mounted on s3: the provider serves its links.
	if m.signer != nil {
		mux.HandleFunc("GET "+LinkBase+"{key...}", m.handleLink)
	}
	return nil
}

// Close releases the bucket when it holds something open (a Dir's root).
func (m *Module) Close() error {
	if c, ok := m.cfg.Bucket.(io.Closer); ok {
		return c.Close()
	}
	return nil
}

// SignedRequest answers whether a request carries a link this module
// signed: a GET (or HEAD) under LinkBase whose signature verifies. cmd/
// hands it to server.Gate, which lets such a request through WITHOUT
// credentials, whatever its Authorization header holds: the link is the
// authorization. An expired link of ours passes too, so that the route
// answers 410 and not the gate 401 — a 401 would end the browser's
// session. A forged or changed link does not pass: the gate treats it as
// any other request.
func (m *Module) SignedRequest(r *http.Request) bool {
	if m.signer == nil || (r.Method != http.MethodGet && r.Method != http.MethodHead) {
		return false
	}
	key, ok := strings.CutPrefix(r.URL.Path, LinkBase)
	if !ok {
		return false
	}
	_, err := m.signer.Verify(http.MethodGet, key, r.URL.Query())
	return err == nil || errors.Is(err, blob.ErrLinkExpired)
}

// operator answers "may this request do anything here": the admin claim, or
// the local mode, where every check answers yes by design.
func (m *Module) operator(r *http.Request) bool {
	if !m.cfg.Identity.ChecksIdentity() {
		return true
	}
	_, admin := m.cfg.Identity.ResolveBearer(r.Header.Get("Authorization"))
	return admin
}

// allowed ranks a request against an artifact's world — artifacts INHERIT
// the world's ACL, with the same visibility shape: a world the caller may
// not read hides its artifacts behind 404, and only readable ones
// distinguish 403.
//
// Two bypasses, both deliberate: the operator (admin claim / local mode) —
// which is also what keeps ORPHANS reachable, artifacts whose world is
// already gone and can rank nobody; and a bake job whose token's world
// claim MATCHES this artifact's world — the writer this system itself sent
// out, narrowed to exactly the world it was sent for (step 4 of the access
// plan, 2026-08-12). A job token without the claim, or for another world,
// ranks as nobody like any other stranger.
func (m *Module) allowed(w http.ResponseWriter, r *http.Request, worldUID string, need access.Level, what string) bool {
	if m.operator(r) {
		return true
	}
	if _, jobWorld, ok := m.cfg.Identity.JobToken(r); ok && jobWorld != "" && jobWorld == worldUID {
		return true
	}
	if worldUID == "" {
		// No world to rank against (junk entry): operator territory only.
		httpjson.ClientError(w, http.StatusNotFound, "no such artifact")
		return false
	}
	exists, level := m.cfg.WorldAccess(r.Context(), worldUID, r.Header.Get("Authorization"))
	if !exists || level < access.Viewer {
		httpjson.ClientError(w, http.StatusNotFound, "no such artifact")
		return false
	}
	if level < need {
		httpjson.ClientError(w, http.StatusForbidden, what+" needs "+need.String()+" access to its world")
		return false
	}
	return true
}

type resolveRequest struct {
	Key
	// With create, an absent key mints an artifact and returns its fresh uid —
	// the writer's path. Without it, absent is 404 — the reader's.
	Create bool `json:"create"`
}

type resolveResponse struct {
	ArtifactUID string `json:"artifactUid"`
	// The files currently present — the batch existence answer that used to be
	// its own `present` endpoint.
	Files []string `json:"files"`
}

func (m *Module) handleResolve(w http.ResponseWriter, r *http.Request) {
	var request resolveRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&request); err != nil {
		httpjson.ClientError(w, http.StatusBadRequest, "expected {worldUid, worldId, pipelineVersion, stage, create?}")
		return
	}
	need, what := access.Viewer, "reading artifacts"
	if request.Create {
		need, what = access.Editor, "writing artifacts"
	}
	if !m.allowed(w, r, request.WorldUID, need, what) {
		return
	}
	uid, files, err := m.store.Resolve(r.Context(), request.Key, request.Create)
	if err != nil {
		respondStoreError(w, err)
		return
	}
	if request.Create {
		slog.Info("artifact resolved for writing", "artifact", uid, "uid", request.WorldUID, "world", request.WorldID, "version", request.PipelineVersion, "stage", request.Stage)
	}
	httpjson.Write(w, http.StatusOK, resolveResponse{ArtifactUID: uid, Files: files})
}

func (m *Module) handleGet(w http.ResponseWriter, r *http.Request) {
	worldUID, _ := m.store.WorldOf(r.Context(), r.PathValue("artifactUID"))
	if !m.allowed(w, r, worldUID, access.Viewer, "reading artifacts") {
		return
	}
	// The right is checked; the bytes come from a link that carries it
	// (DEC-0038, step 3): a presigned GET on s3, so they do not pass through
	// this server, or this module's own signed link on dir.
	link, err := m.store.Link(r.Context(), r.PathValue("artifactUID"), r.PathValue("name"), m.readTTL)
	if err != nil {
		respondStoreError(w, err)
		return
	}
	// A link is valid for minutes; a redirect cached past that would send
	// the client to a dead link.
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, link.URL, http.StatusFound)
}

// handleLink serves a dir link. No caller is needed: the gate let the
// request through for its signature (SignedRequest), and it is checked
// again here, where its result decides. The answers say no more than the
// link holder knows: 403 for a link that does not verify (whatever is
// wrong with it), 410 for one of ours that has expired, 404 for a signed
// key whose object has gone.
func (m *Module) handleLink(w http.ResponseWriter, r *http.Request) {
	key := r.PathValue("key")
	if _, err := m.signer.Verify(http.MethodGet, key, r.URL.Query()); err != nil {
		if errors.Is(err, blob.ErrLinkExpired) {
			httpjson.ClientError(w, http.StatusGone, "the link has expired")
			return
		}
		httpjson.ClientError(w, http.StatusForbidden, "the link is not valid")
		return
	}
	body, info, err := m.cfg.Bucket.Get(r.Context(), key)
	if err != nil {
		if errors.Is(err, blob.ErrNotFound) {
			httpjson.ClientError(w, http.StatusNotFound, "no such artifact")
			return
		}
		httpjson.ServerError(w, "artifact store", err)
		return
	}
	defer func() { _ = body.Close() }()
	// No conditional-request handling and no cache validators: an artifact is
	// immutable under its key, so a client that has it never asks again — and
	// one that asks does not have it.
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size, 10))
	_, _ = io.Copy(w, body)
}

func (m *Module) handlePut(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("artifactUID")
	// Ranked via the RESERVATION's key when the meta has not landed yet —
	// which on the write path it by definition has not.
	worldUID, _ := m.store.WorldOf(r.Context(), uid)
	if !m.allowed(w, r, worldUID, access.Editor, "writing artifacts") {
		return
	}
	if r.ContentLength > UploadLimit {
		httpjson.ClientError(w, http.StatusRequestEntityTooLarge, "artifact upload too large or truncated")
		return
	}
	body := &bodyReader{r: http.MaxBytesReader(w, r.Body, UploadLimit)}
	// r.ContentLength is -1 for a chunked upload; the store spools it.
	if err := m.store.Write(r.Context(), uid, r.PathValue("name"), body, r.ContentLength); err != nil {
		switch {
		case errors.Is(err, ErrBadPath):
			httpjson.ClientError(w, http.StatusBadRequest, "invalid artifact path")
		case errors.Is(err, ErrNotFound):
			// Writing into an unminted uid: resolve with create first. Loud on
			// purpose — accepting the write would mint entries out of thin air.
			httpjson.ClientError(w, http.StatusNotFound, "no such artifact — resolve with create first")
		case body.failed || errors.Is(err, blob.ErrSize) || errors.Is(err, errTooLarge):
			// A body that exceeded the cap, or ended before its length,
			// surfaces from the copy, not from the path check, so it is
			// reported here rather than as a store fault.
			httpjson.ClientError(w, http.StatusRequestEntityTooLarge, "artifact upload too large or truncated")
		default:
			// The bucket refused or could not be reached: the server's
			// fault, not the upload's (on s3 a network error lands here).
			httpjson.ServerError(w, "storing an artifact", err)
		}
		return
	}
	slog.Info("artifact stored", "artifact", uid, "name", r.PathValue("name"))
	// 204 rather than 201: a repeated upload of the same key is a no-op by
	// construction, so "created" would be a claim this store cannot make.
	w.WriteHeader(http.StatusNoContent)
}

// bodyReader records whether reading the request body failed, so that a
// failed write can be told apart: the upload's fault (413) or the bucket's
// (500).
type bodyReader struct {
	r      io.Reader
	failed bool
}

func (b *bodyReader) Read(p []byte) (int, error) {
	n, err := b.r.Read(p)
	if err != nil && !errors.Is(err, io.EOF) {
		b.failed = true
	}
	return n, err
}

func (m *Module) handleList(w http.ResponseWriter, r *http.Request) {
	visible, bytes, err := m.visible(r)
	if err != nil {
		httpjson.ServerError(w, "listing artifacts", err)
		return
	}
	httpjson.Write(w, http.StatusOK, map[string]any{"artifacts": visible, "bytes": bytes})
}

// visible is what the caller may see of the store, and its size.
//
// The listing inherits the worlds' visibility: an artifact shows to
// whoever may read its world. Meta-less entries (junk, mid-write) show
// only to the operator — they can rank nobody. One WorldAccess per
// DISTINCT world, not per artifact. Each entry says what the caller may
// do with it (callerLevel: its world's level, "admin" for the operator),
// so a client greys out what it may not delete rather than letting the
// request fail.
func (m *Module) visible(r *http.Request) ([]callerArtifact, int64, error) {
	artifacts, err := m.store.List(r.Context())
	if err != nil {
		return nil, 0, err
	}
	visible := make([]callerArtifact, 0, len(artifacts))
	var bytes int64
	if m.operator(r) {
		for _, artifact := range artifacts {
			visible = append(visible, callerArtifact{artifact, access.Admin.String()})
		}
		// The operator sees the whole store, so the gauge is the whole store —
		// the cache-size figure the eviction reasons about.
		bytes, _ = m.store.Usage(r.Context())
		return visible, bytes, nil
	}
	// Anyone else sees what they may see, and its size: the store's whole
	// usage would tell them about worlds they cannot see.
	bearer := r.Header.Get("Authorization")
	levels := map[string]access.Level{}
	for _, artifact := range artifacts {
		if artifact.WorldUID == "" {
			continue
		}
		level, ranked := levels[artifact.WorldUID]
		if !ranked {
			_, level = m.cfg.WorldAccess(r.Context(), artifact.WorldUID, bearer)
			levels[artifact.WorldUID] = level
		}
		if level >= access.Viewer {
			visible = append(visible, callerArtifact{artifact, level.String()})
			bytes += artifact.Bytes
		}
	}
	return visible, bytes, nil
}

// LevelSummary is one level of one terrain under one pipeline version: a
// whole level (count 1) or its tiles (count of them), and their bytes —
// what the artifact window shows as a row, instead of an entry per tile
// (a world refined to level 3 is ten thousand of them, 2026-10-02).
type LevelSummary struct {
	WorldUID        string `json:"worldUid"`
	WorldID         string `json:"worldId"`
	PipelineVersion string `json:"pipelineVersion"`
	Level           int    `json:"level"`
	Tiles           bool   `json:"tiles"`
	Count           int    `json:"count"`
	Bytes           int64  `json:"bytes"`
	Label           string `json:"label"`
	BakeMs          int64  `json:"bakeMs"`
	CallerLevel     string `json:"callerLevel"`
}

// handleLevels lists what the caller may see, summed per world, terrain,
// pipeline version and level. Entries whose stage is no level (junk, other
// kinds) are left out; the flat listing still shows them.
func (m *Module) handleLevels(w http.ResponseWriter, r *http.Request) {
	visible, bytes, err := m.visible(r)
	if err != nil {
		httpjson.ServerError(w, "listing artifacts", err)
		return
	}
	type groupKey struct {
		world, terrain, pipeline string
		level                    int
		tiles                    bool
	}
	groups := map[groupKey]*LevelSummary{}
	var order []groupKey
	for _, a := range visible {
		level, tile, ok := StageLevel(a.Stage)
		if !ok {
			continue
		}
		k := groupKey{a.WorldUID, a.WorldID, a.PipelineVersion, level, tile}
		g := groups[k]
		if g == nil {
			g = &LevelSummary{WorldUID: a.WorldUID, WorldID: a.WorldID, PipelineVersion: a.PipelineVersion, Level: level, Tiles: tile, Label: a.Label, CallerLevel: a.CallerLevel}
			groups[k] = g
			order = append(order, k)
		}
		g.Count++
		g.Bytes += a.Bytes
		g.BakeMs += int64(a.BakeMs)
	}
	sort.Slice(order, func(i, j int) bool {
		a, b := order[i], order[j]
		if a.world != b.world {
			return a.world < b.world
		}
		if a.level != b.level {
			return a.level < b.level
		}
		if a.terrain != b.terrain {
			return a.terrain < b.terrain
		}
		return a.pipeline < b.pipeline
	})
	out := make([]LevelSummary, 0, len(order))
	for _, k := range order {
		out = append(out, *groups[k])
	}
	httpjson.Write(w, http.StatusOK, map[string]any{"levels": out, "bytes": bytes})
}

// A listed artifact with the caller's level on its world.
type callerArtifact struct {
	ListedArtifact
	CallerLevel string `json:"callerLevel"`
}

func (m *Module) handleRemove(w http.ResponseWriter, r *http.Request) {
	// Editor suffices: an artifact is recomputable by anyone who may bake,
	// so dropping one destroys nothing an editor could not remake.
	worldUID, _ := m.store.WorldOf(r.Context(), r.PathValue("artifactUID"))
	if !m.allowed(w, r, worldUID, access.Editor, "removing an artifact") {
		return
	}
	if err := m.store.RemoveArtifact(r.Context(), r.PathValue("artifactUID")); err != nil {
		respondStoreError(w, err)
		return
	}
	slog.Info("artifact dropped", "artifact", r.PathValue("artifactUID"))
	w.WriteHeader(http.StatusNoContent)
}

// handleClear clears everything, or — with ?world={uid} — every artifact the
// meta files attribute to one world, or — with ?world={uid}&level={n} — one
// level of it, its tiles included, narrowed by &worldId= and &pipeline= to
// one terrain or version (the artifact window's "delete this level").
func (m *Module) handleClear(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	if world, levelText := query.Get("world"), query.Get("level"); world != "" && levelText != "" {
		level, err := strconv.Atoi(levelText)
		if err != nil || level < 0 {
			httpjson.ClientError(w, http.StatusBadRequest, "level must be a level's number")
			return
		}
		// Editor, as for one artifact: a level is recomputable by anyone
		// who may refine the world.
		if !m.allowed(w, r, world, access.Editor, "removing a level's artifacts") {
			return
		}
		removed, err := m.store.RemoveLevel(r.Context(), world, level, query.Get("worldId"), query.Get("pipeline"))
		if err != nil {
			respondStoreError(w, err)
			return
		}
		slog.Info("artifacts dropped", "uid", world, "level", level, "count", removed)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if world := query.Get("world"); world != "" {
		// The sweep rides on world.delete's level: it exists so deleting a
		// world can take its artifacts with it. (Sweep BEFORE the world is
		// deleted — an orphaned world ranks nobody and falls to the operator.)
		if !m.allowed(w, r, world, access.Owner, "sweeping a world's artifacts") {
			return
		}
		if err := m.store.RemoveWorld(r.Context(), world); err != nil {
			respondStoreError(w, err)
			return
		}
		slog.Info("artifacts dropped", "uid", world)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	// Clearing EVERYTHING is store administration, not a per-world right.
	if !m.operator(r) {
		httpjson.ClientError(w, http.StatusForbidden, "clearing the whole store is an admin action")
		return
	}
	if err := m.store.Clear(r.Context()); err != nil {
		httpjson.ServerError(w, "clearing artifacts", err)
		return
	}
	slog.Info("artifact store cleared")
	w.WriteHeader(http.StatusNoContent)
}

func respondStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		httpjson.ClientError(w, http.StatusNotFound, "no such artifact")
	case errors.Is(err, ErrBadPath):
		httpjson.ClientError(w, http.StatusBadRequest, "invalid artifact path")
	default:
		httpjson.ServerError(w, "artifact store", err)
	}
}
