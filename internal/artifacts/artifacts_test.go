package artifacts

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The store's behaviour is covered in store_test.go; these tests cover the
// HTTP layer — the resolve handshake, status mapping, and the JSON shapes the
// client's artifactsClient.ts parses.

func newTestModule(t *testing.T) *http.ServeMux {
	t.Helper()
	store, err := NewStore(t.TempDir(), 0)
	if err != nil {
		t.Fatal(err)
	}
	m := &Module{store: store}
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
	// A listing sits between write and delete, as the panel's own flow does.
	// It is LOAD-BEARING here: removal cleans the key mapping through the
	// IN-MEMORY meta, which only a refresh (this listing) has read — delete
	// straight after the meta lands and the mapping leaks, so the key
	// resolves to a dropped uid. Found 2026-08-12 writing this test;
	// reported, deliberately not fixed in the same change.
	do(mux, http.MethodGet, "/v1/artifacts", "")

	if got := do(mux, http.MethodDelete, "/v1/artifacts/"+uid, "").Code; got != http.StatusNoContent {
		t.Fatalf("delete = %d, want 204", got)
	}
	if got := do(mux, http.MethodPost, "/v1/artifacts/resolve", resolveBody).Code; got != http.StatusNotFound {
		t.Errorf("resolve after delete = %d, want 404", got)
	}

	// And the by-world sweep, which the meta attribution makes possible.
	// (RemoveWorld refreshes itself, so no listing is needed here.)
	uid, _ = resolve(t, mux, true)
	writeMeta(t, mux, uid)
	if got := do(mux, http.MethodDelete, "/v1/artifacts?world=a754f0db-ff5c-4b45-9f2c-1b4e7a30d001", "").Code; got != http.StatusNoContent {
		t.Fatalf("delete by world = %d, want 204", got)
	}
	if got := do(mux, http.MethodPost, "/v1/artifacts/resolve", resolveBody).Code; got != http.StatusNotFound {
		t.Errorf("resolve after world sweep = %d, want 404", got)
	}
}
