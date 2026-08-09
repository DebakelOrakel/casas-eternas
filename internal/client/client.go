// Package client serves the browser client and, more importantly, tells it
// where the storage lives.
//
// The second job is the one that cannot be dropped. An earlier proposal let the
// API simply BE the page's own origin, which needs no configuration at all —
// and breaks the moment serving and storage are separate processes, which a
// real deployment does. What survives is the weaker claim: whoever serves the
// page knows where the storage is, and says so in /config.json.
// See docs/decisions/server-storage.md.
//
// It also serves the built client itself (--dir-client), which is what makes
// local play one command and one origin. `apiBase` is still the only sensible
// value; `authMode` now comes from the server's own resolved config, so what
// the browser is told and what the server enforces cannot differ.
package client

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/DebakelOrakel/casas-eternas/internal/config"
)

// Config is what cmd/ resolves from the flags. No viper here by design.
type Config struct {
	// Dir is the built client (vite's dist/). Serving it from the same process
	// is what makes local play one command and one origin — and therefore what
	// makes CORS never appear.
	Dir string
	// AuthMode is reported to the browser verbatim. Taken from the same
	// resolved value the server ENFORCES rather than written out here: a client
	// told "none" by a server that checks would show the wrong indicator and
	// offer affordances that then fail.
	AuthMode config.AuthMode
}

// Module serves the client and its runtime configuration.
type Module struct {
	cfg Config
}

// New prepares the module.
func New(cfg Config) (*Module, error) { return &Module{cfg: cfg}, nil }

// Name identifies the module in logs and errors.
func (m *Module) Name() string { return "client" }

// runtimeConfig is the document the browser fetches once at boot. It answers
// WHERE and HOW TO AUTHENTICATE only; what the storage can actually do comes
// from the storage itself, because the serving side cannot know it.
type runtimeConfig struct {
	// APIBase is relative by default, which keeps everything same-origin and
	// means CORS never arises — locally or in a cluster, where /v1 is routed
	// to the storage service through the same ingress. It becomes absolute
	// only when the storage genuinely should be a foreign origin.
	APIBase string `json:"apiBase"`

	// AuthMode is none | password | oidc, verbatim from --auth-mode. It tells
	// the client which login FLOW to run — a form for `password`, a redirect
	// for `oidc` — which is why the value names where the users live rather
	// than what the header looks like. See docs/decisions/server-auth.md.
	AuthMode string `json:"authMode"`
}

// ConfigPath is the discovery document, and it must answer before anyone has
// authenticated: a client that cannot read it cannot learn where to log in.
// Named here so the gate can exempt it without repeating the literal.
const ConfigPath = "/config.json"

// Mount claims the client's routes.
//
// /config.json is registered BEFORE the catch-all, and wins: Go's ServeMux
// prefers the more specific pattern regardless of registration order, but
// stating it here saves the next reader the trip to the documentation.
func (m *Module) Mount(mux *http.ServeMux) error {
	mux.HandleFunc("GET "+ConfigPath, m.serveConfig)
	// No directory means "tell the client where the API is, serve no files" —
	// exactly what a dev run wants, where vite serves the app and proxies here.
	// A directory that was NAMED and is missing is a different thing entirely,
	// and fails below: a default is a guess, a given value is an instruction.
	if m.Dir() == "" {
		slog.Info("client module serving /config.json only", "reason", "--dir-client not set")
		return nil
	}
	if _, err := os.Stat(m.Dir()); err != nil {
		return fmt.Errorf("--dir-client %q: %w", m.Dir(), err)
	}
	mux.Handle("GET /", m.spaHandler())
	return nil
}

// Dir is the resolved client directory.
func (m *Module) Dir() string { return m.cfg.Dir }

// spaHandler serves the built client, falling back to index.html.
//
// The fallback is what makes a single-page app work under a router: a deep
// link is a path the SERVER has no file for, and answering 404 would break
// every bookmark. It deliberately does NOT fall back for paths that look like
// assets — a missing script answering with HTML turns a clear 404 into a
// baffling parse error three layers down.
func (m *Module) spaHandler() http.Handler {
	files := http.FileServer(http.Dir(m.cfg.Dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		clean := filepath.Clean(r.URL.Path)
		if _, err := os.Stat(filepath.Join(m.cfg.Dir, clean)); err == nil {
			// Fingerprinted build assets are safe to cache forever; the shell
			// never is, or a deploy would not reach anyone who has visited.
			if strings.HasPrefix(clean, "/assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
			files.ServeHTTP(w, r)
			return
		}
		if path.Ext(clean) != "" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFile(w, r, filepath.Join(m.cfg.Dir, "index.html"))
	})
}

func (m *Module) serveConfig(w http.ResponseWriter, r *http.Request) {
	// Never cached: it is how a deployment moves its storage, and a stale copy
	// would point a client at an address that no longer answers.
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(runtimeConfig{APIBase: "/v1", AuthMode: string(m.cfg.AuthMode)})
}

// Close releases the module. Nothing is held open yet.
func (m *Module) Close() error { return nil }
