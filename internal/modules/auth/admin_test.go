package auth

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/user"
)

func adminMux(t *testing.T, m *Module) *http.ServeMux {
	t.Helper()
	mux := http.NewServeMux()
	if err := m.MountAdmin(mux); err != nil {
		t.Fatalf("MountAdmin: %v", err)
	}
	return mux
}

func adminDo(t *testing.T, mux *http.ServeMux, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	var request *http.Request
	if body == "" {
		request = httptest.NewRequest(method, path, nil)
	} else {
		request = httptest.NewRequest(method, path, strings.NewReader(body))
	}
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)
	return recorder
}

// The whole administration loop: create, list, change the password, delete —
// each step verified against the LOGIN path, because an admin surface that
// says 201 while nobody can sign in has tested nothing.
func TestAdminUserLifecycle(t *testing.T) {
	m, _ := newTestModule(t, time.Hour)
	admin := adminMux(t, m)

	created := adminDo(t, admin, http.MethodPost, UsersPath, `{"name":"grace","password":"Hopper-1906"}`)
	if created.Code != http.StatusCreated {
		t.Fatalf("create = %d: %s", created.Code, created.Body)
	}
	var entry user.User
	if err := json.NewDecoder(created.Body).Decode(&entry); err != nil {
		t.Fatal(err)
	}
	if entry.ID == "" || entry.Name != "grace" {
		t.Errorf("created entry = %+v", entry)
	}
	if login(t, m, "grace", "Hopper-1906").Code != http.StatusOK {
		t.Error("the created user cannot log in")
	}

	listed := adminDo(t, admin, http.MethodGet, UsersPath, "")
	if listed.Code != http.StatusOK {
		t.Fatalf("list = %d", listed.Code)
	}
	var listing struct {
		Users []user.Listing `json:"users"`
	}
	if err := json.NewDecoder(listed.Body).Decode(&listing); err != nil {
		t.Fatal(err)
	}
	// ada from the fixture plus grace, sorted, both able to log in.
	if len(listing.Users) != 2 || listing.Users[0].Name != "ada" || listing.Users[1].Name != "grace" {
		t.Errorf("listing = %+v", listing.Users)
	}
	for _, u := range listing.Users {
		if !u.HasCredential {
			t.Errorf("%s listed without a credential", u.Name)
		}
	}

	if got := adminDo(t, admin, http.MethodPut, UsersPath+"/grace/password", `{"password":"Lovelace-1843"}`); got.Code != http.StatusNoContent {
		t.Fatalf("set password = %d: %s", got.Code, got.Body)
	}
	if login(t, m, "grace", "Hopper-1906").Code != http.StatusUnauthorized {
		t.Error("the old password still logs in")
	}
	if login(t, m, "grace", "Lovelace-1843").Code != http.StatusOK {
		t.Error("the new password does not log in")
	}

	if got := adminDo(t, admin, http.MethodDelete, UsersPath+"/grace", ""); got.Code != http.StatusNoContent {
		t.Fatalf("delete = %d: %s", got.Code, got.Body)
	}
	if login(t, m, "grace", "Lovelace-1843").Code != http.StatusUnauthorized {
		t.Error("a deleted user still logs in")
	}
}

// Each refusal carries the status the CLI turns into a message — and the
// SHAPE of a wrong request is refused loudly, because a typo'd field that
// decodes to an empty password would otherwise read as a store bug.
func TestAdminRefusals(t *testing.T) {
	m, _ := newTestModule(t, time.Hour)
	admin := adminMux(t, m)

	cases := []struct {
		name, method, path, body string
		want                     int
	}{
		{"duplicate create", http.MethodPost, UsersPath, `{"name":"ada","password":"Xx-passwort1"}`, http.StatusConflict},
		{"empty password", http.MethodPost, UsersPath, `{"name":"eve","password":""}`, http.StatusBadRequest},
		{"empty name", http.MethodPost, UsersPath, `{"name":"","password":"Xx-passwort1"}`, http.StatusBadRequest},
		{"unknown field", http.MethodPost, UsersPath, `{"name":"eve","pasword":"x"}`, http.StatusBadRequest},
		{"not json", http.MethodPost, UsersPath, `garbage`, http.StatusBadRequest},
		{"delete unknown", http.MethodDelete, UsersPath + "/nobody", "", http.StatusNotFound},
		{"passwd unknown", http.MethodPut, UsersPath + "/nobody/password", `{"password":"Xx-passwort1"}`, http.StatusNotFound},
		{"role for unknown user", http.MethodPut, UsersPath + "/nobody/role", `{"role":"admin"}`, http.StatusNotFound},
		{"unknown role", http.MethodPut, UsersPath + "/ada/role", `{"role":"emperor"}`, http.StatusBadRequest},
	}
	for _, c := range cases {
		if got := adminDo(t, admin, c.method, c.path, c.body); got.Code != c.want {
			t.Errorf("%s = %d, want %d: %s", c.name, got.Code, c.want, got.Body)
		}
	}
}

// The admin routes exist on the ADMIN mux alone. Mount (the network surface)
// must not know them: the socket's file permissions are the whole access
// control, and a copy of these routes on the TCP listener would bypass it.
func TestAdminRoutesStayOffTheNetworkListener(t *testing.T) {
	m, _ := newTestModule(t, time.Hour)
	network := http.NewServeMux()
	if err := m.Mount(network); err != nil {
		t.Fatal(err)
	}
	got := adminDo(t, network, http.MethodPost, UsersPath, `{"name":"eve","password":"Xx-passwort1"}`)
	if got.Code != http.StatusNotFound {
		t.Errorf("POST %s on the network mux = %d, want 404", UsersPath, got.Code)
	}
}
