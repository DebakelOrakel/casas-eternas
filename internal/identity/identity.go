// Package identity answers one question: who is asking?
//
// It exists so that question has exactly ONE answer in the process. The world
// store records an owner, and the bake module compares against it — two
// modules resolving "the caller" independently would eventually disagree, and
// a disagreement here reads as a permission bug rather than as the drift it is.
//
// Nothing is checked yet. `authMode: none` is the local mode by definition,
// and a local server is a person on their own machine; protecting them from
// themselves buys nothing (docs/decisions/distributed-bake.md). What matters
// today is that the code path EXISTS and runs, so it cannot rot before the
// mode that needs it arrives.
package identity

import (
	"net/http"
	"strings"

	"github.com/DebakelOrakel/casas-eternas/internal/config"
)

// Local is the synthetic owner every world gets while nobody authenticates.
// A real name rather than an empty string, so ownership is a value that can be
// compared from day one instead of a special case that has to be remembered.
const Local = "local"

// Anonymous is a caller that offered no credentials where credentials are
// required. Distinct from Local, which is a real (if synthetic) identity.
const Anonymous = ""

// Caller resolves who is making a request.
//
// In `none` mode everybody is Local — including a request carrying a token,
// because a server that is not checking has no basis to believe one.
func Caller(r *http.Request, mode config.AuthMode) string {
	if !mode.ChecksIdentity() {
		return Local
	}
	// Token and OIDC land here. Until they do, a mode that claims to check
	// identity must not quietly hand out Local — that would be the worst of
	// both, an authorisation system that says yes to everyone.
	token := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	if token == "" {
		return Anonymous
	}
	return Anonymous
}
