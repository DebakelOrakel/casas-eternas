// Package docs serves the documentation site — the static rendering of the
// repo's docs/ tree (vision, decisions, design, changelog) that
// `npm run build:docs` emits.
//
// A second client-shaped module: serve a directory, nothing else. Serving it
// from the binary keeps a self-hosted deployment's documentation in version
// lockstep with the server; any static host works identically, which is the
// whole point of the bundle shape (docs/design/frontend-surfaces.md). PUBLIC
// by construction — the gate guards /v1/ and nothing else, and these pages
// are exactly the part of the repo declared public (docs/README.md; ideas/
// never enters the build).
package docs

import (
	"fmt"
	"log/slog"
	"net/http"
	"os"

	"github.com/DebakelOrakel/casas-eternas/internal/config"
)

// Prefix is where the site lives — one path below the origin, so the client
// links to it plainly and shares nothing with it but the address.
const Prefix = "/docs/"

// Config carries the full configuration tree (every module holds it whole —
// decided 2026-08-12). The module reads Global and its OWN section
// (`docs.*`), nothing else.
type Config struct {
	All config.Config
}

// Module serves the documentation site.
type Module struct {
	cfg Config
}

// New prepares the module.
func New(cfg Config) (*Module, error) { return &Module{cfg: cfg}, nil }

// Name identifies the module in logs and errors.
func (m *Module) Name() string { return "docs" }

// Dir is the built site's directory — empty when none is configured, which
// is the legitimate dev shape (vite proxies /docs to a server that has one,
// or the link 404s and nothing else suffers).
func (m *Module) Dir() string { return m.cfg.All.Docs.Storage.DirPath() }

// Mount claims the site's routes. Like the client module: no directory means
// serve nothing, but a directory that was NAMED and is missing fails — a
// default is a guess, a given value is an instruction.
func (m *Module) Mount(mux *http.ServeMux) error {
	if m.Dir() == "" {
		slog.Info("docs module serving nothing", "reason", "docs.storage not set")
		return nil
	}
	if _, err := os.Stat(m.Dir()); err != nil {
		return fmt.Errorf("docs.storage.dir.path %q: %w", m.Dir(), err)
	}
	files := http.StripPrefix(Prefix, http.FileServer(http.Dir(m.Dir())))
	mux.Handle("GET "+Prefix, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Never cached: the site redeploys with the server, and its pages are
		// small — a stale doc costs more than the re-fetch it saves.
		w.Header().Set("Cache-Control", "no-cache")
		files.ServeHTTP(w, r)
	}))
	// The bare path, so a typed-in /docs finds the site instead of a 404.
	mux.HandleFunc("GET /docs", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, Prefix, http.StatusMovedPermanently)
	})
	return nil
}

// Close releases the module. Nothing is held open.
func (m *Module) Close() error { return nil }
