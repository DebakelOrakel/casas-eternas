package auth

import (
	"crypto/rand"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// The signing method, fixed here and never read from a token.
//
// This is the whole of JWT's bad security record in one line. The two classic
// breaks are `alg: none` — a token that declares itself unsigned — and algorithm
// confusion, where a verifier that trusts the header is handed an HS256 token
// signed with the RSA PUBLIC key it published. Both work only against a verifier
// that asks the token what algorithm to use. This one does not: the method is
// stated here and anything else is refused before its signature is looked at.
const signingMethod = "HS256"

// Issuer names this server in every token it mints. It costs nothing today —
// there is one verifier — and it is what lets a second one (the artifact service
// the bake design points at) tell our tokens from anyone else's.
const Issuer = "casas-eternas"

// Audiences. A token is minted FOR something, and verifying checks it was minted
// for the thing now being asked.
//
// Without this a bake job's token — which travels to another pod, appears in a
// Job spec and lives as long as the job does — would be a perfectly good user
// session. With it, the two are different values and neither opens the other.
const (
	// AudienceSession is a logged-in person.
	AudienceSession = "session"
	// AudienceBakePrefix builds the audience of a job token, which is scoped to
	// the one artifact key that job may write: "bake:<key>".
	AudienceBakePrefix = "bake:"
)

// MinKeyBytes is the shortest signing key accepted.
//
// HMAC-SHA256's security rests on the key being at least as long as its output,
// and a short key is exactly the kind of weakness that works fine in testing and
// is never noticed. `openssl rand -base64 48` clears it comfortably.
const MinKeyBytes = 32

// Tokens issues and verifies the tokens this server hands out.
//
// It is the same object for both directions on purpose: an issuer and a verifier
// that could be configured differently is a bug with no symptom until the day
// nothing can log in.
type Tokens struct {
	key []byte
}

// NewTokens builds an issuer/verifier over a signing key.
func NewTokens(key []byte) (*Tokens, error) {
	if len(key) < MinKeyBytes {
		return nil, fmt.Errorf("signing key is %d bytes, need at least %d", len(key), MinKeyBytes)
	}
	return &Tokens{key: key}, nil
}

// ReadKey loads a signing key from a file, as mounted from a Secret.
//
// Trailing whitespace is stripped because a key that arrives through a YAML
// block or an editor almost always carries a newline, and a key that differs
// from the one another replica read by exactly one byte is a maddening failure:
// every login works, every subsequent request is rejected.
func ReadKey(path string) ([]byte, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("signing key: %w", err)
	}
	key := []byte(strings.TrimSpace(string(raw)))
	if len(key) < MinKeyBytes {
		return nil, fmt.Errorf("signing key in %s is %d bytes, need at least %d", path, len(key), MinKeyBytes)
	}
	return key, nil
}

// GenerateKey makes a signing key for a server that was given none.
//
// In memory, never written: creating a file somewhere the operator did not ask
// for is a surprise, and the honest consequence of not configuring a key is that
// sessions do not survive a restart — and that several replicas do not agree at
// all. The caller says so out loud; see cmd/.
func GenerateKey() ([]byte, error) {
	key := make([]byte, MinKeyBytes)
	if _, err := rand.Read(key); err != nil {
		return nil, fmt.Errorf("generating a signing key: %w", err)
	}
	return key, nil
}

// Issue mints a token for `subject`, good for `audience`, valid for `ttl`.
func (t *Tokens) Issue(subject, audience string, ttl time.Duration) (string, time.Time, error) {
	if subject == "" {
		return "", time.Time{}, fmt.Errorf("refusing to issue a token with no subject")
	}
	if audience == "" {
		return "", time.Time{}, fmt.Errorf("refusing to issue a token with no audience")
	}
	now := time.Now()
	expires := now.Add(ttl)
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.RegisteredClaims{
		Subject:   subject,
		Audience:  jwt.ClaimStrings{audience},
		Issuer:    Issuer,
		IssuedAt:  jwt.NewNumericDate(now),
		ExpiresAt: jwt.NewNumericDate(expires),
	})
	signed, err := token.SignedString(t.key)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("signing a token: %w", err)
	}
	return signed, expires, nil
}

// Verify checks a token was issued here, for this audience, and has not expired.
// It returns the subject — who the bearer is.
//
// Every failure returns the same shape of nothing: a caller must not be able to
// tell an expired token from a forged one, since the honest answer to both is
// "log in again" and the difference is only useful to someone probing.
func (t *Tokens) Verify(raw, audience string) (string, error) {
	claims := &jwt.RegisteredClaims{}
	_, err := jwt.ParseWithClaims(raw, claims, func(*jwt.Token) (any, error) { return t.key, nil },
		// The pin. Without it the parser would honour the token's own `alg`.
		jwt.WithValidMethods([]string{signingMethod}),
		jwt.WithIssuer(Issuer),
		jwt.WithAudience(audience),
		// Expiry is checked by default; requiring the claim means a token
		// minted without one is refused rather than treated as eternal.
		jwt.WithExpirationRequired(),
	)
	if err != nil {
		return "", fmt.Errorf("token rejected: %w", err)
	}
	if claims.Subject == "" {
		return "", fmt.Errorf("token rejected: no subject")
	}
	return claims.Subject, nil
}

// BakeAudience is the audience of a token scoped to one artifact key.
func BakeAudience(artifactKey string) string { return AudienceBakePrefix + artifactKey }
