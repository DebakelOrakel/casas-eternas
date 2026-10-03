package jobs

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	natsserver "github.com/nats-io/nats-server/v2/server"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/DebakelOrakel/casas-eternas/internal/access"
	"github.com/DebakelOrakel/casas-eternas/internal/config"
	"github.com/DebakelOrakel/casas-eternas/internal/identity"
	"github.com/DebakelOrakel/casas-eternas/internal/relay"
	"github.com/DebakelOrakel/casas-eternas/internal/token"
)

// A worker on the test relay that records the task it was handed, reports
// progress, and finishes when told. It takes one task at a time (the
// consumer's MaxAckPending), so a second job stays queued while the first
// is held. Lets the routes and the authorisation be tested without a Node
// process or a seven-minute wait.
type heldWorker struct {
	mu      sync.Mutex
	started int32
	once    sync.Once
	hold    chan struct{}
	// The last spec handed over, so a test can inspect what the module decided
	// to send rather than only what came back. `gotSpec` is separate because no
	// FIELD of a spec is reliably non-empty.
	lastSpec Spec
	gotSpec  bool
}

// release lets every held task, and every later one, finish.
func (f *heldWorker) release() { f.once.Do(func() { close(f.hold) }) }

// awaitSpec waits for the coordinator to hand the worker a task, and returns it.
func (f *heldWorker) awaitSpec(t *testing.T) Spec {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		f.mu.Lock()
		spec, got := f.lastSpec, f.gotSpec
		f.mu.Unlock()
		if got {
			return spec
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("the worker was never given a task")
	return Spec{}
}

// startHeldWorker serves the tasks on the relay until the test ends.
func startHeldWorker(t *testing.T, server *natsserver.Server) *heldWorker {
	t.Helper()
	conn, err := relay.Connect("jobs", server, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	consumer, err := conn.JetStream().CreateOrUpdateConsumer(ctx, conn.StreamName(streamTasks), jetstream.ConsumerConfig{Durable: "held", AckPolicy: jetstream.AckExplicitPolicy, MaxAckPending: 1})
	if err != nil {
		t.Fatal(err)
	}
	f := &heldWorker{hold: make(chan struct{})}
	consume, err := consumer.Consume(func(msg jetstream.Msg) {
		var spec Spec
		_ = json.Unmarshal(msg.Data(), &spec)
		f.mu.Lock()
		f.lastSpec, f.gotSpec = spec, true
		f.mu.Unlock()
		atomic.AddInt32(&f.started, 1)
		event, _ := json.Marshal(taskEvent{TaskID: spec.TaskID, Phase: "erosion", Percent: 50})
		_ = conn.NATS().Publish(conn.Subject("event", spec.JobID), event)
		go func() {
			select {
			case <-f.hold:
			case <-ctx.Done():
				return
			}
			report, _ := json.Marshal(taskDoneReport{TaskID: spec.TaskID, OK: true, Result: &Result{WorldID: "w", PipelineVersion: "v", Stage: "L1"}})
			if _, err := conn.JetStream().Publish(ctx, conn.Subject("done", spec.TaskID), report); err == nil {
				_ = msg.Ack()
			}
		}()
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		consume.Stop()
		cancel()
		conn.Close()
	})
	return f
}

// fakeWorlds stands in for the ranking closure cmd/ builds over the world
// module — since 2026-08-12 this module never touches the store's layout or
// its grants itself, so its tests do not either. Levels are keyed by the
// BEARER the enqueue forwards, which is exactly the contract: identity
// travels in the header, the ranking answers a level.
type fakeWorlds struct {
	mu     sync.Mutex
	levels map[string]map[string]access.Level // uid -> bearer -> level
}

func (f *fakeWorlds) set(uid, bearer string, level access.Level) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.levels[uid] == nil {
		f.levels[uid] = map[string]access.Level{}
	}
	f.levels[uid][bearer] = level
}

func (f *fakeWorlds) rank(_ context.Context, uid, bearer string) (bool, access.Level) {
	f.mu.Lock()
	defer f.mu.Unlock()
	byBearer, ok := f.levels[uid]
	if !ok {
		return false, access.None
	}
	return true, byBearer[bearer]
}

func (f *fakeWorlds) zip(ctx context.Context, uid string) (string, bool) {
	if exists, _ := f.rank(ctx, uid, ""); !exists {
		return "", false
	}
	return "/fake/" + uid + "/world.zip", true
}

// newTestModule builds a module around a coordinator on a test relay and a
// held worker, skipping New (which insists on a real worker bundle).
func newTestModule(t *testing.T, mode config.AuthMode) (*Module, *heldWorker, *fakeWorlds) {
	t.Helper()
	return newTestModuleWith(t, identity.NewResolver(mode, nil))
}

// newTestModuleWith takes the resolver directly, for the tests that need one
// which can actually verify a token.
func newTestModuleWith(t *testing.T, caller *identity.Resolver) (*Module, *heldWorker, *fakeWorlds) {
	t.Helper()
	server, conn := coordinatorRelay(t)
	worlds := &fakeWorlds{levels: map[string]map[string]access.Level{}}
	ctx, cancel := context.WithCancel(context.Background())
	m := &Module{
		cfg: Config{
			WorldAccess:   worlds.rank,
			WorldZip:      worlds.zip,
			ArtifactsDir:  t.TempDir(),
			Identity:      caller,
			MaxConcurrent: 1,
			Relay:         conn,
			StorageDir:    t.TempDir(),
		},
		jobs:     newRegistry(jobHistory),
		shutdown: ctx,
		cancel:   cancel,
		slots:    1,
	}
	var err error
	m.coord, err = newCoordinator(m.cfg.StorageDir, conn, m.jobs, m.buildSpec)
	if err != nil {
		t.Fatal(err)
	}
	worker := startHeldWorker(t, server)
	t.Cleanup(func() { _ = m.Close() })
	t.Cleanup(worker.release)
	return m, worker, worlds
}

// writeWorld registers a world whose EDITOR is the given bearer — the level
// the ranking answers for whoever presents it. The empty bearer covers the
// local mode's unauthenticated requests.
func writeWorld(t *testing.T, worlds *fakeWorlds, uid string, editorBearers ...string) {
	t.Helper()
	if len(editorBearers) == 0 {
		editorBearers = []string{""}
	}
	for _, bearer := range editorBearers {
		worlds.set(uid, bearer, access.Editor)
	}
}

// post commissions a bake for uid. The uid is spliced into the JSON body —
// since 2026-08-12 it travels there, not in the path — so the tests keep
// stating bodies as the fields they are actually about.
func post(m *Module, uid, body, token string) *httptest.ResponseRecorder {
	if strings.HasPrefix(body, "{") {
		body = `{"worldUid":"` + uid + `",` + body[1:]
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/jobs", strings.NewReader(body))
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	recorder := httptest.NewRecorder()
	m.handleEnqueue(recorder, request)
	return recorder
}

const testUID = "9f2c1b4e-7a30-4d55-8c11-2b6e5d0a1f83"

// `none` is the LOCAL mode by definition: a person on their own machine, with
// nobody to be protected from. The module still asks the ranking — the short
// circuit (everything ranks admin there) lives in cmd/'s closure, which is
// what the fake stands in for.
func TestLocalModeLetsEveryoneBake(t *testing.T) {
	m, _, worlds := newTestModule(t, config.AuthNone)
	writeWorld(t, worlds, testUID)

	if got := post(m, testUID, `{"stage":1}`, "").Code; got != http.StatusAccepted {
		t.Errorf("anonymous local request = %d, want 202", got)
	}
}

// An enqueue arriving once Close has begun must be REFUSED, not crash the
// process.
func TestEnqueueAfterCloseAnswers503(t *testing.T) {
	m, _, worlds := newTestModule(t, config.AuthNone)
	writeWorld(t, worlds, testUID)
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}
	if got := post(m, testUID, `{"stage":1}`, "").Code; got != http.StatusServiceUnavailable {
		t.Errorf("enqueue after Close = %d, want 503", got)
	}
}

// The rule the whole check exists for: editor and up commission bakes, and
// the refusal SHAPE follows the visibility rule — below viewer the world is
// invisible (404), only a readable world distinguishes 403.
func TestLevelsAreEnforcedWhenIdentityIsChecked(t *testing.T) {
	tokens, err := token.NewTokens([]byte("a signing key long enough to be accepted"))
	if err != nil {
		t.Fatalf("NewTokens: %v", err)
	}
	m, _, worlds := newTestModuleWith(t, identity.NewResolver(config.AuthPassword, tokens))

	issue := func(subject, audience string) string {
		t.Helper()
		token, _, issueErr := tokens.Issue(subject, audience, time.Hour)
		if issueErr != nil {
			t.Fatalf("Issue: %v", issueErr)
		}
		return token
	}
	editor := issue("ada", token.AudienceSession)
	viewer := issue("grace", token.AudienceSession)
	worlds.set(testUID, "Bearer "+editor, access.Editor)
	worlds.set(testUID, "Bearer "+viewer, access.Viewer)

	// Below viewer the world does not exist for you — including a bake
	// token, which is what keeps a leaked job token from ordering more
	// bakes: it ranks as nobody.
	for _, c := range []struct{ name, token string }{
		{"no credentials", ""},
		{"nonsense", "not-a-valid-token"},
		{"a stranger's session", issue("eve", token.AudienceSession)},
		{"a bake token", issue("ada", token.JobAudience("v4-abc"))},
	} {
		if got := post(m, testUID, `{"stage":1}`, c.token).Code; got != http.StatusNotFound {
			t.Errorf("%s = %d, want 404", c.name, got)
		}
	}

	// A viewer SEES the world, so the refusal may honestly say "not yours
	// to bake".
	if got := post(m, testUID, `{"stage":1}`, viewer).Code; got != http.StatusForbidden {
		t.Errorf("viewer = %d, want 403", got)
	}
	// And an editor bakes — the case that proves the refusals above refuse
	// for the right reason.
	if got := post(m, testUID, `{"stage":1}`, editor).Code; got != http.StatusAccepted {
		t.Errorf("editor = %d, want 202", got)
	}
}

// An absent world and an invisible one answer identically — that equality
// IS the privacy property, so it is asserted rather than assumed.
func TestHiddenAndMissingAreIndistinguishable(t *testing.T) {
	m, _, worlds := newTestModule(t, config.AuthPassword)
	worlds.set(testUID, "Bearer someone-elses", access.Editor)

	hidden := post(m, testUID, `{"stage":1}`, "").Code
	absent := post(m, "11111111-2222-4333-8444-555555555555", `{"stage":1}`, "").Code
	if hidden != http.StatusNotFound || absent != http.StatusNotFound {
		t.Errorf("hidden = %d, absent = %d, want 404 for both", hidden, absent)
	}
}

func TestRequestsAreValidatedBeforeQueueing(t *testing.T) {
	m, runner, worlds := newTestModule(t, config.AuthNone)
	writeWorld(t, worlds, testUID)

	for _, body := range []string{`{"stage":2}`, `{"stage":0}`, `{"stage":4,"plan":"refine"}`, `{"stage":0,"plan":"refine"}`, `{"scope":{"kind":"basin"},"stage":1}`, `not json`} {
		if got := post(m, testUID, body, "").Code; got != http.StatusBadRequest {
			t.Errorf("body %q = %d, want 400", body, got)
		}
	}
	time.Sleep(50 * time.Millisecond) // give a wrongly queued task the time to arrive
	if started := atomic.LoadInt32(&runner.started); started != 0 {
		t.Errorf("%d jobs reached a worker despite being invalid", started)
	}

	// Omitting the rounds must mean the default, never zero — a bake with no
	// rounds produces a world with no carved valleys, which looks broken.
	recorder := post(m, testUID, `{"stage":1}`, "")
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

func TestProgressAndResultReachTheJobRecord(t *testing.T) {
	m, runner, worlds := newTestModule(t, config.AuthNone)
	writeWorld(t, worlds, testUID)

	recorder := post(m, testUID, `{"stage":1}`, "")
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

	runner.release()
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

// A job that reaches its stores over HTTP — every worker in a cluster —
// carries a token of its own, and only that: the job is not a login and
// not its orderer, and the token names the one world it may touch.
func TestRemoteJobCarriesAScopedToken(t *testing.T) {
	tokens, err := token.NewTokens([]byte("a signing key long enough to be accepted"))
	if err != nil {
		t.Fatalf("NewTokens: %v", err)
	}
	m, runner, worlds := newTestModuleWith(t, identity.NewResolver(config.AuthNone, nil))
	m.cfg.Tokens = tokens
	// The cluster shape, as cmd/ composes it: URLs everywhere, no file paths.
	m.cfg.WorldZip = nil
	m.cfg.WorldsURL = "http://server:8080/v1"
	m.cfg.ArtifactsDir = ""
	m.cfg.ArtifactsURL = "http://server:8080/v1"
	writeWorld(t, worlds, testUID)

	if code := post(m, testUID, `{"stage":1}`, "").Code; code != http.StatusAccepted {
		t.Fatalf("bake request = %d, want 202", code)
	}
	spec := runner.awaitSpec(t)

	if spec.AuthToken == "" {
		t.Fatal("a remote job was sent out with no token")
	}
	subject, jobID, world, err := tokens.VerifyJob(spec.AuthToken)
	if err != nil {
		t.Fatalf("the job's token does not verify: %v", err)
	}
	if subject != token.SubjectJob {
		t.Errorf("token subject = %q, want %q — a job must not borrow its orderer's identity", subject, token.SubjectJob)
	}
	if jobs := m.jobs.list(); len(jobs) != 1 || jobs[0].ID != jobID {
		t.Errorf("the token names job %q, not the one ordered", jobID)
	}
	if world != testUID {
		t.Errorf("job token world claim = %q, want %q", world, testUID)
	}
	if _, err := tokens.Verify(spec.AuthToken, token.AudienceSession); err == nil {
		t.Error("a job token was accepted as a session")
	}
}

// A local worker reads files directly, so a token would be a credential handed
// out for nothing.
func TestLocalJobCarriesNoToken(t *testing.T) {
	tokens, err := token.NewTokens([]byte("a signing key long enough to be accepted"))
	if err != nil {
		t.Fatalf("NewTokens: %v", err)
	}
	m, runner, worlds := newTestModuleWith(t, identity.NewResolver(config.AuthNone, nil))
	m.cfg.Tokens = tokens
	writeWorld(t, worlds, testUID)

	if code := post(m, testUID, `{"stage":1}`, "").Code; code != http.StatusAccepted {
		t.Fatalf("bake request = %d, want 202", code)
	}
	if spec := runner.awaitSpec(t); spec.AuthToken != "" {
		t.Error("a local job was given a token it has no use for")
	}
}

// The half-and-half composition A3 exists for: a local worker beside the
// artifact store whose worlds live in another process. The spec must mix a
// world URL with an artifacts directory and carry a token for the remote
// read.
func TestRemoteWorldsMixWithLocalArtifacts(t *testing.T) {
	tokens, err := token.NewTokens([]byte("a signing key long enough to be accepted"))
	if err != nil {
		t.Fatalf("NewTokens: %v", err)
	}
	m, runner, worlds := newTestModuleWith(t, identity.NewResolver(config.AuthNone, nil))
	m.cfg.Tokens = tokens
	m.cfg.WorldZip = nil
	m.cfg.WorldsURL = "http://worlds:8080/v1"
	writeWorld(t, worlds, testUID)

	if code := post(m, testUID, `{"stage":1}`, "").Code; code != http.StatusAccepted {
		t.Fatalf("bake request = %d, want 202", code)
	}
	spec := runner.awaitSpec(t)
	if spec.WorldURL != "http://worlds:8080/v1/worlds/"+testUID {
		t.Errorf("worldUrl = %q", spec.WorldURL)
	}
	if spec.WorldZip != "" {
		t.Errorf("a remote-worlds spec must not carry a zip path, got %q", spec.WorldZip)
	}
	if spec.ArtifactsDir == "" || spec.ArtifactsURL != "" {
		t.Errorf("artifacts should stay local: dir=%q url=%q", spec.ArtifactsDir, spec.ArtifactsURL)
	}
	if spec.AuthToken == "" {
		t.Error("reading a remote world needs a credential, none was issued")
	}
}

// Spec is marshalled straight into the task message, so its JSON field names
// are a contract with client/scripts/jobWorker.ts. A rename on either side
// would otherwise surface as a task that reads nothing and writes nowhere —
// with no error, because the worker's own fields would simply be undefined.
func TestSpecWireFormatMatchesTheBaker(t *testing.T) {
	local, err := json.Marshal(Spec{Stage: 1, ErosionRounds: 2, WorldZip: "/w.zip", ArtifactsDir: "/art"})
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{`"stage":1`, `"erosionRounds":2`, `"worldZip":"/w.zip"`, `"artifactsDir":"/art"`} {
		if !strings.Contains(string(local), key) {
			t.Errorf("local spec is missing %s: %s", key, local)
		}
	}
	// The path form must not carry empty URL fields: the worker picks its store
	// by which one is present, so an empty string would be an ambiguous job.
	for _, key := range []string{"worldUrl", "artifactsUrl", "authToken", "jobId"} {
		if strings.Contains(string(local), key) {
			t.Errorf("local spec should omit %s: %s", key, local)
		}
	}

	remote, _ := json.Marshal(Spec{Stage: 1, ErosionRounds: 2, WorldURL: "http://s/v1/worlds/x", ArtifactsURL: "http://s/v1", AuthToken: "t", JobID: "j1"})
	for _, key := range []string{`"worldUrl":"http://s/v1/worlds/x"`, `"artifactsUrl":"http://s/v1"`, `"authToken":"t"`, `"jobId":"j1"`} {
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

// A tile job (stage 2) names its tile in a tile scope; the whole world is
// stage 1. The spec hands the tile to the worker as {"x", "y"} — the field
// client/scripts/jobWorker.ts reads — and the stage name is the artifact's.
func TestTileJobsNameTheirTile(t *testing.T) {
	cases := []struct {
		request Request
		ok      bool
	}{
		{Request{WorldUID: "w", Stage: 1, Scope: Scope{Kind: ScopeWorld}}, true},
		{Request{WorldUID: "w", Stage: 2, Scope: Scope{Kind: ScopeTile, X: 3, Y: 0}}, true},
		{Request{WorldUID: "w", Stage: 2, Scope: Scope{Kind: ScopeWorld}}, false},
		{Request{WorldUID: "w", Stage: 1, Scope: Scope{Kind: ScopeTile}}, false},
		{Request{WorldUID: "w", Stage: 2, Scope: Scope{Kind: ScopeTile, X: -1}}, false},
	}
	for _, c := range cases {
		if err := c.request.Validate(); (err == nil) != c.ok {
			t.Errorf("Validate(%+v) = %v, want ok=%v", c.request, err, c.ok)
		}
	}
	tile := Request{WorldUID: "w", Stage: 2, Scope: Scope{Kind: ScopeTile, X: 3, Y: 0}}
	if got := tile.StageName(); got != "L2:3,0" {
		t.Errorf("tile stage = %q, want L2:3,0", got)
	}
	if got := (Request{Stage: 1}).StageName(); got != "L1" {
		t.Errorf("level stage = %q, want L1", got)
	}
	wire, _ := json.Marshal(Spec{Stage: 2, ErosionRounds: 2, Tile: &TileRef{X: 3, Y: 0}, StageName: "L2:3,0"})
	if !strings.Contains(string(wire), `"tile":{"x":3,"y":0}`) {
		t.Errorf("spec does not carry the tile as the worker reads it: %s", wire)
	}
	if strings.Contains(string(wire), "L2:3,0") {
		t.Errorf("the stage name is the coordinator's, not the worker's: %s", wire)
	}
}

// Jobs show to whoever may read their world, say what the caller may do, and
// an editor cancels them — a queued one before it starts, a running one
// while a worker holds it (2026-09-29; before, every caller saw every job).
func TestJobsShowAndCancelByWorldAccess(t *testing.T) {
	tokens, err := token.NewTokens([]byte("a signing key long enough to be accepted"))
	if err != nil {
		t.Fatalf("NewTokens: %v", err)
	}
	m, runner, worlds := newTestModuleWith(t, identity.NewResolver(config.AuthPassword, tokens))
	mux := http.NewServeMux()
	if err := m.Mount(mux); err != nil {
		t.Fatal(err)
	}
	issue := func(subject string) string {
		t.Helper()
		tok, _, issueErr := tokens.Issue(subject, token.AudienceSession, time.Hour)
		if issueErr != nil {
			t.Fatalf("Issue: %v", issueErr)
		}
		return tok
	}
	editor, viewer, stranger := issue("ada"), issue("grace"), issue("eve")
	worlds.set(testUID, "Bearer "+editor, access.Editor)
	worlds.set(testUID, "Bearer "+viewer, access.Viewer)
	do := func(method, path, tok string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(method, path, nil)
		request.Header.Set("Authorization", "Bearer "+tok)
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, request)
		return recorder
	}
	idOf := func(recorder *httptest.ResponseRecorder) string {
		var job Job
		_ = json.Unmarshal(recorder.Body.Bytes(), &job)
		return job.ID
	}
	running := idOf(post(m, testUID, `{"stage":1}`, editor))
	queued := idOf(post(m, testUID, `{"stage":1}`, editor))
	stateOf := func(id string) State {
		job, _ := m.jobs.get(id)
		return job.State
	}
	deadline := time.Now().Add(3 * time.Second)
	for stateOf(running) != StateRunning && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}

	if body := do(http.MethodGet, "/v1/jobs", stranger).Body.String(); strings.TrimSpace(body) != "[]" {
		t.Errorf("a stranger's list = %s, want []", body)
	}
	if body := do(http.MethodGet, "/v1/jobs", viewer).Body.String(); strings.Count(body, `"callerLevel":"viewer"`) != 2 {
		t.Errorf("the viewer's list = %s, want both jobs as viewer", body)
	}
	if got := do(http.MethodGet, "/v1/jobs/"+running, stranger).Code; got != http.StatusNotFound {
		t.Errorf("a stranger's get = %d, want 404", got)
	}

	if got := do(http.MethodDelete, "/v1/jobs/"+queued, stranger).Code; got != http.StatusNotFound {
		t.Errorf("a stranger's cancel = %d, want 404", got)
	}
	if got := do(http.MethodDelete, "/v1/jobs/"+queued, viewer).Code; got != http.StatusForbidden {
		t.Errorf("a viewer's cancel = %d, want 403", got)
	}
	if got := do(http.MethodDelete, "/v1/jobs/"+queued, editor).Code; got != http.StatusNoContent {
		t.Errorf("cancelling the queued job = %d, want 204", got)
	}
	if got := stateOf(queued); got != StateCancelled {
		t.Errorf("the queued job is %s, want cancelled", got)
	}
	if got := do(http.MethodDelete, "/v1/jobs/"+running, editor).Code; got != http.StatusNoContent {
		t.Errorf("cancelling the running job = %d, want 204", got)
	}
	deadline = time.Now().Add(3 * time.Second)
	for stateOf(running) != StateCancelled && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if got := stateOf(running); got != StateCancelled {
		t.Errorf("the running job is %s, want cancelled", got)
	}
	if got := do(http.MethodDelete, "/v1/jobs/"+running, editor).Code; got != http.StatusConflict {
		t.Errorf("cancelling an ended job = %d, want 409", got)
	}
	if n := atomic.LoadInt32(&runner.started); n != 1 {
		t.Errorf("%d bakes started, want 1 (the cancelled queued one must not run)", n)
	}
}

// The module declares its three streams on the relay it is given.
func TestJobsDeclaresItsStreams(t *testing.T) {
	server, err := natsserver.NewServer(&natsserver.Options{Host: "127.0.0.1", Port: -1, JetStream: true, StoreDir: t.TempDir(), NoSigs: true, NoLog: true})
	if err != nil {
		t.Fatal(err)
	}
	go server.Start()
	if !server.ReadyForConnections(10 * time.Second) {
		t.Fatal("server not ready")
	}
	defer func() {
		server.Shutdown()
		server.WaitForShutdown()
	}()
	conn, err := relay.Connect("jobs", server, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := declareStreams(ctx, conn); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"JOBS_TASKS", "JOBS_DONE", "JOBS_EVENTS"} {
		if _, err := conn.JetStream().Stream(ctx, name); err != nil {
			t.Errorf("stream %s: %v", name, err)
		}
	}
	conn.Close()
}

// The event stream carries a job's changes to whoever may see its world, and
// nothing of a world they may not.
func TestEventsStreamTheJobsTheCallerMaySee(t *testing.T) {
	m, runner, worlds := newTestModule(t, config.AuthNone)
	writeWorld(t, worlds, "w1")
	mux := http.NewServeMux()
	if err := m.Mount(mux); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(mux)
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	request, _ := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"/v1/jobs/events", nil)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if got := response.Header.Get("Content-Type"); got != "text/event-stream" {
		t.Fatalf("content type %q", got)
	}
	if rec := post(m, "w1", `{"worldUid":"w1","stage":1}`, ""); rec.Code != http.StatusAccepted {
		t.Fatalf("enqueue %d", rec.Code)
	}
	runner.awaitSpec(t)
	scanner := bufio.NewScanner(response.Body)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var job listedJob
		if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &job); err != nil {
			t.Fatal(err)
		}
		if job.Request.WorldUID != "w1" {
			t.Fatalf("event for %q", job.Request.WorldUID)
		}
		return
	}
	t.Fatal("no event arrived")
}
