---
summary: How the server establishes who is asking. Three modes stay — but `token` becomes `password`, because the axis that matters is WHERE the users live, not what the header looks like. Credentials are an htpasswd file mounted from a Secret; logging in exchanges them for a JWT the server issues itself; OIDC later is a second login method feeding the same token, not a second token. Four paths stay public so a logged-out client can find out where to log in. Revocation is decided (short TTL plus refresh, revoked by a per-user stamp) but not yet built. Both files live in the Secret; the cost — an admin screen cannot write users through a read-only mount, and would go through the Kubernetes API — is recorded rather than discovered later.
date: 2026-08-09
updated: 2026-08-13
area: platform
stage: built
status: decided, sequenced in seven steps. ALL SEVEN BUILT 2026-08-09 — the server authenticates and enforces, the client signs in and behaves like a serverless one when it has not. Refresh (step 8) remains unscheduled. 2026-08-13 — the CREDENTIAL half is superseded by server-user-admin.md: htpasswd and the recorded "admin screen writes the Secret through the k8s API" consequence retire in favour of auth.db (bbolt) under auth.storage; the bcrypt rules and the absent-user timing defence carry over. The token/JWT/mode half of this doc stands unchanged
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

**Where the file lives: the Secret, with its consequence stated.** Decided
2026-08-09, and it reverses an earlier answer in the same session, so both are
recorded rather than only the winner.

The first answer was the writable data directory, reasoning from what comes
after: a persistent user administration is planned, an htpasswd mounted from a
Secret is **read-only** — in Kubernetes, unavoidably so — and a screen that
creates users cannot write there.

The decision is the Secret anyway, because credentials belong with the other
things that must not be in git, and one place to look beats one place to write.
What that costs is exactly the thing the first answer was protecting: the admin
screen cannot add a user by writing the file. It would write the **Secret through
the Kubernetes API** instead, which the ServiceAccount already exists for and
which needs a few lines of RBAC. That is a different mechanism, not a dead end,
and knowing it now is why this paragraph is here.

`--auth-htpasswd` still names a file, so a local server points it anywhere it
likes; only the cluster deployment mounts it read-only.

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
      secretName: casas-eternas-auth   # keys: htpasswd, session.key
```

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

The login endpoint is its own module (`internal/modules/session`) rather than a route the
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

**6. `config.json` gains `login`. BUILT 2026-08-09.**

```json
{"apiBase":"/v1","authMode":"password","login":{"path":"/v1/session"}}
```

Absent under `none`, because there is nothing to log in to and an empty object
would invite the client to decide what that means.

The client module is TOLD the path rather than importing it from the session
module. cmd/ composes, so cmd/ names `session.Path` — the same reasoning as the
gate's exempt list in step 5, and it keeps two modules mountable apart.

`ServerStatus` on the client side gains `loginPath` beside `authMode`. Still no
form: the client can now say *that* it would need to log in, and *where*.

**7. The client's sign-in. BUILT 2026-08-09.**

**One place attaches the token, not twelve.** `server/session.ts` holds it and
exposes `authFetch`, which every server client now goes through. The point is the
401: a token expires mid-session, or the server restarts with a fresh signing
key, and the next call is the first anyone learns of it. One wrapper turns that
into a state change every listener sees, instead of twelve call sites each
inventing a way to report a failure.

**The artifact store's token became a function.** It had an unused
`authToken?: string` option, captured when the store was built — the wrong shape
for a value that changes at sign-in and at expiry. It is `authHeaders?: () =>
Record<string, string>` now, asked at call time, and passed in from the
composition root for the same reason `resolveBase` is: a byte store has no
business knowing how this application authenticates. A bake Job's fixed,
key-scoped token satisfies it by returning the same thing every time.

**Signed out is a state, and the fallback was already there.** `canCommissionBakes`
now answers no without a session, which is all it took: `bakeFromArchive` already
falls through to `bakeStageInBrowser` when the server cannot be used. 8K still
cannot, and now says WHICH of the two problems it is — "needs a server" would
send someone to check a deployment that is fine.

**What the first run through it caught**, all one root: a failure that could not
happen before authentication is one nothing was written to report.

- The artifact store sent the header but used a plain `fetch`, so a dead session
  failed silently THERE while everywhere else noticed. Injecting headers was half
  the job; it takes the session's fetch, and the option is a fetch now.
- Previews were `<img src>`, which the browser resolves itself and therefore
  without credentials — every thumbnail 401'd, and an image's error event says
  nothing. Fetched into an object URL instead.
- "The world list could not be read" and "the server has no worlds" shared one
  message, because before authentication the first could only mean no server —
  in which case the window does not open at all.
- And nothing announced the loss itself. `onSessionLost` fires only from the 401
  branch — signing in and out are things someone just did and can see — and the
  app root says it once, rather than every caller reporting its own symptom.

**localStorage, stated as a trade.** The token is readable by any script on the
origin, which is true of anything a single-page app can send on its own requests;
the alternative that is not is an HttpOnly cookie, ruled out because the CLI and
the bake job need the same door. What it buys is the thing the long lifetime is
for: closing the tab is not signing out.

**The window never appears uninvited.** Not at startup, never over the map. It
opens from the indicator's badge and nowhere else. The password field is cleared
on every open — a password left in a detached form is one a screenshot still has.

It briefly also showed who was signed in, with a sign-out button, and that was
**unreachable**: the indicator is clickable only WHILE the sign-in is missing, so
by the time there was a name to show there was no way into the window. Removed,
along with the two catalog keys it needed.

**So a deliberate sign-out has no home**, and that is a gap rather than a
decision. `signOut()` exists and is called when a request comes back 401; what is
missing is a way to say "not me any more" on a shared machine. The storage panel
is the natural place — it is already the window about server things — but it is
not built.

Refresh (the two-token split and the per-user stamp) is a step 8 that is not
scheduled: `--auth-token-ttl` carries the session length until it exists.

## The logged-out client

Decided 2026-08-09, while planning step 7.

**Logged out behaves like "no server", not like a fault.** Everything local —
generating, the OPFS cache, saving a `.zip` to disk — depends on no server at
all, and the client already has `none` and `unreachable` states for exactly that
situation. Being logged out joins that family rather than becoming its own kind
of breakage.

That turns out to be nearly free, because the fallback already exists. A 4K bake
reads `canCommissionBakes()` and falls through to `bakeStageInBrowser` when the
answer is no — the comment there carries the measurement: 78 s on the server
against 232 s in the tab. The one change authentication needs is that a
logged-out client answers "cannot", so the bake falls back instead of attempting
it, collecting a 401 and reporting a failure. 8K stays server-only: that is the
~2.6 GB a tab does not survive, and no login changes it.

**The indicator becomes a control, on purpose.** It documents itself today as
"a status readout rather than a control: it never opens anything". That stops
being true once it is the way back IN, and the comment changes with it rather
than being quietly contradicted. Clicking opens the login — but only when logging
in would change something: under `none`, or with no server at all, there is
nothing to open, and a window saying "you cannot log in here" is worse than an
indicator that stays quiet.

**Logged out never blocks.** No dialog at startup, no overlay over the map — just
the badge. Someone who wants to bake 4K locally and save a file should be able to
without ever seeing a password prompt.

**A badge, not a fifth state.** The four states answer WHERE a world would go;
being logged out answers WHETHER YOU MAY PUT ONE THERE, and the two are
orthogonal — one can be logged out of a local server or a shared one. A fifth
state would multiplex two independent facts into one symbol and lose the first.

The glyph is `no.png`, the same one the "no server at all" state uses as its main
icon. That is deliberate rather than a shortage of icons: it means the same thing
in both slots — not available — and the SLOT says what it is about. Main icon: no
server. Badge: there is one, but not for you. The single nonsensical combination
cannot arise, since no server means nothing to log in to and therefore no badge.

## What a cluster bake needed before it worked again

Two things, found 2026-08-09 while costing progress reporting for bake Jobs, both
blocking the `password` deployment for SERVER-side bakes. Both fixed the same
day; nothing in the browser was ever affected, and a 4K bake fell back to it
throughout.

**The bake Job carried no token — FIXED 2026-08-09.** `Spec.AuthToken` was
declared, rendered into the Job and read by the baker, and set by nobody.
Harmless while the server ran `none`; with the deployment in `password` mode the
Job's `GET /v1/worlds/{uid}` was a 401 and the bake could not start.

The module now mints one per cluster job, and three choices came with it:

- **The audience names the JOB**, not the artifact key it writes. Decided while
  planning progress reporting: a job reports against one order, so the token has
  to identify which. The artifact key is in the spec anyway.
- **The subject is `bake-job`, not the person who ordered it.** A job may write
  the artifacts of one world; borrowing its orderer's identity would hand it
  everything that person may do, and would make a log line about a misbehaving
  job name the wrong party.
- **One hour.** The token travels in a Job spec, readable by anyone who can read
  Jobs in the namespace, so its lifetime is how long that exposure lasts. Long
  enough for the scheduling deadline plus the longest bake, short enough that a
  leaked spec is stale the same morning.

A job that cannot be given a token FAILS rather than going out without one: it
would start, read the world, collect a 401 and report a bake failure whose cause
was entirely on this side.

**The baker was outside every check.** `tsconfig.json` included only `src`, so
`scripts/bake.ts` — the server-side baker, which shares code with the browser —
was type-checked by nothing. It went on passing a store option that had been
removed hours earlier, and compiled. Fixed the same day: `tsconfig.node.json`
covers `scripts/` with `@types/node` (kept apart so browser code cannot reach
`process`), and `make lint` runs both configs. Verified by putting the break back
and watching it go red.

## A bake Job is a caller, and not a user

Found on the first real cluster run, 2026-08-09: `cannot read the world`.

The Job had its token by then, and the gate refused it — **by design**. A test
asserted, approvingly, that "a bake token must not open the API". That was half
right and wholly blocking: a Job reads the world it was created to bake over that
very API, so a token the gate rejects is a token good for nothing. The audience
split had been built to keep a job from being a LOGIN, and had quietly been
implemented as keeping it from being a caller at all.

`identity.Caller` now accepts both kinds, and the distinction moved to where it
belongs — the subject:

- a session's subject is the user
- a job's is `auth.SubjectBakeJob`, which no ownership comparison accepts

**Two holes surfaced while closing it, both caught by tests rather than by
reading.**

The first: `Caller` returned the job token's subject CLAIM, so a token minted for
"ada" with a bake audience passed an ownership check as ada. The claim is ignored
now and the constant returned — a job is a job whatever it says it is. Relying on
the one place that mints them to always write the right subject is a habit, not a
guarantee.

The second: `canBake(caller, owner)` was true when both were the job subject,
which is reachable — a job is a caller, so a world it wrote would record it as
the owner. A machine identity now owns nothing, stated as its own rule rather
than left to the absence of such a world.

**What is still coarse, and knowingly.** A job token is accepted for the whole
API for its hour, not narrowed to the one world and the one artifact key it
should touch. Narrowing wants the handlers to consult the job's spec, which is
cheap once the progress endpoint exists (it already looks a job up by id) and is
the natural next step when artifact writes get owner checks — stage 2 of "Who may
write" in the storage design.

## Progress from a Kubernetes Job

Built 2026-08-09, and it is what the audience was for.

A Job on another node has no pipe to report through: the Kubernetes API says
pending, running or gone, and nothing between. The alternative considered and
rejected was reading the pod's log — a second connection with its own failure
modes, which is what the earlier note in NotificationOptions argued against.

`POST /v1/bakes/{id}/progress` uses the connection the Job already has for the
world and the artifacts, and **the token is the authorisation**: a job's token
names one job, so the check is `jobID == id` and nothing else. No ownership
lookup, no caller-to-job table.

Four decisions inside it:

- **403, not 401**, for a caller that is not this job — including a perfectly
  good user session. They are authenticated; they are just not this job.
- **Only while the job is RUNNING.** A late report, from a retry or a pod that
  outlived its result, must not reopen a finished record or move a failed one
  back to 50%.
- **404 for both "no such job" and "not running".** The reporter cannot act on
  the difference, and answering it would let anyone holding one job's token
  probe the state of others.
- **Clamped, not rejected**, for a percent out of range: losing the phase over a
  rounding error is the worse trade.

The baker throttles by TIME rather than by percent — one line per whole percent
is right for a log and would be a hundred requests per phase here — and always
sends a phase CHANGE, which is the part a reader acts on. It is fire and forget:
a bake must not fail because a status update did.

**And the local runner gets no job id at all.** Its progress reaches the server
over the pipe this process is already reading; handing it an id would invite it
to post progress to a server it is running inside.

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
