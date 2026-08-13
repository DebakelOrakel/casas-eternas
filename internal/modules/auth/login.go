// Package auth is the auth subsystem's module: the one door credentials go
// through, and — once the admin surface lands — the place users are
// administered. It was the session module until 2026-08-13; the auth TARGET
// is what lets a split deployment pin login (and the registry it writes) to
// one process. See docs/decisions/server-user-admin.md.
//
// It is deliberately the ONLY place a password is seen. Everything else on this
// server takes a token, which is why basic auth appears here and nowhere else:
// sending a password on every request would cost bcrypt's ~100 ms each time, and
// keeping it in a browser to be able to is worse than holding a token that
// expires. See docs/decisions/server-auth.md.
package auth

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/token"
	"github.com/DebakelOrakel/casas-eternas/internal/user"
)

// Path is where the client logs in. Reported in /config.json rather than
// hardcoded in the client, so the browser never has to know this server's route
// layout — and so `oidc` can name a foreign URL in the same place. That
// discovery is also what made the move from /v1/session harmless: the module's
// routes live under the module's namespace, and no client ever derived this.
const Path = "/v1/auth/session"

// Config is what cmd/ resolves from the flags. No viper here by design.
type Config struct {
	// Tokens mints what a successful login returns.
	Tokens *token.Tokens
	// TTL is how long an issued token is good for.
	TTL time.Duration
	// Registry verifies credentials AND answers who they belong to — one
	// lookup since identity and credential moved into one store
	// (docs/decisions/server-user-admin.md). The registry also carries each
	// user's global ROLE — the admin claim is state beside the credential,
	// not a config list, since 2026-08-13. The module OWNS the registry's
	// lifetime: Close releases auth.db and its file lock.
	Registry *user.Registry
}

// Module serves the login endpoint.
type Module struct {
	cfg Config
}

// New checks the module can actually do its job before the server starts.
func New(cfg Config) (*Module, error) {
	if cfg.Tokens == nil {
		return nil, fmt.Errorf("auth: no token issuer")
	}
	if cfg.TTL <= 0 {
		return nil, fmt.Errorf("auth: token lifetime is %v", cfg.TTL)
	}
	if cfg.Registry == nil {
		return nil, fmt.Errorf("auth: no user registry")
	}
	return &Module{cfg: cfg}, nil
}

// Name identifies the module in logs and errors.
func (m *Module) Name() string { return "auth" }

// Mount claims the login route.
func (m *Module) Mount(mux *http.ServeMux) error {
	mux.HandleFunc("POST "+Path, m.serveLogin)
	return nil
}

// Close releases the registry — the module holds auth.db open, and the file
// lock must not outlive the server.
func (m *Module) Close() error { return m.cfg.Registry.Close() }

// response is what a successful login returns. `expiresAt` so the client can
// renew before being surprised, `user` so it can show who is logged in without
// decoding the token — a client that parses a token starts depending on its
// format, and the format is ours to change.
type response struct {
	Token     string    `json:"token"`
	ExpiresAt time.Time `json:"expiresAt"`
	User      string    `json:"user"`
}

func (m *Module) serveLogin(w http.ResponseWriter, r *http.Request) {
	name, password, ok := r.BasicAuth()
	if !ok || name == "" {
		unauthorized(w)
		return
	}

	// One lookup answers both halves: whether the password is right, and WHO
	// it belongs to — a credential attaches to an identity in the store, so a
	// verified login always has its registry entry. The token's subject is
	// that stable id, never the login name: names are credential surface,
	// ids are what owners and grants record. Display stays the name, in the
	// response below.
	entry, valid, err := m.cfg.Registry.Verify(name, password)
	if err != nil {
		// The store is unreadable. That is a fault here, not a wrong
		// password, and answering 401 would send someone off to check a
		// password that was fine. It is also the one case worth logging
		// loudly: nobody can log in until it is fixed.
		slog.Error("cannot check credentials", "error", err)
		http.Error(w, "credentials cannot be checked", http.StatusInternalServerError)
		return
	}
	if !valid {
		unauthorized(w)
		return
	}
	issued, expires, err := m.cfg.Tokens.IssueSession(entry.ID, entry.Admin(), m.cfg.TTL)
	if err != nil {
		slog.Error("cannot issue a token", "error", err, "user", name)
		http.Error(w, "cannot issue a token", http.StatusInternalServerError)
		return
	}
	slog.Info("logged in", "user", name, "id", entry.ID, "admin", entry.Admin(), "expires", expires)

	w.Header().Set("Content-Type", "application/json")
	// A credential must never sit in a shared cache, and "no-store" is the only
	// directive that says so without exception.
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(response{Token: issued, ExpiresAt: expires, User: name})
}

// unauthorized refuses without saying which half was wrong, and — deliberately —
// without WWW-Authenticate.
//
// That header is what summons the browser's native basic-auth dialog: a prompt
// with no logout, no styling and no way for the app to know it happened. The
// endpoint still speaks basic auth, so `curl -u` works; only the invitation is
// withheld.
func unauthorized(w http.ResponseWriter) {
	http.Error(w, "invalid credentials", http.StatusUnauthorized)
}
