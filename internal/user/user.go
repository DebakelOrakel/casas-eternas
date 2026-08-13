// Package user is the registry of who exists AND how they prove it locally:
// the stable ids everything else records, plus the credentials the auth
// subsystem verifies. One bbolt database rather than a file per concern, so
// that creating a user mints identity and credential in ONE transaction —
// see docs/decisions/server-user-admin.md.
//
// The split that MATTERS is unchanged: names are credential surface (a login
// name, later an OIDC subject a foreign provider owns) while owners and
// grants need an identity that survives a rename and never collides across
// login methods. Ids are minted here and never derived from names.
//
// A LEAF like auth: it imports nothing of this repo, so the session module
// can hold one without gaining an edge anywhere.
//
// bbolt rather than the archived boltdb/bolt, and bbolt rather than an LSM
// store: reads (one per login) run in parallel against a memory-mapped
// B+tree, writes (admin operations) serialize onto the single writer this
// store is allowed to have anyway — the exclusive file lock turns "one
// process per store directory" from review discipline into something the
// kernel enforces.
package user

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	bolt "go.etcd.io/bbolt"
)

// User is one registry entry.
type User struct {
	// ID is the stable identity: what a token's `sub` carries and what owners
	// and grants record. A uuid, minted here, never derived from the name.
	ID string `json:"id"`
	// Name is the login name at the time of minting — display data and the
	// key a credential is looked up under, never an identity.
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"createdAt"`
	// Role is the GLOBAL role — what the login mints into the token's adm
	// claim. Empty is the default (a plain user), so every record written
	// before roles existed means what it always did. Attached to the
	// identity rather than the name or the credential: a rename keeps the
	// role, and a future OIDC login coupled to this entry inherits it.
	// Per-world rights are grants on the world, deliberately NOT a role
	// here — see docs/design/access-control.md.
	Role string `json:"role,omitempty"`
	// OIDCSubject joins a foreign provider's `sub` to this entry, once OIDC
	// exists. Reserved now so the record format does not change under it.
	OIDCSubject string `json:"oidcSubject,omitempty"`
}

// The role vocabulary. RoleUser is the accepted SPELLING of the default —
// stored as the empty string, so setting it back is not a format change.
const (
	RoleUser  = "user"
	RoleAdmin = "admin"
)

// Admin reports whether this entry's sessions carry the admin claim.
func (u User) Admin() bool { return u.Role == RoleAdmin }

// file is the users.json layout this registry kept before bbolt — read once
// at founding, never written again.
type file struct {
	Users []User `json:"users"`
}

var (
	bucketUsers       = []byte("users")
	bucketCredentials = []byte("credentials")
)

// Registry is the id-keyed user store, backed by one bbolt database
// (auth.db) holding a `users` bucket (id → JSON entry) and a `credentials`
// bucket (id → bcrypt hash).
//
// Name lookups SCAN the users bucket rather than maintaining a name index:
// at any population this server will see, a scan inside a read transaction
// is memory access, and an index is a second copy that can only ever be
// wrong. The trigger to revisit is a population where logins measurably
// drag, not taste.
type Registry struct {
	db *bolt.DB

	// now is injected so tests can be deterministic about timestamps.
	now func() time.Time
}

// NewRegistry opens (or founds) auth.db in dir, eagerly: a bad auth.storage
// fails at startup, naming the setting, not at the first login. Founding a
// fresh database imports a users.json left by the pre-bbolt registry, ids
// preserved verbatim.
func NewRegistry(dir string) (*Registry, error) {
	if dir == "" {
		return nil, fmt.Errorf("registry directory must not be empty")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("preparing %q: %w", dir, err)
	}
	path := filepath.Join(dir, "auth.db")
	// Stat before Open, because Open creates the file: founding is the one
	// moment the users.json import may run.
	_, statErr := os.Stat(path)
	founding := os.IsNotExist(statErr)

	// The timeout turns a second process into a loud startup error instead of
	// a silent hang on the file lock — the lock IS the one-process rule.
	db, err := bolt.Open(path, 0o600, &bolt.Options{Timeout: time.Second})
	if err != nil {
		return nil, fmt.Errorf("auth.db in %q: %w (one process per store directory — is another server holding it?)", dir, err)
	}
	r := &Registry{db: db, now: time.Now}
	if err := db.Update(func(tx *bolt.Tx) error {
		for _, name := range [][]byte{bucketUsers, bucketCredentials} {
			if _, err := tx.CreateBucketIfNotExists(name); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		// A database that will not open holds the ids everything else
		// references; refusing beats silently founding fresh, which would
		// re-mint every user under new ids — orphaning owners and grants.
		db.Close()
		return nil, fmt.Errorf("auth.db in %q is unusable: %w", dir, err)
	}
	// Every record is parsed once at open, so a database that got corrupted
	// refuses HERE, loudly, rather than surfacing as a user who silently
	// cannot log in — the same reasoning that refuses a corrupt users.json.
	if err := db.View(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketUsers).ForEach(func(id, raw []byte) error {
			var u User
			if err := json.Unmarshal(raw, &u); err != nil {
				return fmt.Errorf("record %q: %w", id, err)
			}
			return nil
		})
	}); err != nil {
		db.Close()
		return nil, fmt.Errorf("auth.db in %q is unusable: %w", dir, err)
	}
	if founding {
		if err := r.importUsersJSON(dir); err != nil {
			db.Close()
			return nil, err
		}
	}
	return r, nil
}

// Close releases the database and its file lock. The module holding the
// registry calls it at shutdown; a registry that is never closed is released
// by process exit, which bbolt survives (writes are transactional), but the
// lock outliving the server would refuse the next start on some platforms.
func (r *Registry) Close() error { return r.db.Close() }

// importUsersJSON founds the database from the pre-bbolt registry file. Ids
// are preserved verbatim — a re-minted id would orphan every owner and grant
// recorded under the old one — and the file is renamed afterwards, so a
// rollback still has its data and the import cannot run twice.
func (r *Registry) importUsersJSON(dir string) error {
	src := filepath.Join(dir, "users.json")
	raw, err := os.ReadFile(src)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var parsed file
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return fmt.Errorf("user registry %s is unreadable: %w", src, err)
	}
	err = r.db.Update(func(tx *bolt.Tx) error {
		seen := map[string]bool{}
		for _, u := range parsed.Users {
			// The old registry could not write a duplicate name; finding one
			// means the file is not what it claims, and picking either entry
			// silently would attach the wrong credential later.
			if seen[u.Name] {
				return fmt.Errorf("%s: user %q appears twice", src, u.Name)
			}
			seen[u.Name] = true
			if err := putUser(tx, u); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	if err := os.Rename(src, src+".imported"); err != nil {
		return fmt.Errorf("imported %s but could not set it aside: %w", src, err)
	}
	return nil
}

// Ensure returns the entry for a login name, minting one on first sight.
// Called after the credential (or later the OIDC provider) has verified the
// name — the registry records who exists; for foreign-held users it never
// decides who may. One write transaction, so two concurrent first logins
// cannot mint two ids for one name.
func (r *Registry) Ensure(name string) (User, error) {
	if name == "" {
		return User{}, fmt.Errorf("refusing to register an empty name")
	}
	var entry User
	err := r.db.Update(func(tx *bolt.Tx) error {
		if existing, ok := findByName(tx, name); ok {
			entry = existing
			return nil
		}
		minted, err := r.mintUser(tx, name)
		entry = minted
		return err
	})
	return entry, err
}

// SetRole assigns the global role — RoleAdmin carries the adm claim from
// the member's NEXT login on (the decision travels in the token, so the
// staleness is the token TTL, exactly as it was when the list lived in the
// config). RoleUser clears it.
func (r *Registry) SetRole(name, role string) error {
	var stored string
	switch role {
	case RoleUser:
		stored = ""
	case RoleAdmin:
		stored = RoleAdmin
	default:
		return fmt.Errorf("%w: unknown role %q (valid: %s, %s)", ErrInvalid, role, RoleUser, RoleAdmin)
	}
	return r.db.Update(func(tx *bolt.Tx) error {
		u, ok := findByName(tx, name)
		if !ok {
			return fmt.Errorf("user %q: %w", name, ErrUnknown)
		}
		u.Role = stored
		return putUser(tx, u)
	})
}

// ByID answers the entry a stable id names — how a display layer turns an
// owner back into something readable.
func (r *Registry) ByID(id string) (User, bool) {
	var entry User
	found := false
	_ = r.db.View(func(tx *bolt.Tx) error {
		if raw := tx.Bucket(bucketUsers).Get([]byte(id)); raw != nil {
			found = json.Unmarshal(raw, &entry) == nil
		}
		return nil
	})
	return entry, found
}

// ByName answers the entry a login name maps to.
func (r *Registry) ByName(name string) (User, bool) {
	var entry User
	found := false
	_ = r.db.View(func(tx *bolt.Tx) error {
		entry, found = findByName(tx, name)
		return nil
	})
	return entry, found
}

// mintUser writes a fresh entry inside the caller's transaction.
func (r *Registry) mintUser(tx *bolt.Tx, name string) (User, error) {
	id, err := mintID()
	if err != nil {
		return User{}, err
	}
	entry := User{ID: id, Name: name, CreatedAt: r.now().UTC()}
	return entry, putUser(tx, entry)
}

// findByName scans the users bucket — see the Registry comment for why this
// is a scan and what would justify an index.
func findByName(tx *bolt.Tx, name string) (User, bool) {
	var entry User
	found := false
	_ = tx.Bucket(bucketUsers).ForEach(func(_, raw []byte) error {
		var u User
		if json.Unmarshal(raw, &u) == nil && u.Name == name {
			entry, found = u, true
		}
		return nil
	})
	return entry, found
}

// putUser writes one entry inside the caller's transaction.
func putUser(tx *bolt.Tx, u User) error {
	raw, err := json.Marshal(u)
	if err != nil {
		return err
	}
	return tx.Bucket(bucketUsers).Put([]byte(u.ID), raw)
}

// mintID returns a fresh uuid-shaped identifier.
func mintID() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	raw[6] = (raw[6] & 0x0f) | 0x40 // version 4
	raw[8] = (raw[8] & 0x3f) | 0x80 // RFC 4122 variant
	h := hex.EncodeToString(raw)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32], nil
}
