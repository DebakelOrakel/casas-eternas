package user

import (
	"testing"
	"time"
)

func TestVerify(t *testing.T) {
	r := open(t, t.TempDir())
	ada, err := r.Create("ada", "correct horse")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.Create("grace", "other"); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name, password string
		want           bool
	}{
		{"ada", "correct horse", true},
		{"ada", "wrong", false},
		{"ada", "", false},
		{"grace", "other", true},
		// One user's password must not open another's account, which is what
		// a lookup that fell back to "any known hash" would do.
		{"grace", "correct horse", false},
		{"nobody", "correct horse", false},
		{"", "correct horse", false},
	}
	for _, c := range cases {
		entry, got, err := r.Verify(c.name, c.password)
		if err != nil {
			t.Errorf("Verify(%q, %q) errored: %v", c.name, c.password, err)
		}
		if got != c.want {
			t.Errorf("Verify(%q, %q) = %v, want %v", c.name, c.password, got, c.want)
		}
		if got && c.name == "ada" && entry.ID != ada.ID {
			t.Errorf("Verify answered id %s, want %s — a second lookup would find someone else", entry.ID, ada.ID)
		}
	}

	// An identity WITHOUT a credential (minted at login, or OIDC-only one
	// day) must refuse exactly like an unknown name.
	if _, err := r.Ensure("credentialless"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := r.Verify("credentialless", "anything"); ok {
		t.Error("an identity with no credential verified")
	}
}

// Create is one transaction over both buckets, and refuses what would
// otherwise be a silent overwrite or a silent second account.
func TestCreateRefusals(t *testing.T) {
	r := open(t, t.TempDir())
	if _, err := r.Create("ada", "pw12345"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Create("ada", "pw12345"); err == nil {
		t.Error("a duplicate name was created")
	}
	// A name minted WITHOUT a credential is still taken: attaching a password
	// to it is SetPassword's job.
	if _, err := r.Ensure("grace"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Create("grace", "pw12345"); err == nil {
		t.Error("Create clobbered an existing identity")
	}
	if _, err := r.Create("", "pw12345"); err == nil {
		t.Error("an empty name was created")
	}
	if _, err := r.Create("eve", ""); err == nil {
		t.Error("an empty password was accepted")
	}
}

func TestSetPassword(t *testing.T) {
	r := open(t, t.TempDir())
	if _, err := r.Create("ada", "first"); err != nil {
		t.Fatal(err)
	}
	if err := r.SetPassword("ada", "second"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := r.Verify("ada", "first"); ok {
		t.Error("the old password still works")
	}
	if _, ok, _ := r.Verify("ada", "second"); !ok {
		t.Error("the new password does not work")
	}
	// A typo'd name must not silently mint a new account.
	if err := r.SetPassword("adda", "pw"); err == nil {
		t.Error("SetPassword invented a user")
	}
	if err := r.SetPassword("ada", ""); err == nil {
		t.Error("an empty password was accepted")
	}
}

// Delete removes identity and credential; re-adding the name mints a NEW id —
// inheriting a predecessor's worlds by registering their old login name is
// exactly what ids exist to prevent.
func TestDeleteAndReAdd(t *testing.T) {
	r := open(t, t.TempDir())
	ada, err := r.Create("ada", "pw12345")
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Delete("ada"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := r.Verify("ada", "pw12345"); ok {
		t.Error("a deleted user still verifies")
	}
	if _, ok := r.ByID(ada.ID); ok {
		t.Error("a deleted user still resolves by id")
	}
	again, err := r.Create("ada", "pw12345")
	if err != nil {
		t.Fatal(err)
	}
	if again.ID == ada.ID {
		t.Error("re-adding a name resurrected the old id")
	}
	if err := r.Delete("nobody"); err == nil {
		t.Error("deleting an unknown user did not complain")
	}
}

func TestListIsSortedByName(t *testing.T) {
	r := open(t, t.TempDir())
	for _, name := range []string{"grace", "ada", "linus"} {
		if _, err := r.Ensure(name); err != nil {
			t.Fatal(err)
		}
	}
	got, err := r.List()
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"ada", "grace", "linus"}
	if len(got) != len(want) {
		t.Fatalf("List returned %d users, want %d", len(got), len(want))
	}
	for i, name := range want {
		if got[i].Name != name {
			t.Errorf("List[%d] = %q, want %q", i, got[i].Name, name)
		}
	}
}

// The claim absentUserHash exists for, measured rather than asserted in a
// comment: rejecting an unknown user must not be visibly cheaper than
// rejecting a known one with the wrong password, or the endpoint tells
// anyone who asks which accounts exist.
//
// A ratio rather than a duration, so it means the same on any machine, and a
// generous one (a quarter) because this is a leak test, not a benchmark: the
// failure it guards against is the microseconds-versus-100ms gap of an early
// return, three orders of magnitude, not a factor of two. Create hashes at
// bcryptCost, which is what absentUserHash was generated at — the two paths
// are only comparable because their work factors match.
func TestUnknownUserCostsTheSameAsAWrongPassword(t *testing.T) {
	r := open(t, t.TempDir())
	if _, err := r.Create("ada", "pw12345"); err != nil {
		t.Fatal(err)
	}
	measure := func(name string) time.Duration {
		start := time.Now()
		if _, ok, _ := r.Verify(name, "wrong"); ok {
			t.Fatalf("Verify(%q) succeeded with a wrong password", name)
		}
		return time.Since(start)
	}
	known := measure("ada")
	unknown := measure("nobody")

	if unknown < known/4 {
		t.Errorf("unknown user rejected in %v against %v for a known one — the absent-user hash is not being compared", unknown, known)
	}
}
