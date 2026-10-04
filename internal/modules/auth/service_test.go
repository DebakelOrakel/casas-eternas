package auth

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/token"
)

// A service account made over the admin surface trades its secret for a bus
// token of the worker kind — not a session — and nothing else does: not a
// user's password, not a wrong secret, not a deleted account's.
func TestServiceAccountBuysABusToken(t *testing.T) {
	m, tokens := newTestModule(t, time.Hour)
	admin := http.NewServeMux()
	if err := m.MountAdmin(admin); err != nil {
		t.Fatal(err)
	}
	public := http.NewServeMux()
	if err := m.Mount(public); err != nil {
		t.Fatal(err)
	}
	call := func(mux *http.ServeMux, method, path string, body any, name, secret string) *httptest.ResponseRecorder {
		var payload bytes.Buffer
		if body != nil {
			_ = json.NewEncoder(&payload).Encode(body)
		}
		request := httptest.NewRequest(method, path, &payload)
		if name != "" {
			request.SetBasicAuth(name, secret)
		}
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, request)
		return recorder
	}

	created := call(admin, http.MethodPost, ServicesPath, map[string]string{"name": "cluster-workers"}, "", "")
	if created.Code != http.StatusCreated {
		t.Fatalf("create = %d: %s", created.Code, created.Body)
	}
	var account CreatedService
	if err := json.Unmarshal(created.Body.Bytes(), &account); err != nil || account.Secret == "" {
		t.Fatalf("created %s: %v", created.Body, err)
	}

	bought := call(public, http.MethodPost, TokenPath, nil, "cluster-workers", account.Secret)
	if bought.Code != http.StatusOK {
		t.Fatalf("token = %d: %s", bought.Code, bought.Body)
	}
	var answer serviceTokenResponse
	if err := json.Unmarshal(bought.Body.Bytes(), &answer); err != nil {
		t.Fatal(err)
	}
	subject, err := tokens.VerifyRelay(answer.Token)
	if err != nil || subject != token.WorkerSubject(account.ID) || token.SubjectKind(subject) != token.SubjectWorker {
		t.Errorf("the bus token's subject %q (%v), want %q", subject, err, token.WorkerSubject(account.ID))
	}
	if _, _, err := tokens.VerifySession(answer.Token); err == nil {
		t.Error("the bus token opens a session")
	}
	if left := time.Until(answer.ExpiresAt); left > ServiceTokenTTL || left < ServiceTokenTTL-time.Minute {
		t.Errorf("the token holds %v, want %v", left, ServiceTokenTTL)
	}

	for name, credentials := range map[string][2]string{
		"a wrong secret":    {"cluster-workers", account.Secret + "x"},
		"a user's password": {"ada", "Geheim-2026"},
		"no credentials":    {"", ""},
	} {
		if got := call(public, http.MethodPost, TokenPath, nil, credentials[0], credentials[1]); got.Code != http.StatusUnauthorized {
			t.Errorf("%s: %d, want 401", name, got.Code)
		}
	}

	listed := call(admin, http.MethodGet, ServicesPath, nil, "", "")
	if !strings.Contains(listed.Body.String(), "cluster-workers") || strings.Contains(listed.Body.String(), account.Secret) {
		t.Errorf("listing %s", listed.Body)
	}
	if got := call(admin, http.MethodDelete, ServicesPath+"/cluster-workers", nil, "", ""); got.Code != http.StatusNoContent {
		t.Fatalf("delete = %d", got.Code)
	}
	if got := call(public, http.MethodPost, TokenPath, nil, "cluster-workers", account.Secret); got.Code != http.StatusUnauthorized {
		t.Errorf("a deleted account: %d, want 401", got.Code)
	}
}
