package server

import (
	"net/http"
	"strings"

	"github.com/DebakelOrakel/casas-eternas/internal/identity"
)

// apiPrefix is what the gate protects. Everything outside it is the browser
// application — the shell, its assets and /config.json — which has to load
// before anyone can log in at all.
const apiPrefix = "/v1/"

// Gate refuses any API request it cannot attribute to somebody.
//
// ONE rule, stated once: everything under /v1/ needs a caller, except the paths
// named as exempt. The alternative — a check inside each handler — spreads a
// security decision across five files, and a decision in five places is one
// somebody eventually makes differently. It also means a route added tomorrow is
// protected by DEFAULT, which is the direction a mistake should fall in.
//
// It does not know about auth modes. In the local mode every caller resolves to
// identity.Local, which is not Anonymous, so the gate lets everyone through
// without a special case — the mode is expressed once, in the resolver, and
// nowhere else.
func Gate(caller *identity.Resolver, exempt []string) func(http.Handler) http.Handler {
	public := make(map[string]bool, len(exempt))
	for _, path := range exempt {
		public[path] = true
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !strings.HasPrefix(r.URL.Path, apiPrefix) || public[r.URL.Path] {
				next.ServeHTTP(w, r)
				return
			}
			if caller.Caller(r) == identity.Anonymous {
				// No WWW-Authenticate: this server's answer to "log in" is its
				// own form posting to the session endpoint, and that header
				// would summon the browser's native dialog instead — one with
				// no logout. See docs/decisions/server-auth.md.
				http.Error(w, "authentication required", http.StatusUnauthorized)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
