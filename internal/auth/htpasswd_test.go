package auth

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// Hashes are generated rather than pasted in: bcrypt salts randomly, so a fixture
// would only prove that one particular salt still works, and a reader could not
// tell which password it belongs to without running the tool.
func hash(t *testing.T, password string) string {
	t.Helper()
	// The floor, not bcrypt.MinCost: the loader now refuses anything weaker, so a
	// cheaper test hash would be testing a file the server would not accept. It
	// costs ~50 ms a hash, which is the price of the fixtures being real.
	h, err := bcrypt.GenerateFromPassword([]byte(password), MinBcryptCost)
	if err != nil {
		t.Fatalf("hashing: %v", err)
	}
	return string(h)
}

func writeFile(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "htpasswd")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("writing fixture: %v", err)
	}
	return path
}

func TestVerify(t *testing.T) {
	path := writeFile(t, "# a comment\n\nada:"+hash(t, "correct horse")+"\ngrace:"+hash(t, "other")+"\n")
	users, err := NewUsers(path)
	if err != nil {
		t.Fatalf("NewUsers: %v", err)
	}

	cases := []struct {
		name, password string
		want           bool
	}{
		{"ada", "correct horse", true},
		{"ada", "wrong", false},
		{"ada", "", false},
		{"grace", "other", true},
		// One user's password must not open another's account, which is what a
		// lookup that fell back to "any known hash" would do.
		{"grace", "correct horse", false},
		{"nobody", "correct horse", false},
		{"", "correct horse", false},
	}
	for _, c := range cases {
		got, err := users.Verify(c.name, c.password)
		if err != nil {
			t.Errorf("Verify(%q, %q) errored: %v", c.name, c.password, err)
		}
		if got != c.want {
			t.Errorf("Verify(%q, %q) = %v, want %v", c.name, c.password, got, c.want)
		}
	}
}

// The file is read per attempt, so a password changed underneath takes effect
// without a restart — that is the whole reason nothing is cached.
func TestVerifySeesFileChanges(t *testing.T) {
	path := writeFile(t, "ada:"+hash(t, "first")+"\n")
	users, err := NewUsers(path)
	if err != nil {
		t.Fatalf("NewUsers: %v", err)
	}
	if ok, _ := users.Verify("ada", "first"); !ok {
		t.Fatal("the original password should work")
	}

	if err := os.WriteFile(path, []byte("ada:"+hash(t, "second")+"\n"), 0o600); err != nil {
		t.Fatalf("rewriting: %v", err)
	}
	if ok, _ := users.Verify("ada", "first"); ok {
		t.Error("the old password still works after the file changed")
	}
	if ok, _ := users.Verify("ada", "second"); !ok {
		t.Error("the new password does not work")
	}
}

// Every one of these must stop the server from starting. The failure they guard
// against is the opposite: a file that loads with a user quietly missing.
func TestNewUsersRejectsBadFiles(t *testing.T) {
	good := hash(t, "pw")
	cases := []struct{ name, content string }{
		{"no colon", "ada\n"},
		{"empty name", ":" + good + "\n"},
		{"empty hash", "ada:\n"},
		{"duplicate user", "ada:" + good + "\nada:" + good + "\n"},
		// The dangerous one: apache's own default hash. It parses, it works,
		// and it is not what anyone thinks they configured.
		{"md5-crypt", "ada:$apr1$vTBQMHqR$3.HZ4rC1U9x/w6X7YFO7z1\n"},
		{"sha1", "ada:{SHA}qUqP5cyxm6YcTAhz05Hph5gvu9M=\n"},
		{"plaintext", "ada:pw\n"},
		// `htpasswd -B` without -C writes exactly this: real bcrypt, cost 5,
		// indistinguishable from a strong hash to the eye.
		{"bcrypt below the cost floor", "ada:$2y$05$pja5f2yAlRqS0M5ZEEEBNuKOpaee3PE37eD9ECuOzcwi8zPKfnUl6\n"},
		{"no users at all", "# only a comment\n"},
	}
	for _, c := range cases {
		if _, err := NewUsers(writeFile(t, c.content)); err == nil {
			t.Errorf("%s: accepted", c.name)
		}
	}

	if _, err := NewUsers(filepath.Join(t.TempDir(), "absent")); err == nil {
		t.Error("a missing file was accepted")
	}
	if _, err := NewUsers("  "); err == nil {
		t.Error("an empty path was accepted")
	}
}

// The error has to say which line, or fixing a file of any size is a search.
func TestErrorNamesTheLine(t *testing.T) {
	_, err := NewUsers(writeFile(t, "ada:"+hash(t, "pw")+"\nbroken\n"))
	if err == nil {
		t.Fatal("accepted a malformed file")
	}
	if !strings.Contains(err.Error(), ":2:") {
		t.Errorf("error does not name line 2: %v", err)
	}
}

// A file that breaks AFTER startup must reject rather than admit, and must say
// so — the caller cannot tell "wrong password" from "unreadable file" otherwise,
// and those want different responses.
func TestVerifyFailsClosedOnABrokenFile(t *testing.T) {
	path := writeFile(t, "ada:"+hash(t, "pw")+"\n")
	users, err := NewUsers(path)
	if err != nil {
		t.Fatalf("NewUsers: %v", err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatalf("removing: %v", err)
	}
	ok, err := users.Verify("ada", "pw")
	if ok {
		t.Error("verified against a file that is gone")
	}
	if err == nil {
		t.Error("a missing file was reported as a plain wrong password")
	}
}

// The claim absentUserHash exists for, measured rather than asserted in a
// comment: rejecting an unknown user must not be visibly cheaper than rejecting
// a known one with the wrong password, or the endpoint tells anyone who asks
// which accounts exist.
//
// A ratio rather than a duration, so it means the same on any machine, and a
// generous one (a quarter) because this is a leak test, not a benchmark: the
// failure it guards against is the microseconds-versus-100ms gap of an early
// return, which is three orders of magnitude, not a factor of two. This is the
// one test here that uses the RECOMMENDED cost, which is what absentUserHash was
// generated at — the two paths are only comparable when their work factors match.
func TestUnknownUserCostsTheSameAsAWrongPassword(t *testing.T) {
	real, err := bcrypt.GenerateFromPassword([]byte("pw"), RecommendedBcryptCost)
	if err != nil {
		t.Fatalf("hashing: %v", err)
	}
	users, err := NewUsers(writeFile(t, "ada:"+string(real)+"\n"))
	if err != nil {
		t.Fatalf("NewUsers: %v", err)
	}

	measure := func(name string) time.Duration {
		start := time.Now()
		if ok, _ := users.Verify(name, "wrong"); ok {
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
