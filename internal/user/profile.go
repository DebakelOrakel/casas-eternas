package user

import (
	"encoding/json"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"

	bolt "go.etcd.io/bbolt"
	"golang.org/x/crypto/bcrypt"
)

// THE PROFILE (docs/decisions/client-accounts.md, fork 5): what a user
// changes about themselves, by id — the caller's token names the id, so a
// profile route never takes a name.

// maxDisplayName bounds a display name, in characters.
const maxDisplayName = 64

// update changes one entry in one transaction.
func (r *Registry) update(id string, change func(*User) error) error {
	return r.db.Update(func(tx *bolt.Tx) error {
		u, ok := byID(tx, id)
		if !ok {
			return fmt.Errorf("user %q: %w", id, ErrUnknown)
		}
		if err := change(&u); err != nil {
			return err
		}
		return putUser(tx, u)
	})
}

func byID(tx *bolt.Tx, id string) (User, bool) {
	var u User
	raw := tx.Bucket(bucketUsers).Get([]byte(id))
	if raw == nil {
		return u, false
	}
	return u, json.Unmarshal(raw, &u) == nil
}

// SetDisplayName sets what the panels show for a user. Trimmed; empty goes
// back to the login name; control characters and more than 64 characters
// are refused.
func (r *Registry) SetDisplayName(id, name string) error {
	name = strings.TrimSpace(name)
	if utf8.RuneCountInString(name) > maxDisplayName {
		return fmt.Errorf("%w: a display name has at most %d characters", ErrInvalid, maxDisplayName)
	}
	if strings.IndexFunc(name, unicode.IsControl) >= 0 {
		return fmt.Errorf("%w: a display name holds no control characters", ErrInvalid)
	}
	return r.update(id, func(u *User) error {
		u.DisplayName = name
		return nil
	})
}

// RecordLogin notes that the user signed in now.
func (r *Registry) RecordLogin(id string) error {
	return r.update(id, func(u *User) error {
		at := r.now().UTC()
		u.LastLoginAt = &at
		return nil
	})
}

// ChangePassword sets a user's password, given the current one: false, and
// nothing changed, when the current password is wrong.
func (r *Registry) ChangePassword(id, current, next string) (bool, error) {
	hash, err := hashPassword(next)
	if err != nil {
		return false, err
	}
	changed := false
	err = r.db.Update(func(tx *bolt.Tx) error {
		credentials := tx.Bucket(bucketCredentials)
		stored := credentials.Get([]byte(id))
		if stored == nil || bcrypt.CompareHashAndPassword(stored, []byte(current)) != nil {
			return nil
		}
		changed = true
		return credentials.Put([]byte(id), hash)
	})
	return changed, err
}

// SetAvatar records the version and media type of the user's picture;
// empty clears it. The picture's bytes are the auth module's file.
func (r *Registry) SetAvatar(id, version, mediaType string) error {
	return r.update(id, func(u *User) error {
		u.Avatar = version
		u.AvatarType = mediaType
		if version == "" {
			u.AvatarType = ""
		}
		return nil
	})
}
