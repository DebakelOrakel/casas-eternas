package artifacts

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/blob"
	"github.com/DebakelOrakel/casas-eternas/internal/config"
	"github.com/DebakelOrakel/casas-eternas/internal/identity"
	"github.com/DebakelOrakel/casas-eternas/internal/token"
)

// The sweep and the writes in flight (2026-10-16, DEC-0038 Status): the
// cap's eviction never takes an entry that a writer is still writing, and
// the files a writer left under a reservation the server forgot at a
// restart become junk that the sweep takes first.

// testClock is a store clock that goroutines may read at the same time. It
// advances one second per reading, as tick does, and jumps on advance.
type testClock struct {
	mu sync.Mutex
	at time.Time
}

func useClock(s *Store) *testClock {
	c := &testClock{at: time.Now()}
	s.now = c.now
	return c
}

func (c *testClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.at = c.at.Add(time.Second)
	return c.at
}

func (c *testClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.at = c.at.Add(d)
}

// heldReader blocks its first Read until released, and says when that Read
// has started: the write is then past its check and in the bucket's Put.
type heldReader struct {
	io.Reader
	started chan struct{}
	release chan struct{}
	once    sync.Once
}

func newHeldReader(body string) *heldReader {
	return &heldReader{Reader: strings.NewReader(body), started: make(chan struct{}), release: make(chan struct{})}
}

func (r *heldReader) Read(p []byte) (int, error) {
	r.once.Do(func() {
		close(r.started)
		<-r.release
	})
	return r.Reader.Read(p)
}

func keyN(n string) Key {
	return Key{WorldID: strings.Repeat(n, 16), PipelineVersion: "v6-a", Stage: "2"}
}

func present(s *Store, uid string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.entries[uid]
	return ok
}

// A reservation that has no file yet is not taken: the writer resolved
// with create a moment ago and writes next. Before 2026-10-16 it was the
// first victim (meta-less, touched), and its writer's PUT answered 404.
func TestSweepSparesAReservation(t *testing.T) {
	s := newStoreAt(t, t.TempDir(), 400)
	useClock(s)
	ctx := context.Background()
	uid, _, err := s.Resolve(ctx, keyN("r"), true)
	if err != nil {
		t.Fatal(err)
	}
	bake(t, s, keyN("a"), "A", strings.Repeat("a", 90))
	bake(t, s, keyN("b"), "B", strings.Repeat("b", 90))
	if got, _, err := s.Resolve(ctx, keyN("r"), false); err != nil || got != uid {
		t.Fatalf("the reservation went in the sweep: %q, %v", got, err)
	}
	if err := write(s, uid, "elevation.u16", "bytes"); err != nil {
		t.Errorf("the writer's write into its reservation = %v", err)
	}
}

// A server PUT in flight is spared even past the grace; once it is
// recorded, the entry is spared for the grace; after that, with no write
// in flight and no meta, it is junk and goes before an entry that LRU
// alone would take first.
func TestSweepSparesAWriteInFlight(t *testing.T) {
	dir := t.TempDir()
	s := newStoreAt(t, dir, 600)
	clock := useClock(s)
	ctx := context.Background()
	uid, _, err := s.Resolve(ctx, keyN("r"), true)
	if err != nil {
		t.Fatal(err)
	}
	body := newHeldReader(strings.Repeat("r", 150))
	done := make(chan error, 1)
	go func() { done <- s.Write(ctx, uid, "elevation.u16", body, 150) }()
	<-body.started
	// Past the grace: only the write in flight protects the entry now.
	clock.advance(2 * evictionGrace)
	bake(t, s, keyN("a"), "A", strings.Repeat("a", 90))
	bake(t, s, keyN("b"), "B", strings.Repeat("b", 90))
	bake(t, s, keyN("c"), "C", strings.Repeat("c", 90))
	if !present(s, uid) {
		t.Fatal("the sweep took an entry with a write in flight")
	}
	close(body.release)
	if err := <-done; err != nil {
		t.Fatalf("the write in flight = %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, uid, "elevation.u16")); err != nil {
		t.Fatalf("the written file is not there: %v", err)
	}

	// Just written: inside the grace, no victim although meta-less.
	bake(t, s, keyN("d"), "D", strings.Repeat("d", 90))
	if !present(s, uid) {
		t.Fatal("the sweep took a meta-less entry written a moment ago")
	}

	// Untouched past the grace, no write in flight: junk, the first victim.
	clock.advance(2 * evictionGrace)
	bake(t, s, keyN("e"), "E", strings.Repeat("e", 90))
	if present(s, uid) {
		t.Error("an abandoned meta-less entry survived the sweep")
	}
	if _, err := os.Stat(filepath.Join(dir, uid)); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the abandoned entry's files stayed: %v", err)
	}
}

// heldHead blocks the bucket's Head of one key until released.
type heldHead struct {
	blob.Bucket
	key     string
	started chan struct{}
	release chan struct{}
	once    sync.Once
}

func (b *heldHead) Head(ctx context.Context, key string) (blob.Info, error) {
	if key == b.key {
		b.once.Do(func() {
			close(b.started)
			<-b.release
		})
	}
	return b.Bucket.Head(ctx, key)
}

// A commit in flight is spared, also when its write link has expired.
func TestSweepSparesACommitInFlight(t *testing.T) {
	bucket := &heldHead{Bucket: openTestDir(t, t.TempDir()), started: make(chan struct{}), release: make(chan struct{})}
	ctx := context.Background()
	s, err := NewStore(ctx, bucket, 600)
	if err != nil {
		t.Fatal(err)
	}
	clock := useClock(s)
	uid, _, _ := s.Resolve(ctx, keyN("r"), true)
	bucket.key = uid + "/a.f32"
	if _, err := linkFor(s, ctx, uid, "a.f32", 150, time.Minute); err != nil {
		t.Fatal(err)
	}
	if _, err := bucket.Put(ctx, bucket.key, strings.NewReader(strings.Repeat("r", 150)), 150, blob.PutOptions{}); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- s.Commit(ctx, uid, []Upload{{"a.f32", 150}}) }()
	<-bucket.started
	// The link has expired and the grace has passed: only the commit in
	// flight protects the entry.
	clock.advance(2 * evictionGrace)
	for _, n := range []string{"a", "b", "c"} {
		bake(t, s, keyN(n), n, strings.Repeat(n, 90))
	}
	if !present(s, uid) {
		t.Fatal("the sweep took an entry with a commit in flight")
	}
	close(bucket.release)
	if err := <-done; err != nil {
		t.Errorf("the commit in flight = %v", err)
	}
}

// After a restart the reservation is gone. Every write of the forgotten
// uid answers 404, which the worker takes as "resolve again"
// (HttpArtifactStore.ts); resolve with create mints a new uid. The files
// the writer left under the old uid are a meta-less entry with no key:
// spared for the grace from their newest write, then junk that the sweep
// takes first.
func TestAForgottenReservationAnswers404AndBecomesJunk(t *testing.T) {
	tokens, err := token.NewTokens([]byte("a signing key long enough to be accepted"))
	if err != nil {
		t.Fatal(err)
	}
	const worldUID = "a754f0db-ff5c-4b45-9f2c-1b4e7a30d001"
	resolver := identity.NewResolver(config.AuthPassword, tokens)
	nobody := noWorlds()
	job, _, _ := tokens.IssueJob("job-1", worldUID, time.Hour)
	body := strings.TrimSuffix(resolveBody, "}") + `,"create":true}`
	resolveAs := func(mux *http.ServeMux) string {
		t.Helper()
		answer := doAs(mux, http.MethodPost, "/v1/artifacts/resolve", body, job)
		var minted struct {
			ArtifactUID string `json:"artifactUid"`
		}
		_ = json.Unmarshal(answer.Body.Bytes(), &minted)
		if minted.ArtifactUID == "" {
			t.Fatalf("job resolve = %d", answer.Code)
		}
		return minted.ArtifactUID
	}

	dir := t.TempDir()
	_, before := newModule(t, openTestDir(t, dir), resolver, nobody)
	old := resolveAs(before)
	if code := doAs(before, http.MethodPut, "/v1/artifacts/"+old+"/nodes.f32", strings.Repeat("n", 150), job).Code; code != http.StatusNoContent {
		t.Fatalf("server PUT = %d", code)
	}
	_, link := writeLink(t, before, old, "z.f32", 3, job)
	if code := putTo(before, link.URL, "zzz"); code != http.StatusOK {
		t.Fatalf("upload = %d", code)
	}

	// The restart.
	m, after := newModule(t, openTestDir(t, dir), resolver, nobody)
	if got, _ := writeLink(t, after, old, "role.u8", 3, job); got.Code != http.StatusNotFound {
		t.Errorf("write-links for a forgotten reservation = %d, want 404", got.Code)
	}
	if code := doAs(after, http.MethodPut, "/v1/artifacts/"+old+"/role.u8", "rrr", job).Code; code != http.StatusNotFound {
		t.Errorf("server PUT into a forgotten reservation = %d, want 404", code)
	}
	if code := commit(after, old, job, Upload{"z.f32", 3}).Code; code != http.StatusNotFound {
		t.Errorf("commit of a forgotten reservation = %d, want 404", code)
	}
	if fresh := resolveAs(after); fresh == old {
		t.Errorf("resolve with create after the restart gave the old uid %s", old)
	}

	// The sweep: spared for the grace, junk after it.
	s := m.Store()
	s.mu.Lock()
	s.cap = 600
	s.mu.Unlock()
	clock := useClock(s)
	for _, n := range []string{"a", "b", "c"} {
		bake(t, s, keyN(n), n, strings.Repeat(n, 90))
	}
	if !present(s, old) {
		t.Fatal("the sweep took the old files inside the grace")
	}
	clock.advance(2 * evictionGrace)
	newest := bake(t, s, keyN("d"), "D", strings.Repeat("d", 90))
	if present(s, old) {
		t.Error("the old files are not junk after the grace")
	}
	if _, err := os.Stat(filepath.Join(dir, old)); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the old files stayed on disk: %v", err)
	}
	if !present(s, newest) {
		t.Error("the newest entry went instead")
	}
}
