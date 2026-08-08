package artifacts

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	return store
}

// A realistic key: the client's world id carries a sanitised seed label plus a
// 64-bit hash, and its labels keep accents on purpose.
func testKey() Key {
	return Key{WorldID: "Ätna-e609be7190af0d7f", PipelineVersion: "v2-1a2b3c4d5e6f7081", Stage: "2"}
}

func write(t *testing.T, s *Store, key Key, name, body string) {
	t.Helper()
	if err := s.Write(key, name, strings.NewReader(body)); err != nil {
		t.Fatalf("Write %s: %v", name, err)
	}
}

func TestWriteReadRoundTrips(t *testing.T) {
	s := newTestStore(t)
	key := testKey()
	write(t, s, key, "elevation.u16", "raster-bytes")

	raw, err := s.Read(key, "elevation.u16")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if !bytes.Equal(raw, []byte("raster-bytes")) {
		t.Errorf("read back %q", raw)
	}
	if _, err := s.Read(key, "rivers.f32"); !errors.Is(err, ErrNotFound) {
		t.Errorf("absent file = %v, want ErrNotFound", err)
	}
	// The layout must match the client's grammar, one level under the root.
	if _, err := os.Stat(filepath.Join(s.dir, key.WorldID, key.PipelineVersion, key.Stage, "elevation.u16")); err != nil {
		t.Errorf("expected layout not on disk: %v", err)
	}
}

// The property that makes locking unnecessary: the key describes the bytes, so
// writing twice is a no-op rather than a conflict. This is the deliberate
// opposite of the world store, which refuses an unexpected revision.
func TestWriteIsIdempotent(t *testing.T) {
	s := newTestStore(t)
	key := testKey()
	for i := 0; i < 3; i++ {
		write(t, s, key, "elevation.u16", "same-bytes")
	}
	raw, err := s.Read(key, "elevation.u16")
	if err != nil || !bytes.Equal(raw, []byte("same-bytes")) {
		t.Fatalf("read = %q, err %v", raw, err)
	}
}

// Concurrent writers must all succeed and leave a complete file — no torn
// content, no leftover temporaries. Guaranteed by write-to-temp-then-rename,
// which is the only thing standing in for a lock here.
func TestConcurrentWritesAllSucceed(t *testing.T) {
	s := newTestStore(t)
	key := testKey()
	const body = "identical-payload-from-every-writer"

	var wg sync.WaitGroup
	errs := make([]error, 8)
	for i := range errs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			errs[i] = s.Write(key, "elevation.u16", strings.NewReader(body))
		}(i)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Errorf("writer %d: %v", i, err)
		}
	}
	raw, err := s.Read(key, "elevation.u16")
	if err != nil || string(raw) != body {
		t.Fatalf("read = %q, err %v", raw, err)
	}
	entries, _ := os.ReadDir(s.stageDir(key))
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".tmp-") {
			t.Errorf("temporary file survived: %s", entry.Name())
		}
	}
}

// The whole point of `present`: discovering the gaps in one round trip.
func TestPresentReportsBothHalves(t *testing.T) {
	s := newTestStore(t)
	key := testKey()
	write(t, s, key, "elevation.u16", "x")
	write(t, s, key, "meta.json", "{}")

	present, err := s.Present(key, []string{"elevation.u16", "rivers.f32", "meta.json", "riverLengths.u32"})
	if err != nil {
		t.Fatalf("Present: %v", err)
	}
	if len(present) != 2 || present[0] != "elevation.u16" || present[1] != "meta.json" {
		t.Errorf("present = %v", present)
	}
	// A malformed name answers "no", rather than failing the whole query — the
	// caller asked whether it is held, and it is not.
	if got, _ := s.Present(key, []string{"../escape"}); len(got) != 0 {
		t.Errorf("a traversal name must not report present: %v", got)
	}
	// A directory is not an artifact.
	write(t, s, key, "tiles/12_7", "tile")
	if got, _ := s.Present(key, []string{"tiles"}); len(got) != 0 {
		t.Errorf("a directory must not report present: %v", got)
	}
	if got, _ := s.Present(key, []string{"tiles/12_7"}); len(got) != 1 {
		t.Errorf("a nested name should be found: %v", got)
	}
}

// Every component becomes a directory name, so traversal is refused rather
// than sanitised. The label may carry accents — that is deliberate, and the
// rule is about separators and control characters, not about alphabet.
func TestPathsAreRefusedNotSanitised(t *testing.T) {
	s := newTestStore(t)
	good := testKey()
	if !good.Valid() {
		t.Fatal("a realistic key with an accented label must be accepted")
	}

	bad := []Key{
		{WorldID: "..", PipelineVersion: "v1", Stage: "2"},
		{WorldID: "a/b", PipelineVersion: "v1", Stage: "2"},
		{WorldID: `a\b`, PipelineVersion: "v1", Stage: "2"},
		{WorldID: "", PipelineVersion: "v1", Stage: "2"},
		{WorldID: "w", PipelineVersion: "../../etc", Stage: "2"},
		{WorldID: "w", PipelineVersion: "v1", Stage: "."},
		{WorldID: "w", PipelineVersion: "v1", Stage: "a\x00b"},
		{WorldID: strings.Repeat("x", maxSegment+1), PipelineVersion: "v1", Stage: "2"},
	}
	for _, key := range bad {
		if key.Valid() {
			t.Errorf("Valid(%+v) = true", key)
		}
		if err := s.Write(key, "elevation.u16", strings.NewReader("x")); !errors.Is(err, ErrBadPath) {
			t.Errorf("Write(%+v) = %v, want ErrBadPath", key, err)
		}
	}
	for _, name := range []string{"..", "../../etc/passwd", "a/../../b", "", "a\x00b", "a/b/c/d/e"} {
		if err := s.Write(good, name, strings.NewReader("x")); !errors.Is(err, ErrBadPath) {
			t.Errorf("Write(name=%q) = %v, want ErrBadPath", name, err)
		}
	}
	// Nothing may have escaped the root.
	entries, _ := os.ReadDir(s.dir)
	for _, entry := range entries {
		if entry.Name() != good.WorldID {
			t.Errorf("unexpected entry at the root: %s", entry.Name())
		}
	}
}

func TestListGroupsAndMeasures(t *testing.T) {
	s := newTestStore(t)
	small := Key{WorldID: "alpha-1111111111111111", PipelineVersion: "v2-aaaa", Stage: "2"}
	large := Key{WorldID: "alpha-1111111111111111", PipelineVersion: "v2-aaaa", Stage: "4"}
	other := Key{WorldID: "bravo-2222222222222222", PipelineVersion: "v2-aaaa", Stage: "2"}

	write(t, s, small, "elevation.u16", strings.Repeat("a", 100))
	write(t, s, small, "meta.json", `{"width":4096,"height":2048,"bakeMs":102000}`)
	write(t, s, large, "elevation.u16", strings.Repeat("b", 400))
	write(t, s, other, "elevation.u16", strings.Repeat("c", 50))

	worlds, err := s.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(worlds) != 2 {
		t.Fatalf("List returned %d worlds, want 2", len(worlds))
	}
	// Largest world first, so the panel leads with what is actually costing room.
	if worlds[0].WorldID != small.WorldID {
		t.Errorf("order = %s first; want the larger world", worlds[0].WorldID)
	}
	if len(worlds[0].Stages) != 2 {
		t.Fatalf("world has %d stages, want 2", len(worlds[0].Stages))
	}
	// Stages smallest first — the quickest read of what a world has cost.
	if worlds[0].Stages[0].Stage != "2" || worlds[0].Stages[1].Stage != "4" {
		t.Errorf("stage order = %s, %s", worlds[0].Stages[0].Stage, worlds[0].Stages[1].Stage)
	}
	if worlds[0].Stages[0].Width != 4096 || worlds[0].Stages[0].BakeMs != 102000 {
		t.Errorf("meta.json not read: %+v", worlds[0].Stages[0])
	}
	// The stage with no meta.json still counts toward size; it occupies disk
	// either way, and dropping it would understate usage.
	if worlds[0].Stages[1].Bytes != 400 || worlds[0].Stages[1].Width != 0 {
		t.Errorf("stage without meta = %+v", worlds[0].Stages[1])
	}
	if worlds[0].Bytes != 100+int64(len(`{"width":4096,"height":2048,"bakeMs":102000}`))+400 {
		t.Errorf("world bytes = %d", worlds[0].Bytes)
	}

	usage, err := s.Usage()
	if err != nil {
		t.Fatalf("Usage: %v", err)
	}
	if usage != worlds[0].Bytes+worlds[1].Bytes {
		t.Errorf("usage %d does not match the sum of the worlds", usage)
	}
}

// A stage may hold nested files once artifacts are tiled. Counting only the
// stage's direct children reported those stages as empty while Usage counted
// them, so the panel's per-world figure and its total disagreed — found by
// running the real routes, not by the tests above.
func TestNestedFilesCountTowardSize(t *testing.T) {
	s := newTestStore(t)
	key := testKey()
	write(t, s, key, "elevation.u16", strings.Repeat("a", 100))
	write(t, s, key, "tiles/12_7", strings.Repeat("b", 40))
	write(t, s, key, "tiles/12_8", strings.Repeat("c", 60))

	worlds, err := s.List()
	if err != nil || len(worlds) != 1 {
		t.Fatalf("List = %v, %v", worlds, err)
	}
	if worlds[0].Stages[0].Bytes != 200 {
		t.Errorf("stage bytes = %d, want 200 (nested files included)", worlds[0].Stages[0].Bytes)
	}
	usage, _ := s.Usage()
	if usage != worlds[0].Bytes {
		t.Errorf("usage %d disagrees with the world total %d", usage, worlds[0].Bytes)
	}
}

func TestRemoveAndClear(t *testing.T) {
	s := newTestStore(t)
	a := Key{WorldID: "alpha-1111111111111111", PipelineVersion: "v2-aaaa", Stage: "2"}
	b := Key{WorldID: "bravo-2222222222222222", PipelineVersion: "v2-aaaa", Stage: "2"}
	write(t, s, a, "elevation.u16", "a")
	write(t, s, b, "elevation.u16", "b")

	if err := s.RemoveWorld(a.WorldID); err != nil {
		t.Fatalf("RemoveWorld: %v", err)
	}
	if _, err := s.Read(a, "elevation.u16"); !errors.Is(err, ErrNotFound) {
		t.Errorf("removed world still readable: %v", err)
	}
	if _, err := s.Read(b, "elevation.u16"); err != nil {
		t.Errorf("the other world was affected: %v", err)
	}
	if err := s.RemoveWorld(a.WorldID); !errors.Is(err, ErrNotFound) {
		t.Errorf("second remove = %v, want ErrNotFound", err)
	}
	if err := s.RemoveWorld("../escape"); !errors.Is(err, ErrBadPath) {
		t.Errorf("traversal remove = %v, want ErrBadPath", err)
	}

	if err := s.Clear(); err != nil {
		t.Fatalf("Clear: %v", err)
	}
	entries, _ := os.ReadDir(s.dir)
	if len(entries) != 0 {
		t.Errorf("Clear left %d entries", len(entries))
	}
	// The store must still be usable afterwards, not merely empty.
	write(t, s, a, "elevation.u16", "again")
	if raw, err := s.Read(a, "elevation.u16"); err != nil || string(raw) != "again" {
		t.Errorf("store unusable after Clear: %q, %v", raw, err)
	}
	if err := s.Clear(); err != nil {
		t.Errorf("clearing twice must be harmless: %v", err)
	}
}
