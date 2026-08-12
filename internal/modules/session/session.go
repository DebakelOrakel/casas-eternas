// Package session is the one door credentials go through.
//
// It is deliberately the ONLY place a password is seen. Everything else on this
// server takes a token, which is why basic auth appears here and nowhere else:
// sending a password on every request would cost bcrypt's ~100 ms each time, and
// keeping it in a browser to be able to is worse than holding a token that
// expires. See docs/decisions/server-auth.md.
package session

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/auth"
	"github.com/DebakelOrakel/casas-eternas/internal/user"
)

// Path is where the client logs in. Reported in /config.json rather than
// hardcoded in the client, so the browser never has to know this server's route
// layout — and so `oidc` can name a foreign URL in the same place.
const Path = "/v1/session"

// Config is what cmd/ resolves from the flags. No viper here by design.
type Config struct {
	// Users verifies passwords. Absent in a mode that has no local user
	// database — `oidc`, once it exists.
	Users *auth.Users
	// Tokens mints what a successful login returns.
	Tokens *auth.Tokens
	// TTL is how long an issued token is good for.
	TTL time.Duration
	// Registry turns a verified login NAME into the stable user id a token's
	// subject carries — minting the entry on first sight. This hook is the
	// one place the registry grows; see docs/decisions/server-users.md.
	Registry *user.Registry
	// Admins are the login names whose sessions carry the admin claim,
	// resolved from global.auth.admins by cmd/.
	Admins map[string]bool
}

// Module serves the login endpoint.
type Module struct {
	cfg Config
}

// New checks the module can actually do its job before the server starts.
func New(cfg Config) (*Module, error) {
	if cfg.Tokens == nil {
		return nil, fmt.Errorf("session: no token issuer")
	}
	if cfg.Users == nil {
		return nil, fmt.Errorf("session: no user database")
	}
	if cfg.TTL <= 0 {
		return nil, fmt.Errorf("session: token lifetime is %v", cfg.TTL)
	}
	if cfg.Registry == nil {
		return nil, fmt.Errorf("session: no user registry")
	}
	return &Module{cfg: cfg}, nil
}

// Name identifies the module in logs and errors.
func (m *Module) Name() string { return "session" }

// Mount claims the login route.
func (m *Module) Mount(mux *http.ServeMux) error {
	mux.HandleFunc("POST "+Path, m.serveLogin)
	return nil
}

// Close releases the module. Nothing is held open.
func (m *Module) Close() error { return nil }

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

	valid, err := m.cfg.Users.Verify(name, password)
	if err != nil {
		// The user file is unreadable or malformed. That is a fault here, not a
		// wrong password, and answering 401 would send someone off to check a
		// password that was fine. It is also the one case worth logging loudly:
		// nobody can log in until it is fixed.
		slog.Error("cannot check credentials", "error", err, "file", m.cfg.Users.Path())
		http.Error(w, "credentials cannot be checked", http.StatusInternalServerError)
		return
	}
	if !valid {
		unauthorized(w)
		return
	}

	// The registry entry is minted HERE, after the password verified — the
	// token's subject is the stable id from then on, never the login name:
	// names are credential surface an operator edits, ids are what owners
	// and grants record. Display stays the name, in the response below.
	entry, err := m.cfg.Registry.Ensure(name)
	if err != nil {
		slog.Error("cannot register the user", "error", err, "user", name)
		http.Error(w, "cannot register the user", http.StatusInternalServerError)
		return
	}
	token, expires, err := m.cfg.Tokens.IssueSession(entry.ID, m.cfg.Admins[name], m.cfg.TTL)
	if err != nil {
		slog.Error("cannot issue a token", "error", err, "user", name)
		http.Error(w, "cannot issue a token", http.StatusInternalServerError)
		return
	}
	slog.Info("logged in", "user", name, "id", entry.ID, "admin", m.cfg.Admins[name], "expires", expires)

	w.Header().Set("Content-Type", "application/json")
	// A credential must never sit in a shared cache, and "no-store" is the only
	// directive that says so without exception.
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(response{Token: token, ExpiresAt: expires, User: name})
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
