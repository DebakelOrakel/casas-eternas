package jobs

import (
	"context"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// The scaler's rule: zero with nothing open; with work, the tasks up to the
// cap, at least one, and never below what already runs.
func TestWantWorkers(t *testing.T) {
	for _, c := range []struct {
		name                      string
		open, tasks, current, max int
		want                      int
	}{
		{"nothing open, workers left over", 0, 0, 3, 4, 0},
		{"nothing open, none running", 0, 0, 0, 4, 0},
		{"level 1: one task, one worker", 1, 1, 0, 4, 1},
		{"tiles beyond the cap", 1, 900, 1, 4, 4},
		{"between levels: nothing handed out yet", 1, 0, 0, 4, 1},
		{"fewer tasks than workers: keep them", 1, 2, 4, 4, 4},
		{"a cap lowered under running workers: keep them", 2, 10, 6, 4, 6},
	} {
		if got := wantWorkers(c.open, c.tasks, c.current, c.max); got != c.want {
			t.Errorf("%s: wantWorkers(%d, %d, %d, %d) = %d, want %d", c.name, c.open, c.tasks, c.current, c.max, got, c.want)
		}
	}
}

// One step against a stand-in API server: the Deployment is found by its
// label, read through its scale subresource and set through it — with the
// service account's token, and never touched when it is already right.
func TestScalerStepSetsTheWorkerDeployment(t *testing.T) {
	var (
		replicas = 0
		puts     []int
		bearer   string
	)
	api := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		bearer = r.Header.Get("Authorization")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/apis/apps/v1/namespaces/ns/deployments":
			if r.URL.Query().Get("labelSelector") != workerSelector {
				t.Errorf("listed with selector %q", r.URL.Query().Get("labelSelector"))
			}
			_, _ = io.WriteString(w, `{"items":[{"metadata":{"name":"casas-eternas-worker"}}]}`)
		case r.Method == http.MethodGet && r.URL.Path == "/apis/apps/v1/namespaces/ns/deployments/casas-eternas-worker/scale":
			fmt.Fprintf(w, `{"spec":{"replicas":%d}}`, replicas)
		case r.Method == http.MethodPut && r.URL.Path == "/apis/apps/v1/namespaces/ns/deployments/casas-eternas-worker/scale":
			var body struct {
				Kind string `json:"kind"`
				Spec struct {
					Replicas int `json:"replicas"`
				} `json:"spec"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body.Kind != "Scale" {
				t.Errorf("PUT a %q", body.Kind)
			}
			replicas = body.Spec.Replicas
			puts = append(puts, replicas)
			_, _ = io.WriteString(w, `{}`)
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer api.Close()
	ca := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: api.Certificate().Raw})
	tokenPath := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenPath, []byte("sa-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	client, err := clusterAPIFrom(api.URL, "ns", ca, tokenPath)
	if err != nil {
		t.Fatal(err)
	}
	open, tasks := 1, 900
	scaler := &workerScaler{api: client, workload: func() (int, int) { return open, tasks }, max: 3}
	ctx := context.Background()

	scaler.step(ctx) // tiles waiting: up to the cap
	scaler.step(ctx) // already right: no write
	open, tasks = 0, 0
	scaler.step(ctx) // everything through: down to zero
	if want := []int{3, 0}; !slices.Equal(puts, want) {
		t.Errorf("scaled to %v, want %v", puts, want)
	}
	if bearer != "Bearer sa-token" {
		t.Errorf("authorised as %q", bearer)
	}
}
