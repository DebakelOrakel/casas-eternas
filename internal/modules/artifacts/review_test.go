package artifacts

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"iter"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
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

// Fixes after the review of 2026-10-16: uploads by link that are never
// committed, a meta.json that names another key, a clear that races a
// write, a meta.json that cannot be read for a moment, and a world store
// in the same bucket.

// hookBucket runs hooks around the calls of a bucket.
type hookBucket struct {
	blob.Bucket
	mu sync.Mutex
	// failGet answers an error for the Get of a key instead of the object.
	failGet func(key string) error
	// beforeList runs before the List; it may block.
	beforeList func(prefix string)
}

// Signer forwards the Dir's signer, so that the module serves its links.
func (h *hookBucket) Signer() *blob.LinkSigner {
	if d, ok := h.Bucket.(signing); ok {
		return d.Signer()
	}
	return nil
}

func (h *hookBucket) set(change func(h *hookBucket)) {
	h.mu.Lock()
	defer h.mu.Unlock()
	change(h)
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

func (h *hookBucket) List(ctx context.Context, prefix string) iter.Seq2[blob.Info, error] {
	h.mu.Lock()
	before := h.beforeList
	h.mu.Unlock()
	if before != nil {
		before(prefix)
	}
	return h.Bucket.List(ctx, prefix)
}

// errUnavailable is a bucket that answers 503 for a moment.
var errUnavailable = errors.New("503 Service Unavailable")

// putObject writes an object straight into the bucket, as a link holder
// does.
func putObject(t *testing.T, s *Store, key, body string) {
	t.Helper()
	if _, err := s.bucket.Put(context.Background(), key, strings.NewReader(body), int64(len(body)), blob.PutOptions{}); err != nil {
		t.Fatal(err)
	}
}

// M2: uploads by link that are never committed count against the cap. A
// write link is refused when the uncommitted bytes would pass the cap, so
// a holder of write rights cannot fill the bucket with uploads that the
// index never counts.
func TestUncommittedUploadsCountAgainstTheCap(t *testing.T) {
	s := newStoreAt(t, t.TempDir(), 2500)
	ctx := context.Background()
	granted := 0
	for i := range 20 {
		uid, _, err := s.Resolve(ctx, keyN(strconv.Itoa(i)), true)
		if err != nil {
			t.Fatal(err)
		}
		link, err := linkFor(s, ctx, uid, "a.f32", 1000, time.Hour)
		if err != nil {
			if !errors.Is(err, errStoreFull) {
				t.Fatalf("link %d refused with %v, want errStoreFull", i, err)
			}
			continue
		}
		granted++
		key, _ := objectKey(uid, "a.f32")
		putObject(t, s, key, strings.Repeat("x", 1000))
		_ = link
	}
	if granted > 2 {
		t.Errorf("%d write links of 1000 B granted under a cap of 2500 B, want at most 2", granted)
	}
}

// M2: an artifact holds at most maxPendingFiles uncommitted files; asking
// again for the same file uses no second place.
func TestAnArtifactHoldsFewUncommittedFiles(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	uid, _, _ := s.Resolve(ctx, testKey(), true)
	for i := range maxPendingFiles {
		if _, err := linkFor(s, ctx, uid, "f"+strconv.Itoa(i), 1, time.Hour); err != nil {
			t.Fatalf("link %d: %v", i, err)
		}
	}
	if _, err := linkFor(s, ctx, uid, "f0", 1, time.Hour); err != nil {
		t.Errorf("a fresh link for a pending file: %v", err)
	}
	if _, err := linkFor(s, ctx, uid, "one-more", 1, time.Hour); !errors.Is(err, errTooManyPending) {
		t.Errorf("link %d = %v, want errTooManyPending", maxPendingFiles+1, err)
	}
}

// M2: a link that expires uncommitted no longer spares its artifact, and
// its bytes still count: the artifact is junk after the grace, and the
// sweep deletes the object that the link put there.
func TestAnExpiredUploadIsJunk(t *testing.T) {
	dir := t.TempDir()
	s := newStoreAt(t, dir, 1500)
	clock := useClock(s)
	ctx := context.Background()
	uid, _, _ := s.Resolve(ctx, keyN("r"), true)
	if _, err := linkFor(s, ctx, uid, "a.f32", 1000, time.Minute); err != nil {
		t.Fatal(err)
	}
	key, _ := objectKey(uid, "a.f32")
	putObject(t, s, key, strings.Repeat("x", 1000))
	clock.advance(2 * evictionGrace)
	bake(t, s, keyN("b"), "B", strings.Repeat("b", 600))
	if present(s, uid) {
		t.Error("the expired, uncommitted artifact is not junk")
	}
	if _, err := os.Stat(filepath.Join(dir, uid, "a.f32")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the uncommitted upload stayed: %v", err)
	}
}

// M3: a meta.json whose key is not the artifact's is refused (409), at the
// server's PUT and at a commit — or a writer with the right to one terrain
// files its bytes under another terrain's key.
func TestAMetaThatNamesAnotherKeyIsRefused(t *testing.T) {
	tokens, err := token.NewTokens([]byte("a signing key long enough to be accepted"))
	if err != nil {
		t.Fatal(err)
	}
	const worldA = "a754f0db-ff5c-4b45-9f2c-1b4e7a30d001"
	m, mux := newModule(t, openTestDir(t, t.TempDir()), identity.NewResolver(config.AuthPassword, tokens), noWorlds())
	jobA, _, _ := tokens.IssueJob("job-a", worldA, time.Hour)
	reserve := func() string {
		t.Helper()
		created := doAs(mux, http.MethodPost, "/v1/artifacts/resolve", strings.TrimSuffix(resolveBody, "}")+`,"create":true}`, jobA)
		var minted struct {
			ArtifactUID string `json:"artifactUid"`
		}
		_ = json.Unmarshal(created.Body.Bytes(), &minted)
		if minted.ArtifactUID == "" {
			t.Fatalf("job resolve = %d", created.Code)
		}
		return minted.ArtifactUID
	}
	own := Key{WorldID: "ba90bda173d581ef", PipelineVersion: "v6", Stage: "2"}
	foreign := Key{WorldID: "ffffffffffffffff", PipelineVersion: "v6", Stage: "2"}

	// The server's PUT.
	uid := reserve()
	if got := doAs(mux, http.MethodPut, "/v1/artifacts/"+uid+"/meta.json", metaFor(foreign, "evil"), jobA).Code; got != http.StatusConflict {
		t.Errorf("PUT of a meta naming terrain B = %d, want 409", got)
	}
	if _, err := readFile(t, m.store, uid, metaName); !errors.Is(err, blob.ErrNotFound) {
		t.Errorf("the refused meta was written: %v", err)
	}

	// By link and commit.
	meta := metaFor(foreign, "evil")
	if _, link := writeLink(t, mux, uid, metaName, len(meta), jobA); link.URL != "" {
		_ = putTo(mux, link.URL, meta)
	}
	if _, err := m.store.bucket.Put(context.Background(), uid+"/"+metaName, strings.NewReader(meta), int64(len(meta)), blob.PutOptions{}); err != nil {
		t.Fatal(err) // the provider's link would have taken it (s3)
	}
	if got := commit(mux, uid, jobA, Upload{metaName, int64(len(meta))}).Code; got != http.StatusConflict {
		t.Errorf("commit of a meta naming terrain B = %d, want 409", got)
	}
	if terrain, _ := m.store.TerrainOf(context.Background(), uid); terrain != own.WorldID {
		t.Errorf("the artifact belongs to %q after the refusal, want terrain A", terrain)
	}
	if _, _, err := m.store.Resolve(context.Background(), foreign, false); !errors.Is(err, ErrNotFound) {
		t.Errorf("terrain B's key resolves after the refusal: %v", err)
	}
	if _, err := readFile(t, m.store, uid, metaName); !errors.Is(err, blob.ErrNotFound) {
		t.Errorf("the refused meta stayed in the bucket: %v", err)
	}

	// Its own key is taken; after the commit, the links of the artifact are
	// no longer valid, and no new one is given.
	good := metaFor(own, "good")
	_, goodLink := writeLink(t, mux, uid, metaName, len(good), jobA)
	_, spare := writeLink(t, mux, uid, "spare.f32", 3, jobA)
	if code := putTo(mux, goodLink.URL, good); code != http.StatusOK {
		t.Fatalf("upload of the good meta = %d", code)
	}
	if got := commit(mux, uid, jobA, Upload{metaName, int64(len(good))}).Code; got != http.StatusNoContent {
		t.Fatalf("commit of the own meta = %d", got)
	}
	if code := putTo(mux, goodLink.URL, strings.Replace(good, "good", "evil", 1)); code != http.StatusForbidden {
		t.Errorf("a link of a committed artifact = %d, want 403", code)
	}
	if code := putTo(mux, spare.URL, "abc"); code != http.StatusForbidden {
		t.Errorf("another link of the committed artifact = %d, want 403", code)
	}
	if got, _ := writeLink(t, mux, uid, metaName, len(good), jobA); got.Code != http.StatusConflict {
		t.Errorf("write-links for a committed artifact = %d, want 409", got.Code)
	}
	if raw, err := readFile(t, m.store, uid, metaName); err != nil || string(raw) != good {
		t.Errorf("meta.json after the refused overwrite = %q, %v", raw, err)
	}
}

// M5: a clear lists the bucket first and deletes only what is not in the
// index after the reset: an artifact written while the clear lists is
// either cleared with the rest or left whole — never in the index with its
// objects deleted.
func TestAClearDoesNotDeleteWhatItDidNotDrop(t *testing.T) {
	bucket := &hookBucket{Bucket: openTestDir(t, t.TempDir())}
	s, err := NewStore(context.Background(), bucket, 0)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	bake(t, s, keyN("a"), "A", "old")
	held, release := make(chan struct{}), make(chan struct{})
	var first atomic.Bool
	bucket.set(func(h *hookBucket) {
		h.beforeList = func(string) {
			if !first.Swap(true) {
				close(held)
				<-release
			}
		}
	})
	cleared := make(chan error, 1)
	go func() { cleared <- s.Clear(ctx) }()
	<-held
	uid := bake(t, s, keyN("b"), "B", "written during the clear")
	close(release)
	if err := <-cleared; err != nil {
		t.Fatal(err)
	}
	if got, files, err := s.Resolve(ctx, keyN("b"), false); err == nil {
		for _, name := range files {
			if _, readErr := readFile(t, s, got, name); readErr != nil {
				t.Errorf("the index holds %s/%s, the bucket does not: %v", got, name, readErr)
			}
		}
	} else if _, readErr := readFile(t, s, uid, metaName); readErr == nil {
		t.Errorf("the index dropped %s, its objects stayed", uid)
	}
}

// M6: a meta.json that cannot be read for a moment (a 503) is not "no
// meta". A commit answers the error (5xx: the worker gives its task back)
// and leaves the artifact as it was; a second commit makes it whole.
func TestACommitWhoseMetaCannotBeReadFails(t *testing.T) {
	bucket := &hookBucket{Bucket: openTestDir(t, t.TempDir())}
	_, mux := newModule(t, bucket, identity.NewResolver(config.AuthNone, nil), adminWorlds())
	uid, _ := resolve(t, mux, true)
	meta := metaFor(Key{WorldID: "ba90bda173d581ef", PipelineVersion: "v6", Stage: "2"}, "m")
	_, link := writeLink(t, mux, uid, metaName, len(meta), "")
	if code := putTo(mux, link.URL, meta); code != http.StatusOK {
		t.Fatalf("upload = %d", code)
	}
	var failing atomic.Bool
	failing.Store(true)
	bucket.set(func(h *hookBucket) {
		h.failGet = func(key string) error {
			if strings.HasSuffix(key, "/"+metaName) && failing.Load() {
				return errUnavailable
			}
			return nil
		}
	})
	if got := commit(mux, uid, "", Upload{metaName, int64(len(meta))}).Code; got < 500 {
		t.Errorf("commit whose meta cannot be read = %d, want 5xx", got)
	}
	if _, files := resolve(t, mux, false); len(files) != 0 {
		t.Errorf("files after the failed commit = %v", files)
	}
	failing.Store(false)
	if got := commit(mux, uid, "", Upload{metaName, int64(len(meta))}).Code; got != http.StatusNoContent {
		t.Errorf("the second commit = %d", got)
	}
}

// M6: at start, a meta.json that cannot be read for a moment is read again;
// one that stays unreadable fails the start with its key. It is never
// indexed as junk, which the sweep would take.
func TestTheStartReadsAnUnreadableMetaAgainOrFails(t *testing.T) {
	dir := t.TempDir()
	seed := newStoreAt(t, dir, 0)
	uid := bake(t, seed, testKey(), "kept", "bytes")
	metaRetryDelay = time.Millisecond

	var failures atomic.Int32
	bucket := &hookBucket{Bucket: openTestDir(t, dir)}
	bucket.set(func(h *hookBucket) {
		h.failGet = func(key string) error {
			if strings.HasSuffix(key, "/"+metaName) && failures.Add(-1) >= 0 {
				return errUnavailable
			}
			return nil
		}
	})
	failures.Store(1)
	s, err := NewStore(context.Background(), bucket, 0)
	if err != nil {
		t.Fatalf("a start with one failed read of a meta: %v", err)
	}
	if whole, _ := s.Whole(context.Background(), []Key{testKey()}); !whole[0] {
		t.Error("the artifact is not whole after a transient failure")
	}
	failures.Store(1000)
	if _, err := NewStore(context.Background(), bucket, 0); err == nil || !strings.Contains(err.Error(), uid) {
		t.Errorf("a start whose meta stays unreadable = %v, want an error naming %s", err, uid)
	}
}

// H3, inside the store: an entry that is shaped like a world (grants.json,
// rev/…, a meta.json with a world's fields) is never junk. The sweep and a
// clear leave it, whatever else shares the bucket by mistake.
func TestAWorldInTheBucketIsNeverJunk(t *testing.T) {
	dir := t.TempDir()
	const world = "9f2c1b4e-7a30-4d55-8c11-2b6e5d0a1f83"
	files := map[string]string{
		world + "/meta.json":                                   `{"uid":"` + world + `","name":"alpha","owner":"ada","revision":1}`,
		world + "/grants.json":                                 `{"owner":"ada"}`,
		world + "/rev/1/world.zip":                             "PK",
		world + "/rev/1/meta.json":                             `{"revision":1}`,
		"0a1b2c3d-0000-4000-8000-0000000000aa/rev/2/world.zip": "PK", // an orphan revision
	}
	for key, body := range files {
		path := filepath.Join(dir, filepath.FromSlash(key))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	s := newStoreAt(t, dir, 200)
	clock := useClock(s)
	clock.advance(2 * evictionGrace)
	for _, n := range []string{"a", "b", "c"} {
		bake(t, s, keyN(n), n, strings.Repeat(n, 90))
	}
	check := func(when string) {
		t.Helper()
		for key, body := range files {
			raw, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(key)))
			if err != nil || !bytes.Equal(raw, []byte(body)) {
				t.Errorf("%s: %s = %q, %v", when, key, raw, err)
			}
		}
	}
	check("after the sweep")
	if err := s.Clear(context.Background()); err != nil {
		t.Fatal(err)
	}
	check("after a clear")
}

// L4: as for the world links (artifacts.link-key-previous), for a read and
// for a write link.
func TestTheArtifactLinksAcceptThePreviousKey(t *testing.T) {
	dir := t.TempDir()
	keyFile := func(name, fill string) string {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte(strings.Repeat(fill, 32)+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	var cfg config.Config
	cfg.Artifacts.LinkKey = keyFile("new", "n")
	cfg.Artifacts.LinkKeyPrevious = keyFile("old", "o")
	signer, err := NewLinkSigner(cfg)
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{http.MethodGet, http.MethodPut} {
		for fill, want := range map[string]bool{"o": true, "n": true, "x": false} {
			other, err := blob.NewLinkSigner(LinkBase, UploadLimit, []byte(strings.Repeat(fill, 32)))
			if err != nil {
				t.Fatal(err)
			}
			link, err := other.Sign(method, "a754f0db-ff5c-4b45-9f2c-1b4e7a30d001/a.f32", time.Minute, 3)
			if err != nil {
				t.Fatal(err)
			}
			if got := signer.Signed(httptest.NewRequest(method, link.URL, nil)); got != want {
				t.Errorf("%s link of key %q verifies = %v, want %v", method, fill, got, want)
			}
		}
	}
	cfg.Artifacts.LinkKeyPrevious = filepath.Join(dir, "missing")
	if _, err := NewLinkSigner(cfg); err == nil || !strings.Contains(err.Error(), "artifacts.link-key-previous") {
		t.Errorf("an unreadable previous key = %v, want an error naming artifacts.link-key-previous", err)
	}
}
