package server

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/DebakelOrakel/casas-eternas/internal/config"
)

// adminModule mounts one admin route beside no network routes at all.
type adminModule struct{}

func (adminModule) Name() string                   { return "fake" }
func (adminModule) Mount(mux *http.ServeMux) error { return nil }
func (adminModule) Close() error                   { return nil }
func (adminModule) MountAdmin(mux *http.ServeMux) error {
	mux.HandleFunc("GET /v1/fake/ping", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("pong"))
	})
	return nil
}

// An unmatched path answers with the targets that DO run here — the reply
// for an exec into the wrong pod, where a bare 404 would read as a broken
// CLI rather than a mis-aimed one.
func TestAdminHandlerAnswersResidentTargets(t *testing.T) {
	handler, err := AdminHandler([]Module{adminModule{}}, []string{"fake"})
	if err != nil {
		t.Fatal(err)
	}

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v1/fake/ping", nil))
	if recorder.Code != http.StatusOK || recorder.Body.String() != "pong" {
		t.Fatalf("admin route = %d %q", recorder.Code, recorder.Body)
	}

	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v1/auth/users", nil))
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("unmatched admin path = %d, want 404", recorder.Code)
	}
	var body struct {
		Targets []string `json:"targets"`
	}
	if err := json.NewDecoder(recorder.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if len(body.Targets) != 1 || body.Targets[0] != "fake" {
		t.Errorf("targets = %v, want [fake]", body.Targets)
	}
}

// The socket end to end: bound, narrowed to 0600, answering, and gone after
// shutdown — the file permissions ARE the access control, so the mode is the
// one assertion here that guards a security property.
func TestServeAdminBindsANarrowedSocket(t *testing.T) {
	// Short directory, not t.TempDir(): a unix socket path is capped around
	// 104 bytes on darwin, which a nested test path can blow through.
	dir, err := os.MkdirTemp("", "adm")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	socket := filepath.Join(dir, "admin.sock")

	// A stale file from a dead process must not refuse the bind.
	if err := os.WriteFile(socket, nil, 0o600); err != nil {
		t.Fatal(err)
	}

	serveErr := make(chan error, 1)
	shutdown, err := serveAdmin(config.Server{AdminSocket: socket}, []Module{adminModule{}}, []string{"fake"}, serveErr)
	if err != nil {
		t.Fatal(err)
	}
	if shutdown == nil {
		t.Fatal("no shutdown for a configured socket")
	}

	info, err := os.Stat(socket)
	if err != nil {
		t.Fatal(err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Errorf("socket mode = %o, want 600", mode)
	}

	client := http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", socket)
		},
	}}
	resp, err := client.Get("http://admin/v1/fake/ping")
	if err != nil {
		t.Fatalf("dialling the socket: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || string(body) != "pong" {
		t.Errorf("over the socket: %d %q", resp.StatusCode, body)
	}

	if err := shutdown(context.Background()); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
	if _, err := os.Stat(socket); !os.IsNotExist(err) {
		t.Error("the socket file outlived the server")
	}
	select {
	case err := <-serveErr:
		t.Errorf("serve reported: %v", err)
	default:
	}
}

// No socket configured, no socket served — and no error inventing one.
func TestServeAdminIsOptional(t *testing.T) {
	shutdown, err := serveAdmin(config.Server{}, nil, nil, nil)
	if err != nil {
		t.Errorf("unconfigured socket errored: %v", err)
	}
	if shutdown != nil {
		t.Error("unconfigured socket produced a shutdown")
	}
}
