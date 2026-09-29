package world

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/access"
	"github.com/DebakelOrakel/casas-eternas/internal/config"
	"github.com/DebakelOrakel/casas-eternas/internal/identity"
	"github.com/DebakelOrakel/casas-eternas/internal/token"
)

// The store's behaviour is covered in store_test.go; these tests cover the
// HTTP layer on top — status mapping, headers, and the JSON shapes clients
// parse. Requests go through a real mux so the route patterns are exercised,
// not just the handler funcs.

func newTestModule(t *testing.T) (*Module, *http.ServeMux) {
	t.Helper()
	m := &Module{
		cfg:   Config{Identity: identity.NewResolver(config.AuthNone, nil)},
		store: newTestStore(t),
	}
	mux := http.NewServeMux()
	if err := m.Mount(mux); err != nil {
		t.Fatal(err)
	}
	return m, mux
}

func do(mux *http.ServeMux, method, path string, body []byte, header map[string]string) *httptest.ResponseRecorder {
	var reader *strings.Reader
	request := httptest.NewRequest(method, path, nil)
	if body != nil {
		request = httptest.NewRequest(method, path, strings.NewReader(string(body)))
	}
	_ = reader
	for key, value := range header {
		request.Header.Set(key, value)
	}
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)
	return recorder
}

// upload PUTs a save whose payload carries the If-Match value, so an update
// never sends byte-identical content — identical bytes hit the content-hash
// dedupe and deliberately mint no new revision, which is its own behaviour,
// not the one these tests are about.
func upload(t *testing.T, mux *http.ServeMux, uid string, ifMatch string) *httptest.ResponseRecorder {
	t.Helper()
	data := buildSave(t, sampleYAML(), []byte("PNG"), map[string][]byte{"payload": []byte("body-" + ifMatch)})
	header := map[string]string{}
	if ifMatch != "" {
		header["If-Match"] = ifMatch
	}
	return do(mux, http.MethodPut, "/v1/worlds/"+uid, data, header)
}

func TestPutMapsTheOptimisticLockOntoStatusCodes(t *testing.T) {
	_, mux := newTestModule(t)

	created := upload(t, mux, sampleUID, "")
	if created.Code != http.StatusCreated {
		t.Fatalf("create = %d, want 201: %s", created.Code, created.Body)
	}
	if got := created.Header().Get("ETag"); got != `"1"` {
		t.Errorf("ETag = %q, want the revision", got)
	}

	// The three refusals, each with its own status so the client can tell
	// them apart: exists (409), stale revision (412), unparseable header (400).
	if got := upload(t, mux, sampleUID, "").Code; got != http.StatusConflict {
		t.Errorf("blind re-create = %d, want 409", got)
	}
	if got := upload(t, mux, sampleUID, `"9"`).Code; got != http.StatusPreconditionFailed {
		t.Errorf("stale If-Match = %d, want 412", got)
	}
	if got := upload(t, mux, sampleUID, "not-a-revision").Code; got != http.StatusBadRequest {
		t.Errorf("malformed If-Match = %d, want 400", got)
	}
	// And the honest update goes through.
	if got := upload(t, mux, sampleUID, `"1"`).Code; got != http.StatusOK {
		t.Errorf("update with current revision = %d, want 200", got)
	}
}

func TestPutRefusesAUidTheSaveDoesNotCarry(t *testing.T) {
	_, mux := newTestModule(t)
	other := "11111111-2222-4333-8444-555555555555"
	if got := upload(t, mux, other, "").Code; got != http.StatusBadRequest {
		t.Errorf("uid mismatch = %d, want 400", got)
	}
}

func TestListIsNeverNull(t *testing.T) {
	// A nil slice marshals as `null`, and exactly that crashed the storage
	// panel once (2026-08-12, the artifact store's stages field). The empty
	// listing must be `[]`.
	_, mux := newTestModule(t)
	response := do(mux, http.MethodGet, "/v1/worlds", nil, nil)
	if body := strings.TrimSpace(response.Body.String()); body != "[]" {
		t.Errorf("empty listing = %q, want []", body)
	}
}

func TestMetaAnswersWithoutTheBytes(t *testing.T) {
	_, mux := newTestModule(t)
	upload(t, mux, sampleUID, "")

	response := do(mux, http.MethodGet, "/v1/worlds/"+sampleUID+"/meta", nil, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("meta = %d", response.Code)
	}
	var meta Meta
	if err := json.Unmarshal(response.Body.Bytes(), &meta); err != nil {
		t.Fatal(err)
	}
	// Owner and revision are what the world-less bake target asks for.
	if meta.Owner != identity.Local || meta.Revision != 1 {
		t.Errorf("meta = %+v, want owner %q revision 1", meta, identity.Local)
	}

	absent := "11111111-2222-4333-8444-555555555555"
	if got := do(mux, http.MethodGet, "/v1/worlds/"+absent+"/meta", nil, nil).Code; got != http.StatusNotFound {
		t.Errorf("absent meta = %d, want 404", got)
	}
}

func TestGetServesTheZipWithItsRevisionAsETag(t *testing.T) {
	_, mux := newTestModule(t)
	upload(t, mux, sampleUID, "")

	response := do(mux, http.MethodGet, "/v1/worlds/"+sampleUID, nil, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("get = %d", response.Code)
	}
	if got := response.Header().Get("Content-Type"); got != "application/zip" {
		t.Errorf("content type = %q", got)
	}
	if got := response.Header().Get("ETag"); got != `"1"` {
		t.Errorf("ETag = %q", got)
	}

	if got := do(mux, http.MethodGet, "/v1/worlds/11111111-2222-4333-8444-555555555555", nil, nil).Code; got != http.StatusNotFound {
		t.Errorf("absent world = %d, want 404", got)
	}
}

// A bake Job may READ the one world its token names — and nothing else in no
// other way: every other world stays the stranger's 404, and even its own
// world refuses writes and deletes. Pins the gap found 2026-08-13, when the
// first cluster bake against a checking server died on this very 404.
func TestBakeJobReadsExactlyItsWorld(t *testing.T) {
	tokens, err := token.NewTokens([]byte("a signing key long enough to be accepted"))
	if err != nil {
		t.Fatal(err)
	}
	m := &Module{
		cfg:   Config{Identity: identity.NewResolver(config.AuthPassword, tokens)},
		store: newTestStore(t),
	}
	mux := http.NewServeMux()
	if err := m.Mount(mux); err != nil {
		t.Fatal(err)
	}
	as := func(method, path, bearer string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(method, path, nil)
		request.Header.Set("Authorization", "Bearer "+bearer)
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, request)
		return recorder
	}

	// ada owns the world; the job was minted FOR it, the stray job for another.
	ada, _, err := tokens.IssueSession("ada-id", false, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	save := buildSave(t, sampleYAML(), []byte("PNG"), nil)
	request := httptest.NewRequest(http.MethodPut, "/v1/worlds/"+sampleUID, strings.NewReader(string(save)))
	request.Header.Set("Authorization", "Bearer "+ada)
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("create = %d", recorder.Code)
	}
	job, _, err := tokens.IssueJob("job-1", sampleUID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	stray, _, err := tokens.IssueJob("job-2", "00000000-0000-4000-8000-000000000000", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	for _, path := range []string{
		"/v1/worlds/" + sampleUID,
		"/v1/worlds/" + sampleUID + "/meta",
	} {
		if got := as(http.MethodGet, path, job).Code; got != http.StatusOK {
			t.Errorf("job GET %s = %d, want 200", path, got)
		}
		// A job for a DIFFERENT world is a stranger here — including the
		// 404 that must not confirm existence.
		if got := as(http.MethodGet, path, stray).Code; got != http.StatusNotFound {
			t.Errorf("stray job GET %s = %d, want 404", path, got)
		}
	}
	// Read only: its own world refuses everything above viewer.
	if got := as(http.MethodDelete, "/v1/worlds/"+sampleUID, job).Code; got == http.StatusOK || got == http.StatusNoContent {
		t.Errorf("job DELETE succeeded (%d)", got)
	}
	update := buildSave(t, sampleYAML(), []byte("PNG"), map[string][]byte{"payload": []byte("v2")})
	request = httptest.NewRequest(http.MethodPut, "/v1/worlds/"+sampleUID, strings.NewReader(string(update)))
	request.Header.Set("Authorization", "Bearer "+job)
	request.Header.Set("If-Match", `"1"`)
	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)
	if recorder.Code == http.StatusOK || recorder.Code == http.StatusCreated {
		t.Errorf("job PUT succeeded (%d)", recorder.Code)
	}
}

// The visibility rule end to end, through real tokens and real grants: a
// private world is INVISIBLE to strangers — absent from the list, 404 on
// every direct route — and the granted levels open exactly their rows of
// the matrix. This is the behaviour step 3 changes for users, so it is
// asserted at the HTTP layer, not the store.
func TestPrivateWorldsAreInvisibleAndGrantsOpenThem(t *testing.T) {
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
	ada, grace, eve, root := issue("ada-id", false), issue("grace-id", false), issue("eve-id", false), issue("root-id", true)

	m := &Module{
		cfg:   Config{Identity: identity.NewResolver(config.AuthPassword, tokens)},
		store: newTestStore(t),
	}
	mux := http.NewServeMux()
	if err := m.Mount(mux); err != nil {
		t.Fatal(err)
	}
	as := func(method, path, token string, body []byte) *httptest.ResponseRecorder {
		request := httptest.NewRequest(method, path, strings.NewReader(string(body)))
		request.Header.Set("Authorization", "Bearer "+token)
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, request)
		return recorder
	}

	// ada creates — and is pinned as owner by the store.
	save := buildSave(t, sampleYAML(), []byte("PNG"), nil)
	if got := as(http.MethodPut, "/v1/worlds/"+sampleUID, ada, save).Code; got != http.StatusCreated {
		t.Fatalf("create = %d", got)
	}

	// Invisible to grace: not listed, and every direct route answers 404 —
	// including the writes, whose refusal must not confirm existence.
	if body := strings.TrimSpace(as(http.MethodGet, "/v1/worlds", grace, nil).Body.String()); body != "[]" {
		t.Errorf("grace's list = %s, want []", body)
	}
	for _, path := range []string{
		"/v1/worlds/" + sampleUID,
		"/v1/worlds/" + sampleUID + "/meta",
		"/v1/worlds/" + sampleUID + "/preview.png",
	} {
		if got := as(http.MethodGet, path, grace, nil).Code; got != http.StatusNotFound {
			t.Errorf("grace GET %s = %d, want 404", path, got)
		}
	}
	if got := as(http.MethodDelete, "/v1/worlds/"+sampleUID, grace, nil).Code; got != http.StatusNotFound {
		t.Errorf("grace DELETE = %d, want 404", got)
	}

	// A viewer grant opens reading and nothing more.
	if err := m.store.WriteGrants(context.Background(), sampleUID,
		access.Grants{Owner: "ada-id", Users: map[string]string{"grace-id": "viewer"}}); err != nil {
		t.Fatal(err)
	}
	if got := as(http.MethodGet, "/v1/worlds/"+sampleUID, grace, nil).Code; got != http.StatusOK {
		t.Errorf("viewer GET = %d, want 200", got)
	}
	update := buildSave(t, sampleYAML(), []byte("PNG"), map[string][]byte{"payload": []byte("v2")})
	request := httptest.NewRequest(http.MethodPut, "/v1/worlds/"+sampleUID, strings.NewReader(string(update)))
	request.Header.Set("Authorization", "Bearer "+grace)
	request.Header.Set("If-Match", `"1"`)
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden {
		t.Errorf("viewer PUT = %d, want 403", recorder.Code)
	}
	if got := as(http.MethodDelete, "/v1/worlds/"+sampleUID, grace, nil).Code; got != http.StatusForbidden {
		t.Errorf("viewer DELETE = %d, want 403", got)
	}

	// The public flag makes every authenticated caller a viewer.
	if err := m.store.WriteGrants(context.Background(), sampleUID, access.Grants{Owner: "ada-id", Public: true}); err != nil {
		t.Fatal(err)
	}
	if got := as(http.MethodGet, "/v1/worlds/"+sampleUID+"/meta", eve, nil).Code; got != http.StatusOK {
		t.Errorf("public meta for eve = %d, want 200", got)
	}
	var listed []Meta
	_ = json.Unmarshal(as(http.MethodGet, "/v1/worlds", eve, nil).Body.Bytes(), &listed)
	if len(listed) != 1 {
		t.Errorf("eve's list of a public world = %d entries, want 1", len(listed))
	}

	// The meta endpoint states the caller's own level — the value a peer
	// service compares against.
	var meta struct {
		CallerLevel string `json:"callerLevel"`
	}
	_ = json.Unmarshal(as(http.MethodGet, "/v1/worlds/"+sampleUID+"/meta", ada, nil).Body.Bytes(), &meta)
	if meta.CallerLevel != "owner" {
		t.Errorf("ada's callerLevel = %q, want owner", meta.CallerLevel)
	}

	// The admin claim outranks the grants; the owner may delete their world.
	if got := as(http.MethodGet, "/v1/worlds/"+sampleUID, root, nil).Code; got != http.StatusOK {
		t.Errorf("admin GET = %d, want 200", got)
	}
	if got := as(http.MethodDelete, "/v1/worlds/"+sampleUID, ada, nil).Code; got != http.StatusNoContent {
		t.Errorf("owner DELETE = %d, want 204", got)
	}
}

// A world from before grants existed follows the migration rule: its
// recorded owner NAME opens it only for the registry user that name maps
// to; everyone else — including the un-mapped — finds it admin-only.
func TestLegacyWorldsFollowTheMigrationRule(t *testing.T) {
	m := &Module{
		cfg: Config{
			LegacyOwner: func(name string) (string, bool) {
				if name == "ada" {
					return "ada-id", true
				}
				return "", false
			},
		},
		store: newTestStore(t),
	}
	if _, err := putAs(t, m.store, sampleUID, "first", "ada", 0); err != nil {
		t.Fatal(err)
	}
	// Strip the grants the create wrote — this world predates them.
	if err := os.Remove(m.store.grantsPath(sampleUID)); err != nil {
		t.Fatal(err)
	}

	if exists, level := m.AccessFor(context.Background(), sampleUID, "ada-id", false); !exists || level != access.Owner {
		t.Errorf("mapped legacy owner ranks %v (exists %v), want owner", level, exists)
	}
	if _, level := m.AccessFor(context.Background(), sampleUID, "grace-id", false); level != access.None {
		t.Errorf("stranger on a legacy world ranks %v, want none", level)
	}
	if _, level := m.AccessFor(context.Background(), sampleUID, "anyone", true); level != access.Admin {
		t.Errorf("admin on a legacy world ranks %v, want admin", level)
	}
}

func TestDeleteRemovesTheWorld(t *testing.T) {
	_, mux := newTestModule(t)
	upload(t, mux, sampleUID, "")

	if got := do(mux, http.MethodDelete, "/v1/worlds/"+sampleUID, nil, nil).Code; got != http.StatusNoContent {
		t.Fatalf("delete = %d, want 204", got)
	}
	if got := do(mux, http.MethodGet, "/v1/worlds/"+sampleUID, nil, nil).Code; got != http.StatusNotFound {
		t.Errorf("get after delete = %d, want 404", got)
	}
}
