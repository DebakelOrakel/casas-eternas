package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/config"
	"github.com/DebakelOrakel/casas-eternas/internal/identity"
	"github.com/DebakelOrakel/casas-eternas/internal/token"
)

const gateKey = "a signing key long enough to be accepted"

// A handler that records whether it was reached at all — the question the gate
// answers is not "what status" but "did this run".
func reached(flag *bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		*flag = true
		w.WriteHeader(http.StatusOK)
	})
}

func newGate(t *testing.T, mode config.AuthMode) (func(http.Handler) http.Handler, *token.Tokens) {
	t.Helper()
	tokens, err := token.NewTokens([]byte(gateKey))
	if err != nil {
		t.Fatalf("NewTokens: %v", err)
	}
	resolver := identity.NewResolver(mode, tokens)
	// Literals rather than the modules' constants: the exempt list is a
	// PARAMETER, and this package deliberately imports no module. What cmd/
	// actually passes is checked where cmd/ builds it.
	return Gate(resolver, []string{"/config.json", CapabilitiesPath, "/v1/session"}), tokens
}

func request(t *testing.T, gate func(http.Handler) http.Handler, path, token string) (int, bool) {
	t.Helper()
	var ran bool
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	recorder := httptest.NewRecorder()
	gate(reached(&ran)).ServeHTTP(recorder, req)
	return recorder.Code, ran
}

// The four public paths, and the reason each one is public. If any of these ever
// starts answering 401, a logged-out browser cannot tell a dead server from one
// it simply has no session for.
func TestPublicPathsAnswerWithoutCredentials(t *testing.T) {
	gate, _ := newGate(t, config.AuthPassword)
	for _, path := range []string{
		"/config.json",    // where the API is and how to log in
		CapabilitiesPath,  // is this server answering
		"/v1/session",     // the login endpoint
		"/",               // the app shell
		"/assets/app.js",  // and its assets
		"/some/deep/link", // a bookmarked route the SPA router handles
	} {
		code, ran := request(t, gate, path, "")
		if !ran || code != http.StatusOK {
			t.Errorf("%s = %d (handler reached: %v), want 200", path, code, ran)
		}
	}
}

// The rule, from the other side: everything else under /v1/ is refused, and the
// handler is never reached — a gate that returned 401 after running the handler
// would have already done the thing.
func TestApiRequiresACaller(t *testing.T) {
	gate, tokens := newGate(t, config.AuthPassword)
	protected := []string{"/v1/worlds", "/v1/worlds/abc", "/v1/artifacts", "/v1/bakes", "/v1/anything-added-tomorrow"}

	for _, path := range protected {
		code, ran := request(t, gate, path, "")
		if code != http.StatusUnauthorized || ran {
			t.Errorf("%s without a token = %d (handler reached: %v), want 401 and not reached", path, code, ran)
		}
	}

	// Credentials that do not verify are worth exactly as much as none.
	for _, bad := range []string{"nonsense", "Bearer nonsense"} {
		code, ran := request(t, gate, "/v1/worlds", bad)
		if code != http.StatusUnauthorized || ran {
			t.Errorf("token %q = %d (reached: %v), want 401", bad, code, ran)
		}
	}

	expired, _, err := tokens.Issue("ada", token.AudienceSession, -time.Minute)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if code, ran := request(t, gate, "/v1/worlds", expired); code != http.StatusUnauthorized || ran {
		t.Errorf("an expired session opened the API: %d (reached: %v)", code, ran)
	}

	// And a real session does — the case that proves the refusals above are for
	// the right reason and not because the gate refuses everything.
	session, _, err := tokens.Issue("ada", token.AudienceSession, time.Hour)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	for _, path := range protected {
		if code, ran := request(t, gate, path, session); !ran || code != http.StatusOK {
			t.Errorf("%s with a session = %d (reached: %v), want 200", path, code, ran)
		}
	}
}

// A bake Job is a caller too, and this test used to assert the opposite.
//
// It read "a bake token must not open the API", which sounded like the audience
// split doing its job and was in fact a contradiction: a Job reads the world it
// was created to bake over this very API, so a token the gate refuses is a token
// good for nothing. The first real cluster run said so — "cannot read the world".
//
// What must remain true is the narrower thing: a job is not a LOGIN. Its subject
// is nobody's, so no ownership comparison accepts it — which is tested where
// ownership lives, in the bake module.
func TestABakeJobIsACallerButNotAUser(t *testing.T) {
	gate, tokens := newGate(t, config.AuthPassword)
	job, _, err := tokens.Issue(token.SubjectBakeJob, token.BakeAudience("job-1"), time.Hour)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if code, ran := request(t, gate, "/v1/worlds/abc", job); !ran || code != http.StatusOK {
		t.Errorf("a bake job could not read a world: %d (reached: %v)", code, ran)
	}

	// Still refused: expired, and issued somewhere else. A job token is not a
	// skeleton key, it is one more thing this server signed.
	expired, _, err := tokens.Issue(token.SubjectBakeJob, token.BakeAudience("job-1"), -time.Minute)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if code, ran := request(t, gate, "/v1/worlds/abc", expired); code != http.StatusUnauthorized || ran {
		t.Errorf("an expired job token was accepted: %d (reached: %v)", code, ran)
	}
	stranger, err := token.NewTokens([]byte("a different key, also long enough ok"))
	if err != nil {
		t.Fatalf("NewTokens: %v", err)
	}
	foreign, _, err := stranger.Issue(token.SubjectBakeJob, token.BakeAudience("job-1"), time.Hour)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if code, ran := request(t, gate, "/v1/worlds/abc", foreign); code != http.StatusUnauthorized || ran {
		t.Errorf("a job token signed elsewhere was accepted: %d (reached: %v)", code, ran)
	}
}

// The native browser dialog must never appear: it has no logout, and this server
// answers "log in" with its own form.
func TestGateDoesNotInviteBasicAuth(t *testing.T) {
	gate, _ := newGate(t, config.AuthPassword)
	req := httptest.NewRequest(http.MethodGet, "/v1/worlds", nil)
	recorder := httptest.NewRecorder()
	var ran bool
	gate(reached(&ran)).ServeHTTP(recorder, req)
	if got := recorder.Header().Get("WWW-Authenticate"); got != "" {
		t.Errorf("WWW-Authenticate = %q, want none", got)
	}
}

// The local mode must not change behaviour at all, and it needs no special case
// in the gate to manage it: every caller resolves to identity.Local, which is not
// Anonymous. This is the regression that would lock a single-user server out of
// its own worlds.
func TestLocalModePassesEverything(t *testing.T) {
	gate := Gate(identity.NewResolver(config.AuthNone, nil), []string{"/config.json"})
	for _, path := range []string{"/v1/worlds", "/v1/artifacts", "/config.json", "/"} {
		if code, ran := request(t, gate, path, ""); !ran || code != http.StatusOK {
			t.Errorf("none mode: %s = %d (reached: %v), want 200", path, code, ran)
		}
	}
}
