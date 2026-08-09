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
	"strings"
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
	// Identity answers who a request comes from — the same resolver every other
	// module holds, so ownership is compared against one notion of "caller".
	Identity *identity.Resolver
	// Tokens mints the credential a CLUSTER bake carries. Nil when the server
	// checks nobody, in which case a Job needs none: it is talking to a server
	// that lets everyone in.
	Tokens *auth.Tokens
	// Listen is the server's own bind address, used only to work out the port a
	// bake Job should reach it on.
	Listen string
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
	serverURL   string
	runner      Runner
	jobs        *registry
	queue       chan string
	cancel      context.CancelFunc
	workers     sync.WaitGroup
}

func New(cfg Config) (*Module, error) {
	if cfg.WorldsDir == "" || cfg.ArtifactsDir == "" {
		return nil, fmt.Errorf("--dir-worlds and --dir-artifacts are both required for bakes")
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
		runner, err = NewKubernetesRunner(bakeImage(), serverBaseURL(cfg.Listen))
		if err != nil {
			return nil, fmt.Errorf("cluster bake runner: %w", err)
		}
	} else {
		runner, err = NewLocalRunner(cfg.BakerPath, nodeHeapMB)
		if err != nil {
			return nil, fmt.Errorf("--baker: %w", err)
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
		serverURL:   serverBaseURL(cfg.Listen),
		runner:      runner,
		jobs:        newRegistry(jobHistory),
		// Buffered so a burst of requests is accepted rather than blocking the
		// HTTP handler; full means genuinely swamped, which answers 503.
		queue:  make(chan string, 64),
		cancel: cancel,
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

func (m *Module) Mount(mux *http.ServeMux) error {
	mux.HandleFunc("POST /v1/worlds/{uid}/bake", m.handleEnqueue)
	mux.HandleFunc("GET /v1/bakes", m.handleList)
	mux.HandleFunc("GET /v1/bakes/{id}", m.handleGet)
	mux.HandleFunc("POST /v1/bakes/{id}/progress", m.handleProgress)
	return nil
}

// Close stops the worker and waits for the job in flight. A bake that is
// minutes in is worth the wait on shutdown — killing it wastes the work and
// leaves a half-written artifact for the next reader to find.
func (m *Module) Close() error {
	m.cancel()
	close(m.queue)
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

// serverBaseURL is the address a bake Job uses to fetch its world and PUT its
// artifacts. The pod's own IP, injected by the downward API — a Job on another
// node cannot mount this pod's ReadWriteOnce volume, so HTTP is the only way
// back, and the pod IP needs no Service to exist first.
//
// If the server pod is replaced mid-bake the address dies with it; so does the
// bake's reason to exist, since nobody is waiting for it any more.
func serverBaseURL(listen string) string {
	ip := os.Getenv("CASAS_POD_IP")
	if ip == "" {
		return ""
	}
	port := "8080"
	if index := strings.LastIndex(listen, ":"); index >= 0 && index+1 < len(listen) {
		port = listen[index+1:]
	}
	return fmt.Sprintf("http://%s:%s/v1", ip, port)
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
	// Both checked before queueing, so a request that cannot succeed fails now
	// rather than at the far end of a queue that may be minutes long.
	owner, zip, ok := m.worldMeta(request.WorldUID)
	if !ok {
		clientError(w, http.StatusNotFound, "no such world, or it has no stored revision")
		return
	}
	if _, err := os.Stat(zip); err != nil {
		clientError(w, http.StatusNotFound, "no such world, or it has no stored revision")
		return
	}
	if !m.canBake(m.cfg.Identity.Caller(r), owner) {
		// 403 and not 404: the world exists, and pretending otherwise would
		// make a permission problem look like a missing save.
		clientError(w, http.StatusForbidden, "only a world's owner may commission a bake for it")
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

// worldMeta reads the little of a world's record this module needs.
//
// Reads the world store's own meta.json rather than importing the package: the
// modules are deliberately independent, and a read-only reader of a documented
// on-disk layout is a smaller coupling than a shared object would be.
func (m *Module) worldMeta(uid string) (owner string, zip string, ok bool) {
	raw, err := os.ReadFile(filepath.Join(m.cfg.WorldsDir, uid, "meta.json"))
	if err != nil {
		return "", "", false
	}
	var meta struct {
		Owner    string `json:"owner"`
		Revision int    `json:"revision"`
	}
	if json.Unmarshal(raw, &meta) != nil || meta.Revision < 1 {
		return "", "", false
	}
	return meta.Owner, filepath.Join(m.cfg.WorldsDir, uid, "rev", fmt.Sprint(meta.Revision), "world.zip"), true
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

		_, zip, _ := m.worldMeta(job.Request.WorldUID)
		spec := Spec{
			JobID:         id,
			Stage:         job.Request.Stage,
			ErosionRounds: job.Request.ErosionRounds,
		}
		// Files when the work happens here, URLs when it happens on another
		// node. Both produce byte-identical artifacts under the identical key
		// (measured), so nothing downstream can tell which ran.
		if m.clusterMode {
			spec.WorldURL = fmt.Sprintf("%s/worlds/%s", m.serverURL, job.Request.WorldUID)
			spec.ArtifactsURL = m.serverURL
			// A Job on another node reaches the server over HTTP like any other
			// client, so on a server that checks identity it needs credentials —
			// without them it gets a 401 reading the world it was created to
			// bake. Scoped to this one job by audience, so it is not a login:
			// the gate refuses it everywhere a session is expected.
			if m.cfg.Tokens != nil {
				token, _, tokenErr := m.cfg.Tokens.Issue(auth.SubjectBakeJob, auth.BakeAudience(id), jobTokenTTL)
				if tokenErr != nil {
					// Failing here rather than sending the Job out without one:
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
		} else {
			spec.WorldZip = zip
			spec.ArtifactsDir = m.cfg.ArtifactsDir
			// The local baker reports over its stderr pipe, which this process
			// is already reading. Telling it its own id would invite it to post
			// progress to a server it is running inside.
			spec.JobID = ""
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
