package server

import (
	"net/http"
	"strings"

	"github.com/DebakelOrakel/casas-eternas/internal/identity"
)

// apiPrefix is what the gate protects. Everything outside it is the browser
// application — the shell, its assets and /config.json — which has to load
// before anyone can log in at all.
const apiPrefix = APIPrefix + "/"

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
//
// `anonymous` is the one narrowing of the rule (2026-10-15, template worlds,
// docs/decisions/template-worlds.md): a request it accepts that carries NO
// credentials at all goes through to its module, which ranks the anonymous
// caller itself — the world module serves templates to everyone. A request
// with credentials that do not verify is still refused here, so a client
// whose session ran out learns it on every route, these included. Nil for
// none. Like `exempt`, a parameter: cmd/ composes it from the modules.
//
// `signed` is the other one (2026-10-16, DEC-0038 step 3): a request that
// carries its OWN authorization, a signed link, goes through when the
// predicate verifies it, whatever its Authorization header holds — the
// link is the right, so a stale session must not refuse it, and a client
// that follows a same-origin redirect keeps its header. A request it does
// not accept meets the rule above like any other. Nil for none.
func Gate(caller *identity.Resolver, exempt []string, anonymous, signed func(*http.Request) bool) func(http.Handler) http.Handler {
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
			if signed != nil && signed(r) {
				next.ServeHTTP(w, r)
				return
			}
			if caller.Caller(r) == identity.Anonymous {
				if anonymous != nil && r.Header.Get("Authorization") == "" && anonymous(r) {
					next.ServeHTTP(w, r)
					return
				}
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
