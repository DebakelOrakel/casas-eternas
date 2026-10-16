package artifacts

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/access"
	"github.com/DebakelOrakel/casas-eternas/internal/blob"
	"github.com/DebakelOrakel/casas-eternas/internal/config"
	"github.com/DebakelOrakel/casas-eternas/internal/identity"
	"github.com/DebakelOrakel/casas-eternas/internal/token"
)

// Writes by link (DEC-0038, fork 7): a writer asks for a write link per
// file with its length, uploads to the bucket, and commits; the index
// learns of the files only at the commit.

// writeLink asks the module for a write link as `token` (empty: none).
func writeLink(t *testing.T, mux *http.ServeMux, uid, name string, size int, token string) (*httptest.ResponseRecorder, writeLinkResponse) {
	t.Helper()
	body := `{"name":"` + name + `","size":` + strconv.Itoa(size) + `}`
	response := doAs(mux, http.MethodPost, "/v1/artifacts/"+uid+"/write-link", body, token)
	var link writeLinkResponse
	if response.Code == http.StatusOK {
		if err := json.Unmarshal(response.Body.Bytes(), &link); err != nil {
			t.Fatal(err)
		}
	}
	return response, link
}

// putTo sends `body` to a dir link with the length the request has.
func putTo(mux *http.ServeMux, target, body string) int {
	request := httptest.NewRequest(http.MethodPut, target, strings.NewReader(body))
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)
	return recorder.Code
}

func commit(mux *http.ServeMux, uid, token string, files ...Upload) *httptest.ResponseRecorder {
	raw, _ := json.Marshal(commitRequest{Files: files})
	return doAs(mux, http.MethodPost, "/v1/artifacts/"+uid+"/commit", string(raw), token)
}

// The whole path on dir: link, upload, commit, read.
func TestDirWriteByLinkAndCommit(t *testing.T) {
	m, mux := newModule(t, openTestDir(t, t.TempDir()), identity.NewResolver(config.AuthNone, nil),
		func(context.Context, string, string) (bool, access.Level) { return true, access.Admin })
	uid, _ := resolve(t, mux, true)
	payload := "raster-bytes"
	response, link := writeLink(t, mux, uid, "elevation.f32", len(payload), "")
	if response.Code != http.StatusOK {
		t.Fatalf("write-link = %d %s", response.Code, response.Body)
	}
	u, _ := url.Parse(link.URL)
	if link.Method != http.MethodPut || u.Host != "" || u.Path != LinkBase+uid+"/elevation.f32" || u.Query().Get("len") != "12" {
		t.Fatalf("link %s %q: want a PUT under %s with the length signed in", link.Method, link.URL, LinkBase)
	}
	if left := time.Until(link.Expires); left < 59*time.Minute || left > time.Hour {
		t.Errorf("link lives %v, want about the write-link-ttl of 1h", left)
	}
	if !m.SignedRequest(httptest.NewRequest(http.MethodPut, link.URL, nil)) {
		t.Error("the gate predicate refuses a valid write link")
	}
	if code := putTo(mux, link.URL, payload); code != http.StatusOK {
		t.Fatalf("upload = %d", code)
	}
	// Uploaded, not committed: the index does not know it yet.
	if _, files := resolve(t, mux, false); len(files) != 0 {
		t.Errorf("files before the commit = %v", files)
	}
	if code := do(mux, http.MethodGet, "/v1/artifacts/"+uid+"/elevation.f32", "").Code; code != http.StatusNotFound {
		t.Errorf("read before the commit = %d, want 404", code)
	}

	meta := metaFor(Key{WorldUID: "a754f0db-ff5c-4b45-9f2c-1b4e7a30d001", WorldID: "ba90bda173d581ef", PipelineVersion: "v6", Stage: "2"}, "linked")
	_, metaLink := writeLink(t, mux, uid, "meta.json", len(meta), "")
	if code := putTo(mux, metaLink.URL, meta); code != http.StatusOK {
		t.Fatalf("meta upload = %d", code)
	}
	if got := commit(mux, uid, "", Upload{"elevation.f32", int64(len(payload))}, Upload{"meta.json", int64(len(meta))}); got.Code != http.StatusNoContent {
		t.Fatalf("commit = %d %s", got.Code, got.Body)
	}
	if _, files := resolve(t, mux, false); strings.Join(files, ",") != "elevation.f32,meta.json" {
		t.Errorf("files after the commit = %v", files)
	}
	whole, _ := m.store.Whole(context.Background(), []Key{{WorldUID: "a754f0db-ff5c-4b45-9f2c-1b4e7a30d001", WorldID: "ba90bda173d581ef", PipelineVersion: "v6", Stage: "2"}})
	if !whole[0] {
		t.Error("the commit with the meta did not make the artifact whole")
	}
	if read := follow(t, mux, "/v1/artifacts/"+uid+"/elevation.f32", ""); read.Code != http.StatusOK || read.Body.String() != payload {
		t.Errorf("read after the commit = %d %q", read.Code, read.Body.String())
	}
	// A restart indexes it as well: it is in the bucket.
	if usage, _ := m.store.Usage(context.Background()); usage != int64(len(payload)+len(meta)) {
		t.Errorf("usage = %d", usage)
	}
}

// A write link allows exactly its key, its length and its lifetime.
func TestDirWriteLinkRefusals(t *testing.T) {
	m, mux := newModule(t, openTestDir(t, t.TempDir()), identity.NewResolver(config.AuthNone, nil),
		func(context.Context, string, string) (bool, access.Level) { return true, access.Admin })
	uid, _ := resolve(t, mux, true)
	_, link := writeLink(t, mux, uid, "a.f32", 5, "")
	u, _ := url.Parse(link.URL)
	q := u.Query()
	with := func(path string, change func(url.Values)) string {
		v := url.Values{}
		for k, vs := range q {
			v[k] = append([]string(nil), vs...)
		}
		change(v)
		return path + "?" + v.Encode()
	}
	keyB := strings.Replace(u.Path, "a.f32", "b.f32", 1)
	cases := []struct {
		name, target, body string
		want               int
	}{
		{"key A's link for key B", with(keyB, func(url.Values) {}), "AAAAA", http.StatusForbidden},
		{"another uid", with(LinkBase+"00000000-dead-4bee-8888-000000000000/a.f32", func(url.Values) {}), "AAAAA", http.StatusForbidden},
		{"a shorter body", link.URL, "AAA", http.StatusForbidden},
		{"a longer body", link.URL, "AAAAAAA", http.StatusForbidden},
		{"a changed length", with(u.Path, func(v url.Values) { v.Set("len", "7") }), "AAAAAAA", http.StatusForbidden},
		{"a changed signature", with(u.Path, func(v url.Values) {
			sig := []byte(v.Get("sig"))
			sig[0] ^= 1
			v.Set("sig", string(sig))
		}), "AAAAA", http.StatusForbidden},
		{"a later expiry", with(u.Path, func(v url.Values) {
			exp, _ := strconv.ParseInt(v.Get("exp"), 10, 64)
			v.Set("exp", strconv.FormatInt(exp+3600, 10))
		}), "AAAAA", http.StatusForbidden},
		{"no length", with(u.Path, func(v url.Values) { v.Del("len") }), "AAAAA", http.StatusForbidden},
		{"traversal", with(LinkBase+uid+"/%2e%2e/%2e%2e/etc/passwd", func(url.Values) {}), "AAAAA", http.StatusForbidden},
		{"traversal in the key", with(LinkBase+"%2e%2e/"+uid+"/a.f32", func(url.Values) {}), "AAAAA", http.StatusForbidden},
	}
	for _, c := range cases {
		if got := putTo(mux, c.target, c.body); got != c.want {
			t.Errorf("%s: PUT %s = %d, want %d", c.name, c.target, got, c.want)
		}
	}
	// None of them wrote anything: only the right key, length, lifetime do.
	for _, name := range []string{"a.f32", "b.f32"} {
		if _, err := readFile(t, m.store, uid, name); !errors.Is(err, blob.ErrNotFound) {
			t.Errorf("%s was written by a refused upload: %v", name, err)
		}
	}
	// A read link is no write link, and a write link is no read link.
	if m.SignedRequest(httptest.NewRequest(http.MethodGet, link.URL, nil)) {
		t.Error("the gate predicate lets a GET through on a write link")
	}
	if got := do(mux, http.MethodGet, link.URL, "").Code; got != http.StatusForbidden {
		t.Errorf("GET on a write link = %d, want 403", got)
	}
	if m.SignedRequest(httptest.NewRequest(http.MethodPut, with(keyB, func(url.Values) {}), nil)) {
		t.Error("the gate predicate lets a PUT to another key through")
	}
	if code := putTo(mux, link.URL, "AAAAA"); code != http.StatusOK {
		t.Errorf("the link itself = %d", code)
	}

	// Expired: 410, and the gate lets it reach the route.
	short, err := m.store.WriteLink(context.Background(), uid, "c.f32", 2, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(time.Until(short.Expires) + 20*time.Millisecond)
	if got := putTo(mux, short.URL, "cc"); got != http.StatusGone {
		t.Errorf("expired write link = %d, want 410", got)
	}
	if !m.SignedRequest(httptest.NewRequest(http.MethodPut, short.URL, nil)) {
		t.Error("the gate predicate refuses an expired write link of ours")
	}

	// The route refuses what it cannot sign.
	for _, c := range []struct {
		name, body string
		want       int
	}{
		{"negative size", `{"name":"x.f32","size":-1}`, http.StatusBadRequest},
		{"too large", `{"name":"x.f32","size":` + strconv.Itoa(UploadLimit+1) + `}`, http.StatusRequestEntityTooLarge},
		{"a meta too large", `{"name":"meta.json","size":` + strconv.Itoa(metaLimit+1) + `}`, http.StatusRequestEntityTooLarge},
		{"a bad name", `{"name":"../x","size":1}`, http.StatusBadRequest},
		{"no name", `{"size":1}`, http.StatusBadRequest},
	} {
		if got := do(mux, http.MethodPost, "/v1/artifacts/"+uid+"/write-link", c.body).Code; got != c.want {
			t.Errorf("write-link, %s = %d, want %d", c.name, got, c.want)
		}
	}
	if got := do(mux, http.MethodPost, "/v1/artifacts/00000000-dead-4bee-8888-000000000000/write-link", `{"name":"x","size":1}`).Code; got != http.StatusNotFound {
		t.Errorf("write-link into an unminted uid = %d, want 404", got)
	}
}

// The commit enters only what is in the bucket as said, and only what was
// signed.
func TestCommitChecksTheBucket(t *testing.T) {
	_, mux := newModule(t, openTestDir(t, t.TempDir()), identity.NewResolver(config.AuthNone, nil),
		func(context.Context, string, string) (bool, access.Level) { return true, access.Admin })
	uid, _ := resolve(t, mux, true)
	_, link := writeLink(t, mux, uid, "a.f32", 3, "")
	cases := []struct {
		name  string
		files []Upload
		want  int
	}{
		{"before the upload", []Upload{{"a.f32", 3}}, http.StatusConflict},
		{"a name never signed", []Upload{{"b.f32", 3}}, http.StatusConflict},
		{"a bad name", []Upload{{"../a.f32", 3}}, http.StatusBadRequest},
	}
	for _, c := range cases {
		if got := commit(mux, uid, "", c.files...).Code; got != c.want {
			t.Errorf("commit %s = %d, want %d", c.name, got, c.want)
		}
	}
	if code := putTo(mux, link.URL, "abc"); code != http.StatusOK {
		t.Fatalf("upload = %d", code)
	}
	if got := commit(mux, uid, "", Upload{"a.f32", 4}).Code; got != http.StatusConflict {
		t.Errorf("commit of another size = %d, want 409", got)
	}
	if got := commit(mux, uid, "", Upload{"a.f32", 3}, Upload{"b.f32", 3}).Code; got != http.StatusConflict {
		t.Errorf("commit with one unsigned file = %d, want 409", got)
	}
	// Either all or nothing: the refused commit entered nothing.
	if _, files := resolve(t, mux, false); len(files) != 0 {
		t.Errorf("files after refused commits = %v", files)
	}
	if got := commit(mux, uid, "").Code; got != http.StatusBadRequest {
		t.Errorf("commit of nothing = %d, want 400", got)
	}
	if got := commit(mux, "00000000-dead-4bee-8888-000000000000", "", Upload{"a.f32", 3}).Code; got != http.StatusNotFound {
		t.Errorf("commit into an unminted uid = %d, want 404", got)
	}
	if got := commit(mux, uid, "", Upload{"a.f32", 3}).Code; got != http.StatusNoContent {
		t.Errorf("commit = %d", got)
	}
	if _, files := resolve(t, mux, false); len(files) != 1 {
		t.Errorf("files after the commit = %v", files)
	}
}

// The routes need the right to write the artifact's world: a job token for
// that world, not for another, and not none.
func TestWriteLinksNeedTheJobsWorld(t *testing.T) {
	tokens, err := token.NewTokens([]byte("a signing key long enough to be accepted"))
	if err != nil {
		t.Fatal(err)
	}
	const worldUID = "a754f0db-ff5c-4b45-9f2c-1b4e7a30d001"
	_, mux := newModule(t, openTestDir(t, t.TempDir()), identity.NewResolver(config.AuthPassword, tokens),
		func(context.Context, string, string) (bool, access.Level) { return false, access.None })
	rightJob, _, _ := tokens.IssueJob("job-1", worldUID, time.Hour)
	wrongJob, _, _ := tokens.IssueJob("job-2", "00000000-1111-4222-8333-444444444444", time.Hour)
	created := doAs(mux, http.MethodPost, "/v1/artifacts/resolve", strings.TrimSuffix(resolveBody, "}")+`,"create":true}`, rightJob)
	var minted struct {
		ArtifactUID string `json:"artifactUid"`
	}
	_ = json.Unmarshal(created.Body.Bytes(), &minted)
	if minted.ArtifactUID == "" {
		t.Fatalf("job resolve = %d", created.Code)
	}
	uid := minted.ArtifactUID
	for _, c := range []struct {
		who, token string
		want       int
	}{{"no token", "", http.StatusNotFound}, {"another world's job", wrongJob, http.StatusNotFound}, {"the job's own", rightJob, http.StatusOK}} {
		if got, _ := writeLink(t, mux, uid, "a.f32", 3, c.token); got.Code != c.want {
			t.Errorf("write-link, %s = %d, want %d", c.who, got.Code, c.want)
		}
	}
	_, link := writeLink(t, mux, uid, "a.f32", 3, rightJob)
	if code := putTo(mux, link.URL, "abc"); code != http.StatusOK {
		t.Fatalf("upload = %d", code)
	}
	for _, c := range []struct {
		who, token string
		want       int
	}{{"no token", "", http.StatusNotFound}, {"another world's job", wrongJob, http.StatusNotFound}, {"the job's own", rightJob, http.StatusNoContent}} {
		if got := commit(mux, uid, c.token, Upload{"a.f32", 3}).Code; got != c.want {
			t.Errorf("commit, %s = %d, want %d", c.who, got, c.want)
		}
	}
}

// A file uploaded by link and never committed goes with its artifact, and
// the sweep spares an artifact while a write link of it is valid.
func TestPendingUploadsAreRemovedAndSpared(t *testing.T) {
	dir := t.TempDir()
	store := newStoreAt(t, dir, 0)
	ctx := context.Background()
	uid, _, _ := store.Resolve(ctx, testKey(), true)
	if _, err := store.WriteLink(ctx, uid, "a.f32", 3, time.Hour); err != nil {
		t.Fatal(err)
	}
	// The writer's upload, straight into the bucket.
	key, _ := objectKey(uid, "a.f32")
	if _, err := store.bucket.Put(ctx, key, strings.NewReader("abc"), 3, blob.PutOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := store.RemoveArtifact(ctx, uid); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, uid, "a.f32")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("an uncommitted upload stayed after the removal: %v", err)
	}

	// The sweep: an entry that uploads is not taken, though it is the
	// least recently used.
	capped := newStoreAt(t, t.TempDir(), 400)
	tick(capped)
	uploading, _, _ := capped.Resolve(ctx, Key{WorldUID: "uid-a", WorldID: "1111111111111111", PipelineVersion: "v6-a", Stage: "2"}, true)
	if err := write(capped, uploading, "old.f32", strings.Repeat("o", 150)); err != nil {
		t.Fatal(err)
	}
	if _, err := capped.WriteLink(ctx, uploading, "more.f32", 10, time.Hour); err != nil {
		t.Fatal(err)
	}
	// Two more artifacts push the store over its cap.
	bake(t, capped, Key{WorldUID: "uid-b", WorldID: "2222222222222222", PipelineVersion: "v6-a", Stage: "2"}, "B", strings.Repeat("b", 90))
	bake(t, capped, Key{WorldUID: "uid-c", WorldID: "3333333333333333", PipelineVersion: "v6-a", Stage: "2"}, "C", strings.Repeat("c", 90))
	capped.mu.Lock()
	_, kept := capped.entries[uploading]
	capped.mu.Unlock()
	if !kept {
		t.Error("the sweep took an artifact whose write link is valid")
	}
}

// On s3 the write link is a presigned PUT on the provider with the length
// signed in; the bytes do not pass through the module, and the commit's
// Head finds them. (The fake checks no signature: what the provider
// refuses is measured in TestAWSWireArtifacts.)
func TestS3WriteByPresignedPut(t *testing.T) {
	fake, srv, bucket := openFakeS3(t, map[string][]byte{})
	_, mux := newModule(t, bucket, identity.NewResolver(config.AuthNone, nil),
		func(context.Context, string, string) (bool, access.Level) { return true, access.Admin })
	uid, _ := resolve(t, mux, true)
	response, link := writeLink(t, mux, uid, "elevation.u16", 12, "")
	if response.Code != http.StatusOK {
		t.Fatalf("write-link = %d %s", response.Code, response.Body)
	}
	u, _ := url.Parse(link.URL)
	if link.Method != http.MethodPut || !strings.HasPrefix(link.URL, srv.URL+"/artifacts/run/"+uid+"/elevation.u16?") ||
		!strings.Contains(u.Query().Get("X-Amz-SignedHeaders"), "content-length") || u.Query().Get("X-Amz-Expires") != "3600" {
		t.Fatalf("link %s %q: want a presigned PUT with content-length signed and 1h to live", link.Method, link.URL)
	}
	for name := range link.Header {
		if strings.EqualFold(name, "Content-Length") || strings.EqualFold(name, "Host") {
			t.Errorf("the link names header %s, which the client sets itself", name)
		}
	}
	put, _ := http.NewRequest(link.Method, link.URL, strings.NewReader("raster-bytes"))
	for name, value := range link.Header {
		put.Header.Set(name, value)
	}
	res, err := srv.Client().Do(put)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("upload = %d", res.StatusCode)
	}
	if got := commit(mux, uid, "", Upload{"elevation.u16", 12}); got.Code != http.StatusNoContent {
		t.Fatalf("commit = %d %s", got.Code, got.Body)
	}
	if _, files := resolve(t, mux, false); len(files) != 1 {
		t.Errorf("files = %v", files)
	}
	fake.DeleteObject("artifacts", "run/"+uid+"/elevation.u16")
	if got := commit(mux, uid, "", Upload{"elevation.u16", 12}); got.Code != http.StatusConflict {
		t.Errorf("commit of an object that is not there = %d, want 409", got.Code)
	}
}

// The two 409s of write-link can be told apart: a whole artifact (another
// writer committed first, the bytes are there) carries the code
// "committed" in the body; too many uncommitted files carries none. The
// worker treats the first as "already written" and the second as a refusal.
func TestWriteLinkConflictsCarryACode(t *testing.T) {
	_, mux := newModule(t, openTestDir(t, t.TempDir()), identity.NewResolver(config.AuthNone, nil),
		func(context.Context, string, string) (bool, access.Level) { return true, access.Admin })
	codeOf := func(r *httptest.ResponseRecorder) string {
		var body struct {
			Code string `json:"code"`
		}
		_ = json.Unmarshal(r.Body.Bytes(), &body)
		return body.Code
	}
	uid, _ := resolve(t, mux, true)
	meta := metaFor(Key{WorldUID: "a754f0db-ff5c-4b45-9f2c-1b4e7a30d001", WorldID: "ba90bda173d581ef", PipelineVersion: "v6", Stage: "2"}, "whole")
	_, metaLink := writeLink(t, mux, uid, metaName, len(meta), "")
	for i := range maxPendingFiles - 1 {
		if got, _ := writeLink(t, mux, uid, "f"+strconv.Itoa(i), 1, ""); got.Code != http.StatusOK {
			t.Fatalf("link %d = %d", i, got.Code)
		}
	}
	full, _ := writeLink(t, mux, uid, "one-more", 1, "")
	if full.Code != http.StatusConflict || codeOf(full) == WriteLinkCommitted {
		t.Errorf("too many pending = %d %s, want 409 without the code %q", full.Code, full.Body, WriteLinkCommitted)
	}

	if code := putTo(mux, metaLink.URL, meta); code != http.StatusOK {
		t.Fatalf("meta upload = %d", code)
	}
	if got := commit(mux, uid, "", Upload{metaName, int64(len(meta))}); got.Code != http.StatusNoContent {
		t.Fatalf("commit = %d %s", got.Code, got.Body)
	}
	whole, _ := writeLink(t, mux, uid, "f0", 1, "")
	if whole.Code != http.StatusConflict || codeOf(whole) != WriteLinkCommitted {
		t.Errorf("write-link for a whole artifact = %d %s, want 409 with the code %q", whole.Code, whole.Body, WriteLinkCommitted)
	}
}
