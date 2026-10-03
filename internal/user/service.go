// SERVICE ACCOUNTS: machines that prove themselves to this server — job
// workers in the cluster and outside it (docs/decisions/detail-ladder.md,
// addendum 2026-10-03). A name and a secret, kept beside the users in
// auth.db but in buckets of their own: a service account is never a user,
// never logs in to a session and never owns a world. Its secret is
// exchanged for a short-lived bus token (internal/modules/auth, the token
// route), so deleting the account ends its access within that token's life
// without any process having to look anything up.
//
// The secret is minted here, random and long, and shown ONCE — the store
// keeps only its hash, made by the same function and at the same cost as a
// password's.

package user

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"time"

	bolt "go.etcd.io/bbolt"
	"golang.org/x/crypto/bcrypt"
)

// Service is one service account.
type Service struct {
	// ID is the stable identity a bus token's subject carries.
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"createdAt"`
}

var (
	bucketServices       = []byte("services")
	bucketServiceSecrets = []byte("serviceSecrets")
)

// A service account's name: lower-case words joined by hyphens, as it will
// sit in Secret names and logs.
var serviceName = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)

// serviceSecretBytes is the secret's entropy. 32 random bytes are beyond
// guessing; bcrypt on top only keeps a stolen auth.db from handing them out.
const serviceSecretBytes = 32

// CreateService mints a service account and its secret in one transaction
// and returns the secret — the only time it exists outside the caller.
func (r *Registry) CreateService(name string) (Service, string, error) {
	if !serviceName.MatchString(name) {
		return Service{}, "", fmt.Errorf("%w: service account name %q (lower-case letters, digits and hyphens)", ErrInvalid, name)
	}
	secret, hash, err := mintServiceSecret()
	if err != nil {
		return Service{}, "", err
	}
	var entry Service
	err = r.db.Update(func(tx *bolt.Tx) error {
		if _, ok := findService(tx, name); ok {
			return fmt.Errorf("service account %q: %w", name, ErrExists)
		}
		id, err := mintID()
		if err != nil {
			return err
		}
		entry = Service{ID: id, Name: name, CreatedAt: r.now().UTC()}
		raw, err := json.Marshal(entry)
		if err != nil {
			return err
		}
		if err := tx.Bucket(bucketServices).Put([]byte(id), raw); err != nil {
			return err
		}
		return tx.Bucket(bucketServiceSecrets).Put([]byte(id), hash)
	})
	if err != nil {
		return Service{}, "", err
	}
	return entry, secret, nil
}

// RotateService replaces the account's secret and returns the new one. The
// old secret stops working at once; tokens it already bought run out.
func (r *Registry) RotateService(name string) (string, error) {
	secret, hash, err := mintServiceSecret()
	if err != nil {
		return "", err
	}
	err = r.db.Update(func(tx *bolt.Tx) error {
		s, ok := findService(tx, name)
		if !ok {
			return fmt.Errorf("service account %q: %w", name, ErrUnknown)
		}
		return tx.Bucket(bucketServiceSecrets).Put([]byte(s.ID), hash)
	})
	if err != nil {
		return "", err
	}
	return secret, nil
}

// DeleteService removes the account and its secret.
func (r *Registry) DeleteService(name string) error {
	return r.db.Update(func(tx *bolt.Tx) error {
		s, ok := findService(tx, name)
		if !ok {
			return fmt.Errorf("service account %q: %w", name, ErrUnknown)
		}
		if err := tx.Bucket(bucketServiceSecrets).Delete([]byte(s.ID)); err != nil {
			return err
		}
		return tx.Bucket(bucketServices).Delete([]byte(s.ID))
	})
}

// ListServices returns every service account, sorted by name.
func (r *Registry) ListServices() ([]Service, error) {
	var out []Service
	err := r.db.View(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketServices).ForEach(func(_, raw []byte) error {
			var s Service
			if err := json.Unmarshal(raw, &s); err != nil {
				return fmt.Errorf("unreadable service account record: %w", err)
			}
			out = append(out, s)
			return nil
		})
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// VerifyService reports whether the secret belongs to the named account. An
// unknown name and a wrong secret cost the same and answer the same, as a
// login does (see absentUserHash).
func (r *Registry) VerifyService(name, secret string) (Service, bool, error) {
	var entry Service
	var hash []byte
	err := r.db.View(func(tx *bolt.Tx) error {
		s, ok := findService(tx, name)
		if !ok {
			return nil
		}
		if h := tx.Bucket(bucketServiceSecrets).Get([]byte(s.ID)); h != nil {
			entry = s
			hash = append([]byte(nil), h...)
		}
		return nil
	})
	if err != nil {
		return Service{}, false, err
	}
	if hash == nil {
		_ = bcrypt.CompareHashAndPassword([]byte(absentUserHash), []byte(secret))
		return Service{}, false, nil
	}
	if bcrypt.CompareHashAndPassword(hash, []byte(secret)) != nil {
		return Service{}, false, nil
	}
	return entry, true, nil
}

// mintServiceSecret makes a secret and its hash.
func mintServiceSecret() (string, []byte, error) {
	raw := make([]byte, serviceSecretBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", nil, err
	}
	secret := base64.RawURLEncoding.EncodeToString(raw)
	hash, err := hashPassword(secret)
	if err != nil {
		return "", nil, err
	}
	return secret, hash, nil
}

func findService(tx *bolt.Tx, name string) (Service, bool) {
	var entry Service
	found := false
	_ = tx.Bucket(bucketServices).ForEach(func(_, raw []byte) error {
		var s Service
		if json.Unmarshal(raw, &s) == nil && s.Name == name {
			entry, found = s, true
		}
		return nil
	})
	return entry, found
}
