package user

import (
	"errors"
	"testing"
)

// A service account's secret is shown once and works; a rotation replaces
// it; a deletion ends it; and the account never appears as a user.
func TestServiceAccountLifecycle(t *testing.T) {
	r, err := NewRegistry(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()

	created, secret, err := r.CreateService("cluster-workers")
	if err != nil {
		t.Fatal(err)
	}
	if created.ID == "" || len(secret) < 40 {
		t.Fatalf("created %+v with secret of %d characters", created, len(secret))
	}
	if _, _, err := r.CreateService("cluster-workers"); !errors.Is(err, ErrExists) {
		t.Errorf("a second account of the same name: %v, want ErrExists", err)
	}
	if _, _, err := r.CreateService("Cluster Workers"); !errors.Is(err, ErrInvalid) {
		t.Errorf("a name with spaces: %v, want ErrInvalid", err)
	}
	if got, ok, err := r.VerifyService("cluster-workers", secret); err != nil || !ok || got.ID != created.ID {
		t.Fatalf("the secret: %+v %v %v", got, ok, err)
	}
	if _, ok, _ := r.VerifyService("cluster-workers", secret+"x"); ok {
		t.Error("a wrong secret was accepted")
	}
	if _, ok, _ := r.VerifyService("nobody", secret); ok {
		t.Error("an unknown account was accepted")
	}
	// Never a user: no login, no listing among the users.
	if _, ok, _ := r.Verify("cluster-workers", secret); ok {
		t.Error("the service account logged in as a user")
	}
	if users, _ := r.List(); len(users) != 0 {
		t.Errorf("the users list holds %v", users)
	}

	rotated, err := r.RotateService("cluster-workers")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := r.VerifyService("cluster-workers", secret); ok {
		t.Error("the old secret still works after a rotation")
	}
	if _, ok, _ := r.VerifyService("cluster-workers", rotated); !ok {
		t.Error("the rotated secret does not work")
	}
	if list, err := r.ListServices(); err != nil || len(list) != 1 || list[0].Name != "cluster-workers" {
		t.Errorf("listing: %v %v", list, err)
	}

	if err := r.DeleteService("cluster-workers"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := r.VerifyService("cluster-workers", rotated); ok {
		t.Error("a deleted account's secret still works")
	}
	if err := r.DeleteService("cluster-workers"); !errors.Is(err, ErrUnknown) {
		t.Errorf("deleting twice: %v, want ErrUnknown", err)
	}
}
