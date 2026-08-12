package world

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/DebakelOrakel/casas-eternas/internal/access"
)

// putAs uploads a save as a specific caller — the grants tests are about who
// wrote, which the shared putSave helper deliberately fixes to "local".
func putAs(t *testing.T, s *Store, uid, body, caller string, expected int) (Meta, error) {
	t.Helper()
	yaml := "metadata:\n  name: alpha\n  uid: " + uid + "\nspec:\n  seed: alpha-seed\nstatus:\n  erosionRun: 2\n  revision: 1\n"
	data := buildSave(t, yaml, nil, map[string][]byte{"payload": []byte(body)})
	info, err := inspectSave(data)
	if err != nil {
		t.Fatalf("inspectSave: %v", err)
	}
	return s.Put(context.Background(), uid, data, info, caller, expected)
}

// The bug this whole arrangement kills: Meta.Owner used to be re-stamped
// from the caller on every upload, so in a shared world the first editor
// save stole the world. Now the owner is pinned in grants.json at creation
// and a revision write cannot move it.
func TestOwnerIsPinnedAtCreationAndSurvivesOtherWriters(t *testing.T) {
	s := newTestStore(t)
	meta, err := putAs(t, s, sampleUID, "first", "ada-id", 0)
	if err != nil {
		t.Fatal(err)
	}
	if meta.Owner != "ada-id" {
		t.Fatalf("creator = %q", meta.Owner)
	}
	grants, found, err := s.ReadGrants(context.Background(), sampleUID)
	if err != nil || !found {
		t.Fatalf("grants after create: found=%v err=%v", found, err)
	}
	if grants.Owner != "ada-id" || grants.Public {
		t.Errorf("fresh grants = %+v, want private, owned by the creator", grants)
	}

	// An editor writes a revision — the world must NOT change hands.
	meta, err = putAs(t, s, sampleUID, "second", "grace-id", 1)
	if err != nil {
		t.Fatal(err)
	}
	if meta.Owner != "ada-id" {
		t.Errorf("after grace's save the owner is %q — the world was stolen", meta.Owner)
	}
	grants, _, _ = s.ReadGrants(context.Background(), sampleUID)
	if grants.Owner != "ada-id" {
		t.Errorf("grants owner moved to %q by an upload", grants.Owner)
	}
}

// A world from before grants existed keeps the owner its meta already
// records, and no grants are minted for it by an upload: the migration rule
// for a checking server decides that case deliberately (see the design
// doc), not a side effect of a save.
func TestLegacyWorldIsNeitherRestampedNorSilentlyMigrated(t *testing.T) {
	s := newTestStore(t)
	if _, err := putAs(t, s, sampleUID, "first", "ada-id", 0); err != nil {
		t.Fatal(err)
	}
	// Simulate the pre-grants store: the document simply is not there.
	if err := os.Remove(s.grantsPath(sampleUID)); err != nil {
		t.Fatal(err)
	}

	meta, err := putAs(t, s, sampleUID, "second", "eve-id", 1)
	if err != nil {
		t.Fatal(err)
	}
	if meta.Owner != "ada-id" {
		t.Errorf("legacy owner re-stamped to %q", meta.Owner)
	}
	if _, found, _ := s.ReadGrants(context.Background(), sampleUID); found {
		t.Error("an upload minted grants for a legacy world")
	}
}

func TestWriteGrantsTransfersAndMirrorsImmediately(t *testing.T) {
	s := newTestStore(t)
	if _, err := putAs(t, s, sampleUID, "first", "ada-id", 0); err != nil {
		t.Fatal(err)
	}

	next := access.Grants{Owner: "grace-id", Public: true, Users: map[string]string{"eve-id": "editor"}}
	if err := s.WriteGrants(context.Background(), sampleUID, next); err != nil {
		t.Fatal(err)
	}
	grants, found, err := s.ReadGrants(context.Background(), sampleUID)
	if err != nil || !found {
		t.Fatalf("read back: found=%v err=%v", found, err)
	}
	if grants.Owner != "grace-id" || !grants.Public || grants.Users["eve-id"] != "editor" {
		t.Errorf("grants did not round-trip: %+v", grants)
	}
	// The display mirror updates with the transfer, not at the next upload.
	meta, err := s.Get(context.Background(), sampleUID)
	if err != nil {
		t.Fatal(err)
	}
	if meta.Owner != "grace-id" {
		t.Errorf("meta mirror = %q after transfer", meta.Owner)
	}

	// Refusals: no owner, an ungrantable role, an absent world.
	if err := s.WriteGrants(context.Background(), sampleUID, access.Grants{}); err == nil {
		t.Error("grants without an owner were accepted")
	}
	if err := s.WriteGrants(context.Background(), sampleUID, access.Grants{Owner: "g", Users: map[string]string{"x": "admin"}}); err == nil {
		t.Error("a per-world admin grant was accepted")
	}
	absent := "11111111-2222-4333-8444-555555555555"
	if err := s.WriteGrants(context.Background(), absent, next); !errors.Is(err, ErrNotFound) {
		t.Errorf("grants for an absent world: %v, want ErrNotFound", err)
	}
}

// Corrupt is not absent: a parse error must surface, never silently reopen
// a shared world under legacy rules.
func TestCorruptGrantsAreAnErrorNotAnAbsence(t *testing.T) {
	s := newTestStore(t)
	if _, err := putAs(t, s, sampleUID, "first", "ada-id", 0); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(s.grantsPath(sampleUID), []byte("not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.ReadGrants(context.Background(), sampleUID); err == nil {
		t.Error("corrupt grants read as fine")
	}
}
