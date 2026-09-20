---
summary: Authorization for the multiplayer server — per-world roles (owner/editor/viewer + public flag) granted to stable user ids, enforced inside the modules against a grants.json that lives beside each world. Hand-rolled internal/access over any policy engine, with the switch point named. Decided in discussion 2026-08-12; NOTHING IS BUILT — this doc is the plan, including build order and the two bugs it must fix on the way (owner follows the last writer; bake-job tokens are API-wide).
date: 2026-08-12
updated: 2026-08-13
area: platform
stage: building
status: in progress — every fork below was put to the user and decided 2026-08-12. STEPS 1–4 BUILT 2026-08-12: user registry + id-keyed tokens + admin claim (docs/decisions/server-users.md); internal/access + grants.json pinned at create; the CHECKS run in the modules — world filters its list and gates every route (below viewer = 404, the privacy shape), artifacts and bake rank through one injected WorldAccess closure (co-resident or via the meta endpoint's callerLevel); and the bake-job token carries a WORLD claim, accepted by the artifact store exactly there — the promised narrowing, one claim, no new infrastructure. Only step 5 (grants API + share UI) remains. Orphaned artifacts (world already deleted) rank nobody and fall to the operator/eviction — noted, accepted. 2026-08-13 — the auth target gained its concrete shape in decisions/server-user-admin.md (auth.db in bbolt, unix-socket admin channel, `auth user` CLI) and design/server-deployment.md records why the split REQUIRES it (buildAuth is per-process today)
---

# Access control: sharing worlds

The finished game is not single-player: worlds must be shareable, so every
API interaction except the purely informational ones needs authorization.
This doc records the model, the shape, and the build order — decided in a
structured discussion (2026-08-12), built not at all.

It completes a boundary two earlier docs drew deliberately and left open:
[server-auth.md](../decisions/server-auth.md) states "the credential file
answers authentication, the world store answers authorisation — roles and
quota belong there", and [server-storage.md](./server-storage.md) sketches
"Who may write" in three stages, of which only stage 1 (local: anyone)
exists. This is stages 2+ written out.

## The model: a per-world ACL with ordered levels

What "sharing worlds" needs, listed exhaustively: one owner per world; a
handful of NAMED collaborators at read or read+write+bake; an optional
"anyone may read" flag; one global admin set; inheritance from the world
onto its artifacts and bakes; the none-mode bypass. What it does not need:
groups, relation traversal, roles detached from resources, attribute
predicates, delegation.

The simplest model that covers exactly that is a per-object ACL — the
Google-Docs/Unix sharing shape: a (user → level) list on the world plus a
public bit. Not classic RBAC (global roles cannot express *whose* world
anything is), and calling it ReBAC oversells it: ReBAC earns its name when
relations are traversed, and there is zero traversal here. ReBAC is the
GROWTH PATH (the day groups arrive, a grant's subject becomes a relation),
not the current model.

**The levels are totally ordered** — viewer ⊂ editor ⊂ owner ⊂ admin, each
strictly adding actions — so the check is a rank comparison, not a matrix
lookup: `levelOf(user, world) >= requiredLevel(action)`. The matrix below
documents what each level MEANS; the code needs one ordered enum and one
comparison. Caution that keeps this reversible: grants.json stores role
NAMES, never ranks — the ordering is interpretation, not storage, so a
future role that breaks the total order (conceivable in the game era)
switches the interpretation back to a matrix without touching any file or
API.

**Rejected alternatives, with the switch point named:**

- **Global-role RBAC** — cannot express per-resource ownership at all.
- **Zanzibar-class services** (SpiceDB, OpenFGA, Ory Keto) — a separate
  process with its own database, structurally against "one binary, files
  not a database, local play needs no infrastructure".
- **Embedded policy engines** — Casbin (model DSL + storage adapters) and
  OPA/Rego turn every permission question into a policy-language question,
  for what is a 3-role × 5-action matrix plus one map lookup. Oso's open
  source library is archived (2023). The switch point at which a library
  earns its place: several resource types with inheritance, groups, or
  policies that must change without a deploy. Until then the hand-rolled
  module IS the specification a migration would start from.
- **Small Go RBAC libraries** (goRBAC, ladon, …) — they model GLOBAL roles
  with inheritance, the shape rejected above, and the hard work here is
  not policy evaluation anyway: it is grants persistence, identity and
  enforcement placement, none of which any library provides. A dependency
  for the trivial 20 %.
- **Capability tokens** (Macaroons, Biscuit) — the one architecturally
  different model: rights live in the token, sharing is handing over an
  attenuated token, no grants store needed. Wrong here twice: grants must
  be LISTABLE and REVOCABLE in a UI (so the store exists anyway), and the
  server is always present to ask. Roles-as-JWT-claims fails the same way —
  a revoked grant must not outlive the token.

The property that actually carries the hand-rolled choice: authorization in
this design is DATA, not code — the matrix is a table, the grants are a
JSON file, `Can()` is a lookup. That is precisely the form a later engine
migration would start from mechanically.

**Scope cut:** the world is the only shareable resource for now; artifacts,
bakes and revisions inherit from it (artifacts already carry the worldUid in
their meta — the 2026-08-11/12 storage redesign pays in here). The game era
will add its OWN resource kinds (a running game, its dynasties/seats) with
their own roles — kept in mind, not built toward: actions are named values
(`world.read`, …) precisely so a later `game.*` family is additive.

## Identity: a small user registry, not login-name strings

When this was designed, the caller was the htpasswd login name — a string
with no stable id. Renaming a user would orphan every world they own, and
OIDC (decided, not built) arrives with a foreign subject that must map to
SOMETHING. String identity is also this repo's most recently paid-for bug
class twice over.

So: a registry — `{ id: uuid, name, createdAt }`, later an `oidcSubject` —
distinct from the credential; the registry is the identity. **Owner and
grants store user IDS, never names.** Renames become a registry edit; OIDC
becomes a second way to arrive at the same id. (Since 2026-08-13 identity
and credential live in one auth.db administered over the admin socket, and
local users are created there rather than minted at login — the id rule is
unchanged; decisions/server-user-admin.md.)

## Roles × actions

Roles per world: `viewer`, `editor`, `owner`; `public: true` makes every
authenticated user a viewer. Globally there is only `admin` — designed as
an operator flag (`--admins`), since 2026-08-13 a field on the user record
bound via `auth role bind <name> admin` over the admin socket
(decisions/server-user-admin.md, addendum) — explicit either way, and
still no first-user magic.

| action | viewer | editor | owner | admin |
|---|---|---|---|---|
| `world.read` — zip, preview, artifacts, bake status | ✓ | ✓ | ✓ | ✓ |
| `world.write` — upload a revision | | ✓ | ✓ | ✓ |
| `world.bake` — commission 4K/8K | | ✓ | ✓ | ✓ |
| `world.share` — grants, public flag, ownership transfer | | | ✓ | ✓ |
| `world.delete` | | | ✓ | ✓ |

Two cells were argued: editors MAY bake (it costs server resources, but a
shared world nobody may bake cannot be played together at 4K), and viewers
MAY download artifacts (`read` includes them — artifacts ARE world data,
which is also why artifact GETs are not "informational").

**Visibility:** private by default; the world list shows own + granted +
public. The only unauthenticated/unscoped routes remain the three that
exist today: `/config.json`, `GET /v1/capabilities`, and the login endpoint
(`POST /v1/auth/session` since 2026-08-13; the client discovers it via
`config.json`, so the move was free).

## Where the grants live: `{uid}/grants.json`

```json
{ "owner": "<userId>", "public": false, "users": { "<userId>": "editor" } }
```

A separate, server-owned file beside the world's meta — NOT a field in
meta.json, which is rebuilt from the uploaded save on every Put. That
rebuild is also today's standing bug: **`Meta.Owner` follows the last
writer** (`store.go` re-stamps it per upload), which in a shared world
means the first editor save would steal the world. Moving ownership into
grants.json fixes that structurally: the owner is pinned at creation,
moves only through an explicit transfer (`world.share`), and the meta's
`owner` becomes a display mirror. API: `GET/PUT /v1/worlds/{uid}/grants`,
whole document, If-Match like the world itself.

## Where the checks run: in the modules

The Gate stays pure authentication ("who is this"). Authorization runs in
the module handlers, which ask a narrow `internal/access` interface —
`Can(caller, action, world)` — wired by `cmd/` exactly like
`identity.Resolver` is today. The check needs the resource's context
(grants.json), which only the module has; a central route→action table
would load the world anyway and invert the modules-know-nothing rule.
`internal/access` is expected to stay under ~200 lines: the matrix above,
the grants lookup, the admin list, the none-mode short circuit.

**`--auth-mode none` stays permission-free**: every check answers yes for
the synthetic local identity. But the DATA is still written correctly —
owner, grants, public — so a store later switched to `password` has no
ownerless worlds.

## Two repairs this plan owes the existing system

- **Owner pinning** (above) — the follows-last-writer behaviour is a bug
  the moment a second user exists.
- **Bake-job token narrowing** — server-auth.md left it explicitly open
  ("the natural next step when artifact writes get owner checks"): a job
  token used to be accepted API-wide for its hour. DONE 2026-08-12 (step 4):
  the token carries its job's world as a claim, and the artifact store
  accepts it exactly there; progress reporting was already narrowed by the
  job-id audience. 2026-08-13 — the WORLD half of the same claim turned out
  to be missing: a job could not READ the world it bakes on a checking
  server (the first real cluster bake in password mode died on the privacy
  404, since every earlier one had run under `none`). The world module now
  accepts the claim for READS on exactly that world; writes and deletes
  stay refused.

## Existing worlds, and switching a server to `password`

A world without grants.json on a checking server: the meta's owner (if it
maps to a registry user) is the owner; otherwise the world is private to
admins. Worlds owned by the synthetic `local` identity are admin-only
until an admin creates grants or transfers ownership — switching modes
never silently gives worlds away; the operator decides.

## How it would fall out in code (sketched 2026-08-12, still nothing built)

**New:**

- `internal/access` (~150–200 lines): the ordered `Level` enum, `Action`
  constants, the `Grants` type, `Can(callerID, action, grants)` as a rank
  comparison, the `--admins` set, the none-mode short circuit. Pure
  functions, trivially testable.
- `internal/user` (~150 lines): users.json (uuid, name, createdAt; later
  oidcSubject), written atomically, MINTED ON FIRST LOGIN — the hook sits
  in `session`: after `Users.Verify`, `EnsureUser(name)`, and the token
  `sub` becomes the USER ID rather than the name (display name moves into
  the login response). Existing tokens die at deploy; one re-login.
- grants.json handling in the world store: `ReadGrants`/`WriteGrants`,
  created on the first Put with owner = caller id — which is where the
  owner-follows-last-writer bug dies. Migration as decided above.
- `GET/PUT /v1/worlds/{uid}/grants` at share level, whole document with its
  own small revision counter as the lock.
- Client: almost nothing at first — the world list arrives filtered; the
  share UI is stage 5, and its i18n keys are proposed then.

**Rebuilt:**

- `internal/modules/world` handlers: List FILTERS (reads grants per world — N is
  small), Get/Preview at viewer, Put at editor (create: any authenticated
  user, becomes owner), Delete at owner; `Meta.Owner` demoted to a display
  mirror of grants.json.
- `internal/modules/artifacts` — the first structurally interesting seam: the
  module must not know the world module, so its Config gains an injected
  `WorldLevel(callerID, worldUid) Level`, wired by `cmd/` as a closure over
  the world store's grants reader — composition at the root, the same
  pattern that distributes `identity.Resolver` today. resolve/read at
  viewer, resolve(create)/write at editor, listing filtered, clear at
  admin.
- `internal/modules/bake` — the second: `canBake` becomes `Can(caller, world.bake)`
  (editor and up), and the JOB TOKEN gains a world claim; `artifacts`
  accepts a bake-job caller only when the claim matches the key's
  worldUid. That IS the promised token narrowing — one claim, no new
  infrastructure.
- `internal/modules/session` / `internal/identity`: login mints the registry
  entry; `Caller()` returns the id from then on. The signature stays a
  string — the change is semantic, not structural.

**Untouched:** the Gate (pure authn), the token mechanics, the artifact
store's internals, world revisions, the client's OPFS/tiered stores (a 403
already reads as a miss there).

Rough size: 600–900 lines of Go plus tests; client near zero until the
share UI. New CLI surface: `--admins` and the registry's path flag — both
proposed properly when building starts.

## Deployment: an `auth` target, but only for authentication

Asked 2026-08-12: can this run as its own service? Split answer, and the
line runs exactly where the data lives.

**Authentication separates cleanly** — `--target auth` (CUT 2026-08-13,
server-user-admin.md step 3): login (`/v1/auth/session`), the credential
store (auth.db), later the OIDC callback and user administration. A subsystem with behaviour and its own state, i.e. the
shape the target system exists for. It can run apart because tokens are
JWTs under the shared `--auth-session-key`: every other process VERIFIES
locally and never calls the auth service per request — it is needed at
login time only, and existing sessions survive its absence. (Any process
holding the key can also issue, which is how the bake module's job tokens
keep working in a split — holding the key IS the trust domain.)

**Authorization does not separate**, by this design's own reasoning: the
decision data (grants.json) is deliberately co-located with the resource.
A standalone decision service would either centralise the data the file
layout avoids centralising, or call back into the world store per check —
the Zanzibar costs without the Zanzibar benefits. `internal/access` stays
a library each process embeds; the `WorldLevel` injection works in a split
deployment too (wired over the shared directory, or world+artifacts simply
stay co-deployed — they share the disk anyway).

Three wrinkles a split costs, named now: display names (modules store only
ids; showing a name means asking the auth service or denormalised hints in
grants.json); the admin role (RESOLVED 2026-08-13: it lives in the
registry itself now, so the login process owns both halves); and
revocation (server-auth.md's unbuilt step 8 — a per-user notBefore would
live with the registry while verification is local everywhere, so per-user
revocation needs short TTLs or a back-channel, and the split sharpens
that).

## Build order (when building starts)

1. **User registry** — users.json, minted at login; `--admins`.
2. **grants.json + owner pinning** — written on world create; meta.owner
   demoted to mirror; migration rule above.
3. **Checks in the modules** — world first (read/write/delete/list
   filtering), then artifacts (resolve/read/write against the world's
   visibility), then bake (replacing today's lone `canBake`).
4. **Bake-job token narrowing.**
5. **Grants API + UI** — the share dialog in the worlds panel; i18n keys
   proposed then, not now.

Each step lands alone and leaves the server consistent; a decisions/ doc
records the fork when step 1 begins.

## Open, deliberately

- **Groups / teams** — the first feature that would justify a policy
  library; not before a second resource type exists either.
- **Game-era roles** (seats in a running game) — a different resource with
  different verbs; nothing here presumes its shape. Two boundary stakes set
  2026-08-12: in-game POSSESSION (a dynasty's mine, a trade) is game state
  governed by game rules, not authorization — the API boundary only asks
  "may you act as this seat"; and relationships that gate visibility and
  agency (dynasty membership, alliances seeing through fog) are where the
  ReBAC growth path would genuinely engage, shaped by game design that
  does not exist yet.
- **One RUNNING world per server** (stated 2026-08-12): the store holds
  many worlds, the future world loop runs exactly one per instance — the
  shape the module design already anticipated (`world-loop` as a stateful,
  once-per-world sub-target). Game-era roles therefore attach to THE world
  of an instance, not to a set.
- **Knowledge-gated reads** (stated 2026-08-12): today `world.read` means
  the whole world, artifacts included, and for now that is fine. The game
  wants discovery — resource locations must be EARNED, so a player's
  client must not hold the full rasters. That is not an ACL question (who
  may read) but a DATA question (which parts one may know): the server
  would serve knowledge-filtered views, colliding deliberately with the
  client-holds-the-save architecture and converging with server-storage's
  endgame stage ("the server computes") and the watercolour knowledge
  field, which already models the three knowledge tiers as PRESENTATION.
  Expected split, when it comes: `world.read` as editor/workbench (all)
  versus as player (what your knowledge field covers) — the filtering
  itself being per-player derivation work, not a permission check.
- **Quota** — server-storage.md places it with ownership; the registry
  gives it a subject, the artifact cap gives it a mechanism, but whose
  budget is whose is undecided.
- **Token refresh/revocation** (server-auth.md step 8) — adjacent, not
  part of this.
- **Service identities** (stated 2026-08-12): a world-less bake service
  (the "a target must run alone" rule) authenticates to the world service
  by minting tokens with the shared key — mechanically fine today, but once
  this ACL enforces, that machine identity needs DEFINED rights (read the
  world it bakes, nothing else) rather than riding on "any authenticated
  caller". Same family as the job-token narrowing, one level up.
