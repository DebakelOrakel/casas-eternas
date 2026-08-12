package client

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/DebakelOrakel/casas-eternas/internal/config"
)

// /config.json is the discovery document the browser boots from — what it
// says must match what the server enforces, which is the whole reason the
// module reads the resolved tree instead of its own setting.

func serveConfigJSON(t *testing.T, cfg Config) (*httptest.ResponseRecorder, map[string]json.RawMessage) {
	t.Helper()
	m, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	if err := m.Mount(mux); err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, ConfigPath, nil))
	var document map[string]json.RawMessage
	if err := json.Unmarshal(recorder.Body.Bytes(), &document); err != nil {
		t.Fatalf("config.json does not parse: %v", err)
	}
	return recorder, document
}

func TestConfigJSONTellsTheClientWhereAndHow(t *testing.T) {
	var tree config.Config
	tree.Global.Auth.Mode = "password"
	response, document := serveConfigJSON(t, Config{All: tree, LoginPath: "/v1/session"})

	// Never cached: it is how a deployment moves its storage.
	if got := response.Header().Get("Cache-Control"); got != "no-cache" {
		t.Errorf("Cache-Control = %q", got)
	}
	if got := string(document["apiBase"]); got != `"/v1"` {
		t.Errorf("apiBase = %s", got)
	}
	// Verbatim from the resolved tree — what the browser is told and what the
	// server enforces cannot differ, because both read the same value.
	if got := string(document["authMode"]); got != `"password"` {
		t.Errorf("authMode = %s", got)
	}
	var login struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(document["login"], &login); err != nil || login.Path != "/v1/session" {
		t.Errorf("login = %s (%v)", document["login"], err)
	}
}

func TestConfigJSONOmitsALoginNobodyServes(t *testing.T) {
	// Stating a login path with nothing listening there would send the client
	// to a 404; absence is the honest answer in `none` mode.
	var tree config.Config
	tree.Global.Auth.Mode = "none"
	_, document := serveConfigJSON(t, Config{All: tree})
	if _, present := document["login"]; present {
		t.Errorf("login should be absent, got %s", document["login"])
	}
}

func TestWithoutADirectoryOnlyConfigIsServed(t *testing.T) {
	// The dev-run shape: vite serves the app and proxies here — the module
	// answers /config.json and nothing else, rather than refusing to start.
	var tree config.Config
	m, err := New(Config{All: tree})
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	if err := m.Mount(mux); err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/", nil))
	if recorder.Code != http.StatusNotFound {
		t.Errorf("/ without a client directory = %d, want 404", recorder.Code)
	}
}
