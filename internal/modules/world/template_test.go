package world

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
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

// Template worlds (docs/decisions/template-worlds.md), end to end through real
// tokens and real grants: a template is readable by every caller, the
// anonymous one included; the mark is the admin's; a copy is a new world of
// the caller's with the source named in world.yaml.
//
// The gate in front is server.Gate's rule restated (nothing imports
// internal/server): a request without a caller is refused unless it carries
// no credentials and AnonymousReads accepts it. server/gate_test.go checks
// the gate keeps that rule.

type templateFixture struct {
	t       *testing.T
	m       *Module
	handler http.Handler
	ada     string // owns the world
	grace   string // a stranger to it
	root    string // the admin
}

func newTemplateFixture(t *testing.T) *templateFixture {
	t.Helper()
	tokens, err := token.NewTokens([]byte("a signing key long enough to be accepted"))
	if err != nil {
		t.Fatal(err)
	}
	issue := func(id string, admin bool) string {
		t.Helper()
		raw, _, issueErr := tokens.IssueSession(id, admin, time.Hour)
		if issueErr != nil {
			t.Fatal(issueErr)
		}
		return raw
	}
	resolver := identity.NewResolver(config.AuthPassword, tokens)
	m := moduleOn(Config{Identity: resolver}, newTestStore(t))
	mux := http.NewServeMux()
	if err := m.Mount(mux); err != nil {
		t.Fatal(err)
	}
	f := &templateFixture{
		t: t, m: m,
		handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if resolver.Caller(r) == identity.Anonymous && (r.Header.Get("Authorization") != "" || !AnonymousReads(r)) {
				http.Error(w, "authentication required", http.StatusUnauthorized)
				return
			}
			mux.ServeHTTP(w, r)
		}),
		ada: issue("ada-id", false), grace: issue("grace-id", false), root: issue("root-id", true),
	}
	save := buildSave(t, sampleYAML(), []byte("PNG"), map[string][]byte{"payload": []byte("terrain")})
	if got := f.as(http.MethodPut, "/v1/worlds/"+sampleUID, f.ada, save).Code; got != http.StatusCreated {
		t.Fatalf("create = %d", got)
	}
	return f
}

// as sends a request; an empty bearer sends none at all.
func (f *templateFixture) as(method, path, bearer string, body []byte) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, bytes.NewReader(body))
	if bearer != "" {
		request.Header.Set("Authorization", "Bearer "+bearer)
	}
	recorder := httptest.NewRecorder()
	f.handler.ServeHTTP(recorder, request)
	return recorder
}

func (f *templateFixture) list(bearer string) []listedWorld {
	f.t.Helper()
	response := f.as(http.MethodGet, "/v1/worlds", bearer, nil)
	if response.Code != http.StatusOK {
		f.t.Fatalf("list = %d", response.Code)
	}
	var listed []listedWorld
	if err := json.Unmarshal(response.Body.Bytes(), &listed); err != nil {
		f.t.Fatal(err)
	}
	return listed
}

var readRoutes = []string{
	"/v1/worlds/" + sampleUID,
	"/v1/worlds/" + sampleUID + "/meta",
	"/v1/worlds/" + sampleUID + "/preview.png",
}

func TestOnlyAnAdminSetsTheTemplateMark(t *testing.T) {
	f := newTemplateFixture(t)
	path := "/v1/worlds/" + sampleUID + "/template"
	// The owner may read the world, so the refusal says so (403); the
	// stranger may not, so it is the stranger's 404; nobody signed in is
	// stopped at the gate.
	if got := f.as(http.MethodPut, path, f.ada, nil).Code; got != http.StatusForbidden {
		t.Errorf("owner PUT template = %d, want 403", got)
	}
	if got := f.as(http.MethodPut, path, f.grace, nil).Code; got != http.StatusNotFound {
		t.Errorf("stranger PUT template = %d, want 404", got)
	}
	if got := f.as(http.MethodPut, path, "", nil).Code; got != http.StatusUnauthorized {
		t.Errorf("anonymous PUT template = %d, want 401", got)
	}

	before, _ := f.m.store.Get(context.Background(), sampleUID)
	response := f.as(http.MethodPut, path, f.root, nil)
	var meta Meta
	_ = json.Unmarshal(response.Body.Bytes(), &meta)
	if response.Code != http.StatusOK || !meta.Template {
		t.Fatalf("admin PUT template = %d, template %v", response.Code, meta.Template)
	}
	// A property of the stored world, not of its content.
	if meta.Revision != before.Revision || meta.ContentHash != before.ContentHash {
		t.Errorf("marking moved the content: revision %d→%d", before.Revision, meta.Revision)
	}
	// The owner's share path cannot take the mark away (nor give it).
	if err := f.m.store.WriteGrants(context.Background(), sampleUID, access.Grants{Owner: "ada-id"}); err != nil {
		t.Fatal(err)
	}
	if grants, _, _ := f.m.store.ReadGrants(context.Background(), sampleUID); !grants.Template {
		t.Error("WriteGrants removed the template mark")
	}
	// The owner may not remove it either; the admin may.
	if got := f.as(http.MethodDelete, path, f.ada, nil).Code; got != http.StatusForbidden {
		t.Errorf("owner DELETE template = %d, want 403", got)
	}
	if got := f.as(http.MethodDelete, path, f.root, nil).Code; got != http.StatusOK {
		t.Errorf("admin DELETE template = %d, want 200", got)
	}
	if meta, _ := f.m.store.Get(context.Background(), sampleUID); meta.Template {
		t.Error("the mark is still mirrored after its removal")
	}
}

func TestATemplateIsReadableByEveryone(t *testing.T) {
	f := newTemplateFixture(t)

	// Before the mark: private means invisible to the stranger (404), and
	// without credentials the answer is the gate's (401) — on the routes
	// the gate now lets through, too.
	for _, path := range readRoutes {
		if got := f.as(http.MethodGet, path, f.grace, nil).Code; got != http.StatusNotFound {
			t.Errorf("stranger GET %s = %d, want 404", path, got)
		}
		if got := f.as(http.MethodGet, path, "", nil).Code; got != http.StatusUnauthorized {
			t.Errorf("anonymous GET %s = %d, want 401", path, got)
		}
	}
	if listed := f.list(""); len(listed) != 0 {
		t.Errorf("anonymous list before the mark = %d entries, want 0", len(listed))
	}

	if _, err := f.m.store.SetTemplate(context.Background(), sampleUID, true); err != nil {
		t.Fatal(err)
	}
	for _, bearer := range []string{"", f.grace} {
		for _, path := range readRoutes {
			if got, want := f.as(http.MethodGet, path, bearer, nil).Code, readAnswer(path); got != want {
				t.Errorf("GET %s as %q = %d, want %d", path, bearer, got, want)
			}
		}
		listed := f.list(bearer)
		if len(listed) != 1 || !listed[0].Template || listed[0].CallerLevel != "viewer" {
			t.Errorf("list as %q = %+v, want the template, at viewer", bearer, listed)
		}
	}
	// Reading, nothing more.
	if got := f.as(http.MethodDelete, "/v1/worlds/"+sampleUID, f.grace, nil).Code; got != http.StatusForbidden {
		t.Errorf("stranger DELETE of a template = %d, want 403", got)
	}
	if got := f.as(http.MethodDelete, "/v1/worlds/"+sampleUID, "", nil).Code; got != http.StatusUnauthorized {
		t.Errorf("anonymous DELETE of a template = %d, want 401", got)
	}
	// The owner and the admin keep their own levels on it.
	for bearer, want := range map[string]string{f.ada: "owner", f.root: "admin"} {
		if listed := f.list(bearer); len(listed) != 1 || listed[0].CallerLevel != want {
			t.Errorf("list = %+v, want callerLevel %s", listed, want)
		}
	}
	// Credentials that do not verify are refused even here: a lapsed
	// session must learn it, not see the templates only.
	if got := f.as(http.MethodGet, "/v1/worlds", "nonsense", nil).Code; got != http.StatusUnauthorized {
		t.Errorf("a bad token on the list = %d, want 401", got)
	}
}

func TestACopyIsANewWorldOfTheCaller(t *testing.T) {
	f := newTemplateFixture(t)
	path := "/v1/worlds/" + sampleUID + "/copy"

	// Not readable, not copyable: the stranger's 404. Nobody signed in
	// cannot own a copy, so the gate refuses it.
	if got := f.as(http.MethodPost, path, f.grace, nil).Code; got != http.StatusNotFound {
		t.Errorf("stranger copy of a private world = %d, want 404", got)
	}
	if _, err := f.m.store.SetTemplate(context.Background(), sampleUID, true); err != nil {
		t.Fatal(err)
	}
	if got := f.as(http.MethodPost, path, "", nil).Code; got != http.StatusUnauthorized {
		t.Errorf("anonymous copy = %d, want 401", got)
	}

	response := f.as(http.MethodPost, path, f.grace, nil)
	if response.Code != http.StatusCreated {
		t.Fatalf("copy = %d: %s", response.Code, response.Body)
	}
	var meta Meta
	if err := json.Unmarshal(response.Body.Bytes(), &meta); err != nil {
		t.Fatal(err)
	}
	if meta.UID == sampleUID || !ValidUID(meta.UID) {
		t.Fatalf("copy uid = %q", meta.UID)
	}
	if meta.Owner != "grace-id" || meta.Revision != 1 || meta.Template || meta.Name != "alpha" || !meta.HasPreview {
		t.Errorf("copy meta = %+v, want grace's, revision 1, no template, the same name and a preview", meta)
	}
	grants, _, _ := f.m.store.ReadGrants(context.Background(), meta.UID)
	if grants.Owner != "grace-id" || grants.Template || grants.Public {
		t.Errorf("copy grants = %+v, want private and grace's", grants)
	}

	// The archive: world.yaml names the new uid and the source; every other
	// entry is the same bytes.
	copied, _, err := f.m.store.ReadCurrent(context.Background(), meta.UID)
	if err != nil {
		t.Fatal(err)
	}
	original, _, _ := f.m.store.ReadCurrent(context.Background(), sampleUID)
	yaml, entries := unzip(t, copied)
	_, sourceEntries := unzip(t, original)
	if uid, _ := readYAMLValue(yaml, "metadata.uid"); uid != meta.UID {
		t.Errorf("copy's world.yaml uid = %q, want %q", uid, meta.UID)
	}
	if from, _ := readYAMLValue(yaml, "metadata.annotations."+CopiedFromAnnotation); from != sampleUID {
		t.Errorf("copied-from annotation = %q, want %q\n%s", from, sampleUID, yaml)
	}
	if seed, _ := readYAMLValue(yaml, "spec.seed"); seed != "alpha" {
		t.Errorf("the spec moved: seed %q", seed)
	}
	for _, name := range []string{"payload", "preview.png"} {
		if !bytes.Equal(entries[name], sourceEntries[name]) {
			t.Errorf("entry %s differs from the source's", name)
		}
	}
	// The copy is grace's to open and write: she sees it as its owner, and
	// the stranger to it (ada, the template's owner) does not see it at all.
	if listed := f.list(f.grace); len(listed) != 2 {
		t.Errorf("grace lists %d worlds, want the template and her copy", len(listed))
	}
	if got := f.as(http.MethodGet, "/v1/worlds/"+meta.UID, f.ada, nil).Code; got != http.StatusNotFound {
		t.Errorf("ada GET of grace's copy = %d, want 404", got)
	}

	// A copy of a copy names its direct source, once.
	second := f.as(http.MethodPost, "/v1/worlds/"+meta.UID+"/copy", f.grace, nil)
	var secondMeta Meta
	_ = json.Unmarshal(second.Body.Bytes(), &secondMeta)
	data, _, _ := f.m.store.ReadCurrent(context.Background(), secondMeta.UID)
	yaml, _ = unzip(t, data)
	if from, _ := readYAMLValue(yaml, "metadata.annotations."+CopiedFromAnnotation); from != meta.UID || strings.Count(yaml, CopiedFromAnnotation) != 1 {
		t.Errorf("copy of a copy: annotation %q, %d times\n%s", from, strings.Count(yaml, CopiedFromAnnotation), yaml)
	}
}

// Readable is enough: an editor or viewer may copy a shared world that is
// no template — the bytes are theirs to download anyway.
func TestAReadableWorldMayBeCopiedWithoutTheMark(t *testing.T) {
	f := newTemplateFixture(t)
	if err := f.m.store.WriteGrants(context.Background(), sampleUID,
		access.Grants{Owner: "ada-id", Users: map[string]string{"grace-id": "viewer"}}); err != nil {
		t.Fatal(err)
	}
	if got := f.as(http.MethodPost, "/v1/worlds/"+sampleUID+"/copy", f.grace, nil).Code; got != http.StatusCreated {
		t.Errorf("viewer copy = %d, want 201", got)
	}
}

func TestTheMarkNeedsGrants(t *testing.T) {
	s := newTestStore(t)
	if _, err := putAs(t, s, sampleUID, "first", "ada", 0); err != nil {
		t.Fatal(err)
	}
	removeObject(t, s, grantsKey(sampleUID))
	if _, err := s.SetTemplate(context.Background(), sampleUID, true); err != ErrNoGrants {
		t.Errorf("mark on a legacy world = %v, want ErrNoGrants", err)
	}
}

func TestWithCopyIdentityKeepsOtherAnnotations(t *testing.T) {
	yaml := "apiVersion: casas-eternas/v1alpha1\nkind: FlatWorld\nmetadata:\n  name: a\n  uid: old\n  annotations:\n    example/note: kept\n    " + CopiedFromAnnotation + ": older\nspec:\n  seed: s\n"
	out, err := withCopyIdentity(yaml, "new", "old")
	if err != nil {
		t.Fatal(err)
	}
	want := "apiVersion: casas-eternas/v1alpha1\nkind: FlatWorld\nmetadata:\n  name: a\n  uid: new\n  annotations:\n    example/note: kept\n    " + CopiedFromAnnotation + ": old\nspec:\n  seed: s\n"
	if out != want {
		t.Errorf("rewrite =\n%s\nwant\n%s", out, want)
	}
	if _, err := withCopyIdentity("spec:\n  seed: s\n", "new", "old"); err == nil {
		t.Error("a world.yaml without metadata was rewritten")
	}
}

func unzip(t *testing.T, data []byte) (string, map[string][]byte) {
	t.Helper()
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	entries := map[string][]byte{}
	for _, file := range reader.File {
		rc, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		raw, err := io.ReadAll(rc)
		_ = rc.Close()
		if err != nil {
			t.Fatal(err)
		}
		entries[file.Name] = raw
	}
	return string(entries["world.yaml"]), entries
}

func TestAnonymousReadsAreTheFourReadRoutes(t *testing.T) {
	cases := map[string]bool{
		"GET /v1/worlds":                                    true,
		"GET /v1/worlds/" + sampleUID:                       true,
		"GET /v1/worlds/" + sampleUID + "/meta":             true,
		"GET /v1/worlds/" + sampleUID + "/preview.png":      true,
		"GET /v1/worlds/" + sampleUID + "/grants":           false,
		"GET /v1/worlds/not-a-uid":                          false,
		"POST /v1/worlds/" + sampleUID + "/copy":            false,
		"PUT /v1/worlds/" + sampleUID:                       false,
		"DELETE /v1/worlds/" + sampleUID:                    false,
		"GET /v1/artifacts":                                 false,
		"GET /v1/worlds/" + sampleUID + "/preview.png/../x": false,
	}
	for line, want := range cases {
		method, path, _ := strings.Cut(line, " ")
		if got := AnonymousReads(httptest.NewRequest(method, path, nil)); got != want {
			t.Errorf("%s = %v, want %v", line, got, want)
		}
	}
}
