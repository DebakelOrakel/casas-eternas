// Package auth answers "is this password right for this user", and later "is
// this token one we issued". Both are AUTHENTICATION — establishing who someone
// is. What they are then allowed to do is authorisation, and that lives with the
// thing being protected: the world store records an owner, the bake module
// compares against it.
//
// The split is deliberate and load-bearing. It is why credentials live in an
// operations file that can be rotated and mounted by people who should never
// touch a world, and why roles and quota do NOT belong here.
// See docs/decisions/server-auth.md.
package auth

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"golang.org/x/crypto/bcrypt"
)

// MinBcryptCost is the weakest work factor accepted, and RecommendedBcryptCost
// is what the error tells people to use.
//
// The floor exists because `htpasswd -B` defaults to cost 5 — measured, not
// assumed — while Go's own default is 10. Five is roughly thirty times cheaper
// to attack, and accepting it silently would contradict the whole reason
// non-bcrypt schemes are refused: nobody should believe they are protected when
// they are not. Rejecting rather than warning was chosen deliberately on
// 2026-08-09, while no files exist in the wild to lock anyone out of.
const (
	MinBcryptCost         = 10
	RecommendedBcryptCost = 12
)

// A syntactically valid bcrypt hash of a password nobody has, compared against
// when the named user does not exist.
//
// Without it, an unknown user is rejected in microseconds while a real one costs
// bcrypt's deliberate ~100 ms — a thousandfold difference anyone can measure,
// which turns the login endpoint into a "does this account exist" oracle.
// Burning the same work on a hash that cannot match removes the signal. The
// value is not a secret; only its cost matters.
//
// It is cost 12, at the recommended factor rather than the floor, so it is never
// CHEAPER than a hash in the file. What remains is small and stated rather than
// hidden: a file using a cost above 12 makes a real user slower than an absent
// one again — a factor of two or four, against network jitter, rather than the
// thousandfold gap this removes.
const absentUserHash = "$2a$12$xOFKD.DvhC/zkYbVsgzXbeT3LFKQ9B2y23eWT3NVhMwbOW/MTpHa2"

// Users verifies passwords against an htpasswd file.
//
// It holds the PATH, never the contents. Kubernetes rewrites a projected Secret
// when it changes, and an admin screen will rewrite the file directly — caching
// would buy a cache-invalidation bug in exchange for file I/O on an operation
// that happens once per login. Reading it per attempt is the simpler thing that
// cannot be wrong.
type Users struct {
	path string
}

// NewUsers checks the file is readable and well-formed, then keeps only its path.
//
// The parse at startup is the point: a server whose user file is missing or
// broken must fail to start, not start and reject everybody. The second is a
// misconfiguration wearing a permission bug's clothes, and it gets debugged as
// one — the same reasoning as config.ParseAuthMode.
func NewUsers(path string) (*Users, error) {
	if strings.TrimSpace(path) == "" {
		return nil, fmt.Errorf("no user file configured")
	}
	if _, err := load(path); err != nil {
		return nil, err
	}
	return &Users{path: path}, nil
}

// Path is the file being consulted, for logs and errors.
func (u *Users) Path() string { return u.path }

// Verify reports whether the password belongs to the named user.
//
// A file that has become unreadable or malformed since startup rejects
// everyone — the safe direction — and says so through err. Callers log it;
// answering "yes" on a broken file would be the one unrecoverable mistake here.
func (u *Users) Verify(name, password string) (bool, error) {
	users, err := load(u.path)
	if err != nil {
		return false, err
	}
	hash, known := users[name]
	if !known {
		// Deliberately not an early return — see absentUserHash.
		_ = bcrypt.CompareHashAndPassword([]byte(absentUserHash), []byte(password))
		return false, nil
	}
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil, nil
}

// load parses the whole file, or fails.
//
// STRICT, on every line, and that is a choice against the obvious alternative of
// skipping what it cannot parse. A skipped line is a user who silently cannot
// log in — and if it is the only administrator, a lockout with no message. An
// error names the line and is fixed in a minute.
//
// The cost of strictness is that a HALF-WRITTEN file rejects everyone while it
// is being written. That is why the admin screen, when it arrives, must write to
// a temporary file and rename over the target: rename is atomic, so no reader
// ever sees a partial file. Kubernetes already does this for projected Secrets.
func load(path string) (map[string]string, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("user file: %w", err)
	}
	defer file.Close()

	users := map[string]string{}
	scanner := bufio.NewScanner(file)
	for line := 1; scanner.Scan(); line++ {
		text := strings.TrimSpace(scanner.Text())
		if text == "" || strings.HasPrefix(text, "#") {
			continue
		}
		// SplitN, because a bcrypt hash contains no colon but a future format
		// might, and the username is the part that must not.
		name, hash, found := strings.Cut(text, ":")
		if !found || name == "" || hash == "" {
			return nil, fmt.Errorf("%s:%d: not a user:hash line", path, line)
		}
		// A duplicate is ambiguous, and silently taking one of them is how a
		// user someone believes they removed goes on working.
		if _, seen := users[name]; seen {
			return nil, fmt.Errorf("%s:%d: user %q appears twice", path, line, name)
		}
		if err := checkBcrypt(hash); err != nil {
			return nil, fmt.Errorf("%s:%d: user %q: %w", path, line, name, err)
		}
		users[name] = hash
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("user file: %w", err)
	}
	if len(users) == 0 {
		return nil, fmt.Errorf("%s: no users", path)
	}
	return users, nil
}

// checkBcrypt rejects every scheme htpasswd can write except bcrypt, and bcrypt
// below MinBcryptCost.
//
// Apache's default is MD5-crypt (`$apr1$`), and it also emits SHA1 (`{SHA}`),
// crypt and plaintext. Accepting any of them would be the worse kindness: the
// file would work, and its owner would believe the passwords were protected.
//
// The cost floor is the same argument one level down. `htpasswd -B` writes cost
// 5 unless told otherwise, which looks identical to a strong hash and is not.
// Both errors say what to type instead, because "wrong format" without a remedy
// is just an obstacle.
func checkBcrypt(hash string) error {
	cost, err := bcrypt.Cost([]byte(hash))
	if err != nil {
		return fmt.Errorf("not a bcrypt hash (use `htpasswd -B -C %d`): %w", RecommendedBcryptCost, err)
	}
	if cost < MinBcryptCost {
		return fmt.Errorf("bcrypt cost %d is below %d — `htpasswd -B` defaults to 5; regenerate with `htpasswd -B -C %d`", cost, MinBcryptCost, RecommendedBcryptCost)
	}
	return nil
}
