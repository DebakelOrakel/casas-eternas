package auth

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/token"
	"github.com/DebakelOrakel/casas-eternas/internal/user"
)

const signingKey = "a signing key long enough to be accepted"

func newTestModule(t *testing.T, ttl time.Duration) (*Module, *token.Tokens) {
	t.Helper()
	tokens, err := token.NewTokens([]byte(signingKey))
	if err != nil {
		t.Fatalf("NewTokens: %v", err)
	}
	registry, err := user.NewRegistry(t.TempDir())
	if err != nil {
		t.Fatalf("NewRegistry: %v", err)
	}
	if _, err := registry.Create("ada", "Geheim-2026"); err != nil {
		t.Fatalf("Create: %v", err)
	}
	m, err := New(Config{Tokens: tokens, TTL: ttl, SessionTTL: 24 * time.Hour, Registry: registry, StorageDir: t.TempDir()})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { m.Close() })
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
	recorder := login(t, m, "ada", "Geheim-2026")
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

	// The point of the endpoint: what it returns must open the door — and its
	// subject is the REGISTRY ID, never the name.
	subject, err := tokens.Verify(body.Token, token.AudienceSession)
	if err != nil {
		t.Fatalf("the issued token does not verify: %v", err)
	}
	entry, found := m.cfg.Registry.ByName("ada")
	if !found {
		t.Fatal("the created user has no registry entry")
	}
	if subject != entry.ID {
		t.Errorf("token subject = %q, want the registry id %q", subject, entry.ID)
	}
	if subject == "ada" {
		t.Error("the login name leaked into the token subject")
	}
	// The same person again is the same id — logging in twice must not fork
	// the identity.
	second := login(t, m, "ada", "Geheim-2026")
	var again response
	_ = json.NewDecoder(second.Body).Decode(&again)
	if s, _ := tokens.Verify(again.Token, token.AudienceSession); s != entry.ID {
		t.Errorf("second login subject = %q, want %q", s, entry.ID)
	}
	// Not on the admin list, so the claim must be absent.
	if _, admin, _ := tokens.VerifySession(body.Token); admin {
		t.Error("a plain user's session carries the admin claim")
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
		{"unknown user", "grace", "Geheim-2026"},
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

// A broken store is the server's fault, not the caller's. Answering 401 would
// send someone off to check a password that was never the problem.
func TestUnreadableStoreIsNotAWrongPassword(t *testing.T) {
	m, _ := newTestModule(t, time.Hour)
	// The cheapest honest breakage: a closed database refuses every read the
	// way a vanished volume would.
	if err := m.Close(); err != nil {
		t.Fatalf("closing: %v", err)
	}
	recorder := login(t, m, "ada", "Geheim-2026")
	if recorder.Code != http.StatusInternalServerError {
		t.Errorf("login against a broken store = %d, want 500", recorder.Code)
	}
}

// Every ingredient is required at construction, so a misconfiguration stops the
// server rather than producing an endpoint that cannot do its job.
func TestNewRequiresEverything(t *testing.T) {
	tokens, err := token.NewTokens([]byte(signingKey))
	if err != nil {
		t.Fatalf("NewTokens: %v", err)
	}
	registry, err := user.NewRegistry(t.TempDir())
	if err != nil {
		t.Fatalf("NewRegistry: %v", err)
	}
	defer registry.Close()
	for _, c := range []struct {
		name string
		cfg  Config
	}{
		{"no tokens", Config{Registry: registry, TTL: time.Hour}},
		{"no lifetime", Config{Registry: registry, Tokens: tokens}},
		{"negative lifetime", Config{Registry: registry, Tokens: tokens, TTL: -time.Hour}},
		{"no storage", Config{Registry: registry, Tokens: tokens, TTL: time.Hour}},
		{"no registry", Config{Tokens: tokens, TTL: time.Hour}},
	} {
		if _, err := New(c.cfg); err == nil {
			t.Errorf("%s: accepted", c.name)
		}
	}
}

// The admin CLAIM is minted at login from the user's ROLE in the store —
// the decision still travels in the token, so no process ever needs the
// registry to answer "is this an admin"; only its birthplace moved from the
// config list into auth.db (docs/decisions/server-user-admin.md).
func TestTheRoleMintsTheAdminClaim(t *testing.T) {
	m, tokens := newTestModule(t, time.Hour)
	if _, err := m.cfg.Registry.Create("root", "Geheim-2026"); err != nil {
		t.Fatal(err)
	}
	if err := m.cfg.Registry.SetRole("root", user.RoleAdmin); err != nil {
		t.Fatal(err)
	}
	recorder := login(t, m, "root", "Geheim-2026")
	if recorder.Code != http.StatusOK {
		t.Fatalf("admin login = %d: %s", recorder.Code, recorder.Body)
	}
	var body response
	if err := json.NewDecoder(recorder.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if _, admin, err := tokens.VerifySession(body.Token); err != nil || !admin {
		t.Errorf("admin session claim = %v (err %v), want true", admin, err)
	}

	// Rebinding to the default demotes — at the NEXT login, which is the
	// staleness the model always had.
	if err := m.cfg.Registry.SetRole("root", user.RoleUser); err != nil {
		t.Fatal(err)
	}
	again := login(t, m, "root", "Geheim-2026")
	var demoted response
	if err := json.NewDecoder(again.Body).Decode(&demoted); err != nil {
		t.Fatal(err)
	}
	if _, admin, _ := tokens.VerifySession(demoted.Token); admin {
		t.Error("a demoted user's fresh session still carries the admin claim")
	}
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
	request.SetBasicAuth("ada", "Geheim-2026")
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)
	if recorder.Code == http.StatusOK {
		t.Error("GET logged in")
	}
}
