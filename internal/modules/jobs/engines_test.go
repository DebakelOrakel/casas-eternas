package jobs

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
)

// memoryPipelineFiles is PipelineFiles in memory.
type memoryPipelineFiles struct {
	mu    sync.Mutex
	files map[string][]byte
}

func (s *memoryPipelineFiles) Link(_ context.Context, pipeline, file string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.files[pipeline+"/"+file]; !ok {
		return "", ErrNoPipelineFile
	}
	return "https://store.example/" + pipeline + "/" + file, nil
}

func (s *memoryPipelineFiles) Put(_ context.Context, pipeline, file string, body []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.files[pipeline+"/"+file] = body
	return nil
}

// releaseHost serves the release engine-<testPipeline> with one file, and
// counts the downloads of that file. `sums` is its SHA256SUMS.
func releaseHost(t *testing.T, body []byte, sums string) (string, *atomic.Int32) {
	t.Helper()
	downloads := &atomic.Int32{}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /engine-"+testPipeline+"/SHA256SUMS", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(sums))
	})
	mux.HandleFunc("GET /engine-"+testPipeline+"/pipeline.mjs", func(w http.ResponseWriter, _ *http.Request) {
		downloads.Add(1)
		_, _ = w.Write(body)
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server.URL, downloads
}

func getEngineFile(m *Module, pipeline, file string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodGet, "/v1/jobs/engines/"+pipeline+"/"+file, nil)
	request.SetPathValue("pipeline", pipeline)
	request.SetPathValue("file", file)
	recorder := httptest.NewRecorder()
	m.handleEngineFile(recorder, request)
	return recorder
}

// A file of a release: downloaded once, checked, stored, then served from
// the store by a link.
func TestEngineFilesComeFromTheRelease(t *testing.T) {
	body := []byte("the module")
	sum := sha256.Sum256(body)
	source, downloads := releaseHost(t, body, hex.EncodeToString(sum[:])+"  pipeline.mjs\n")
	store := &memoryPipelineFiles{files: map[string][]byte{}}
	m := &Module{cfg: Config{EngineSource: source, PipelineFiles: store}}

	for range 2 {
		got := getEngineFile(m, testPipeline, "pipeline.mjs")
		if got.Code != http.StatusFound || got.Header().Get("Location") != "https://store.example/"+testPipeline+"/pipeline.mjs" {
			t.Fatalf("got %d to %q", got.Code, got.Header().Get("Location"))
		}
	}
	if downloads.Load() != 1 {
		t.Errorf("%d downloads, want 1", downloads.Load())
	}
	if string(store.files[testPipeline+"/pipeline.mjs"]) != "the module" {
		t.Error("the file was not stored")
	}
}

func TestEngineFilesAreRefused(t *testing.T) {
	body := []byte("the module")
	source, _ := releaseHost(t, body, "0000  pipeline.mjs\n")
	store := &memoryPipelineFiles{files: map[string][]byte{}}
	m := &Module{cfg: Config{EngineSource: source, PipelineFiles: store}}
	cases := []struct {
		pipeline, file string
		want           int
	}{
		// Not the release's checksum: nothing stored.
		{testPipeline, "pipeline.mjs", http.StatusBadGateway},
		// Not in the release's SHA256SUMS.
		{testPipeline, "casas-engine-linux-amd64.node", http.StatusNotFound},
		// No such release.
		{"v0-none", "pipeline.mjs", http.StatusNotFound},
		// Not a file of a release.
		{testPipeline, "SHA256SUMS", http.StatusNotFound},
		{testPipeline, "..", http.StatusNotFound},
	}
	for _, c := range cases {
		if got := getEngineFile(m, c.pipeline, c.file).Code; got != c.want {
			t.Errorf("%s/%s = %d, want %d", c.pipeline, c.file, got, c.want)
		}
	}
	if len(store.files) != 0 {
		t.Errorf("stored %d files, want none", len(store.files))
	}
	// Without the artifacts target in this process.
	if got := getEngineFile(&Module{cfg: Config{EngineSource: source}}, testPipeline, "pipeline.mjs").Code; got != http.StatusServiceUnavailable {
		t.Errorf("without a store = %d, want 503", got)
	}
}

func TestEngineReadsNeedNoCaller(t *testing.T) {
	if !AnonymousReads(httptest.NewRequest(http.MethodGet, "/v1/jobs/engines/v11-x/pipeline.mjs", nil)) {
		t.Error("a pipeline file needs a caller")
	}
	if !AnonymousReads(httptest.NewRequest(http.MethodGet, "/v1/jobs/pipelines", nil)) {
		t.Error("the work per pipeline needs a caller")
	}
	if AnonymousReads(httptest.NewRequest(http.MethodGet, "/v1/jobs", nil)) {
		t.Error("the job list needs no caller")
	}
}

// The shipped release goes into the store once, each file checked against
// its SHA256SUMS; a file that does not match, or one beside no SHA256SUMS,
// does not.
func TestTheShippedReleaseIsStored(t *testing.T) {
	sum := func(body string) string {
		hash := sha256.Sum256([]byte(body))
		return hex.EncodeToString(hash[:])
	}
	files := map[string]string{
		"pipeline.json":                 `{"pipelineVersion":"` + testPipeline + `"}`,
		"pipeline.mjs":                  "the module",
		"casas-engine-linux-amd64.node": "an engine",
	}
	dir := t.TempDir()
	sums := ""
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		sums += sum(body) + "  " + name + "\n"
	}
	// Not the bytes the SHA256SUMS names.
	if err := os.WriteFile(filepath.Join(dir, "casas-engine-linux-amd64.node"), []byte("another engine"), 0o644); err != nil {
		t.Fatal(err)
	}
	store := &memoryPipelineFiles{files: map[string][]byte{}}
	seedPipelineFiles(context.Background(), dir, store)
	if len(store.files) != 0 {
		t.Fatalf("stored %d files beside no SHA256SUMS", len(store.files))
	}
	if err := os.WriteFile(filepath.Join(dir, "SHA256SUMS"), []byte(sums), 0o644); err != nil {
		t.Fatal(err)
	}
	seedPipelineFiles(context.Background(), dir, store)
	if len(store.files) != 2 || string(store.files[testPipeline+"/pipeline.mjs"]) != "the module" || store.files[testPipeline+"/pipeline.json"] == nil {
		t.Errorf("stored %v, want pipeline.mjs and pipeline.json", keys(store.files))
	}
	// Stored ones are not put again.
	store.files[testPipeline+"/pipeline.mjs"] = []byte("kept")
	seedPipelineFiles(context.Background(), dir, store)
	if string(store.files[testPipeline+"/pipeline.mjs"]) != "kept" {
		t.Error("a stored file was put again")
	}
}

func keys(m map[string][]byte) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// The incubator's version has its own release, with the incubator's native
// build in it: a file not in `engine-<version>` is looked for in
// `incubator-<version>`.
func TestTheIncubatorHasItsOwnRelease(t *testing.T) {
	body := []byte("the incubator's module")
	sum := sha256.Sum256(body)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /incubator-"+testPipeline+"/SHA256SUMS", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(hex.EncodeToString(sum[:]) + "  pipeline.mjs\n"))
	})
	mux.HandleFunc("GET /incubator-"+testPipeline+"/pipeline.mjs", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(body)
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	got, err := fetchReleaseFile(context.Background(), server.URL, testPipeline, "pipeline.mjs")
	if err != nil || string(got) != string(body) {
		t.Errorf("from the incubator's release: %q, %v", got, err)
	}
	if _, err := fetchReleaseFile(context.Background(), server.URL, testPipeline, "constants.json"); !errors.Is(err, errNoRelease) {
		t.Errorf("a file in neither release: %v", err)
	}
	if !releaseFile.MatchString("casas-incubator-linux-amd64.node") {
		t.Error("the incubator's native build is no release file")
	}
}
