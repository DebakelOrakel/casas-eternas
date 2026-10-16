package artifacts

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/access"
	"github.com/DebakelOrakel/casas-eternas/internal/blob"
	"github.com/DebakelOrakel/casas-eternas/internal/config"
	"github.com/DebakelOrakel/casas-eternas/internal/identity"
	"github.com/DebakelOrakel/casas-eternas/internal/token"
)

// The store's behaviour is covered in store_test.go; these tests cover the
// HTTP layer — the resolve handshake, status mapping, and the JSON shapes the
// client's artifactsClient.ts parses.

// newTestModule builds the module in the LOCAL shape: a none-mode resolver
// and the everything-ranks-admin closures cmd/ composes there. The checking
// shape, with a real ranking, is built with a testWorlds that grants.
func newTestModule(t *testing.T) *http.ServeMux {
	t.Helper()
	_, mux := newModule(t, openTestDir(t, t.TempDir()), identity.NewResolver(config.AuthNone, nil), adminWorlds())
	return mux
}

// testWorlds stands in for the world module (Config.WorldAccess,
// TerrainAccess, AddTerrain): per world a level per Authorization header
// and its terrain ids.
type testWorlds struct {
	mu sync.Mutex
	// everyone is every caller's level on every world: Admin in the local
	// shape, None where only grants rank.
	everyone access.Level
	levels   map[string]map[string]access.Level // world uid → Authorization → level
	terrains map[string][]string                // world uid → terrain ids
}

func newWorlds(everyone access.Level) *testWorlds {
	return &testWorlds{everyone: everyone, levels: map[string]map[string]access.Level{}, terrains: map[string][]string{}}
}

func adminWorlds() *testWorlds { return newWorlds(access.Admin) }
func noWorlds() *testWorlds    { return newWorlds(access.None) }

// grant gives the caller with `bearer` (a whole Authorization header) a
// level on a world.
func (w *testWorlds) grant(uid, bearer string, level access.Level) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.levels[uid] == nil {
		w.levels[uid] = map[string]access.Level{}
	}
	w.levels[uid][bearer] = level
}

// hold records terrain ids of a world, as a job's resolve does.
func (w *testWorlds) hold(uid string, terrains ...string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, id := range terrains {
		if !slices.Contains(w.terrains[uid], id) {
			w.terrains[uid] = append(w.terrains[uid], id)
		}
	}
}

func (w *testWorlds) levelLocked(uid, bearer string) access.Level {
	return max(w.everyone, w.levels[uid][bearer])
}

func (w *testWorlds) world(_ context.Context, uid, bearer string) (bool, access.Level, []string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	_, granted := w.levels[uid]
	_, held := w.terrains[uid]
	if !granted && !held && w.everyone == access.None {
		return false, access.None, nil
	}
	return true, w.levelLocked(uid, bearer), slices.Clone(w.terrains[uid])
}

func (w *testWorlds) terrain(_ context.Context, worldID, bearer string) (access.Level, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	level, holders := access.None, 0
	for uid, ids := range w.terrains {
		if slices.Contains(ids, worldID) {
			holders++
			level = max(level, w.levelLocked(uid, bearer))
		}
	}
	return level, holders > 1
}

func (w *testWorlds) addTerrain(_ context.Context, uid, worldID, _ string) error {
	w.hold(uid, worldID)
	return nil
}

// newModule builds the module through New, on `bucket`, and mounts it.
func newModule(t *testing.T, bucket blob.Bucket, resolver *identity.Resolver, worlds *testWorlds) (*Module, *http.ServeMux) {
	t.Helper()
	var all config.Config
	all.Artifacts.ReadLinkTTL = 15 * time.Minute
	all.Artifacts.WriteLinkTTL = time.Hour
	m, err := New(context.Background(), Config{All: all, Bucket: bucket, Identity: resolver, WorldAccess: worlds.world, TerrainAccess: worlds.terrain, AddTerrain: worlds.addTerrain})
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	if err := m.Mount(mux); err != nil {
		t.Fatal(err)
	}
	return m, mux
}

// follow answers a read the way a client does: the module redirects to a
// link, and a same-origin link is asked of the same mux, with the same
// header (a client keeps it on a same-origin redirect).
func follow(t *testing.T, mux *http.ServeMux, path, token string) *httptest.ResponseRecorder {
	t.Helper()
	first := doAs(mux, http.MethodGet, path, "", token)
	if first.Code != http.StatusFound {
		return first
	}
	if got := first.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("redirect Cache-Control = %q, want no-store", got)
	}
	location := first.Header().Get("Location")
	if !strings.HasPrefix(location, LinkBase) {
		t.Fatalf("redirect to %q, want a link under %s", location, LinkBase)
	}
	return doAs(mux, http.MethodGet, location, "", token)
}

func do(mux *http.ServeMux, method, path, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)
	return recorder
}

// The world names what a resolve works for (resolveRequest.World): read in
// the local mode only, where it records the terrain for the world.
const resolveBody = `{"worldId":"ba90bda173d581ef","pipelineVersion":"v6","stage":"2","world":"a754f0db-ff5c-4b45-9f2c-1b4e7a30d001"}`

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

	read := follow(t, mux, "/v1/artifacts/"+uid+"/elevation.f32", "")
	if read.Code != http.StatusOK || read.Body.String() != "raster-bytes" || read.Header().Get("Content-Length") != "12" {
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

// Artifacts inherit the ACL of the worlds that hold their terrain — the
// whole matrix of DEC-0039, through real tokens: only the job of a world
// writes (it binds the terrain to its world as it resolves), strangers see
// 404, viewers and the anonymous caller of a template read, a copy that
// holds the same terrain reads at once, a shared terrain is removed by an
// admin only, and the owner's sweep takes what no other world holds.
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
	owner, editor, viewer, stranger, admin, copier := issue("own", false), issue("ed", false), issue("view", false), issue("str", false), issue("root", true), issue("copier", false)
	const (
		worldUID = "a754f0db-ff5c-4b45-9f2c-1b4e7a30d001"
		copyUID  = "b754f0db-ff5c-4b45-9f2c-1b4e7a30d002"
		terrain  = "ba90bda173d581ef"
	)
	worlds := noWorlds()
	worlds.grant(worldUID, "Bearer "+owner, access.Owner)
	worlds.grant(worldUID, "Bearer "+editor, access.Editor)
	worlds.grant(worldUID, "Bearer "+viewer, access.Viewer)
	worlds.grant(copyUID, "Bearer "+copier, access.Owner)
	m, mux := newModule(t, openTestDir(t, t.TempDir()), identity.NewResolver(config.AuthPassword, tokens), worlds)

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

	// Before any job, no world holds the terrain: nobody reads it.
	if got := doAs(mux, http.MethodPost, "/v1/artifacts/resolve", resolveBody, viewer).Code; got != http.StatusNotFound {
		t.Errorf("viewer resolve before a job = %d, want 404", got)
	}

	// The job of the world mints and writes; that is the working path
	// everything else is measured against. Its resolve binds the terrain.
	createBody := strings.TrimSuffix(resolveBody, "}") + `,"create":true}`
	created := doAs(mux, http.MethodPost, "/v1/artifacts/resolve", createBody, rightJob)
	if created.Code != http.StatusOK {
		t.Fatalf("job create = %d: %s", created.Code, created.Body)
	}
	if _, _, held := worlds.world(context.Background(), worldUID, ""); !slices.Contains(held, terrain) {
		t.Fatalf("the job's resolve did not bind the terrain: %v", held)
	}
	var minted struct {
		ArtifactUID string `json:"artifactUid"`
	}
	_ = json.Unmarshal(created.Body.Bytes(), &minted)
	if got := doAs(mux, http.MethodPut, "/v1/artifacts/"+minted.ArtifactUID+"/elevation.f32", "bytes", rightJob).Code; got != http.StatusNoContent {
		t.Fatalf("job write = %d", got)
	}
	meta := `{"key":{"worldId":"` + terrain + `","pipelineVersion":"v6","stage":"2"},"label":"test","createdAt":1}`
	if got := doAs(mux, http.MethodPut, "/v1/artifacts/"+minted.ArtifactUID+"/meta.json", meta, rightJob).Code; got != http.StatusNoContent {
		t.Fatalf("job meta = %d", got)
	}

	// The listing says what each caller may do with an entry, and counts only
	// what the caller sees (2026-09-29).
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

	read := "/v1/artifacts/" + minted.ArtifactUID + "/elevation.f32"
	cases := []struct {
		name   string
		method string
		path   string
		body   string
		token  string
		want   int
	}{
		{"stranger resolve", http.MethodPost, "/v1/artifacts/resolve", resolveBody, stranger, http.StatusNotFound},
		{"stranger read", http.MethodGet, read, "", stranger, http.StatusNotFound},
		{"anonymous read of a world that is no template", http.MethodGet, read, "", "", http.StatusNotFound},
		{"viewer resolve", http.MethodPost, "/v1/artifacts/resolve", resolveBody, viewer, http.StatusOK},
		{"viewer read", http.MethodGet, read, "", viewer, http.StatusOK},
		{"viewer create", http.MethodPost, "/v1/artifacts/resolve", createBody, viewer, http.StatusForbidden},
		{"editor create", http.MethodPost, "/v1/artifacts/resolve", createBody, editor, http.StatusForbidden},
		{"admin create", http.MethodPost, "/v1/artifacts/resolve", createBody, admin, http.StatusForbidden},
		{"editor write", http.MethodPut, "/v1/artifacts/" + minted.ArtifactUID + "/f2", "x", editor, http.StatusForbidden},
		{"editor write link", http.MethodPost, "/v1/artifacts/" + minted.ArtifactUID + "/write-link", `{"name":"f3","size":1}`, editor, http.StatusForbidden},
		{"viewer remove", http.MethodDelete, "/v1/artifacts/" + minted.ArtifactUID, "", viewer, http.StatusForbidden},
		{"editor sweep needs owner", http.MethodDelete, "/v1/artifacts?world=" + worldUID, "", editor, http.StatusForbidden},
		{"viewer clear-all", http.MethodDelete, "/v1/artifacts", "", viewer, http.StatusForbidden},
		{"job of another world writes", http.MethodPut, "/v1/artifacts/" + minted.ArtifactUID + "/job2.f32", "x", wrongJob, http.StatusNotFound},
		{"claim-less job token writes", http.MethodPut, "/v1/artifacts/" + minted.ArtifactUID + "/job3.f32", "x", clueless, http.StatusNotFound},
		{"copy's owner reads before the copy holds the terrain", http.MethodGet, read, "", copier, http.StatusNotFound},
	}
	for _, c := range cases {
		response := doAs(mux, c.method, c.path, c.body, c.token)
		got := response.Code
		if c.method == http.MethodGet && got == http.StatusFound {
			got = follow(t, mux, c.path, c.token).Code
		}
		if got != c.want {
			t.Errorf("%s = %d, want %d", c.name, got, c.want)
		}
		// The check comes before the link: a refused read hands out none.
		if c.want != http.StatusOK && response.Header().Get("Location") != "" {
			t.Errorf("%s handed out a link: %s", c.name, response.Header().Get("Location"))
		}
	}

	// A template: the anonymous caller ranks a viewer, and reads.
	worlds.grant(worldUID, "", access.Viewer)
	if got := follow(t, mux, read, "").Code; got != http.StatusOK {
		t.Errorf("anonymous read of a template = %d, want 200", got)
	}

	// A copy holds the same terrain (the server's copy carries the ids):
	// its owner reads at once, and the terrain is shared now — removed by
	// an admin only, and left by a sweep.
	worlds.hold(copyUID, terrain)
	if got := follow(t, mux, read, copier).Code; got != http.StatusOK {
		t.Errorf("the copy's owner reads = %d, want 200", got)
	}
	if got := doAs(mux, http.MethodDelete, "/v1/artifacts/"+minted.ArtifactUID, "", editor).Code; got != http.StatusForbidden {
		t.Errorf("editor removes a shared artifact = %d, want 403", got)
	}
	if got := doAs(mux, http.MethodDelete, "/v1/artifacts?worldId="+terrain+"&level=0", "", copier).Code; got != http.StatusForbidden {
		t.Errorf("the copy's owner drops a shared level = %d, want 403", got)
	}
	if got := doAs(mux, http.MethodDelete, "/v1/artifacts?world="+copyUID, "", copier).Code; got != http.StatusNoContent {
		t.Errorf("the copy's owner sweeps = %d, want 204", got)
	}
	if got := follow(t, mux, read, viewer).Code; got != http.StatusOK {
		t.Errorf("after the copy's sweep the template's viewer reads = %d, want 200 (shared terrain stays)", got)
	}

	// The copy is gone; the terrain is the world's alone, and its owner's
	// sweep takes it.
	worlds.mu.Lock()
	delete(worlds.terrains, copyUID)
	worlds.mu.Unlock()
	if got := doAs(mux, http.MethodDelete, "/v1/artifacts?world="+worldUID, "", owner).Code; got != http.StatusNoContent {
		t.Errorf("owner sweep = %d, want 204", got)
	}
	if _, ok := m.store.TerrainOf(context.Background(), minted.ArtifactUID); ok {
		t.Error("the owner's sweep left the artifact of a terrain no other world holds")
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
	meta := `{"key":{"worldId":"ba90bda173d581ef","pipelineVersion":"v6","stage":"2"},"label":"test","createdAt":1}`
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

// The levels listing sums a world's tiles per level, terrain and version;
// a level is removed whole, tiles included, and only of the version asked.
func TestLevelsAreSummedAndRemovedWhole(t *testing.T) {
	mux := newTestModule(t)
	mint := func(stage, version string) {
		t.Helper()
		key := `{"worldId":"ba90bda173d581ef","pipelineVersion":"` + version + `","stage":"` + stage + `"`
		response := do(mux, http.MethodPost, "/v1/artifacts/resolve", key+`,"create":true}`)
		var decoded struct {
			ArtifactUID string `json:"artifactUid"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &decoded); err != nil || decoded.ArtifactUID == "" {
			t.Fatalf("resolve %s = %d: %s", stage, response.Code, response.Body)
		}
		do(mux, http.MethodPut, "/v1/artifacts/"+decoded.ArtifactUID+"/f", "xx")
		meta := `{"key":` + key + `},"label":"seed","bakeMs":10,"createdAt":1}`
		if got := do(mux, http.MethodPut, "/v1/artifacts/"+decoded.ArtifactUID+"/meta.json", meta).Code; got != http.StatusNoContent {
			t.Fatalf("meta %s = %d", stage, got)
		}
	}
	mint("L1", "v6")
	mint("L2:0,0", "v6")
	mint("L3:0,0", "v6")
	mint("L3:1,0", "v6")
	mint("L3:0,0", "v7")
	mint("odd", "v6")

	levels := func() map[string]int {
		t.Helper()
		response := do(mux, http.MethodGet, "/v1/artifacts/levels", "")
		var decoded struct {
			Levels []LevelSummary `json:"levels"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &decoded); err != nil {
			t.Fatalf("levels = %d: %s", response.Code, response.Body)
		}
		out := map[string]int{}
		for _, l := range decoded.Levels {
			out[fmt.Sprintf("L%d %v %s", l.Level, l.Tiles, l.PipelineVersion)] = l.Count
		}
		return out
	}
	got := levels()
	want := map[string]int{"L1 false v6": 1, "L2 true v6": 1, "L3 true v6": 2, "L3 true v7": 1}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("levels %v, want %v", got, want)
	}
	if code := do(mux, http.MethodDelete, "/v1/artifacts?worldId=ba90bda173d581ef&level=3&pipeline=v6", "").Code; code != http.StatusNoContent {
		t.Fatalf("delete level = %d", code)
	}
	got = levels()
	want = map[string]int{"L1 false v6": 1, "L2 true v6": 1, "L3 true v7": 1}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("after delete %v, want %v", got, want)
	}
	if code := do(mux, http.MethodDelete, "/v1/artifacts?worldId=ba90bda173d581ef&level=x", "").Code; code != http.StatusBadRequest {
		t.Errorf("a level that is no number = %d, want 400", code)
	}
	if code := do(mux, http.MethodDelete, "/v1/artifacts?level=1", "").Code; code != http.StatusBadRequest {
		t.Errorf("a level of no terrain = %d, want 400", code)
	}
}

// The gate lets a request without credentials through to a resolve and the
// read of a file — the module ranks it by the terrain — and to nothing else
// of this module (DEC-0039, fork 4).
func TestAnonymousReadsAreAResolveAndAFileRead(t *testing.T) {
	for _, c := range []struct {
		method, path string
		want         bool
	}{
		{http.MethodPost, "/v1/artifacts/resolve", true},
		{http.MethodGet, "/v1/artifacts/5f0e1c4a-0000-4000-8000-000000000001/meta.json", true},
		{http.MethodGet, "/v1/artifacts/5f0e1c4a-0000-4000-8000-000000000001/family-1/elevation.u16", true},
		{http.MethodGet, "/v1/artifacts", false},
		{http.MethodGet, "/v1/artifacts/levels", false},
		{http.MethodPut, "/v1/artifacts/5f0e1c4a-0000-4000-8000-000000000001/meta.json", false},
		{http.MethodPost, "/v1/artifacts/5f0e1c4a-0000-4000-8000-000000000001/write-link", false},
		{http.MethodDelete, "/v1/artifacts/5f0e1c4a-0000-4000-8000-000000000001", false},
		{http.MethodGet, LinkBase + "5f0e1c4a-0000-4000-8000-000000000001/meta.json", false},
	} {
		if got := AnonymousReads(httptest.NewRequest(c.method, c.path, nil)); got != c.want {
			t.Errorf("%s %s = %v, want %v", c.method, c.path, got, c.want)
		}
	}
}
