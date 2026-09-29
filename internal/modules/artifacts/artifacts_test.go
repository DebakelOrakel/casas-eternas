package artifacts

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/access"
	"github.com/DebakelOrakel/casas-eternas/internal/config"
	"github.com/DebakelOrakel/casas-eternas/internal/identity"
	"github.com/DebakelOrakel/casas-eternas/internal/token"
)

// The store's behaviour is covered in store_test.go; these tests cover the
// HTTP layer — the resolve handshake, status mapping, and the JSON shapes the
// client's artifactsClient.ts parses.

// newTestModule builds the module in the LOCAL shape: a none-mode resolver
// and the everything-ranks-admin closure cmd/ composes there. The checking
// shape, with a real ranking, is built by newCheckedModule below.
func newTestModule(t *testing.T) *http.ServeMux {
	t.Helper()
	store, err := NewStore(t.TempDir(), 0)
	if err != nil {
		t.Fatal(err)
	}
	m := &Module{
		cfg: Config{
			Identity:    identity.NewResolver(config.AuthNone, nil),
			WorldAccess: func(context.Context, string, string) (bool, access.Level) { return true, access.Admin },
		},
		store: store,
	}
	mux := http.NewServeMux()
	if err := m.Mount(mux); err != nil {
		t.Fatal(err)
	}
	return mux
}

func do(mux *http.ServeMux, method, path, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)
	return recorder
}

const resolveBody = `{"worldUid":"a754f0db-ff5c-4b45-9f2c-1b4e7a30d001","worldId":"ba90bda173d581ef","pipelineVersion":"v6","stage":"2"}`

func resolve(t *testing.T, mux *http.ServeMux, create bool) (string, []string) {
	t.Helper()
	body := resolveBody
	if create {
		body = strings.TrimSuffix(body, "}") + `,"create":true}`
	}
	response := do(mux, http.MethodPost, "/v1/artifacts/resolve", body)
	if response.Code != http.StatusOK {
		t.Fatalf("resolve = %d: %s", response.Code, response.Body)
	}
	var decoded struct {
		ArtifactUID string   `json:"artifactUid"`
		Files       []string `json:"files"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &decoded); err != nil {
		t.Fatal(err)
	}
	return decoded.ArtifactUID, decoded.Files
}

func TestResolveIsTheOnlyDoorToAKey(t *testing.T) {
	mux := newTestModule(t)

	// A reader asking for an absent key gets 404 — resolve without create is
	// the existence question.
	if got := do(mux, http.MethodPost, "/v1/artifacts/resolve", resolveBody).Code; got != http.StatusNotFound {
		t.Fatalf("resolve absent = %d, want 404", got)
	}

	// A writer mints; the same key resolves to the SAME uid from then on —
	// that idempotency is what replaced the old path grammar.
	uid, files := resolve(t, mux, true)
	if uid == "" {
		t.Fatal("create resolved to an empty uid")
	}
	if len(files) != 0 {
		t.Fatalf("fresh artifact already has files: %v", files)
	}
	again, _ := resolve(t, mux, true)
	if again != uid {
		t.Errorf("second create minted %s, want the existing %s", again, uid)
	}

	// Files appear in the resolve answer once written — the batch existence
	// check that used to be its own endpoint.
	if got := do(mux, http.MethodPut, "/v1/artifacts/"+uid+"/elevation.f32", "raster-bytes").Code; got != http.StatusNoContent {
		t.Fatalf("put = %d, want 204", got)
	}
	if _, files = resolve(t, mux, false); len(files) != 1 || files[0] != "elevation.f32" {
		t.Errorf("files after write = %v", files)
	}

	read := do(mux, http.MethodGet, "/v1/artifacts/"+uid+"/elevation.f32", "")
	if read.Code != http.StatusOK || read.Body.String() != "raster-bytes" {
		t.Errorf("read = %d %q", read.Code, read.Body.String())
	}
}

func TestWritingIntoAnUnmintedUidIsRefused(t *testing.T) {
	// Accepting the write would mint entries out of thin air — the uid must
	// come from resolve.
	mux := newTestModule(t)
	response := do(mux, http.MethodPut, "/v1/artifacts/00000000-dead-4bee-8888-000000000000/file", "x")
	if response.Code != http.StatusNotFound {
		t.Fatalf("put unminted = %d, want 404", response.Code)
	}
	if !strings.Contains(response.Body.String(), "resolve") {
		t.Errorf("the refusal should point at resolve: %s", response.Body)
	}
}

// doAs is do with a bearer token.
func doAs(mux *http.ServeMux, method, path, body, token string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)
	return recorder
}

// Artifacts inherit their world's ACL — the whole matrix, through real
// tokens: strangers see 404 (a hidden world hides its artifacts), viewers
// read but neither write nor remove, editors do both, the store-wide clear
// is the operator's, and a bake job's own token writes without any grant
// (the bypass step 4 will narrow).
func TestArtifactsInheritTheWorldsACL(t *testing.T) {
	tokens, err := token.NewTokens([]byte("a signing key long enough to be accepted"))
	if err != nil {
		t.Fatal(err)
	}
	issue := func(id string, admin bool) string {
		t.Helper()
		token, _, issueErr := tokens.IssueSession(id, admin, time.Hour)
		if issueErr != nil {
			t.Fatal(issueErr)
		}
		return token
	}
	owner, editor, viewer, stranger, admin := issue("own", false), issue("ed", false), issue("view", false), issue("str", false), issue("root", true)
	const worldUID = "a754f0db-ff5c-4b45-9f2c-1b4e7a30d001"
	levels := map[string]access.Level{
		"Bearer " + owner:  access.Owner,
		"Bearer " + editor: access.Editor,
		"Bearer " + viewer: access.Viewer,
	}

	store, err := NewStore(t.TempDir(), 0)
	if err != nil {
		t.Fatal(err)
	}
	m := &Module{
		cfg: Config{
			Identity: identity.NewResolver(config.AuthPassword, tokens),
			WorldAccess: func(_ context.Context, uid, bearer string) (bool, access.Level) {
				if uid != worldUID {
					return false, access.None
				}
				return true, levels[bearer]
			},
		},
		store: store,
	}
	mux := http.NewServeMux()
	if err := m.Mount(mux); err != nil {
		t.Fatal(err)
	}

	// The editor mints and writes; that is the working path everything else
	// is measured against.
	createBody := strings.TrimSuffix(resolveBody, "}") + `,"create":true}`
	created := doAs(mux, http.MethodPost, "/v1/artifacts/resolve", createBody, editor)
	if created.Code != http.StatusOK {
		t.Fatalf("editor create = %d: %s", created.Code, created.Body)
	}
	var minted struct {
		ArtifactUID string `json:"artifactUid"`
	}
	_ = json.Unmarshal(created.Body.Bytes(), &minted)
	if got := doAs(mux, http.MethodPut, "/v1/artifacts/"+minted.ArtifactUID+"/elevation.f32", "bytes", editor).Code; got != http.StatusNoContent {
		t.Fatalf("editor write = %d", got)
	}

	// The listing says what each caller may do with an entry, and counts only
	// what the caller sees (2026-09-29).
	meta := `{"key":{"worldUid":"` + worldUID + `","worldId":"w","pipelineVersion":"v","stage":"L1"},"label":"test","createdAt":1}`
	if got := doAs(mux, http.MethodPut, "/v1/artifacts/"+minted.ArtifactUID+"/meta.json", meta, editor).Code; got != http.StatusNoContent {
		t.Fatalf("editor meta = %d", got)
	}
	for _, c := range []struct {
		who, token, level string
	}{{"viewer", viewer, `"callerLevel":"viewer"`}, {"owner", owner, `"callerLevel":"owner"`}, {"operator", admin, `"callerLevel":"admin"`}} {
		body := doAs(mux, http.MethodGet, "/v1/artifacts", "", c.token).Body.String()
		if !strings.Contains(body, c.level) {
			t.Errorf("%s listing = %s, want %s", c.who, body, c.level)
		}
	}
	if body := doAs(mux, http.MethodGet, "/v1/artifacts", "", stranger).Body.String(); !strings.Contains(body, `"artifacts":[]`) || !strings.Contains(body, `"bytes":0`) {
		t.Errorf("a stranger's listing = %s, want nothing and no bytes", body)
	}

	cases := []struct {
		name   string
		method string
		path   string
		body   string
		token  string
		want   int
	}{
		{"stranger resolve", http.MethodPost, "/v1/artifacts/resolve", resolveBody, stranger, http.StatusNotFound},
		{"stranger read", http.MethodGet, "/v1/artifacts/" + minted.ArtifactUID + "/elevation.f32", "", stranger, http.StatusNotFound},
		{"viewer resolve", http.MethodPost, "/v1/artifacts/resolve", resolveBody, viewer, http.StatusOK},
		{"viewer read", http.MethodGet, "/v1/artifacts/" + minted.ArtifactUID + "/elevation.f32", "", viewer, http.StatusOK},
		{"viewer create", http.MethodPost, "/v1/artifacts/resolve", createBody, viewer, http.StatusForbidden},
		{"viewer write", http.MethodPut, "/v1/artifacts/" + minted.ArtifactUID + "/f2", "x", viewer, http.StatusForbidden},
		{"viewer remove", http.MethodDelete, "/v1/artifacts/" + minted.ArtifactUID, "", viewer, http.StatusForbidden},
		{"editor sweep needs owner", http.MethodDelete, "/v1/artifacts?world=" + worldUID, "", editor, http.StatusForbidden},
		{"viewer clear-all", http.MethodDelete, "/v1/artifacts", "", viewer, http.StatusForbidden},
	}
	for _, c := range cases {
		if got := doAs(mux, c.method, c.path, c.body, c.token).Code; got != c.want {
			t.Errorf("%s = %d, want %d", c.name, got, c.want)
		}
	}

	// The listing inherits visibility: the viewer sees the artifact, the
	// stranger sees an empty store.
	for token, want := range map[string]int{viewer: 1, stranger: 0} {
		var listing struct {
			Artifacts []ListedArtifact `json:"artifacts"`
		}
		response := doAs(mux, http.MethodGet, "/v1/artifacts", "", token)
		if err := json.Unmarshal(response.Body.Bytes(), &listing); err != nil {
			t.Fatal(err)
		}
		if len(listing.Artifacts) != want {
			t.Errorf("listing length = %d, want %d", len(listing.Artifacts), want)
		}
	}

	// A bake job's token writes exactly where its world claim points — the
	// system's own writer, narrowed to the one world it was sent for. For
	// any other world, or without the claim (a pre-claim token), it is a
	// stranger like every other.
	rightJob, _, err := tokens.IssueJob("job-1", worldUID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	wrongJob, _, err := tokens.IssueJob("job-2", "00000000-1111-4222-8333-444444444444", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	clueless, _, err := tokens.Issue(token.SubjectJob, token.JobAudience("job-3"), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if got := doAs(mux, http.MethodPut, "/v1/artifacts/"+minted.ArtifactUID+"/job.f32", "x", rightJob).Code; got != http.StatusNoContent {
		t.Errorf("bake job write for its own world = %d, want 204", got)
	}
	if got := doAs(mux, http.MethodPut, "/v1/artifacts/"+minted.ArtifactUID+"/job2.f32", "x", wrongJob).Code; got != http.StatusNotFound {
		t.Errorf("bake job write for ANOTHER world = %d, want 404", got)
	}
	if got := doAs(mux, http.MethodPut, "/v1/artifacts/"+minted.ArtifactUID+"/job3.f32", "x", clueless).Code; got != http.StatusNotFound {
		t.Errorf("claim-less job token write = %d, want 404", got)
	}

	// Owner sweeps their world; the operator clears the store.
	if got := doAs(mux, http.MethodDelete, "/v1/artifacts?world="+worldUID, "", owner).Code; got != http.StatusNoContent {
		t.Errorf("owner sweep = %d, want 204", got)
	}
	if got := doAs(mux, http.MethodDelete, "/v1/artifacts", "", admin).Code; got != http.StatusNoContent {
		t.Errorf("admin clear = %d, want 204", got)
	}
}

// The regression the byKey sweep exists for (found and fixed 2026-08-12):
// removing an entry whose IN-MEMORY meta is nil used to leave the key mapped
// to the dropped uid, so the next resolve answered a uid whose PUTs 404ed.
// Two legitimate states have a nil in-memory meta, and both are exercised
// here WITHOUT a listing in between — a listing's refresh would have read the
// meta and masked the leak.
func TestRemovalNeverStrandsAKeyOnADroppedUid(t *testing.T) {
	mux := newTestModule(t)

	// State one: a reservation whose writer never finished — exactly what
	// eviction's junk-first pass deletes.
	uid, _ := resolve(t, mux, true)
	if got := do(mux, http.MethodDelete, "/v1/artifacts/"+uid, "").Code; got != http.StatusNoContent {
		t.Fatalf("delete reservation = %d", got)
	}
	if got := do(mux, http.MethodPost, "/v1/artifacts/resolve", resolveBody).Code; got != http.StatusNotFound {
		t.Errorf("key still resolves after its reservation was dropped: %d", got)
	}
	if minted, _ := resolve(t, mux, true); minted == uid {
		t.Error("a fresh create resolved to the dropped uid")
	}

	// State two: the meta.json landed, but no refresh read it before the
	// delete arrived.
	uid, _ = resolve(t, mux, false)
	writeMeta(t, mux, uid)
	if got := do(mux, http.MethodDelete, "/v1/artifacts/"+uid, "").Code; got != http.StatusNoContent {
		t.Fatalf("delete after meta = %d", got)
	}
	if got := do(mux, http.MethodPost, "/v1/artifacts/resolve", resolveBody).Code; got != http.StatusNotFound {
		t.Errorf("key still resolves after its artifact was dropped: %d", got)
	}
}

func TestListShapesAreNeverNull(t *testing.T) {
	// A nil slice marshals as `null`, and exactly that crashed the storage
	// panel mid-render once (2026-08-12). Empty must be [].
	mux := newTestModule(t)
	response := do(mux, http.MethodGet, "/v1/artifacts", "")
	if response.Code != http.StatusOK {
		t.Fatalf("list = %d", response.Code)
	}
	body := response.Body.String()
	if !strings.Contains(body, `"artifacts":[]`) {
		t.Errorf("empty listing = %s, want artifacts:[]", body)
	}
}

// writeMeta completes an artifact the way a real bake does — the meta.json
// lands among the files and carries the key. Both removal paths clean the
// key mapping through the meta, so a test that skipped it would exercise a
// state production only reaches when a writer crashed mid-bake.
func writeMeta(t *testing.T, mux *http.ServeMux, uid string) {
	t.Helper()
	meta := `{"key":{"worldUid":"a754f0db-ff5c-4b45-9f2c-1b4e7a30d001","worldId":"ba90bda173d581ef","pipelineVersion":"v6","stage":"2"},"label":"test","createdAt":1}`
	if got := do(mux, http.MethodPut, "/v1/artifacts/"+uid+"/meta.json", meta).Code; got != http.StatusNoContent {
		t.Fatalf("writing meta = %d", got)
	}
}

func TestRemovalByArtifactAndByWorld(t *testing.T) {
	mux := newTestModule(t)
	uid, _ := resolve(t, mux, true)
	do(mux, http.MethodPut, "/v1/artifacts/"+uid+"/f", "x")
	writeMeta(t, mux, uid)

	if got := do(mux, http.MethodDelete, "/v1/artifacts/"+uid, "").Code; got != http.StatusNoContent {
		t.Fatalf("delete = %d, want 204", got)
	}
	if got := do(mux, http.MethodPost, "/v1/artifacts/resolve", resolveBody).Code; got != http.StatusNotFound {
		t.Errorf("resolve after delete = %d, want 404", got)
	}

	// And the by-world sweep, which the meta attribution makes possible.
	uid, _ = resolve(t, mux, true)
	writeMeta(t, mux, uid)
	if got := do(mux, http.MethodDelete, "/v1/artifacts?world=a754f0db-ff5c-4b45-9f2c-1b4e7a30d001", "").Code; got != http.StatusNoContent {
		t.Fatalf("delete by world = %d, want 204", got)
	}
	if got := do(mux, http.MethodPost, "/v1/artifacts/resolve", resolveBody).Code; got != http.StatusNotFound {
		t.Errorf("resolve after world sweep = %d, want 404", got)
	}
}
