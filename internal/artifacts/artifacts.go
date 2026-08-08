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
// The path grammar mirrors the client's local OPFS layout
// (client/src/storage/ArtifactStore.ts) so a server tier slots in behind the
// same interface rather than needing a translation layer.
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
	// Dir is where artifacts live, under {worldId}/{pipelineVersion}/{stage}
	// as on the client.
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

// Mount claims the artifact routes. Artifacts are keyed by the CONTENT hash of
// the terrain (worldId), not by a world's stable uid — re-eroding a world must
// produce new artifacts while remaining the same world.
func (m *Module) Mount(mux *http.ServeMux) error {
	mux.HandleFunc("GET /v1/artifacts", m.handleList)
	mux.HandleFunc("DELETE /v1/artifacts", m.handleClear)
	mux.HandleFunc("DELETE /v1/artifacts/{worldID}", m.handleRemoveWorld)
	mux.HandleFunc("POST /v1/artifacts/{worldID}/{pipelineVersion}/{stage}/present", m.handlePresent)
	// `{name...}` rather than `{name}` so a future tile layout ("tiles/12_7")
	// needs no new route; every segment is validated in the store, which is
	// what keeps the flexibility from becoming a path traversal.
	mux.HandleFunc("GET /v1/artifacts/{worldID}/{pipelineVersion}/{stage}/{name...}", m.handleGet)
	mux.HandleFunc("PUT /v1/artifacts/{worldID}/{pipelineVersion}/{stage}/{name...}", m.handlePut)
	mux.HandleFunc("DELETE /v1/artifacts/{worldID}/{pipelineVersion}/{stage}/{name...}", m.handleRemoveFile)
	return nil
}

// Close releases the store. Nothing is held open.
func (m *Module) Close() error { return nil }

func keyFrom(r *http.Request) Key {
	return Key{
		WorldID:         r.PathValue("worldID"),
		PipelineVersion: r.PathValue("pipelineVersion"),
		Stage:           r.PathValue("stage"),
	}
}

func (m *Module) handleGet(w http.ResponseWriter, r *http.Request) {
	// "present" is a POST endpoint one level up; a GET landing here would be a
	// client mistake worth naming rather than a mysterious 404 for a file.
	raw, err := m.store.Read(keyFrom(r), r.PathValue("name"))
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
	key := keyFrom(r)
	body := http.MaxBytesReader(w, r.Body, uploadLimit)
	if err := m.store.Write(key, r.PathValue("name"), body); err != nil {
		if errors.Is(err, ErrBadPath) {
			clientError(w, http.StatusBadRequest, "invalid artifact path")
			return
		}
		// A body that exceeded the cap surfaces from the copy, not from the
		// path check, so it is reported here rather than as a store fault.
		clientError(w, http.StatusRequestEntityTooLarge, "artifact upload too large or truncated")
		return
	}
	slog.Info("artifact stored", "world", key.WorldID, "version", key.PipelineVersion, "stage", key.Stage, "name", r.PathValue("name"))
	// 204 rather than 201: a repeated upload of the same key is a no-op by
	// construction, so "created" would be a claim this store cannot make.
	w.WriteHeader(http.StatusNoContent)
}

type presentRequest struct {
	Names []string `json:"names"`
}

type presentResponse struct {
	Present []string `json:"present"`
	Missing []string `json:"missing"`
}

func (m *Module) handlePresent(w http.ResponseWriter, r *http.Request) {
	var request presentRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&request); err != nil {
		clientError(w, http.StatusBadRequest, "expected {\"names\": [...]}")
		return
	}
	present, err := m.store.Present(keyFrom(r), request.Names)
	if err != nil {
		respondStoreError(w, err)
		return
	}
	// Both halves are returned rather than just one: the caller wants to fetch
	// the gaps, and making it compute the difference invites an off-by-one in
	// every client that ever talks to this.
	has := make(map[string]bool, len(present))
	for _, name := range present {
		has[name] = true
	}
	missing := make([]string, 0, len(request.Names)-len(present))
	for _, name := range request.Names {
		if !has[name] {
			missing = append(missing, name)
		}
	}
	writeJSON(w, http.StatusOK, presentResponse{Present: present, Missing: missing})
}

func (m *Module) handleList(w http.ResponseWriter, r *http.Request) {
	worlds, err := m.store.List()
	if err != nil {
		serverError(w, "listing artifacts", err)
		return
	}
	if worlds == nil {
		worlds = []WorldArtifacts{}
	}
	usage, _ := m.store.Usage()
	writeJSON(w, http.StatusOK, map[string]any{"worlds": worlds, "bytes": usage})
}

func (m *Module) handleRemoveFile(w http.ResponseWriter, r *http.Request) {
	if err := m.store.RemoveFile(keyFrom(r), r.PathValue("name")); err != nil {
		respondStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (m *Module) handleRemoveWorld(w http.ResponseWriter, r *http.Request) {
	if err := m.store.RemoveWorld(r.PathValue("worldID")); err != nil {
		respondStoreError(w, err)
		return
	}
	slog.Info("artifacts dropped", "world", r.PathValue("worldID"))
	w.WriteHeader(http.StatusNoContent)
}

func (m *Module) handleClear(w http.ResponseWriter, r *http.Request) {
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
