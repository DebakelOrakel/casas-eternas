package artifacts

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DebakelOrakel/casas-eternas/internal/blob"
)

// testLinkKey signs the dir links in tests.
var testLinkKey = []byte("a test link key, at least thirty-two bytes long")

// openTestDir opens a Dir bucket at `dir` that signs links as the module's
// would.
func openTestDir(t *testing.T, dir string) *blob.Dir {
	t.Helper()
	signer, err := blob.NewLinkSigner(LinkBase, UploadLimit, testLinkKey)
	if err != nil {
		t.Fatal(err)
	}
	d, err := blob.OpenDir(dir, signer)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	return d
}

// newStoreAt opens a store on a Dir at `dir`, indexing what is there.
func newStoreAt(t *testing.T, dir string, capBytes int64) *Store {
	t.Helper()
	store, err := NewStore(context.Background(), openTestDir(t, dir), capBytes)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	return store
}

func newTestStore(t *testing.T) *Store {
	t.Helper()
	// Cap 0 (unlimited): eviction has its own tests; everything else asserts
	// on entries it expects to stay.
	return newStoreAt(t, t.TempDir(), 0)
}

// readFile reads one artifact file through the bucket, as a link would.
func readFile(t *testing.T, s *Store, uid, name string) ([]byte, error) {
	t.Helper()
	key, err := objectKey(uid, name)
	if err != nil {
		return nil, err
	}
	body, _, err := s.bucket.Get(context.Background(), key)
	if err != nil {
		return nil, err
	}
	defer func() { _ = body.Close() }()
	return io.ReadAll(body)
}

// write is Store.Write with a string body of known length.
func write(s *Store, uid, name, body string) error {
	return s.Write(context.Background(), uid, name, strings.NewReader(body), int64(len(body)))
}

// tick makes the store's clock advance one second per reading, so the
// order of accesses does not hang on the resolution of the system clock.
func tick(s *Store) {
	at := time.Now()
	var mu sync.Mutex
	s.now = func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		at = at.Add(time.Second)
		return at
	}
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
	if err := write(s, uid, "elevation.u16", payload); err != nil {
		t.Fatalf("Write elevation: %v", err)
	}
	if err := write(s, uid, "meta.json", metaFor(key, label)); err != nil {
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
	if err := write(s, uid, "elevation.u16", "x"); err != nil {
		t.Fatal(err)
	}
	_, files, err = s.Resolve(context.Background(), key, true)
	if err != nil || len(files) != 1 || files[0] != "elevation.u16" {
		t.Fatalf("files = %v (err %v)", files, err)
	}
}

func TestWriteRequiresAMintedArtifact(t *testing.T) {
	s := newTestStore(t)
	if err := write(s, "00000000-0000-4000-8000-000000000000", "elevation.u16", "x"); !errors.Is(err, ErrNotFound) {
		t.Errorf("write into unminted uid = %v, want ErrNotFound", err)
	}
}

func TestReadRoundTripsAndRefusesTraversal(t *testing.T) {
	s := newTestStore(t)
	uid := bake(t, s, testKey(), "Ätna", "raster-bytes")

	raw, err := readFile(t, s, uid, "elevation.u16")
	if err != nil || string(raw) != "raster-bytes" {
		t.Fatalf("read = %q, %v", raw, err)
	}
	if _, err := s.Link(context.Background(), uid, "rivers.f32", time.Minute); !errors.Is(err, ErrNotFound) {
		t.Errorf("link to an absent file = %v, want ErrNotFound", err)
	}
	// The local store's rule and the leaf's key rule both apply: no
	// traversal, no separator games, no names the leaf could not hold.
	for _, name := range []string{"..", "../../etc/passwd", "a/../../b", "", "a\x00b", "a/b/c/d/e", ".hidden", "with space", "ä"} {
		if err := write(s, uid, name, "x"); !errors.Is(err, ErrBadPath) {
			t.Errorf("Write(name=%q) = %v, want ErrBadPath", name, err)
		}
	}
	if _, err := s.Link(context.Background(), "../escape", "meta.json", time.Minute); !errors.Is(err, ErrBadPath) {
		t.Errorf("traversal uid = %v, want ErrBadPath", err)
	}
}

// The index survives a restart because it IS the metas: a fresh Store over
// the same directory resolves the same key.
func TestIndexRebuildsFromMetas(t *testing.T) {
	dir := t.TempDir()
	first := newStoreAt(t, dir, 0)
	key := testKey()
	uid := bake(t, first, key, "Ätna", "payload")

	second := newStoreAt(t, dir, 0)
	found, files, err := second.Resolve(context.Background(), key, false)
	if err != nil || found != uid {
		t.Fatalf("restarted resolve = %q, %v (want %q)", found, err, uid)
	}
	if len(files) != 2 {
		t.Errorf("files after restart = %v", files)
	}
}

// A hand-copied directory — ANY name the key rule allows, as long as its
// meta.json is readable — is indexed when the store opens. Since DEC-0038
// step 3 that is at the next start, not on the next request: the index is
// built from one List and then kept in memory.
func TestHandCopiedDirectoryIsIndexedAtStart(t *testing.T) {
	dir := t.TempDir()
	key := testKey()
	copied := filepath.Join(dir, "backup-von-2026")
	if err := os.MkdirAll(copied, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(copied, "elevation.u16"), []byte("bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(copied, "meta.json"), []byte(metaFor(key, "Ätna")), 0o644); err != nil {
		t.Fatal(err)
	}
	s := newStoreAt(t, dir, 0)

	uid, _, err := s.Resolve(context.Background(), key, false)
	if err != nil || uid != "backup-von-2026" {
		t.Fatalf("hand-copied resolve = %q, %v", uid, err)
	}
}

func TestListReportsMetasAndStrays(t *testing.T) {
	dir := t.TempDir()
	// A directory with no readable meta: bytes with a name, nothing more.
	stray := filepath.Join(dir, "half-copied")
	if err := os.MkdirAll(stray, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stray, "elevation.u16"), []byte(strings.Repeat("s", 60)), 0o644); err != nil {
		t.Fatal(err)
	}
	s := newStoreAt(t, dir, 0)
	keyA := testKey()
	keyB := Key{WorldUID: "uid-bravo", WorldID: "2222222222222222", PipelineVersion: "v6-bbbb", Stage: "4"}
	bake(t, s, keyA, "Ätna", strings.Repeat("a", 100))
	bake(t, s, keyB, "Bravo", strings.Repeat("b", 400))

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
	store := newStoreAt(t, t.TempDir(), 600)
	tick(store)
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
	dir := t.TempDir()
	// A foreign, meta-less directory that this process never touched — as a
	// hand-copy or crashed bake would leave it. Fresh mtime → inside grace.
	freshStray := filepath.Join(dir, "mid-flight")
	if err := os.MkdirAll(freshStray, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(freshStray, "elevation.u16"), []byte(strings.Repeat("s", 120)), 0o644); err != nil {
		t.Fatal(err)
	}
	store := newStoreAt(t, dir, 250)
	keyA := Key{WorldUID: "uid-a", WorldID: "1111111111111111", PipelineVersion: "v6-a", Stage: "2"}
	keyB := Key{WorldUID: "uid-b", WorldID: "2222222222222222", PipelineVersion: "v6-a", Stage: "2"}
	bake(t, store, keyA, "A", strings.Repeat("a", 90))
	bake(t, store, keyB, "B", strings.Repeat("b", 90))

	// Over cap, but the stray is inside the grace — the oldest COMPLETE entry
	// goes instead.
	if _, err := os.Stat(filepath.Join(freshStray, "elevation.u16")); err != nil {
		t.Errorf("a fresh meta-less entry must be spared: %v", err)
	}
	if _, _, err := store.Resolve(context.Background(), keyA, false); !errors.Is(err, ErrNotFound) {
		t.Errorf("expected the oldest complete entry to be evicted instead: %v", err)
	}

	// Age the stray past the grace: now it is junk and goes first.
	store.mu.Lock()
	if e, ok := store.entries["mid-flight"]; ok {
		e.modified = time.Now().Add(-2 * evictionGrace)
	}
	store.mu.Unlock()
	keyC := Key{WorldUID: "uid-c", WorldID: "4444444444444444", PipelineVersion: "v6-a", Stage: "2"}
	bake(t, store, keyC, "C", strings.Repeat("c", 90))
	if _, err := os.Stat(filepath.Join(freshStray, "elevation.u16")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("an aged meta-less entry must be the first victim: %v", err)
	}
}

// Whole is the batch presence answer: an artifact counts once its meta.json
// is there, a reservation or an unknown key does not.
func TestWholeAnswersPerKey(t *testing.T) {
	s := newTestStore(t)
	done := testKey()
	bake(t, s, done, "done", "x")
	reserved := testKey()
	reserved.Stage = "3"
	uid, _, err := s.Resolve(context.Background(), reserved, true)
	if err != nil {
		t.Fatal(err)
	}
	if err := write(s, uid, "elevation.u16", "x"); err != nil {
		t.Fatal(err)
	}
	unknown := testKey()
	unknown.Stage = "4"
	whole, err := s.Whole(context.Background(), []Key{done, reserved, unknown})
	if err != nil {
		t.Fatal(err)
	}
	if len(whole) != 3 || !whole[0] || whole[1] || whole[2] {
		t.Fatalf("Whole = %v, want [true false false]", whole)
	}
}

// writeTree writes files under dir; a name ending in "/" is a directory.
func writeTree(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for name, body := range files {
		path := filepath.Join(dir, filepath.FromSlash(name))
		if strings.HasSuffix(name, "/") {
			if err := os.MkdirAll(path, 0o755); err != nil {
				t.Fatal(err)
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// A directory written by the store before DEC-0038 step 3 (and by the job
// worker's own fs store) opens as it is: no migration for local users. The
// fixture holds every shape that layout left behind.
func TestOldLayoutOpensAsItIs(t *testing.T) {
	dir := t.TempDir()
	level := Key{WorldUID: "2bfe969c-1c67-4b8e-9dc6-3f6d2fddc001", WorldID: "e609be7190af0d7f", PipelineVersion: "v6-1a2b", Stage: "L1"}
	tile := level
	tile.Stage = "L2:3,4"
	const levelUID = "0001f5f4-4b3b-4f3d-861f-852b97080def"
	const tileUID = "0002470b-562c-4620-b940-c660bac3623f"
	writeTree(t, dir, map[string]string{
		// A whole level: meta, files, one nested level of files.
		levelUID + "/meta.json":              metaFor(level, "Level"),
		levelUID + "/meshZ.f32":              "zzzz",
		levelUID + "/family-1/elevation.u16": "ee",
		// The Go store's unfinished temp file (os.CreateTemp ".tmp-*"):
		// not an object, not counted.
		levelUID + "/.tmp-123456": "half",
		// A tile, with the worker's leftover temp file (`<name>.tmp-<pid>`):
		// a file like any other, counted, as before.
		tileUID + "/meta.json":          metaFor(tile, "Tile"),
		tileUID + "/tileZ.f32":          "tt",
		tileUID + "/tileZ.f32.tmp-4242": "t",
		// A minted entry whose writer never wrote: an empty directory.
		"5f0e1c4a-0000-4000-8000-000000000001/": "",
		// A meta-less entry: junk with bytes.
		"5f0e1c4a-0000-4000-8000-000000000002/elevation.u16": "jjj",
		// A stray file at the root: ignored, as it always was.
		"stray.txt": "s",
	})
	s := newStoreAt(t, dir, 0)

	uid, files, err := s.Resolve(context.Background(), level, false)
	if err != nil || uid != levelUID {
		t.Fatalf("level resolve = %q, %v", uid, err)
	}
	if want := "family-1/elevation.u16 meshZ.f32 meta.json"; strings.Join(files, " ") != want {
		t.Errorf("level files = %v, want %s", files, want)
	}
	if uid, _, err := s.Resolve(context.Background(), tile, false); err != nil || uid != tileUID {
		t.Errorf("tile resolve = %q, %v", uid, err)
	}
	if whole, _ := s.Whole(context.Background(), []Key{level, tile}); !whole[0] || !whole[1] {
		t.Errorf("Whole = %v, want both", whole)
	}
	raw, err := readFile(t, s, levelUID, "family-1/elevation.u16")
	if err != nil || string(raw) != "ee" {
		t.Errorf("nested read = %q, %v", raw, err)
	}
	link, err := s.Link(context.Background(), levelUID, "meshZ.f32", time.Minute)
	if err != nil || !strings.HasPrefix(link.URL, LinkBase+levelUID+"/meshZ.f32?") {
		t.Errorf("link = %+v, %v", link, err)
	}

	listed, _ := s.List(context.Background())
	byUID := map[string]ListedArtifact{}
	for _, a := range listed {
		byUID[a.ArtifactUID] = a
	}
	if len(listed) != 3 {
		t.Errorf("listed %d entries, want level, tile and junk: %+v", len(listed), listed)
	}
	if a := byUID[levelUID]; a.Stage != "L1" || a.Bytes != int64(len(metaFor(level, "Level"))+4+2) {
		t.Errorf("level entry = %+v (the temp file must not count)", a)
	}
	if a := byUID[tileUID]; a.Stage != "L2:3,4" || a.Bytes != int64(len(metaFor(tile, "Tile"))+2+1) {
		t.Errorf("tile entry = %+v", a)
	}
	if a := byUID["5f0e1c4a-0000-4000-8000-000000000002"]; a.WorldUID != "" || a.Bytes != 3 {
		t.Errorf("junk entry = %+v", a)
	}

	// Writes go on in the same layout.
	if err := write(s, levelUID, "rivers.f32", "rr"); err != nil {
		t.Fatal(err)
	}
	if raw, err := os.ReadFile(filepath.Join(dir, levelUID, "rivers.f32")); err != nil || string(raw) != "rr" {
		t.Errorf("written file on disk = %q, %v", raw, err)
	}
	// And removal takes the files off the disk.
	if err := s.RemoveArtifact(context.Background(), tileUID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, tileUID, "tileZ.f32")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("removed tile still on disk: %v", err)
	}
}

// The recency the sweep orders by is recorded by this process: a link
// handed out counts as a use, and it outranks the meta's createdAt. After a
// restart nothing is recorded (DEC-0038: S3 has no atime, and the access
// time is not persisted), and createdAt — the bake time — orders instead.
func TestEvictionUsesRecordedAccessThenCreatedAt(t *testing.T) {
	dir := t.TempDir()
	store := newStoreAt(t, dir, 0)
	tick(store)
	keys := []Key{
		{WorldUID: "uid-a", WorldID: "1111111111111111", PipelineVersion: "v6-a", Stage: "2"},
		{WorldUID: "uid-a", WorldID: "2222222222222222", PipelineVersion: "v6-a", Stage: "2"},
	}
	// The first is baked EARLIER by the meta's clock (createdAt).
	created := []int64{1_000_000, 2_000_000}
	uids := make([]string, len(keys))
	for i, key := range keys {
		uid, _, err := store.Resolve(context.Background(), key, true)
		if err != nil {
			t.Fatal(err)
		}
		uids[i] = uid
		if err := write(store, uid, "elevation.u16", strings.Repeat("x", 100)); err != nil {
			t.Fatal(err)
		}
		meta := strings.TrimSuffix(metaFor(key, "m"), "}") + `,"createdAt":` + strconvI(created[i]) + `}`
		if err := write(store, uid, "meta.json", meta); err != nil {
			t.Fatal(err)
		}
	}
	firstVictim := func(s *Store) string {
		t.Helper()
		s.mu.Lock()
		defer s.mu.Unlock()
		s.cap = 1 // every entry is a candidate
		victims := s.sweepLocked("")
		if len(victims) == 0 {
			t.Fatal("no victims")
		}
		uid, _, _ := strings.Cut(victims[0], "/")
		return uid
	}
	// In this process the first is used last (a link): the second goes
	// first, although createdAt alone would pick the first.
	if _, err := store.Link(context.Background(), uids[0], "elevation.u16", time.Minute); err != nil {
		t.Fatal(err)
	}
	if got := firstVictim(store); got != uids[1] {
		t.Errorf("first victim = %s, want %s (not used since its write)", got, uids[1])
	}
	// The sweep above only dropped the index entries; the files stay, so a
	// restart sees both again, with no access recorded.
	if got := firstVictim(newStoreAt(t, dir, 0)); got != uids[0] {
		t.Errorf("after a restart the first victim = %s, want %s (the older createdAt)", got, uids[0])
	}
}

func strconvI(n int64) string { return strconv.FormatInt(n, 10) }

// A body of unknown length (a chunked upload) is spooled and stored whole.
func TestWriteOfUnknownLength(t *testing.T) {
	s := newTestStore(t)
	uid, _, err := s.Resolve(context.Background(), testKey(), true)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Write(context.Background(), uid, "elevation.u16", strings.NewReader("chunked bytes"), -1); err != nil {
		t.Fatal(err)
	}
	if raw, err := readFile(t, s, uid, "elevation.u16"); err != nil || string(raw) != "chunked bytes" {
		t.Errorf("read = %q, %v", raw, err)
	}
	// A body shorter than its stated length is refused, and nothing lands.
	if err := s.Write(context.Background(), uid, "short.u16", strings.NewReader("abc"), 10); !errors.Is(err, blob.ErrSize) {
		t.Errorf("short body = %v, want ErrSize", err)
	}
	if _, err := readFile(t, s, uid, "short.u16"); !errors.Is(err, blob.ErrNotFound) {
		t.Errorf("a refused write left an object: %v", err)
	}
	if _, files, _ := s.Resolve(context.Background(), testKey(), false); strings.Join(files, " ") != "elevation.u16" {
		t.Errorf("files = %v", files)
	}
}

// Removal while a write is on its way: the index must not keep a ghost
// and the bucket must not keep an orphan.
func TestWriteIntoARemovedArtifactLeavesNothing(t *testing.T) {
	s := newTestStore(t)
	uid, _, err := s.Resolve(context.Background(), testKey(), true)
	if err != nil {
		t.Fatal(err)
	}
	// The body's first read removes the artifact: the write has passed its
	// check and is in Put.
	body := &onFirstRead{Reader: strings.NewReader("bytes"), do: func() { _ = s.RemoveArtifact(context.Background(), uid) }}
	if err := s.Write(context.Background(), uid, "elevation.u16", body, 5); !errors.Is(err, ErrNotFound) {
		t.Errorf("write into a removed artifact = %v, want ErrNotFound", err)
	}
	if _, err := readFile(t, s, uid, "elevation.u16"); !errors.Is(err, blob.ErrNotFound) {
		t.Errorf("an orphan object stayed: %v", err)
	}
}

type onFirstRead struct {
	io.Reader
	do   func()
	done bool
}

func (r *onFirstRead) Read(p []byte) (int, error) {
	if !r.done {
		r.done = true
		r.do()
	}
	return r.Reader.Read(p)
}

// Junk whose top-level name breaks the key rule (copied in by hand, with a
// space or a non-ASCII letter) cannot be deleted through the leaf's Delete;
// the sweep removes it through the dir backend's junk path, so that it does
// not come back at the next start. The evicted valid entry leaves no empty
// directory either.
func TestSweepRemovesJunkWithInvalidNames(t *testing.T) {
	dir := t.TempDir()
	names := []string{"copy of entry", "Ärger"}
	for _, name := range names {
		if err := os.MkdirAll(filepath.Join(dir, name, "family 1"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, name, "elevation.u16"), []byte(strings.Repeat("j", 120)), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, name, "family 1", "ä.u16"), []byte("j"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	store := newStoreAt(t, dir, 250)
	store.mu.Lock()
	for _, name := range names {
		e, ok := store.entries[name]
		if !ok {
			store.mu.Unlock()
			t.Fatalf("%q was not indexed as junk", name)
		}
		e.modified = time.Now().Add(-2 * evictionGrace)
	}
	store.mu.Unlock()
	keyA := Key{WorldUID: "uid-a", WorldID: "1111111111111111", PipelineVersion: "v6-a", Stage: "2"}
	keyB := Key{WorldUID: "uid-b", WorldID: "2222222222222222", PipelineVersion: "v6-a", Stage: "2"}
	keyC := Key{WorldUID: "uid-c", WorldID: "3333333333333333", PipelineVersion: "v6-a", Stage: "2"}
	uidA := bake(t, store, keyA, "A", strings.Repeat("a", 90))
	bake(t, store, keyB, "B", strings.Repeat("b", 90))
	bake(t, store, keyC, "C", strings.Repeat("c", 90))
	for _, name := range names {
		if _, err := os.Lstat(filepath.Join(dir, name)); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("junk %q is still on disk: %v", name, err)
		}
	}
	if _, _, err := store.Resolve(context.Background(), keyA, false); !errors.Is(err, ErrNotFound) {
		t.Fatalf("the oldest entry should have been evicted after the junk: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(dir, uidA)); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the evicted entry left its directory: %v", err)
	}
	// A restart does not find the junk again.
	again := newStoreAt(t, dir, 250)
	again.mu.Lock()
	defer again.mu.Unlock()
	for _, name := range names {
		if _, ok := again.entries[name]; ok {
			t.Errorf("junk %q came back at the next start", name)
		}
	}
}
