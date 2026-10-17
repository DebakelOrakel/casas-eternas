package world

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/config"
	"github.com/DebakelOrakel/casas-eternas/internal/identity"
	"github.com/DebakelOrakel/casas-eternas/internal/token"
)

// A world's terrain ids (Meta.Terrains, docs/decisions/artifacts-by-content.md,
// DEC-0039): only a job of the world records one, every upload carries the
// set across, a copy takes it, and the terrain's rank is the caller's
// highest over the worlds that hold it.
func TestTerrainsAreRecordedByTheJobAndCarried(t *testing.T) {
	tokens, err := token.NewTokens([]byte("a signing key long enough to be accepted"))
	if err != nil {
		t.Fatal(err)
	}
	session := func(id string, admin bool) string {
		t.Helper()
		raw, _, issueErr := tokens.IssueSession(id, admin, time.Hour)
		if issueErr != nil {
			t.Fatal(issueErr)
		}
		return raw
	}
	ada, grace, root := session("ada-id", false), session("grace-id", false), session("root-id", true)
	job, _, _ := tokens.IssueJob("job-1", sampleUID, time.Hour)
	otherJob, _, _ := tokens.IssueJob("job-2", "00000000-1111-4222-8333-444444444444", time.Hour)
	m := moduleOn(Config{Identity: identity.NewResolver(config.AuthPassword, tokens)}, newTestStore(t))
	mux := http.NewServeMux()
	if err := m.Mount(mux); err != nil {
		t.Fatal(err)
	}
	send := func(method, path, bearer string, body []byte, header map[string]string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(method, path, bytes.NewReader(body))
		if bearer != "" {
			request.Header.Set("Authorization", "Bearer "+bearer)
		}
		for k, v := range header {
			request.Header.Set(k, v)
		}
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, request)
		return recorder
	}
	terrainsOf := func(uid string) []string {
		t.Helper()
		meta, err := m.store.Get(t.Context(), uid)
		if err != nil {
			t.Fatal(err)
		}
		return meta.Terrains
	}
	rank := func(bearer, worldID string) (string, bool) {
		t.Helper()
		response := send(http.MethodGet, "/v1/worlds/terrain-access?worldId="+worldID, bearer, nil, nil)
		var answer struct {
			CallerLevel string `json:"callerLevel"`
			Shared      bool   `json:"shared"`
		}
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &answer) != nil {
			t.Fatalf("terrain-access = %d %s", response.Code, response.Body)
		}
		return answer.CallerLevel, answer.Shared
	}

	save := buildSave(t, sampleYAML(), []byte("PNG"), map[string][]byte{"payload": []byte("terrain")})
	if got := send(http.MethodPut, "/v1/worlds/"+sampleUID, ada, save, nil).Code; got != http.StatusCreated {
		t.Fatalf("create = %d", got)
	}
	report := func(bearer, worldID string) int {
		return send(http.MethodPost, "/v1/worlds/"+sampleUID+"/terrains", bearer, []byte(`{"worldId":"`+worldID+`"}`), nil).Code
	}
	for _, c := range []struct {
		who, bearer string
		want        int
	}{{"the owner", ada, http.StatusForbidden}, {"the job of another world", otherJob, http.StatusForbidden}, {"nobody", "", http.StatusForbidden}} {
		if got := report(c.bearer, "t1"); got != c.want {
			t.Errorf("%s reports a terrain = %d, want %d", c.who, got, c.want)
		}
	}
	if got := report(job, "not/an id"); got != http.StatusBadRequest {
		t.Errorf("a terrain id with a slash = %d, want 400", got)
	}
	if got := report(job, "t1"); got != http.StatusNoContent {
		t.Fatalf("the job reports its terrain = %d, want 204", got)
	}
	if got := report(job, "t1"); got != http.StatusNoContent {
		t.Errorf("the job reports it again = %d, want 204", got)
	}
	if got := terrainsOf(sampleUID); !slices.Equal(got, []string{"t1"}) {
		t.Fatalf("terrains = %v, want [t1]", got)
	}

	// An upload rebuilds the meta from the save; the set is the server's.
	again := buildSave(t, sampleYAML(), []byte("PNG"), map[string][]byte{"payload": []byte("other terrain")})
	if got := send(http.MethodPut, "/v1/worlds/"+sampleUID, ada, again, map[string]string{"If-Match": `"1"`}).Code; got != http.StatusOK {
		t.Fatalf("update = %d", got)
	}
	if got := terrainsOf(sampleUID); !slices.Equal(got, []string{"t1"}) {
		t.Errorf("terrains after an upload = %v, want [t1]", got)
	}

	if level, shared := rank(ada, "t1"); level != "owner" || shared {
		t.Errorf("the owner's rank on the terrain = %s shared %v, want owner alone", level, shared)
	}
	if level, _ := rank(grace, "t1"); level != "none" {
		t.Errorf("a stranger's rank on the terrain = %s, want none", level)
	}
	if level, _ := rank(ada, "t2"); level != "none" {
		t.Errorf("the owner's rank on a terrain no world holds = %s, want none", level)
	}
	if !AnonymousReads(httptest.NewRequest(http.MethodGet, "/v1/worlds/terrain-access?worldId=t1", nil)) {
		t.Error("the gate does not let an anonymous terrain-access through")
	}

	// A public template, and a copy of it: the copy takes the set, so the terrain
	// is shared, and its owner ranks on it at once.
	if got := send(http.MethodPut, "/v1/worlds/"+sampleUID+"/template", root, nil, nil).Code; got != http.StatusOK {
		t.Fatalf("template = %d", got)
	}
	if got := send(http.MethodPut, "/v1/worlds/"+sampleUID+"/visibility", root, []byte(`{"visibility":"public"}`), nil).Code; got != http.StatusOK {
		t.Fatalf("public = %d", got)
	}
	if level, _ := rank("", "t1"); level != "viewer" {
		t.Errorf("the anonymous rank on a template's terrain = %s, want viewer", level)
	}
	copied := send(http.MethodPost, "/v1/worlds/"+sampleUID+"/copy", grace, nil, nil)
	if copied.Code != http.StatusCreated {
		t.Fatalf("copy = %d", copied.Code)
	}
	var copyMeta Meta
	if err := json.Unmarshal(copied.Body.Bytes(), &copyMeta); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(copyMeta.Terrains, []string{"t1"}) {
		t.Errorf("the copy's terrains = %v, want [t1]", copyMeta.Terrains)
	}
	if level, shared := rank(grace, "t1"); level != "owner" || !shared {
		t.Errorf("the copy's owner on the terrain = %s shared %v, want owner, shared", level, shared)
	}
	if _, shared := rank("", "t1"); !shared {
		t.Error("the anonymous viewer of the template is not told that the terrain is shared")
	}
}
