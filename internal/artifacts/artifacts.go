// Package artifacts is the ARTIFACT store: derived data such as the amplification
// bake's rasters and, later, tiles.
//
// Named for what it HOLDS, not for being a cache — the client's OPFS copy is a
// cache, this one is the shared authoritative copy. What both do share is the
// property its counterpart internal/world does NOT have: everything here is a
// deterministic function of a world plus a pipeline version, so it can be
// dropped at any time and recomputed. That is why the two are separate modules
// with deliberately different delete affordances in the UI.
//
// Skeleton: routes only. The path grammar mirrors the client's local OPFS
// layout (client/src/storage/ArtifactStore.ts) so a server tier slots in behind
// the same interface rather than needing a translation layer.
package artifacts

import (
	"fmt"
	"net/http"
	"os"
)

// Config is what cmd/ resolves from the flags. No viper here by design.
type Config struct {
	// Dir is where artifacts live, under worlds/{worldId}/… as on the client.
	Dir string
}

// Module serves the artifact store.
type Module struct {
	cfg Config
}

// New prepares the store, creating the directory so a bad --dir-artifacts fails at
// startup rather than on first write.
func New(cfg Config) (*Module, error) {
	if cfg.Dir == "" {
		return nil, fmt.Errorf("--dir-artifacts must not be empty")
	}
	if err := os.MkdirAll(cfg.Dir, 0o755); err != nil {
		return nil, fmt.Errorf("preparing --dir-artifacts %q: %w", cfg.Dir, err)
	}
	return &Module{cfg: cfg}, nil
}

// Name identifies the module in logs and errors.
func (m *Module) Name() string { return "artifacts" }

// Mount claims the artifact routes. Artifacts are keyed by the CONTENT hash of
// the terrain (worldId), not by the world's stable uid — re-eroding a world
// must produce new artifacts while remaining the same world.
//
// `present` is the one addition plain REST needs here: at 8192² there are more
// tiles than a client should discover with one HEAD request each.
func (m *Module) Mount(mux *http.ServeMux) error {
	mux.HandleFunc("GET /v1/artifacts/{worldID}/{pipelineVersion}/{stage}/{name}", notImplemented)
	mux.HandleFunc("PUT /v1/artifacts/{worldID}/{pipelineVersion}/{stage}/{name}", notImplemented)
	mux.HandleFunc("POST /v1/artifacts/{worldID}/{pipelineVersion}/{stage}/present", notImplemented)
	return nil
}

// Close releases the store. Nothing is held open yet.
func (m *Module) Close() error { return nil }

func notImplemented(w http.ResponseWriter, r *http.Request) {
	http.Error(w, "artifact store not implemented yet", http.StatusNotImplemented)
}
