// Package bake turns a stored world into a finer mesh level, on the server.
//
// The reason it exists is size: level 1 of a real world is ~17 M nodes and
// 349 MB, unremarkable for a process and too much for a browser tab. (It
// baked the raster amplification's 4096²/8192² tiers until 2026-09-29.)
//
// It is NOT a port of the pipeline. The baker is the client's own
// TypeScript, bundled for Node and spawned as a subprocess, so an artifact
// carries a key derived from its inputs exactly as the client derives it.
//
// Simple today, deliberately not a dead end: see job.go for the three things
// (job as a value, explicit scope, Runner interface) that let this become many
// distributed workers without a rewrite.
package jobs

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"path/filepath"
	"sync"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/access"
	"github.com/DebakelOrakel/casas-eternas/internal/httpjson"
	"github.com/DebakelOrakel/casas-eternas/internal/identity"
	"github.com/DebakelOrakel/casas-eternas/internal/relay"
	"github.com/DebakelOrakel/casas-eternas/internal/token"
)

// defaultErosionRounds mirrors the client's AMPLIFY_EROSION_ROUNDS
// (mirrors_test.go checks the two agree; since
// erosion-v2 P3 these are ENGINE ITERATIONS — the measurement behind the
// value lives beside the client constant). A request that omits the field
// gets this rather than zero: "no rounds" would silently produce a world
// with no carved valleys, which looks like a broken bake.
const defaultErosionRounds = 12

// nodeHeapMB is what the baker's Node process is allowed. Sized for the 8192²
// measurement (~2.6 GB) with headroom, since running out mid-bake wastes the
// minutes already spent. The worker Deployment pins the same number by hand
// on its command line (deploy/manifests.yaml) — change the two together;
// mirrors_test.go fails when they differ.
//
// IT DOES NOT BOUND THIS WORKLOAD, and that is worth knowing before anyone
// raises it to fix a memory problem. Measured 2026-08-15 on a 16384² bake, the
// largest the pipeline has ever run: at this 6144 ceiling it finished in 2510 s
// with 9.4 GiB RESIDENT, and the same bake given a 24576 ceiling finished in
// 2516 s with 8.5 GiB — the smaller ceiling used MORE memory, not less. The
// amplification's working set is typed arrays, which live outside the V8 old
// space this flag governs, so the ceiling only shifts GC timing. What actually
// binds is system RAM.
//
// (Both runs produced byte-identical artifacts, which is also the determinism
// check at that size.)
const nodeHeapMB = 6144

// jobHistory caps the in-memory job records. The RESULT lives in the artifact
// store, so an evicted record loses only the story of how it got there.
const jobHistory = 200

// Config is what cmd/ resolves from the flags. No viper here by design.
type Config struct {
	// WorldAccess ranks the enqueuing caller against the world — everything
	// admitting a bake request needs to know, since 2026-08-12 as a LEVEL
	// (editor and up may bake) rather than an owner comparison. Injected by
	// cmd/ (the same pattern that distributes identity.Resolver): a closure
	// over the co-resident world module, or an HTTP lookup of the world
	// service's meta endpoint, whose answer carries the level. Either way
	// this module never learns the world store's layout or its grants.
	//
	// bearer is the enqueuing caller's Authorization header, forwarded
	// verbatim so identity travels in the token and this module holds
	// nobody's. A bake-job token ranks as None — a job must never order
	// more bakes; the ranking enforces what canBake used to compare.
	WorldAccess func(ctx context.Context, uid, bearer string) (exists bool, level access.Level)
	// The world as the BAKER reads it — exactly one of the two is set.
	// WorldZip yields the current revision's save as a file path, for a local
	// runner sitting beside the world store; called at start rather than at
	// enqueue, so a world deleted while queued fails the job instead of
	// baking a stale path. WorldsURL is the /v1 base to fetch from instead: a
	// cluster Job reaching its own server by pod IP, or any runner whose
	// world module lives in another process.
	WorldZip  func(ctx context.Context, uid string) (path string, ok bool)
	WorldsURL string
	// The artifact sink — exactly one of the two is set. ArtifactsDir is the
	// directory the co-resident artifacts module serves (safe to share:
	// that store is idempotent by construction); ArtifactsURL is its /v1 base
	// in another process.
	ArtifactsDir string
	ArtifactsURL string
	// The Node bundle, from `make worker` (npm run build:worker).
	WorkerPath string
	// Identity answers who a request comes from — the same resolver every other
	// module holds, so ownership is compared against one notion of "caller".
	Identity *identity.Resolver
	// Tokens mints the credential a bake carries when it reads or writes over
	// HTTP. Nil when the server checks nobody, in which case none is needed:
	// it is talking to servers that let everyone in.
	Tokens *token.Tokens
	// MaxConcurrent bakes. One by default, and that is a memory argument: two
	// 8192² bakes want 5 GB between them. In a cluster the ceiling is the
	// nodes' free memory instead — each Job reserves its honest 3Gi, and
	// setting this above what the cluster can hold only produces Pending
	// jobs, which the runner reports as exactly that.
	MaxConcurrent int
	// The module's connection to the relay (internal/relay), made by cmd/
	// in the process or to global.services.relay. The module owns it from
	// here and closes it. With it, off a cluster, the jobs run through the
	// coordinator and its workers; nil only in tests of the runner path.
	Relay *relay.Conn
	// Where the local workers reach the relay (a NATS URL): the co-resident
	// relay's port, or global.services.relay.
	RelayURL string
	// The coordinator's state directory (jobs.storage), for jobs.db.
	StorageDir string
}

type Module struct {
	cfg Config
	// Whether this server runs in a cluster, its workers in pods of their own.
	// Captured once at construction — a process does not move in or out of a
	// cluster while it runs.
	clusterMode bool
	runner      Runner
	jobs        *registry
	queue       chan string
	// shutdown is done once Close has begun. It is what the workers and the
	// enqueue handler watch — the queue channel is never closed, because the
	// handler may be sending on it in the same instant Close runs, and a send
	// on a closed channel is a panic rather than a refusal.
	shutdown context.Context
	cancel   context.CancelFunc
	workers  sync.WaitGroup
	// The running jobs' own cancellations, by id: what DELETE /v1/jobs/{id}
	// pulls to stop one bake without touching the others.
	runningMu sync.Mutex
	running   map[string]context.CancelFunc
	// The coordinator and its local workers, when the jobs run over the
	// relay (coordinator.go, workerpool.go); nil on the runner path.
	coord *coordinator
	pool  *workerPool
	// How many jobs run at once (jobs.max-concurrent): the local workers on
	// the relay path, the runner's slots otherwise.
	slots int
}

func New(cfg Config) (*Module, error) {
	// Exactly-one checks, because these are the wiring cmd/ owes this module —
	// a missing half is a composition bug, and both halves at once would make
	// the spec builder below ambiguous about where the truth lives.
	if cfg.WorldAccess == nil {
		return nil, fmt.Errorf("bake needs its WorldAccess wiring; that is cmd/'s job")
	}
	if (cfg.WorldZip == nil) == (cfg.WorldsURL == "") {
		return nil, fmt.Errorf("bake needs exactly one world source (WorldZip or WorldsURL); that is cmd/'s job")
	}
	if (cfg.ArtifactsDir == "") == (cfg.ArtifactsURL == "") {
		return nil, fmt.Errorf("bake needs exactly one artifact sink (ArtifactsDir or ArtifactsURL); that is cmd/'s job")
	}
	// Where the work runs is decided by DETECTING the cluster and by nothing
	// else, deliberately without a flag: in a cluster it runs in the worker
	// Deployment this module scales, never in the server's own pod under the
	// server's own memory limit; off one, in workers this module starts.
	// See docs/decisions/detail-ladder.md, addendum 2026-10-03.
	var runner Runner
	var err error
	if InCluster() {
		// A worker in another pod has only URLs — a file path in this pod
		// means the composition is wrong, and finding out here beats a task
		// going out with an empty fetch address.
		if cfg.WorldsURL == "" || cfg.ArtifactsURL == "" {
			return nil, fmt.Errorf("jobs in a cluster need WorldsURL and ArtifactsURL; is CASAS_POD_IP set? (deploy/manifests.yaml wires it)")
		}
		// And the coordinator, which the workers serve over the relay.
		if cfg.Relay == nil {
			return nil, fmt.Errorf("jobs in a cluster run over the relay: run -t relay in this process or set global.services.relay")
		}
	} else {
		runner, err = NewLocalRunner(cfg.WorkerPath, nodeHeapMB)
		if err != nil {
			return nil, fmt.Errorf("jobs.worker: %w", err)
		}
	}

	workers := cfg.MaxConcurrent
	if workers < 1 {
		workers = 1
	}

	ctx, cancel := context.WithCancel(context.Background())
	if cfg.Relay != nil {
		declareCtx, declareCancel := context.WithTimeout(context.Background(), 10*time.Second)
		err := declareStreams(declareCtx, cfg.Relay)
		declareCancel()
		if err != nil {
			cancel()
			return nil, err
		}
	}
	m := &Module{
		cfg:         cfg,
		clusterMode: InCluster(),
		runner:      runner,
		slots:       workers,
		jobs:        newRegistry(jobHistory),
		running:     map[string]context.CancelFunc{},
		// Buffered so a burst of requests is accepted rather than blocking the
		// HTTP handler; full means genuinely swamped, which answers 503.
		queue:    make(chan string, 64),
		shutdown: ctx,
		cancel:   cancel,
	}
	// Over the relay: the coordinator plans and hands out the tasks, and
	// workers compute them — off a cluster the local ones this module starts,
	// in a cluster the worker Deployment it scales (scaler.go).
	if cfg.Relay != nil {
		if cfg.StorageDir == "" {
			cancel()
			return nil, fmt.Errorf("jobs.storage: the coordinator needs a directory for jobs.db")
		}
		m.coord, err = newCoordinator(cfg.StorageDir, cfg.Relay, m.jobs, m.buildSpec)
		if err != nil {
			cancel()
			return nil, err
		}
		if local, ok := runner.(*localRunner); ok && cfg.RelayURL != "" {
			m.pool = startWorkerPool(local.bakerPath, cfg.RelayURL, workers, nodeHeapMB, cfg.Tokens)
		}
		if InCluster() {
			api, err := newClusterAPI()
			if err != nil {
				m.coord.close()
				cancel()
				return nil, fmt.Errorf("worker scaler: %w", err)
			}
			scaler := &workerScaler{api: api, workload: m.coord.workload, max: workers}
			go scaler.run(ctx)
		}
		slog.Info("jobs ready", "coordinator", cfg.StorageDir, "workers", workers, "checks identity", cfg.Identity.ChecksIdentity())
		return m, nil
	}
	for range workers {
		m.workers.Add(1)
		go m.work(ctx)
	}
	slog.Info("bake ready", "workers", workers, "checks identity", cfg.Identity.ChecksIdentity(), "cluster", InCluster())
	return m, nil
}

func (m *Module) Name() string { return "jobs" }

// Describe tells the client HOW bakes run here, which is not something it can
// infer: the same API answers whether the work happens in a subprocess beside
// the server or in workers over the relay. The client uses it to say which, while
// it waits — and it has to choose that wording and its icon before the job
// exists, because a notification cannot change either once it is on screen.
func (m *Module) Describe() map[string]any {
	runner := "subprocess"
	if m.coord != nil {
		runner = "relay"
	}
	// The jobs window's "n of m workers busy" reads jobWorkers: the local
	// workers, or the most the worker Deployment is scaled to.
	return map[string]any{"bakeRunner": runner, "jobWorkers": m.slots}
}

// Mount claims the bake routes — all of them under /v1/bakes, because a bake
// IS the job: commissioning one is creating a job resource, not an operation
// on the world. (It lived at POST /v1/worlds/{uid}/bake until 2026-08-12,
// which was the one route registered inside another module's namespace.)
func (m *Module) Mount(mux *http.ServeMux) error {
	mux.HandleFunc("POST /v1/jobs", m.handleEnqueue)
	mux.HandleFunc("GET /v1/jobs", m.handleList)
	mux.HandleFunc("GET /v1/jobs/events", m.handleEvents)
	mux.HandleFunc("GET /v1/jobs/{id}", m.handleGet)
	mux.HandleFunc("DELETE /v1/jobs/{id}", m.handleCancel)
	return nil
}

// Close cancels the workers and waits for them to wind down. The cancellation
// reaches a running bake's subprocess or Job, which aborts it — a half-run
// bake is harmless, because the artifact store only ever sees complete file
// PUTs and the key is derived from inputs, so an interrupted bake simply
// leaves nothing to find. The queue channel is deliberately NOT closed; see
// the field comment.
func (m *Module) Close() error {
	m.cancel()
	if m.pool != nil {
		m.pool.stop()
	}
	if m.coord != nil {
		m.coord.close()
	}
	done := make(chan struct{})
	go func() {
		m.workers.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		slog.Warn("bake workers did not stop in time")
	}
	if m.cfg.Relay != nil {
		m.cfg.Relay.Close()
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
		httpjson.ClientError(w, http.StatusBadRequest, `expected {"worldUid": "…", "stage": 1} or {"worldUid": "…", "stage": 2, "scope": {"kind": "tile", "x": 0, "y": 0}}`)
		return
	}
	if request.Scope.Kind == "" {
		request.Scope.Kind = ScopeWorld
	}
	if request.ErosionRounds == 0 {
		request.ErosionRounds = defaultErosionRounds
	}
	if err := request.Validate(); err != nil {
		httpjson.ClientError(w, http.StatusBadRequest, err.Error())
		return
	}
	// Ranked before queueing, so a request that cannot succeed fails now
	// rather than at the far end of a queue that may be minutes long. The
	// visibility shape matches the world module's: a world the caller may
	// not read answers 404 — private means invisible — and only a readable
	// one distinguishes 403. A bake is minutes of a machine, so the level is
	// editor and up, never merely viewer; and a bake-job token ranks as
	// None, which is what keeps a leaked job token from ordering more bakes.
	exists, level := m.cfg.WorldAccess(r.Context(), request.WorldUID, r.Header.Get("Authorization"))
	if !exists || level < access.Viewer {
		httpjson.ClientError(w, http.StatusNotFound, "no such world, or it has no stored revision")
		return
	}
	if level < access.Editor {
		httpjson.ClientError(w, http.StatusForbidden, "world.bake needs editor access to this world")
		return
	}

	// Checked LAST, right before queueing: a request refused for shutdown
	// should not have been refused for a reason that would still apply
	// tomorrow. The remaining race — shutdown beginning between this check and
	// the send — strands an id in the buffered queue of an exiting process,
	// which costs nothing; the panic the old close(queue) risked cost the
	// whole shutdown.
	if m.shutdown.Err() != nil {
		httpjson.ClientError(w, http.StatusServiceUnavailable, "server is shutting down")
		return
	}

	if request.Plan != "" && m.coord == nil {
		httpjson.ClientError(w, http.StatusBadRequest, "a plan needs the coordinator, which runs over the relay")
		return
	}
	job := m.jobs.add(Job{ID: newID(), Request: request, State: StateQueued, QueuedAt: time.Now()})
	if m.coord != nil {
		if err := m.coord.submit(job); err != nil {
			httpjson.ClientError(w, http.StatusServiceUnavailable, err.Error())
			return
		}
		slog.Info("job planned", "job", job.ID, "world", request.WorldUID, "stage", request.Stage, "plan", request.Plan)
		job, _ = m.jobs.get(job.ID)
		httpjson.Write(w, http.StatusAccepted, job)
		return
	}
	select {
	case m.queue <- job.ID:
	default:
		job, _ = m.jobs.update(job.ID, func(j *Job) {
			j.State = StateFailed
			j.Error = "bake queue is full"
		})
		httpjson.ClientError(w, http.StatusServiceUnavailable, "bake queue is full")
		return
	}
	slog.Info("bake queued", "job", job.ID, "world", request.WorldUID, "stage", request.Stage)
	// 202: accepted, not done. The caller polls, or simply looks for the
	// artifact — which is the point of keying artifacts by content.
	httpjson.Write(w, http.StatusAccepted, job)
}

// A job with the caller's level on its world ("viewer", "editor", "owner",
// or "admin" for the operator): what the caller may do with it. Cancelling
// takes an editor, as ordering one does.
type listedJob struct {
	Job
	CallerLevel string `json:"callerLevel"`
}

// operator answers "may this request see and do anything here": the admin
// claim, or the local mode, where every check answers yes by design.
func (m *Module) operator(r *http.Request) bool {
	if !m.cfg.Identity.ChecksIdentity() {
		return true
	}
	_, admin := m.cfg.Identity.ResolveBearer(r.Header.Get("Authorization"))
	return admin
}

// levelFor ranks the caller against a job's world. A job is its world's
// data (its world uid, its error text), so it shows to whoever may read the
// world — the shape the artifacts have (2026-09-29; before, every caller
// saw every job).
func (m *Module) levelFor(r *http.Request, job Job) access.Level {
	if m.operator(r) {
		return access.Admin
	}
	exists, level := m.cfg.WorldAccess(r.Context(), job.Request.WorldUID, r.Header.Get("Authorization"))
	if !exists {
		return access.None
	}
	return level
}

func (m *Module) handleGet(w http.ResponseWriter, r *http.Request) {
	job, ok := m.jobs.get(r.PathValue("id"))
	level := access.None
	if ok {
		level = m.levelFor(r, job)
	}
	if level < access.Viewer {
		httpjson.ClientError(w, http.StatusNotFound, "no such job")
		return
	}
	httpjson.Write(w, http.StatusOK, listedJob{job, level.String()})
}

// handleCancel stops a job: a queued one never starts, a running one has its
// context cancelled, which aborts its subprocess or Job as a shutdown does.
// A half-run bake is harmless (see Close). A job that has already ended
// answers 409.
func (m *Module) handleCancel(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	job, ok := m.jobs.get(id)
	level := access.None
	if ok {
		level = m.levelFor(r, job)
	}
	if level < access.Viewer {
		httpjson.ClientError(w, http.StatusNotFound, "no such job")
		return
	}
	if level < access.Editor {
		httpjson.ClientError(w, http.StatusForbidden, "cancelling a bake needs editor access to its world")
		return
	}
	if m.coord != nil {
		if !m.coord.cancelJob(id) {
			httpjson.ClientError(w, http.StatusConflict, "the job has already ended")
			return
		}
		slog.Info("job cancelled", "job", id, "world", job.Request.WorldUID)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	cancelled := false
	now := time.Now()
	updated, _ := m.jobs.update(id, func(j *Job) {
		if j.State == StateQueued {
			j.State = StateCancelled
			j.EndedAt = &now
			cancelled = true
		}
	})
	if !cancelled && updated.State == StateRunning {
		m.runningMu.Lock()
		stop := m.running[id]
		m.runningMu.Unlock()
		if stop != nil {
			stop()
			cancelled = true
		}
	}
	if !cancelled {
		httpjson.ClientError(w, http.StatusConflict, "the job has already ended")
		return
	}
	slog.Info("bake cancelled", "job", id, "world", job.Request.WorldUID)
	w.WriteHeader(http.StatusNoContent)
}

func (m *Module) handleList(w http.ResponseWriter, r *http.Request) {
	// One ranking per DISTINCT world, not per job.
	levels := map[string]access.Level{}
	visible := make([]listedJob, 0)
	for _, job := range m.jobs.list() {
		level, ranked := levels[job.Request.WorldUID]
		if !ranked {
			level = m.levelFor(r, job)
			levels[job.Request.WorldUID] = level
		}
		if level >= access.Viewer {
			visible = append(visible, listedJob{job, level.String()})
		}
	}
	httpjson.Write(w, http.StatusOK, visible)
}

// jobTokenTTL bounds a Job's credential.
//
// Longer than schedulingDeadline plus a bake, and no longer: the token travels
// in a Job spec, which is readable by anyone who can read Jobs in the namespace,
// so its value is how long that exposure lasts. An 8192² bake runs in minutes;
// an hour is generous for the worst case and short enough that a leaked spec
// goes stale the same morning.
const jobTokenTTL = time.Hour

func (m *Module) work(ctx context.Context) {
	defer m.workers.Done()
	for {
		var id string
		select {
		case <-ctx.Done():
			return
		case id = <-m.queue:
		}
		job, ok := m.jobs.get(id)
		if !ok || job.State == StateCancelled {
			continue
		}
		started := time.Now()
		m.jobs.update(id, func(j *Job) {
			j.State = StateRunning
			j.StartedAt = &started
		})

		spec, err := m.buildSpec(ctx, id, job.Request)
		if err != nil {
			failed := time.Now()
			m.jobs.update(id, func(j *Job) {
				j.State = StateFailed
				j.Error = err.Error()
				j.EndedAt = &failed
			})
			slog.Warn("bake not started", "job", id, "world", job.Request.WorldUID, "err", err)
			continue
		}
		// Its own context under the module's, so a cancel stops this job
		// alone (handleCancel).
		jobCtx, stopJob := context.WithCancel(ctx)
		m.runningMu.Lock()
		if m.running == nil {
			m.running = map[string]context.CancelFunc{}
		}
		m.running[id] = stopJob
		m.runningMu.Unlock()
		result, err := m.runner.Run(jobCtx, spec, func(p Progress) {
			m.jobs.update(id, func(j *Job) {
				j.Phase = p.Phase
				j.Percent = p.Percent
			})
		})

		m.runningMu.Lock()
		delete(m.running, id)
		m.runningMu.Unlock()
		// Cancelled by a caller rather than failed: its context went, the
		// module's did not.
		byCaller := jobCtx.Err() != nil && ctx.Err() == nil
		stopJob()

		ended := time.Now()
		m.jobs.update(id, func(j *Job) {
			j.EndedAt = &ended
			// A cancel wins over whatever the runner returned after it.
			if byCaller {
				j.State = StateCancelled
				return
			}
			if err != nil {
				j.State = StateFailed
				j.Error = err.Error()
				return
			}
			j.State = StateDone
			j.Percent = 100
			j.Result = &result
		})
		if byCaller {
			continue
		}
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
		// The world comes from the job REQUEST, not the result: a cluster
		// runner deliberately returns no Result payload (the Job wrote its
		// artifacts itself), which used to render here as world="". The size
		// is genuinely unknown in that case, so the attribute simply stays
		// away rather than reading 0x0.
		done := []any{"job", id, "world", job.Request.WorldUID, "stage", result.Stage,
			"took", ended.Sub(started).Round(time.Second)}
		if result.Width > 0 {
			done = append(done, "size", fmt.Sprintf("%dx%d", result.Width, result.Height))
		}
		slog.Info("bake done", done...)
	}
}

// buildSpec resolves a request into what a worker needs — shared by the
// subprocess runner (one per order) and the coordinator (a task each).
//
// Files where the composition put a store beside this process, URLs where it
// did not — each half decided on its own, so a local worker beside the
// artifacts can still fetch its world from a peer service. Both shapes
// produce byte-identical artifacts under the identical key (measured), so
// nothing downstream can tell which ran.
func (m *Module) buildSpec(ctx context.Context, id string, request Request) (Spec, error) {
	spec := Spec{
		Stage:         request.Stage,
		ErosionRounds: request.ErosionRounds,
		StageName:     request.StageName(),
	}
	if request.Scope.Kind == ScopeTile {
		spec.Tile = &TileRef{X: request.Scope.X, Y: request.Scope.Y}
	}
	if m.cfg.WorldZip != nil {
		zip, ok := m.cfg.WorldZip(ctx, request.WorldUID)
		if !ok {
			// Deleted (or pruned) between enqueue and start. Failing names the
			// actual cause; a dead path would report a worker fault instead.
			return Spec{}, errors.New("the world disappeared before the bake started")
		}
		spec.WorldZip = zip
	} else {
		spec.WorldURL = fmt.Sprintf("%s/worlds/%s", m.cfg.WorldsURL, request.WorldUID)
	}
	if m.cfg.ArtifactsDir != "" {
		spec.ArtifactsDir = m.cfg.ArtifactsDir
	} else {
		spec.ArtifactsURL = m.cfg.ArtifactsURL
	}
	// A worker that reaches ANY store over HTTP talks to a server that may
	// check identity, and without credentials it gets a 401 reading the world
	// it was created to bake. Scoped to this one job by audience, so it is not
	// a login: the gate refuses it everywhere a session is expected.
	if m.cfg.Tokens != nil && (spec.WorldURL != "" || spec.ArtifactsURL != "") {
		token, _, err := m.cfg.Tokens.IssueJob(id, request.WorldUID, jobTokenTTL)
		if err != nil {
			// Failing here rather than sending the worker out without one: it
			// would start, read the world, get a 401 and report a failure
			// whose cause is on this side entirely.
			return Spec{}, fmt.Errorf("cannot issue a token for the bake job: %w", err)
		}
		spec.AuthToken = token
	}
	// The local workers share this machine's disk: a long task keeps its
	// checkpoints under the module's storage, where the worker that takes
	// it over after a crash finds them.
	if m.cfg.StorageDir != "" && !m.clusterMode {
		dir, err := filepath.Abs(filepath.Join(m.cfg.StorageDir, "checkpoints"))
		if err != nil {
			return Spec{}, err
		}
		spec.CheckpointDir = dir
	}
	return spec, nil
}

// eventKeepAlive is how often a quiet event stream says it is still there,
// so proxies and the client do not take it for dead.
const eventKeepAlive = 20 * time.Second

// handleEvents streams the jobs the caller may see as they change, as
// server-sent events: one `data:` line with the job (as GET /v1/jobs/{id}
// answers it) per change. The client reads the list once and follows the
// stream instead of polling; it falls back to polling when the stream drops.
// Read with fetch, not EventSource: the caller's token travels in the
// Authorization header, which EventSource cannot send.
func (m *Module) handleEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		httpjson.ClientError(w, http.StatusInternalServerError, "streaming is not supported here")
		return
	}
	changes, stop := m.jobs.watch()
	defer stop()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()
	levels := map[string]access.Level{}
	keepAlive := time.NewTicker(eventKeepAlive)
	defer keepAlive.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-m.shutdown.Done():
			return
		case <-keepAlive.C:
			if _, err := w.Write([]byte(": keep-alive\n\n")); err != nil {
				return
			}
			flusher.Flush()
		case job := <-changes:
			level, ranked := levels[job.Request.WorldUID]
			if !ranked {
				level = m.levelFor(r, job)
				levels[job.Request.WorldUID] = level
			}
			if level < access.Viewer {
				continue
			}
			raw, err := json.Marshal(listedJob{job, level.String()})
			if err != nil {
				continue
			}
			if _, err := fmt.Fprintf(w, "data: %s\n\n", raw); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}
