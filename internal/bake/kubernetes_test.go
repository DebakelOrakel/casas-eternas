package bake

import (
	"encoding/json"
	"os"
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
// disappeared from the template, bakes would still run — and two would land on
// one node, or a finished Job would linger holding a reservation.
func TestTemplateKeepsTheRulesThatMatter(t *testing.T) {
	manifest := renderTemplate(t, testValues())
	spec := dig(t, manifest, "spec").(map[string]any)
	podSpec := dig(t, manifest, "spec", "template", "spec").(map[string]any)

	// Hard, not preferred: two 2.6 GB bakes must never share a node, and
	// "preferred" would let them under exactly the pressure that makes it hurt.
	affinity := dig(t, manifest, "spec", "template", "spec", "affinity", "podAntiAffinity").(map[string]any)
	if _, ok := affinity["requiredDuringSchedulingIgnoredDuringExecution"]; !ok {
		t.Error("anti-affinity is not required — two bakes could share a node")
	}
	if _, ok := affinity["preferredDuringSchedulingIgnoredDuringExecution"]; ok {
		t.Error("anti-affinity is merely preferred")
	}
	rule := affinity["requiredDuringSchedulingIgnoredDuringExecution"].([]any)[0].(map[string]any)
	if rule["topologyKey"] != "kubernetes.io/hostname" {
		t.Errorf("topologyKey = %v, want per-node", rule["topologyKey"])
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
	resources := container["resources"].(map[string]any)
	requests := resources["requests"].(map[string]any)
	if requests["memory"] != "3Gi" {
		t.Errorf("memory request = %v; it must be honest or the scheduler co-locates bakes", requests["memory"])
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
	// on any node, which is what makes the anti-affinity above workable.
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

func TestServerBaseURLUsesTheListenPort(t *testing.T) {
	t.Setenv("CASAS_POD_IP", "10.1.2.3")
	if got := serverBaseURL(":9090"); got != "http://10.1.2.3:9090/v1" {
		t.Errorf("serverBaseURL = %q", got)
	}
	if got := serverBaseURL("0.0.0.0:8080"); got != "http://10.1.2.3:8080/v1" {
		t.Errorf("serverBaseURL = %q", got)
	}
	// Without the downward API there is no address a Job could come back to,
	// and an empty string is what makes the runner refuse rather than create
	// Jobs that cannot reach anything.
	_ = os.Unsetenv("CASAS_POD_IP")
	if got := serverBaseURL(":8080"); got != "" {
		t.Errorf("serverBaseURL without POD_IP = %q, want empty", got)
	}
}
