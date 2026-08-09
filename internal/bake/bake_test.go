package bake

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/auth"
	"github.com/DebakelOrakel/casas-eternas/internal/config"
	"github.com/DebakelOrakel/casas-eternas/internal/identity"
)

// A runner that records what it was asked to do and finishes when told. Lets
// the queue and the authorisation be tested without a Node process or a
// seven-minute wait.
type fakeRunner struct {
	mu      sync.Mutex
	running int32
	peak    int32
	started int32
	release chan struct{}
}

func newFakeRunner() *fakeRunner { return &fakeRunner{release: make(chan struct{})} }

func (f *fakeRunner) Run(ctx context.Context, spec Spec, onProgress func(Progress)) (Result, error) {
	atomic.AddInt32(&f.started, 1)
	now := atomic.AddInt32(&f.running, 1)
	f.mu.Lock()
	if now > f.peak {
		f.peak = now
	}
	f.mu.Unlock()
	defer atomic.AddInt32(&f.running, -1)

	onProgress(Progress{Phase: "erosion", Percent: 50})
	select {
	case <-f.release:
	case <-ctx.Done():
	case <-time.After(5 * time.Second):
	}
	return Result{WorldID: "w", PipelineVersion: "v", Stage: "2", Width: 4096, Height: 2048}, nil
}

// newTestModule builds a module around the fake runner, skipping New (which
// insists on a real baker bundle).
func newTestModule(t *testing.T, mode config.AuthMode, workers int) (*Module, *fakeRunner, string) {
	t.Helper()
	return newTestModuleWith(t, identity.NewResolver(mode, nil), workers)
}

// newTestModuleWith takes the resolver directly, for the tests that need one
// which can actually verify a token.
func newTestModuleWith(t *testing.T, caller *identity.Resolver, workers int) (*Module, *fakeRunner, string) {
	t.Helper()
	dir := t.TempDir()
	runner := newFakeRunner()
	ctx, cancel := context.WithCancel(context.Background())
	m := &Module{
		cfg:    Config{WorldsDir: dir, ArtifactsDir: t.TempDir(), Identity: caller, MaxConcurrent: workers},
		runner: runner,
		jobs:   newRegistry(jobHistory),
		queue:  make(chan string, 64),
		cancel: cancel,
	}
	for range workers {
		m.workers.Add(1)
		go m.work(ctx)
	}
	t.Cleanup(func() { _ = m.Close() })
	return m, runner, dir
}

// writeWorld lays down the little of the world store's layout this module reads.
func writeWorld(t *testing.T, dir, uid, owner string) {
	t.Helper()
	revDir := filepath.Join(dir, uid, "rev", "1")
	if err := os.MkdirAll(revDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(revDir, "world.zip"), []byte("pretend"), 0o644); err != nil {
		t.Fatal(err)
	}
	meta := map[string]any{"uid": uid, "owner": owner, "revision": 1}
	raw, _ := json.Marshal(meta)
	if err := os.WriteFile(filepath.Join(dir, uid, "meta.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
}

func post(m *Module, uid, body, token string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, "/v1/worlds/"+uid+"/bake", strings.NewReader(body))
	request.SetPathValue("uid", uid)
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	recorder := httptest.NewRecorder()
	m.handleEnqueue(recorder, request)
	return recorder
}

const testUID = "9f2c1b4e-7a30-4d55-8c11-2b6e5d0a1f83"

// `none` is the LOCAL mode by definition: a person on their own machine, with
// nobody to be protected from. Every request passes, and the check still runs.
func TestLocalModeLetsEveryoneBake(t *testing.T) {
	m, _, dir := newTestModule(t, config.AuthNone, 1)
	writeWorld(t, dir, testUID, identity.Local)

	if got := post(m, testUID, `{"stage":2}`, "").Code; got != http.StatusAccepted {
		t.Errorf("anonymous local request = %d, want 202", got)
	}
	// Even a world owned by somebody else: in this mode there is no somebody
	// else, and inventing one would only be a lie with a stack trace.
	writeWorld(t, dir, testUID, "someone-far-away")
	if got := post(m, testUID, `{"stage":2}`, "").Code; got != http.StatusAccepted {
		t.Errorf("foreign-owned world in local mode = %d, want 202", got)
	}
}

// The rule the whole check exists for, and the one that would be silently
// inverted by a wrong comparison.
func TestOwnershipIsEnforcedWhenIdentityIsChecked(t *testing.T) {
	tokens, err := auth.NewTokens([]byte("a signing key long enough to be accepted"))
	if err != nil {
		t.Fatalf("NewTokens: %v", err)
	}
	m, _, dir := newTestModuleWith(t, identity.NewResolver(config.AuthPassword, tokens), 1)
	writeWorld(t, dir, testUID, "ada")

	issue := func(subject, audience string) string {
		t.Helper()
		token, _, issueErr := tokens.Issue(subject, audience, time.Hour)
		if issueErr != nil {
			t.Fatalf("Issue: %v", issueErr)
		}
		return token
	}

	// Everything that is not a verifiable token for the OWNER must be refused,
	// and all of it identically — an unverifiable token is worth exactly as much
	// as none at all, never a fallback to some weaker identity.
	for _, c := range []struct{ name, token string }{
		{"no credentials", ""},
		{"nonsense", "not-a-valid-token"},
		{"someone else's session", issue("grace", auth.AudienceSession)},
		// The audience split, from the other side: a token that this server
		// really did issue, for the very artifact key this bake would write,
		// still is not a login.
		{"a bake token", issue("ada", auth.BakeAudience("v4-abc"))},
	} {
		if got := post(m, testUID, `{"stage":2}`, c.token).Code; got != http.StatusForbidden {
			t.Errorf("%s = %d, want 403", c.name, got)
		}
	}

	// And the owner's own session does open it — the case that proves the four
	// above are refused for the right reason and not because nothing works.
	if got := post(m, testUID, `{"stage":2}`, issue("ada", auth.AudienceSession)).Code; got == http.StatusForbidden {
		t.Error("the owner's own session was refused")
	}

	// The unit underneath, where the decision actually lives: a wrong operator
	// here is the difference between "only the owner" and "anyone but".
	cases := []struct {
		caller, owner string
		want          bool
	}{
		{"ada", "ada", true},
		{"ada", "grace", false},
		{identity.Anonymous, "", false}, // both empty must NOT match
		{identity.Anonymous, "ada", false},
		{"ada", "", false},
	}
	for _, c := range cases {
		if got := m.canBake(c.caller, c.owner); got != c.want {
			t.Errorf("canBake(%q, %q) = %v, want %v", c.caller, c.owner, got, c.want)
		}
	}
}

// A refusal must not double as a denial that the world exists.
func TestRefusalDistinguishesMissingFromForbidden(t *testing.T) {
	m, _, dir := newTestModule(t, config.AuthPassword, 1)
	writeWorld(t, dir, testUID, "ada")

	if got := post(m, testUID, `{"stage":2}`, "").Code; got != http.StatusForbidden {
		t.Errorf("existing world, wrong caller = %d, want 403", got)
	}
	absent := "11111111-2222-4333-8444-555555555555"
	if got := post(m, absent, `{"stage":2}`, "").Code; got != http.StatusNotFound {
		t.Errorf("absent world = %d, want 404", got)
	}
}

func TestRequestsAreValidatedBeforeQueueing(t *testing.T) {
	m, runner, dir := newTestModule(t, config.AuthNone, 1)
	writeWorld(t, dir, testUID, identity.Local)

	for _, body := range []string{`{"stage":3}`, `{"stage":0}`, `{"scope":{"kind":"basin"},"stage":2}`, `not json`} {
		if got := post(m, testUID, body, "").Code; got != http.StatusBadRequest {
			t.Errorf("body %q = %d, want 400", body, got)
		}
	}
	if started := atomic.LoadInt32(&runner.started); started != 0 {
		t.Errorf("%d jobs reached the runner despite being invalid", started)
	}

	// Omitting the rounds must mean the default, never zero — a bake with no
	// rounds produces a world with no carved valleys, which looks broken.
	recorder := post(m, testUID, `{"stage":2}`, "")
	var job Job
	if err := json.Unmarshal(recorder.Body.Bytes(), &job); err != nil {
		t.Fatal(err)
	}
	if job.Request.ErosionRounds != defaultErosionRounds {
		t.Errorf("erosionRounds = %d, want %d", job.Request.ErosionRounds, defaultErosionRounds)
	}
	if job.Request.Scope.Kind != ScopeWorld {
		t.Errorf("scope = %q, want %q", job.Request.Scope.Kind, ScopeWorld)
	}
}

// The cap is a memory argument — two 8k bakes want 5 GB — so it has to hold
// under a burst, not merely be configured.
func TestConcurrencyIsCapped(t *testing.T) {
	const cap = 2
	m, runner, dir := newTestModule(t, config.AuthNone, cap)
	writeWorld(t, dir, testUID, identity.Local)

	for i := 0; i < 6; i++ {
		if got := post(m, testUID, `{"stage":2}`, "").Code; got != http.StatusAccepted {
			t.Fatalf("request %d = %d, want 202", i, got)
		}
	}
	// Let the workers pick up and block in the fake runner.
	deadline := time.Now().Add(2 * time.Second)
	for atomic.LoadInt32(&runner.running) < cap && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond) // give any extra worker a chance to misbehave

	runner.mu.Lock()
	peak := runner.peak
	runner.mu.Unlock()
	if peak > cap {
		t.Errorf("%d bakes ran at once, cap is %d", peak, cap)
	}
	if peak < cap {
		t.Errorf("only %d ran at once; the pool is not using its %d workers", peak, cap)
	}
	close(runner.release)
}

func TestProgressAndResultReachTheJobRecord(t *testing.T) {
	m, runner, dir := newTestModule(t, config.AuthNone, 1)
	writeWorld(t, dir, testUID, identity.Local)

	recorder := post(m, testUID, `{"stage":2}`, "")
	var job Job
	_ = json.Unmarshal(recorder.Body.Bytes(), &job)

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if current, _ := m.jobs.get(job.ID); current.Percent == 50 && current.Phase == "erosion" {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	current, _ := m.jobs.get(job.ID)
	if current.Phase != "erosion" || current.Percent != 50 {
		t.Errorf("progress not recorded: %+v", current)
	}
	if current.State != StateRunning {
		t.Errorf("state = %q, want running", current.State)
	}

	close(runner.release)
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if done, _ := m.jobs.get(job.ID); done.State == StateDone {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	done, _ := m.jobs.get(job.ID)
	if done.State != StateDone || done.Result == nil || done.Percent != 100 {
		t.Errorf("finished job = %+v", done)
	}
}

// Spec is marshalled straight into the baker's argv, so its JSON field names
// are a contract with client/scripts/bake.ts. A rename on either side would
// otherwise surface as a bake that reads nothing and writes nowhere — with no
// error, because the baker's own fields would simply be undefined.
func TestSpecWireFormatMatchesTheBaker(t *testing.T) {
	local, err := json.Marshal(Spec{Stage: 2, ErosionRounds: 2, WorldZip: "/w.zip", ArtifactsDir: "/art"})
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{`"stage":2`, `"erosionRounds":2`, `"worldZip":"/w.zip"`, `"artifactsDir":"/art"`} {
		if !strings.Contains(string(local), key) {
			t.Errorf("local spec is missing %s: %s", key, local)
		}
	}
	// The path form must not carry empty URL fields: the baker picks its store
	// by which one is present, so an empty string would be an ambiguous job.
	for _, key := range []string{"worldUrl", "artifactsUrl", "authToken"} {
		if strings.Contains(string(local), key) {
			t.Errorf("local spec should omit %s: %s", key, local)
		}
	}

	remote, _ := json.Marshal(Spec{Stage: 4, ErosionRounds: 2, WorldURL: "http://s/v1/worlds/x", ArtifactsURL: "http://s/v1", AuthToken: "t"})
	for _, key := range []string{`"worldUrl":"http://s/v1/worlds/x"`, `"artifactsUrl":"http://s/v1"`, `"authToken":"t"`} {
		if !strings.Contains(string(remote), key) {
			t.Errorf("remote spec is missing %s: %s", key, remote)
		}
	}
	for _, key := range []string{"worldZip", "artifactsDir"} {
		if strings.Contains(string(remote), key) {
			t.Errorf("remote spec should omit %s: %s", key, remote)
		}
	}
}
