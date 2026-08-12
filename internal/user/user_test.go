package user

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

var uuidShape = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// The property everything downstream leans on: one name, one id, forever.
func TestEnsureMintsOnceAndSurvivesReopening(t *testing.T) {
	dir := t.TempDir()
	r, err := NewRegistry(dir)
	if err != nil {
		t.Fatal(err)
	}

	ada, err := r.Ensure("ada")
	if err != nil {
		t.Fatal(err)
	}
	if !uuidShape.MatchString(ada.ID) {
		t.Errorf("id %q is not a v4 uuid", ada.ID)
	}
	if again, _ := r.Ensure("ada"); again.ID != ada.ID {
		t.Errorf("second login minted a second id: %s vs %s", again.ID, ada.ID)
	}
	grace, err := r.Ensure("grace")
	if err != nil {
		t.Fatal(err)
	}
	if grace.ID == ada.ID {
		t.Error("two users share one id")
	}

	// A restart must read the same ids back — a re-minted id would orphan
	// every owner and grant recorded under the old one.
	reopened, err := NewRegistry(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := reopened.ByName("ada"); !ok || got.ID != ada.ID {
		t.Errorf("reopened registry answered %+v for ada, want id %s", got, ada.ID)
	}
	if got, ok := reopened.ByID(grace.ID); !ok || got.Name != "grace" {
		t.Errorf("ByID(%s) = %+v", grace.ID, got)
	}
}

// A corrupt registry must refuse, not silently start fresh: starting fresh
// re-mints every user under new ids.
func TestUnreadableRegistryRefusesToOpen(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "users.json"), []byte("not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewRegistry(dir); err == nil {
		t.Fatal("a corrupt users.json opened without complaint")
	}
}

func TestLookupsAnswerAbsence(t *testing.T) {
	r, err := NewRegistry(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := r.ByName("nobody"); ok {
		t.Error("ByName invented a user")
	}
	if _, ok := r.ByID("00000000-0000-4000-8000-000000000000"); ok {
		t.Error("ByID invented a user")
	}
	if _, err := r.Ensure(""); err == nil {
		t.Error("an empty name was registered")
	}
}
