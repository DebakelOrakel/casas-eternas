package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Spec is a Request resolved against the stores: what a worker needs to
// actually do the work, rather than the ids the caller used.
//
// It carries BOTH shapes because the same work runs in two places. A local
// worker sits next to the files and gets paths. A worker in a cluster runs
// in a pod of its own and cannot count on mounting the server's
// ReadWriteOnce volume, so it gets URLs and a token instead.
//
// This struct IS the wire format: it is marshalled straight into the task
// message on the relay, so these field names are a contract with
// client/scripts/jobWorker.ts.
// Measured 2026-08-08: the two shapes produce byte-identical artifacts, which
// is the property that lets either run without anyone downstream caring.
type Spec struct {
	Stage         int `json:"stage"`
	ErosionRounds int `json:"erosionRounds"`
	// The tile, for a stage with tiles (2, 3).
	Tile *TileRef `json:"tile,omitempty"`
	// The artifact stage the job produces (Request.StageName). Not sent to
	// the worker.
	StageName string `json:"-"`

	// Exactly one of each pair.
	WorldZip     string `json:"worldZip,omitempty"`
	WorldURL     string `json:"worldUrl,omitempty"`
	ArtifactsDir string `json:"artifactsDir,omitempty"`
	ArtifactsURL string `json:"artifactsUrl,omitempty"`

	// Bearer token for the URL form, naming this one job.
	AuthToken string `json:"authToken,omitempty"`

	// The task's id, when the coordinator handed it out (coordinator.go):
	// what the worker reports on jobs.done.<taskId>.
	TaskID string `json:"taskId,omitempty"`

	// Whether the worker may report an artifact already in the store as
	// the task's result instead of computing it again: set for the tasks of
	// a plan. The artifact key names the inputs and the pipeline version, so
	// one there is the one the task would write.
	Reuse bool `json:"reuse,omitempty"`

	// For a tile: the upstream tiles of its level, whose outflow it reads
	// (the refine plan's flow edges, coordinator.go).
	Upstream []TileRef `json:"upstream,omitempty"`

	// Where a long task keeps its checkpoints (level 1's replay), on a disk
	// every worker that may take the task over can read. Empty: none kept.
	CheckpointDir string `json:"checkpointDir,omitempty"`

	// The job's id, set by the coordinator (coordinator.go): the worker
	// reports its progress on jobs.event.<jobId>, and a cancel names it.
	JobID string `json:"jobId,omitempty"`
}

// TileRef is a tile's column and row, as the worker reads them.
type TileRef struct {
	X int `json:"x"`
	Y int `json:"y"`
}

// workerBundle checks the bundle exists before anything is queued and
// answers its absolute path. A missing bundle is a startup problem worth
// naming then, not a job that fails minutes later for a reason the user
// cannot see.
func workerBundle(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(absolute); err != nil {
		return "", fmt.Errorf("job worker bundle not found at %s (build it with `make worker`): %w", absolute, err)
	}
	return absolute, nil
}

// WorkerVersion asks the bundle which pipeline it IS, without running one
// (`job-worker.mjs --version`, see client/scripts/jobWorker.ts).
//
// A property of the BUNDLE, not of how a job gets executed: in a cluster
// nothing runs it locally, yet the workers' image carries the same baker as
// the binary beside it. `casas-eternas version` is the caller, and the reason it
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
	// bounding. Output is one JSON line.
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
