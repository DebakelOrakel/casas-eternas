package world

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/DebakelOrakel/casas-eternas/internal/access"
	"github.com/DebakelOrakel/casas-eternas/internal/blob"
	"github.com/DebakelOrakel/casas-eternas/internal/config"
	"github.com/DebakelOrakel/casas-eternas/internal/identity"
)

// The world store on the blob leaf (DEC-0038, step 5): the same behaviour on
// a Dir and on S3 (the fake, aws and ceph rows), the layout an older server
// wrote, the index built again from a List, and the conditional write that
// keeps a second writer from overwriting a revision.

// testBackends are the buckets the store runs on: a Dir, and the fake S3
// with the aws row (conditional writes) and the ceph row (none).
func testBackends() map[string]func(t *testing.T) blob.Bucket {
	return map[string]func(t *testing.T) blob.Bucket{
		"dir": func(t *testing.T) blob.Bucket { return testDir(t, t.TempDir()) },
		"aws": func(t *testing.T) blob.Bucket {
			_, srv := newFakeS3(t)
			return openFakeBucket(t, srv, blob.FlavourAWS)
		},
		"ceph": func(t *testing.T) blob.Bucket {
			_, srv := newFakeS3(t)
			return openFakeBucket(t, srv, blob.FlavourCeph)
		},
	}
}

func adminModule(store *Store) (*Module, *http.ServeMux) {
	m := &Module{cfg: Config{Identity: identity.NewResolver(config.AuthNone, nil)}, store: store}
	mux := http.NewServeMux()
	_ = m.Mount(mux)
	return m, mux
}

// Every route on every backend: upload, update, dedupe, list, read, preview,
// template mark, copy, prune, a restart, delete.
func TestTheStoreBehavesTheSameOnEveryBackend(t *testing.T) {
	for name, open := range testBackends() {
		t.Run(name, func(t *testing.T) {
			bucket := open(t)
			s := newTestStoreOn(t, bucket, 2)
			_, mux := adminModule(s)

			if got := upload(t, mux, sampleUID, "").Code; got != http.StatusCreated {
				t.Fatalf("create = %d", got)
			}
			for _, rev := range []string{"1", "2"} {
				if got := upload(t, mux, sampleUID, rev).Code; got != http.StatusOK {
					t.Fatalf("update from %s = %d", rev, got)
				}
			}
			if got := upload(t, mux, sampleUID, "1").Code; got != http.StatusPreconditionFailed {
				t.Errorf("stale update = %d, want 412", got)
			}
			if got := upload(t, mux, sampleUID, "").Code; got != http.StatusConflict {
				t.Errorf("create over a world = %d, want 409", got)
			}
			// Dedupe: the same bytes again mint nothing.
			data := buildSave(t, sampleYAML(), []byte("PNG"), map[string][]byte{"payload": []byte("body-2")})
			if got := do(mux, http.MethodPut, "/v1/worlds/"+sampleUID, data, map[string]string{"If-Match": "3"}); got.Code != http.StatusOK || got.Header().Get("ETag") != `"3"` {
				t.Errorf("identical re-upload = %d, ETag %s; want 200 and revision 3", got.Code, got.Header().Get("ETag"))
			}
			// Prune: with 2 kept, revision 1 is gone, 2 and 3 stay.
			if storedUnder(t, s, revPrefix(sampleUID, 1)) != 0 || !stored(t, s, revKey(sampleUID, 2, zipName)) || storedUnder(t, s, revPrefix(sampleUID, 4)) != 0 {
				t.Error("retention did not keep exactly revisions 2 and 3")
			}

			get := do(mux, http.MethodGet, "/v1/worlds/"+sampleUID, nil, nil)
			if get.Code != http.StatusOK || !bytes.Equal(get.Body.Bytes(), data) {
				t.Errorf("read back = %d, %d bytes", get.Code, get.Body.Len())
			}
			if got := do(mux, http.MethodGet, "/v1/worlds/"+sampleUID+"/preview.png", nil, nil); got.Code != http.StatusOK || got.Body.String() != "PNG" {
				t.Errorf("preview = %d %q", got.Code, got.Body)
			}
			if got := do(mux, http.MethodPut, "/v1/worlds/"+sampleUID+"/template", nil, nil).Code; got != http.StatusOK {
				t.Errorf("template mark = %d", got)
			}
			copied := do(mux, http.MethodPost, "/v1/worlds/"+sampleUID+"/copy", nil, nil)
			var copyMeta Meta
			if copied.Code != http.StatusCreated || json.Unmarshal(copied.Body.Bytes(), &copyMeta) != nil || copyMeta.Revision != 1 || copyMeta.Template {
				t.Fatalf("copy = %d %s", copied.Code, copied.Body)
			}

			// A restart: a new store on the same bucket knows the same.
			before, _ := s.List(context.Background())
			again := newTestStoreOn(t, bucket, 2)
			after, err := again.List(context.Background())
			if err != nil || len(after) != 2 || len(before) != 2 {
				t.Fatalf("after a restart: %d worlds (before %d), err %v", len(after), len(before), err)
			}
			for i := range after {
				if after[i] != before[i] {
					t.Errorf("world %d after a restart = %+v, before %+v", i, after[i], before[i])
				}
			}
			if g, found, err := again.ReadGrants(context.Background(), sampleUID); err != nil || !found || !g.Template || g.Owner != identity.Local {
				t.Errorf("grants after a restart = %+v, found %v, err %v", g, found, err)
			}
			if _, mux2 := adminModule(again); upload(t, mux2, sampleUID, "3").Code != http.StatusOK {
				t.Error("an update after a restart failed")
			}

			if got := do(mux, http.MethodDelete, "/v1/worlds/"+copyMeta.UID, nil, nil).Code; got != http.StatusNoContent {
				t.Errorf("delete = %d", got)
			}
			if n := storedUnder(t, s, copyMeta.UID+"/"); n != 0 {
				t.Errorf("%d objects of a deleted world stay", n)
			}
		})
	}
}

// A store opened on the bucket that an older server wrote (the files it
// made with rename, before the leaf): no migration, and every read and
// write works on it. The fixture is the old layout exactly, with what a
// directory gathers besides: an editor's .DS_Store, a temp file of an
// interrupted write, a stray file at the top.
func TestTheStoreOpensTheOldLayout(t *testing.T) {
	root := t.TempDir()
	world := filepath.Join(root, sampleUID)
	zip1 := buildSave(t, sampleYAML(), []byte("PNG1"), map[string][]byte{"payload": []byte("one")})
	zip2 := buildSave(t, sampleYAML(), []byte("PNG2"), map[string][]byte{"payload": []byte("two")})
	files := map[string][]byte{
		// Written by the code of 2026-08: no kind, progress or template yet.
		"meta.json": []byte(`{
  "uid": "` + sampleUID + `",
  "name": "alpha",
  "owner": "ada-id",
  "revision": 2,
  "createdAt": "2026-08-12T10:00:00Z",
  "updatedAt": "2026-08-13T10:00:00Z",
  "size": ` + strconv.Itoa(len(zip2)) + `,
  "erosionRun": 3,
  "hasPreview": true,
  "seed": "alpha",
  "generator": "old-build",
  "contentHash": "abc"
}
`),
		"grants.json":          []byte("{\n  \"owner\": \"ada-id\"\n}\n"),
		"rev/1/world.zip":      zip1,
		"rev/1/preview.png":    []byte("PNG1"),
		"rev/1/meta.json":      []byte(`{"revision":1,"size":1,"erosionRun":3,"hasPreview":true,"createdAt":"2026-08-12T10:00:00Z"}`),
		"rev/2/world.zip":      zip2,
		"rev/2/preview.png":    []byte("PNG2"),
		"rev/2/meta.json":      []byte(`{"revision":2,"size":1,"erosionRun":3,"hasPreview":true,"createdAt":"2026-08-13T10:00:00Z","contentHash":"abc"}`),
		".DS_Store":            []byte("finder"),
		"rev/2/.tmp-123456789": []byte("half"),
	}
	for name, data := range files {
		path := filepath.Join(world, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "notes.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	s := newTestStoreOn(t, testDir(t, root), 3)
	list, err := s.List(context.Background())
	if err != nil || len(list) != 1 || list[0].Revision != 2 || list[0].Owner != "ada-id" || list[0].Generator != "old-build" {
		t.Fatalf("List = %+v, err %v", list, err)
	}
	data, _, err := s.ReadCurrent(context.Background(), sampleUID)
	if err != nil || !bytes.Equal(data, zip2) {
		t.Errorf("ReadCurrent = %d bytes, err %v; want revision 2", len(data), err)
	}
	if p, err := s.ReadPreview(context.Background(), sampleUID); err != nil || string(p) != "PNG2" {
		t.Errorf("ReadPreview = %q, %v", p, err)
	}
	if g, found, err := s.ReadGrants(context.Background(), sampleUID); err != nil || !found || g.Owner != "ada-id" {
		t.Errorf("ReadGrants = %+v, %v, %v", g, found, err)
	}
	if path, err := s.CurrentZipPath(context.Background(), sampleUID); err != nil || path != filepath.Join(world, "rev", "2", "world.zip") {
		t.Errorf("CurrentZipPath = %q, %v", path, err)
	}

	// An upload continues the numbering; the owner stays the pinned one.
	meta, _, err := putSave(t, s, sampleUID, "three", 2)
	if err != nil || meta.Revision != 3 || meta.Owner != "ada-id" || !meta.CreatedAt.Equal(list[0].CreatedAt) {
		t.Fatalf("update = %+v, %v", meta, err)
	}
	if raw, err := os.ReadFile(filepath.Join(world, "rev", "3", "world.zip")); err != nil || len(raw) != int(meta.Size) {
		t.Errorf("revision 3 is not where the old layout puts it: %v", err)
	}
	// The world is deleted although the leaf refuses .DS_Store's key and
	// does not list the temp file: those two files stay (with the
	// directories that hold them), everything the store wrote goes.
	if err := s.Delete(context.Background(), sampleUID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := s.Get(context.Background(), sampleUID); !errors.Is(err, ErrNotFound) {
		t.Errorf("Get after delete = %v", err)
	}
	var left []string
	_ = filepath.WalkDir(world, func(path string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			rel, _ := filepath.Rel(world, path)
			left = append(left, filepath.ToSlash(rel))
		}
		return nil
	})
	if strings.Join(left, ",") != ".DS_Store,rev/2/.tmp-123456789" {
		t.Errorf("left after the delete: %v", left)
	}
	reindex(t, s)
	if list, _ := s.List(context.Background()); len(list) != 0 {
		t.Errorf("a deleted world lists after a restart: %+v", list)
	}
}

// Two WRITERS on one bucket — outside the model (one process per store), but
// what the conditional write is for: both believe revision 1 is current and
// upload at once. Exactly one wins; the other gets 412, and the winner's save
// is what is stored. On the ceph row (no conditional write) only the
// in-process lock exists, so the test runs on the Dir and the aws row.
func TestTwoWritersRacingForARevisionLetOneWin(t *testing.T) {
	for _, name := range []string{"dir", "aws"} {
		t.Run(name, func(t *testing.T) {
			for round := range 10 {
				bucket := testBackends()[name](t)
				a := newTestStoreOn(t, bucket, 0)
				if _, _, err := putSave(t, a, sampleUID, "base", 0); err != nil {
					t.Fatal(err)
				}
				b := newTestStoreOn(t, bucket, 0) // a second process, indexed at revision 1
				_, muxA := adminModule(a)
				_, muxB := adminModule(b)

				codes := make([]int, 2)
				var wg sync.WaitGroup
				for i, mux := range []*http.ServeMux{muxA, muxB} {
					wg.Add(1)
					go func() {
						defer wg.Done()
						data := buildSave(t, sampleYAML(), []byte("PNG"), map[string][]byte{"payload": []byte{byte('a' + i)}})
						codes[i] = do(mux, http.MethodPut, "/v1/worlds/"+sampleUID, data, map[string]string{"If-Match": "1"}).Code
					}()
				}
				wg.Wait()
				ok, refused := 0, 0
				for _, c := range codes {
					switch c {
					case http.StatusOK:
						ok++
					case http.StatusPreconditionFailed:
						refused++
					}
				}
				if ok != 1 || refused != 1 {
					t.Fatalf("round %d: codes %v, want one 200 and one 412", round, codes)
				}
				winner := a
				if codes[1] == http.StatusOK {
					winner = b
				}
				want, _, _ := winner.ReadCurrent(context.Background(), sampleUID)
				reindex(t, a)
				got, meta, err := a.ReadCurrent(context.Background(), sampleUID)
				if err != nil || meta.Revision != 2 || !bytes.Equal(got, want) {
					t.Fatalf("round %d: stored revision %d, the winner's bytes %v, err %v", round, meta.Revision, bytes.Equal(got, want), err)
				}
			}
		})
	}
}

// failingBucket fails the Put of keys that end in `suffix`, once.
type failingBucket struct {
	blob.Bucket
	mu     sync.Mutex
	suffix string
}

func (f *failingBucket) Put(ctx context.Context, key string, body io.Reader, size int64, opts blob.PutOptions) (blob.Info, error) {
	f.mu.Lock()
	fail := f.suffix != "" && strings.HasSuffix(key, f.suffix)
	if fail {
		f.suffix = ""
	}
	f.mu.Unlock()
	if fail {
		return blob.Info{}, errors.New("the bucket went away")
	}
	return f.Bucket.Put(ctx, key, body, size, opts)
}

// An upload that ends after its save and before its meta.json leaves a
// revision the meta never names. The next upload steps over its number
// (with a crash: known from the List at start; with a failure in this
// process: known since the claim) instead of failing on it for ever.
func TestAnInterruptedUploadIsSteppedOver(t *testing.T) {
	for _, name := range []string{"dir", "aws", "ceph"} {
		t.Run(name, func(t *testing.T) {
			bucket := &failingBucket{Bucket: testBackends()[name](t)}
			s := newTestStoreOn(t, bucket, 0)
			if _, _, err := putSave(t, s, sampleUID, "v1", 0); err != nil {
				t.Fatal(err)
			}
			// A failure in this process, after the save of revision 2.
			bucket.suffix = "/rev/2/" + metaName
			if _, _, err := putSave(t, s, sampleUID, "v2", 1); err == nil {
				t.Fatal("the failing upload succeeded")
			}
			meta, _, err := putSave(t, s, sampleUID, "v2", 1)
			if err != nil || meta.Revision != 3 {
				t.Fatalf("upload after a failure = rev %d, %v; want 3", meta.Revision, err)
			}
			// A crash: an orphan written by hand, seen at the next start.
			writeObject(t, s, revKey(sampleUID, 4, zipName), []byte("half"))
			meta, _, err = putSave(t, s, sampleUID, "v3", 3)
			if err != nil || meta.Revision != 5 {
				t.Fatalf("upload after a crash = rev %d, %v; want 5", meta.Revision, err)
			}
			if data, _, err := s.ReadCurrent(context.Background(), sampleUID); err != nil || bytes.Equal(data, []byte("half")) {
				t.Errorf("current = %q, %v", data, err)
			}

			// A creation over what an interrupted creation left (no meta.json):
			// 201, at the next free revision.
			fresh := newTestStoreOn(t, testBackends()[name](t), 0)
			writeObject(t, fresh, revKey(sampleUID, 1, zipName), []byte("half"))
			writeObject(t, fresh, grantsKey(sampleUID), []byte(`{"owner":"mallory"}`))
			_, mux := adminModule(fresh)
			res := upload(t, mux, sampleUID, "")
			var created Meta
			if res.Code != http.StatusCreated || json.Unmarshal(res.Body.Bytes(), &created) != nil || created.Revision != 2 {
				t.Fatalf("create over an orphan = %d %s", res.Code, res.Body)
			}
			if g, _, _ := fresh.ReadGrants(context.Background(), sampleUID); g.Owner != identity.Local {
				t.Errorf("the orphan's grants were kept: %+v", g)
			}
		})
	}
}

// The s3 bucket is opened with versioning on (BucketOptions): the worlds are
// the only copy. The aws row writes the create-only keys conditionally; the
// ceph row, without the capability, writes them plainly.
func TestTheS3BucketIsVersionedAndWritesConditionally(t *testing.T) {
	for _, flavour := range []string{blob.FlavourAWS, blob.FlavourCeph} {
		t.Run(flavour, func(t *testing.T) {
			f, srv := newFakeS3(t)
			s := newTestStoreOn(t, openFakeBucket(t, srv, flavour), 0)
			if !f.versioning["worlds"] {
				t.Error("versioning is not on")
			}
			if s.LocalFiles() {
				t.Error("an s3 bucket claims local files")
			}
			if _, err := s.CurrentZipPath(context.Background(), sampleUID); err == nil {
				t.Error("CurrentZipPath answered on s3")
			}
			if _, _, err := putSave(t, s, sampleUID, "v1", 0); err != nil {
				t.Fatal(err)
			}
			if _, _, err := putSave(t, s, sampleUID, "v2", 1); err != nil {
				t.Fatal(err)
			}
			f.mu.Lock()
			conditional := f.conditional
			_, prefixed := f.objects["worlds/test/run/"+metaKey(sampleUID)]
			f.mu.Unlock()
			// aws: the save of each revision and the meta at the creation.
			want := map[string]int{blob.FlavourAWS: 3, blob.FlavourCeph: 0}[flavour]
			if conditional != want {
				t.Errorf("%d conditional writes, want %d", conditional, want)
			}
			if !prefixed {
				t.Error("the s3 block's prefix was not applied")
			}
		})
	}
}

// Grants in the index follow every writer: a transfer, the template mark.
func TestTheIndexFollowsTheGrants(t *testing.T) {
	s := newTestStore(t)
	if _, err := putAs(t, s, sampleUID, "first", "ada-id", 0); err != nil {
		t.Fatal(err)
	}
	if err := s.WriteGrants(context.Background(), sampleUID, access.Grants{Owner: "grace-id"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetTemplate(context.Background(), sampleUID, true); err != nil {
		t.Fatal(err)
	}
	reindex(t, s)
	g, _, err := s.ReadGrants(context.Background(), sampleUID)
	meta, _ := s.Get(context.Background(), sampleUID)
	if err != nil || g.Owner != "grace-id" || !g.Template || meta.Owner != "grace-id" || !meta.Template {
		t.Errorf("after a restart: grants %+v, meta owner %q template %v, err %v", g, meta.Owner, meta.Template, err)
	}
}
