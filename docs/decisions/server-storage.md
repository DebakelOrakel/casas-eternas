---
summary: The server keeps two stores with two different keys — a WORLD store keyed on a stable `metadata.uid` in world.yaml, and an ARTIFACT store keyed on the content hash of the terrain, so re-eroding a world correctly invalidates its derived data without making it a different world. The client learns where the storage is from a `/config.json` served by whoever serves the page (relative `apiBase` by default, so CORS never arises) and what it can do from the API itself. One binary with a single `start` subcommand runs whichever modules `--target` names — client, world, artifacts, where singular means a subsystem with behaviour and plural a collection without any — so local play and a split deployment are the same program. Storage on disk is files, not a database. One window with two tabs, deliberately unequal delete affordances. World store first, artifact store after.
date: 2026-08-07
status: decided — architecture and the forks below. BUILT 2026-08-08: the CLI surface and module skeleton, world.yaml's metadata.uid, the WORLD STORE (revisions, optimistic locking, preview extraction), the client's load/save/storage panels, and the ARTIFACT STORE (get/put/present/list/delete). Not built: the client talking to the artifact store, eviction, and the client-serving flags.
---

# Server storage: two identities, two stores, one config file

The [design discussion](../design/server-storage.md) proposed the shape:
an artifact store next to a world store, plain REST, identity from day
one. It stands, and stays as the longer argument. This doc records what
was actually *decided* on top of it, which is mostly the parts that
discussion left open — and one thing it got wrong.

## 1. Two identities, not one

The problem arrived as a worry: *if the world store is keyed on the
world, and eroding a world once more changes it, does the key break?*

It does not, because two different questions were being asked of one
key. Splitting them dissolves the conflict:

| | identifies | keys | on another erosion pass |
|---|---|---|---|
| `metadata.uid` — stable, in `world.yaml` | *the world as a thing you own and name* | the **world store** | unchanged |
| `worldId` — hash of the bake's inputs | *this exact terrain* | the **artifact store** | **changes, by design** |

Erode again and the artifacts re-bake (they must — they describe terrain
that no longer exists) while the world stays the same world, with the
same name and history, one entry on the server gaining a revision.

The content hash cannot serve as the world's identity, and the recipe
cannot either — that was already established when the local cache was
built: two worlds can carry an identical `spec` (same seed, same
sliders, tectonics stopped at epoch 40 versus epoch 90) and be entirely
different planets. Keying a world store on the recipe would alias them.

### What changes in `world.yaml`

It remains the recipe: human-readable, and the only home the panel
settings have. `state.json` is **not** touched — it is the snapshot, and
the existing rule holds that `status` carries only what the snapshot
does not.

- `metadata.name` becomes a real, editable display name. Today it is the
  seed input, which is why every cached world showed the same label
  until that bug was found.
- `metadata.uid` is added: generated once at first save, never changed.
  A UUID rather than the name, because names collide and get renamed —
  identity and label are different jobs.
- `status` gains a revision counter, which the server's optimistic lock
  compares so two machines editing one world collide loudly instead of
  one silently overwriting the other.
- `status` does **not** gain the terrain's content id, though the plan
  first said it would. It would have let a listing say "the server holds
  different terrain" without downloading eight megabytes — but
  `deriveWorldId` hashes the DEQUANTISED precipitation layer, and the
  generator holds raw floats, so a value written at save time would
  differ from the one every reader computes. A hash that is subtly wrong
  is worse than an absent one; readers derive it from the save, as
  WorldMapScreen already does.

**Legacy saves** — written before `uid` existed — derive one, once, from
the elevation raster they carry, shaped as a version-8 UUID so a uid is
one format everywhere. This does not contradict the rule above: the
content does not *become* the identity, it only *seeds* it, and further
erosion never moves it afterwards. Rolling a random id instead would
silently turn the same pre-uid file opened on two machines into two
worlds, with nothing left to merge them by.

## 2. Configuration: a file from whoever serves the page

The tempting simplification — *let the API just be the page's own
origin, then there is nothing to configure* — is wrong, and it is worth
recording why, because it is attractive right up until it fails. The
process serving the client is not necessarily the process holding the
storage: a local instance may well be one binary doing both, but a
deployment can have a static frontend, a storage service and later bake
workers as separate components.

What survives is the weaker claim: **whoever serves the page knows where
the storage is.** So the client fetches `/config.json` once at boot,
`Cache-Control: no-cache`.

Chosen over injecting `window.__CASAS__` into `index.html`, which would
save the round trip: templating requires the Go binary to be the thing
serving the page, and the deployment is OpenShift with nginx. As a file
the same mechanism works everywhere — the Go server renders it from its
own Viper config, or a ConfigMap is mounted over it and nobody templates
anything.

**Where and what come from different places.** The serving side knows
the address; only the storage service knows its own abilities.

- `config.json` → `apiBase`, `authMode` (`none` / `token` / `oidc` plus
  issuer). Static, set by the operator.
- `GET /v1/capabilities` → whether this server can bake, which pipeline
  versions it knows, what quota applies. Once bake workers exist, this
  is the difference between "remember to update the ConfigMap" and "the
  client notices by itself".

**`apiBase` is relative by default — `/v1`.** Then everything is
same-origin and CORS does not exist, locally or in the cluster, where
`/v1` is routed to the storage service through the same Route. It only
becomes absolute when the storage genuinely *should* be a foreign
origin, and then CORS is a deliberate configured choice rather than
something discovered while debugging a first deployment.

**No probing.** Not "try localhost:8080 and fall back": an absent
`config.json` is an unambiguous statement, a failed connection only an
indication, and probing adds a failure mode (a stale or foreign service
on that port) for nothing.

**No server is a first-class state**, not an error. Development on
worldgen must not require a backend; the client stays on OPFS exactly as
it does today. This is also the constraint from the design doc's own
recommendation: the client keeps its ability to bake, so a server is an
accelerator and never a requirement.

### `npm run dev` is unchanged

Vite proxies `/v1` (and `/config.json`) to `CASAS_API` or
`localhost:8080`, so development runs the same code path as production
rather than a special case. With a Go server running, the dev client
picks up its real configuration; without one it falls into the
server-less mode above.

### One binary, one `start`, `--target` per module

There is **one subcommand, `start`**, and `--target` names which
*modules* it runs. That is what makes the multi-component deployment and
the single-process local instance the same program rather than two:

```
casas-eternas start --target all                      # local play: every module
casas-eternas start -t world -t artifacts             # cluster: storage only, no client
casas-eternas start -t client                         # frontend only, storage lives elsewhere
```

**Selection and configuration are separate flags.** `--target` picks the
modules; `--dir-worlds` and `--dir-artifacts` say where each keeps its files,
independently, with defaults.

This is deliberately *not* the tempting alternative of making a path
flag's presence its own enable switch (`--dir-worlds ./saves` meaning
"and therefore run the world module"). That was proposed here first and
is wrong for two reasons that only show up on contact:

- **It forbids default paths.** A flag with a default is always
  "present", so the enable signal would have to come from Cobra's
  `Changed` — a flag that behaves differently depending on whether you
  happened to type its default value is a trap, not a convenience.
- **Not every module owns a directory.** A bake worker has no store; a
  module without a path would need an artificial boolean, and then two
  mechanisms exist for one question. `--target` scales to any module
  uniformly.

**Worlds and artifacts stay separate modules**, not one "storage". They
differ in every property that matters — mutable versus immutable, owned
versus ownerless, irreplaceable versus recomputable — and a deployment
will eventually want to scale or back them up differently.

**An empty `--target` is an error**, not an implicit `all`, and so is an
unknown one:

```
$ casas-eternas start
Error: no target selected; valid targets: all, client, world, artifacts
```

With `all` available as a one-word shorthand, starting nothing is far
more likely to be a typo than an intention — and a mistyped target that
silently started no modules would look exactly like a healthy server.

### Which flags sit where

Transport belongs to the **process**, so it is persistent on the root
command: whichever modules run, they share one listener and one TLS
identity. Storage paths belong to **one module**, so they sit on the
subcommand that starts it.

| flag | on | default |
|---|---|---|
| `--listen` | root, persistent | `:8080` |
| `--tls-cert`, `--tls-key` | root, persistent | empty (HTTP) |
| `--tls-ca` | root, persistent | empty; setting it turns on **mutual** TLS |
| `--target` / `-t` | `start` | none — required |
| `--dir-worlds`, `--dir-artifacts` | `start` | `./worlds`, `./artifacts` |

Both `--dir-*` flags are named for what the directory HOLDS, not for the
module that reads it — the same rule as the module names themselves.
That matters most for `world`, which is a subsystem rather than a store
and will grow a tile database and a loop, each wanting a directory of
its own; `--dir-worlds` beside a future `--dir-tiles` stays unambiguous
where `--dir-world` would not. It also keeps disk and URL reading the
same way, `worlds/{uid}` under `/v1/worlds/{uid}`.

`./saves` was considered and rejected for the default: the directory is
a STRUCTURE (`{uid}/meta.json`, `{uid}/rev/{n}/world.zip`), not a folder
of files, and a name like "saves" invites dropping a downloaded
`alpha.zip` into it — which the server would never see, while looking
exactly as though it should.

`--listen` takes a full `host:port` rather than a bare port, because
`127.0.0.1:8080` is how a local instance stays off the network — a port
alone cannot express that. `--tls-ca` is the authority that **client**
certificates are checked against, not the server's own chain, which is
why the `tls-` prefix is worth its length: a module that later speaks TLS
*to* another service will want its own `--client-cert`, and a bare
`--ca` would already have been ambiguous.

Every flag is bound through Viper with `SetEnvPrefix("CASAS")`, so the
same configuration works in a container without a command line:
`CASAS_TARGET`, `CASAS_DIR_WORLD`, `CASAS_LISTEN`. The prefix is not
cosmetic — unprefixed, these would have claimed `TARGET` and `DIR_WORLD`,
generic enough that a runtime or a sidecar collides with them eventually.

### Where the module boundary runs

**Only `cmd/` reads Viper.** It resolves flags into plain structs and
hands each module its own; nothing under `internal/` imports cobra or
viper. A module is therefore testable without a command line and never
knows what its flag is called, which is what makes renaming one a
one-file change.

```
cmd/              cobra + viper, the only place either appears
internal/config   resolved structs, target parsing, validation
internal/server   listener, TLS, mux, graceful shutdown
internal/client    /config.json (and later the static bundle)
internal/world     the world subsystem — saves now, tiles and loop later
internal/artifacts the artifact store
```

`internal/server` defines the `Module` interface it mounts, and the
modules do **not** import it: Go satisfies interfaces structurally, so
having the three methods is enough. The dependency runs one way — the
server knows about modules, the modules know about nothing — which is
what keeps them separable if one ever becomes its own process.

### Why `world` is singular and `artifacts` is plural

Not a slip. The two are different *kinds* of thing, and the names say so:
**singular means a subsystem with behaviour, plural means a collection
without any.**

`world` holds the saves today, and is expected to grow the tile database
and the world loop — so naming it for its first job (`worldstore`,
`worldstorage`) would be wrong within a year. `artifacts` is a bag of
derived files and will stay one, so it is named for what it holds. It is
deliberately not called `cache`: the *client's* OPFS copy is a cache, the
server's is the shared authoritative copy.

This is also where the two axes stop being the same axis:

- **Package layout follows the domain.** Saves, tiles and the loop share
  one world's state, so they belong in one `internal/world`.
- **`--target` follows the deployment unit.** A save endpoint is
  stateless and replicable; a world loop is stateful and exists once per
  world. A cluster will eventually want three of the first and one of the
  second.

Keeping those separable is what makes the split later cost nothing: if a
subsystem has to straddle processes it gains a **sub-target**
(`world-loop`) rather than a new name, and no package moves.

### A clarification the world loop forces

[queryable-world-save.md](./queryable-world-save.md) records that the
server *generates nothing* — "store and answer, don't generate". A world
loop generates, so the rule needs its scope stated or someone will later
read it as a prohibition.

It was about **world creation**: creative, human-driven, once per world,
and it stays in the client. **Simulating an existing world** is the same
category as the amplification bake — mechanical, deterministic,
repeatable over a finished world — which the amplification decision
already admits as a legitimate server job. The line is *creation versus
derivation*, not client versus server.

## 3. Files, not a database

Confirmed rather than newly decided, because the question came back:
neither BadgerDB nor BoltDB, and neither was ever recorded — the design
doc says content-addressed directories and files, with a small index
only if quota or eviction later needs querying.

That holds. Blobs belong in the filesystem: reading a 30 MB tile through
a key-value transaction gives up `sendfile`, HTTP range requests and the
`rm -rf worlds/X` that the structured path layout exists to permit. If
an index does become necessary, **bolt** — embedded, single file,
read-heavy, pure Go — and for metadata only. Badger is an LSM tree built
for write-heavy throughput, which this workload never is.

### On-disk layout

The client already has a path grammar
(`client/src/storage/ArtifactStore.ts`), and the server follows it —
below the root, not at it:

```
world/{uid}/meta.json               name, seed label, owner, current revision
world/{uid}/rev/{n}/world.zip       the save as it exists today
world/{uid}/rev/{n}/preview.png     EXTRACTED at upload
world/{uid}/rev/{n}/meta.json       contentHash, erosionRun, size, createdAt

artifacts/{worldId}/{pipelineVersion}/{stage}/…   the client's grammar verbatim
```

**The two roots must stay apart**, even though the client's local
artifact paths begin `worlds/`. There, `worldId` is a *content hash*;
here the world store's key is a *stable uid*. Sharing one prefix would
imply a relationship that does not exist — an artifact's `worldId` can
belong to a world that was never uploaded at all.

**`preview.png` is extracted at upload**, because it is what makes the
worlds tab worth having: unzipping thirty megabytes to show a hundred
kilobytes of thumbnail, per row, per listing, is not a thing to do.
`archive/zip` reads single entries without touching the rest.

**The server reads exactly two things out of a save**: `metadata` from
`world.yaml`, and `preview.png`. Everything else is opaque bytes. That is
the constraint that lets the save format keep evolving without the server
following along.

### The asymmetry that shapes the code

Everything below falls out of the two stores being different kinds of
data, which is the same reason they are separate modules and separate
tabs:

| | artifacts | world |
|---|---|---|
| concurrent writes | **idempotent** — same key, same bytes; last writer wins, no locking | **a real conflict** — needs `If-Match: {revision}` |
| durability | no `fsync`; losing one costs a re-bake | `fsync` before `rename`; losing one is a loss |
| eviction | a size cap applies **here** | **never** deleted automatically |
| ownership | none (inherited from the world) | `owner` in meta.json, from day one, "local" in `none` mode |

The optimistic lock on worlds is the one place convenience would be
expensive: without it, a user on two machines silently loses a save.

Two failure codes, not one — the plan first said 409 for both, which
conflates two different mistakes:

- **412 Precondition Failed** when `If-Match` names a revision that is
  not current. This is what RFC 9110 specifies for a failed `If-Match`,
  and it means "refetch and retry".
- **409 Conflict** when `If-Match` is absent (i.e. "create this") and the
  world already exists. Nothing was asked to be matched, so there is no
  precondition to have failed; the caller simply meant a different verb.

The revision doubles as the **ETag**, rather than a second token derived
beside it — two identifiers for one fact only ever drift apart.

**Writes are temp-file plus `rename`** (atomic within a filesystem), with
`meta.json` written **last** — the rule the client already follows, and
what keeps "meta present means entry complete" true, so an interrupted
upload reads as absent rather than as corrupt terrain.

### No index, with the trigger named

Listing walks `world/*/meta.json` — one level, microseconds at ten
worlds. An index (bolt, metadata only) is warranted when eviction needs
to sort by access time, or when a listing becomes measurable. Naming the
trigger matters more than staying under it.

## 4. One window, two tabs

The two stores have **opposite risk profiles**: artifacts are disposable
(worst case, a re-bake), worlds are irreplaceable (delete means loss).
A "delete everything" button beside worlds that cannot be recomputed is
the arrangement in which someone eventually loses a world.

So: one entry point, two tabs, with deliberately unequal destructive
affordances. The cache tab keeps deleting without confirmation; the
worlds tab confirms and offers no bulk delete at all.

The worlds tab carries what the cache tab has no equivalent for:

- the **`preview.png` the save already contains** — worlds become
  visually browsable, the single largest gain here;
- name, seed, saved-at, size, how far it was taken (epoch,
  `erosionRun`);
- **where it lives** — local only, server only, or both. Reconciling
  those is the tab's actual job.

## 5. Sequencing: world store first

Unchanged from the design doc, with a stronger reason than it had. The
world store is small, pays off immediately (no more download/upload
dance, worlds become shareable) and is what establishes identity,
configuration and the client-side plumbing — after which the artifact
store is the same mechanism with different content.

The artifact store's real prize is 8k, and 8k needs the server to
*compute*, not merely to store: the browser tab dies at roughly three
gigabytes, which no amount of storage fixes. That is a larger step, and
the design doc notes it has a prerequisite that does not exist yet —
client-side tiling, the same work the memory problem needs.

In order:

1. **`metadata.uid` in `world.yaml`** — pure client work, needs no
   server, and blocks everything after it: the world store has nothing
   to key on until a save carries an identity. **BUILT 2026-08-08**
   (`storage/artifactKey.ts` gained `newWorldUid`/`deriveWorldUid` beside
   `deriveWorldId`, so the two identities are read side by side; the
   generator mints on save, reads back on load, and clears only in
   `regenerate()` — running more tectonics or resetting erosion are the
   same world evolving). A real editable display NAME is deliberately
   split off: it needs UI and i18n keys, and the server does not wait on
   it.
2. **The world store**: PUT/GET/LIST/DELETE, preview extraction,
   revisions, the optimistic lock.
3. **The client's half**: save-to and load-from server behind the folder
   and floppy buttons that already exist, plus the worlds tab.
4. **Artifacts**: `HttpArtifactStore`, a `TieredArtifactStore`
   (local → server → compute), and `present`.

## Related

- [design/server-storage.md](../design/server-storage.md) — the longer
  architectural argument this decides on top of: the two-store framing,
  the REST shape including the `present` endpoint, the auth staging, and
  the speculation about a Node bake worker.
- [design/amplification-artifacts.md](../design/amplification-artifacts.md)
  — what would be cached and why it is expensive.
- [decisions/worldmap-amplification.md](./worldmap-amplification.md) —
  the determinism rule that lets a server recompute anything at all.
- [decisions/queryable-world-save.md](./queryable-world-save.md) — the
  "store and answer, do not generate" role this extends.
- [design/world-save-format.md](../design/world-save-format.md) — the
  `.zip` the world store holds.
