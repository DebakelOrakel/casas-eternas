package user

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	bolt "go.etcd.io/bbolt"
)

// CODES (docs/decisions/client-accounts.md, forks 3 and 4): the only way to
// a new account, and the way back into one without e-mail. An admin makes a
// code and hands it over by any channel; the code is shown once, and only
// its SHA-256 is kept — 80 random bits need no slow hash.
//
//   - an INVITE is good for a number of registrations until it expires;
//   - a RESET sets one user's password once, within 24 hours.

var (
	bucketInvites = []byte("invites")
	bucketResets  = []byte("resets")
)

// ErrCode is a code that is unknown, spent, expired or revoked — told apart
// to nobody, so a guess learns nothing.
var ErrCode = errors.New("the code is not valid")

// ResetValidity is how long a reset code holds.
const ResetValidity = 24 * time.Hour

// loginName is what a registration may choose as its login name: letters,
// digits, dot, dash and underscore, 2 to 32 characters, starting with a
// letter or digit. Names an admin made before are not held to it.
var loginName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$`)

// Invite is one invite code's record, without the code.
type Invite struct {
	ID        string    `json:"id"`
	Uses      int       `json:"uses"`
	Left      int       `json:"left"`
	ExpiresAt time.Time `json:"expiresAt"`
	CreatedBy string    `json:"createdBy"`
	CreatedAt time.Time `json:"createdAt"`
	Hash      string    `json:"hash"`
	// Hint is the code's last group, so an admin tells the codes in the list
	// apart: the list showed the record's id under "Code" at first, and the id
	// was taken for the code (2026-10-04). Four of sixteen characters leave
	// 60 bits to guess.
	Hint string `json:"hint"`
}

type reset struct {
	UserID    string    `json:"userId"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// crockford is Crockford's base32: no I, L, O or U, so a code read aloud or
// typed from paper survives.
const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// mintCode is 16 Crockford characters in four groups: K7QF-2M9X-HW4T-8RNB.
func mintCode() (string, error) {
	raw := make([]byte, 10)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	var b strings.Builder
	var acc, bits uint
	for i, n := 0, 0; n < 16; n++ {
		for bits < 5 {
			acc = acc<<8 | uint(raw[i])
			i++
			bits += 8
		}
		bits -= 5
		if n > 0 && n%4 == 0 {
			b.WriteByte('-')
		}
		b.WriteByte(crockford[(acc>>bits)&31])
	}
	return b.String(), nil
}

// hashCode is a code's stored form: upper case, separators gone, and the
// letters Crockford reads as digits read as digits.
func hashCode(code string) string {
	code = strings.NewReplacer("-", "", " ", "", "O", "0", "I", "1", "L", "1").Replace(strings.ToUpper(code))
	sum := sha256.Sum256([]byte(code))
	return hex.EncodeToString(sum[:])
}

// CreateInvite makes a code good for `uses` registrations within `valid`.
func (r *Registry) CreateInvite(uses int, valid time.Duration, createdBy string) (Invite, string, error) {
	if uses < 1 || uses > 1000 {
		return Invite{}, "", fmt.Errorf("%w: an invite is good for 1 to 1000 registrations", ErrInvalid)
	}
	if valid < time.Hour || valid > 365*24*time.Hour {
		return Invite{}, "", fmt.Errorf("%w: an invite is valid for an hour to a year", ErrInvalid)
	}
	code, err := mintCode()
	if err != nil {
		return Invite{}, "", err
	}
	id, err := mintID()
	if err != nil {
		return Invite{}, "", err
	}
	now := r.now().UTC()
	invite := Invite{ID: id, Uses: uses, Left: uses, ExpiresAt: now.Add(valid), CreatedBy: createdBy, CreatedAt: now, Hash: hashCode(code), Hint: code[len(code)-4:]}
	raw, err := json.Marshal(invite)
	if err != nil {
		return Invite{}, "", err
	}
	if err := r.db.Update(func(tx *bolt.Tx) error { return tx.Bucket(bucketInvites).Put([]byte(id), raw) }); err != nil {
		return Invite{}, "", err
	}
	invite.Hash = ""
	return invite, code, nil
}

// ListInvites answers the invites not yet spent or expired, newest first,
// without their hashes; spent and expired ones are dropped on the way.
func (r *Registry) ListInvites() ([]Invite, error) {
	var out []Invite
	now := r.now()
	err := r.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(bucketInvites)
		var gone [][]byte
		err := bucket.ForEach(func(k, v []byte) error {
			var invite Invite
			if json.Unmarshal(v, &invite) != nil || invite.Left <= 0 || now.After(invite.ExpiresAt) {
				gone = append(gone, append([]byte(nil), k...))
				return nil
			}
			invite.Hash = ""
			out = append(out, invite)
			return nil
		})
		for _, k := range gone {
			if err := bucket.Delete(k); err != nil {
				return err
			}
		}
		return err
	})
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, err
}

// RevokeInvite ends a code before it is spent.
func (r *Registry) RevokeInvite(id string) error {
	return r.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(bucketInvites)
		if bucket.Get([]byte(id)) == nil {
			return fmt.Errorf("invite %q: %w", id, ErrUnknown)
		}
		return bucket.Delete([]byte(id))
	})
}

// CreateReset makes a code that sets the named user's password once,
// within ResetValidity. A new one for the same user ends the old one.
func (r *Registry) CreateReset(name string) (string, time.Time, error) {
	code, err := mintCode()
	if err != nil {
		return "", time.Time{}, err
	}
	expires := r.now().UTC().Add(ResetValidity)
	err = r.db.Update(func(tx *bolt.Tx) error {
		u, ok := findByName(tx, name)
		if !ok {
			return fmt.Errorf("user %q: %w", name, ErrUnknown)
		}
		bucket := tx.Bucket(bucketResets)
		var old [][]byte
		_ = bucket.ForEach(func(k, v []byte) error {
			var rec reset
			if json.Unmarshal(v, &rec) == nil && rec.UserID == u.ID {
				old = append(old, append([]byte(nil), k...))
			}
			return nil
		})
		for _, k := range old {
			if err := bucket.Delete(k); err != nil {
				return err
			}
		}
		raw, err := json.Marshal(reset{UserID: u.ID, ExpiresAt: expires})
		if err != nil {
			return err
		}
		return bucket.Put([]byte(hashCode(code)), raw)
	})
	return code, expires, err
}

// Redeem spends a code. An invite registers `name` with `password` and
// counts the use; a reset sets its user's password, whatever `name` says.
// Either answers the user, to be signed in. ErrCode for a code that is not
// valid; ErrExists and ErrInvalid for a name that is taken or not allowed.
func (r *Registry) Redeem(code, name, password string) (User, error) {
	hash, err := personPassword(password)
	if err != nil {
		return User{}, err
	}
	key := hashCode(code)
	now := r.now()
	var out User
	// A reset that has run out, or whose user is gone, is refused AND
	// deleted: returning ErrCode from the transaction would roll the
	// delete back (as it did until 2026-10-04), so it commits and says so.
	spent := false
	err = r.db.Update(func(tx *bolt.Tx) error {
		// A reset first: it names its user.
		resets := tx.Bucket(bucketResets)
		if raw := resets.Get([]byte(key)); raw != nil {
			var rec reset
			if err := resets.Delete([]byte(key)); err != nil {
				return err
			}
			if json.Unmarshal(raw, &rec) != nil || now.After(rec.ExpiresAt) {
				spent = true
				return nil
			}
			u, ok := byID(tx, rec.UserID)
			if !ok {
				spent = true
				return nil
			}
			if err := endSessions(tx, u); err != nil {
				return err
			}
			out, _ = byID(tx, u.ID)
			return tx.Bucket(bucketCredentials).Put([]byte(u.ID), hash)
		}
		invites := tx.Bucket(bucketInvites)
		var id []byte
		var invite Invite
		_ = invites.ForEach(func(k, v []byte) error {
			var candidate Invite
			if id == nil && json.Unmarshal(v, &candidate) == nil && candidate.Hash == key {
				id, invite = append([]byte(nil), k...), candidate
			}
			return nil
		})
		if id == nil || invite.Left <= 0 || now.After(invite.ExpiresAt) {
			return ErrCode
		}
		// After the code, so a reset's holder who leaves the name empty
		// hears that the code is spent. That a bad name answers otherwise
		// for a valid code tells a guesser something; the limiter counts it
		// as a failure for that reason (auth/codes.go, serveRedeem).
		if !loginName.MatchString(name) {
			return fmt.Errorf("%w: a login name is 2 to 32 letters, digits, dots, dashes or underscores", ErrInvalid)
		}
		if _, taken := findByName(tx, name); taken {
			return fmt.Errorf("user %q: %w", name, ErrExists)
		}
		u, err := r.mintUser(tx, name)
		if err != nil {
			return err
		}
		u.InvitedBy = invite.ID
		u.Inviter = invite.CreatedBy
		if err := putUser(tx, u); err != nil {
			return err
		}
		if err := tx.Bucket(bucketCredentials).Put([]byte(u.ID), hash); err != nil {
			return err
		}
		invite.Left--
		raw, err := json.Marshal(invite)
		if err != nil {
			return err
		}
		out = u
		return invites.Put(id, raw)
	})
	if err == nil && spent {
		return User{}, ErrCode
	}
	return out, err
}
