---
summary: How local users are administered once an admin surface exists. htpasswd retires — credentials and the user registry merge into one bbolt database (auth.db) owned by the auth module, administered through the module's own admin endpoints. Locally those endpoints are served over a unix socket (HTTP over UDS) where possession of the socket IS the authorization, and `casas-eternas auth user add|list|delete|passwd` is a thin CLI client over it. Bootstrap and emergency access are the same mechanism — the socket against an empty or locked-out database. No config bootstrap, no writing Secrets through the Kubernetes API.
date: 2026-08-13
updated: 2026-08-13
area: platform
stage: built
status: decided, sequenced and ALL SIX steps built 2026-08-13 (end-to-end smoke against the real binary passed). Step 6 landed as a HARD BREAK, decided the same day in a second discussion — the sequenced htpasswd transition was built and then removed before ever running in production; see the step for why. Same-day addendum BUILT: the admin role moved into auth.db as well (`auth role bind|list`, global.auth.admins removed) — see the addendum section. Supersedes the credential half of server-auth.md (htpasswd in the Secret, and the recorded "admin screen writes the Secret through the k8s API" consequence) and revises server-users.md (registry merges into auth.db; local users become admin-provisioned, minting-at-first-login stays for OIDC). All surface names (`-t auth`, /v1/auth/session, global.admin.socket, the CLI verbs) approved.
---

# Local user administration: auth.db behind an admin socket

## The problem

Local users live in an htpasswd file, and every path to *administering* them
is bad. The file is operator-editable — that was its point — but Kubernetes
mounts it read-only from a Secret, so the planned admin screen cannot write
it. [server-auth.md](./server-auth.md) recorded the consequence honestly at
decision time: the screen "would write the Secret through the Kubernetes API
instead". Paying that consequence now would mean giving the pod RBAC write
access to the very Secret that holds its credentials, fighting GitOps (the
next `oc apply` silently reverts whatever the screen wrote), teaching the
server which platform it runs on, and maintaining a *different* write path on
a plain server (edit the file) than on the cluster (write the Secret).

A "configstore interface that does the right thing per platform" was
considered and is the wrong abstraction: it papers over a distinction instead
of honouring it. **The moment the server writes something at runtime, that
thing is not configuration any more — it is state.** Config flows operator →
process, one way, and this repo already has an answer for state: module
storage, one process per store directory, atomic writes.

## The decision, in three parts

### 1. Credentials become auth-module state, in bbolt

One database file, `auth.db`, under `auth.storage`, owned by the auth module
(today: session). Library: `go.etcd.io/bbolt` — the maintained fork of
BoltDB (the original was frozen by its author in 2017 and is archived;
etcd's fork is API-compatible and is what everything current uses). bbolt is
a memory-mapped B+tree: read transactions run in parallel and cost about as
much as memory access, writes serialize onto a single writer with an fsync
per commit. Read-optimised is exactly the right side of the trade for an
auth workload — a read per login, a write per admin operation.

Buckets: `users` (the registry that is users.json today) and `credentials`
(name → bcrypt hash, replacing htpasswd's lines). Creating a user mints
identity and credential **in one transaction** — the operation the two-file
world could not have. Every hash is minted in the store at one cost (12, two
above Go's default; server-auth.md's cost FLOOR retired with the import —
no external hash ever enters, so there is nobody a floor would speak to),
and the absent-user timing defence stays.

The file lock is a feature, not a limitation: bbolt takes an exclusive flock
on open, so "one process per store directory" stops being review discipline
and becomes something the kernel enforces.

### 2. The admin channel: the module's own endpoints, additionally on a unix socket

Admin operations are normal handlers of the auth module, registered under its
namespace — but on a **second listener**: a unix domain socket (plain HTTP
over UDS, no new protocol). The TCP listener does not carry them at all
until the admin panels ([frontend-surfaces.md](../design/frontend-surfaces.md))
arrive, at which point the same handlers appear there token-gated behind the
`adm` claim.

Possession of the socket IS the authorization — the Docker-daemon /
Postgres-peer-auth model. On Kubernetes, `pods/exec` RBAC gates who reaches
it (and exec sessions are auditable at the API server); on a plain machine,
file permissions on the socket do. "Whoever may reach the machine may
administer it" — the same trust htpasswd always implied, now stated.

This one mechanism answers three questions that would otherwise each need
their own:

- **Bootstrap**: empty `users` bucket → exec in, create the first admin. No
  chicken-and-egg, because the socket needs no login.
- **Emergency**: every admin locked out → the socket still answers.
- **Day-to-day**: a cheap admin screen until the panels exist, and a runbook
  tool after.

### 3. The CLI: `casas-eternas auth user add|list|delete|passwd`

A thin client that dials the socket — cobra stays in `cmd/`, logic stays in
the module, exactly the existing composition split. The grammar is
`<module> <resource> <verb>`, and that is the real argument for it: it makes
the CLI the fourth surface of the one-vocabulary rule. `auth` is already the
config section, the flag prefix, the env prefix and (on the target's arrival)
the route namespace; a flat `user add` would open a second grammar that
breaks the first time another module wants an admin verb. Later admin
surfaces (`world …`, `artifacts …`) ride the same socket under their own
namespaces — the socket is process-level, like the HTTP listener, and
resident modules contribute handlers to it.

Exec'd in the wrong pod of a split deployment, the socket answers with which
targets are resident — the same failure mode as any target that is not
running here. No routing, no discovery.

## Rejected alternatives

- **Keep htpasswd; admin screen writes the Secret through the k8s API** —
  the recorded plan, rejected for the reasons in "The problem". It was also
  the one row of the deployment map whose write path differed between plain
  and Kubernetes; `auth.db` on a volume behaves identically on both.
- **Config bootstrap (the Grafana model)** — a `auth.bootstrap.*` credential
  applied when the database is empty. Its only exclusive value is zero-touch
  provisioning (`helm install` and never exec), which this deployment does
  not need; the price is a second credential mechanism kept alive and a
  first-start-only special semantic in the config. If zero-touch is ever
  wanted, an **initContainer in the auth pod** may write the pre-start
  database directly — the one place a direct-DB write path is legitimate,
  because the pod lifecycle guarantees the server is not running yet. (A
  setup Job cannot reach the socket — it is pod-local filesystem — and would
  have to `kubectl exec` with RBAC and kubectl in its image. Deferred until
  actually wanted.)
- **CLI opens auth.db directly** — bbolt's flock forbids it while the server
  runs (even read-only opens take a shared lock, which the server's exclusive
  lock blocks). What remains is an offline tool, and on Kubernetes "stop the
  server first" deletes the very container one would exec into. Two write
  paths onto one database is also exactly what the store rule exists to
  prevent.

## A recorded rejection, reversed knowingly

[server-users.md](./server-users.md) rejected **pre-provisioning** — "two
files to keep in step, and the registry would start deciding who may log in,
which is htpasswd's job". Both reasons dissolve here: there is no second
file (one database, one transaction), and deciding who may log in *is* the
auth module's job once it owns the credentials. So local users become
admin-provisioned. **Minting-at-first-login remains the model for OIDC**,
where the users genuinely live elsewhere and the registry genuinely follows.

## What retired, what renamed

- The htpasswd file, `global.auth.htpasswd`, and the `htpasswd` key of the
  `casas-eternas-auth` Secret — all gone. The **session key stays in the
  Secret** — it is shared, operator-owned, read-once; nothing about it
  changed.
- `users.json` — merged into `auth.db` (its refuse-to-open-when-corrupt rule
  carries over; ids must never be re-minted). The founding import for a
  users.json left by an older server REMAINS in the code: it costs no
  operator step and protects the ids that owners and grants reference.
- The session module became the **auth module** with the target cut
  ([access-control.md](../design/access-control.md)) — the CLI group, config
  section and storage key already said `auth`, and the one-vocabulary rule
  that carries this decision would tear if the module kept a different name.

## Surface

- Subcommand group `auth user` with `add`, `list`, `delete`, `passwd`, plus
  `--password-stdin` on the two that take one.
- The socket path key `global.admin.socket` — process-level, since any
  resident module may contribute admin handlers; empty means "no admin
  socket". All approved 2026-08-13.

## Sequencing (planned 2026-08-13)

Six steps. Each ends green on `make lint` and `go test ./...`, lands alone,
and leaves every deployment shape working; `none` mode is untouched
throughout. The client is untouched until the panels (frontend-surfaces) —
this is Go and deploy work only. Surface approvals are embedded where they
block, marked ⚠; all three were approved 2026-08-13, and steps 1–5 were
built the same day. One mechanical consequence the plan had not named: the
module package `auth` collides with the LEAF `internal/auth`, and an import
alias would hide the name from grep — so the leaf renamed to
`internal/token`, which after step 6 is all it holds anyway.

**1. The store.** `go.etcd.io/bbolt` becomes a dependency (always bbolt,
never the archived `boltdb/bolt`). `internal/user.Registry` grows into the
DB-backed store: `auth.db` under `auth.storage`, buckets `users` and
`credentials`; the API gains `Verify`, `SetPassword`, `Delete`, `List`, and
create-user becomes one transaction. The bcrypt rules move over from
`internal/auth` (cost floor 10, recommended 12, strict validation, the
absent-user timing defence — the measuring test comes along).
`internal/auth` keeps tokens only. Founding import: a missing `auth.db`
beside an existing `users.json` imports it — ids preserved verbatim, the
JSON left renamed (`users.json.imported`) so a rollback has its data and a
re-import cannot double-mint. Proposed seam, to confirm at review: the store
stays in `internal/user` (it is the "who exists" leaf, now also "how they
prove it"); if that reads wrong in code, the fallback is a fresh leaf both
`auth` and `session` consume. ~300–400 lines plus tests.

**2. Session verifies against the store.** `buildAuth` opens the store in
password mode; the login handler answers validity and identity in one
lookup. (As planned, this step also carried an htpasswd founding import as
the migration path; step 6's hard break removed it again the same day —
recorded there, since a reversal only the winner survives is the kind this
repo writes down.)

**3. The auth module and target.** ⚠ approvals: `-t auth` joining the
target list, and the login route moving `/v1/session` → `/v1/auth/session`
(safe for the client — it discovers the path via `config.json`'s
`login.path`, never derives it; the exempt list and `session.Path` renames
follow). The session module renames to `internal/modules/auth`; `buildAuth`
becomes target-bound: only the process running the auth target opens the
store and serves login, every process keeps resolver + key, `all` includes
`auth`. This ends the buildAuth-per-process finding
([server-deployment.md](../design/server-deployment.md)) and makes password
mode splittable at all.

**4. The admin socket.** ⚠ approval: the config key (proposal
`global.admin.socket`, empty = no socket). `internal/server` gains an
optional second listener — same mux composition, unix domain socket, plain
HTTP — that carries admin-only handlers modules register beside their
public ones. The auth module registers user CRUD under its namespace; an
unknown namespace answers with the resident targets (the wrong-pod
message). Socket file mode 0600, replaced atomically at bind. Tests run
httptest over UDS. ~150–200 lines.

**5. The CLI.** `casas-eternas auth user add|list|delete|passwd` in `cmd/`
(verbs approved 2026-08-13) — thin clients over HTTP-on-UDS via a custom
dialer. Passwords are prompted or read from `--password-stdin`, never argv
(`ps` leaks). Server errors pass through verbatim; the wrong-pod answer
from step 4 is the UX for a mis-aimed exec. ~200 lines.

**6. Retirement — BUILT, as a HARD BREAK.** As planned, this step was gated
on a two-phase deployment dance: run the new binary once so the founding
import moves the deployed htpasswd's credentials into auth.db, drop the
key everywhere, only then delete (the loader's `ErrorUnused` makes a
leftover key a start error). Decided 2026-08-13, second discussion: with
exactly ONE deployment and no release audience, transition machinery
served nobody — so the htpasswd import, `internal/token/htpasswd.go` with
its tests, the `global.auth.htpasswd` key, the Secret's htpasswd half and
the manifests' lines went in one move, and the bcrypt cost floor went with
them (no external hash ever enters the store, so there is nobody a floor
would speak to; everything is minted at one private cost). What the break
costs, once, on one deployment: identities survive through the users.json
import — ids preserved, owners and grants keep resolving — and each
account gets its password back with `auth user passwd <name>`, which is
exactly why SetPassword and Create are separate operations. A stranger
arriving with an htpasswd someday re-types passwords the same way.

**Out of scope, stated:** the panels-based admin UI (frontend-surfaces),
revocation (`notBefore` — server-auth.md step 8, which now has its bucket
waiting), OIDC, and any grants/ACL work (access-control step 5 is a
separate track). `global.auth.admins` stays config — policy an operator
writes, unchanged by any of this.

## Addendum (2026-08-13): the admin role moves in too

`global.auth.admins` — the last user-shaped thing living in the config — is
gone; the global role is a FIELD on the user record in auth.db, bound over
the admin surface. This knowingly reverses server-users.md's reasoning
("policy an operator writes, not state a process keeps"), and the ground
shifted underneath it the moment the socket landed: back then the config
was the only place an operator *could* write — now the admin channel is
exactly that place, with the same authorization (possession). What the move
buys, concretely: the role attaches to the ID rather than a login name (a
rename keeps it, and a future OIDC login coupled through `oidcSubject`
inherits it), role changes need no config rollout, and one of
access-control.md's three split wrinkles — the name→id resolution of
`--admins` needing the registry — dissolves, because the login process now
owns both.

Unchanged on purpose: the claim mechanics. The decision still travels in
the token, minted at login, stale until the next one (TTL-bounded) — only
its birthplace moved. And still no first-user magic: the first admin is
`auth role bind <name> admin` over the socket, said out loud.

Surface (approved 2026-08-13, replacing an earlier `promote/demote`
sketch): `role` is its own RESOURCE beside `user` —

- `auth role bind <name> <user|admin>` — name first, like every other
  command here; bind REPLACES, since a user holds exactly one global role
  (a field, not a set), and binding `user` is the way back to the default.
- `auth role list` — the bindings that deviate from the default; a
  client-side projection of the user listing, no second endpoint.
- The API route stays `PUT /v1/auth/users/{name}/role`: the CLI groups by
  task, the API by record, and the record is the user's.

The vocabulary is closed (`user`, `admin`); the default is stored as the
empty string, so every record from before roles existed means what it
always did. Per-world levels (viewer/editor/owner) are grants on the world
and deliberately never called roles here. Removing the config key is the
same ErrorUnused hard break as the rest — painless, since no deployment
ever set it.

## Fallout elsewhere

- The deployment map lives in
  [design/server-deployment.md](../design/server-deployment.md); net change
  there: the htpasswd Secret row is gone, `auth.db` joined the auth
  volume, and every remaining row behaves identically on plain and cluster.
- Revocation (server-auth.md's unbuilt step 8, the per-user `notBefore`
  stamp) gains its natural home: a value beside the credentials, one more
  bucket entry. Still unscheduled.
- The grants API (access-control.md step 5) is untouched — grants live with
  worlds, deliberately, and nothing here moves them.
