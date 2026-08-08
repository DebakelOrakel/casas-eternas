// Package bake turns a stored world into amplified terrain, on the server.
//
// The reason it exists is a measurement: an 8192² amplification bake peaks
// near 2.6 GB. That is unremarkable for a process and fatal for a browser tab
// — Safari kills it. So 8k is a capability of having a server, even a local
// one, and the client keeps its own ability to bake at the resolutions a tab
// can hold.
//
// It is NOT a port of the pipeline. The baker is the browser's own TypeScript,
// bundled for Node and spawned as a subprocess, which is what keeps a
// server-baked artifact byte-identical to a browser-baked one — they carry a
// key derived from their inputs, so they had better be.
//
// Simple today, deliberately not a dead end: see job.go for the three things
// (job as a value, explicit scope, Runner interface) that let this become many
// distributed workers without a rewrite.
package bake

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// defaultErosionRounds mirrors the client's AMPLIFY_EROSION_ROUNDS. A request
// that omits the field gets this rather than zero: "no rounds" would silently
// produce a world with no carved valleys, which looks like a broken bake.
const defaultErosionRounds = 2

// nodeHeapMB is what the baker's Node process is allowed. Sized for the 8192²
// measurement (~2.6 GB) with headroom, since running out mid-bake wastes the
// minutes already spent.
const nodeHeapMB = 6144

// jobHistory caps the in-memory job records. The RESULT lives in the artifact
// store, so an evicted record loses only the story of how it got there.
const jobHistory = 200

// Config is what cmd/ resolves from the flags. No viper here by design.
type Config struct {
	// Where saved worlds live — read only. Shared with the world module by
	// path rather than by object: the world store's writes are atomic renames,
	// so reading underneath one is safe, and keeping the modules unaware of
	// each other is what lets any subset of them run.
	WorldsDir string
	// Where the baker writes. Same directory the artifacts module serves from,
	// and safe for the same reason — that store is idempotent by construction
	// and needs no locking.
	ArtifactsDir string
	// The Node bundle, from `npm run build:baker`.
	BakerPath string
}

type Module struct {
	cfg      Config
	runner   Runner
	jobs     *registry
	queue    chan string
	cancel   context.CancelFunc
	finished chan struct{}
}

func New(cfg Config) (*Module, error) {
	if cfg.WorldsDir == "" || cfg.ArtifactsDir == "" {
		return nil, fmt.Errorf("--dir-worlds and --dir-artifacts are both required for bakes")
	}
	runner, err := NewLocalRunner(cfg.BakerPath, nodeHeapMB)
	if err != nil {
		return nil, fmt.Errorf("--baker: %w", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	m := &Module{
		cfg:    cfg,
		runner: runner,
		jobs:   newRegistry(jobHistory),
		// Buffered so a burst of requests is accepted rather than blocking the
		// HTTP handler; full means genuinely swamped, which answers 503.
		queue:    make(chan string, 64),
		cancel:   cancel,
		finished: make(chan struct{}),
	}
	// ONE worker. Not an oversight: two concurrent 8k bakes want 5 GB, so
	// serialising is the correct default and the queue is what makes that
	// bearable. Raising it is a flag away once basins split the work into
	// pieces that actually fit side by side.
	go m.work(ctx)
	return m, nil
}

func (m *Module) Name() string { return "bake" }

func (m *Module) Mount(mux *http.ServeMux) error {
	mux.HandleFunc("POST /v1/worlds/{uid}/bake", m.handleEnqueue)
	mux.HandleFunc("GET /v1/bakes", m.handleList)
	mux.HandleFunc("GET /v1/bakes/{id}", m.handleGet)
	return nil
}

// Close stops the worker and waits for the job in flight. A bake that is
// minutes in is worth the wait on shutdown — killing it wastes the work and
// leaves a half-written artifact for the next reader to find.
func (m *Module) Close() error {
	m.cancel()
	close(m.queue)
	select {
	case <-m.finished:
	case <-time.After(30 * time.Second):
		slog.Warn("bake worker did not stop in time")
	}
	return nil
}

func newID() string {
	raw := make([]byte, 8)
	_, _ = rand.Read(raw)
	return hex.EncodeToString(raw)
}

func (m *Module) handleEnqueue(w http.ResponseWriter, r *http.Request) {
	var request Request
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&request); err != nil {
		clientError(w, http.StatusBadRequest, `expected {"stage": 2}`)
		return
	}
	request.WorldUID = r.PathValue("uid")
	if request.Scope.Kind == "" {
		request.Scope.Kind = ScopeWorld
	}
	if request.ErosionRounds == 0 {
		request.ErosionRounds = defaultErosionRounds
	}
	if err := request.Validate(); err != nil {
		clientError(w, http.StatusBadRequest, err.Error())
		return
	}
	// Checked before queueing so a typo'd uid fails now rather than at the far
	// end of a queue that may be minutes long.
	if _, err := os.Stat(m.worldZip(request.WorldUID)); err != nil {
		clientError(w, http.StatusNotFound, "no such world, or it has no stored revision")
		return
	}

	job := &Job{ID: newID(), Request: request, State: StateQueued, QueuedAt: time.Now()}
	m.jobs.add(job)
	select {
	case m.queue <- job.ID:
	default:
		m.jobs.update(job.ID, func(j *Job) {
			j.State = StateFailed
			j.Error = "bake queue is full"
		})
		clientError(w, http.StatusServiceUnavailable, "bake queue is full")
		return
	}
	slog.Info("bake queued", "job", job.ID, "world", request.WorldUID, "stage", request.Stage)
	// 202: accepted, not done. The caller polls, or simply looks for the
	// artifact — which is the point of keying artifacts by content.
	writeJSON(w, http.StatusAccepted, job)
}

func (m *Module) handleGet(w http.ResponseWriter, r *http.Request) {
	job, ok := m.jobs.get(r.PathValue("id"))
	if !ok {
		clientError(w, http.StatusNotFound, "no such job")
		return
	}
	writeJSON(w, http.StatusOK, job)
}

func (m *Module) handleList(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, m.jobs.list())
}

// worldZip resolves a world's current revision to a path.
//
// Reads the world store's own meta.json rather than importing the package: the
// modules are deliberately independent, and a read-only reader of a documented
// on-disk layout is a smaller coupling than a shared object would be.
func (m *Module) worldZip(uid string) string {
	raw, err := os.ReadFile(filepath.Join(m.cfg.WorldsDir, uid, "meta.json"))
	if err != nil {
		return filepath.Join(m.cfg.WorldsDir, uid, "missing")
	}
	var meta struct {
		Revision int `json:"revision"`
	}
	if json.Unmarshal(raw, &meta) != nil || meta.Revision < 1 {
		return filepath.Join(m.cfg.WorldsDir, uid, "missing")
	}
	return filepath.Join(m.cfg.WorldsDir, uid, "rev", fmt.Sprint(meta.Revision), "world.zip")
}

func (m *Module) work(ctx context.Context) {
	defer close(m.finished)
	for id := range m.queue {
		job, ok := m.jobs.get(id)
		if !ok {
			continue
		}
		started := time.Now()
		m.jobs.update(id, func(j *Job) {
			j.State = StateRunning
			j.StartedAt = &started
		})

		spec := Spec{
			WorldZip:      m.worldZip(job.Request.WorldUID),
			Stage:         job.Request.Stage,
			ErosionRounds: job.Request.ErosionRounds,
			ArtifactsDir:  m.cfg.ArtifactsDir,
		}
		result, err := m.runner.Run(ctx, spec, func(p Progress) {
			m.jobs.update(id, func(j *Job) {
				j.Phase = p.Phase
				j.Percent = p.Percent
			})
		})

		ended := time.Now()
		m.jobs.update(id, func(j *Job) {
			j.EndedAt = &ended
			if err != nil {
				j.State = StateFailed
				j.Error = err.Error()
				return
			}
			j.State = StateDone
			j.Percent = 100
			j.Result = &result
		})
		if err != nil {
			// A cancelled context is a shutdown, not a fault worth alarming
			// about — the job record already says it failed.
			if errors.Is(ctx.Err(), context.Canceled) {
				slog.Info("bake abandoned on shutdown", "job", id)
				continue
			}
			slog.Error("bake failed", "job", id, "err", err)
			continue
		}
		slog.Info("bake done", "job", id, "world", result.WorldID, "stage", result.Stage,
			"size", fmt.Sprintf("%dx%d", result.Width, result.Height), "took", ended.Sub(started).Round(time.Second))
	}
}

func clientError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
