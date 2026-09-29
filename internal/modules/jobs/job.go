package jobs

import (
	"fmt"
	"sync"
	"time"
)

// A bake job, and the shape that keeps distribution open.
//
// The bake is one subprocess on one machine today. The design constraint is
// that it must not have to be rewritten when it becomes many — so three things
// are already true that would otherwise have to be retrofitted:
//
//   - a job is a VALUE with an id and a lifecycle, not a function call. A
//     synchronous POST that computes and returns would be the dead end: there
//     is nothing to queue, nothing to dispatch, nothing to ask about.
//   - a job names its SCOPE. Today that is always the whole world; when
//     erosion is split along drainage divides it becomes one basin, and the
//     protocol does not change.
//   - the thing that RUNS a job is an interface, so a pool or a remote worker
//     replaces the local subprocess without touching the queue or the routes.
//
// See docs/decisions/server-storage.md and the 8k discussion: the point of
// baking here at all is that 2.6 GB is unremarkable for a process and fatal
// for a browser tab.

// ScopeKind says which part of a world a job covers.
type ScopeKind string

const (
	// ScopeWorld is the whole world in one pass — the only kind today.
	ScopeWorld ScopeKind = "world"
	// ScopeBasin is reserved for the split along drainage divides. Declared
	// now so the wire format and the queue never have to learn a new shape.
	ScopeBasin ScopeKind = "basin"
)

type Scope struct {
	Kind ScopeKind `json:"kind"`
	// Which basin, once Kind is ScopeBasin. Ignored for ScopeWorld.
	ID int `json:"id,omitempty"`
}

type State string

const (
	StateQueued  State = "queued"
	StateRunning State = "running"
	StateDone    State = "done"
	StateFailed  State = "failed"
	// Cancelled by a caller (DELETE /v1/jobs/{id}) before or while it ran.
	StateCancelled State = "cancelled"
)

// Request is what a caller asks for.
type Request struct {
	WorldUID string `json:"worldUid"`
	// The level to bake: 1 is the mesh's level 1 (the save's mesh refined to
	// twice the density; client/src/pipeline/meshBakeStage.ts). The raster
	// amplification's factors 2/4/8 went on 2026-09-29.
	Stage int `json:"stage"`
	// Erosion rounds; zero means the module's default rather than "no erosion",
	// because a request that forgot the field should not silently produce a
	// world with no valleys.
	ErosionRounds int   `json:"erosionRounds,omitempty"`
	Scope         Scope `json:"scope"`
}

// Result is what a finished job produced — the artifact's coordinates, so a
// caller can go and fetch it without guessing the key.
type Result struct {
	WorldID         string `json:"worldId"`
	PipelineVersion string `json:"pipelineVersion"`
	Stage           string `json:"stage"`
	Width           int    `json:"width"`
	Height          int    `json:"height"`
	DurationMs      int64  `json:"durationMs"`
}

// Job is a request plus everything that happened to it.
type Job struct {
	ID      string  `json:"id"`
	Request Request `json:"request"`
	State   State   `json:"state"`
	// Whole percent of the current phase, and which phase — enough for a
	// readout without inventing a progress model the pipeline does not have.
	Phase     string     `json:"phase,omitempty"`
	Percent   int        `json:"percent"`
	Error     string     `json:"error,omitempty"`
	Result    *Result    `json:"result,omitempty"`
	QueuedAt  time.Time  `json:"queuedAt"`
	StartedAt *time.Time `json:"startedAt,omitempty"`
	EndedAt   *time.Time `json:"endedAt,omitempty"`
}

// Validate rejects a request that cannot be run, with a message naming the
// field — a job that fails at the far end of a seven-minute queue for a reason
// visible on arrival is a waste of everyone's time.
func (r Request) Validate() error {
	if r.WorldUID == "" {
		return fmt.Errorf("worldUid is required")
	}
	// Level 1 is the only one built; the tile levels come as their own jobs.
	if r.Stage != 1 {
		return fmt.Errorf("stage must be 1")
	}
	switch r.Scope.Kind {
	case "", ScopeWorld:
	case ScopeBasin:
		return fmt.Errorf("basin scope is not implemented yet")
	default:
		return fmt.Errorf("unknown scope %q", r.Scope.Kind)
	}
	return nil
}

// registry holds jobs by id. Bounded so a long-running server does not
// accumulate every job it ever ran: finished jobs are evicted oldest-first
// once the count passes the cap, which is safe because the RESULT lives in the
// artifact store — a job record is only the story of how it got there.
type registry struct {
	mu    sync.Mutex
	jobs  map[string]*Job
	order []string
	cap   int
}

func newRegistry(capacity int) *registry {
	return &registry{jobs: make(map[string]*Job), cap: capacity}
}

// add takes the job BY VALUE and returns a snapshot, so no caller is left
// holding a pointer into a record the workers mutate. That was not merely
// tidiness: the enqueue handler used to serialise the very pointer it had just
// registered, while a worker was writing State and StartedAt through the lock
// — a data race the tests only surfaced under `-race`.
func (r *registry) add(job Job) Job {
	r.mu.Lock()
	defer r.mu.Unlock()
	stored := &job
	r.jobs[job.ID] = stored
	r.order = append(r.order, job.ID)
	for len(r.order) > r.cap {
		oldest := r.order[0]
		// Never evict something still in flight, however old it is.
		if state := r.jobs[oldest].State; state == StateQueued || state == StateRunning {
			break
		}
		r.order = r.order[1:]
		delete(r.jobs, oldest)
	}
	return *stored
}

func (r *registry) get(id string) (Job, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	job, ok := r.jobs[id]
	if !ok {
		return Job{}, false
	}
	return *job, true
}

// list returns a snapshot, newest first.
func (r *registry) list() []Job {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]Job, 0, len(r.order))
	for i := len(r.order) - 1; i >= 0; i-- {
		if job, ok := r.jobs[r.order[i]]; ok {
			out = append(out, *job)
		}
	}
	return out
}

// update mutates a job under the lock. Returning the copy is deliberate: every
// reader gets a snapshot, so nothing outside can hold a pointer into a record
// the worker is still writing.
func (r *registry) update(id string, mutate func(*Job)) (Job, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	job, ok := r.jobs[id]
	if !ok {
		return Job{}, false
	}
	mutate(job)
	return *job, true
}
