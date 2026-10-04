package user

import (
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

// A reset that has run out is refused AND gone: it does not come back to
// life when the clock does. (The delete used to roll back with the refusal.)
func TestExpiredResetIsDeleted(t *testing.T) {
	r := open(t, t.TempDir())
	if _, err := r.Create("ada", "Alt-passwort"); err != nil {
		t.Fatal(err)
	}
	code, _, err := r.CreateReset("ada")
	if err != nil {
		t.Fatal(err)
	}
	real := r.now
	r.now = func() time.Time { return real().Add(ResetValidity + time.Hour) }
	if _, err := r.Redeem(code, "", "Neu-passwort"); !errors.Is(err, ErrCode) {
		t.Fatalf("an expired reset = %v, want ErrCode", err)
	}
	r.now = real
	if _, err := r.Redeem(code, "ada", "Neu-passwort"); !errors.Is(err, ErrCode) {
		t.Errorf("the expired reset was kept: %v", err)
	}
}

// One use, many takers at once: exactly one registers.
func TestConcurrentRedeemSpendsOnce(t *testing.T) {
	r := open(t, t.TempDir())
	_, code, err := r.CreateInvite(1, time.Hour, "ada")
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	won := 0
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if _, err := r.Redeem(code, "user"+string(rune('a'+i)), "Pw-passwort1"); err == nil {
				mu.Lock()
				won++
				mu.Unlock()
			}
		}(i)
	}
	wg.Wait()
	if won != 1 {
		t.Errorf("%d registrations from a code of one use", won)
	}
}

func TestChangePassword(t *testing.T) {
	r := open(t, t.TempDir())
	ada, err := r.Create("ada", "Alt-passwort")
	if err != nil {
		t.Fatal(err)
	}
	if changed, err := r.ChangePassword(ada.ID, "falsch", "Neu-passwort"); changed || err != nil {
		t.Errorf("wrong current = %v, %v", changed, err)
	}
	if _, err := r.ChangePassword(ada.ID, "Alt-passwort", strings.Repeat("x", 73)); !errors.Is(err, ErrInvalid) {
		t.Errorf("73 bytes = %v, want ErrInvalid", err)
	}
	if changed, err := r.ChangePassword(ada.ID, "Alt-passwort", "Neu-passwort"); !changed || err != nil {
		t.Fatalf("right current = %v, %v", changed, err)
	}
	if _, ok, _ := r.Verify("ada", "Neu-passwort"); !ok {
		t.Error("the new password does not verify")
	}
}

// A display name that turns text around, or hides characters, is refused;
// an emoji sequence joined with U+200D is a name like any other.
func TestDisplayNameRefusesFormatCharacters(t *testing.T) {
	r := open(t, t.TempDir())
	ada, err := r.Create("ada", "Pw-passwort1")
	if err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"ad‮a", "a​da"} {
		if err := r.SetDisplayName(ada.ID, bad); !errors.Is(err, ErrInvalid) {
			t.Errorf("%q = %v, want ErrInvalid", bad, err)
		}
	}
	if err := r.SetDisplayName(ada.ID, "Ada 👩‍💻"); err != nil {
		t.Errorf("an emoji sequence = %v", err)
	}
}

// The rule for a person's password, and that setting one, by any way,
// ends the user's sessions.
func TestPasswordRuleAndSessionGeneration(t *testing.T) {
	r := open(t, t.TempDir())
	for _, weak := range []string{"Kurz-1", "nur-kleinbuchstaben", "NUR-GROSSBUCHSTABEN"} {
		if _, err := r.Create("ada", weak); !errors.Is(err, ErrInvalid) {
			t.Errorf("%q = %v, want ErrInvalid", weak, err)
		}
	}
	ada, err := r.Create("ada", "Alt-passwort")
	if err != nil {
		t.Fatal(err)
	}
	generation := func() uint64 {
		u, _ := r.ByID(ada.ID)
		return u.SessionGeneration
	}
	start := generation()
	if err := r.SetPassword("ada", "Neu-passwort"); err != nil || generation() != start+1 {
		t.Errorf("SetPassword: %v, generation %d", err, generation())
	}
	if _, err := r.ChangePassword(ada.ID, "Neu-passwort", "Noch-ein-passwort"); err != nil || generation() != start+2 {
		t.Errorf("ChangePassword: %v, generation %d", err, generation())
	}
	code, _, err := r.CreateReset("ada")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.Redeem(code, "", "Reset-passwort"); err != nil || generation() != start+3 {
		t.Errorf("a reset: %v, generation %d", err, generation())
	}
}

// Blocked: the right password is refused, a reset code too, and blocking
// ends the sessions; unblocked, the password works again.
func TestBlocking(t *testing.T) {
	r := open(t, t.TempDir())
	ada, err := r.Create("ada", "Alt-passwort")
	if err != nil {
		t.Fatal(err)
	}
	code, _, err := r.CreateReset("ada")
	if err != nil {
		t.Fatal(err)
	}
	if err := r.SetBlocked("ada", true); err != nil {
		t.Fatal(err)
	}
	if u, _ := r.ByID(ada.ID); !u.Blocked || u.SessionGeneration != ada.SessionGeneration+1 {
		t.Errorf("blocked = %+v", u)
	}
	if _, ok, _ := r.Verify("ada", "Alt-passwort"); ok {
		t.Error("a blocked user signed in")
	}
	if _, err := r.Redeem(code, "", "Reset-passwort"); !errors.Is(err, ErrCode) {
		t.Errorf("a blocked user's reset = %v, want ErrCode", err)
	}
	if err := r.SetBlocked("ada", false); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := r.Verify("ada", "Alt-passwort"); !ok {
		t.Error("an unblocked user cannot sign in")
	}
	if err := r.SetBlocked("nobody", true); !errors.Is(err, ErrUnknown) {
		t.Errorf("blocking nobody = %v, want ErrUnknown", err)
	}
}
