package world

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	store, err := NewStore(t.TempDir())
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

// putSave uploads a save and also hands back the exact bytes it sent, so a
// test can assert on identity rather than on a marker string — the archive is
// DEFLATE-compressed, so its payload does not appear literally in the file.
func putSave(t *testing.T, s *Store, uid string, body string, expected int) (Meta, []byte, error) {
	t.Helper()
	yaml := "metadata:\n  name: alpha\n  uid: " + uid + "\nstatus:\n  erosionRun: 2\n  revision: 1\n"
	data := buildSave(t, yaml, []byte("PNG-"+body), map[string][]byte{"payload": []byte(body)})
	info, err := inspectSave(data)
	if err != nil {
		t.Fatalf("inspectSave: %v", err)
	}
	meta, err := s.Put(uid, data, info, "local", expected)
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

	data, read, err := s.ReadCurrent(sampleUID)
	if err != nil {
		t.Fatalf("ReadCurrent: %v", err)
	}
	if read.Revision != 1 || int64(len(data)) != meta.Size {
		t.Errorf("read back revision %d, %d bytes (meta says %d)", read.Revision, len(data), meta.Size)
	}
	if !bytes.Equal(data, sent) {
		t.Error("stored bytes are not byte-identical to the ones uploaded")
	}
	preview, err := s.ReadPreview(sampleUID)
	if err != nil || !bytes.Equal(preview, []byte("PNG-first")) {
		t.Errorf("preview = %q, err = %v", preview, err)
	}
}

// The optimistic lock, which is the whole reason a world is not just a file:
// last-writer-wins would silently destroy the other machine's save.
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
	data, _, _ := s.ReadCurrent(sampleUID)
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
	raw, err := os.ReadFile(filepath.Join(s.revDir(sampleUID, 1), "world.zip"))
	if err != nil {
		t.Fatalf("revision 1 should still be on disk: %v", err)
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
	if err := os.Remove(filepath.Join(s.worldDir(sampleUID), "meta.json")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Get(sampleUID); !errors.Is(err, ErrNotFound) {
		t.Errorf("Get = %v, want ErrNotFound", err)
	}
	if _, _, err := s.ReadCurrent(sampleUID); !errors.Is(err, ErrNotFound) {
		t.Errorf("ReadCurrent = %v, want ErrNotFound", err)
	}
	list, err := s.List()
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
	if err := os.WriteFile(filepath.Join(s.worldDir(uids[1]), "meta.json"), []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	// So must a stray directory that is not a world at all.
	if err := os.MkdirAll(filepath.Join(s.dir, "not-a-world"), 0o755); err != nil {
		t.Fatal(err)
	}

	list, err := s.List()
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
	if err := s.Delete(sampleUID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := os.Stat(s.worldDir(sampleUID)); !os.IsNotExist(err) {
		t.Error("world directory survived the delete")
	}
	if err := s.Delete(sampleUID); !errors.Is(err, ErrNotFound) {
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
		if _, err := s.Get(uid); !errors.Is(err, ErrNotFound) {
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
	meta, err := s.Get(sampleUID)
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
