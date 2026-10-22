package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"syscall"
	"time"
)

// THE LAUNCHER (docs/decisions/engine-releases.md, fork 6): what
// `casas-eternas worker` runs, wherever a worker starts — the local pool
// (workerpool.go), the cluster's worker Deployment, a person on another
// machine. It chooses the pipeline that has the work, finds that pipeline's
// bundle and engine (the shipped ones, or the release's through the
// server), and runs `node <bundle> --serve` on them. A worker whose pipeline
// has no more work while another one has exits with exitSwitch
// (client/scripts/jobWorker.ts); the launcher then chooses again. Any other
// end of the worker ends the launcher with the worker's code, and its
// supervisor (the pool, Kubernetes) starts it again.

// LauncherConfig is what the launcher runs with.
type LauncherConfig struct {
	// The shipped bundle (jobs.worker), its engine beside it as
	// casas-engine.node.
	Bundle string
	// Where the bundles and engines of other pipelines are kept, one
	// directory per pipeline.
	CacheDir string
	// The Node heap ceiling, MB.
	HeapMB int
	// The serving argument, JSON (serveConfig, and jobWorker.ts's
	// ServeConfig): passed on unchanged. Its `jobs` is the API base the
	// launcher asks.
	Serve string
}

// exitSwitch is the worker's exit code for "another pipeline has the
// work": EX_TEMPFAIL.
const exitSwitch = 75

const (
	// How long the launcher waits for the work per pipeline.
	pipelinesTimeout = 10 * time.Second
	// How long one file of a release may take to come.
	pipelineFetchTimeout = 5 * time.Minute
)

// RunLauncher runs workers until one ends for another reason than a switch,
// and answers that worker's exit code. It stops the worker, and returns,
// when ctx is done.
func RunLauncher(ctx context.Context, cfg LauncherConfig) (int, error) {
	var serve serveConfig
	if err := json.Unmarshal([]byte(cfg.Serve), &serve); err != nil {
		return 0, fmt.Errorf("the serving argument is not JSON: %w", err)
	}
	own, err := WorkerVersion(ctx, cfg.Bundle)
	if err != nil {
		return 0, err
	}
	for {
		pipeline := choosePipeline(ctx, serve.Jobs, own)
		bundle := cfg.Bundle
		if pipeline != own {
			bundle, err = pipelineBundle(ctx, serve.Jobs, cfg.CacheDir, pipeline)
			if err != nil {
				slog.Warn("job worker: the bundle of another pipeline", "pipeline", pipeline, "err", err)
				bundle, pipeline = cfg.Bundle, own
			}
		}
		slog.Info("job worker starting", "pipeline", pipeline, "bundle", bundle)
		code, err := runServing(ctx, bundle, cfg.HeapMB, cfg.Serve)
		if err != nil || ctx.Err() != nil || code != exitSwitch {
			return code, err
		}
	}
}

// choosePipeline is the pipeline to serve: this installation's own while it
// has work or nobody has any, else the one with the most work. Without an
// answer from the server, the own one.
func choosePipeline(ctx context.Context, jobsAPI, own string) string {
	if jobsAPI == "" {
		return own
	}
	work, err := pipelinesWork(ctx, jobsAPI)
	if err != nil {
		slog.Warn("job worker: the work per pipeline", "err", err)
		return own
	}
	if work[own] > 0 || len(work) == 0 {
		return own
	}
	pipelines := make([]string, 0, len(work))
	for pipeline := range work {
		pipelines = append(pipelines, pipeline)
	}
	sort.Slice(pipelines, func(i, j int) bool {
		if work[pipelines[i]] != work[pipelines[j]] {
			return work[pipelines[i]] > work[pipelines[j]]
		}
		return pipelines[i] < pipelines[j]
	})
	return pipelines[0]
}

// pipelinesWork asks GET /v1/jobs/pipelines.
func pipelinesWork(ctx context.Context, jobsAPI string) (map[string]int, error) {
	ctx, cancel := context.WithTimeout(ctx, pipelinesTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, jobsAPI+"/jobs/pipelines", nil)
	if err != nil {
		return nil, err
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET /jobs/pipelines: %s", response.Status)
	}
	var answer pipelinesResponse
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&answer); err != nil {
		return nil, err
	}
	return answer.Pipelines, nil
}

// pipelineBundle is the bundle of `pipeline` in the cache, with its engine
// for this platform beside it, as the shipped one has: fetched from the
// server (GET /v1/jobs/engines) when it is not there, and checked to be
// that pipeline.
func pipelineBundle(ctx context.Context, jobsAPI, cacheDir, pipeline string) (string, error) {
	if jobsAPI == "" {
		return "", errors.New("the serving argument names no jobs API")
	}
	if !pipelinePattern.MatchString(pipeline) {
		return "", fmt.Errorf("%q is no pipeline", pipeline)
	}
	dir := filepath.Join(cacheDir, pipeline)
	bundle := filepath.Join(dir, "job-worker.mjs")
	files := map[string]string{
		"job-worker.mjs": bundle,
		"casas-engine-" + runtime.GOOS + "-" + runtime.GOARCH + ".node": filepath.Join(dir, "casas-engine.node"),
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	for name, path := range files {
		if _, err := os.Stat(path); err == nil {
			continue
		}
		if err := fetchPipelineFile(ctx, jobsAPI+"/jobs/engines/"+pipeline+"/"+name, path); err != nil {
			return "", fmt.Errorf("%s: %w", name, err)
		}
	}
	got, err := WorkerVersion(ctx, bundle)
	if err != nil {
		return "", err
	}
	if got != pipeline {
		return "", fmt.Errorf("the bundle in %s is %s, not %s", dir, got, pipeline)
	}
	return bundle, nil
}

// fetchPipelineFile downloads one file to `path`: into a temporary file
// beside it first, so that a broken download leaves no file behind.
func fetchPipelineFile(ctx context.Context, url, path string) error {
	ctx, cancel := context.WithTimeout(ctx, pipelineFetchTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s: %s", url, response.Status)
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(temporary.Name()) }()
	if _, err := io.Copy(temporary, io.LimitReader(response.Body, maxReleaseFile)); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporary.Name(), path)
}

// runServing runs one serving worker until it exits, and answers its exit
// code. When ctx is done it asks the worker to stop, as the pool does
// (workerpool.go, runWorker).
func runServing(ctx context.Context, bundle string, heapMB int, serve string) (int, error) {
	cmd := exec.Command("node", "--max-old-space-size="+strconv.Itoa(heapMB), bundle, "--serve", serve)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Start(); err != nil {
		return 0, fmt.Errorf("the job worker did not start: %w", err)
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	var err error
	select {
	case err = <-exited:
	case <-ctx.Done():
		_ = cmd.Process.Signal(syscall.SIGTERM)
		select {
		case err = <-exited:
		case <-time.After(workerStopGrace):
			_ = cmd.Process.Kill()
			err = <-exited
		}
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return exit.ExitCode(), nil
	}
	return 0, err
}
