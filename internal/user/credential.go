// The credential half of the registry: bcrypt hashes in the `credentials`
// bucket, keyed by user id — by the IDENTITY, not the name, so a future
// rename cannot detach a password from its person. Every hash is minted
// HERE, at one cost, through one function; nothing external ever writes
// one. See docs/decisions/server-user-admin.md.
package user

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	bolt "go.etcd.io/bbolt"
	"golang.org/x/crypto/bcrypt"
)

// Sentinels the admin surface maps onto HTTP statuses — matching on error
// STRINGS is how a reworded message silently turns a 409 into a 500.
var (
	// ErrUnknown names an operation on a user the registry has never seen.
	ErrUnknown = errors.New("no such user")
	// ErrExists names a creation that would collide with an existing name.
	ErrExists = errors.New("user already exists")
	// ErrInvalid names input the store refuses on principle — an empty name
	// or password — as opposed to input that merely collides with state.
	ErrInvalid = errors.New("invalid")
)

// bcryptCost is the work factor every credential is hashed at. Go's own
// default is 10; two above it is deliberate margin, and the resulting
// ~100 ms per verification is the point of bcrypt, not a cost to optimise.
// Private: since every hash in the store is minted here, there is no second
// party a floor or a recommendation would speak to.
const bcryptCost = 12

// A syntactically valid bcrypt hash of a password nobody has, compared against
// when the named user does not exist or holds no credential.
//
// Without it, an unknown user is rejected in microseconds while a real one
// costs bcrypt's deliberate ~100 ms — a thousandfold difference anyone can
// measure, which turns the login endpoint into a "does this account exist"
// oracle. Burning the same work on a hash that cannot match removes the
// signal. The value is not a secret; only its cost matters: it is bcryptCost,
// the same factor every stored hash carries, so the two paths always cost
// the same.
const absentUserHash = "$2a$12$xOFKD.DvhC/zkYbVsgzXbeT3LFKQ9B2y23eWT3NVhMwbOW/MTpHa2"

// Verify reports whether the password belongs to the named user, and answers
// with the entry so the caller never needs a second lookup for the id.
//
// An unknown name, an identity without a local credential (OIDC-only, once
// that exists) and a wrong password are indistinguishable from outside: same
// answer, same bcrypt burn.
func (r *Registry) Verify(name, password string) (User, bool, error) {
	var entry User
	var hash []byte
	err := r.db.View(func(tx *bolt.Tx) error {
		u, ok := findByName(tx, name)
		if !ok {
			return nil
		}
		if h := tx.Bucket(bucketCredentials).Get([]byte(u.ID)); h != nil {
			// Get's slice is only valid inside the transaction.
			entry = u
			hash = append([]byte(nil), h...)
		}
		return nil
	})
	if err != nil {
		return User{}, false, err
	}
	if hash == nil {
		// Deliberately not an early return — see absentUserHash.
		_ = bcrypt.CompareHashAndPassword([]byte(absentUserHash), []byte(password))
		return User{}, false, nil
	}
	if bcrypt.CompareHashAndPassword(hash, []byte(password)) != nil {
		return User{}, false, nil
	}
	return entry, true, nil
}

// Create mints an identity and its credential in ONE transaction — the
// operation the two-file world could not have, and the reason this store
// exists. It refuses a name that already exists in any form; attaching a
// password to an existing identity is SetPassword's job, and conflating the
// two is how an admin overwrites a credential they meant to create.
func (r *Registry) Create(name, password string) (User, error) {
	if name == "" {
		return User{}, fmt.Errorf("%w: refusing to create a user with no name", ErrInvalid)
	}
	hash, err := personPassword(password)
	if err != nil {
		return User{}, err
	}
	var entry User
	err = r.db.Update(func(tx *bolt.Tx) error {
		if _, ok := findByName(tx, name); ok {
			return fmt.Errorf("user %q: %w", name, ErrExists)
		}
		minted, err := r.mintUser(tx, name)
		if err != nil {
			return err
		}
		entry = minted
		return tx.Bucket(bucketCredentials).Put([]byte(entry.ID), hash)
	})
	if err != nil {
		return User{}, err
	}
	return entry, nil
}

// SetPassword replaces (or first sets) the named user's credential. The user
// must exist — a typo'd name must not silently mint a new account.
//
// It ends the user's sessions: a password set by an admin is most often set
// because the old one is no longer trusted.
func (r *Registry) SetPassword(name, password string) error {
	hash, err := personPassword(password)
	if err != nil {
		return err
	}
	return r.db.Update(func(tx *bolt.Tx) error {
		u, ok := findByName(tx, name)
		if !ok {
			return fmt.Errorf("user %q: %w", name, ErrUnknown)
		}
		if err := endSessions(tx, u); err != nil {
			return err
		}
		return tx.Bucket(bucketCredentials).Put([]byte(u.ID), hash)
	})
}

// Delete removes the identity AND its credential. Owners and grants may
// still record the id; those worlds fall to the admin-only rule for
// unmapped owners (docs/design/access-control.md, "Existing worlds") rather
// than being reassigned. Re-adding the same name mints a NEW id on purpose —
// the name was never the identity, and inheriting a predecessor's worlds by
// registering their old login name is exactly what ids exist to prevent.
func (r *Registry) Delete(name string) error {
	return r.db.Update(func(tx *bolt.Tx) error {
		u, ok := findByName(tx, name)
		if !ok {
			return fmt.Errorf("user %q: %w", name, ErrUnknown)
		}
		if err := tx.Bucket(bucketCredentials).Delete([]byte(u.ID)); err != nil {
			return err
		}
		return tx.Bucket(bucketUsers).Delete([]byte(u.ID))
	})
}

// Listing is one row of the admin view: the entry plus whether it can log in
// here. An identity without a credential is a real state — minted at a login
// before the store held passwords, or OIDC-only one day — and an admin
// listing that hid the difference would show two identical users of which
// only one can sign in.
type Listing struct {
	User
	HasCredential bool `json:"hasCredential"`
}

// List returns every entry, sorted by name — admin surface, not a hot path.
func (r *Registry) List() ([]Listing, error) {
	var out []Listing
	err := r.db.View(func(tx *bolt.Tx) error {
		credentials := tx.Bucket(bucketCredentials)
		return tx.Bucket(bucketUsers).ForEach(func(_, raw []byte) error {
			var u User
			if err := json.Unmarshal(raw, &u); err != nil {
				return fmt.Errorf("unreadable user record: %w", err)
			}
			out = append(out, Listing{User: u, HasCredential: credentials.Get([]byte(u.ID)) != nil})
			return nil
		})
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// HasCredentials answers the startup question "could anyone log in at all" —
// a checking mode with an empty credential bucket is a misconfiguration to
// report before the first 401 makes it look like a permission bug.
func (r *Registry) HasCredentials() bool {
	any := false
	_ = r.db.View(func(tx *bolt.Tx) error {
		k, _ := tx.Bucket(bucketCredentials).Cursor().First()
		any = k != nil
		return nil
	})
	return any
}

// MinPasswordLength is the shortest password a person may set, in
// characters (2026-10-04).
const MinPasswordLength = 10

// personPassword is hashPassword for a person's password, with the rule a
// person's password must meet: at least MinPasswordLength characters, an
// upper-case and a lower-case letter among them (decided 2026-10-04). A
// service account's secret is generated, not chosen, and is not held to it.
// Passwords set before the rule keep working; the rule applies when one is
// set.
func personPassword(password string) ([]byte, error) {
	if utf8.RuneCountInString(password) < MinPasswordLength || !strings.ContainsFunc(password, unicode.IsUpper) || !strings.ContainsFunc(password, unicode.IsLower) {
		return nil, fmt.Errorf("%w: a password has at least %d characters, upper- and lower-case letters among them", ErrInvalid, MinPasswordLength)
	}
	return hashPassword(password)
}

// hashPassword is the one place a plaintext password becomes a hash. An empty
// password is refused here rather than hashed: bcrypt would accept it
// happily, and an account with an empty password is a misconfiguration
// wearing a feature's clothes.
func hashPassword(password string) ([]byte, error) {
	if password == "" {
		return nil, fmt.Errorf("%w: refusing an empty password", ErrInvalid)
	}
	// bcrypt reads 72 bytes and refuses more; said here as the caller's
	// mistake, not as a server error.
	if len(password) > 72 {
		return nil, fmt.Errorf("%w: a password is at most 72 bytes", ErrInvalid)
	}
	return bcrypt.GenerateFromPassword([]byte(password), bcryptCost)
}
