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
// Skeleton: /config.json is real. Static file serving is NOT wired yet, because
// it needs a flag for the dist/ directory (and the config it reports needs ones
// for apiBase and authMode) — and flags get proposed before they get built.
package client

import (
	"encoding/json"
	"net/http"
)

// Config is what cmd/ resolves from the flags. No viper here by design.
type Config struct{}

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

	// AuthMode is none | token | oidc. Every code path exists from the start
	// so that SSO later is a config value rather than a refactor.
	AuthMode string `json:"authMode"`
}

// Mount claims the client's routes.
func (m *Module) Mount(mux *http.ServeMux) error {
	mux.HandleFunc("GET /config.json", m.serveConfig)
	return nil
}

func (m *Module) serveConfig(w http.ResponseWriter, r *http.Request) {
	// Never cached: it is how a deployment moves its storage, and a stale copy
	// would point a client at an address that no longer answers.
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(runtimeConfig{APIBase: "/v1", AuthMode: "none"})
}

// Close releases the module. Nothing is held open yet.
func (m *Module) Close() error { return nil }
