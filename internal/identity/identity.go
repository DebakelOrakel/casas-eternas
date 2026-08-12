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
// Everywhere else the answer comes from a token this server issued. TWO KINDS
// are accepted, and they are deliberately different identities:
//
//   - a person's session, whose subject is the user
//   - a bake Job, whose subject is auth.SubjectBakeJob
//
// The second was missing until the first real cluster run, and its absence was
// written down as a FEATURE: a test asserted that a job token must not open the
// API. That was half right. A job must not be a LOGIN — it must not order bakes
// or pass an ownership check, and it does not, because its subject is not any
// user's. But it does have to read the world it was created to bake and write
// the artifacts it produces, both over this same API, so refusing it outright
// left the token it carries good for nothing.
//
// Anything else is Anonymous: absent, expired, forged, or issued elsewhere.
// None of them is a reason to fall back to a weaker identity.
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
	if subject, err := r.tokens.Verify(raw, auth.AudienceSession); err == nil {
		return subject
	}
	// A job's token, which names one job by audience.
	//
	// The subject CLAIM is deliberately ignored: a job is a job whatever it says
	// it is. Returning the claim let a token minted for "ada" with a bake
	// audience pass an ownership check as ada — caught by an existing test the
	// moment job tokens became callers at all. Relying on the one place that
	// mints them to always write the right subject is not a guarantee, it is a
	// habit; this makes impersonation impossible instead of unlikely.
	if _, _, err := r.tokens.VerifyBakeJob(raw); err == nil {
		return auth.SubjectBakeJob
	}
	return Anonymous
}

// Admin reports whether the request carries an admin's session.
//
// From the token's claim, verified locally — never a lookup: the name→id
// registry lives with the auth subsystem alone, and rights that had to be
// resolved elsewhere per request would break the split this design exists
// for. In the local mode the answer is false; `none` has no operators to
// distinguish, and the checks that consult this all answer yes there anyway.
func (r *Resolver) Admin(req *http.Request) bool {
	if !r.ChecksIdentity() || r.tokens == nil {
		return false
	}
	raw := bearer(req)
	if raw == "" {
		return false
	}
	_, admin, err := r.tokens.VerifySession(raw)
	return err == nil && admin
}

// BakeJob answers WHICH bake job is asking, if one is.
//
// The same question Caller answers, at the resolution the progress endpoint
// needs: a job's token names one job, so this is what turns "may this caller
// report for this job" into a comparison. It lives here rather than in the bake
// module for the reason the package exists — a second place resolving a caller
// would eventually disagree with this one, and a disagreement about identity
// reads as a permission bug.
//
// In the local mode this returns false: nothing is verified there, and the
// endpoint it serves is unreachable anyway (that runner reports over a pipe).
func (r *Resolver) BakeJob(req *http.Request) (jobID string, ok bool) {
	if !r.ChecksIdentity() || r.tokens == nil {
		return "", false
	}
	raw := bearer(req)
	if raw == "" {
		return "", false
	}
	_, id, err := r.tokens.VerifyBakeJob(raw)
	if err != nil {
		return "", false
	}
	return id, true
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
