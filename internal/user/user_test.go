package user

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

var uuidShape = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func open(t *testing.T, dir string) *Registry {
	t.Helper()
	r, err := NewRegistry(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.Close() })
	return r
}

// The property everything downstream leans on: one name, one id, forever.
func TestEnsureMintsOnceAndSurvivesReopening(t *testing.T) {
	dir := t.TempDir()
	r := open(t, dir)

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
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	reopened := open(t, dir)
	if got, ok := reopened.ByName("ada"); !ok || got.ID != ada.ID {
		t.Errorf("reopened registry answered %+v for ada, want id %s", got, ada.ID)
	}
	if got, ok := reopened.ByID(grace.ID); !ok || got.Name != "grace" {
		t.Errorf("ByID(%s) = %+v", grace.ID, got)
	}
}

// A corrupt store must refuse, not silently start fresh: starting fresh
// re-mints every user under new ids. Both corruptions — the users.json a
// founding would import, and the database itself — refuse the same way.
func TestCorruptStoresRefuseToOpen(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "users.json"), []byte("not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewRegistry(dir); err == nil {
		t.Fatal("a corrupt users.json founded a registry without complaint")
	}

	dir = t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "auth.db"), []byte("not a bolt database"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewRegistry(dir); err == nil {
		t.Fatal("a corrupt auth.db opened without complaint")
	}
}

func TestLookupsAnswerAbsence(t *testing.T) {
	r := open(t, t.TempDir())
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

// Founding a fresh database imports the pre-bbolt users.json with its ids
// preserved verbatim, and sets the file aside so the import cannot run twice.
func TestFoundingImportsUsersJSON(t *testing.T) {
	dir := t.TempDir()
	legacy := file{Users: []User{
		{ID: "11111111-2222-4333-8444-555555555555", Name: "ada"},
		{ID: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", Name: "grace"},
	}}
	raw, _ := json.Marshal(legacy)
	if err := os.WriteFile(filepath.Join(dir, "users.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}

	r := open(t, dir)
	if got, ok := r.ByName("ada"); !ok || got.ID != legacy.Users[0].ID {
		t.Errorf("ada = %+v, want the imported id %s", got, legacy.Users[0].ID)
	}
	if got, ok := r.ByID(legacy.Users[1].ID); !ok || got.Name != "grace" {
		t.Errorf("ByID(imported) = %+v", got)
	}
	if _, err := os.Stat(filepath.Join(dir, "users.json")); !os.IsNotExist(err) {
		t.Error("users.json still in place after the import")
	}
	if _, err := os.Stat(filepath.Join(dir, "users.json.imported")); err != nil {
		t.Errorf("users.json.imported: %v", err)
	}

	// A users.json appearing AFTER founding is stale data, not an instruction:
	// the database exists, so nothing may import it.
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	late, _ := json.Marshal(file{Users: []User{{ID: "99999999-0000-4000-8000-000000000000", Name: "mallory"}}})
	if err := os.WriteFile(filepath.Join(dir, "users.json"), late, 0o600); err != nil {
		t.Fatal(err)
	}
	reopened := open(t, dir)
	if _, ok := reopened.ByName("mallory"); ok {
		t.Error("a users.json beside an existing database was imported")
	}
}

// A users.json with a duplicate name must refuse the WHOLE founding — picking
// either entry silently would attach the wrong credential later.
func TestFoundingRefusesDuplicateNames(t *testing.T) {
	dir := t.TempDir()
	dup := file{Users: []User{
		{ID: "11111111-2222-4333-8444-555555555555", Name: "ada"},
		{ID: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", Name: "ada"},
	}}
	raw, _ := json.Marshal(dup)
	if err := os.WriteFile(filepath.Join(dir, "users.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewRegistry(dir); err == nil {
		t.Fatal("a duplicate name founded a registry without complaint")
	}
}

// The global role is a field on the identity — it survives reopening,
// rebinding to the default clears it, and the vocabulary is closed.
func TestSetRole(t *testing.T) {
	dir := t.TempDir()
	r := open(t, dir)
	if _, err := r.Ensure("ada"); err != nil {
		t.Fatal(err)
	}
	if err := r.SetRole("ada", RoleAdmin); err != nil {
		t.Fatal(err)
	}
	if entry, _ := r.ByName("ada"); !entry.Admin() {
		t.Error("the bound role does not answer Admin()")
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	reopened := open(t, dir)
	if entry, _ := reopened.ByName("ada"); !entry.Admin() {
		t.Error("the role did not survive reopening")
	}
	if err := reopened.SetRole("ada", RoleUser); err != nil {
		t.Fatal(err)
	}
	entry, _ := reopened.ByName("ada")
	if entry.Admin() {
		t.Error("rebinding to the default did not demote")
	}
	// Stored as the EMPTY string, so records from before roles existed and
	// demoted ones are the same shape.
	if entry.Role != "" {
		t.Errorf("the default role is stored as %q, want empty", entry.Role)
	}
	if err := reopened.SetRole("ada", "emperor"); err == nil {
		t.Error("an unknown role was bound")
	}
	if err := reopened.SetRole("nobody", RoleAdmin); err == nil {
		t.Error("a role was bound to an unknown user")
	}
}

// The file lock IS the one-process rule: a second open must fail loudly
// rather than hang or silently share.
func TestSecondProcessIsRefused(t *testing.T) {
	dir := t.TempDir()
	_ = open(t, dir)
	if second, err := NewRegistry(dir); err == nil {
		second.Close()
		t.Fatal("a second registry opened the same directory")
	}
}
