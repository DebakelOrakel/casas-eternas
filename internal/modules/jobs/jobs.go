// Package bake turns a stored world into a finer mesh level, on the server.
//
// The reason it exists is size: level 1 of a real world is ~17 M nodes and
// 349 MB, unremarkable for a process and too much for a browser tab. (It
// baked the raster amplification's 4096²/8192² tiers until 2026-09-29.)
//
// It is NOT a port of the pipeline. The worker is the client's own
// TypeScript, bundled for Node, so an artifact carries a key derived from its
// inputs exactly as the client derives it. A coordinator hands out the tasks
// over the relay (coordinator.go); workers serve them — off a cluster the
// processes this module starts (workerpool.go), in a cluster the worker
// Deployment it scales (scaler.go).
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

// NodeHeapMB is what the baker's Node process is allowed. Sized for the 8192²
// measurement (~2.6 GB) with headroom, since running out mid-bake wastes the
// minutes already spent. The worker Deployment pins the same number by hand
// in the chart (deploy/helm/values.yaml, workers.heapMB) — change the two together;
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
const NodeHeapMB = 6144

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
	// worker sitting beside the world store; called when the task is handed
	// out rather than at enqueue, so a world deleted while queued fails the
	// job instead of baking a stale path. WorldsURL is the /v1 base to fetch
	// from instead: a cluster worker reaching its own server by pod IP, or
	// any worker whose world module lives in another process.
	WorldZip  func(ctx context.Context, uid string) (path string, ok bool)
	WorldsURL string
	// The artifact sink: the artifacts module's /v1 base. Always a URL
	// (DEC-0038, step 3): the store's index lives in the artifacts
	// module's process and sees only what passes through its API, and on
	// s3 there is no directory to write into. cmd/ gives a local worker
	// the server's own listener (or its internal one, where the public
	// one speaks TLS), a cluster worker the pod IP.
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
	// MaxConcurrent is how many workers compute at once: the local worker
	// processes, or the most replicas the scaler gives the worker
	// Deployment. One by default, and that is a memory argument: a level-1
	// task wants gigabytes. In a cluster the ceiling is the nodes' free
	// memory instead; setting this above what the cluster can hold only
	// produces Pending pods. Zero: none of this server's own — every worker
	// joins from outside (2026-10-22).
	MaxConcurrent int
	// ScaleWorkers: in a cluster, scale the worker Deployment (scaler.go).
	// False for a server whose workers all come from outside.
	ScaleWorkers bool
	// The module's connection to the relay (internal/relay), made by cmd/
	// in the process or to global.services.relay. The module owns it from
	// here and closes it. With it, off a cluster, the jobs run through the
	// coordinator and its workers. Required: the jobs run over it.
	Relay *relay.Conn
	// Where the local workers reach the relay (a NATS URL): the co-resident
	// relay's port, or global.services.relay.
	RelayURL string
	// The coordinator's state directory (jobs.state-dir), for jobs.db.
	StateDir string
	// ArtifactPresent answers, per key, whether that artifact is whole in the
	// store: what lets the coordinator mark a refine plan's tiles that are
	// already there done instead of handing each to a worker to find out
	// (coordinator.go, handleDone). One call for all of a plan's tiles, so
	// the store is scanned once. Composed by cmd/ over a co-resident
	// artifacts module; nil leaves the check to the workers.
	ArtifactPresent func(ctx context.Context, keys []ArtifactKey) []bool
	// Launcher is this binary, which runs `worker` (launcher.go) for each
	// local worker; LocalAPI this server's API as a local worker reaches it
	// (`…/v1`).
	Launcher string
	LocalAPI string
	// GeneratorSource is where the pipelines' releases are
	// (jobs.generator-source): a file of a release is
	// <GeneratorSource>/generator-<pipeline>/<file> (engines.go).
	GeneratorSource string
	// PipelineFiles keeps the files of the pipelines' releases in the
	// artifact store: composed by cmd/ over a co-resident artifacts module.
	// Nil: over ArtifactsURL, with the module's own credential (engines.go,
	// httpPipelineFiles).
	PipelineFiles PipelineFiles
}

type Module struct {
	cfg Config
	// Whether this server runs in a cluster, its workers in pods of their own.
	// Captured once at construction — a process does not move in or out of a
	// cluster while it runs.
	clusterMode bool
	jobs        *registry
	// shutdown is done once Close has begun. It is what the enqueue handler
	// and the event streams watch.
	shutdown context.Context
	cancel   context.CancelFunc
	// The coordinator, and its local workers off a cluster (coordinator.go,
	// workerpool.go; pool is nil in a cluster).
	coord *coordinator
	pool  *workerPool
	// How many jobs run at once (jobs.max-concurrent): the local workers,
	// or the most the worker Deployment is scaled to.
	slots int
	// The cluster's worker scaler; nil where this process starts its own
	// workers.
	scaler *workerScaler
	// One download of a pipeline file at a time (engines.go).
	fetchMu sync.Mutex
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
	if cfg.ArtifactsURL == "" {
		return nil, fmt.Errorf("bake needs its artifact sink (ArtifactsURL); that is cmd/'s job")
	}
	// Where the work runs is decided by DETECTING the cluster and by nothing
	// else, deliberately without a flag: in a cluster it runs in the worker
	// Deployment this module scales, never in the server's own pod under the
	// server's own memory limit; off one, in workers this module starts.
	// See docs/decisions/detail-ladder.md, addendum 2026-10-03.
	if cfg.Relay == nil {
		return nil, fmt.Errorf("jobs run over the relay: run -t relay in this process or set global.services.relay")
	}
	if cfg.StateDir == "" {
		return nil, fmt.Errorf("jobs.state-dir: the coordinator needs a directory for jobs.db")
	}
	if cfg.MaxConcurrent < 0 {
		return nil, fmt.Errorf("jobs.max-concurrent: %d workers; 0 is none of this server's own", cfg.MaxConcurrent)
	}
	workers := cfg.MaxConcurrent
	var workerPath string
	var err error
	if InCluster() {
		// A worker in another pod has only URLs — a file path in this pod
		// means the composition is wrong, and finding out here beats a task
		// going out with an empty fetch address.
		if cfg.WorldsURL == "" {
			return nil, fmt.Errorf("jobs in a cluster need WorldsURL; is CASAS_POD_IP set? (the chart, deploy/helm, wires it)")
		}
	} else if workers > 0 {
		workerPath, err = workerBundle(cfg.WorkerPath)
		if err != nil {
			return nil, fmt.Errorf("jobs.worker: %w", err)
		}
	}

	declareCtx, declareCancel := context.WithTimeout(context.Background(), 10*time.Second)
	err = declareStreams(declareCtx, cfg.Relay)
	declareCancel()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	m := &Module{
		cfg:         cfg,
		clusterMode: InCluster(),
		slots:       workers,
		jobs:        newRegistry(jobHistory),
		shutdown:    ctx,
		cancel:      cancel,
	}
	// The coordinator plans and hands out the tasks, and workers compute
	// them — off a cluster the local ones this module starts, in a cluster
	// the worker Deployment it scales (scaler.go).
	var token tokenFor
	if cfg.Tokens != nil {
		token = func(jobID, worldUID string) (string, time.Time, error) {
			return cfg.Tokens.IssueJob(jobID, worldUID, jobTokenTTL)
		}
	}
	m.coord, err = newCoordinator(cfg.StateDir, cfg.Relay, m.jobs, m.buildSpec, token, cfg.ArtifactPresent)
	if err != nil {
		cancel()
		return nil, err
	}
	if cfg.PipelineFiles == nil {
		cfg.PipelineFiles = httpPipelineFiles{base: cfg.ArtifactsURL, tokens: cfg.Tokens}
		m.cfg.PipelineFiles = cfg.PipelineFiles
	}
	if workerPath != "" && cfg.RelayURL != "" {
		if cfg.Launcher == "" {
			m.coord.close()
			cancel()
			return nil, fmt.Errorf("local workers need their launcher (Launcher); that is cmd/'s job")
		}
		m.pool = startWorkerPool(localWorker{launcher: cfg.Launcher, bundle: workerPath, jobsAPI: cfg.LocalAPI, heapMB: NodeHeapMB}, cfg.RelayURL, workers, cfg.Tokens)
	}
	if InCluster() && cfg.ScaleWorkers && workers > 0 {
		api, err := newClusterAPI()
		if err != nil {
			m.coord.close()
			cancel()
			return nil, fmt.Errorf("worker scaler: %w", err)
		}
		scaler := &workerScaler{api: api, workload: m.coord.workload, max: workers}
		scaler.wanted.Store(-1)
		m.scaler = scaler
		go scaler.run(ctx)
	}
	slog.Info("jobs ready", "coordinator", cfg.StateDir, "workers", workers, "checks identity", cfg.Identity.ChecksIdentity())
	return m, nil
}

func (m *Module) Name() string { return "jobs" }

// Describe tells the client HOW jobs run here. Since the subprocess runner
// went (2026-10-03) the answer is always the relay; the key stays because
// the client reads it.
func (m *Module) Describe() map[string]any {
	// The jobs window's "n of m workers busy" reads jobWorkers: the local
	// workers, or the most the worker Deployment is scaled to.
	return map[string]any{"bakeRunner": "relay", "jobWorkers": m.slots}
}

// Mount claims the bake routes — all of them under /v1/bakes, because a bake
// IS the job: commissioning one is creating a job resource, not an operation
// on the world. (It lived at POST /v1/worlds/{uid}/bake until 2026-08-12,
// which was the one route registered inside another module's namespace.)
func (m *Module) Mount(mux *http.ServeMux) error {
	mux.HandleFunc("POST /v1/jobs", m.handleEnqueue)
	mux.HandleFunc("GET /v1/jobs", m.handleList)
	mux.HandleFunc("GET /v1/jobs/events", m.handleEvents)
	mux.HandleFunc("GET /v1/jobs/workers", m.handleWorkers)
	mux.HandleFunc("GET /v1/jobs/engines/{pipeline}/{file}", m.handleEngineFile)
	mux.HandleFunc("GET /v1/jobs/pipelines", m.handlePipelines)
	mux.HandleFunc("GET /v1/jobs/{id}", m.handleGet)
	mux.HandleFunc("DELETE /v1/jobs/{id}", m.handleCancel)
	return nil
}

// Close stops the local workers and the coordinator. A task a worker held
// stays unacknowledged on the relay and goes to the next worker — harmless,
// because the artifact store only ever sees complete file PUTs and the key
// is derived from inputs, so an interrupted task simply leaves nothing to
// find.
func (m *Module) Close() error {
	m.cancel()
	if m.pool != nil {
		m.pool.stop()
	}
	m.coord.close()
	m.cfg.Relay.Close()
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
		httpjson.ClientError(w, http.StatusBadRequest, `expected {"worldUid": "…", "stage": 1, "pipeline": "…"}, {"worldUid": "…", "stage": 2, "scope": {"kind": "tile", "x": 0, "y": 0}, "pipeline": "…"} or {"worldUid": "…", "stage": 1, "scope": {"kind": "history", "id": 0}, "level": "…", "pipeline": "…"}`)
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
	// A job token orders nothing: that is what keeps a leaked one from
	// ordering more bakes. Refused before it is ranked (it ranks as a
	// viewer on a template or a public world).
	if _, _, ok := m.cfg.Identity.JobToken(r); ok {
		httpjson.ClientError(w, http.StatusForbidden, "a job token does not order jobs")
		return
	}
	// Ranked before queueing, so a request that cannot succeed fails now
	// rather than at the far end of a queue that may be minutes long. The
	// visibility shape matches the world module's: a world the caller may
	// not read answers 404 — private means invisible. Every signed-in
	// caller who may read the world may order (DEC-0039, fork 5): the bytes
	// are the same whoever orders them, and they serve every world with the
	// terrain, so ordering is a cost, not a right over the world. The
	// anonymous caller never gets here; the gate refuses it.
	exists, level := m.cfg.WorldAccess(r.Context(), request.WorldUID, r.Header.Get("Authorization"))
	if !exists || level < access.Viewer {
		httpjson.ClientError(w, http.StatusNotFound, "no such world, or it has no stored revision")
		return
	}

	// Checked LAST, right before queueing: a request refused for shutdown
	// should not have been refused for a reason that would still apply
	// tomorrow.
	if m.shutdown.Err() != nil {
		httpjson.ClientError(w, http.StatusServiceUnavailable, "server is shutting down")
		return
	}

	job := m.jobs.add(Job{ID: newID(), Request: request, State: StateQueued, QueuedAt: time.Now(), OrderedBy: m.orderer(r)})
	if err := m.coord.submit(job); err != nil {
		httpjson.ClientError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	slog.Info("job planned", "job", job.ID, "world", request.WorldUID, "stage", request.Stage, "plan", request.Plan)
	job, _ = m.jobs.get(job.ID)
	// 202: accepted, not done. The caller polls, or simply looks for the
	// artifact — which is the point of keying artifacts by content.
	httpjson.Write(w, http.StatusAccepted, job)
}

// orderer is the caller as a job records it (Job.OrderedBy): a user id in
// a checking server, empty in the local mode.
func (m *Module) orderer(r *http.Request) string {
	if !m.cfg.Identity.ChecksIdentity() {
		return ""
	}
	caller, _ := m.cfg.Identity.ResolveBearer(r.Header.Get("Authorization"))
	if caller == identity.Anonymous {
		return ""
	}
	return caller
}

// mayCancel answers whether a caller with `level` on a job's world may
// cancel it: an editor of the world, or the caller who ordered it.
func (m *Module) mayCancel(r *http.Request, job Job, level access.Level) bool {
	if level >= access.Editor {
		return true
	}
	caller := m.orderer(r)
	return caller != "" && caller == job.OrderedBy
}

// ActionCancel is the one action a caller may have on a job: an editor of
// its world, or the caller who ordered it (mayCancel).
const ActionCancel = "job.cancel"

// A job with the actions the caller may perform on it — what the client
// renders by, deriving no rule of its own (DEC-0040, fork 7).
type listedJob struct {
	Job
	Actions []string `json:"actions"`
}

// listed answers a job as the caller sees it.
func (m *Module) listed(r *http.Request, job Job, level access.Level) listedJob {
	actions := []string{}
	if m.mayCancel(r, job, level) {
		actions = append(actions, ActionCancel)
	}
	return listedJob{job, actions}
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
	httpjson.Write(w, http.StatusOK, m.listed(r, job, level))
}

// handleCancel stops a job: its queued tasks are withdrawn, and a worker
// computing one of them is told to stop. A half-run task is harmless (see
// Close). A job that has already ended answers 409.
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
	if !m.mayCancel(r, job, level) {
		httpjson.ClientError(w, http.StatusForbidden, "cancelling a bake needs editor access to its world, or to have ordered it")
		return
	}
	if !m.coord.cancelJob(id) {
		httpjson.ClientError(w, http.StatusConflict, "the job has already ended")
		return
	}
	slog.Info("job cancelled", "job", id, "world", job.Request.WorldUID)
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
			visible = append(visible, m.listed(r, job, level))
		}
	}
	httpjson.Write(w, http.StatusOK, visible)
}

// jobTokenTTL bounds a job's credential.
//
// The task carries one minted when it is handed out; the worker asks the
// coordinator for a fresh one when it starts the task and again before the
// one in hand runs out (coordinator.go, handleToken), so a task of any
// length stays authorized while its job is open, and a cancelled job's
// worker is refused within the hour. (For a day of 2026-10-04 it was 48
// hours, minted once: a level-1 replay ran 7 h 45 min in the cluster and
// its artifact write was refused with the hour.) It names one job and one
// world.
const jobTokenTTL = time.Hour

// buildSpec resolves a request into what a worker needs, a task at a time
// (the coordinator's specFor).
//
// The world as a file where the composition put the world store beside
// this process, as a URL where it did not; the artifacts always by URL
// (Config.ArtifactsURL). Both world shapes produce byte-identical artifacts
// under the identical key (measured), so nothing downstream can tell which
// ran.
func (m *Module) buildSpec(ctx context.Context, id string, request Request) (Spec, error) {
	spec := Spec{
		Stage:         request.Stage,
		ErosionRounds: request.ErosionRounds,
		StageName:     request.StageName(),
	}
	if request.Scope.Kind == ScopeTile {
		spec.Tile = &TileRef{X: request.Scope.X, Y: request.Scope.Y}
	}
	if request.Scope.Kind == ScopeHistory {
		spec.History = &HistoryRef{Origin: request.Scope.ID, Level: request.Level, Reach: request.Scope.Reach, SeaLow: request.Scope.SeaLow}
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
	spec.ArtifactsURL = m.cfg.ArtifactsURL
	// Every worker reaches the artifact store over HTTP, so it talks to a
	// server that may check identity, and without credentials it gets a 401
	// writing what it was created to bake. Scoped to this one job by
	// audience, so it is not a login: the gate refuses it everywhere a
	// session is expected.
	if m.cfg.Tokens != nil {
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
	// checkpoints under the module's state-dir, where the worker that takes
	// it over after a crash finds them.
	if m.cfg.StateDir != "" && !m.clusterMode {
		dir, err := filepath.Abs(filepath.Join(m.cfg.StateDir, "checkpoints"))
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
			raw, err := json.Marshal(m.listed(r, job, level))
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
