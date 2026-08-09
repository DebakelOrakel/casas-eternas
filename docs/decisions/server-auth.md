---
summary: How the server establishes who is asking. Three modes stay — but `token` becomes `password`, because the axis that matters is WHERE the users live, not what the header looks like. Credentials are an htpasswd file mounted from a Secret; logging in exchanges them for a JWT the server issues itself; OIDC later is a second login method feeding the same token, not a second token. Four paths stay public so a logged-out client can find out where to log in. Revocation is decided (short TTL plus refresh, revoked by a per-user stamp) but not yet built. The user file lives in the writable data directory rather than the Secret, because the planned admin screen has to be able to add users.
date: 2026-08-09
status: decided, sequenced in seven steps. STEPS 1–5 BUILT 2026-08-09 — the server authenticates and enforces. What is left is the client: telling it where to log in, and a form to do it with
---

# Server authentication

The staging was decided long ago and is already in the code: build with a notion
of identity from day one, check it later
([server-storage.md](../design/server-storage.md)). `identity.Caller` is the one
place that answers "who is asking", the world store records an owner, and the
bake module compares against it. What was never decided is what actually fills
that in. This does.

## The correction that reorders everything

The three modes were `none` / `token` / `oidc`, and the first observation is
that the last two look identical: both arrive as `Authorization: Bearer <x>`.

They are identical **on the wire** and nowhere else:

| | static token | OIDC |
|---|---|---|
| who issues | this server | a foreign IdP |
| how it is checked | compare against a secret we hold | verify a signature against fetched JWKS, plus `iss`/`aud`/`exp` |
| what logging in looks like | paste a secret | a browser redirect the server never sees a password in |

So the axis is not "token versus OIDC" — it is **where the users live**. The
modes become:

```
none      local; a synthetic identity owns everything (unchanged)
password  this server holds the user database
oidc      a foreign IdP holds it
```

That is also exactly what the client needs to be told: `password` means "show a
form", `oidc` means "redirect". `basic` would have been the wrong name for the
middle one — it describes the transport of one endpoint, not the flow.

## Basic auth: the right credential format, the wrong request scheme

Sending `Authorization: Basic` on every request is the obvious reading of "use
basic auth instead of a token", and it fails on three counts:

- **Cost.** A properly hashed password (bcrypt) takes ~100 ms to verify *by
  design*. Per request that is untenable, and a cheap hash chosen to make it
  affordable is the vulnerability the hashing was for.
- **No way out.** The native browser prompt (`WWW-Authenticate: Basic`) has no
  logout. For a single-page app that alone disqualifies it.
- **The password would have to stay in the browser** to be replayed on every
  request — strictly worse than a token that expires.

So basic auth is used at **one** endpoint, to log in, and what comes back is a
token. The transport after that is the `Authorization: Bearer` path
`identity.Caller` already parses and the baker already sets, so this is a change
of where the token comes from rather than a new mechanism.

## Credentials: htpasswd, not a JSON user file

The deciding argument is a boundary worth keeping sharp: **the credential file
answers authentication, the world store answers authorisation.** The store
already records an owner per world; roles and quota belong there. Put them beside
a password hash and game state ends up in a file that is otherwise an operations
concern, rotated and mounted by people who should never touch worlds.

Given that split, the credential file needs to answer exactly one question — is
this password right for this user — and htpasswd answers it with a format that
already has tooling (`htpasswd -B -c auth.htpasswd ada`), a bcrypt convention,
one line per user, and trivial appendability. A JSON file would mean inventing a
format, a hashing convention and the tools to edit it.

`golang.org/x/crypto/bcrypt` is the only new dependency this half needs.

**Where the file lives, decided by what comes after it.** A persistent user
administration with a small admin screen is planned (2026-08-09), and that
settles a question the format alone does not: an htpasswd mounted from a Secret
is **read-only** — in Kubernetes, unavoidably so — and a screen that creates
users cannot write there.

So the user file belongs in the **writable data directory**, beside the worlds,
and the Secret carries only `session.key`. `--auth-htpasswd` still names a file,
so mounting a read-only one remains possible for a deployment that manages users
by hand; the admin screen then simply cannot add any. The constraint is expressed
by the filesystem rather than by a second config value, and `htpasswd -B` works
on both.

## The token: JWT, self-issued, in every mode

**OIDC is a login method, not a second token.** The alternative — pass the IdP's
token through and verify it on every request — would leave the API with two token
types that never meet, one per mode. Issuing our own after verifying the IdP's
means the API sees exactly one token type always, `identity.Caller` keeps one
code path, the baker is unaffected by the mode, and lifetime and audience are
ours rather than the IdP's.

**Why JWT rather than a hand-rolled HMAC token**, which would be about twenty-five
lines: not because it saves OIDC work. It barely does — OIDC's bulk is the
authorization-code flow, PKCE, discovery, JWKS fetching and key rotation, and a
library handles the signature check regardless of what our own token looks like.

The real reason is that **this system already has more than one verifier**. The
bake job runs in its own pod carrying a token that is meant to be scoped to one
artifact key, and the design points at a server that computes bakes itself, which
is another service again. For one verifier holding one secret, a bespoke token is
fine. For a second, you want a self-describing format — and eventually you want
that verifier to be able to *check* without being able to *mint*, which in JWT is
a key change (HS256 → EdDSA plus published JWKS) and in a bespoke format is a
format change.

One benefit is collectable immediately: `aud`. A user session and a bake-job token
are indistinguishable strings today. As claims they are different audiences, and
an intercepted job token cannot be replayed as a user session.

Shape: `sub` (who), `aud` (`session` or `bake:<artifactKey>`), `exp`, `iat`,
`iss`. HS256 against the mounted key. Library: `github.com/golang-jwt/jwt/v5`.

**Two guard rails belong in the code, not in anyone's memory.** JWT's poor
security record is concentrated in two places — `alg: none`, and algorithm
confusion where an HS256 token is signed with the RS256 *public* key. Both are
avoided by pinning the algorithm at verification and **never reading `alg` from
the header**. It is one line, and it is the kind of line that is omitted once.

## Logging in

```
POST /v1/session      Authorization: Basic base64(ada:secret)
  → 200 {"token": "...", "expiresAt": "...", "user": "ada"}
  → 401, and deliberately WITHOUT WWW-Authenticate — that header is what
    summons the native browser dialog we are avoiding
```

Basic at that endpoint rather than a JSON body, because `curl -u ada:secret`
then works unchanged: the CLI and the baker need the same door as the browser,
which is also the argument against a cookie-only session.

When refresh arrives the response gains a second token, and the shape above is
what stays: the access token is what every other request carries, then and now.

`DELETE /v1/session` stays cosmetic, and the revocation section says why — with a
per-user stamp rather than a token store there is nothing server-side to delete.
Logging out is the client forgetting both tokens; the access one expires by
itself in minutes, which is precisely what the short lifetime is for.

## What stays public, and why

Four things, the first two on principle rather than convenience:

- **`GET /config.json`** — the discovery document, by definition. Behind auth,
  a client could never learn where to authenticate.
- **`GET /v1/capabilities`** — the reachability probe. Behind auth, a logged-out
  user is told "server unreachable" instead of "please log in", which is a
  misleading state and not a secret worth keeping: that a server exists reveals
  nothing.
- **`POST /v1/session`** — the login endpoint itself.
- **The static client** (`GET /`, `/assets/*`) — the app must load before anyone
  can log in.

Everything else answers 401.

**`config.json` has to say more than it does.** `authMode` states *that* login is
required, not *where*:

```json
{ "apiBase": "/v1", "authMode": "password", "login": { "path": "/v1/session" } }
```

The same field carries the IdP's authorize URL and client id under `oidc` — and
that one the client cannot derive from `apiBase` at all. So the location is
spelled out even in the `password` case, where deriving it would work: the client
has no business knowing the server's route layout.

## Kubernetes: a mounted file, not an environment variable

```yaml
volumeMounts:
  - name: auth
    mountPath: /etc/casas-eternas/auth
    readOnly: true
volumes:
  - name: auth
    secret:
      secretName: casas-eternas-auth   # key: session.key
```

Only the session key. The user file lives in the writable data volume — see
"Where the file lives" above.

**Not an environment variable**, because this process *starts Kubernetes Jobs*
([distributed-bake.md](./distributed-bake.md)). Environment is inherited by child
processes and shows up in `ps` and in crash dumps; a mounted path does neither.

**Re-read per login attempt, no cache.** Kubernetes updates the projected file
when the Secret changes, so caching the contents buys a cache-invalidation bug in
exchange for file I/O on an operation that happens rarely.

**`session.key` matters more than it looks.** Generated at startup instead, every
restart invalidates every session — and with several replicas each accepts only
its own tokens. It belongs in the Secret with the passwords.

## Revocation: short TTL plus refresh — decided, not yet built

A stateless token is valid until it expires, whether it is a JWT or a bespoke
string. Agreed 2026-08-09 that revocation is not needed yet, and that when it
arrives it is **short TTL plus refresh** rather than a deny-list on the access
token.

**What that actually buys, stated plainly, because it is easy to mis-expect.**
A short lifetime by itself does not revoke anything — it only shortens the window.
Revocation comes from the *refresh* step being the one place that consults server
state. So the pattern is two tokens with different jobs:

- **access token** — minutes, sent on every request, stateless, never consulted
  against anything. This is the JWT above.
- **refresh token** — long-lived, sent ONLY to the refresh endpoint, and checked
  against state. That check is the revocation point.

Without state on the refresh side, refresh buys nothing but more frequent logins.

**How much state — the per-user stamp, not a token store.** The case that matters
here is "this user is out", not "log this one device out". A single
`notBefore` timestamp per user answers the first completely: bump it and every
token issued earlier stops verifying, everywhere, at once. It is a number, it
lives beside the credentials, and revoking is setting it.

A per-token store is what the second case needs, and it is a different size of
thing — entries with a lifecycle, expiry and cleanup. Not worth it for a handful
of users; recorded so the choice is visible if per-device logout is ever wanted.

**The bake job's token does not refresh.** Its audience is `bake:<artifactKey>`
and its life is the job's life; a job that outlives its token has already gone
wrong. Refresh belongs to `aud: session` only, which the audience split above
already makes expressible.

**Consequence for the flags below:** one TTL is no longer enough. The access
token wants minutes and the session wants weeks, and collapsing them would either
log people out constantly or make the short lifetime pointless.

## Sequencing

Each step ends green on `go test ./internal/...` and `make lint`, and each is
useful on its own. The default stays `none` throughout, so nothing changes for a
local server until someone passes `--auth-mode`.

**1. The mode, renamed. BUILT 2026-08-09.** `config.AuthToken` → `AuthPassword`,
and `--auth-mode` exists for the first time. Nothing authenticates yet;
`password` still resolves every caller to Anonymous, which is what
`identity.Caller` already does for a mode that claims to check.

`ParseAuthMode` came with it, and it is the part worth having: `ChecksIdentity`
counts everything that is not `none` as a mode that checks, so `--auth-mode
passwrod` would have started a server that refuses every request while looking
healthy — a misconfiguration wearing a permission bug's clothes. It now refuses
to start. The mode is resolved ONCE in `buildModules` and handed to all three
modules that take one, so the value the client is told cannot drift from the one
the server enforces.

Two consequences landed as predicted: `bake_test.go`'s "unrecognised token = 403"
now reads "unverifiable token", stating the rule that will matter once there is a
verifier — a token the server cannot verify is worth exactly as much as none at
all, never a fallback to a weaker identity. And the client's `/config.json`
comment stopped saying `token`.

**2. Credentials, as a package with no HTTP in it. BUILT 2026-08-09.**
`internal/auth` holds the file's PATH, never its contents, and re-reads per
attempt — Kubernetes rewrites a projected Secret when it changes and the admin
screen will rewrite the file directly, so a cache would buy an invalidation bug
in exchange for file I/O on an operation that happens once per login.

Three decisions taken while building it, each against the obvious alternative:

- **Strict parsing, not skip-what-you-cannot-read.** The plan said skip; that is
  wrong. A skipped line is a user who silently cannot log in — and if it is the
  only administrator, a lockout with no message. Errors name the file and line.
  The price is that a HALF-WRITTEN file rejects everyone, which is why the admin
  screen must write to a temporary file and rename over the target. Kubernetes
  already does exactly that for projected Secrets.
- **bcrypt only, and not below cost 10.** htpasswd also writes MD5-crypt
  (`$apr1$`, apache's own default), SHA1 and plaintext; all are refused. The cost
  floor was added on 2026-08-09 after measuring what `htpasswd -B` actually
  writes: **cost 5**, where Go's own default is 10 — roughly thirty times cheaper
  to attack, and visually identical to a strong hash. Rejecting rather than
  warning was chosen because it is cheap to do now, while no files exist in the
  wild to lock anyone out of. Both errors name the remedy (`htpasswd -B -C 12`),
  because "wrong format" without one is just an obstacle.
- **A duplicate user is an error**, because silently taking one of the two is how
  a user somebody believes they removed goes on working.

**One hardening the plan did not name.** An unknown user would be rejected in
microseconds while a real one costs bcrypt's deliberate ~100 ms — three orders of
magnitude, measurable by anyone, which turns the login endpoint into a "does this
account exist" oracle. Comparing against a fixed valid hash when the user is
absent removes the signal for free. There is a test that MEASURES it rather than
asserting it in a comment: a ratio, so it means the same on any machine.

The fixed hash is at the recommended cost (12) rather than the floor, so it is
never cheaper than a hash in the file. The residual is stated in the code rather
than hidden: a file using a cost above 12 makes a real user slower than an absent
one again — a factor of two or four against network jitter, rather than the
thousandfold gap this removes.

**Documenting how to make the file** belongs with the flag, and is the first
thing anyone needs: `htpasswd -B -C 12 -c <file> <user>` for the first user, the
same without `-c` for every further one (with `-c` it truncates), `htpasswd -D`
to remove one.

**3. The token, likewise standalone. BUILT 2026-08-09.** Issue and verify in one
object — an issuer and a verifier that could be configured apart is a bug with no
symptom until the day nothing can log in. Pinned method, required expiry, checked
issuer and audience.

**The audiences earn themselves immediately.** A bake token is
`bake:<artifactKey>` and a session is `session`, so a job token — which travels
to another pod and sits in a Job spec, far more exposed than a browser's — cannot
be replayed as a login, and cannot be used against a different artifact key
either.

**On the two attacks, and what measuring them changed.** Both are in the tests.
Then the pin was REMOVED to see which test noticed, and only one did: the
algorithm-confusion case reported `an HS512 token was accepted as "ada"`. The
`alg: none` case stayed green — golang-jwt refuses that unless the keyfunc hands
back its `UnsafeAllowNoneSignatureType` sentinel, and ours hands back an HMAC
key, so the refusal was never the pin's doing. The test is worth keeping (it pins
that we never opt in, and that the library keeps requiring it) but its comment
now says what it actually guards. A green test proves nothing until you know what
turns it red.

**4. `POST /v1/session`, and identity learns to verify. BUILT 2026-08-09.**

`identity.Caller` became `identity.Resolver.Caller`, because answering now needs
a verifier and a verifier needs a key. The consequence is a simplification the
plan did not anticipate: `world.Config` and `bake.Config` no longer carry an
`AuthMode` at all — they hold the one Resolver and ask it. A module that used to
know how authentication was configured now only knows how to ask who is calling,
which is what the package claimed to be for.

The login endpoint is its own module (`internal/session`) rather than a route the
server mounts beside `/v1/capabilities`, because "modules claim their routes" is
this codebase's existing shape and the endpoint fits it. `internal/auth` stays
HTTP-free, as steps 2 and 3 set it up to be. It is mounted whenever there is
something to log in to, regardless of `--target`: a deployment serving only the
artifact store still has to let its callers authenticate.

`Caller` verifies the token itself rather than reading a value a middleware put
in the request context — its stated purpose is to be the ONE place that answers
"who is asking", and moving the answer elsewhere would undo that to save a
signature check that costs microseconds.

Two things the wiring taught:

- **Fail before warning about something else.** The first version generated an
  ephemeral signing key (with its warning) and then refused to start because
  `--auth-htpasswd` was missing. Two messages about different things, the loud
  one irrelevant. Users are checked first now.
- **The bake test could finally say something true.** It asserted "nobody can
  authenticate yet"; with a real verifier it now issues real tokens and checks
  that a stranger's session, a bake token for the very artifact key in question,
  and nonsense are all refused identically — while the owner's own session is
  not. The audience split earns itself there, from the enforcement side.

**5. 401 for everything else. BUILT 2026-08-09.**

The rule came out shorter than the plan assumed, because reading the actual route
table showed it was already true: **everything under `/v1/` needs a caller,
except the paths named exempt.** Everything outside `/v1/` is the browser
application, which has to load before anyone can log in. So there is no list of
protected paths to maintain — a route added tomorrow is protected by default,
which is the direction a mistake should fall in.

The exempt list lives at the **composition root** (`cmd/`), not in the server
package. `server` deliberately knows about no module — a module is mountable
purely by having three methods — and importing one to read a path constant would
trade that away. cmd/ already imports every module, so it can name
`client.ConfigPath`, `server.CapabilitiesPath` and `session.Path` rather than
repeat three string literals, which is how a path stops being exempt without
anyone deciding it should.

**The gate does not know about auth modes**, and that is worth more than it
looks. In `none` mode every caller resolves to `identity.Local`, which is not
Anonymous, so the gate passes everyone with no special case: the mode is
expressed once, in the resolver. The test that matters guards the other
direction — a single-user local server locked out of its own worlds would be the
worst regression this step could cause.

Verified end to end as well as in tests: `/config.json` and `/v1/capabilities`
answer 200 while logged out, `/v1/worlds` answers 401 with no credentials and
with an unverifiable token, and 200 with a session from `curl -u`. In `none` mode
`/v1/worlds` answers 200 with nothing at all, and `/v1/session` does not exist.

**6. `config.json` gains `login`.** Server side, plus the client's
`serverStatus.ts` reading it. Still no form — the client can now say *that* it
would need to log in.

**7. The client's login form**, and a fifth state for the server indicator
("logged out" as distinct from "unreachable" — the whole reason `capabilities`
stays public). Needs new i18n keys, to be proposed before they are added.

Refresh (the two-token split and the per-user stamp) is a step 8 that is not
scheduled: `--auth-token-ttl` carries the session length until it exists.

## Flags

```
--auth-mode none|password|oidc     there is no flag for this today at all
--auth-htpasswd <path>             the user file
--auth-session-key <path>          HMAC key; absent → generated at startup, with a warning
--auth-token-ttl <duration>        the access token; proposed default 15m
--auth-session-ttl <duration>      how long you stay logged in before re-entering
                                   a password; proposed default 720h
```

The two TTLs are the refresh decision made concrete. Until refresh is built,
`--auth-token-ttl` is the only one that does anything, and its default should
then be the session length rather than 15m — a short-lived token with nothing to
renew it is just a logout timer.

Two consequences that travel with them: `config.AuthToken` becomes
`AuthPassword`, and `bake_test.go`'s "unrecognised token = 403" then describes
something else and needs restating.

## Related

- [server-storage.md](../design/server-storage.md) — the auth staging this
  fills in, and the ownership model it feeds
- [distributed-bake.md](./distributed-bake.md) — the job token that becomes an
  audience, and the reason secrets must not live in the environment
