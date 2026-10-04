---
id: DEC-0022
title.en: Server users: identity vs credential
title.de: Server-Nutzer: Identität und Zugangsdaten
summary.en: Who a user IS, as opposed to how they log in. A registry (users.json under
  auth.storage) holds stable uuid identities, MINTED AT FIRST LOGIN —
  htpasswd stays the one place users are administered, and the registry
  follows it. A session token's subject is the registry id from then on,
  never the login name; the name remains display data in the login response.
  Admins are login names on global.auth.admins whose sessions carry an `adm`
  claim — the decision travels in the token, so every process keeps
  verifying locally and none ever needs the registry. Step 1 of the
  access-control build order.
summary.de: Wer ein Nutzer IST, im Unterschied dazu, wie er sich anmeldet. Ein Register
  (users.json unter auth.storage) hält stabile UUID-Identitäten, ERZEUGT
  BEIM ERSTEN LOGIN — htpasswd bleibt der eine Ort, an dem Nutzer verwaltet
  werden. Das Subjekt eines Session-Tokens ist ab dann die Register-ID, nie
  der Login-Name. Admins sind Login-Namen in global.auth.admins, deren
  Sessions einen Claim `adm` tragen — die Entscheidung reist im Token, jeder
  Prozess prüft lokal. Schritt 1 der Bauordnung zur Zugriffskontrolle.
area: platform
stage: built
createdAt: 2026-08-12
updatedAt: 2026-10-04
related: [DES-0011, DEC-0019, DEC-0023]
---

## The problem

Everything that is about to exist — owners that stick, grants, admin rights —
needs to record WHO. The only name the server had was the htpasswd login
name: credential surface an operator edits, renameable, and about to collide
with a second login method (OIDC brings a foreign `sub`). Recording names as
identities bakes the credential into every owner field and grant.

## The decision: an id-keyed registry, minted at login

`internal/user` keeps `users.json` — `{id (uuid v4), name, createdAt,
oidcSubject?}` — written atomically, refusing to open when corrupt (starting
fresh would re-mint every id and orphan everything recorded under the old
ones).

Entries are minted **on first successful login**, in the session module,
right after the password verifies. Rejected alternatives:

- **Pre-provisioning** (operator writes users.json too) — two files to keep
  in step, and the registry would start deciding who may log in, which is
  htpasswd's job. The registry records who exists; it never decides who may.
- **Deriving the id from the name** (hash) — a rename would silently become
  a different person; that is the bug ids exist to prevent.

The token's `sub` is the registry id from then on. The login response still
carries `user: <name>` for display, so the client is untouched. Existing
sessions die at deploy (one re-login); worlds saved before this record the
NAME as owner and re-own on their next save — the migration rule for a
checking server is in docs/design/access-control.md ("Existing worlds").

## Where the registry lives: `auth.storage`

A new `auth:` section shaped like every other target section (storage
union), because that is what auth is on its way to becoming — the separable
auth target. Deliberately NOT under `global.auth`: global holds what every
process reads (mode, shared key, TTLs, admins); the registry is state only
the login-serving process touches. Default `./auth` (`./data/auth` since
2026-09-30); the container mounts
`/data/auth`.

## Admins: a claim in the token

`global.auth.admins` lists login names. At login, the process holding the
registry checks membership and mints an `adm` claim into the session token
(`auth.IssueSession` / `VerifySession`; `identity.Resolver.Admin` reads it).

Chosen over a per-process admin list because modules know callers only by
id and the name→id mapping lives with the auth subsystem alone — a
per-process list would need the registry everywhere, exactly the coupling
the split design forbids. The cost is stated, not hidden: an admin change
takes effect at the member's NEXT login, bounded by the token TTL. The
local mode answers false — `none` has no operators to distinguish, and the
checks that will consult this all answer yes there anyway.

## Open, deliberately

- Nothing CHECKS admin yet — the claim exists so steps 3–5 of the
  access-control plan have something to read.
- Revocation (per-user notBefore) still waits on server-auth.md's step 8;
  the claim inherits its TTL-bounded staleness.
- The ephemeral-signing-key warning should probably become a refusal once
  `global.services.*` are set (split = shared key IS the trust domain) —
  to be decided when the auth target is cut.

## Status

2026-10-04: DEC-0034 adds a display name, the last sign-in and the invite
code a user came with to the user record; the login name stays the
credential's key. Not built.

decided and BUILT 2026-08-12 — registry, session hook, admin claim,
identity.Admin, deploy wiring. Steps 2–5 of docs/design/access-control.md
build on it. 2026-08-13 — revised by server-user-admin.md: users.json merges
into auth.db (bbolt) and LOCAL users become admin-provisioned there,
knowingly reversing this doc's pre-provisioning rejection (its two reasons
dissolve when identity and credential share one database).
Minting-at-first-login stays the model for OIDC. Ids and the id-in-token
rule stand unchanged; the admin claim's mechanics too — but its SOURCE moved
the same day: global.auth.admins is gone, the role is a field on the user
record, bound via `auth role bind` (the "policy an operator writes"
reasoning below inverted once the admin socket became the operator's write
channel — see server-user-admin.md's addendum).
