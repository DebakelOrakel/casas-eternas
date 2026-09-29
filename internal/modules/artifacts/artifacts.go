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
	"strconv"

	"github.com/DebakelOrakel/casas-eternas/internal/access"
	"github.com/DebakelOrakel/casas-eternas/internal/config"
	"github.com/DebakelOrakel/casas-eternas/internal/httpjson"
	"github.com/DebakelOrakel/casas-eternas/internal/identity"
)

// uploadLimit caps one artifact file. An amplified elevation raster is ~17 MB
// at 4096 and ~67 MB at 8192; this leaves room for the resolutions above that
// without letting a single request run away. A candidate for a flag once a
// deployment has an opinion — as is the size cap that eviction will need.
const uploadLimit = 512 << 20 // 512 MiB

// Config carries the full configuration tree (every module holds it whole —
// decided 2026-08-12). No viper here by design; the module reads Global and
// its OWN section (`artifacts.*`), nothing else.
type Config struct {
	All config.Config
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
}

// New prepares the store, creating the directory so a bad artifacts.storage
// fails at startup rather than on first write.
func New(cfg Config) (*Module, error) {
	if cfg.Identity == nil || cfg.WorldAccess == nil {
		return nil, fmt.Errorf("artifacts needs its identity and world-access wiring; that is cmd/'s job")
	}
	capBytes, err := config.ParseByteSize(cfg.All.Artifacts.Cap)
	if err != nil {
		return nil, fmt.Errorf("artifacts.cap: %w", err)
	}
	store, err := NewStore(cfg.All.Artifacts.Storage.DirPath(), capBytes)
	if err != nil {
		return nil, fmt.Errorf("artifacts.storage: %w", err)
	}
	return &Module{cfg: cfg, store: store}, nil
}

// Name identifies the module in logs and errors.
func (m *Module) Name() string { return "artifacts" }

// Mount claims the artifact routes.
func (m *Module) Mount(mux *http.ServeMux) error {
	mux.HandleFunc("POST /v1/artifacts/resolve", m.handleResolve)
	mux.HandleFunc("GET /v1/artifacts", m.handleList)
	mux.HandleFunc("DELETE /v1/artifacts", m.handleClear)
	mux.HandleFunc("DELETE /v1/artifacts/{artifactUID}", m.handleRemove)
	// `{name...}` rather than `{name}` so a future tile layout ("tiles/12_7")
	// needs no new route; every segment is validated in the store, which is
	// what keeps the flexibility from becoming a path traversal.
	mux.HandleFunc("GET /v1/artifacts/{artifactUID}/{name...}", m.handleGet)
	mux.HandleFunc("PUT /v1/artifacts/{artifactUID}/{name...}", m.handlePut)
	return nil
}

// Close releases the store. Nothing is held open.
func (m *Module) Close() error { return nil }

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
	raw, err := m.store.Read(r.Context(), r.PathValue("artifactUID"), r.PathValue("name"))
	if err != nil {
		respondStoreError(w, err)
		return
	}
	// No conditional-request handling and no cache validators: an artifact is
	// immutable under its key, so a client that has it never asks again — and
	// one that asks does not have it.
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.Itoa(len(raw)))
	_, _ = w.Write(raw)
}

func (m *Module) handlePut(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("artifactUID")
	// Ranked via the RESERVATION's key when the meta has not landed yet —
	// which on the write path it by definition has not.
	worldUID, _ := m.store.WorldOf(r.Context(), uid)
	if !m.allowed(w, r, worldUID, access.Editor, "writing artifacts") {
		return
	}
	body := http.MaxBytesReader(w, r.Body, uploadLimit)
	if err := m.store.Write(r.Context(), uid, r.PathValue("name"), body); err != nil {
		switch {
		case errors.Is(err, ErrBadPath):
			httpjson.ClientError(w, http.StatusBadRequest, "invalid artifact path")
		case errors.Is(err, ErrNotFound):
			// Writing into an unminted uid: resolve with create first. Loud on
			// purpose — accepting the write would mint entries out of thin air.
			httpjson.ClientError(w, http.StatusNotFound, "no such artifact — resolve with create first")
		default:
			// A body that exceeded the cap surfaces from the copy, not from the
			// path check, so it is reported here rather than as a store fault.
			httpjson.ClientError(w, http.StatusRequestEntityTooLarge, "artifact upload too large or truncated")
		}
		return
	}
	slog.Info("artifact stored", "artifact", uid, "name", r.PathValue("name"))
	// 204 rather than 201: a repeated upload of the same key is a no-op by
	// construction, so "created" would be a claim this store cannot make.
	w.WriteHeader(http.StatusNoContent)
}

func (m *Module) handleList(w http.ResponseWriter, r *http.Request) {
	artifacts, err := m.store.List(r.Context())
	if err != nil {
		httpjson.ServerError(w, "listing artifacts", err)
		return
	}
	// The listing inherits the worlds' visibility: an artifact shows to
	// whoever may read its world. Meta-less entries (junk, mid-write) show
	// only to the operator — they can rank nobody. One WorldAccess per
	// DISTINCT world, not per artifact. Each entry says what the caller may
	// do with it (callerLevel: its world's level, "admin" for the operator),
	// so a client greys out what it may not delete rather than letting the
	// request fail.
	visible := make([]callerArtifact, 0, len(artifacts))
	var bytes int64
	if m.operator(r) {
		for _, artifact := range artifacts {
			visible = append(visible, callerArtifact{artifact, access.Admin.String()})
		}
		// The operator sees the whole store, so the gauge is the whole store —
		// the cache-size figure the eviction reasons about.
		bytes, _ = m.store.Usage(r.Context())
	} else {
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
	}
	// Anyone else sees what they may see, and its size: the store's whole
	// usage would tell them about worlds they cannot see.
	httpjson.Write(w, http.StatusOK, map[string]any{"artifacts": visible, "bytes": bytes})
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
// meta files attribute to one world.
func (m *Module) handleClear(w http.ResponseWriter, r *http.Request) {
	if world := r.URL.Query().Get("world"); world != "" {
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
