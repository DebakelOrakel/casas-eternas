package bake

import (
	"encoding/json"
	"strings"
	"testing"
	"text/template"
)

// renderTemplate exercises the real embedded template without needing a
// cluster — which matters, because a mistake in it would otherwise surface as
// an API rejection minutes into a deployment.
func renderTemplate(t *testing.T, values map[string]string) map[string]any {
	t.Helper()
	parsed, err := template.New("bake-job").Parse(defaultJobTemplate)
	if err != nil {
		t.Fatalf("the embedded template does not parse: %v", err)
	}
	runner := &kubernetesRunner{
		api:           &clusterAPI{namespace: values["Namespace"]},
		template:      parsed,
		image:         values["Image"],
		memoryRequest: "3Gi",
		memoryLimit:   "4Gi",
	}
	raw, err := runner.render(values["Name"], values["JobID"], values["Args"])
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	var manifest map[string]any
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatalf("rendered manifest is not JSON: %v", err)
	}
	return manifest
}

func testValues() map[string]string {
	args, _ := json.Marshal([]string{`{"stage":4,"worldUrl":"http://10.1.2.3:8080/v1/worlds/x"}`})
	return map[string]string{
		"Name": "casas-bake-abc123", "Namespace": "worlds", "JobID": "abc123",
		"Image": "ghcr.io/x/casas-eternas:latest", "Args": string(args),
	}
}

func dig(t *testing.T, root map[string]any, path ...string) any {
	t.Helper()
	var current any = root
	for _, step := range path {
		object, ok := current.(map[string]any)
		if !ok {
			t.Fatalf("path %v: %q is not an object", path, step)
		}
		current, ok = object[step]
		if !ok {
			t.Fatalf("path %v: no %q", path, step)
		}
	}
	return current
}

func TestTemplateRendersAValidJob(t *testing.T) {
	manifest := renderTemplate(t, testValues())

	if manifest["apiVersion"] != "batch/v1" || manifest["kind"] != "Job" {
		t.Errorf("apiVersion/kind = %v/%v", manifest["apiVersion"], manifest["kind"])
	}
	if got := dig(t, manifest, "metadata", "name"); got != "casas-bake-abc123" {
		t.Errorf("name = %v", got)
	}
	if got := dig(t, manifest, "metadata", "namespace"); got != "worlds" {
		t.Errorf("namespace = %v", got)
	}
	container := dig(t, manifest, "spec", "template", "spec", "containers").([]any)[0].(map[string]any)
	if container["image"] != "ghcr.io/x/casas-eternas:latest" {
		t.Errorf("image = %v", container["image"])
	}

	// The job payload must arrive as ONE argument. YAML would happily turn a
	// badly quoted value into several, and the baker would then parse the first
	// fragment as its whole job.
	args, ok := container["args"].([]any)
	if !ok || len(args) != 1 {
		t.Fatalf("args = %#v, want exactly one element", container["args"])
	}
	var job map[string]any
	if err := json.Unmarshal([]byte(args[0].(string)), &job); err != nil {
		t.Fatalf("the single argument is not the job JSON: %v", err)
	}
	if job["stage"] != float64(4) {
		t.Errorf("job payload did not survive templating: %v", job)
	}
}

// The rules that exist for a measured reason. If any of these silently
// disappeared from the template, bakes would still run — and overcommit a
// node, or a finished Job would linger holding a reservation.
func TestTemplateKeepsTheRulesThatMatter(t *testing.T) {
	manifest := renderTemplate(t, testValues())
	spec := dig(t, manifest, "spec").(map[string]any)
	podSpec := dig(t, manifest, "spec", "template", "spec").(map[string]any)

	// A PREFERENCE, deliberately (2026-08-13, replacing a hard one-per-node
	// anti-affinity): spreading must never block a node that genuinely has
	// room — the honest memory request below is the law, this only keeps
	// the load even. ScheduleAnyway is the whole point; DoNotSchedule would
	// be the old hard rule wearing new syntax.
	if _, ok := podSpec["affinity"]; ok {
		t.Error("the template grew an affinity back — capacity belongs to the requests, spreading to the constraint below")
	}
	constraint := dig(t, manifest, "spec", "template", "spec").(map[string]any)["topologySpreadConstraints"].([]any)[0].(map[string]any)
	if constraint["topologyKey"] != "kubernetes.io/hostname" {
		t.Errorf("topologyKey = %v, want per-node", constraint["topologyKey"])
	}
	if constraint["whenUnsatisfiable"] != "ScheduleAnyway" {
		t.Errorf("whenUnsatisfiable = %v — anything harder re-blocks nodes that have room", constraint["whenUnsatisfiable"])
	}
	if constraint["maxSkew"] != float64(1) {
		t.Errorf("maxSkew = %v, want 1 (empty nodes first)", constraint["maxSkew"])
	}

	// Retries belong to the server, not the cluster: a bake that failed for a
	// real reason fails again identically, six minutes at a time.
	if spec["backoffLimit"] != float64(0) {
		t.Errorf("backoffLimit = %v, want 0", spec["backoffLimit"])
	}
	if _, ok := spec["ttlSecondsAfterFinished"]; !ok {
		t.Error("no ttlSecondsAfterFinished — finished Jobs would accumulate")
	}
	if podSpec["restartPolicy"] != "Never" {
		t.Errorf("restartPolicy = %v", podSpec["restartPolicy"])
	}

	container := podSpec["containers"].([]any)[0].(map[string]any)

	// The baker MUST be the same commit as the server that commissioned it: the
	// artifact key carries a pipeline version, so an older baker files its work
	// under a key nobody looks for, reports success, and nothing appears.
	//
	// IfNotPresent defeats that with a moving tag — a node holding some :latest
	// never fetches another — which is how a cluster bake ran an old baker on
	// 2026-08-09 and reported no progress.
	if container["imagePullPolicy"] != "Always" {
		t.Errorf("imagePullPolicy = %v, want Always — a stale baker fails silently", container["imagePullPolicy"])
	}

	resources := container["resources"].(map[string]any)
	requests := resources["requests"].(map[string]any)
	if requests["memory"] != "3Gi" {
		t.Errorf("memory request = %v; it is the ONLY per-node limit — dishonest means overcommitted nodes", requests["memory"])
	}
	// Memory is capped, CPU deliberately is not — CFS throttling is exactly
	// wrong for a six-minute burst.
	limits := resources["limits"].(map[string]any)
	if _, ok := limits["memory"]; !ok {
		t.Error("no memory limit")
	}
	if _, ok := limits["cpu"]; ok {
		t.Error("a CPU limit would throttle the bake through CFS")
	}

	// The Job mounts no persistent volume: that is what lets it be scheduled
	// on any node, which is what leaves placement to the scheduler at all.
	for _, volume := range podSpec["volumes"].([]any) {
		if _, ok := volume.(map[string]any)["persistentVolumeClaim"]; ok {
			t.Error("the bake Job claims a PVC; it cannot then be scheduled freely")
		}
	}
}

// Detection is strictly the in-cluster token, never a kubeconfig: a laptop
// that starts creating Job objects is worse than an inconvenient one.
func TestInClusterNeedsBothEnvAndFiles(t *testing.T) {
	if InCluster() {
		t.Skip("this test machine looks like a pod")
	}
	t.Setenv("KUBERNETES_SERVICE_HOST", "10.0.0.1")
	t.Setenv("KUBERNETES_SERVICE_PORT", "443")
	if InCluster() {
		t.Error("env alone was accepted as being in a cluster")
	}
	if _, err := newClusterAPI(); err == nil {
		t.Error("a cluster client was built without the service account files")
	}
}

func TestJobNameIsAValidObjectName(t *testing.T) {
	// Kubernetes object names are DNS-1123: lowercase alphanumerics and
	// dashes, starting with a letter. A bare hex id beginning with a digit
	// would be rejected at creation, minutes after the request.
	for _, id := range []string{"abc123", "0f9e8d7c6b5a4321", "FFFF"} {
		name := jobName(id)
		if !strings.HasPrefix(name, "casas-bake-") {
			t.Errorf("jobName(%q) = %q", id, name)
		}
		if name != strings.ToLower(name) {
			t.Errorf("jobName(%q) = %q is not lowercase", id, name)
		}
		if len(name) > 63 {
			t.Errorf("jobName(%q) is %d chars, over the 63 limit", id, len(name))
		}
	}
}
