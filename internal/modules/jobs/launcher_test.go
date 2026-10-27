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

// fakeHost is a job worker host for the launcher: it loads the pipeline
// module beside it or by --pipeline, as the real one does; `--version`
// tells the module's pipeline, `--serve` ends with the module's code.
const fakeHost = `import { pathToFileURL } from 'node:url'
const args = process.argv.slice(2)
const at = args.indexOf('--pipeline')
const path = at >= 0 ? args[at + 1] : new URL('./pipeline.mjs', import.meta.url).pathname
const module = await import(pathToFileURL(path).href)
if (args[0] === '--version') console.log(JSON.stringify({ pipelineVersion: module.version }))
else process.exit(module.serveExit)
`

// fakeModule is a pipeline module for fakeHost.
func fakeModule(pipeline string, code int) string {
	return "export const version = '" + pipeline + "'\nexport const serveExit = " + strconv.Itoa(code) + "\n"
}

// writeHost writes the host with its own module beside it.
func writeHost(t *testing.T, dir, pipeline string, code int) string {
	t.Helper()
	host := filepath.Join(dir, "job-worker.mjs")
	if err := os.WriteFile(host, []byte(fakeHost), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "pipeline.mjs"), []byte(fakeModule(pipeline, code)), 0o644); err != nil {
		t.Fatal(err)
	}
	return host
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
		case "pipeline.mjs":
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
		// The own history's work before another pipeline's.
		{map[string]int{"v0-history": 1, "v0-other": 9}, "v0-history"},
		{map[string]int{"v0-own": 1, "v0-history": 9}, "v0-own"},
	}
	for _, c := range cases {
		api, _, _ := jobsAPI(t, []map[string]int{c.work}, "")
		if got, _ := choosePipeline(context.Background(), api, "v0-own", "v0-history"); got != c.want {
			t.Errorf("work %v: %s, want %s", c.work, got, c.want)
		}
	}
	// No server, no answer: the own pipeline.
	if got, _ := choosePipeline(context.Background(), "", "v0-own", ""); got != "v0-own" {
		t.Errorf("without a jobs API: %s", got)
	}
	if got, _ := choosePipeline(context.Background(), "http://127.0.0.1:1/v1", "v0-own", ""); got != "v0-own" {
		t.Errorf("without an answer: %s", got)
	}
}

// The server names the pipelines that are histories': the launcher then
// fetches the history's native build too.
func TestTheLauncherKnowsAHistoryByTheServer(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/jobs/pipelines", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(pipelinesResponse{Pipelines: map[string]int{"v0-other": 2}, Histories: []string{"v0-other"}})
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	if got, isHistory := choosePipeline(context.Background(), server.URL+"/v1", "v0-own", ""); got != "v0-other" || !isHistory {
		t.Errorf("chose %s, a history %v; want v0-other, a history", got, isHistory)
	}
}

// Another pipeline's module and engine: fetched once into the cache, and
// refused when the module is another pipeline than its name.
func TestTheLauncherFetchesAndChecksAPipeline(t *testing.T) {
	api, _, fetched := jobsAPI(t, []map[string]int{{}}, fakeModule("v0-other", 0))
	host := writeHost(t, t.TempDir(), "v0-own", 0)
	cache := t.TempDir()
	for range 2 {
		module, err := pipelineModule(context.Background(), serveConfig{Jobs: api}, cache, host, "v0-other", false)
		if err != nil {
			t.Fatal(err)
		}
		if module != filepath.Join(cache, "v0-other", "pipeline.mjs") {
			t.Errorf("module %s", module)
		}
	}
	if fetched.Load() != 2 {
		t.Errorf("%d files fetched, want 2 (the module and the engine, once)", fetched.Load())
	}
	if engine, err := os.ReadFile(filepath.Join(cache, "v0-other", "casas-engine.node")); err != nil || string(engine) != "an engine" {
		t.Errorf("the engine beside the bundle: %q, %v", engine, err)
	}

	wrong, _, _ := jobsAPI(t, []map[string]int{{}}, fakeModule("v0-third", 0))
	if _, err := pipelineModule(context.Background(), serveConfig{Jobs: wrong}, t.TempDir(), host, "v0-other", false); err == nil {
		t.Error("a module of another pipeline was taken")
	}
}

// A link to this API that the server names by its address inside is asked
// at the worker's `api`; another link is followed as it is.
func TestTheLauncherAsksItsOwnAPI(t *testing.T) {
	outside := http.NewServeMux()
	outside.HandleFunc("GET /v1/artifacts/a/pipeline.mjs", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("the module"))
	})
	api := httptest.NewServer(outside)
	t.Cleanup(api.Close)
	jobs := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://stores.inside.invalid:8080/v1/artifacts/a/pipeline.mjs", http.StatusFound)
	}))
	t.Cleanup(jobs.Close)
	path := filepath.Join(t.TempDir(), "pipeline.mjs")
	if err := fetchPipelineFile(context.Background(), jobs.URL+"/v1/jobs/engines/v0-other/pipeline.mjs", api.URL, path); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(path); string(got) != "the module" {
		t.Errorf("got %q", got)
	}
}

// A worker that ends with exitSwitch is followed by the worker of the
// pipeline with the work; any other end ends the launcher with its code.
func TestTheLauncherSwitchesPipelines(t *testing.T) {
	api, asked, _ := jobsAPI(t, []map[string]int{{}, {"v0-other": 1}}, fakeModule("v0-other", 3))
	serve, _ := json.Marshal(serveConfig{Relay: "nats://unused", Pools: []string{poolTile}, Jobs: api})
	code, err := RunLauncher(context.Background(), LauncherConfig{
		Bundle:   writeHost(t, t.TempDir(), "v0-own", exitSwitch),
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
