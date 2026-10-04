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
	if _, err := r.Create("ada", "alt"); err != nil {
		t.Fatal(err)
	}
	code, _, err := r.CreateReset("ada")
	if err != nil {
		t.Fatal(err)
	}
	real := r.now
	r.now = func() time.Time { return real().Add(ResetValidity + time.Hour) }
	if _, err := r.Redeem(code, "", "neu"); !errors.Is(err, ErrCode) {
		t.Fatalf("an expired reset = %v, want ErrCode", err)
	}
	r.now = real
	if _, err := r.Redeem(code, "ada", "neu"); !errors.Is(err, ErrCode) {
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
			if _, err := r.Redeem(code, "user"+string(rune('a'+i)), "pw"); err == nil {
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
	ada, err := r.Create("ada", "alt")
	if err != nil {
		t.Fatal(err)
	}
	if changed, err := r.ChangePassword(ada.ID, "falsch", "neu"); changed || err != nil {
		t.Errorf("wrong current = %v, %v", changed, err)
	}
	if _, err := r.ChangePassword(ada.ID, "alt", strings.Repeat("x", 73)); !errors.Is(err, ErrInvalid) {
		t.Errorf("73 bytes = %v, want ErrInvalid", err)
	}
	if changed, err := r.ChangePassword(ada.ID, "alt", "neu"); !changed || err != nil {
		t.Fatalf("right current = %v, %v", changed, err)
	}
	if _, ok, _ := r.Verify("ada", "neu"); !ok {
		t.Error("the new password does not verify")
	}
}

// A display name that turns text around, or hides characters, is refused;
// an emoji sequence joined with U+200D is a name like any other.
func TestDisplayNameRefusesFormatCharacters(t *testing.T) {
	r := open(t, t.TempDir())
	ada, err := r.Create("ada", "pw")
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
