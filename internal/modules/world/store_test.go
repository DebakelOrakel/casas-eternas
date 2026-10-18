package world

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/blob"
)

// newTestStore is a store on a Dir in a temporary directory.
func newTestStore(t *testing.T) *Store {
	t.Helper()
	return newTestStoreOn(t, testDir(t, t.TempDir()), 0)
}

// testDir opens a Dir at root that signs its links, as cmd/ opens it,
// closed at the end of the test.
func testDir(t *testing.T, root string) *blob.Dir {
	t.Helper()
	d, err := blob.OpenDir(root, testSigner(t))
	if err != nil {
		t.Fatalf("OpenDir: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })
	return d
}

// testSigner signs the dir links with a fixed key.
func testSigner(t *testing.T) *blob.LinkSigner {
	t.Helper()
	signer, err := blob.NewLinkSigner(LinkBase, uploadLimit, []byte("world-test-link-key-of-32-bytes!"))
	if err != nil {
		t.Fatal(err)
	}
	return signer
}

// moduleOn is a module on `store` as New makes it: the read lifetime of
// 15m and, on a Dir, its signer.
func moduleOn(cfg Config, store *Store) *Module {
	m := &Module{cfg: cfg, store: store, readTTL: 15 * time.Minute}
	if d, ok := store.bucket.(signing); ok {
		m.signer = d.Signer()
	}
	return m
}

// newTestStoreOn is a store on `bucket`. keepRevisions 0 (retain all) for
// most tests: the retention sweep has its own tests, and everything else
// here asserts on revisions it expects to stay.
func newTestStoreOn(t *testing.T, bucket blob.Bucket, keepRevisions int) *Store {
	t.Helper()
	store, err := NewStore(context.Background(), bucket, keepRevisions)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	// Deterministic, monotonic timestamps so ordering assertions are about the
	// store's behaviour and not about clock resolution.
	tick := time.Date(2026, 8, 8, 12, 0, 0, 0, time.UTC)
	store.now = func() time.Time {
		tick = tick.Add(time.Second)
		return tick
	}
	return store
}

// removeObject and writeObject change the bucket behind the store's back,
// as an operator's hand would, and then build the index again: the store
// sees such a change at its next start (it is the one writer).
func removeObject(t *testing.T, s *Store, key string) {
	t.Helper()
	if err := s.bucket.Delete(context.Background(), key); err != nil {
		t.Fatal(err)
	}
	reindex(t, s)
}

func writeObject(t *testing.T, s *Store, key string, data []byte) {
	t.Helper()
	if _, err := s.bucket.Put(context.Background(), key, bytes.NewReader(data), int64(len(data)), blob.PutOptions{}); err != nil {
		t.Fatal(err)
	}
	reindex(t, s)
}

// reindex builds the index from the bucket again, as a restart does.
func reindex(t *testing.T, s *Store) {
	t.Helper()
	if err := s.load(context.Background()); err != nil {
		t.Fatalf("reindex: %v", err)
	}
}

// stored reports whether the bucket holds the key.
func stored(t *testing.T, s *Store, key string) bool {
	t.Helper()
	_, err := s.bucket.Head(context.Background(), key)
	if err != nil && !errors.Is(err, blob.ErrNotFound) {
		t.Fatal(err)
	}
	return err == nil
}

// storedUnder counts the keys under a prefix.
func storedUnder(t *testing.T, s *Store, prefix string) int {
	t.Helper()
	n := 0
	for _, err := range s.bucket.List(context.Background(), prefix) {
		if err != nil {
			t.Fatal(err)
		}
		n++
	}
	return n
}

// putSave uploads a save and also hands back the exact bytes it sent, so a
// test can assert on identity rather than on a marker string — the archive is
// DEFLATE-compressed, so its payload does not appear literally in the file.
func putSave(t *testing.T, s *Store, uid string, body string, expected int) (Meta, []byte, error) {
	t.Helper()
	yaml := "kind: SphereWorld\nmetadata:\n  name: alpha\n  uid: " + uid + "\nspec:\n  seed: alpha-seed\nstatus:\n  erosionRun: 2\n  revision: 1\n  generator: test-build\n  pipeline: v11-test\n  progress: climate\n"
	data := buildSave(t, yaml, []byte("PNG-"+body), map[string][]byte{"payload": []byte(body)})
	info, err := inspectSave(data)
	if err != nil {
		t.Fatalf("inspectSave: %v", err)
	}
	meta, err := s.Put(context.Background(), uid, data, info, "local", expected)
	return meta, data, err
}

func TestPutThenReadRoundTrips(t *testing.T) {
	s := newTestStore(t)
	meta, sent, err := putSave(t, s, sampleUID, "first", 0)
	if err != nil {
		t.Fatalf("Put: %v", err)
	}
	if meta.Revision != 1 {
		t.Errorf("first revision = %d, want 1", meta.Revision)
	}
	if meta.Owner != "local" || meta.Name != "alpha" || !meta.HasPreview {
		t.Errorf("meta = %+v", meta)
	}
	// The listing's display data, read out of the yaml and mirrored into the
	// world meta so the load/save panels need no unzip.
	if meta.Seed != "alpha-seed" || meta.Generator != "test-build" || meta.Pipeline != "v11-test" || len(meta.ContentHash) != 64 {
		t.Errorf("display meta = seed %q, generator %q, pipeline %q, hash %q", meta.Seed, meta.Generator, meta.Pipeline, meta.ContentHash)
	}
	// The shape and the progress, mirrored the same way (2026-10-11), and
	// kept in meta.json: the listing reads them back from disk.
	if meta.Kind != "SphereWorld" || meta.Progress != "climate" {
		t.Errorf("display meta = kind %q, progress %q", meta.Kind, meta.Progress)
	}
	listed, err := s.List(context.Background())
	if err != nil || len(listed) != 1 || listed[0].Kind != "SphereWorld" || listed[0].Progress != "climate" {
		t.Errorf("listed = %+v, err = %v", listed, err)
	}

	data, read, err := s.ReadCurrent(context.Background(), sampleUID)
	if err != nil {
		t.Fatalf("ReadCurrent: %v", err)
	}
	if read.Revision != 1 || int64(len(data)) != meta.Size {
		t.Errorf("read back revision %d, %d bytes (meta says %d)", read.Revision, len(data), meta.Size)
	}
	if !bytes.Equal(data, sent) {
		t.Error("stored bytes are not byte-identical to the ones uploaded")
	}
	preview, err := s.ReadPreview(context.Background(), sampleUID)
	if err != nil || !bytes.Equal(preview, []byte("PNG-first")) {
		t.Errorf("preview = %q, err = %v", preview, err)
	}
}

// The optimistic lock, which is the whole reason a world is not just a file:
// last-writer-wins would silently destroy the other machine's save.
// A meta.json from before the pipeline was mirrored takes it from the
// save at the next start, and keeps it.
func TestStartMirrorsAMissingPipeline(t *testing.T) {
	s := newTestStore(t)
	if _, _, err := putSave(t, s, sampleUID, "first", 0); err != nil {
		t.Fatalf("Put: %v", err)
	}
	raw, _, err := s.bucket.Get(context.Background(), metaKey(sampleUID))
	if err != nil {
		t.Fatal(err)
	}
	var old map[string]any
	body, _ := io.ReadAll(raw)
	_ = raw.Close()
	if err := json.Unmarshal(body, &old); err != nil {
		t.Fatal(err)
	}
	delete(old, "pipeline")
	before, _ := json.Marshal(old)
	writeObject(t, s, metaKey(sampleUID), before)
	again := newTestStoreOn(t, s.bucket, 0)
	meta, err := again.Get(context.Background(), sampleUID)
	if err != nil || meta.Pipeline != "v11-test" {
		t.Fatalf("pipeline after start = %q, err %v", meta.Pipeline, err)
	}
	third := newTestStoreOn(t, s.bucket, 0)
	if e, _ := third.entry(sampleUID); e.noPipeline || e.meta.Pipeline != "v11-test" {
		t.Errorf("pipeline not written back: %+v", e.meta)
	}
}

func TestPutEnforcesTheExpectedRevision(t *testing.T) {
	s := newTestStore(t)
	if _, _, err := putSave(t, s, sampleUID, "v1", 0); err != nil {
		t.Fatalf("create: %v", err)
	}

	if _, _, err := putSave(t, s, sampleUID, "again", 0); !errors.Is(err, ErrExists) {
		t.Errorf("create over an existing world = %v, want ErrExists", err)
	}
	if _, _, err := putSave(t, s, sampleUID, "stale", 5); !errors.Is(err, ErrRevisionMismatch) {
		t.Errorf("update from a wrong revision = %v, want ErrRevisionMismatch", err)
	}

	meta, accepted, err := putSave(t, s, sampleUID, "v2", 1)
	if err != nil {
		t.Fatalf("update from the current revision: %v", err)
	}
	if meta.Revision != 2 {
		t.Errorf("revision = %d, want 2", meta.Revision)
	}

	// A refused write must have changed nothing: what is current is the one
	// accepted update, not either of the two rejected attempts.
	data, _, _ := s.ReadCurrent(context.Background(), sampleUID)
	if !bytes.Equal(data, accepted) {
		t.Error("current contents are not the accepted write")
	}

	// Updating a world that does not exist is a mismatch, not a create.
	other := "11111111-2222-4333-8444-555555555555"
	if _, _, err := putSave(t, s, other, "x", 3); !errors.Is(err, ErrRevisionMismatch) {
		t.Errorf("update of an absent world = %v, want ErrRevisionMismatch", err)
	}
}

// An earlier revision must survive being superseded — this is the half of the
// system where nothing can be recomputed.
func TestPutKeepsPreviousRevisions(t *testing.T) {
	s := newTestStore(t)
	_, firstBytes, err := putSave(t, s, sampleUID, "v1", 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := putSave(t, s, sampleUID, "v2", 1); err != nil {
		t.Fatal(err)
	}
	raw, err := s.read(context.Background(), revKey(sampleUID, 1, zipName), 0)
	if err != nil {
		t.Fatalf("revision 1 should still be stored: %v", err)
	}
	if !bytes.Equal(raw, firstBytes) {
		t.Error("revision 1 no longer holds its own bytes")
	}
}

// meta.json is written LAST, so a world whose meta is missing must read as
// absent rather than as a world pointing at contents nobody promised.
func TestWorldWithoutMetaReadsAsAbsent(t *testing.T) {
	s := newTestStore(t)
	if _, _, err := putSave(t, s, sampleUID, "v1", 0); err != nil {
		t.Fatal(err)
	}
	removeObject(t, s, metaKey(sampleUID))
	if _, err := s.Get(context.Background(), sampleUID); !errors.Is(err, ErrNotFound) {
		t.Errorf("Get = %v, want ErrNotFound", err)
	}
	if _, _, err := s.ReadCurrent(context.Background(), sampleUID); !errors.Is(err, ErrNotFound) {
		t.Errorf("ReadCurrent = %v, want ErrNotFound", err)
	}
	list, err := s.List(context.Background())
	if err != nil || len(list) != 0 {
		t.Errorf("List = %v (%d entries), want empty", err, len(list))
	}
}

func TestListIsNewestFirstAndSkipsBrokenEntries(t *testing.T) {
	s := newTestStore(t)
	uids := []string{
		"aaaaaaaa-1111-4111-8111-111111111111",
		"bbbbbbbb-2222-4222-8222-222222222222",
		"cccccccc-3333-4333-8333-333333333333",
	}
	for _, uid := range uids {
		if _, _, err := putSave(t, s, uid, "x", 0); err != nil {
			t.Fatal(err)
		}
	}
	// A corrupt entry must not take the listing down with it — one broken
	// world should not make the panel unusable.
	// So must a stray object that is not a world at all.
	writeObject(t, s, "not-a-world/x", []byte("x"))
	writeObject(t, s, metaKey(uids[1]), []byte("{not json"))
	if _, err := s.Get(context.Background(), uids[1]); err == nil || errors.Is(err, ErrNotFound) {
		t.Errorf("Get of a corrupt world = %v, want a parse error", err)
	}

	list, err := s.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("List returned %d entries, want 2", len(list))
	}
	if list[0].UID != uids[2] || list[1].UID != uids[0] {
		t.Errorf("order = %s, %s; want newest first", list[0].UID, list[1].UID)
	}
}

func TestDeleteRemovesEveryRevision(t *testing.T) {
	s := newTestStore(t)
	if _, _, err := putSave(t, s, sampleUID, "v1", 0); err != nil {
		t.Fatal(err)
	}
	if _, _, err := putSave(t, s, sampleUID, "v2", 1); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(context.Background(), sampleUID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if n := storedUnder(t, s, sampleUID+"/"); n != 0 {
		t.Errorf("%d objects of the world survived the delete", n)
	}
	if err := s.Delete(context.Background(), sampleUID); !errors.Is(err, ErrNotFound) {
		t.Errorf("second delete = %v, want ErrNotFound", err)
	}
}

// A uid becomes a directory name, so anything that is not a UUID is refused
// rather than sanitised — including the traversal attempts.
func TestInvalidUIDsAreRefused(t *testing.T) {
	s := newTestStore(t)
	for _, uid := range []string{
		"", "..", "../../etc/passwd", "9f2c1b4e_7a30_4d55_8c11_2b6e5d0a1f83",
		"9f2c1b4e-7a30-4d55-8c11-2b6e5d0a1f8", // one short
		"9f2c1b4e-7a30-4d55-8c11-2b6e5d0a1f83/x",
		"../" + sampleUID,
	} {
		if ValidUID(uid) {
			t.Errorf("ValidUID(%q) = true", uid)
		}
		if _, err := s.Get(context.Background(), uid); !errors.Is(err, ErrNotFound) {
			t.Errorf("Get(%q) = %v, want ErrNotFound", uid, err)
		}
	}
	if !ValidUID(sampleUID) {
		t.Error("a real uid must be accepted")
	}
}

// Two uploads of one world racing: the per-world mutex plus the revision check
// must let exactly one through. Without the mutex both could read revision 1
// and both decide they may write 2.
func TestConcurrentPutsLetExactlyOneWin(t *testing.T) {
	s := newTestStore(t)
	if _, _, err := putSave(t, s, sampleUID, "base", 0); err != nil {
		t.Fatal(err)
	}

	const racers = 8
	var wg sync.WaitGroup
	results := make([]error, racers)
	start := make(chan struct{})
	for i := range racers {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			_, _, results[i] = putSave(t, s, sampleUID, "racer", 1)
		}(i)
	}
	close(start)
	wg.Wait()

	won := 0
	for i, err := range results {
		switch {
		case err == nil:
			won++
		case errors.Is(err, ErrRevisionMismatch):
		default:
			t.Errorf("racer %d failed unexpectedly: %v", i, err)
		}
	}
	if won != 1 {
		t.Errorf("%d racers succeeded, want exactly 1", won)
	}
	meta, err := s.Get(context.Background(), sampleUID)
	if err != nil || meta.Revision != 2 {
		t.Errorf("after the race revision = %d (err %v), want 2", meta.Revision, err)
	}
}

func TestCreatedAtSurvivesUpdates(t *testing.T) {
	s := newTestStore(t)
	first, _, err := putSave(t, s, sampleUID, "v1", 0)
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := putSave(t, s, sampleUID, "v2", 1)
	if err != nil {
		t.Fatal(err)
	}
	if !second.CreatedAt.Equal(first.CreatedAt) {
		t.Errorf("createdAt moved: %v -> %v", first.CreatedAt, second.CreatedAt)
	}
	if !second.UpdatedAt.After(first.UpdatedAt) {
		t.Errorf("updatedAt did not advance: %v -> %v", first.UpdatedAt, second.UpdatedAt)
	}
}

// A byte-identical re-upload of the current revision changes nothing, so it
// must mint nothing: same revision back, no new directory on disk.
func TestPutDedupesIdenticalUpload(t *testing.T) {
	s := newTestStore(t)
	first, firstBytes, err := putSave(t, s, sampleUID, "v1", 0)
	if err != nil {
		t.Fatal(err)
	}
	info, err := inspectSave(firstBytes)
	if err != nil {
		t.Fatalf("inspectSave: %v", err)
	}
	again, err := s.Put(context.Background(), sampleUID, firstBytes, info, "local", first.Revision)
	if err != nil {
		t.Fatalf("identical re-upload: %v", err)
	}
	if again.Revision != first.Revision {
		t.Errorf("revision moved on identical bytes: %d -> %d", first.Revision, again.Revision)
	}
	if n := storedUnder(t, s, revPrefix(sampleUID, first.Revision+1)); n != 0 {
		t.Errorf("an identical upload left a new revision behind")
	}
	// Different bytes at the same expected revision still advance as ever.
	if next, _, err := putSave(t, s, sampleUID, "v2", first.Revision); err != nil || next.Revision != first.Revision+1 {
		t.Fatalf("changed upload = rev %d, err %v", next.Revision, err)
	}
}

// Retention: with keepRevisions = 2, the third upload prunes revision 1 while
// the current and its predecessor stay readable.
func TestPruneKeepsNewestN(t *testing.T) {
	store := newTestStoreOn(t, testDir(t, t.TempDir()), 2)
	for i, body := range []string{"v1", "v2", "v3"} {
		if _, _, err := putSave(t, store, sampleUID, body, i); err != nil {
			t.Fatal(err)
		}
	}
	if n := storedUnder(t, store, revPrefix(sampleUID, 1)); n != 0 {
		t.Errorf("revision 1 should have been pruned")
	}
	for _, n := range []int{2, 3} {
		if !stored(t, store, revKey(sampleUID, n, zipName)) {
			t.Errorf("revision %d should be retained", n)
		}
	}
	// The current revision still reads, and the meta still names it.
	if _, meta, err := store.ReadCurrent(context.Background(), sampleUID); err != nil || meta.Revision != 3 {
		t.Errorf("current after prune = rev %d, err %v", meta.Revision, err)
	}
}
