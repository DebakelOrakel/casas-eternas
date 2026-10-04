package cmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/config"
	"github.com/DebakelOrakel/casas-eternas/internal/modules/auth"
	"github.com/DebakelOrakel/casas-eternas/internal/server"
	"github.com/DebakelOrakel/casas-eternas/internal/user"
)

// passwordConfig is the smallest tree a password-mode process accepts.
func passwordConfig(t *testing.T) config.Config {
	t.Helper()
	var cfg config.Config
	cfg.Global.Listen = ":0"
	cfg.Global.Auth.Mode = string(config.AuthPassword)
	cfg.Global.Auth.TokenTTL = time.Hour
	cfg.Global.Auth.SessionTTL = 24 * time.Hour
	cfg.Auth.Storage = config.Storage{Dir: &config.DirStorage{Path: t.TempDir()}}
	return cfg
}

func closeAll(t *testing.T, modules []server.Module) {
	t.Helper()
	for _, m := range modules {
		if err := m.Close(); err != nil {
			t.Errorf("closing %s: %v", m.Name(), err)
		}
	}
}

func moduleNames(modules []server.Module) []string {
	names := make([]string, 0, len(modules))
	for _, m := range modules {
		names = append(names, m.Name())
	}
	return names
}

// Login is the auth TARGET's job: the module appears exactly when the target
// is selected, and a process without it runs WITHOUT auth.storage — that is
// the property that makes password mode splittable at all
// (docs/decisions/server-user-admin.md, step 3).
func TestLoginFollowsTheAuthTarget(t *testing.T) {
	// The auth target serves login. Seeded through the store itself — the
	// same door the admin surface uses — so the start is not the bootstrap
	// state.
	cfg := passwordConfig(t)
	seed, err := user.NewRegistry(cfg.Auth.Storage.DirPath())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := seed.Create("ada", "Pw12345-geheim"); err != nil {
		t.Fatal(err)
	}
	if err := seed.Close(); err != nil {
		t.Fatal(err)
	}
	modules, _, err := buildModules(config.Targets{config.TargetAuth: true}, cfg)
	if err != nil {
		t.Fatalf("auth-only process: %v", err)
	}
	if names := moduleNames(modules); len(names) != 1 || names[0] != "auth" {
		t.Errorf("auth-only process mounts %v, want [auth]", names)
	}
	closeAll(t, modules)

	// A world-only process needs neither credentials nor auth.storage — it
	// verifies tokens locally and never opens the store.
	worldOnly := passwordConfig(t)
	worldOnly.Auth.Storage = config.Storage{}
	worldOnly.World.Storage = config.Storage{Dir: &config.DirStorage{Path: t.TempDir()}}
	modules, _, err = buildModules(config.Targets{config.TargetWorld: true}, worldOnly)
	if err != nil {
		t.Fatalf("world-only process: %v", err)
	}
	for _, name := range moduleNames(modules) {
		if name == "auth" {
			t.Error("a world-only process mounted the login module")
		}
	}
	closeAll(t, modules)
}

// An empty credential store is the BOOTSTRAP state when an admin socket can
// still create the first user, and a dead end when nothing can: the second
// must stop the start, the first must not.
func TestEmptyCredentialStoreNeedsABootstrapPath(t *testing.T) {
	cfg := passwordConfig(t)
	_, _, err := buildModules(config.Targets{config.TargetAuth: true}, cfg)
	if err == nil {
		t.Fatal("a password server nobody could ever log in to started anyway")
	}
	if !strings.Contains(err.Error(), "nobody could ever log in") {
		t.Errorf("the refusal does not name the problem: %v", err)
	}

	withSocket := passwordConfig(t)
	withSocket.Global.Admin.Socket = filepath.Join(t.TempDir(), "admin.sock")
	modules, _, err := buildModules(config.Targets{config.TargetAuth: true}, withSocket)
	if err != nil {
		t.Fatalf("an empty store with an admin socket refused to start: %v", err)
	}
	closeAll(t, modules)
}

// Moved here with the function (2026-08-12): the address a bake Job comes
// back to is composition, not bake mechanics.
func TestServerBaseURLUsesTheListenPort(t *testing.T) {
	t.Setenv("CASAS_POD_IP", "10.1.2.3")
	if got := serverBaseURL(":9090"); got != "http://10.1.2.3:9090/v1" {
		t.Errorf("serverBaseURL = %q", got)
	}
	if got := serverBaseURL("0.0.0.0:8080"); got != "http://10.1.2.3:8080/v1" {
		t.Errorf("serverBaseURL = %q", got)
	}
	// Without the downward API there is no address a Job could come back to,
	// and an empty string is what makes the composition refuse rather than
	// create Jobs that cannot reach anything.
	_ = os.Unsetenv("CASAS_POD_IP")
	if got := serverBaseURL(":8080"); got != "" {
		t.Errorf("serverBaseURL without POD_IP = %q, want empty", got)
	}
}

// A worker trades its service account for a bus token before it holds any
// token at all, so the token route must be on the public surface — behind
// the gate, the trade was refused for want of the very token it buys.
func TestServiceTokenRouteIsPublic(t *testing.T) {
	cfg := passwordConfig(t)
	seed, err := user.NewRegistry(cfg.Auth.Storage.DirPath())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := seed.Create("ada", "Pw12345-geheim"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := seed.CreateService("workers"); err != nil {
		t.Fatal(err)
	}
	if err := seed.Close(); err != nil {
		t.Fatal(err)
	}
	modules, gate, err := buildModules(config.Targets{config.TargetAuth: true}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer closeAll(t, modules)
	mux := http.NewServeMux()
	admin := http.NewServeMux()
	for _, m := range modules {
		if err := m.Mount(mux); err != nil {
			t.Fatal(err)
		}
		if a, ok := m.(server.AdminModule); ok {
			if err := a.MountAdmin(admin); err != nil {
				t.Fatal(err)
			}
		}
	}
	// The secret is shown once at creation; rotate for one this test knows.
	rotated := httptest.NewRecorder()
	admin.ServeHTTP(rotated, httptest.NewRequest(http.MethodPost, auth.ServicesPath+"/workers/rotate", nil))
	var account auth.CreatedService
	if err := json.Unmarshal(rotated.Body.Bytes(), &account); err != nil || account.Secret == "" {
		t.Fatalf("rotate: %d %s", rotated.Code, rotated.Body)
	}

	request := httptest.NewRequest(http.MethodPost, auth.TokenPath, nil)
	request.SetBasicAuth("workers", account.Secret)
	recorder := httptest.NewRecorder()
	gate(mux).ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Errorf("the token route behind the gate = %d, want 200: %s", recorder.Code, recorder.Body)
	}
}
