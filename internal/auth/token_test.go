package auth

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const testKey = "a signing key long enough to be accepted"

func newTokens(t *testing.T) *Tokens {
	t.Helper()
	tokens, err := NewTokens([]byte(testKey))
	if err != nil {
		t.Fatalf("NewTokens: %v", err)
	}
	return tokens
}

func TestIssueAndVerify(t *testing.T) {
	tokens := newTokens(t)
	raw, expires, err := tokens.Issue("ada", AudienceSession, time.Hour)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if time.Until(expires) > time.Hour+time.Minute || time.Until(expires) < 59*time.Minute {
		t.Errorf("expiry %v is not about an hour away", expires)
	}
	subject, err := tokens.Verify(raw, AudienceSession)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if subject != "ada" {
		t.Errorf("subject = %q, want ada", subject)
	}
}

// THE FIRST OF THE TWO CLASSIC BREAKS: a token declaring itself unsigned, which
// anyone can forge in a text editor.
//
// Measured 2026-08-09, because a green test proves nothing until you know what
// turns it red: this one STILL PASSES with jwt.WithValidMethods removed. The
// method pin is not what refuses it. golang-jwt refuses `alg: none` unless the
// keyfunc hands back its `UnsafeAllowNoneSignatureType` sentinel, and ours hands
// back an HMAC key — so the refusal comes from never opting in to the unsafe
// path, plus the library continuing to require that opt-in.
//
// Both are worth pinning, so the test stays; what changed is the claim. The
// method pin is guarded by the test below, which DOES go red without it.
func TestRejectsAlgNone(t *testing.T) {
	tokens := newTokens(t)

	// Hand-built, because no sane library will sign one for you: `alg: none`
	// tokens have an empty signature and are otherwise perfectly well-formed.
	header := base64url(t, map[string]any{"alg": "none", "typ": "JWT"})
	claims := base64url(t, map[string]any{
		"sub": "ada",
		"aud": []string{AudienceSession},
		"iss": Issuer,
		"exp": time.Now().Add(time.Hour).Unix(),
	})
	forged := header + "." + claims + "."

	if subject, err := tokens.Verify(forged, AudienceSession); err == nil {
		t.Errorf("an alg:none token was accepted as %q", subject)
	}
}

// THE SECOND, and the one that actually guards jwt.WithValidMethods: algorithm
// confusion. Same key, different method. A verifier that takes the method from
// the token uses whatever it is told, which is the shape that turns a published
// RSA public key into a signing key.
//
// The token is otherwise VALID — right key, right claims, right audience — so the
// pin is the only reason left to refuse it. Verified by removing the pin: this
// test reports `an HS512 token was accepted as "ada"`.
func TestRejectsAnotherSigningMethod(t *testing.T) {
	tokens := newTokens(t)
	other := jwt.NewWithClaims(jwt.SigningMethodHS512, jwt.RegisteredClaims{
		Subject:   "ada",
		Audience:  jwt.ClaimStrings{AudienceSession},
		Issuer:    Issuer,
		ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
	})
	raw, err := other.SignedString([]byte(testKey))
	if err != nil {
		t.Fatalf("signing with HS512: %v", err)
	}
	if subject, err := tokens.Verify(raw, AudienceSession); err == nil {
		t.Errorf("an HS512 token was accepted as %q", subject)
	}
}

// The reason audiences exist: a bake job's token travels to another pod and sits
// in a Job spec, where it is far more exposed than a browser's. It must not be a
// session.
func TestAudiencesDoNotOpenEachOther(t *testing.T) {
	tokens := newTokens(t)
	bakeAudience := BakeAudience("v4-abc123")

	job, _, err := tokens.Issue("ada", bakeAudience, time.Hour)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if _, err := tokens.Verify(job, AudienceSession); err == nil {
		t.Error("a bake token was accepted as a session")
	}
	if _, err := tokens.Verify(job, bakeAudience); err != nil {
		t.Errorf("a bake token was refused for its own audience: %v", err)
	}
	// And a job token is scoped to ONE key, not to bakes in general.
	if _, err := tokens.Verify(job, BakeAudience("v4-something-else")); err == nil {
		t.Error("a bake token opened a different artifact key")
	}

	session, _, err := tokens.Issue("ada", AudienceSession, time.Hour)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if _, err := tokens.Verify(session, bakeAudience); err == nil {
		t.Error("a session was accepted as a bake token")
	}
}

func TestRejectsExpiredWrongKeyAndTampered(t *testing.T) {
	tokens := newTokens(t)

	expired, _, err := tokens.Issue("ada", AudienceSession, -time.Minute)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if _, err := tokens.Verify(expired, AudienceSession); err == nil {
		t.Error("an expired token was accepted")
	}

	valid, _, err := tokens.Issue("ada", AudienceSession, time.Hour)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}

	stranger, err := NewTokens([]byte("a different key, also long enough ok"))
	if err != nil {
		t.Fatalf("NewTokens: %v", err)
	}
	if _, err := stranger.Verify(valid, AudienceSession); err == nil {
		t.Error("a token was accepted by a server holding a different key")
	}

	// Flipping a character in the payload must break the signature, not merely
	// change the answer.
	parts := strings.Split(valid, ".")
	if len(parts) != 3 {
		t.Fatalf("token has %d parts", len(parts))
	}
	tampered := parts[0] + "." + parts[1][:len(parts[1])-2] + "XY." + parts[2]
	if _, err := tokens.Verify(tampered, AudienceSession); err == nil {
		t.Error("a tampered token was accepted")
	}

	// Structural nonsense must be refused as calmly as a forgery.
	for _, junk := range []string{"", "not a token", "a.b.c", strings.Repeat("x", 500)} {
		if _, err := tokens.Verify(junk, AudienceSession); err == nil {
			t.Errorf("%q was accepted as a token", junk)
		}
	}
}

// A token minted without an expiry would otherwise be eternal — the one mistake
// that cannot be undone later, since it is indistinguishable from a good token
// forever.
func TestRejectsTokenWithoutExpiry(t *testing.T) {
	tokens := newTokens(t)
	eternal := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.RegisteredClaims{
		Subject:  "ada",
		Audience: jwt.ClaimStrings{AudienceSession},
		Issuer:   Issuer,
	})
	raw, err := eternal.SignedString([]byte(testKey))
	if err != nil {
		t.Fatalf("signing: %v", err)
	}
	if _, err := tokens.Verify(raw, AudienceSession); err == nil {
		t.Error("a token with no expiry was accepted")
	}
}

// A token from somewhere else that happens to use the same key must still be
// refused — the issuer is what a second verifier will one day rely on.
func TestRejectsForeignIssuer(t *testing.T) {
	tokens := newTokens(t)
	foreign := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.RegisteredClaims{
		Subject:   "ada",
		Audience:  jwt.ClaimStrings{AudienceSession},
		Issuer:    "somebody-else",
		ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
	})
	raw, err := foreign.SignedString([]byte(testKey))
	if err != nil {
		t.Fatalf("signing: %v", err)
	}
	if _, err := tokens.Verify(raw, AudienceSession); err == nil {
		t.Error("a token from a foreign issuer was accepted")
	}
}

func TestRefusesToIssueWithoutSubjectOrAudience(t *testing.T) {
	tokens := newTokens(t)
	if _, _, err := tokens.Issue("", AudienceSession, time.Hour); err == nil {
		t.Error("issued a token with no subject")
	}
	if _, _, err := tokens.Issue("ada", "", time.Hour); err == nil {
		t.Error("issued a token with no audience")
	}
}

// A short key is the weakness that works perfectly in testing and is never
// noticed, so it is refused where it enters rather than where it fails.
func TestKeysMustBeLongEnough(t *testing.T) {
	if _, err := NewTokens([]byte("short")); err == nil {
		t.Error("a five-byte signing key was accepted")
	}
	if _, err := NewTokens(nil); err == nil {
		t.Error("an empty signing key was accepted")
	}

	dir := t.TempDir()
	path := filepath.Join(dir, "session.key")
	// The newline is the point: a key file written by an editor or a YAML block
	// carries one, and a replica that kept it would disagree with one that did
	// not — every login working and every request after it failing.
	if err := os.WriteFile(path, []byte(testKey+"\n"), 0o600); err != nil {
		t.Fatalf("writing: %v", err)
	}
	key, err := ReadKey(path)
	if err != nil {
		t.Fatalf("ReadKey: %v", err)
	}
	if string(key) != testKey {
		t.Errorf("ReadKey kept surrounding whitespace: %q", key)
	}

	if err := os.WriteFile(path, []byte("tiny\n"), 0o600); err != nil {
		t.Fatalf("writing: %v", err)
	}
	if _, err := ReadKey(path); err == nil {
		t.Error("a short key file was accepted")
	}
	if _, err := ReadKey(filepath.Join(dir, "absent")); err == nil {
		t.Error("a missing key file was accepted")
	}
}

func TestGeneratedKeysAreUsableAndDifferent(t *testing.T) {
	first, err := GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	second, err := GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	if string(first) == string(second) {
		t.Fatal("two generated keys are identical")
	}
	if _, err := NewTokens(first); err != nil {
		t.Errorf("a generated key was rejected: %v", err)
	}
}

func base64url(t *testing.T, value map[string]any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshalling: %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(encoded)
}
