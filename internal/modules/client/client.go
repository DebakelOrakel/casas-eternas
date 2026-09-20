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
// It also serves the built client itself (client.storage), which is what makes
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

// Config carries the full configuration tree (every module holds it whole —
// decided 2026-08-12) plus the module's wiring. No viper here by design; the
// module reads Global and its OWN section, nothing else.
type Config struct {
	All config.Config
	// LoginPath is where the browser logs in, when there is anywhere to. Passed
	// in rather than imported from the session module: cmd/ is where modules are
	// composed, and a module reaching into another for a constant would make the
	// two impossible to mount apart.
	LoginPath string
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

	// AuthMode is none | password | oidc, verbatim from global.auth.mode. It tells
	// the client which login FLOW to run — a form for `password`, a redirect
	// for `oidc` — which is why the value names where the users live rather
	// than what the header looks like. See docs/decisions/server-auth.md.
	AuthMode string `json:"authMode"`

	// Login says WHERE to authenticate, which authMode alone does not: it states
	// that a login is required, never how to reach one. Absent when there is
	// nothing to log in to.
	//
	// Spelled out even under `password`, where the client could derive it from
	// apiBase — because the client has no business knowing this server's route
	// layout, and because `oidc` will put a FOREIGN url here that cannot be
	// derived at all.
	Login *login `json:"login,omitempty"`
}

// login is the discovery half of authentication.
type login struct {
	Path string `json:"path"`
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
		slog.Info("client module serving /config.json only", "reason", "client.storage not set")
		return nil
	}
	if _, err := os.Stat(m.Dir()); err != nil {
		return fmt.Errorf("client.storage.dir.path %q: %w", m.Dir(), err)
	}
	mux.Handle("GET /", m.spaHandler())
	return nil
}

// Dir is the resolved client directory — empty when no storage is configured,
// which is the legitimate dev-run shape (serve /config.json only).
func (m *Module) Dir() string { return m.cfg.All.Client.Storage.DirPath() }

// spaHandler serves the built client, falling back to index.html.
//
// The fallback is what makes a single-page app work under a router: a deep
// link is a path the SERVER has no file for, and answering 404 would break
// every bookmark. It deliberately does NOT fall back for paths that look like
// assets — a missing script answering with HTML turns a clear 404 into a
// baffling parse error three layers down.
func (m *Module) spaHandler() http.Handler {
	files := http.FileServer(http.Dir(m.Dir()))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Cross-origin isolation, so the page may use SharedArrayBuffer — the
		// erosion engine's worker pool shares its rasters through one
		// (docs/design/erosion-v2.md, multithreading). Browsers grant SAB only
		// when the DOCUMENT carries both headers; setting them on every
		// response from this handler is harmless (subresources ignore COOP)
		// and keeps the two serving branches below identical. The vite dev
		// server sets the same pair — change the two together. Under
		// require-corp any cross-origin SUBRESOURCE must opt in via CORP;
		// API calls are unaffected either way, because fetch() runs in CORS
		// mode, which COEP never restricts.
		//
		// CORP says of our own responses what is true of them: they are meant
		// for this origin and no other. same-origin, not same-site. It is NOT
		// what makes the generator's nested workers load in WebKit, which was
		// the first guess and was wrong — see client/vite.config.ts.
		w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		w.Header().Set("Cross-Origin-Embedder-Policy", "require-corp")
		w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
		clean := filepath.Clean(r.URL.Path)
		if _, err := os.Stat(filepath.Join(m.Dir(), clean)); err == nil {
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
		http.ServeFile(w, r, filepath.Join(m.Dir(), "index.html"))
	})
}

func (m *Module) serveConfig(w http.ResponseWriter, r *http.Request) {
	// Never cached: it is how a deployment moves its storage, and a stale copy
	// would point a client at an address that no longer answers.
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Content-Type", "application/json")
	// The literal mirrors server.APIPrefix, which this module must not import
	// (nothing imports internal/server); change the two together.
	document := runtimeConfig{APIBase: "/v1", AuthMode: m.cfg.All.Global.Auth.Mode}
	if m.cfg.LoginPath != "" {
		document.Login = &login{Path: m.cfg.LoginPath}
	}
	_ = json.NewEncoder(w).Encode(document)
}

// Close releases the module. Nothing is held open yet.
func (m *Module) Close() error { return nil }
