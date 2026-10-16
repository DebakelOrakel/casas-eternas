package world

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/blob"
	"github.com/DebakelOrakel/casas-eternas/internal/config"
	"github.com/DebakelOrakel/casas-eternas/internal/identity"
	"github.com/DebakelOrakel/casas-eternas/internal/token"
)

// Fixes after the review of 2026-10-16: a write that the bucket stored but
// answered with an error, a request context that ends half-way, the lock of
// a deleted world, retention with orphan revisions, and job tokens that
// write worlds.

// hookBucket runs hooks around the calls of a bucket, so that a test can
// make a call wait or make a stored write answer an error.
type hookBucket struct {
	blob.Bucket
	mu sync.Mutex
	// beforePut runs before the Put; it may block.
	beforePut func(ctx context.Context, key string)
	// afterPut runs after the Put with its result; it may replace the error.
	afterPut func(key string, err error) error
	// failGet answers an error for the Get of a key instead of the object.
	failGet func(key string) error
	// beforeDelete runs before the Delete; it may block.
	beforeDelete func(key string)
}

func (h *hookBucket) set(change func(h *hookBucket)) {
	h.mu.Lock()
	defer h.mu.Unlock()
	change(h)
}

func (h *hookBucket) Put(ctx context.Context, key string, body io.Reader, size int64, opts blob.PutOptions) (blob.Info, error) {
	h.mu.Lock()
	before, after := h.beforePut, h.afterPut
	h.mu.Unlock()
	if before != nil {
		before(ctx, key)
	}
	info, err := h.Bucket.Put(ctx, key, body, size, opts)
	if after != nil {
		err = after(key, err)
	}
	return info, err
}

func (h *hookBucket) Get(ctx context.Context, key string) (io.ReadCloser, blob.Info, error) {
	h.mu.Lock()
	fail := h.failGet
	h.mu.Unlock()
	if fail != nil {
		if err := fail(key); err != nil {
			return nil, blob.Info{}, err
		}
	}
	return h.Bucket.Get(ctx, key)
}

func (h *hookBucket) Delete(ctx context.Context, key string) error {
	h.mu.Lock()
	before := h.beforeDelete
	h.mu.Unlock()
	if before != nil {
		before(key)
	}
	return h.Bucket.Delete(ctx, key)
}

// once answers true the first time only.
func once() func() bool {
	var done atomic.Bool
	return func() bool { return !done.Swap(true) }
}

// errLost is a write the bucket stored and whose answer was lost.
var errLost = errors.New("the answer was lost")

// H1: the save of a revision is stored, but its Put answers an error (a
// lost answer; or 412, when the SDK's retry meets its own If-None-Match).
// The number must count as taken, or every later update picks it again and
// answers 412 until a restart.
func TestAClaimThatAnsweredAnErrorTakesItsRevision(t *testing.T) {
	for _, answer := range []error{errLost, blob.ErrExists} {
		for _, name := range []string{"dir", "aws"} {
			t.Run(name+"/"+answer.Error(), func(t *testing.T) {
				bucket := &hookBucket{Bucket: testBackends()[name](t)}
				s := newTestStoreOn(t, bucket, 0)
				if _, _, err := putSave(t, s, sampleUID, "v1", 0); err != nil {
					t.Fatal(err)
				}
				first := once()
				bucket.set(func(h *hookBucket) {
					h.afterPut = func(key string, err error) error {
						if err == nil && strings.HasSuffix(key, "/rev/2/"+zipName) && first() {
							return answer
						}
						return err
					}
				})
				if _, _, err := putSave(t, s, sampleUID, "v2", 1); err == nil {
					t.Fatal("the update whose save answered an error succeeded")
				}
				meta, _, err := putSave(t, s, sampleUID, "v2", 1)
				if err != nil || meta.Revision != 3 {
					t.Fatalf("the next update = rev %d, %v; want rev 3", meta.Revision, err)
				}
			})
		}
	}
}

// H1: a request whose context ends after the save (the browser tab was
// closed) still writes the rest of the revision: preview, revision meta and
// the world's meta, so the world is not left half-way.
func TestAnUploadIsNotCutOffByItsRequest(t *testing.T) {
	bucket := &hookBucket{Bucket: testBackends()["aws"](t)}
	s := newTestStoreOn(t, bucket, 0)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	bucket.set(func(h *hookBucket) {
		h.afterPut = func(key string, err error) error {
			if strings.HasSuffix(key, zipName) {
				cancel()
			}
			return err
		}
	})
	yaml := "kind: FlatWorld\nmetadata:\n  name: alpha\n  uid: " + sampleUID + "\n"
	data := buildSave(t, yaml, []byte("PNG"), map[string][]byte{"payload": []byte("v1")})
	info, err := inspectSave(data)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Put(ctx, sampleUID, data, info, "local", 0); err != nil {
		t.Fatalf("an upload whose request ended after the save: %v", err)
	}
	reindex(t, s)
	if got, meta, err := s.ReadCurrent(context.Background(), sampleUID); err != nil || meta.Revision != 1 || !bytes.Equal(got, data) {
		t.Fatalf("after a restart: rev %d, equal %v, %v", meta.Revision, bytes.Equal(got, data), err)
	}
	if _, err := s.ReadPreview(context.Background(), sampleUID); err != nil {
		t.Errorf("the preview is missing: %v", err)
	}
}

// H2: the creation's meta.json is stored, but its Put answers an error. The
// world must exist for this process: the index enters it (it is ours), so
// Get finds it and an update with its revision goes through.
func TestACreationWhoseMetaAnsweredAnErrorExists(t *testing.T) {
	for _, name := range []string{"dir", "aws"} {
		t.Run(name, func(t *testing.T) {
			bucket := &hookBucket{Bucket: testBackends()[name](t)}
			s := newTestStoreOn(t, bucket, 0)
			first := once()
			bucket.set(func(h *hookBucket) {
				h.afterPut = func(key string, err error) error {
					if err == nil && key == metaKey(sampleUID) && first() {
						return errLost
					}
					return err
				}
			})
			created, _, err := putSave(t, s, sampleUID, "v1", 0)
			if err != nil {
				t.Fatalf("the creation whose meta is stored: %v", err)
			}
			if meta, err := s.Get(context.Background(), sampleUID); err != nil || meta.Revision != created.Revision {
				t.Fatalf("Get = rev %d, %v", meta.Revision, err)
			}
			if _, _, err := putSave(t, s, sampleUID, "v2", created.Revision); err != nil {
				t.Fatalf("the update after it: %v", err)
			}
		})
	}
}

// H2: as above, and the read back of meta.json fails as well, so the store
// cannot tell whether the meta is its own. The retry of the creation then
// finds a meta.json there: it answers 409, and from then on the index holds
// the stored world — Get, a second retry and an update all agree.
func TestACreationThatCannotBeConfirmedAnswersConsistently(t *testing.T) {
	for _, name := range []string{"dir", "aws"} {
		t.Run(name, func(t *testing.T) {
			bucket := &hookBucket{Bucket: testBackends()[name](t)}
			s := newTestStoreOn(t, bucket, 0)
			firstPut, firstGet := once(), once()
			bucket.set(func(h *hookBucket) {
				h.afterPut = func(key string, err error) error {
					if err == nil && key == metaKey(sampleUID) && firstPut() {
						return errLost
					}
					return err
				}
				h.failGet = func(key string) error {
					if key == metaKey(sampleUID) && firstGet() {
						return errors.New("the bucket is away")
					}
					return nil
				}
			})
			if _, _, err := putSave(t, s, sampleUID, "v1", 0); err == nil {
				t.Fatal("a creation that cannot be confirmed succeeded")
			}
			if _, _, err := putSave(t, s, sampleUID, "v1-again", 0); !errors.Is(err, ErrExists) {
				t.Fatalf("the retry = %v, want ErrExists", err)
			}
			meta, err := s.Get(context.Background(), sampleUID)
			if err != nil || meta.Revision != 1 {
				t.Fatalf("Get after the 409 = rev %d, %v; want the stored rev 1", meta.Revision, err)
			}
			if _, _, err := putSave(t, s, sampleUID, "v1-third", 0); !errors.Is(err, ErrExists) {
				t.Errorf("a second retry = %v, want ErrExists", err)
			}
			if _, _, err := putSave(t, s, sampleUID, "v2", meta.Revision); err != nil {
				t.Errorf("an update with the stored revision: %v", err)
			}
		})
	}
}

// M4: a delete must not drop the world's lock while a writer waits on it,
// or a writer that comes after gets a fresh lock and two writers run at
// once. On ceph (no conditional write) nothing else keeps them apart.
func TestADeleteKeepsTheLockOfAWaitingWriter(t *testing.T) {
	bucket := &hookBucket{Bucket: testBackends()["ceph"](t)}
	s := newTestStoreOn(t, bucket, 0)
	if _, _, err := putSave(t, s, sampleUID, "v1", 0); err != nil {
		t.Fatal(err)
	}
	deleteHeld, deleteGo := make(chan struct{}), make(chan struct{})
	firstDelete := once()
	bucket.set(func(h *hookBucket) {
		h.beforeDelete = func(key string) {
			if key == metaKey(sampleUID) && firstDelete() {
				close(deleteHeld)
				<-deleteGo
			}
		}
	})
	deleted := make(chan error, 1)
	go func() { deleted <- s.Delete(context.Background(), sampleUID) }()
	<-deleteHeld

	// The first writer waits on the world's lock, held by the delete.
	firstWrote := make(chan error, 1)
	go func() {
		_, _, err := putSave(t, s, sampleUID, "w1", 0)
		firstWrote <- err
	}()
	time.Sleep(100 * time.Millisecond)

	// Its save is held in the bucket; a save of the second writer that
	// starts meanwhile runs at the same time.
	firstHeld, firstGo := make(chan struct{}), make(chan struct{})
	var holding, overlap atomic.Bool
	firstSave := once()
	bucket.set(func(h *hookBucket) {
		h.beforePut = func(_ context.Context, key string) {
			if !strings.HasSuffix(key, zipName) {
				return
			}
			if firstSave() {
				holding.Store(true)
				close(firstHeld)
				<-firstGo
				holding.Store(false)
				return
			}
			if holding.Load() {
				overlap.Store(true)
			}
		}
	})
	close(deleteGo)
	if err := <-deleted; err != nil {
		t.Fatalf("Delete: %v", err)
	}
	<-firstHeld
	secondWrote := make(chan error, 1)
	go func() {
		_, _, err := putSave(t, s, sampleUID, "w2", 0)
		secondWrote <- err
	}()
	time.Sleep(100 * time.Millisecond)
	close(firstGo)
	if err := <-firstWrote; err != nil {
		t.Fatalf("the first writer: %v", err)
	}
	if err := <-secondWrote; !errors.Is(err, ErrExists) {
		t.Errorf("the second writer = %v, want ErrExists after the first one", err)
	}
	if overlap.Load() {
		t.Error("two writers of one world ran at once")
	}
	s.locksMu.Lock()
	left := len(s.locks)
	s.locksMu.Unlock()
	if left != 0 {
		t.Errorf("%d locks left after every writer is done, want 0", left)
	}
}

// L1: retention counts the revisions that have a meta.json. An orphan (a
// save whose upload ended before its revision meta) uses up no slot; it is
// pruned first, and the newest good revisions stay.
func TestRetentionCountsOnlyWholeRevisions(t *testing.T) {
	bucket := &failingBucket{Bucket: testBackends()["dir"](t)}
	s := newTestStoreOn(t, bucket, 2)
	for i, body := range []string{"v1", "v2"} {
		if _, _, err := putSave(t, s, sampleUID, body, i); err != nil {
			t.Fatal(err)
		}
	}
	bucket.mu.Lock()
	bucket.suffix = "/rev/3/" + metaName
	bucket.mu.Unlock()
	if _, _, err := putSave(t, s, sampleUID, "v3", 2); err == nil {
		t.Fatal("the failing upload succeeded")
	}
	meta, _, err := putSave(t, s, sampleUID, "v3", 2)
	if err != nil || meta.Revision != 4 {
		t.Fatalf("upload after the orphan = rev %d, %v; want 4", meta.Revision, err)
	}
	for revision, want := range map[int]bool{1: false, 2: true, 3: false, 4: true} {
		if got := stored(t, s, revKey(sampleUID, revision, zipName)); got != want {
			t.Errorf("revision %d stored = %v, want %v", revision, got, want)
		}
	}
	if n := storedUnder(t, s, revPrefix(sampleUID, 3)); n != 0 {
		t.Errorf("the orphan revision 3 keeps %d objects", n)
	}
}

// M1: a job token reads its world and writes artifacts; it never writes a
// world. Create, copy, delete and the template mark answer 403 for it — a
// world it created was owned by "job", so by every job token.
func TestAJobTokenWritesNoWorld(t *testing.T) {
	tokens, err := token.NewTokens([]byte("a signing key long enough to be accepted"))
	if err != nil {
		t.Fatal(err)
	}
	m := moduleOn(Config{Identity: identity.NewResolver(config.AuthPassword, tokens)}, newTestStore(t))
	mux := http.NewServeMux()
	if err := m.Mount(mux); err != nil {
		t.Fatal(err)
	}
	as := func(method, path, bearer string, body []byte) *httptest.ResponseRecorder {
		request := httptest.NewRequest(method, path, bytes.NewReader(body))
		request.Header.Set("Authorization", "Bearer "+bearer)
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, request)
		return recorder
	}
	ada, _, err := tokens.IssueSession("ada-id", false, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	job, _, err := tokens.IssueJob("job-1", sampleUID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if got := as(http.MethodPut, "/v1/worlds/"+sampleUID, ada, buildSave(t, sampleYAML(), []byte("PNG"), nil)).Code; got != http.StatusCreated {
		t.Fatalf("ada's create = %d", got)
	}

	const other = "1b2c3d4e-0000-4000-8000-00000000abcd"
	otherSave := buildSave(t, strings.Replace(sampleYAML(), sampleUID, other, 1), []byte("PNG"), nil)
	for _, c := range []struct {
		method, path string
		body         []byte
	}{
		{http.MethodPut, "/v1/worlds/" + other, otherSave},
		{http.MethodPost, "/v1/worlds/" + sampleUID + "/copy", nil},
		{http.MethodDelete, "/v1/worlds/" + sampleUID, nil},
		{http.MethodPut, "/v1/worlds/" + sampleUID + "/template", nil},
		{http.MethodDelete, "/v1/worlds/" + sampleUID + "/template", nil},
	} {
		if got := as(c.method, c.path, job, c.body).Code; got != http.StatusForbidden {
			t.Errorf("job %s %s = %d, want 403", c.method, c.path, got)
		}
	}
	if _, err := m.store.Get(context.Background(), other); !errors.Is(err, ErrNotFound) {
		t.Errorf("the job's create left a world: %v", err)
	}
	if listed, _ := m.store.List(context.Background()); len(listed) != 1 {
		t.Errorf("%d worlds after the job's requests, want 1", len(listed))
	}
	// The user may.
	if got := as(http.MethodPost, "/v1/worlds/"+sampleUID+"/copy", ada, nil).Code; got != http.StatusCreated {
		t.Errorf("ada's copy = %d, want 201", got)
	}
	if got := as(http.MethodPut, "/v1/worlds/"+other, ada, otherSave).Code; got != http.StatusCreated {
		t.Errorf("ada's create = %d, want 201", got)
	}
}

// L4: during a key change-over, world.link-key-previous verifies the links
// of the key before; new links are signed with world.link-key. A link of a
// third key does not verify, and a previous key that is set but cannot be
// read fails the start.
func TestTheWorldLinksAcceptThePreviousKey(t *testing.T) {
	dir := t.TempDir()
	keyFile := func(name, fill string) string {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte(strings.Repeat(fill, 32)+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	var cfg config.Config
	cfg.World.LinkKey = keyFile("new", "n")
	cfg.World.LinkKeyPrevious = keyFile("old", "o")
	signer, err := NewLinkSigner(cfg)
	if err != nil {
		t.Fatal(err)
	}
	verifies := func(fill string) bool {
		t.Helper()
		other, err := blob.NewLinkSigner(LinkBase, uploadLimit, []byte(strings.Repeat(fill, 32)))
		if err != nil {
			t.Fatal(err)
		}
		link, err := other.Sign(http.MethodGet, sampleUID+"/rev/1/world.zip", time.Minute, 0)
		if err != nil {
			t.Fatal(err)
		}
		return signer.Signed(httptest.NewRequest(http.MethodGet, link.URL, nil))
	}
	if !verifies("o") {
		t.Error("a link of the previous key does not verify")
	}
	if !verifies("n") {
		t.Error("a link of the current key does not verify")
	}
	if verifies("x") {
		t.Error("a link of a third key verifies")
	}
	own, _ := signer.Sign(http.MethodGet, sampleUID+"/rev/1/world.zip", time.Minute, 0)
	current, _ := blob.NewLinkSigner(LinkBase, uploadLimit, []byte(strings.Repeat("n", 32)))
	if !current.Signed(httptest.NewRequest(http.MethodGet, own.URL, nil)) {
		t.Error("a new link is not signed with world.link-key")
	}
	cfg.World.LinkKeyPrevious = filepath.Join(dir, "missing")
	if _, err := NewLinkSigner(cfg); err == nil || !strings.Contains(err.Error(), "world.link-key-previous") {
		t.Errorf("an unreadable previous key = %v, want an error naming world.link-key-previous", err)
	}
}
