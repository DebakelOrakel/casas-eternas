// Package token answers "is this token one we issued", and mints the ones we
// do. Issuing and verifying are AUTHENTICATION — establishing who someone is.
// What they are then allowed to do is authorisation, and that lives with the
// thing being protected: the world store records an owner, the bake module
// compares against it. Roles and quota do NOT belong here.
//
// Named for what it holds: the password half of authentication moved into the
// user registry (one store, one transaction — docs/decisions/server-user-admin.md),
// and this leaf kept the token mechanics. It was `internal/auth` until
// 2026-08-13; the name freed the module namespace for the auth module the
// admin surface lives in. See docs/decisions/server-auth.md for the token
// design itself.
package token

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
	// AudienceJobPrefix builds the audience of a bake job's token, which names
	// the ONE job it belongs to: "job:<jobID>".
	//
	// The job rather than the artifact key it writes, decided 2026-08-09: a job
	// reports its progress to an endpoint keyed by job id, and the artifact key
	// is in its spec anyway. Keying the audience by artifact would have meant
	// the token could not identify which job was talking.
	AudienceJobPrefix = "job:"
	// AudienceRelay is a connection to the message bus (internal/modules/
	// relay): a module's or a worker's. Its own audience so neither a
	// session nor a job's token opens the bus, and a bus token opens no
	// HTTP route.
	AudienceRelay = "relay"
)

// SubjectWorker is who a job worker is on the bus. A worker serves every
// job, so its token names no job and no world; what it may touch over HTTP
// comes with each task, as that job's own token. A worker of the jobs
// module's own pool is plain `worker`; one that proved itself with a service
// account is `worker:<account id>` (WorkerSubject), so the log can tell them
// apart. Both are the same kind on the bus.
const SubjectWorker = "worker"

// WorkerSubject is the subject of a worker that proved itself with the
// service account `id`.
func WorkerSubject(id string) string { return SubjectWorker + ":" + id }

// SubjectKind is a subject's kind: what comes before its first colon
// (`worker:…` → `worker`, `module:jobs` → `module`), or the whole subject.
func SubjectKind(subject string) string {
	kind, _, _ := strings.Cut(subject, ":")
	return kind
}

// ModuleSubject is who a module is on the bus: `module:<name>`.
func ModuleSubject(module string) string { return "module:" + module }

// IssueRelay mints a bus credential for `subject` (SubjectWorker or a
// ModuleSubject).
func (t *Tokens) IssueRelay(subject string, ttl time.Duration) (string, time.Time, error) {
	return t.Issue(subject, AudienceRelay, ttl)
}

// VerifyRelay is Verify for the bus's audience.
func (t *Tokens) VerifyRelay(raw string) (string, error) {
	return t.Verify(raw, AudienceRelay)
}

// SubjectJob is who a bake Job is, as a caller.
//
// Not the person who ordered it: a Job may write the artifacts of the one world
// it was given, and borrowing its orderer's identity would hand it everything
// that person may do — including ordering more bakes. A name of its own keeps
// "may bake" and "may act as ada" separate, and it is what a log line names when
// a Job misbehaves.
const SubjectJob = "job"

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

// sessionClaims is a session token's payload: the registered set plus the
// one claim of ours.
type sessionClaims struct {
	jwt.RegisteredClaims
	// Admin marks an operator's session. A CLAIM rather than a per-process
	// list (decided 2026-08-12, docs/decisions/server-users.md): modules know
	// callers only by id, the name→id registry lives with the auth subsystem
	// alone, and a claim keeps every process verifying locally — the same
	// property the whole token design rests on. The cost is honest: admin
	// changes take effect at the next login, bounded by the token TTL.
	Admin bool `json:"adm,omitempty"`
}

// IssueSession mints a logged-in person's token: subject is the user's
// REGISTRY ID (never the login name — names are credential surface, ids are
// identity), plus the admin claim.
func (t *Tokens) IssueSession(userID string, admin bool, ttl time.Duration) (string, time.Time, error) {
	if userID == "" {
		return "", time.Time{}, fmt.Errorf("refusing to issue a session with no subject")
	}
	now := time.Now()
	expires := now.Add(ttl)
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, sessionClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   userID,
			Audience:  jwt.ClaimStrings{AudienceSession},
			Issuer:    Issuer,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(expires),
		},
		Admin: admin,
	})
	signed, err := token.SignedString(t.key)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("signing a token: %w", err)
	}
	return signed, expires, nil
}

// VerifySession is Verify for the session audience, answering the admin
// claim too. Verify remains correct for sessions — it simply cannot see the
// claim — so callers that only need the subject keep using it.
func (t *Tokens) VerifySession(raw string) (subject string, admin bool, err error) {
	claims := &sessionClaims{}
	if _, parseErr := jwt.ParseWithClaims(raw, claims, func(*jwt.Token) (any, error) { return t.key, nil },
		jwt.WithValidMethods([]string{signingMethod}),
		jwt.WithIssuer(Issuer),
		jwt.WithAudience(AudienceSession),
		jwt.WithExpirationRequired(),
	); parseErr != nil {
		return "", false, fmt.Errorf("token rejected: %w", parseErr)
	}
	if claims.Subject == "" {
		return "", false, fmt.Errorf("token rejected: no subject")
	}
	return claims.Subject, claims.Admin, nil
}

// JobAudience is the audience of the token belonging to one bake job.
func JobAudience(jobID string) string { return AudienceJobPrefix + jobID }

// bakeClaims is a bake job token's payload: the registered set plus the ONE
// world the job exists to bake.
type bakeClaims struct {
	jwt.RegisteredClaims
	// World narrows the token to its job's world (step 4 of the access plan,
	// 2026-08-12): the artifact store accepts a job as a writer only where
	// this claim matches the artifact's world. Without it a leaked job token
	// was a pass for ANY artifact for its hour.
	World string `json:"wld,omitempty"`
}

// IssueJob mints the credential one bake job carries: subject is the
// machine identity, audience names the job, and the world claim names the
// one world it may touch.
func (t *Tokens) IssueJob(jobID, worldUID string, ttl time.Duration) (string, time.Time, error) {
	if jobID == "" || worldUID == "" {
		return "", time.Time{}, fmt.Errorf("refusing to issue a bake token without a job and its world")
	}
	now := time.Now()
	expires := now.Add(ttl)
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, bakeClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   SubjectJob,
			Audience:  jwt.ClaimStrings{JobAudience(jobID)},
			Issuer:    Issuer,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(expires),
		},
		World: worldUID,
	})
	signed, err := token.SignedString(t.key)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("signing a token: %w", err)
	}
	return signed, expires, nil
}

// VerifyJob accepts a token belonging to SOME bake job, and says which —
// the job AND the world its claim narrows it to.
//
// Separate from Verify because the caller does not know the audience in advance
// — that is the thing being asked. Everything else is identical: the same
// pinned method, the same required expiry, the same issuer. Only the audience is
// matched by shape rather than by value, and it must still BE one: a token with
// no `bake:` audience is refused here exactly as a session token is.
//
// It exists because a Job reaches the API like any other client and would
// otherwise be refused by the gate — which is what happened on the first real
// cluster run after job tokens were introduced. worldUID may be empty only
// for a token minted before the claim existed; callers that gate on the
// world treat that as no claim at all.
func (t *Tokens) VerifyJob(raw string) (subject, jobID, worldUID string, err error) {
	claims := &bakeClaims{}
	if _, parseErr := jwt.ParseWithClaims(raw, claims, func(*jwt.Token) (any, error) { return t.key, nil },
		jwt.WithValidMethods([]string{signingMethod}),
		jwt.WithIssuer(Issuer),
		jwt.WithExpirationRequired(),
	); parseErr != nil {
		return "", "", "", fmt.Errorf("token rejected: %w", parseErr)
	}
	// Exactly one, so a token carrying both a session and a job audience cannot
	// be minted into something that is quietly both.
	if len(claims.Audience) != 1 || !strings.HasPrefix(claims.Audience[0], AudienceJobPrefix) {
		return "", "", "", fmt.Errorf("token rejected: not a bake job token")
	}
	id := strings.TrimPrefix(claims.Audience[0], AudienceJobPrefix)
	if id == "" || claims.Subject == "" {
		return "", "", "", fmt.Errorf("token rejected: incomplete bake job token")
	}
	return claims.Subject, id, claims.World, nil
}
