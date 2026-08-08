package bake

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"
	"text/template"
	"time"

	"gopkg.in/yaml.v3"
)

// The Runner that turns a bake into a Kubernetes Job.
//
// The whole point of `Runner` being an interface: the queue, the routes and
// the job registry above are untouched by this file. What changes is only
// WHERE the work happens — and, because the baker already reads and writes
// over HTTP, the Job needs no volume and can be scheduled anywhere. That is
// what makes the hard anti-affinity in the template workable at all.

// The Job manifest, kept as an editable file rather than built in Go: what a
// reader sees in internal/bake/bake-job.yaml is exactly what the cluster is
// asked for. It lives beside this file rather than in deploy/ only because
// go:embed cannot reach outside its own package; deploy/README.md says so.
// Embedded so the binary runs alone; a ConfigMap-mounted override later is a
// change of where this is read from, nothing more.
//
//go:embed bake-job.yaml
var defaultJobTemplate string

const (
	// How often the Job's status is read. A bake runs for minutes, so this is
	// generous — and polling avoids a watch stream's reconnect and
	// resource-version handling, which is the fiddliest part of the API.
	pollInterval = 2 * time.Second
	// Finished Jobs disappear on their own after this. The artifact is the
	// result; the Job object is only the story of how it got there.
	jobTTLSeconds = 600
	// How long a Job may fail to start a pod before it is given up on.
	//
	// This is not paranoia. A pod rejected by admission — an SCC that refuses
	// the security context, a quota already spent — does NOT increment the
	// Job's `failed` counter: the Job simply never progresses, and a runner
	// without this would poll it until the process died, holding a worker slot
	// the whole time.
	//
	// Generous, because Pending is a legitimate state here: hard anti-affinity
	// means a Job beyond the node count waits for one to free up, and that is
	// the design working rather than failing.
	schedulingDeadline = 10 * time.Minute
)

type kubernetesRunner struct {
	api       *clusterAPI
	template  *template.Template
	image     string
	serverURL string
	// Memory the Job asks for and is capped at. The measured 8192² peak is
	// ~2.6 GB, so the request has to be honest or the scheduler will put two
	// bakes on one node despite the anti-affinity being satisfied.
	memoryRequest string
	memoryLimit   string
}

// NewKubernetesRunner is only reachable when InCluster() says so — see
// docs/decisions/distributed-bake.md for why there is no flag to force it.
func NewKubernetesRunner(image, serverURL string) (Runner, error) {
	api, err := newClusterAPI()
	if err != nil {
		return nil, err
	}
	if image == "" {
		return nil, fmt.Errorf("no image to run bakes with; set CASAS_BAKE_IMAGE or the pod's own image")
	}
	parsed, err := templateFor(defaultJobTemplate)
	if err != nil {
		return nil, err
	}
	return &kubernetesRunner{
		api:           api,
		template:      parsed,
		image:         image,
		serverURL:     strings.TrimSuffix(serverURL, "/"),
		memoryRequest: "3Gi",
		memoryLimit:   "4Gi",
	}, nil
}

// templateFor parses a job template. Its own function so the integration test
// can build the same runner against a real cluster without duplicating what a
// correctly-constructed one looks like.
func templateFor(text string) (*template.Template, error) {
	parsed, err := template.New("bake-job").Parse(text)
	if err != nil {
		return nil, fmt.Errorf("bake job template: %w", err)
	}
	return parsed, nil
}

// jobName derives a valid object name from a job id. Kubernetes names are
// DNS-1123 labels, so the hex id is prefixed rather than used bare — a name
// starting with a digit is rejected, and "bake-" also makes the objects
// obvious in a listing.
func jobName(id string) string { return "casas-bake-" + strings.ToLower(id) }

func (r *kubernetesRunner) Run(ctx context.Context, spec Spec, onProgress func(Progress)) (Result, error) {
	// The Job talks to the server over HTTP, so the paths a local subprocess
	// would use are replaced here. This is the only place that knows the
	// difference; the baker itself picks its store from what it is handed.
	remote := spec
	remote.WorldZip = ""
	remote.ArtifactsDir = ""
	if remote.WorldURL == "" || remote.ArtifactsURL == "" {
		return Result{}, fmt.Errorf("a cluster bake needs worldUrl and artifactsUrl")
	}
	payload, err := json.Marshal(remote)
	if err != nil {
		return Result{}, err
	}
	// argv as a JSON array, so a template that is edited by hand cannot break
	// quoting: the value substituted is already a valid YAML flow sequence.
	args, err := json.Marshal([]string{string(payload)})
	if err != nil {
		return Result{}, err
	}

	name := jobName(spec.JobID)
	manifest, err := r.render(name, spec.JobID, string(args))
	if err != nil {
		return Result{}, err
	}
	if err := r.api.createJob(ctx, manifest); err != nil {
		return Result{}, err
	}
	// Always cleaned up, even on failure or shutdown: the TTL would get there
	// eventually, but a bake pod left holding 2.6 GB blocks a node against the
	// anti-affinity rule for as long as it lives.
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
		defer cancel()
		_ = r.api.deleteJob(cleanup, name)
	}()

	return r.await(ctx, name, spec.Stage, onProgress)
}

func (r *kubernetesRunner) render(name, jobID, args string) ([]byte, error) {
	var out bytes.Buffer
	err := r.template.Execute(&out, map[string]string{
		"Name":          name,
		"Namespace":     r.api.namespace,
		"Image":         r.image,
		"Args":          args,
		"JobID":         jobID,
		"MemoryRequest": r.memoryRequest,
		"MemoryLimit":   r.memoryLimit,
		"TTLSeconds":    fmt.Sprint(jobTTLSeconds),
	})
	if err != nil {
		return nil, fmt.Errorf("rendering the bake job: %w", err)
	}
	// YAML in the repo, JSON on the wire. The template stays readable and
	// reviewable — which is the whole reason it is a file — while the API gets
	// what it wants.
	var document any
	if err := yaml.Unmarshal(out.Bytes(), &document); err != nil {
		return nil, fmt.Errorf("bake job template is not valid YAML: %w", err)
	}
	return json.Marshal(document)
}

// await polls until the Job finishes, reporting what it can along the way.
//
// There is no per-phase progress here, unlike the local runner: a Job's output
// is its pod's log, and streaming that back would be a second connection and a
// second failure mode for a number nobody acts on. What IS reported is the
// distinction that matters — a Job waiting for a node looks nothing like one
// that is working, and calling both "running" would be a lie the anti-affinity
// rule makes routine.
func (r *kubernetesRunner) await(ctx context.Context, name string, stage int, onProgress func(Progress)) (Result, error) {
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	reported := ""
	begun := time.Now()
	giveUpUnstarted := begun.Add(schedulingDeadline)

	for {
		select {
		case <-ctx.Done():
			// A bare "context deadline exceeded" says nothing about what was
			// being waited FOR, and this wait has two very different shapes:
			// a job that never got a node, and a job that has been baking for
			// minutes. Naming the last known phase is the difference between
			// "something timed out" and knowing where to look. Observed for
			// real: an image pull onto a freshly provisioned node took 52 s of
			// the 54 s the whole job needed.
			phase := reported
			if phase == "" {
				phase = "not yet observed"
			}
			return Result{}, fmt.Errorf("stopped waiting for bake job %s after %s (last seen: %s): %w",
				name, time.Since(begun).Round(time.Second), phase, ctx.Err())
		case <-ticker.C:
		}

		state, err := r.api.jobStatus(ctx, name)
		if err != nil {
			// A transient API error is not a failed bake — the Job is still
			// out there working. Only a cancelled context ends this loop.
			continue
		}

		switch {
		case state.Succeeded > 0:
			// No Result. The Job wrote its artifacts itself and its output is
			// its pod's log; fetching that back would be a second connection
			// and a second failure mode to report numbers nobody acts on. The
			// artifact IS the result, and every client finds it by key — which
			// is exactly what keying artifacts by content bought. The job
			// record therefore says "done" with the stage it was asked for and
			// nothing else, and that is honest rather than lossy.
			return Result{Stage: fmt.Sprint(stage)}, nil
		case state.Failed > 0:
			message := state.Message
			if message == "" {
				message = "the bake pod failed"
			}
			return Result{}, fmt.Errorf("bake job %s failed: %s", name, message)
		}

		phase := "pending"
		if state.Started && state.Active > 0 {
			phase = "running"
			// Only unstarted Jobs are given up on. Once a pod is running it may
			// take as long as a bake takes.
			giveUpUnstarted = time.Now().Add(schedulingDeadline)
		}
		if phase == "pending" && time.Now().After(giveUpUnstarted) {
			// The three real causes, named — because the Job's own status says
			// nothing useful in any of them, and the operator would otherwise
			// be looking at a stuck object with no hint where to start.
			return Result{}, fmt.Errorf("bake job %s started no pod within %s: no node may satisfy the "+
				"anti-affinity, admission (SCC, quota) refused the pod, or its image cannot be pulled — "+
				"`kubectl describe job %s` says which", name, schedulingDeadline, name)
		}
		if phase != reported {
			reported = phase
			onProgress(Progress{Phase: phase, Percent: 0})
		}
	}
}
