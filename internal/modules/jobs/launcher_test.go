package jobs

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"sync/atomic"
	"testing"
)

// fakeBundle is a job worker bundle for the launcher: `--version` tells
// `pipeline`, `--serve` ends with `code`.
func fakeBundle(pipeline string, code int) string {
	return `if (process.argv[2] === '--version') console.log(JSON.stringify({ pipelineVersion: '` + pipeline + `' }))
else process.exit(` + strconv.Itoa(code) + `)
`
}

func writeBundle(t *testing.T, dir, pipeline string, code int) string {
	t.Helper()
	path := filepath.Join(dir, "job-worker.mjs")
	if err := os.WriteFile(path, []byte(fakeBundle(pipeline, code)), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// jobsAPI serves the work per pipeline, one answer per call (the last one
// again after the end), and the files of pipeline v0-other.
func jobsAPI(t *testing.T, answers []map[string]int, other string) (string, *atomic.Int32, *atomic.Int32) {
	t.Helper()
	asked, fetched := &atomic.Int32{}, &atomic.Int32{}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/jobs/pipelines", func(w http.ResponseWriter, _ *http.Request) {
		n := int(asked.Add(1)) - 1
		_ = json.NewEncoder(w).Encode(pipelinesResponse{Pipelines: answers[min(n, len(answers)-1)]})
	})
	mux.HandleFunc("GET /v1/jobs/engines/v0-other/{file}", func(w http.ResponseWriter, r *http.Request) {
		fetched.Add(1)
		switch r.PathValue("file") {
		case "job-worker.mjs":
			_, _ = w.Write([]byte(other))
		case "casas-engine-" + runtime.GOOS + "-" + runtime.GOARCH + ".node":
			_, _ = w.Write([]byte("an engine"))
		default:
			http.NotFound(w, r)
		}
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server.URL + "/v1", asked, fetched
}

func TestTheLauncherChoosesThePipelineWithTheWork(t *testing.T) {
	cases := []struct {
		work map[string]int
		want string
	}{
		{map[string]int{}, "v0-own"},
		{map[string]int{"v0-own": 1, "v0-other": 9}, "v0-own"},
		{map[string]int{"v0-other": 2, "v0-third": 5}, "v0-third"},
		{map[string]int{"v0-b": 3, "v0-a": 3}, "v0-a"},
	}
	for _, c := range cases {
		api, _, _ := jobsAPI(t, []map[string]int{c.work}, "")
		if got := choosePipeline(context.Background(), api, "v0-own"); got != c.want {
			t.Errorf("work %v: %s, want %s", c.work, got, c.want)
		}
	}
	// No server, no answer: the own pipeline.
	if got := choosePipeline(context.Background(), "", "v0-own"); got != "v0-own" {
		t.Errorf("without a jobs API: %s", got)
	}
	if got := choosePipeline(context.Background(), "http://127.0.0.1:1/v1", "v0-own"); got != "v0-own" {
		t.Errorf("without an answer: %s", got)
	}
}

// Another pipeline's bundle and engine: fetched once into the cache, and
// refused when the bundle is another pipeline than its name.
func TestTheLauncherFetchesAndChecksAPipeline(t *testing.T) {
	api, _, fetched := jobsAPI(t, []map[string]int{{}}, fakeBundle("v0-other", 0))
	cache := t.TempDir()
	for range 2 {
		bundle, err := pipelineBundle(context.Background(), api, cache, "v0-other")
		if err != nil {
			t.Fatal(err)
		}
		if bundle != filepath.Join(cache, "v0-other", "job-worker.mjs") {
			t.Errorf("bundle %s", bundle)
		}
	}
	if fetched.Load() != 2 {
		t.Errorf("%d files fetched, want 2 (the bundle and the engine, once)", fetched.Load())
	}
	if engine, err := os.ReadFile(filepath.Join(cache, "v0-other", "casas-engine.node")); err != nil || string(engine) != "an engine" {
		t.Errorf("the engine beside the bundle: %q, %v", engine, err)
	}

	wrong, _, _ := jobsAPI(t, []map[string]int{{}}, fakeBundle("v0-third", 0))
	if _, err := pipelineBundle(context.Background(), wrong, t.TempDir(), "v0-other"); err == nil {
		t.Error("a bundle of another pipeline was taken")
	}
}

// A worker that ends with exitSwitch is followed by the worker of the
// pipeline with the work; any other end ends the launcher with its code.
func TestTheLauncherSwitchesPipelines(t *testing.T) {
	api, asked, _ := jobsAPI(t, []map[string]int{{}, {"v0-other": 1}}, fakeBundle("v0-other", 3))
	serve, _ := json.Marshal(serveConfig{Relay: "nats://unused", Pools: []string{poolTile}, Jobs: api})
	code, err := RunLauncher(context.Background(), LauncherConfig{
		Bundle:   writeBundle(t, t.TempDir(), "v0-own", exitSwitch),
		CacheDir: t.TempDir(),
		HeapMB:   64,
		Serve:    string(serve),
	})
	if err != nil {
		t.Fatal(err)
	}
	if code != 3 || asked.Load() != 2 {
		t.Errorf("code %d after %d choices, want 3 after 2", code, asked.Load())
	}
}
