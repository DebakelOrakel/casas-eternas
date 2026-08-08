// Package world is the world SUBSYSTEM, not merely a store. Today it holds the
// saves — named, mutable, owned; later it grows the tile database and the world
// loop, which is why it is named for the domain rather than for its first job.
//
// Its counterpart internal/artifacts is the opposite kind of thing: a bag of
// derived files with no behaviour. That is the whole reason they are separate
// modules — mutable vs immutable, owned vs ownerless, irreplaceable vs
// recomputable — and only this one holds data a user can actually lose.
// See docs/decisions/server-storage.md.
//
// Skeleton: the routes exist and answer, the storage does not. Filling it in is
// the next step, and it starts with world.yaml gaining a stable metadata.uid —
// the key this store is addressed by, which no world carries yet.
package world

import (
	"fmt"
	"net/http"
	"os"
)

// Config is what cmd/ resolves from the flags. No viper here by design.
type Config struct {
	// Dir is where saved worlds live, one directory per world.
	Dir string
}

// Module serves the world store.
type Module struct {
	cfg Config
}

// New prepares the store. The directory is created eagerly so a bad --dir-world
// fails at startup, naming the flag, rather than on the first upload hours
// later.
func New(cfg Config) (*Module, error) {
	if cfg.Dir == "" {
		return nil, fmt.Errorf("--dir-world must not be empty")
	}
	if err := os.MkdirAll(cfg.Dir, 0o755); err != nil {
		return nil, fmt.Errorf("preparing --dir-world %q: %w", cfg.Dir, err)
	}
	return &Module{cfg: cfg}, nil
}

// Name identifies the module in logs and errors.
func (m *Module) Name() string { return "world" }

// Mount claims the world store's routes. The shape follows the decision doc:
// worlds are addressed by their stable uid, not by their terrain hash.
func (m *Module) Mount(mux *http.ServeMux) error {
	mux.HandleFunc("GET /v1/worlds", notImplemented)
	mux.HandleFunc("GET /v1/worlds/{worldUID}", notImplemented)
	mux.HandleFunc("PUT /v1/worlds/{worldUID}", notImplemented)
	mux.HandleFunc("DELETE /v1/worlds/{worldUID}", notImplemented)
	return nil
}

// Close releases the store. Nothing is held open yet.
func (m *Module) Close() error { return nil }

func notImplemented(w http.ResponseWriter, r *http.Request) {
	http.Error(w, "world store not implemented yet", http.StatusNotImplemented)
}
