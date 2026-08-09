// Package identity answers one question: who is asking?
//
// It exists so that question has exactly ONE answer in the process. The world
// store records an owner, and the bake module compares against it — two
// modules resolving "the caller" independently would eventually disagree, and
// a disagreement here reads as a permission bug rather than as the drift it is.
//
// It answers WHO, never WHAT THEY MAY DO. Authorisation lives with the thing
// being protected, which is why the world store owns the owner and the bake
// module owns the comparison. See docs/decisions/server-auth.md.
package identity

import (
	"net/http"
	"strings"

	"github.com/DebakelOrakel/casas-eternas/internal/auth"
	"github.com/DebakelOrakel/casas-eternas/internal/config"
)

// Local is the synthetic owner every world gets while nobody authenticates.
// A real name rather than an empty string, so ownership is a value that can be
// compared from day one instead of a special case that has to be remembered.
const Local = "local"

// Anonymous is a caller that offered no credentials where credentials are
// required. Distinct from Local, which is a real (if synthetic) identity.
const Anonymous = ""

// Resolver turns a request into a caller.
//
// A value rather than a package-level function, because answering now needs a
// verifier and a verifier needs a key. Handing every module the same Resolver is
// what keeps the single answer single: the alternative — each module holding a
// mode and building its own verifier — is exactly the drift this package exists
// to prevent.
type Resolver struct {
	mode   config.AuthMode
	tokens *auth.Tokens
}

// NewResolver builds the process's one resolver.
//
// `tokens` may be nil in a mode that does not check identity; in a mode that
// does, its absence means no request can ever be attributed, which is a
// misconfiguration the caller is expected to have already refused.
func NewResolver(mode config.AuthMode, tokens *auth.Tokens) *Resolver {
	return &Resolver{mode: mode, tokens: tokens}
}

// ChecksIdentity reports whether authorisation decisions mean anything, so a
// module can ask its resolver instead of carrying an auth mode of its own.
func (r *Resolver) ChecksIdentity() bool { return r != nil && r.mode.ChecksIdentity() }

// Caller resolves who is making a request.
//
// In `none` mode everybody is Local — including a request carrying a token,
// because a server that is not checking has no basis to believe one.
//
// Everywhere else the answer comes from a token this server issued, verified
// for the session audience. Anything else is Anonymous: an absent token, an
// expired one, a forged one and one minted for a bake job all mean the same
// thing here, and none of them is a reason to fall back to a weaker identity.
func (r *Resolver) Caller(req *http.Request) string {
	if !r.ChecksIdentity() {
		return Local
	}
	if r.tokens == nil {
		return Anonymous
	}
	raw := bearer(req)
	if raw == "" {
		return Anonymous
	}
	subject, err := r.tokens.Verify(raw, auth.AudienceSession)
	if err != nil {
		return Anonymous
	}
	return subject
}

// bearer pulls the credential out of the Authorization header, case-insensitively
// on the scheme because RFC 7235 says the scheme is not case sensitive and some
// clients send "bearer".
func bearer(req *http.Request) string {
	header := strings.TrimSpace(req.Header.Get("Authorization"))
	scheme, value, found := strings.Cut(header, " ")
	if !found || !strings.EqualFold(scheme, "Bearer") {
		return ""
	}
	return strings.TrimSpace(value)
}
