package jobs

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
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
	mux.HandleFunc("GET /engine-"+testPipeline+"/job-worker.mjs", func(w http.ResponseWriter, _ *http.Request) {
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
	body := []byte("the bundle")
	sum := sha256.Sum256(body)
	source, downloads := releaseHost(t, body, hex.EncodeToString(sum[:])+"  job-worker.mjs\n")
	store := &memoryPipelineFiles{files: map[string][]byte{}}
	m := &Module{cfg: Config{EngineSource: source, PipelineFiles: store}}

	for range 2 {
		got := getEngineFile(m, testPipeline, "job-worker.mjs")
		if got.Code != http.StatusFound || got.Header().Get("Location") != "https://store.example/"+testPipeline+"/job-worker.mjs" {
			t.Fatalf("got %d to %q", got.Code, got.Header().Get("Location"))
		}
	}
	if downloads.Load() != 1 {
		t.Errorf("%d downloads, want 1", downloads.Load())
	}
	if string(store.files[testPipeline+"/job-worker.mjs"]) != "the bundle" {
		t.Error("the file was not stored")
	}
}

func TestEngineFilesAreRefused(t *testing.T) {
	body := []byte("the bundle")
	source, _ := releaseHost(t, body, "0000  job-worker.mjs\n")
	store := &memoryPipelineFiles{files: map[string][]byte{}}
	m := &Module{cfg: Config{EngineSource: source, PipelineFiles: store}}
	cases := []struct {
		pipeline, file string
		want           int
	}{
		// Not the release's checksum: nothing stored.
		{testPipeline, "job-worker.mjs", http.StatusBadGateway},
		// Not in the release's SHA256SUMS.
		{testPipeline, "casas-engine-linux-amd64.node", http.StatusNotFound},
		// No such release.
		{"v0-none", "job-worker.mjs", http.StatusNotFound},
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
	if got := getEngineFile(&Module{cfg: Config{EngineSource: source}}, testPipeline, "job-worker.mjs").Code; got != http.StatusServiceUnavailable {
		t.Errorf("without a store = %d, want 503", got)
	}
}

func TestEngineReadsNeedNoCaller(t *testing.T) {
	if !AnonymousReads(httptest.NewRequest(http.MethodGet, "/v1/jobs/engines/v11-x/job-worker.mjs", nil)) {
		t.Error("a pipeline file needs a caller")
	}
	if !AnonymousReads(httptest.NewRequest(http.MethodGet, "/v1/jobs/pipelines", nil)) {
		t.Error("the work per pipeline needs a caller")
	}
	if AnonymousReads(httptest.NewRequest(http.MethodGet, "/v1/jobs", nil)) {
		t.Error("the job list needs no caller")
	}
}
