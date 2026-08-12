package world

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/DebakelOrakel/casas-eternas/internal/config"
	"github.com/DebakelOrakel/casas-eternas/internal/identity"
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
