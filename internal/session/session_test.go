package session

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/auth"
	"golang.org/x/crypto/bcrypt"
)

const signingKey = "a signing key long enough to be accepted"

func newTestModule(t *testing.T, ttl time.Duration) (*Module, *auth.Tokens) {
	t.Helper()
	hash, err := bcrypt.GenerateFromPassword([]byte("geheim"), auth.MinBcryptCost)
	if err != nil {
		t.Fatalf("hashing: %v", err)
	}
	path := filepath.Join(t.TempDir(), "htpasswd")
	if err := os.WriteFile(path, []byte("ada:"+string(hash)+"\n"), 0o600); err != nil {
		t.Fatalf("writing users: %v", err)
	}
	users, err := auth.NewUsers(path)
	if err != nil {
		t.Fatalf("NewUsers: %v", err)
	}
	tokens, err := auth.NewTokens([]byte(signingKey))
	if err != nil {
		t.Fatalf("NewTokens: %v", err)
	}
	m, err := New(Config{Users: users, Tokens: tokens, TTL: ttl})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return m, tokens
}

func login(t *testing.T, m *Module, name, password string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, Path, nil)
	if name != "" || password != "" {
		request.SetBasicAuth(name, password)
	}
	recorder := httptest.NewRecorder()
	mux := http.NewServeMux()
	if err := m.Mount(mux); err != nil {
		t.Fatalf("Mount: %v", err)
	}
	mux.ServeHTTP(recorder, request)
	return recorder
}

func TestLoginIssuesAUsableSession(t *testing.T) {
	m, tokens := newTestModule(t, time.Hour)
	recorder := login(t, m, "ada", "geheim")
	if recorder.Code != http.StatusOK {
		t.Fatalf("login = %d, want 200: %s", recorder.Code, recorder.Body)
	}

	var body response
	if err := json.NewDecoder(recorder.Body).Decode(&body); err != nil {
		t.Fatalf("decoding: %v", err)
	}
	if body.User != "ada" {
		t.Errorf("user = %q, want ada", body.User)
	}
	if time.Until(body.ExpiresAt) < 59*time.Minute {
		t.Errorf("expiresAt %v is not about an hour away", body.ExpiresAt)
	}

	// The point of the endpoint: what it returns must open the door.
	subject, err := tokens.Verify(body.Token, auth.AudienceSession)
	if err != nil {
		t.Fatalf("the issued token does not verify: %v", err)
	}
	if subject != "ada" {
		t.Errorf("token subject = %q, want ada", subject)
	}

	// A credential in a shared cache is a credential handed to the next person
	// through that proxy.
	if store := recorder.Header().Get("Cache-Control"); !strings.Contains(store, "no-store") {
		t.Errorf("Cache-Control = %q, want no-store", store)
	}
}

func TestLoginRefusals(t *testing.T) {
	m, _ := newTestModule(t, time.Hour)
	for _, c := range []struct{ name, user, password string }{
		{"wrong password", "ada", "falsch"},
		{"unknown user", "grace", "geheim"},
		{"empty password", "ada", ""},
		{"no credentials at all", "", ""},
	} {
		recorder := login(t, m, c.user, c.password)
		if recorder.Code != http.StatusUnauthorized {
			t.Errorf("%s = %d, want 401", c.name, recorder.Code)
		}
		// The native browser dialog is summoned by this header alone, and it
		// has no logout — which is the whole reason the app does its own form.
		if got := recorder.Header().Get("WWW-Authenticate"); got != "" {
			t.Errorf("%s sent WWW-Authenticate: %q", c.name, got)
		}
		if strings.Contains(recorder.Body.String(), "ada") {
			t.Errorf("%s named a user in its refusal: %s", c.name, recorder.Body)
		}
	}
}

// A broken user file is the server's fault, not the caller's. Answering 401
// would send someone off to check a password that was never the problem.
func TestUnreadableUserFileIsNotAWrongPassword(t *testing.T) {
	m, _ := newTestModule(t, time.Hour)
	if err := os.Remove(m.cfg.Users.Path()); err != nil {
		t.Fatalf("removing: %v", err)
	}
	recorder := login(t, m, "ada", "geheim")
	if recorder.Code != http.StatusInternalServerError {
		t.Errorf("login against a missing user file = %d, want 500", recorder.Code)
	}
}

// Every ingredient is required at construction, so a misconfiguration stops the
// server rather than producing an endpoint that cannot do its job.
func TestNewRequiresEverything(t *testing.T) {
	users, err := auth.NewUsers(writeUsers(t))
	if err != nil {
		t.Fatalf("NewUsers: %v", err)
	}
	tokens, err := auth.NewTokens([]byte(signingKey))
	if err != nil {
		t.Fatalf("NewTokens: %v", err)
	}
	for _, c := range []struct {
		name string
		cfg  Config
	}{
		{"no tokens", Config{Users: users, TTL: time.Hour}},
		{"no users", Config{Tokens: tokens, TTL: time.Hour}},
		{"no lifetime", Config{Users: users, Tokens: tokens}},
		{"negative lifetime", Config{Users: users, Tokens: tokens, TTL: -time.Hour}},
	} {
		if _, err := New(c.cfg); err == nil {
			t.Errorf("%s: accepted", c.name)
		}
	}
}

func writeUsers(t *testing.T) string {
	t.Helper()
	hash, err := bcrypt.GenerateFromPassword([]byte("pw"), auth.MinBcryptCost)
	if err != nil {
		t.Fatalf("hashing: %v", err)
	}
	path := filepath.Join(t.TempDir(), "htpasswd")
	if err := os.WriteFile(path, []byte("ada:"+string(hash)+"\n"), 0o600); err != nil {
		t.Fatalf("writing: %v", err)
	}
	return path
}

// GET must not reach the handler at all: the mux is what enforces the method,
// and a login that answered to a URL in a browser's address bar would put a
// password in history and in every access log between here and there.
func TestOnlyPostLogsIn(t *testing.T) {
	m, _ := newTestModule(t, time.Hour)
	mux := http.NewServeMux()
	if err := m.Mount(mux); err != nil {
		t.Fatalf("Mount: %v", err)
	}
	request := httptest.NewRequest(http.MethodGet, Path, nil)
	request.SetBasicAuth("ada", "geheim")
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)
	if recorder.Code == http.StatusOK {
		t.Error("GET logged in")
	}
}
