// Package user is the registry of who exists: the stable ids everything else
// records, distinct from the login names people type.
//
// The split matters because names are CREDENTIAL surface (htpasswd lines an
// operator edits; later an OIDC subject a foreign provider owns) while owners
// and grants need an identity that survives a rename and never collides
// across login methods. Entries are MINTED ON FIRST LOGIN rather than
// provisioned: the htpasswd file stays the one place users are administered,
// and the registry follows it — see docs/decisions/server-users.md.
//
// A LEAF like auth: it imports nothing of this repo, so the session module
// can hold one without gaining an edge anywhere.
package user

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// User is one registry entry.
type User struct {
	// ID is the stable identity: what a token's `sub` carries and what owners
	// and grants record. A uuid, minted here, never derived from the name.
	ID string `json:"id"`
	// Name is the login name at the time of minting — display data and the
	// join key to htpasswd, never an identity.
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"createdAt"`
	// OIDCSubject joins a foreign provider's `sub` to this entry, once OIDC
	// exists. Reserved now so the file format does not change under it.
	OIDCSubject string `json:"oidcSubject,omitempty"`
}

// file is users.json on disk — wrapped in an object so the format can grow a
// field without becoming a different file.
type file struct {
	Users []User `json:"users"`
}

// Registry is the id-keyed user store, backed by one JSON file.
//
// One file rather than a directory per user: the registry is read at login
// only, its whole content fits in memory at any population this server will
// see, and a single atomic rename is the simplest write that cannot tear.
type Registry struct {
	path string

	mu     sync.Mutex
	users  []User
	byName map[string]int
	byID   map[string]int

	// now is injected so tests can be deterministic about timestamps.
	now func() time.Time
}

// NewRegistry opens (or founds) the registry in dir, eagerly: a bad
// auth.storage fails at startup, naming the setting, not at the first login.
func NewRegistry(dir string) (*Registry, error) {
	if dir == "" {
		return nil, fmt.Errorf("registry directory must not be empty")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("preparing %q: %w", dir, err)
	}
	r := &Registry{path: filepath.Join(dir, "users.json"), now: time.Now}
	if err := r.load(); err != nil {
		return nil, err
	}
	return r, nil
}

func (r *Registry) load() error {
	r.users = nil
	r.byName = map[string]int{}
	r.byID = map[string]int{}
	raw, err := os.ReadFile(r.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var parsed file
	if err := json.Unmarshal(raw, &parsed); err != nil {
		// Refusing beats rebuilding: a registry that will not parse holds the
		// ids everything else references, and silently starting fresh would
		// re-mint every user under new ids — orphaning owners and grants.
		return fmt.Errorf("user registry %s is unreadable: %w", r.path, err)
	}
	r.users = parsed.Users
	for i, u := range r.users {
		r.byName[u.Name] = i
		r.byID[u.ID] = i
	}
	return nil
}

// Ensure returns the entry for a login name, minting one on first sight.
// Called after the password (or later the OIDC provider) has verified the
// name — the registry records who exists, it never decides who may.
func (r *Registry) Ensure(name string) (User, error) {
	if name == "" {
		return User{}, fmt.Errorf("refusing to register an empty name")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if i, ok := r.byName[name]; ok {
		return r.users[i], nil
	}
	id, err := mintID()
	if err != nil {
		return User{}, err
	}
	entry := User{ID: id, Name: name, CreatedAt: r.now().UTC()}
	r.users = append(r.users, entry)
	r.byName[name] = len(r.users) - 1
	r.byID[id] = len(r.users) - 1
	if err := r.persist(); err != nil {
		// The entry must not exist in memory only: a second replica (or a
		// restart) would mint a DIFFERENT id for the same person.
		r.load()
		return User{}, err
	}
	return entry, nil
}

// ByID answers the entry a stable id names — how a display layer turns an
// owner back into something readable.
func (r *Registry) ByID(id string) (User, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	i, ok := r.byID[id]
	if !ok {
		return User{}, false
	}
	return r.users[i], true
}

// ByName answers the entry a login name maps to.
func (r *Registry) ByName(name string) (User, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	i, ok := r.byName[name]
	if !ok {
		return User{}, false
	}
	return r.users[i], true
}

// persist writes users.json atomically. Called under r.mu.
func (r *Registry) persist() error {
	raw, err := json.MarshalIndent(file{Users: r.users}, "", "  ")
	if err != nil {
		return err
	}
	tmp := r.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, r.path)
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
