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
	"sync"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/auth"
	"github.com/DebakelOrakel/casas-eternas/internal/identity"
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
	// WorldOwner answers who owns a world and whether it has a stored
	// revision — everything admitting a bake request needs to know. Injected
	// by cmd/ (the same pattern that distributes identity.Resolver): a closure
	// over the co-resident world store, or an HTTP lookup against
	// global.services.worlds. Either way this module never learns the world
	// store's disk layout.
	//
	// bearer is the enqueuing caller's Authorization header, forwarded
	// verbatim so the HTTP variant authenticates as the person asking —
	// identity travels in the token, and this module holds nobody's. The
	// closure variant ignores it.
	WorldOwner func(uid, bearer string) (owner string, ok bool)
	// The world as the BAKER reads it — exactly one of the two is set.
	// WorldZip yields the current revision's save as a file path, for a local
	// runner sitting beside the world store; called at start rather than at
	// enqueue, so a world deleted while queued fails the job instead of
	// baking a stale path. WorldsURL is the /v1 base to fetch from instead: a
	// cluster Job reaching its own server by pod IP, or any runner whose
	// world module lives in another process.
	WorldZip  func(uid string) (path string, ok bool)
	WorldsURL string
	// The artifact sink — exactly one of the two is set. ArtifactsDir is the
	// directory the co-resident artifacts module serves (safe to share:
	// that store is idempotent by construction); ArtifactsURL is its /v1 base
	// in another process. In cluster mode the baker also derives its
	// progress-report URL from ArtifactsURL, which is why cmd/ refuses the
	// cluster + remote-artifacts combination until the spec carries a
	// progress URL of its own.
	ArtifactsDir string
	ArtifactsURL string
	// SelfURL is the /v1 base under which a bake Job on ANOTHER node reaches
	// this very server. Resolved by cmd/ from the pod IP; required in a
	// cluster, empty for a purely local runner (which reports over its pipe).
	SelfURL string
	// The Node bundle, from `npm run build:baker`.
	BakerPath string
	// Identity answers who a request comes from — the same resolver every other
	// module holds, so ownership is compared against one notion of "caller".
	Identity *identity.Resolver
	// Tokens mints the credential a bake carries when it reads or writes over
	// HTTP. Nil when the server checks nobody, in which case none is needed:
	// it is talking to servers that let everyone in.
	Tokens *auth.Tokens
	// MaxConcurrent bakes. One by default, and that is a memory argument: two
	// 8192² bakes want 5 GB between them. In a cluster it also interacts with
	// the hard anti-affinity — the effective figure is min(this, nodes), and
	// setting it higher only produces Pending jobs.
	MaxConcurrent int
}

type Module struct {
	cfg Config
	// Whether jobs run as Kubernetes Jobs. Captured once at construction —
	// a process does not move in or out of a cluster while it runs.
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
}

func New(cfg Config) (*Module, error) {
	// Exactly-one checks, because these are the wiring cmd/ owes this module —
	// a missing half is a composition bug, and both halves at once would make
	// the spec builder below ambiguous about where the truth lives.
	if cfg.WorldOwner == nil {
		return nil, fmt.Errorf("bake needs its WorldOwner accessor wired; that is cmd/'s job")
	}
	if (cfg.WorldZip == nil) == (cfg.WorldsURL == "") {
		return nil, fmt.Errorf("bake needs exactly one world source (WorldZip or WorldsURL); that is cmd/'s job")
	}
	if (cfg.ArtifactsDir == "") == (cfg.ArtifactsURL == "") {
		return nil, fmt.Errorf("bake needs exactly one artifact sink (ArtifactsDir or ArtifactsURL); that is cmd/'s job")
	}
	// The runner is chosen by DETECTING the cluster and by nothing else. There
	// is deliberately no flag: both of its settings would be a behaviour the
	// design rules out — forcing cluster mode off-cluster contradicts the rule
	// that this exists only there, and forcing local mode inside one would run
	// 2.6 GB bakes in the server's own pod, under the server's own memory
	// limit. See docs/decisions/distributed-bake.md.
	var runner Runner
	var err error
	if InCluster() {
		// A Job on another node has only URLs — a file path in this pod means
		// the composition is wrong, and finding out here beats a Job getting
		// created with an empty fetch address. SelfURL is where it reports
		// progress; missing means CASAS_POD_IP was not injected.
		if cfg.SelfURL == "" || cfg.WorldsURL == "" || cfg.ArtifactsURL == "" {
			return nil, fmt.Errorf("a cluster bake needs SelfURL, WorldsURL and ArtifactsURL; is CASAS_POD_IP set? (deploy/manifests.yaml wires it)")
		}
		runner, err = NewKubernetesRunner(bakeImage())
		if err != nil {
			return nil, fmt.Errorf("cluster bake runner: %w", err)
		}
	} else {
		runner, err = NewLocalRunner(cfg.BakerPath, nodeHeapMB)
		if err != nil {
			return nil, fmt.Errorf("bake.baker: %w", err)
		}
	}

	workers := cfg.MaxConcurrent
	if workers < 1 {
		workers = 1
	}

	ctx, cancel := context.WithCancel(context.Background())
	m := &Module{
		cfg:         cfg,
		clusterMode: InCluster(),
		runner:      runner,
		jobs:        newRegistry(jobHistory),
		// Buffered so a burst of requests is accepted rather than blocking the
		// HTTP handler; full means genuinely swamped, which answers 503.
		queue:    make(chan string, 64),
		shutdown: ctx,
		cancel:   cancel,
	}
	for range workers {
		m.workers.Add(1)
		go m.work(ctx)
	}
	slog.Info("bake ready", "workers", workers, "checks identity", cfg.Identity.ChecksIdentity(), "cluster", InCluster())
	return m, nil
}

func (m *Module) Name() string { return "bake" }

// Describe tells the client HOW bakes run here, which is not something it can
// infer: the same API answers whether the work happens in a subprocess beside
// the server or as a Job on another node. The client uses it to say which, while
// it waits — and it has to choose that wording and its icon before the job
// exists, because a notification cannot change either once it is on screen.
func (m *Module) Describe() map[string]any {
	runner := "subprocess"
	if m.clusterMode {
		runner = "kubernetes"
	}
	return map[string]any{"bakeRunner": runner}
}

// Mount claims the bake routes — all of them under /v1/bakes, because a bake
// IS the job: commissioning one is creating a job resource, not an operation
// on the world. (It lived at POST /v1/worlds/{uid}/bake until 2026-08-12,
// which was the one route registered inside another module's namespace.)
func (m *Module) Mount(mux *http.ServeMux) error {
	mux.HandleFunc("POST /v1/bakes", m.handleEnqueue)
	mux.HandleFunc("GET /v1/bakes", m.handleList)
	mux.HandleFunc("GET /v1/bakes/{id}", m.handleGet)
	mux.HandleFunc("POST /v1/bakes/{id}/progress", m.handleProgress)
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
	return nil
}

// bakeImage is the image a Job runs. Taken from the environment rather than a
// flag because it is meaningless outside a cluster: the deployment sets it to
// its OWN image, so the bake pipeline is the same commit as the server that
// commissioned it — a mismatch there fails silently (the artifact key carries
// a pipeline version, and a client would simply never look for what was made).
func bakeImage() string { return os.Getenv("CASAS_BAKE_IMAGE") }

func newID() string {
	raw := make([]byte, 8)
	_, _ = rand.Read(raw)
	return hex.EncodeToString(raw)
}

func (m *Module) handleEnqueue(w http.ResponseWriter, r *http.Request) {
	var request Request
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&request); err != nil {
		clientError(w, http.StatusBadRequest, `expected {"worldUid": "…", "stage": 2}`)
		return
	}
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
	// Both checked before queueing, so a request that cannot succeed fails now
	// rather than at the far end of a queue that may be minutes long.
	owner, ok := m.cfg.WorldOwner(request.WorldUID, r.Header.Get("Authorization"))
	if !ok {
		clientError(w, http.StatusNotFound, "no such world, or it has no stored revision")
		return
	}
	if !m.canBake(m.cfg.Identity.Caller(r), owner) {
		// 403 and not 404: the world exists, and pretending otherwise would
		// make a permission problem look like a missing save.
		clientError(w, http.StatusForbidden, "only a world's owner may commission a bake for it")
		return
	}

	// Checked LAST, right before queueing: a request refused for shutdown
	// should not have been refused for a reason that would still apply
	// tomorrow. The remaining race — shutdown beginning between this check and
	// the send — strands an id in the buffered queue of an exiting process,
	// which costs nothing; the panic the old close(queue) risked cost the
	// whole shutdown.
	if m.shutdown.Err() != nil {
		clientError(w, http.StatusServiceUnavailable, "server is shutting down")
		return
	}

	job := m.jobs.add(Job{ID: newID(), Request: request, State: StateQueued, QueuedAt: time.Now()})
	select {
	case m.queue <- job.ID:
	default:
		job, _ = m.jobs.update(job.ID, func(j *Job) {
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

// handleProgress takes a running job's own report of where it has got to.
//
// A Job on another node has no other way to say: the Kubernetes API tells this
// server whether a pod is pending, running or gone, and nothing in between. The
// alternative was reading the pod's log, which is a second connection with its
// own failure modes; this is the connection the Job already uses for the world
// and the artifacts. See docs/decisions/server-auth.md.
//
// THE TOKEN IS THE AUTHORISATION, and this is where the audience earns itself:
// a job's token names one job, so verifying it against the id in the path
// answers "may this caller report for this job" in a single comparison. No
// ownership lookup, no caller-to-job table.
func (m *Module) handleProgress(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !m.mayReportFor(r, id) {
		// Deliberately not 401: the caller may be perfectly well authenticated,
		// just not as this job. 403 says "not you" rather than "who are you".
		clientError(w, http.StatusForbidden, "not this job")
		return
	}
	var report Progress
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, progressBodyLimit)).Decode(&report); err != nil {
		clientError(w, http.StatusBadRequest, "malformed progress")
		return
	}
	if report.Phase == "" {
		clientError(w, http.StatusBadRequest, "phase is required")
		return
	}
	// Clamped rather than rejected: a percent slightly out of range is a rounding
	// error in a progress bar, and failing the report would lose the phase too.
	report.Percent = min(100, max(0, report.Percent))

	updated := false
	m.jobs.update(id, func(j *Job) {
		// Only while it is running. A report that arrives after the job ended —
		// a retry, or a pod that outlived its own result — must not reopen a
		// finished record or move a failed one back to 50%.
		if j.State != StateRunning {
			return
		}
		j.Phase = report.Phase
		j.Percent = report.Percent
		updated = true
	})
	if !updated {
		// 404 for both "no such job" and "not running any more": the reporter
		// cannot act on the difference, and saying which would let anyone
		// holding one job's token probe for the state of others.
		clientError(w, http.StatusNotFound, "no such running job")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// mayReportFor answers whether this request is THIS job reporting.
//
// Asked of the resolver rather than verified here: the module MINTS job tokens
// (cfg.Tokens) and that is a different capability from checking one. Verifying
// with its own copy worked and was wrong — two answers to "who is asking" in one
// process is exactly what the identity package exists to prevent.
func (m *Module) mayReportFor(r *http.Request, id string) bool {
	// The local mode checks nobody, and its runner reports over a pipe anyway —
	// so this endpoint is unused there rather than open.
	if !m.cfg.Identity.ChecksIdentity() {
		return true
	}
	jobID, ok := m.cfg.Identity.BakeJob(r)
	return ok && jobID == id
}

func (m *Module) handleList(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, m.jobs.list())
}

// canBake decides whether this caller may commission a bake of this world.
//
// A bake is minutes of a machine, so in a multi-user deployment it is not a
// thing anyone may ask for on anyone's world. The rule is OWNERSHIP — it is
// your world — matching the staging the artifact store already sets out.
//
// In `none` mode this passes unconditionally, because that mode IS the local
// one: a person on their own machine, with nobody to be protected from. The
// check still runs, which is the point of having it now rather than later.
func (m *Module) canBake(caller, owner string) bool {
	if !m.cfg.Identity.ChecksIdentity() {
		return true
	}
	// A machine identity owns nothing, ever. Without this the comparison below
	// is true when caller and owner are BOTH the job subject — reachable, since
	// a job is a caller and a world it wrote would record it as the owner. The
	// rule is worth stating rather than relying on no such world existing.
	if caller == auth.SubjectBakeJob || owner == auth.SubjectBakeJob {
		return false
	}
	return caller != identity.Anonymous && caller == owner
}

// progressBodyLimit bounds what a progress report may be. It is two small
// fields; anything larger is a mistake or an attempt, and reading it into memory
// first would be the wrong way to find out.
const progressBodyLimit = 1 << 10

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
		if !ok {
			continue
		}
		started := time.Now()
		m.jobs.update(id, func(j *Job) {
			j.State = StateRunning
			j.StartedAt = &started
		})

		// Files where the composition put a store beside this process, URLs
		// where it did not — each half decided on its own, so a local runner
		// beside the artifacts can still fetch its world from a peer service.
		// Both shapes produce byte-identical artifacts under the identical
		// key (measured), so nothing downstream can tell which ran.
		spec := Spec{
			Stage:         job.Request.Stage,
			ErosionRounds: job.Request.ErosionRounds,
		}
		if m.cfg.WorldZip != nil {
			zip, ok := m.cfg.WorldZip(job.Request.WorldUID)
			if !ok {
				// Deleted (or pruned) between enqueue and start. Failing the
				// job names the actual cause; handing the runner a dead path
				// would report a baker fault instead.
				failed := time.Now()
				m.jobs.update(id, func(j *Job) {
					j.State = StateFailed
					j.Error = "the world disappeared before the bake started"
					j.EndedAt = &failed
				})
				slog.Warn("bake not started, world gone", "job", id, "world", job.Request.WorldUID)
				continue
			}
			spec.WorldZip = zip
		} else {
			spec.WorldURL = fmt.Sprintf("%s/worlds/%s", m.cfg.WorldsURL, job.Request.WorldUID)
		}
		if m.cfg.ArtifactsDir != "" {
			spec.ArtifactsDir = m.cfg.ArtifactsDir
		} else {
			spec.ArtifactsURL = m.cfg.ArtifactsURL
		}
		// A baker that reaches ANY store over HTTP talks to a server that may
		// check identity, and without credentials it gets a 401 reading the
		// world it was created to bake. Scoped to this one job by audience, so
		// it is not a login: the gate refuses it everywhere a session is
		// expected.
		if m.cfg.Tokens != nil && (spec.WorldURL != "" || spec.ArtifactsURL != "") {
			token, _, tokenErr := m.cfg.Tokens.Issue(auth.SubjectBakeJob, auth.BakeAudience(id), jobTokenTTL)
			if tokenErr != nil {
				// Failing here rather than sending the baker out without one:
				// it would start, read the world, get a 401 and report a
				// bake failure whose cause is on this side entirely.
				failed := time.Now()
				m.jobs.update(id, func(j *Job) {
					j.State = StateFailed
					j.Error = fmt.Sprintf("cannot issue a token for the bake job: %v", tokenErr)
					j.EndedAt = &failed
				})
				slog.Error("bake not started", "job", id, "err", tokenErr)
				continue
			}
			spec.AuthToken = token
		}
		// Only a Job on another node learns its own id: it reports progress
		// through the HTTP route. The local baker reports over its stderr
		// pipe, which this process is already reading — telling it its id
		// would invite it to post progress to a server it is running inside.
		if m.clusterMode {
			spec.JobID = id
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
