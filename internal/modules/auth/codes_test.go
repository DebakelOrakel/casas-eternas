package auth

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// The admin API on the network, invites and resets end to end: an admin
// makes a code, a stranger registers with it and is signed in, the code
// runs out; a reset sets a password once; a non-admin is refused; and an
// admin cannot remove themselves over the network.
func TestCodesAndNetworkAdmin(t *testing.T) {
	m, _ := newTestModule(t, time.Hour)
	if err := m.cfg.Registry.SetRole("ada", "admin"); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	if err := m.Mount(mux); err != nil {
		t.Fatal(err)
	}
	tokenOf := func(rec *httptest.ResponseRecorder) string {
		t.Helper()
		var out struct {
			Token string `json:"token"`
		}
		if json.Unmarshal(rec.Body.Bytes(), &out) != nil || out.Token == "" {
			t.Fatalf("no token in %d %s", rec.Code, rec.Body.String())
		}
		return out.Token
	}
	do := func(method, path, bearer, body string) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, path, bytes.NewBufferString(body))
		request.RemoteAddr = "192.0.2.1:1234"
		if bearer != "" {
			request.Header.Set("Authorization", "Bearer "+bearer)
		}
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, request)
		return recorder
	}
	admin := tokenOf(login(t, m, "ada", "Geheim-2026"))

	created := do(http.MethodPost, AdminPrefix+"/invites", admin, `{"uses":2,"validHours":24}`)
	var invite struct {
		ID        string `json:"id"`
		Code      string `json:"code"`
		Left      int    `json:"left"`
		CreatedBy string `json:"createdBy"`
	}
	if created.Code != http.StatusCreated || json.Unmarshal(created.Body.Bytes(), &invite) != nil || len(invite.Code) != 19 || invite.Left != 2 || invite.CreatedBy != "ada" {
		t.Fatalf("create invite = %d %s", created.Code, created.Body.String())
	}

	// Listed with the code's last group as its hint — never the code, and
	// never its hash.
	open := do(http.MethodGet, AdminPrefix+"/invites", admin, "").Body.String()
	if !strings.Contains(open, `"hint":"`+invite.Code[15:]+`"`) || strings.Contains(open, invite.Code) || !strings.Contains(open, `"hash":""`) {
		t.Errorf("the open invite is listed as %s", open)
	}

	// Registering: lower case and without dashes is the same code.
	sloppy := strings.ToLower(strings.ReplaceAll(invite.Code, "-", ""))
	grace := tokenOf(do(http.MethodPost, RedeemPath, "", `{"code":"`+sloppy+`","name":"grace","password":"Pw-passwort1"}`))
	if got := do(http.MethodPost, RedeemPath, "", `{"code":"`+invite.Code+`","name":"grace","password":"Pw-passwort1"}`); got.Code != http.StatusConflict {
		t.Errorf("a taken name = %d, want 409", got.Code)
	}
	if got := do(http.MethodPost, RedeemPath, "", `{"code":"`+invite.Code+`","name":"x","password":"Pw-passwort1"}`); got.Code != http.StatusBadRequest {
		t.Errorf("a bad name = %d, want 400", got.Code)
	}
	tokenOf(do(http.MethodPost, RedeemPath, "", `{"code":"`+invite.Code+`","name":"linus","password":"Pw-passwort1"}`))
	if got := do(http.MethodPost, RedeemPath, "", `{"code":"`+invite.Code+`","name":"eve","password":"Pw-passwort1"}`); got.Code != http.StatusForbidden {
		t.Errorf("a spent code = %d, want 403", got.Code)
	}
	if list := do(http.MethodGet, AdminPrefix+"/invites", admin, ""); !strings.Contains(list.Body.String(), `"invites":[]`) {
		t.Errorf("a spent invite is still listed: %s", list.Body.String())
	}
	if users := do(http.MethodGet, AdminPrefix+"/users", admin, ""); !strings.Contains(users.Body.String(), `"invitedBy":"`+invite.ID+`","inviter":"ada"`) {
		t.Errorf("the user list does not say who came with the code: %s", users.Body.String())
	}

	// Not an admin: the admin API refuses.
	if got := do(http.MethodGet, AdminPrefix+"/users", grace, ""); got.Code != http.StatusForbidden {
		t.Errorf("a user on the admin API = %d, want 403", got.Code)
	}
	if got := do(http.MethodGet, AdminPrefix+"/users", "", ""); got.Code != http.StatusUnauthorized {
		t.Errorf("nobody on the admin API = %d, want 401", got.Code)
	}

	// A reset: once, then the code is gone.
	reset := do(http.MethodPost, AdminPrefix+"/users/grace/reset", admin, "")
	var resetCode struct {
		Code string `json:"code"`
	}
	if reset.Code != http.StatusCreated || json.Unmarshal(reset.Body.Bytes(), &resetCode) != nil {
		t.Fatalf("reset = %d %s", reset.Code, reset.Body.String())
	}
	tokenOf(do(http.MethodPost, RedeemPath, "", `{"code":"`+resetCode.Code+`","password":"Neu-passwort"}`))
	if got := login(t, m, "grace", "Neu-passwort"); got.Code != http.StatusOK {
		t.Errorf("login after the reset = %d", got.Code)
	}
	if got := do(http.MethodPost, RedeemPath, "", `{"code":"`+resetCode.Code+`","password":"Again-passwort"}`); got.Code != http.StatusForbidden {
		t.Errorf("a reset code used twice = %d, want 403", got.Code)
	}

	// Not on yourself over the network; on someone else, yes.
	if got := do(http.MethodPut, AdminPrefix+"/users/ada/role", admin, `{"role":"user"}`); got.Code != http.StatusConflict {
		t.Errorf("own demotion = %d, want 409", got.Code)
	}
	if got := do(http.MethodDelete, AdminPrefix+"/users/ada", admin, ""); got.Code != http.StatusConflict {
		t.Errorf("own deletion = %d, want 409", got.Code)
	}
	if got := do(http.MethodPut, AdminPrefix+"/users/grace/role", admin, `{"role":"admin"}`); got.Code != http.StatusNoContent {
		t.Errorf("another's role = %d, want 204", got.Code)
	}

	// A refresh answers the role as it is now: grace, promoted after her
	// sign-in, gets an access token with the claim.
	var graceSession struct {
		RefreshToken string `json:"refreshToken"`
	}
	_ = json.Unmarshal(login(t, m, "grace", "Neu-passwort").Body.Bytes(), &graceSession)
	if got := do(http.MethodPost, RefreshPath, graceSession.RefreshToken, ""); got.Code != http.StatusOK {
		t.Errorf("a refresh = %d, want 200", got.Code)
	} else if _, admin, err := m.cfg.Tokens.VerifySession(tokenOf(got)); err != nil || !admin {
		t.Errorf("the refreshed token has admin %v (%v)", admin, err)
	}
	if got := do(http.MethodPost, RefreshPath, grace, ""); got.Code != http.StatusUnauthorized {
		t.Errorf("an access token as a refresh token = %d, want 401", got.Code)
	}

	// Demoted: the token still carries the claim, the registry decides.
	graceAdmin := tokenOf(login(t, m, "grace", "Neu-passwort"))
	if got := do(http.MethodGet, AdminPrefix+"/users", graceAdmin, ""); got.Code != http.StatusOK {
		t.Fatalf("a promoted admin = %d, want 200", got.Code)
	}
	if got := do(http.MethodPut, AdminPrefix+"/users/grace/role", admin, `{"role":"user"}`); got.Code != http.StatusNoContent {
		t.Fatalf("demoting = %d, want 204", got.Code)
	}
	if got := do(http.MethodPut, AdminPrefix+"/users/ada/role", graceAdmin, `{"role":"user"}`); got.Code != http.StatusForbidden {
		t.Errorf("a demoted admin's old token = %d, want 403", got.Code)
	}

	// A password bcrypt cannot take is the caller's mistake, not a 500.
	long := strings.Repeat("x", 73)
	if got := do(http.MethodPost, RedeemPath, "", `{"code":"AAAA-BBBB-CCCC-DDDD","name":"bob","password":"`+long+`"}`); got.Code != http.StatusBadRequest {
		t.Errorf("a 73-byte password = %d, want 400", got.Code)
	}
}

// Guessing codes is turned away after a few tries from one address.
func TestRedeemIsRateLimited(t *testing.T) {
	m, _ := newTestModule(t, time.Hour)
	mux := http.NewServeMux()
	if err := m.Mount(mux); err != nil {
		t.Fatal(err)
	}
	last := 0
	for i := 0; i < redeemFailures+1; i++ {
		request := httptest.NewRequest(http.MethodPost, RedeemPath, strings.NewReader(`{"code":"AAAA-BBBB-CCCC-DDDD","name":"eve","password":"Pw-passwort1"}`))
		request.RemoteAddr = "198.51.100.7:999"
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, request)
		last = recorder.Code
	}
	if last != http.StatusTooManyRequests {
		t.Errorf("after %d wrong codes = %d, want 429", redeemFailures, last)
	}

	// From a public address, X-Forwarded-For is the client's own word: a
	// new one per request changes nothing.
	request := httptest.NewRequest(http.MethodPost, RedeemPath, strings.NewReader(`{"code":"AAAA-BBBB-CCCC-DDDD","name":"eve","password":"Pw-passwort1"}`))
	request.RemoteAddr = "198.51.100.7:999"
	request.Header.Set("X-Forwarded-For", "203.0.113.99")
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusTooManyRequests {
		t.Errorf("a forged X-Forwarded-For = %d, want 429", recorder.Code)
	}
}

// Behind a router (a private peer), the address it appended counts — the
// last one, not the client's first.
func TestClientAddrBehindARouter(t *testing.T) {
	for _, c := range []struct{ peer, forwarded, want string }{
		{"198.51.100.7:1", "1.2.3.4", "198.51.100.7"},
		{"10.0.0.5:1", "1.2.3.4, 203.0.113.9", "203.0.113.9"},
		{"127.0.0.1:1", "203.0.113.9", "203.0.113.9"},
		{"10.0.0.5:1", "", "10.0.0.5"},
	} {
		request := httptest.NewRequest(http.MethodPost, RedeemPath, nil)
		request.RemoteAddr = c.peer
		if c.forwarded != "" {
			request.Header.Set("X-Forwarded-For", c.forwarded)
		}
		if got := clientAddr(request); got != c.want {
			t.Errorf("peer %s, forwarded %q = %s, want %s", c.peer, c.forwarded, got, c.want)
		}
	}
}

// The auth module's routes beside the client module's "GET /" on one mux, as
// a full server mounts them: a pattern the two cannot rank is a panic at
// start, which a test of this module alone never sees.
func TestMountsBesideTheClient(t *testing.T) {
	m, _ := newTestModule(t, time.Hour)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /", func(http.ResponseWriter, *http.Request) {})
	defer func() {
		if recovered := recover(); recovered != nil {
			t.Fatalf("mounting beside GET / panics: %v", recovered)
		}
	}()
	if err := m.Mount(mux); err != nil {
		t.Fatal(err)
	}
}
