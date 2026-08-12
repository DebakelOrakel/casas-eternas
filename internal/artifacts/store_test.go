package artifacts

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	// Cap 0 (unlimited): eviction has its own tests; everything else asserts
	// on entries it expects to stay.
	store, err := NewStore(t.TempDir(), 0)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	return store
}

func testKey() Key {
	return Key{WorldUID: "2bfe969c-1c67-4b8e-9dc6-3f6d2fddc001", WorldID: "e609be7190af0d7f", PipelineVersion: "v6-1a2b3c4d5e6f7081", Stage: "2"}
}

// metaFor renders the client's meta.json for a key — the one file that makes
// an entry resolvable.
func metaFor(key Key, label string) string {
	return `{"key":{"worldUid":"` + key.WorldUID + `","worldId":"` + key.WorldID + `","pipelineVersion":"` + key.PipelineVersion + `","stage":"` + key.Stage + `"},"label":"` + label + `","width":4096,"height":2048,"bakeMs":9000}`
}

// bake writes a complete artifact the way the client does: resolve with
// create, files, meta last. Returns the uid.
func bake(t *testing.T, s *Store, key Key, label, payload string) string {
	t.Helper()
	uid, _, err := s.Resolve(context.Background(), key, true)
	if err != nil {
		t.Fatalf("Resolve(create): %v", err)
	}
	if err := s.Write(context.Background(), uid, "elevation.u16", strings.NewReader(payload)); err != nil {
		t.Fatalf("Write elevation: %v", err)
	}
	if err := s.Write(context.Background(), uid, "meta.json", strings.NewReader(metaFor(key, label))); err != nil {
		t.Fatalf("Write meta: %v", err)
	}
	return uid
}

func TestResolveMintsOnceAndReuses(t *testing.T) {
	s := newTestStore(t)
	key := testKey()

	if _, _, err := s.Resolve(context.Background(), key, false); !errors.Is(err, ErrNotFound) {
		t.Fatalf("resolve of an absent key = %v, want ErrNotFound", err)
	}
	uid, files, err := s.Resolve(context.Background(), key, true)
	if err != nil || uid == "" || len(files) != 0 {
		t.Fatalf("create = %q, %v, %v", uid, files, err)
	}
	// The same key resolves to the SAME uid — the idempotency the old path
	// grammar provided by construction, now provided by the reservation.
	again, _, err := s.Resolve(context.Background(), key, true)
	if err != nil || again != uid {
		t.Fatalf("second create = %q, want %q (err %v)", again, uid, err)
	}
	// The resolve response carries the present files — the batch existence
	// answer that used to be the `present` endpoint.
	if err := s.Write(context.Background(), uid, "elevation.u16", strings.NewReader("x")); err != nil {
		t.Fatal(err)
	}
	_, files, err = s.Resolve(context.Background(), key, true)
	if err != nil || len(files) != 1 || files[0] != "elevation.u16" {
		t.Fatalf("files = %v (err %v)", files, err)
	}
}

func TestWriteRequiresAMintedArtifact(t *testing.T) {
	s := newTestStore(t)
	if err := s.Write(context.Background(), "00000000-0000-4000-8000-000000000000", "elevation.u16", strings.NewReader("x")); !errors.Is(err, ErrNotFound) {
		t.Errorf("write into unminted uid = %v, want ErrNotFound", err)
	}
}

func TestReadRoundTripsAndRefusesTraversal(t *testing.T) {
	s := newTestStore(t)
	uid := bake(t, s, testKey(), "Ätna", "raster-bytes")

	raw, err := s.Read(context.Background(), uid, "elevation.u16")
	if err != nil || string(raw) != "raster-bytes" {
		t.Fatalf("read = %q, %v", raw, err)
	}
	if _, err := s.Read(context.Background(), uid, "rivers.f32"); !errors.Is(err, ErrNotFound) {
		t.Errorf("absent file = %v, want ErrNotFound", err)
	}
	for _, name := range []string{"..", "../../etc/passwd", "a/../../b", "", "a\x00b", "a/b/c/d/e"} {
		if err := s.Write(context.Background(), uid, name, strings.NewReader("x")); !errors.Is(err, ErrBadPath) {
			t.Errorf("Write(name=%q) = %v, want ErrBadPath", name, err)
		}
	}
	if _, err := s.Read(context.Background(), "../escape", "meta.json"); !errors.Is(err, ErrBadPath) {
		t.Errorf("traversal uid = %v, want ErrBadPath", err)
	}
}

// The index survives a restart because it IS the metas: a fresh Store over
// the same directory resolves the same key.
func TestIndexRebuildsFromMetas(t *testing.T) {
	dir := t.TempDir()
	first, err := NewStore(dir, 0)
	if err != nil {
		t.Fatal(err)
	}
	key := testKey()
	uid := bake(t, first, key, "Ätna", "payload")

	second, err := NewStore(dir, 0)
	if err != nil {
		t.Fatal(err)
	}
	found, files, err := second.Resolve(context.Background(), key, false)
	if err != nil || found != uid {
		t.Fatalf("restarted resolve = %q, %v (want %q)", found, err, uid)
	}
	if len(files) != 2 {
		t.Errorf("files after restart = %v", files)
	}
}

// A hand-copied directory — ANY name, as long as its meta.json is readable —
// is indexed on the next access, without a restart. This is the property the
// whole redesign exists for.
func TestHandCopiedDirectoryIsIndexed(t *testing.T) {
	s := newTestStore(t)
	key := testKey()
	copied := filepath.Join(s.dir, "backup-von-2026")
	if err := os.MkdirAll(copied, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(copied, "elevation.u16"), []byte("bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(copied, "meta.json"), []byte(metaFor(key, "Ätna")), 0o644); err != nil {
		t.Fatal(err)
	}

	uid, _, err := s.Resolve(context.Background(), key, false)
	if err != nil || uid != "backup-von-2026" {
		t.Fatalf("hand-copied resolve = %q, %v", uid, err)
	}
}

func TestListReportsMetasAndStrays(t *testing.T) {
	s := newTestStore(t)
	keyA := testKey()
	keyB := Key{WorldUID: "uid-bravo", WorldID: "2222222222222222", PipelineVersion: "v6-bbbb", Stage: "4"}
	bake(t, s, keyA, "Ätna", strings.Repeat("a", 100))
	bake(t, s, keyB, "Bravo", strings.Repeat("b", 400))
	// A directory with no readable meta: bytes with a name, nothing more.
	stray := filepath.Join(s.dir, "half-copied")
	if err := os.MkdirAll(stray, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stray, "elevation.u16"), []byte(strings.Repeat("s", 60)), 0o644); err != nil {
		t.Fatal(err)
	}

	artifacts, err := s.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(artifacts) != 3 {
		t.Fatalf("List returned %d entries, want 3", len(artifacts))
	}
	// Largest first.
	if artifacts[0].Label != "Bravo" || artifacts[0].WorldUID != "uid-bravo" || artifacts[0].Stage != "4" {
		t.Errorf("first entry = %+v", artifacts[0])
	}
	var strayEntry *ListedArtifact
	var listed int64
	for i := range artifacts {
		listed += artifacts[i].Bytes
		if artifacts[i].ArtifactUID == "half-copied" {
			strayEntry = &artifacts[i]
		}
	}
	if strayEntry == nil || strayEntry.WorldUID != "" || strayEntry.Bytes != 60 {
		t.Fatalf("stray entry = %+v", strayEntry)
	}
	// The listing and the usage figure must agree — the invariant whose
	// violation showed as phantom megabytes above an empty panel.
	usage, _ := s.Usage(context.Background())
	if usage != listed {
		t.Errorf("usage %d disagrees with the listing sum %d", usage, listed)
	}
}

func TestRemoveArtifactWorldAndClear(t *testing.T) {
	s := newTestStore(t)
	keyA1 := Key{WorldUID: "uid-alpha", WorldID: "1111111111111111", PipelineVersion: "v6-aaaa", Stage: "2"}
	keyA2 := Key{WorldUID: "uid-alpha", WorldID: "3333333333333333", PipelineVersion: "v6-aaaa", Stage: "2"}
	keyB := Key{WorldUID: "uid-bravo", WorldID: "2222222222222222", PipelineVersion: "v6-aaaa", Stage: "2"}
	uidA1 := bake(t, s, keyA1, "Alpha", "a1")
	bake(t, s, keyA2, "Alpha", "a2")
	uidB := bake(t, s, keyB, "Bravo", "b")

	if err := s.RemoveArtifact(context.Background(), uidA1); err != nil {
		t.Fatalf("RemoveArtifact: %v", err)
	}
	if _, _, err := s.Resolve(context.Background(), keyA1, false); !errors.Is(err, ErrNotFound) {
		t.Errorf("removed artifact still resolves: %v", err)
	}

	// The world sweep works off the metas: every entry naming uid-alpha goes.
	if err := s.RemoveWorld(context.Background(), "uid-alpha"); err != nil {
		t.Fatalf("RemoveWorld: %v", err)
	}
	if _, _, err := s.Resolve(context.Background(), keyA2, false); !errors.Is(err, ErrNotFound) {
		t.Errorf("swept world still resolves: %v", err)
	}
	if _, _, err := s.Resolve(context.Background(), keyB, false); err != nil {
		t.Errorf("the other world was affected: %v", err)
	}
	if err := s.RemoveWorld(context.Background(), "uid-alpha"); !errors.Is(err, ErrNotFound) {
		t.Errorf("second sweep = %v, want ErrNotFound", err)
	}

	if err := s.Clear(context.Background()); err != nil {
		t.Fatalf("Clear: %v", err)
	}
	if _, _, err := s.Resolve(context.Background(), keyB, false); !errors.Is(err, ErrNotFound) {
		t.Errorf("cleared store still resolves: %v", err)
	}
	// The store must still be usable afterwards, not merely empty.
	if again := bake(t, s, keyB, "Bravo", "again"); again == uidB {
		t.Log("uid reuse after clear is fine but statistically absurd")
	}
}

// Concurrent resolves of one key must agree on a single uid — the property
// that lets two machines bake the same world without coordination.
func TestConcurrentResolvesShareOneUID(t *testing.T) {
	s := newTestStore(t)
	key := testKey()
	uids := make([]string, 8)
	var wg sync.WaitGroup
	for i := range uids {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			uid, _, err := s.Resolve(context.Background(), key, true)
			if err != nil {
				t.Errorf("resolver %d: %v", i, err)
			}
			uids[i] = uid
		}(i)
	}
	wg.Wait()
	for _, uid := range uids[1:] {
		if uid != uids[0] {
			t.Fatalf("resolvers disagreed: %v", uids)
		}
	}
}

// The cap: writes past it evict least-recently-used artifacts — never the one
// just written — and meta-less junk goes first once it is older than the
// grace.
func TestCapEvictsLeastRecentlyUsed(t *testing.T) {
	// A complete test artifact is ~270 bytes (90 payload + ~180 meta); 600
	// holds two of them, so exactly one eviction is needed once three exist.
	store, err := NewStore(t.TempDir(), 600)
	if err != nil {
		t.Fatal(err)
	}
	oldKey := Key{WorldUID: "uid-a", WorldID: "1111111111111111", PipelineVersion: "v6-a", Stage: "2"}
	hotKey := Key{WorldUID: "uid-a", WorldID: "2222222222222222", PipelineVersion: "v6-a", Stage: "2"}
	bake(t, store, oldKey, "Old", strings.Repeat("o", 90))
	bake(t, store, hotKey, "Hot", strings.Repeat("h", 90))
	// Touch the second entry so the first is the least recently used.
	if _, _, err := store.Resolve(context.Background(), hotKey, false); err != nil {
		t.Fatal(err)
	}

	// This write pushes the total past 250 bytes; the sweep must reclaim the
	// stale entry, keep the touched one, and never eat the newcomer.
	newKey := Key{WorldUID: "uid-b", WorldID: "3333333333333333", PipelineVersion: "v6-a", Stage: "2"}
	newUID := bake(t, store, newKey, "New", strings.Repeat("n", 90))

	if _, _, err := store.Resolve(context.Background(), oldKey, false); !errors.Is(err, ErrNotFound) {
		t.Errorf("stale entry survived the sweep: %v", err)
	}
	if _, _, err := store.Resolve(context.Background(), hotKey, false); err != nil {
		t.Errorf("recently used entry was evicted: %v", err)
	}
	if uid, _, err := store.Resolve(context.Background(), newKey, false); err != nil || uid != newUID {
		t.Errorf("the just-written entry must never be the victim: %q, %v", uid, err)
	}
}

// A meta-less directory INSIDE the grace is spared (it may be another
// writer's bake mid-flight); the same directory past the grace is the first
// thing the sweep takes.
func TestCapSparesFreshMetalessEntries(t *testing.T) {
	store, err := NewStore(t.TempDir(), 250)
	if err != nil {
		t.Fatal(err)
	}
	// A foreign, meta-less directory that this process never touched — as a
	// hand-copy or crashed bake would leave it. Fresh mtime → inside grace.
	freshStray := filepath.Join(store.dir, "mid-flight")
	if err := os.MkdirAll(freshStray, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(freshStray, "elevation.u16"), []byte(strings.Repeat("s", 120)), 0o644); err != nil {
		t.Fatal(err)
	}
	keyA := Key{WorldUID: "uid-a", WorldID: "1111111111111111", PipelineVersion: "v6-a", Stage: "2"}
	keyB := Key{WorldUID: "uid-b", WorldID: "2222222222222222", PipelineVersion: "v6-a", Stage: "2"}
	bake(t, store, keyA, "A", strings.Repeat("a", 90))
	bake(t, store, keyB, "B", strings.Repeat("b", 90))

	// Over cap, but the stray is inside the grace — the oldest COMPLETE entry
	// goes instead.
	if _, err := os.Stat(freshStray); err != nil {
		t.Errorf("a fresh meta-less entry must be spared: %v", err)
	}
	if _, _, err := store.Resolve(context.Background(), keyA, false); !errors.Is(err, ErrNotFound) {
		t.Errorf("expected the oldest complete entry to be evicted instead: %v", err)
	}

	// Age the stray past the grace: now it is junk and goes first.
	old := time.Now().Add(-2 * evictionGrace)
	if err := os.Chtimes(freshStray, old, old); err != nil {
		t.Fatal(err)
	}
	store.mu.Lock()
	if e, ok := store.entries["mid-flight"]; ok {
		e.mtime = old // the index cached the fresh mtime; age it the same way
	}
	store.mu.Unlock()
	keyC := Key{WorldUID: "uid-c", WorldID: "4444444444444444", PipelineVersion: "v6-a", Stage: "2"}
	bake(t, store, keyC, "C", strings.Repeat("c", 90))
	if _, err := os.Stat(freshStray); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("an aged meta-less entry must be the first victim: %v", err)
	}
}
