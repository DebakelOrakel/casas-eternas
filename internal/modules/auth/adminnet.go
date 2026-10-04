package auth

import (
	"net/http"
	"strings"
)

// THE ADMIN API ON THE NETWORK (docs/decisions/client-accounts.md, fork 1):
// the admin socket's handlers, the same ones, under AdminPrefix on the
// network listener, for a session whose token carries the adm claim. The
// socket stays the way in for the first user and a locked-out deployment.
//
// One thing the network may not do that the socket may: an admin taking
// their own admin role away or deleting themselves. Over the network that
// is how the last admin locks everybody out; on the socket it is a choice
// someone with the machine can undo.

// AdminPrefix is where the admin API answers on the network listener:
// /v1/auth/admin/users is the socket's /v1/auth/users.
const AdminPrefix = "/v1/auth/admin"

func (m *Module) mountNetworkAdmin(mux *http.ServeMux) {
	inner := http.NewServeMux()
	_ = m.MountAdmin(inner)
	gated := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		caller, ok := m.me(w, r)
		if !ok {
			return
		}
		// The registry's role, not the token's adm claim: the claim says what
		// the role WAS at sign-in. A demoted admin's token keeps its claim
		// until it runs out, and over the network that would be time enough
		// to demote the one who demoted them; a promoted user's lacks it
		// while the panel already offers them the window.
		if !caller.Admin() {
			http.Error(w, "the admin API needs an administrator", http.StatusForbidden)
			return
		}
		path := "/v1/auth" + strings.TrimPrefix(r.URL.Path, AdminPrefix)
		if selfDemotion(r.Method, path, caller.Name) {
			http.Error(w, "not on yourself over the network: another admin, or the admin socket, can", http.StatusConflict)
			return
		}
		forwarded := withActor(r, caller.Name)
		target := *r.URL
		target.Path, target.RawPath = path, ""
		forwarded.URL = &target
		inner.ServeHTTP(w, forwarded)
	})
	// One pattern per method, never a method-less one: the client module's
	// "GET /" and a method-less "/v1/auth/admin/" are each more general than
	// the other in one respect, and ServeMux refuses the pair at mount
	// (2026-10-04, the first start with both). A method the admin API does
	// not have is answered by the inner mux as before.
	for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodDelete} {
		mux.Handle(method+" "+AdminPrefix+"/", gated)
	}
}

// selfDemotion is a call that deletes the caller or sets the caller's role.
func selfDemotion(method, path, name string) bool {
	own := UsersPath + "/" + name
	return (method == http.MethodDelete && path == own) || (method == http.MethodPut && path == own+"/role")
}
