package jobs

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// How a job actually gets run.
//
// An interface with one implementation, which is usually a smell — here it is
// the seam the whole "distribute it later" story hangs on. A pool, a queue
// consumer or a remote worker each becomes another Runner, and the queue and
// the routes above never learn about it.

// Progress is reported as the pipeline moves, so a caller polling a job sees
// something more useful than "running" for seven minutes.
type Progress struct {
	Phase   string `json:"phase"`
	Percent int    `json:"percent"`
}

type Runner interface {
	Run(ctx context.Context, spec Spec, onProgress func(Progress)) (Result, error)
}

// Spec is a Request resolved against the stores: what the runner needs to
// actually do the work, rather than the ids the caller used.
//
// It carries BOTH shapes because the same bake runs in two places. A local
// subprocess sits next to the files and gets paths. A Kubernetes Job may land
// on any node — usually not the server's — and cannot count on mounting the
// server's ReadWriteOnce volume, so it gets URLs and a token instead.
//
// This struct IS the wire format: it is marshalled straight into the baker's
// argv, so these field names are a contract with client/scripts/bake.ts.
// Measured 2026-08-08: the two shapes produce byte-identical artifacts, which
// is the property that lets either run without anyone downstream caring.
type Spec struct {
	Stage         int `json:"stage"`
	ErosionRounds int `json:"erosionRounds"`
	// The tile, for stage 2.
	Tile *TileRef `json:"tile,omitempty"`
	// The artifact stage the job produces (Request.StageName), for the
	// runner that reports a result without reading the worker's output.
	// Not sent to the worker.
	StageName string `json:"-"`

	// Exactly one of each pair.
	WorldZip     string `json:"worldZip,omitempty"`
	WorldURL     string `json:"worldUrl,omitempty"`
	ArtifactsDir string `json:"artifactsDir,omitempty"`
	ArtifactsURL string `json:"artifactsUrl,omitempty"`

	// Bearer token for the URL form, naming this one job.
	AuthToken string `json:"authToken,omitempty"`

	// API base of the bake module that commissioned the job — where progress
	// reports go. Named for the MODULE it addresses, like ArtifactsURL, not
	// for the one route the baker currently posts to. Only a cluster Job
	// carries it; without it the baker falls back to ArtifactsURL, the
	// co-resident shape.
	JobsURL string `json:"jobsUrl,omitempty"`

	// The task's id, when the coordinator handed it out (coordinator.go):
	// what the worker reports on jobs.done.<taskId>.
	TaskID string `json:"taskId,omitempty"`

	// The bake job's id.
	//
	// The cluster runner names its Job object after it, which is what makes a
	// stray Job traceable back to the request that made it — and since
	// 2026-08-09 the baker gets it too, because a Job on another node reports
	// its progress to /v1/jobs/{id}/progress and has to know which id that is.
	// omitempty, so a local run's spec still carries neither this nor a URL: it
	// reports over the pipe.
	JobID string `json:"jobId,omitempty"`
}

// TileRef is a tile's column and row, as the worker reads them.
type TileRef struct {
	X int `json:"x"`
	Y int `json:"y"`
}

// localRunner spawns the Node baker as a subprocess.
//
// A subprocess rather than an embedded interpreter, for three reasons that all
// point the same way: the pipeline is the browser's own TypeScript and running
// it under Node is the only way to keep it single-sourced; a bake that
// exhausts memory takes the subprocess down instead of the server; and the
// isolation means "run it elsewhere" later is a change of Runner rather than a
// change of everything.
type localRunner struct {
	// Path to the esbuild bundle produced by `make worker` (npm run build:worker).
	bakerPath string
	// Heap ceiling handed to Node. An 8192² bake peaks near 2.6 GB, and node's
	// own default is far below that on some builds — leaving it to chance is
	// how a bake dies at 90% with an unhelpful message.
	maxHeapMB int
}

// NewLocalRunner checks the bundle exists before anything is queued. A missing
// baker is a startup problem worth naming then, not a job that fails minutes
// later for a reason the user cannot see.
func NewLocalRunner(bakerPath string, maxHeapMB int) (Runner, error) {
	absolute, err := filepath.Abs(bakerPath)
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(absolute); err != nil {
		return nil, fmt.Errorf("job worker bundle not found at %s (build it with `make worker`): %w", absolute, err)
	}
	return &localRunner{bakerPath: absolute, maxHeapMB: maxHeapMB}, nil
}

// WorkerVersion asks the bundle which pipeline it IS, without running one
// (`job-worker.mjs --version`, see client/scripts/jobWorker.ts).
//
// A package function rather than a Runner method, because it is a property of
// the BUNDLE and not of how a job gets executed: a cluster runner spawns
// nothing locally, yet the image it launches carries the same baker as the
// binary beside it. `casas-eternas version` is the caller, and the reason it
// exists is the one failure this system has that is otherwise silent — a baker
// built from a different commit than the client writes a perfectly good
// artifact under a key nobody looks for, so the bake reports success and the
// map never changes.
func WorkerVersion(ctx context.Context, bakerPath string) (string, error) {
	absolute, err := filepath.Abs(bakerPath)
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(absolute); err != nil {
		return "", fmt.Errorf("no job worker bundle at %s — build it with `make worker`", absolute)
	}
	// No heap ceiling: --version parses no world and allocates nothing worth
	// bounding. Output is the same one-JSON-line contract Run relies on.
	out, err := exec.CommandContext(ctx, "node", absolute, "--version").Output()
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) && len(exit.Stderr) > 0 {
			return "", fmt.Errorf("%s: %s", absolute, strings.TrimSpace(string(exit.Stderr)))
		}
		return "", fmt.Errorf("running node %s --version: %w", absolute, err)
	}
	var reported struct {
		PipelineVersion string `json:"pipelineVersion"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(out))), &reported); err != nil || reported.PipelineVersion == "" {
		return "", fmt.Errorf("%s answered --version with something unreadable", absolute)
	}
	return reported.PipelineVersion, nil
}

func (r *localRunner) Run(ctx context.Context, spec Spec, onProgress func(Progress)) (Result, error) {
	payload, err := json.Marshal(spec)
	if err != nil {
		return Result{}, err
	}

	cmd := exec.CommandContext(ctx, "node", fmt.Sprintf("--max-old-space-size=%d", r.maxHeapMB), r.bakerPath, string(payload))
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return Result{}, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return Result{}, err
	}
	if err := cmd.Start(); err != nil {
		return Result{}, fmt.Errorf("starting node: %w", err)
	}

	// stderr carries progress lines AND any failure message. Both are kept:
	// the progress goes to the callback, the tail goes into the error, because
	// "exit status 1" on its own tells nobody anything.
	var lastLines []string
	stderrDone := make(chan struct{})
	go func() {
		defer close(stderrDone)
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			line := scanner.Text()
			var progress Progress
			if json.Unmarshal([]byte(line), &progress) == nil && progress.Phase != "" {
				onProgress(progress)
				continue
			}
			lastLines = append(lastLines, line)
			if len(lastLines) > 5 {
				lastLines = lastLines[1:]
			}
		}
	}()

	out, readErr := io.ReadAll(stdout)
	<-stderrDone
	waitErr := cmd.Wait()
	if waitErr != nil {
		detail := strings.TrimSpace(strings.Join(lastLines, "; "))
		if detail == "" {
			detail = waitErr.Error()
		}
		return Result{}, fmt.Errorf("bake failed: %s", detail)
	}
	if readErr != nil {
		return Result{}, readErr
	}

	// The result is the LAST line of stdout: the baker writes exactly one, but
	// taking the last means a stray print upstream cannot break the parse.
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	var result Result
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &result); err != nil {
		return Result{}, fmt.Errorf("baker produced no readable result: %w", err)
	}
	return result, nil
}
