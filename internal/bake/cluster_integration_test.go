package bake

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Against a REAL cluster. Skipped unless told where one is, so it is silent in
// CI and on any machine that has not opted in.
//
//	CASAS_K8S_SERVER=https://api.example:6443 \
//	CASAS_K8S_TOKEN=<service account token> \
//	CASAS_K8S_CA=/path/to/ca.crt \
//	CASAS_K8S_NAMESPACE=<namespace> \
//	go test ./internal/bake/ -run Cluster -v
//
// Optional: CASAS_K8S_IMAGE=<a pullable image> turns on the part that waits
// for a pod to actually run. Without it the test still does the valuable half
// — see below.
//
// This deliberately does NOT go through a `kubectl proxy`. The proxy would
// handle authentication for us, and authentication and the CA pool are exactly
// what fails first in a new namespace; a test that skipped them would pass
// while the deployment could not talk to anything.
//
// It is also NOT an escape hatch for running cluster mode locally. Production
// still reaches NewKubernetesRunner only through InCluster(), which needs the
// service account files a pod has and a laptop does not
// (docs/decisions/distributed-bake.md).

func clusterForTest(t *testing.T) (*clusterAPI, string) {
	t.Helper()
	server := os.Getenv("CASAS_K8S_SERVER")
	token := os.Getenv("CASAS_K8S_TOKEN")
	namespace := os.Getenv("CASAS_K8S_NAMESPACE")
	if server == "" || token == "" || namespace == "" {
		t.Skip("set CASAS_K8S_SERVER, _TOKEN and _NAMESPACE to run against a cluster")
	}

	// CASAS_K8S_CA is OPTIONAL: a cluster whose API server has a publicly
	// trusted certificate has no CA to extract, and its kubeconfig carries
	// none. Empty means the system trust store.
	var ca []byte
	if caPath := os.Getenv("CASAS_K8S_CA"); caPath != "" {
		var err error
		ca, err = os.ReadFile(caPath)
		if err != nil {
			t.Fatalf("reading CASAS_K8S_CA: %v", err)
		}
		if len(ca) == 0 {
			t.Fatalf("CASAS_K8S_CA points at an empty file (%s) — either fill it or unset the variable", caPath)
		}
	}
	// Written to a file because production re-reads the token per request —
	// projected tokens rotate — and the test should exercise that path rather
	// than a shortcut around it.
	tokenPath := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenPath, []byte(token), 0o600); err != nil {
		t.Fatal(err)
	}

	api, err := clusterAPIFrom(server, namespace, ca, tokenPath)
	if err != nil {
		t.Fatalf("building the cluster client: %v", err)
	}
	return api, namespace
}

func runnerForTest(t *testing.T, api *clusterAPI, image string) *kubernetesRunner {
	t.Helper()
	runner, err := NewKubernetesRunner(image)
	if err == nil {
		// Only reachable if the machine really is a pod; take the API we built
		// from the environment either way, so the target is the test's cluster.
		concrete := runner.(*kubernetesRunner)
		concrete.api = api
		return concrete
	}
	// The normal case: not in a pod, so the constructor refused. Build the
	// same object directly — every field is the one production would have.
	parsed, perr := templateFor(defaultJobTemplate)
	if perr != nil {
		t.Fatalf("template: %v", perr)
	}
	return &kubernetesRunner{
		api: api, template: parsed, image: image,
		memoryRequest: "64Mi", memoryLimit: "128Mi", // tiny: this must schedule anywhere
	}
}

// waitGone blocks until a job is really deleted. Deletion is asynchronous, and
// creating the same name a moment later would otherwise race the collector.
func waitGone(t *testing.T, ctx context.Context, api *clusterAPI, name string) {
	t.Helper()
	for i := 0; i < 30; i++ {
		if _, err := api.jobStatus(ctx, name); err != nil {
			return
		}
		time.Sleep(time.Second)
	}
	t.Fatalf("%s did not go away; remove it by hand", name)
}

// The half that needs no working image, and the one worth the most: does the
// API server ACCEPT the manifest this template produces? A field it rejects —
// a typo, a moved key, an apiVersion that has aged out — is invisible until
// something real tries it, and unit tests cannot see it at all.
func TestClusterAcceptsTheJobTemplate(t *testing.T) {
	api, namespace := clusterForTest(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	runner := runnerForTest(t, api, "registry.example/does-not-need-to-exist:test")
	// A fixed name, not a random one: a run that dies mid-test leaves an
	// object behind, and a findable one can be removed by hand.
	jobID := "itest-template"
	name := jobName(jobID)
	// …which means a previous run may still own it. Removed first, so the test
	// is re-runnable rather than failing with "already exists".
	_ = api.deleteJob(ctx, name)
	waitGone(t, ctx, api, name)

	args, _ := json.Marshal([]string{`{"stage":2,"erosionRounds":2,"worldUrl":"http://x/v1/worlds/y","artifactsUrl":"http://x/v1"}`})
	manifest, err := runner.render(name, jobID, string(args))
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	t.Logf("posting to %s, namespace %s", api.baseURL, namespace)

	if err := api.createJob(ctx, manifest); err != nil {
		// The API's own message is the point of surfacing it: "jobs.batch is
		// forbidden" means RBAC, a validation message names the offending
		// field. Either is actionable; a status code is not.
		t.Fatalf("the cluster refused the job: %v", err)
	}
	// Always, even on a failing assertion below: a pod stuck pulling an image
	// that does not exist still holds its reservation.
	defer func() {
		cleanup, cancelCleanup := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancelCleanup()
		if err := api.deleteJob(cleanup, name); err != nil {
			t.Errorf("could not clean up %s: %v", name, err)
		}
	}()

	// Creating the Job is only half the question. A pod is admitted SEPARATELY,
	// after the Job controller makes it — so an SCC that refuses this security
	// context, or a spent quota, shows up here and nowhere in the create call.
	// And it does not increment `failed`: the Job just never progresses.
	//
	// So: wait for a pod to actually exist. With an unpullable image it will
	// sit in ImagePullBackOff, which is fine — that still proves it was
	// admitted and scheduled, which is what is under test.
	deadline := time.Now().Add(90 * time.Second)
	var state jobState
	for time.Now().Before(deadline) {
		var err error
		state, err = api.jobStatus(ctx, name)
		if err != nil {
			t.Fatalf("reading the job back: %v", err)
		}
		if state.Started || state.Active > 0 || state.Failed > 0 {
			break
		}
		time.Sleep(2 * time.Second)
	}
	t.Logf("job %s: active=%d succeeded=%d failed=%d started=%v", name, state.Active, state.Succeeded, state.Failed, state.Started)
	if state.Succeeded > 0 {
		t.Errorf("a job with an unpullable image reported success")
	}
	if !state.Started && state.Active == 0 {
		t.Errorf("no pod appeared within 90s — the Job was accepted but its POD was not. "+
			"Run `kubectl describe job %s -n %s` and look at the events: an SCC refusing the "+
			"security context or a spent quota both look exactly like this", name, namespace)
	}
}

// Reading a job that is not there must be an error rather than a zero value —
// otherwise a mistyped name would look like a job that has not started yet,
// and the runner would poll it forever.
func TestClusterReportsAMissingJob(t *testing.T) {
	api, _ := clusterForTest(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if _, err := api.jobStatus(ctx, "casas-bake-definitely-not-there"); err == nil {
		t.Error("reading an absent job returned no error")
	} else {
		t.Logf("absent job reports: %v", err)
	}
	// Deleting something absent is fine: the caller wanted it gone, and it is.
	if err := api.deleteJob(ctx, "casas-bake-definitely-not-there"); err != nil {
		t.Errorf("deleting an absent job: %v", err)
	}
}

// The whole path, only when the real image is available. `--version` rather
// than a bake: what is under test is the runner's create → poll → finish →
// clean up, plus the fact that this IMAGE contains a working baker at all. The
// pipeline has its own proof elsewhere, and a real bake would need a world on
// a reachable server.
//
// It also answers the question that bit once already — does this image's
// pipeline version match what a client will look for — which is why the
// version is logged rather than merely exercised.
func TestClusterRunsAJobToCompletion(t *testing.T) {
	api, _ := clusterForTest(t)
	image := os.Getenv("CASAS_K8S_IMAGE")
	if image == "" {
		t.Skip("set CASAS_K8S_IMAGE to a pullable image to run this")
	}
	// Generous, because a cluster that autoscales may have to provision a node
	// first — measured on APPUiO, that alone can outlast a tighter budget, and
	// a test failing on infrastructure latency teaches nothing.
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()

	runner := runnerForTest(t, api, image)
	jobID := "itest-run"
	name := jobName(jobID)
	_ = api.deleteJob(ctx, name)
	waitGone(t, ctx, api, name)
	defer func() {
		cleanup, cancelCleanup := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancelCleanup()
		_ = api.deleteJob(cleanup, name)
	}()

	// Exits immediately, and prints which pipeline the image carries. Rendered
	// through the REAL template, so the scheduling rules under test are the
	// ones production uses.
	manifest, err := runner.render(name, jobID, `["--version"]`)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if err := api.createJob(ctx, manifest); err != nil {
		t.Fatalf("create: %v", err)
	}

	var phases []string
	last := ""
	begun := time.Now()
	deadline := time.Now().Add(14 * time.Minute)
	for time.Now().Before(deadline) {
		state, err := api.jobStatus(ctx, name)
		if err != nil {
			t.Fatalf("status: %v", err)
		}
		phase := "pending"
		switch {
		case state.Succeeded > 0:
			phase = "succeeded"
		case state.Failed > 0:
			phase = "failed"
		case state.Started && state.Active > 0:
			phase = "running"
		}
		if phase != last {
			phases = append(phases, phase)
			last = phase
			t.Logf("  %s (after %s)", phase, time.Since(begun).Round(time.Second))
		}
		if phase == "succeeded" || phase == "failed" {
			break
		}
		time.Sleep(pollInterval)
	}
	t.Logf("phases seen: %v", phases)
	if last != "succeeded" {
		t.Errorf("job ended as %q, want succeeded — `kubectl logs job/%s` says why", last, name)
	}
	t.Logf("read the image's pipeline version with: kubectl logs job/%s", name)
	// The distinction the anti-affinity makes routine: a job must be seen
	// waiting before it is seen working, never reported as running while it
	// has no node.
	if len(phases) > 0 && phases[0] != "pending" {
		t.Errorf("first observed phase was %q; a job is pending before it runs", phases[0])
	}
}
