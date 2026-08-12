package identity

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/auth"
	"github.com/DebakelOrakel/casas-eternas/internal/config"
)

// Caller is the process's ONE answer to "who is asking" — every module's
// authorisation sits on it, so its table of cases is worth stating in full.
func TestCallerResolvesEveryKindOfCredential(t *testing.T) {
	tokens, err := auth.NewTokens([]byte("a signing key long enough to be accepted"))
	if err != nil {
		t.Fatal(err)
	}
	session, _, err := tokens.Issue("ada", auth.AudienceSession, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	// A bake token whose subject CLAIMS to be a user — the impersonation case:
	// the claim must be ignored, a job is a job whatever it says it is.
	disguisedJob, _, err := tokens.Issue("ada", auth.BakeAudience("job-1"), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	foreign, err := auth.NewTokens([]byte("a different signing key entirely, ok!!"))
	if err != nil {
		t.Fatal(err)
	}
	forged, _, err := foreign.Issue("ada", auth.AudienceSession, time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	checking := NewResolver(config.AuthPassword, tokens)
	local := NewResolver(config.AuthNone, nil)

	cases := []struct {
		name     string
		resolver *Resolver
		header   string
		want     string
	}{
		{"none mode, no credentials", local, "", Local},
		// Even a real token: a server that is not checking has no basis to
		// believe one, and must not half-check.
		{"none mode ignores tokens", local, "Bearer " + session, Local},
		{"checking, no credentials", checking, "", Anonymous},
		{"checking, nonsense", checking, "Bearer not-a-token", Anonymous},
		{"checking, wrong scheme", checking, "Basic dXNlcjpwdw==", Anonymous},
		{"checking, forged signature", checking, "Bearer " + forged, Anonymous},
		{"a session names its user", checking, "Bearer " + session, "ada"},
		// RFC 7235: the scheme is case-insensitive, and some clients send it
		// lowercase.
		{"lowercase bearer scheme", checking, "bearer " + session, "ada"},
		{"a job token is the job, never its subject claim", checking, "Bearer " + disguisedJob, auth.SubjectBakeJob},
	}
	for _, c := range cases {
		request := httptest.NewRequest(http.MethodGet, "/v1/worlds", nil)
		if c.header != "" {
			request.Header.Set("Authorization", c.header)
		}
		if got := c.resolver.Caller(request); got != c.want {
			t.Errorf("%s: Caller = %q, want %q", c.name, got, c.want)
		}
	}
}

// Admin comes from the session's claim, verified locally — and from nowhere
// else: a bake token, a forged token or the local mode must all answer false.
func TestAdminComesOnlyFromTheClaim(t *testing.T) {
	tokens, err := auth.NewTokens([]byte("a signing key long enough to be accepted"))
	if err != nil {
		t.Fatal(err)
	}
	adminSession, _, err := tokens.IssueSession("id-1", true, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	plainSession, _, err := tokens.IssueSession("id-2", false, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	job, _, err := tokens.Issue(auth.SubjectBakeJob, auth.BakeAudience("job-1"), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	checking := NewResolver(config.AuthPassword, tokens)

	cases := []struct {
		name     string
		resolver *Resolver
		header   string
		want     bool
	}{
		{"admin claim", checking, "Bearer " + adminSession, true},
		{"plain session", checking, "Bearer " + plainSession, false},
		{"bake token", checking, "Bearer " + job, false},
		{"no credentials", checking, "", false},
		{"local mode", NewResolver(config.AuthNone, nil), "Bearer " + adminSession, false},
	}
	for _, c := range cases {
		request := httptest.NewRequest(http.MethodGet, "/", nil)
		if c.header != "" {
			request.Header.Set("Authorization", c.header)
		}
		if got := c.resolver.Admin(request); got != c.want {
			t.Errorf("%s: Admin = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestBakeJobNamesExactlyItsOwnJob(t *testing.T) {
	tokens, err := auth.NewTokens([]byte("a signing key long enough to be accepted"))
	if err != nil {
		t.Fatal(err)
	}
	job, _, err := tokens.IssueBakeJob("job-7", "world-9", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	session, _, err := tokens.Issue("ada", auth.AudienceSession, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	checking := NewResolver(config.AuthPassword, tokens)

	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.Header.Set("Authorization", "Bearer "+job)
	if id, world, ok := checking.BakeJob(request); !ok || id != "job-7" || world != "world-9" {
		t.Errorf("BakeJob = %q/%q/%v, want job-7/world-9/true", id, world, ok)
	}

	// A session is a caller but not a job; the local mode verifies nothing.
	request.Header.Set("Authorization", "Bearer "+session)
	if _, _, ok := checking.BakeJob(request); ok {
		t.Error("a user session passed as a bake job")
	}
	if _, _, ok := NewResolver(config.AuthNone, nil).BakeJob(request); ok {
		t.Error("the local mode attributed a job id")
	}
}
