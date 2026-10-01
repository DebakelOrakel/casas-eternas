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
	// ScopeTile is one tile of a fine mesh level (stage 2 or 3): X and Y are
	// its column and row on that level's tile grid (docs/decisions/tile-jobs.md).
	ScopeTile ScopeKind = "tile"
)

type Scope struct {
	Kind ScopeKind `json:"kind"`
	// Which basin, once Kind is ScopeBasin. Ignored for ScopeWorld.
	ID int `json:"id,omitempty"`
	// Which tile, once Kind is ScopeTile. The grid's size depends on the
	// world, so the upper bound is the worker's to check.
	X int `json:"x,omitempty"`
	Y int `json:"y,omitempty"`
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
	// twice the density; client/src/pipeline/meshBakeStage.ts), 2 one tile of
	// the top level, named by a tile scope (meshTileBake.ts). The raster
	// amplification's factors 2/4/8 went on 2026-09-29.
	Stage int `json:"stage"`
	// Erosion rounds; zero means the module's default rather than "no erosion",
	// because a request that forgot the field should not silently produce a
	// world with no valleys.
	ErosionRounds int   `json:"erosionRounds,omitempty"`
	Scope         Scope `json:"scope"`
	// The plan: empty for the one task the request names; "refine" for
	// level 1 and then every land and shelf tile on it, up to Stage — the
	// finishing step's "refine the world" (coordinator.go). Needs the
	// coordinator.
	Plan string `json:"plan,omitempty"`
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
	// Level 1 runs over the whole world, the levels below one tile at a time.
	switch r.Scope.Kind {
	case "", ScopeWorld:
		if r.Plan != "" && r.Plan != PlanRefine {
			return fmt.Errorf("unknown plan %q", r.Plan)
		}
		// A plan's stage is the level it refines up to.
		if r.Plan == PlanRefine {
			if r.Stage < 1 || r.Stage > maxRefineStage {
				return fmt.Errorf("a refine plan goes up to stage 1 to %d", maxRefineStage)
			}
			break
		}
		if r.Stage != 1 {
			return fmt.Errorf("stage %d needs a tile scope; the whole world is stage 1", r.Stage)
		}
	case ScopeTile:
		if r.Plan != "" {
			return fmt.Errorf("a plan runs over the whole world")
		}
		// The levels with tiles (client/src/generator/mesh/meshTile.ts,
		// TILE_SPECS).
		if r.Stage < 2 || r.Stage > maxTileStage {
			return fmt.Errorf("a tile scope is stage 2 to %d", maxTileStage)
		}
		if r.Scope.X < 0 || r.Scope.Y < 0 {
			return fmt.Errorf("tile x and y must not be negative")
		}
	case ScopeBasin:
		return fmt.Errorf("basin scope is not implemented yet")
	default:
		return fmt.Errorf("unknown scope %q", r.Scope.Kind)
	}
	return nil
}

// StageName is the artifact stage a request produces: `L1` for a level,
// `L2:x,y` for a tile — the client's meshLevelStage and meshTileStage.
func (r Request) StageName() string {
	if r.Scope.Kind == ScopeTile {
		return fmt.Sprintf("L%d:%d,%d", r.Stage, r.Scope.X, r.Scope.Y)
	}
	return fmt.Sprintf("L%d", r.Stage)
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
	// Who hears about every change (the event stream, /v1/jobs/events).
	watchers map[chan Job]struct{}
}

// watch returns a channel that receives every job as it changes, and the
// function that ends the watch. A watcher that does not keep up misses
// changes rather than holding the registry up; it reads the list again.
func (r *registry) watch() (<-chan Job, func()) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.watchers == nil {
		r.watchers = map[chan Job]struct{}{}
	}
	ch := make(chan Job, 64)
	r.watchers[ch] = struct{}{}
	return ch, func() {
		r.mu.Lock()
		defer r.mu.Unlock()
		delete(r.watchers, ch)
	}
}

// tell hands a snapshot to every watcher. Called with the lock held.
func (r *registry) tell(job Job) {
	for ch := range r.watchers {
		select {
		case ch <- job:
		default:
		}
	}
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
	r.tell(job)
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
	r.tell(*job)
	return *job, true
}
