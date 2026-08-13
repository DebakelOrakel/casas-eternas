package docs

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/DebakelOrakel/casas-eternas/internal/config"
)

func TestServesTheSiteUnderItsPrefix(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<h1>docs</h1>"), 0o600); err != nil {
		t.Fatal(err)
	}
	var tree config.Config
	tree.Docs.Storage.Dir = &config.DirStorage{Path: dir}
	m, err := New(Config{All: tree})
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	if err := m.Mount(mux); err != nil {
		t.Fatal(err)
	}

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/docs/", nil))
	if recorder.Code != http.StatusOK || recorder.Body.String() != "<h1>docs</h1>" {
		t.Errorf("index = %d %q", recorder.Code, recorder.Body.String())
	}
	// A stale page costs more than the re-fetch it saves.
	if got := recorder.Header().Get("Cache-Control"); got != "no-cache" {
		t.Errorf("Cache-Control = %q", got)
	}

	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/docs", nil))
	if recorder.Code != http.StatusMovedPermanently {
		t.Errorf("bare /docs = %d, want a redirect", recorder.Code)
	}

	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/docs/absent.html", nil))
	if recorder.Code != http.StatusNotFound {
		t.Errorf("absent page = %d, want 404", recorder.Code)
	}
}

func TestWithoutADirectoryNothingIsServed(t *testing.T) {
	m, err := New(Config{})
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	if err := m.Mount(mux); err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/docs/", nil))
	if recorder.Code != http.StatusNotFound {
		t.Errorf("unmounted docs = %d, want 404", recorder.Code)
	}
}

func TestANamedButMissingDirectoryRefuses(t *testing.T) {
	var tree config.Config
	tree.Docs.Storage.Dir = &config.DirStorage{Path: "/definitely/not/there"}
	m, err := New(Config{All: tree})
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Mount(http.NewServeMux()); err == nil {
		t.Error("a named, missing directory mounted without complaint")
	}
}
