package jobs

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// Just enough Kubernetes to create a Job, watch it finish, and clean up.
//
// Hand-rolled against the REST API rather than through client-go, for the same
// reason this project reads world.yaml with thirty lines instead of a YAML
// dependency: the surface actually needed is three verbs on one resource
// type, and client-go would multiply a module that has two dependencies into
// one that has dozens. If that surface ever grows — watching pods, reading
// logs, custom resources — client-go is the honest upgrade, and this file is
// what gets deleted.
//
// It POLLS rather than watches. A watch is a chunked JSON stream with
// reconnect and resource-version semantics, and it is by far the fiddliest
// part of talking to the API. Against a job that runs for minutes, asking
// every couple of seconds is indistinguishable in behaviour and far harder to
// get wrong.

const (
	serviceAccountDir = "/var/run/secrets/kubernetes.io/serviceaccount"
	tokenFile         = serviceAccountDir + "/token"
	caFile            = serviceAccountDir + "/ca.crt"
	namespaceFile     = serviceAccountDir + "/namespace"
)

// InCluster reports whether this process is running inside a pod.
//
// Deliberately NOT "can a Kubernetes client be built": that succeeds on any
// developer machine holding a kubeconfig, and a laptop that starts creating
// Job objects is a worse outcome than an inconvenient one. Both the service
// account files AND the injected service env must be present, which together
// happen only in a pod (docs/decisions/distributed-bake.md).
func InCluster() bool {
	if os.Getenv("KUBERNETES_SERVICE_HOST") == "" || os.Getenv("KUBERNETES_SERVICE_PORT") == "" {
		return false
	}
	for _, path := range []string{tokenFile, caFile, namespaceFile} {
		if _, err := os.Stat(path); err != nil {
			return false
		}
	}
	return true
}

// clusterAPI is a minimal client for one namespace.
type clusterAPI struct {
	baseURL   string
	namespace string
	client    *http.Client
	// Read per request rather than cached: projected service account tokens
	// are rotated in place, and a long-lived server that captured one at
	// startup would begin failing hours later for no visible reason.
	tokenPath string
}

func newClusterAPI() (*clusterAPI, error) {
	host := os.Getenv("KUBERNETES_SERVICE_HOST")
	port := os.Getenv("KUBERNETES_SERVICE_PORT")
	if host == "" || port == "" {
		return nil, fmt.Errorf("not running in a cluster")
	}
	namespace, err := os.ReadFile(namespaceFile)
	if err != nil {
		return nil, fmt.Errorf("reading namespace: %w", err)
	}
	ca, err := os.ReadFile(caFile)
	if err != nil {
		return nil, fmt.Errorf("reading cluster CA: %w", err)
	}
	// IPv6 service hosts arrive bare, so they are bracketed here rather than
	// producing a URL that fails to parse at the first request.
	return clusterAPIFrom(fmt.Sprintf("https://%s:%s", bracketed(host), port), strings.TrimSpace(string(namespace)), ca, tokenFile)
}

// clusterAPIFrom builds the client from explicit values.
//
// Split out from newClusterAPI so the integration test can reach a real
// cluster through the SAME code — the auth header, the CA pool, the per-request
// token read. A test that talked to a proxy instead would exercise none of
// that, and those are exactly the parts that fail first in a new namespace.
func clusterAPIFrom(baseURL, namespace string, caPEM []byte, tokenPath string) (*clusterAPI, error) {
	if namespace == "" {
		return nil, fmt.Errorf("no namespace")
	}

	// A nil pool means the system trust store, and that is a real case rather
	// than a fallback: a cluster whose API server presents a publicly trusted
	// certificate has no CA to hand out, so its kubeconfig carries none. In a
	// pod there is always one — the service account mounts it — so this branch
	// belongs to reaching a cluster from outside.
	var pool *x509.CertPool
	if trimmed := bytes.TrimSpace(caPEM); len(trimmed) > 0 {
		pool = x509.NewCertPool()
		if !pool.AppendCertsFromPEM(trimmed) {
			// Distinguishing the failure modes matters more here than it looks:
			// an empty extraction and a corrupt file produce the same symptom,
			// and the fix for each is completely different.
			preview := string(trimmed)
			if len(preview) > 40 {
				preview = preview[:40] + "…"
			}
			return nil, fmt.Errorf("the cluster CA is %d bytes but holds no PEM certificate (starts %q) — "+
				"if it came from `certificate-authority-data`, check that key exists; some kubeconfigs use "+
				"`certificate-authority` (a file path) or none at all", len(trimmed), preview)
		}
	}

	return &clusterAPI{
		baseURL:   strings.TrimSuffix(baseURL, "/"),
		namespace: namespace,
		tokenPath: tokenPath,
		client: &http.Client{
			Timeout: 30 * time.Second,
			// RootCAs nil = the system pool.
			Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}},
		},
	}, nil
}

func bracketed(host string) string {
	if strings.Contains(host, ":") && !strings.HasPrefix(host, "[") {
		return "[" + host + "]"
	}
	return host
}

func (c *clusterAPI) do(ctx context.Context, method, path string, body []byte) ([]byte, int, error) {
	token, err := os.ReadFile(c.tokenPath)
	if err != nil {
		return nil, 0, fmt.Errorf("reading service account token: %w", err)
	}
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return nil, 0, err
	}
	request.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.client.Do(request)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = response.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	return raw, response.StatusCode, err
}

func (c *clusterAPI) jobsPath() string {
	return "/apis/batch/v1/namespaces/" + c.namespace + "/jobs"
}

// apiError turns the API's own Status object into something readable. Its
// `message` says things like "jobs.batch is forbidden: User cannot create
// resource" — infinitely more useful than the status code, and precisely what
// someone setting up RBAC needs to see.
func apiError(action string, status int, raw []byte) error {
	var parsed struct {
		Message string `json:"message"`
		Reason  string `json:"reason"`
	}
	if json.Unmarshal(raw, &parsed) == nil && parsed.Message != "" {
		return fmt.Errorf("%s: %s (%s)", action, parsed.Message, parsed.Reason)
	}
	return fmt.Errorf("%s: HTTP %d", action, status)
}

func (c *clusterAPI) createJob(ctx context.Context, manifest []byte) error {
	raw, status, err := c.do(ctx, http.MethodPost, c.jobsPath(), manifest)
	if err != nil {
		return err
	}
	if status != http.StatusCreated && status != http.StatusOK {
		return apiError("creating job", status, raw)
	}
	return nil
}

// jobState is the little of a Job's status this needs.
type jobState struct {
	Succeeded int
	Failed    int
	Active    int
	// Whether any pod has actually been scheduled. With honest memory
	// requests a Job beyond the cluster's free capacity sits unschedulable,
	// and reporting that as "running" would leave someone watching a
	// progress readout that cannot move (docs/decisions/distributed-bake.md).
	Started bool
	Message string
}

func (c *clusterAPI) jobStatus(ctx context.Context, name string) (jobState, error) {
	raw, status, err := c.do(ctx, http.MethodGet, c.jobsPath()+"/"+name, nil)
	if err != nil {
		return jobState{}, err
	}
	if status != http.StatusOK {
		return jobState{}, apiError("reading job", status, raw)
	}
	var parsed struct {
		Status struct {
			Succeeded  int    `json:"succeeded"`
			Failed     int    `json:"failed"`
			Active     int    `json:"active"`
			StartTime  string `json:"startTime"`
			Conditions []struct {
				Type    string `json:"type"`
				Status  string `json:"status"`
				Reason  string `json:"reason"`
				Message string `json:"message"`
			} `json:"conditions"`
		} `json:"status"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return jobState{}, fmt.Errorf("reading job: %w", err)
	}
	state := jobState{
		Succeeded: parsed.Status.Succeeded,
		Failed:    parsed.Status.Failed,
		Active:    parsed.Status.Active,
		Started:   parsed.Status.StartTime != "",
	}
	for _, condition := range parsed.Status.Conditions {
		if condition.Status == "True" && (condition.Type == "Failed" || condition.Type == "Complete") {
			state.Message = strings.TrimSpace(condition.Reason + " " + condition.Message)
		}
	}
	return state, nil
}

// jobSummary is the little of a listed Job the retention sweep needs.
type jobSummary struct {
	Name    string
	Created time.Time
	Failed  bool
}

// listJobs answers this namespace's bake Jobs, selected by the component
// label the template stamps on every one (job.yaml) — the same handle
// its topology spread keys off.
func (c *clusterAPI) listJobs(ctx context.Context) ([]jobSummary, error) {
	raw, status, err := c.do(ctx, http.MethodGet, c.jobsPath()+"?labelSelector="+url.QueryEscape("casas-eternas/component=job"), nil)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, apiError("listing jobs", status, raw)
	}
	var parsed struct {
		Items []struct {
			Metadata struct {
				Name              string    `json:"name"`
				CreationTimestamp time.Time `json:"creationTimestamp"`
			} `json:"metadata"`
			Status struct {
				Failed int `json:"failed"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("listing jobs: %w", err)
	}
	jobs := make([]jobSummary, 0, len(parsed.Items))
	for _, item := range parsed.Items {
		jobs = append(jobs, jobSummary{
			Name:    item.Metadata.Name,
			Created: item.Metadata.CreationTimestamp,
			Failed:  item.Status.Failed > 0,
		})
	}
	return jobs, nil
}

// deleteJob removes a Job and its pods. Foreground propagation so the pods go
// too — an orphaned bake pod still running would keep its 3Gi reservation
// for as long as it lives.
func (c *clusterAPI) deleteJob(ctx context.Context, name string) error {
	body, _ := json.Marshal(map[string]any{
		"apiVersion":        "meta/v1",
		"kind":              "DeleteOptions",
		"propagationPolicy": "Foreground",
	})
	raw, status, err := c.do(ctx, http.MethodDelete, c.jobsPath()+"/"+name, body)
	if err != nil {
		return err
	}
	if status != http.StatusOK && status != http.StatusAccepted && status != http.StatusNotFound {
		return apiError("deleting job", status, raw)
	}
	return nil
}

// The worker Deployment (deploy/manifests.yaml): found by its label, scaled
// through its scale subresource. Three more verbs on one more resource —
// still well inside what a hand-rolled client is for (see the top of this
// file).
const workerSelector = "casas-eternas/component=worker"

func (c *clusterAPI) deploymentsPath() string {
	return "/apis/apps/v1/namespaces/" + c.namespace + "/deployments"
}

// workerDeployments names the Deployments carrying the worker label.
func (c *clusterAPI) workerDeployments(ctx context.Context) ([]string, error) {
	raw, status, err := c.do(ctx, http.MethodGet, c.deploymentsPath()+"?labelSelector="+url.QueryEscape(workerSelector), nil)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, apiError("listing worker deployments", status, raw)
	}
	var parsed struct {
		Items []struct {
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
		} `json:"items"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("listing worker deployments: %w", err)
	}
	names := make([]string, 0, len(parsed.Items))
	for _, item := range parsed.Items {
		names = append(names, item.Metadata.Name)
	}
	return names, nil
}

// replicas answers how many replicas a Deployment is asked for.
func (c *clusterAPI) replicas(ctx context.Context, name string) (int, error) {
	raw, status, err := c.do(ctx, http.MethodGet, c.deploymentsPath()+"/"+name+"/scale", nil)
	if err != nil {
		return 0, err
	}
	if status != http.StatusOK {
		return 0, apiError("reading the worker scale", status, raw)
	}
	var parsed struct {
		Spec struct {
			Replicas int `json:"replicas"`
		} `json:"spec"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return 0, fmt.Errorf("reading the worker scale: %w", err)
	}
	return parsed.Spec.Replicas, nil
}

// scale sets a Deployment's replicas. A PUT of the whole Scale, without a
// resource version: the scaler is the one writer of this number, so there is
// no other change to lose.
func (c *clusterAPI) scale(ctx context.Context, name string, replicas int) error {
	body, _ := json.Marshal(map[string]any{
		"apiVersion": "autoscaling/v1",
		"kind":       "Scale",
		"metadata":   map[string]string{"name": name, "namespace": c.namespace},
		"spec":       map[string]int{"replicas": replicas},
	})
	raw, status, err := c.do(ctx, http.MethodPut, c.deploymentsPath()+"/"+name+"/scale", body)
	if err != nil {
		return err
	}
	if status != http.StatusOK {
		return apiError("scaling the workers", status, raw)
	}
	return nil
}
