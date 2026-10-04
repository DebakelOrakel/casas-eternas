package auth

import (
	"bytes"
	"encoding/json"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// A png of the given size, for the avatar routes.
func pngOf(t *testing.T, w, h int) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, w, h))); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// The profile routes as a signed-in user uses them: read, rename, change
// the password, set and remove a picture — and only with a session.
func TestProfileRoutes(t *testing.T) {
	m, tokens := newTestModule(t, time.Hour)
	mux := http.NewServeMux()
	if err := m.Mount(mux); err != nil {
		t.Fatal(err)
	}
	var session struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(login(t, m, "ada", "geheim").Body.Bytes(), &session); err != nil || session.Token == "" {
		t.Fatalf("login: %v", err)
	}
	do := func(method, path, bearer, contentType string, body []byte) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, path, bytes.NewReader(body))
		if bearer != "" {
			request.Header.Set("Authorization", "Bearer "+bearer)
		}
		if contentType != "" {
			request.Header.Set("Content-Type", contentType)
		}
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, request)
		return recorder
	}
	var me profile
	read := do(http.MethodGet, MePath, session.Token, "", nil)
	if read.Code != http.StatusOK || json.Unmarshal(read.Body.Bytes(), &me) != nil || me.Name != "ada" || me.LastLoginAt == nil {
		t.Fatalf("GET me = %d %s", read.Code, read.Body.String())
	}

	if got := do(http.MethodPut, MePath, session.Token, "application/json", []byte(`{"displayName":"  Ada Lovelace "}`)); got.Code != http.StatusOK || !strings.Contains(got.Body.String(), `"displayName":"Ada Lovelace"`) {
		t.Errorf("rename = %d %s", got.Code, got.Body.String())
	}
	if got := do(http.MethodPut, MePath, session.Token, "application/json", []byte(`{"displayName":"`+strings.Repeat("x", 65)+`"}`)); got.Code != http.StatusBadRequest {
		t.Errorf("a long name = %d, want 400", got.Code)
	}

	if got := do(http.MethodPut, MePath+"/password", session.Token, "application/json", []byte(`{"current":"wrong","new":"neu"}`)); got.Code != http.StatusForbidden {
		t.Errorf("a wrong current password = %d, want 403", got.Code)
	}
	if got := do(http.MethodPut, MePath+"/password", session.Token, "application/json", []byte(`{"current":"geheim","new":"neu"}`)); got.Code != http.StatusNoContent {
		t.Errorf("a password change = %d, want 204", got.Code)
	}
	if got := login(t, m, "ada", "neu"); got.Code != http.StatusOK {
		t.Errorf("login with the new password = %d", got.Code)
	}

	avatar := pngOf(t, 256, 256)
	put := do(http.MethodPut, MePath+"/avatar", session.Token, "image/png", avatar)
	var set struct {
		Avatar string `json:"avatar"`
	}
	if put.Code != http.StatusOK || json.Unmarshal(put.Body.Bytes(), &set) != nil || set.Avatar == "" {
		t.Fatalf("PUT avatar = %d %s", put.Code, put.Body.String())
	}
	path := strings.Replace(AvatarPath, "{id}", me.ID, 1)
	got := do(http.MethodGet, path, session.Token, "", nil)
	if got.Code != http.StatusOK || !bytes.Equal(got.Body.Bytes(), avatar) || got.Header().Get("Content-Type") != "image/png" {
		t.Errorf("GET avatar = %d, %d bytes, %s", got.Code, got.Body.Len(), got.Header().Get("Content-Type"))
	}
	cached := httptest.NewRequest(http.MethodGet, path, nil)
	cached.Header.Set("If-None-Match", got.Header().Get("ETag"))
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, cached)
	if recorder.Code != http.StatusNotModified {
		t.Errorf("a cached avatar = %d, want 304", recorder.Code)
	}
	for _, c := range []struct {
		name, contentType string
		body              []byte
		want              int
	}{
		{"not square", "image/png", pngOf(t, 256, 128), http.StatusBadRequest},
		{"too small", "image/png", pngOf(t, 32, 32), http.StatusBadRequest},
		{"not an image", "image/png", []byte("hello"), http.StatusBadRequest},
		{"another type", "image/gif", avatar, http.StatusUnsupportedMediaType},
		{"jpeg declared, png sent", "image/jpeg", avatar, http.StatusBadRequest},
	} {
		if got := do(http.MethodPut, MePath+"/avatar", session.Token, c.contentType, c.body); got.Code != c.want {
			t.Errorf("%s = %d, want %d", c.name, got.Code, c.want)
		}
	}
	if got := do(http.MethodDelete, MePath+"/avatar", session.Token, "", nil); got.Code != http.StatusNoContent {
		t.Errorf("DELETE avatar = %d", got.Code)
	}
	if got := do(http.MethodGet, path, session.Token, "", nil); got.Code != http.StatusNotFound {
		t.Errorf("a removed avatar = %d, want 404", got.Code)
	}

	// A job's token is not a person.
	job, _, err := tokens.IssueJob("j1", "w1", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if got := do(http.MethodGet, MePath, job, "", nil); got.Code != http.StatusUnauthorized {
		t.Errorf("GET me with a job token = %d, want 401", got.Code)
	}
	if got := do(http.MethodGet, MePath, "", "", nil); got.Code != http.StatusUnauthorized {
		t.Errorf("GET me without a token = %d, want 401", got.Code)
	}
}
