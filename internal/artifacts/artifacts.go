// Package artifacts is the ARTIFACT store: derived data such as the
// amplification bake's rasters and, later, tiles.
//
// Named for what it HOLDS, not for being a cache — the client's OPFS copy is a
// cache, this one is the shared authoritative copy. What both do share is the
// property its counterpart internal/world does NOT have: everything here is a
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
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
)

// uploadLimit caps one artifact file. An amplified elevation raster is ~17 MB
// at 4096 and ~67 MB at 8192; this leaves room for the resolutions above that
// without letting a single request run away. A candidate for a flag once a
// deployment has an opinion — as is the size cap that eviction will need.
const uploadLimit = 512 << 20 // 512 MiB

// Config is what cmd/ resolves from the flags. No viper here by design.
type Config struct {
	// Dir is where artifacts live, one uuid directory per artifact.
	Dir string
}

// Module serves the artifact store.
type Module struct {
	store *Store
}

// New prepares the store, creating the directory so a bad --dir-artifacts
// fails at startup rather than on first write.
func New(cfg Config) (*Module, error) {
	store, err := NewStore(cfg.Dir)
	if err != nil {
		return nil, fmt.Errorf("--dir-artifacts: %w", err)
	}
	return &Module{store: store}, nil
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
		clientError(w, http.StatusBadRequest, "expected {worldUid, worldId, pipelineVersion, stage, create?}")
		return
	}
	uid, files, err := m.store.Resolve(request.Key, request.Create)
	if err != nil {
		respondStoreError(w, err)
		return
	}
	if request.Create {
		slog.Info("artifact resolved for writing", "artifact", uid, "uid", request.WorldUID, "world", request.WorldID, "version", request.PipelineVersion, "stage", request.Stage)
	}
	writeJSON(w, http.StatusOK, resolveResponse{ArtifactUID: uid, Files: files})
}

func (m *Module) handleGet(w http.ResponseWriter, r *http.Request) {
	raw, err := m.store.Read(r.PathValue("artifactUID"), r.PathValue("name"))
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
	body := http.MaxBytesReader(w, r.Body, uploadLimit)
	if err := m.store.Write(uid, r.PathValue("name"), body); err != nil {
		switch {
		case errors.Is(err, ErrBadPath):
			clientError(w, http.StatusBadRequest, "invalid artifact path")
		case errors.Is(err, ErrNotFound):
			// Writing into an unminted uid: resolve with create first. Loud on
			// purpose — accepting the write would mint entries out of thin air.
			clientError(w, http.StatusNotFound, "no such artifact — resolve with create first")
		default:
			// A body that exceeded the cap surfaces from the copy, not from the
			// path check, so it is reported here rather than as a store fault.
			clientError(w, http.StatusRequestEntityTooLarge, "artifact upload too large or truncated")
		}
		return
	}
	slog.Info("artifact stored", "artifact", uid, "name", r.PathValue("name"))
	// 204 rather than 201: a repeated upload of the same key is a no-op by
	// construction, so "created" would be a claim this store cannot make.
	w.WriteHeader(http.StatusNoContent)
}

func (m *Module) handleList(w http.ResponseWriter, r *http.Request) {
	artifacts, err := m.store.List()
	if err != nil {
		serverError(w, "listing artifacts", err)
		return
	}
	if artifacts == nil {
		artifacts = []ListedArtifact{}
	}
	usage, _ := m.store.Usage()
	writeJSON(w, http.StatusOK, map[string]any{"artifacts": artifacts, "bytes": usage})
}

func (m *Module) handleRemove(w http.ResponseWriter, r *http.Request) {
	if err := m.store.RemoveArtifact(r.PathValue("artifactUID")); err != nil {
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
		if err := m.store.RemoveWorld(world); err != nil {
			respondStoreError(w, err)
			return
		}
		slog.Info("artifacts dropped", "uid", world)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err := m.store.Clear(); err != nil {
		serverError(w, "clearing artifacts", err)
		return
	}
	slog.Info("artifact store cleared")
	w.WriteHeader(http.StatusNoContent)
}

func respondStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		clientError(w, http.StatusNotFound, "no such artifact")
	case errors.Is(err, ErrBadPath):
		clientError(w, http.StatusBadRequest, "invalid artifact path")
	default:
		serverError(w, "artifact store", err)
	}
}

func clientError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

// serverError logs the detail and returns a generic message: the cause belongs
// in the operator's log, not in a response body.
func serverError(w http.ResponseWriter, context string, err error) {
	slog.Error(context, "err", err)
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
