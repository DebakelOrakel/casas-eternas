package cmd

import (
	"archive/zip"
	"bytes"
	"context"
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
	cfg.Auth.StateDir = t.TempDir()
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
// is selected, and a process without it runs WITHOUT auth.state-dir — that is
// the property that makes password mode splittable at all
// (docs/decisions/server-user-admin.md, step 3).
func TestLoginFollowsTheAuthTarget(t *testing.T) {
	// The auth target serves login. Seeded through the store itself — the
	// same door the admin surface uses — so the start is not the bootstrap
	// state.
	cfg := passwordConfig(t)
	seed, err := user.NewRegistry(cfg.Auth.StateDir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := seed.Create("ada", "Pw12345-geheim"); err != nil {
		t.Fatal(err)
	}
	if err := seed.Close(); err != nil {
		t.Fatal(err)
	}
	modules, _, _, err := buildModules(context.Background(), config.Targets{config.TargetAuth: true}, cfg)
	if err != nil {
		t.Fatalf("auth-only process: %v", err)
	}
	if names := moduleNames(modules); len(names) != 1 || names[0] != "auth" {
		t.Errorf("auth-only process mounts %v, want [auth]", names)
	}
	closeAll(t, modules)

	// A world-only process needs neither credentials nor auth.state-dir — it
	// verifies tokens locally and never opens the store.
	worldOnly := passwordConfig(t)
	worldOnly.Auth.StateDir = ""
	worldOnly.World.Storage = config.ObjectStorage{Type: "dir", Dir: &config.DirStorage{Path: t.TempDir()}}
	worldOnly.World.ReadLinkTTL = 15 * time.Minute
	modules, _, _, err = buildModules(context.Background(), config.Targets{config.TargetWorld: true}, worldOnly)
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
	_, _, _, err := buildModules(context.Background(), config.Targets{config.TargetAuth: true}, cfg)
	if err == nil {
		t.Fatal("a password server nobody could ever log in to started anyway")
	}
	if !strings.Contains(err.Error(), "nobody could ever log in") {
		t.Errorf("the refusal does not name the problem: %v", err)
	}

	withSocket := passwordConfig(t)
	withSocket.Global.Admin.Socket = filepath.Join(t.TempDir(), "admin.sock")
	modules, _, _, err := buildModules(context.Background(), config.Targets{config.TargetAuth: true}, withSocket)
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
	seed, err := user.NewRegistry(cfg.Auth.StateDir)
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
	modules, gate, _, err := buildModules(context.Background(), config.Targets{config.TargetAuth: true}, cfg)
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

// The gate lets the dir links of the world module through without
// credentials, and only those (DEC-0038, fork 5; the world's since
// 2026-10-16): a GET of the zip as ada answers 302 to a link under the
// world's namespace, the link answers the bytes to no one in particular,
// and a changed link meets the gate's 401. The artifact links keep passing
// beside them (one predicate per module, joined in buildModules).
func TestTheGateLetsTheWorldLinksThrough(t *testing.T) {
	cfg := passwordConfig(t)
	seed, err := user.NewRegistry(cfg.Auth.StateDir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := seed.Create("ada", "Pw12345-geheim"); err != nil {
		t.Fatal(err)
	}
	if err := seed.Close(); err != nil {
		t.Fatal(err)
	}
	cfg.World.Storage.Type = "dir"
	cfg.World.Storage.Dir = &config.DirStorage{Path: t.TempDir()}
	cfg.World.ReadLinkTTL = 15 * time.Minute
	cfg.World.KeepRevisions = 3
	modules, gate, _, err := buildModules(context.Background(), config.Targets{config.TargetAuth: true, config.TargetWorld: true}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer closeAll(t, modules)
	mux := http.NewServeMux()
	for _, m := range modules {
		if err := m.Mount(mux); err != nil {
			t.Fatal(err)
		}
	}
	handler := gate(mux)
	serve := func(method, target, bearer string, body []byte) *httptest.ResponseRecorder {
		var request *http.Request
		if body != nil {
			request = httptest.NewRequest(method, target, bytes.NewReader(body))
		} else {
			request = httptest.NewRequest(method, target, nil)
		}
		if bearer != "" {
			request.Header.Set("Authorization", "Bearer "+bearer)
		}
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		return recorder
	}
	login := httptest.NewRequest(http.MethodPost, auth.Path, nil)
	login.SetBasicAuth("ada", "Pw12345-geheim")
	session := httptest.NewRecorder()
	handler.ServeHTTP(session, login)
	var token struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(session.Body.Bytes(), &token); err != nil || token.Token == "" {
		t.Fatalf("login = %d %s", session.Code, session.Body)
	}

	const uid = "9f2c1b4e-7a30-4d55-8c11-2b6e5d0a1f83"
	var save bytes.Buffer
	zw := zip.NewWriter(&save)
	f, _ := zw.Create("world.yaml")
	_, _ = f.Write([]byte("apiVersion: casas-eternas/v1alpha1\nkind: FlatWorld\nmetadata:\n  name: alpha\n  uid: " + uid + "\n"))
	_ = zw.Close()
	if got := serve(http.MethodPut, "/v1/worlds/"+uid, token.Token, save.Bytes()); got.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", got.Code, got.Body)
	}
	redirect := serve(http.MethodGet, "/v1/worlds/"+uid, token.Token, nil)
	link := redirect.Header().Get("Location")
	if redirect.Code != http.StatusFound || !strings.HasPrefix(link, "/v1/worlds/"+uid+"/rev/1/world.zip?") {
		t.Fatalf("read = %d to %q, want 302 to the world's own link", redirect.Code, link)
	}
	if got := serve(http.MethodGet, link, "", nil); got.Code != http.StatusOK || !bytes.Equal(got.Body.Bytes(), save.Bytes()) {
		t.Errorf("the link without credentials = %d, %d bytes; want 200 with the save", got.Code, got.Body.Len())
	}
	// With the session's header too, as a browser sends it on a same-origin
	// redirect: the link decides, not the header.
	if got := serve(http.MethodGet, link, token.Token, nil); got.Code != http.StatusOK {
		t.Errorf("the link with credentials = %d, want 200", got.Code)
	}
	if got := serve(http.MethodGet, strings.Replace(link, "sig=", "sig=x", 1), "", nil); got.Code != http.StatusUnauthorized {
		t.Errorf("a changed link without credentials = %d, want the gate's 401", got.Code)
	}
	if got := serve(http.MethodGet, "/v1/worlds/"+uid, "", nil); got.Code != http.StatusUnauthorized {
		t.Errorf("the zip without credentials = %d, want 401", got.Code)
	}
}

// A peer that answers without the module refuses the start; one that does
// not answer yet does not, and is asked again until it does: the processes
// of a split start together, and two that waited for each other would never
// start (docs/decisions/helm-chart.md).
func TestCheckPeerStartsBeforeAPeerAnswers(t *testing.T) {
	peer := func(modules string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`{"modules":` + modules + `}`))
		}))
	}
	right := peer(`["world"]`)
	defer right.Close()
	if err := checkPeer(keySvcWorlds, right.URL, "world"); err != nil {
		t.Errorf("a peer with the module: %v", err)
	}
	wrong := peer(`["docs"]`)
	defer wrong.Close()
	if err := checkPeer(keySvcWorlds, wrong.URL, "world"); err == nil || !strings.Contains(err.Error(), keySvcWorlds) {
		t.Errorf("a peer without the module: err = %v, want the start refused naming the setting", err)
	}
	// A port nothing listens on: free one, then close it.
	silent := httptest.NewServer(http.NotFoundHandler())
	address := silent.URL
	silent.Close()
	peerRetryFirst, peerRetryMost = 10*time.Millisecond, 10*time.Millisecond
	if err := checkPeer(keySvcWorlds, address, "world"); err != nil {
		t.Errorf("a peer not answering yet: %v, want the start to go on", err)
	}
}

// A client in a process without the auth target still names the login in
// password mode: in a split the ingress sends /v1/auth to the process that
// runs it, on the client's own origin (docs/decisions/helm-chart.md).
func TestASplitClientNamesTheLogin(t *testing.T) {
	cfg := passwordConfig(t)
	cfg.Auth.StateDir = ""
	modules, _, _, err := buildModules(context.Background(), config.Targets{config.TargetClient: true}, cfg)
	if err != nil {
		t.Fatalf("client-only process: %v", err)
	}
	defer closeAll(t, modules)
	mux := http.NewServeMux()
	for _, m := range modules {
		if err := m.Mount(mux); err != nil {
			t.Fatal(err)
		}
	}
	answer := httptest.NewRecorder()
	mux.ServeHTTP(answer, httptest.NewRequest(http.MethodGet, "/config.json", nil))
	var body struct {
		Login *struct {
			Path string `json:"path"`
		} `json:"login"`
	}
	if err := json.Unmarshal(answer.Body.Bytes(), &body); err != nil {
		t.Fatalf("config.json: %v (%s)", err, answer.Body)
	}
	if body.Login == nil || body.Login.Path != auth.Path {
		t.Errorf("config.json login = %+v, want %s", body.Login, auth.Path)
	}
}
