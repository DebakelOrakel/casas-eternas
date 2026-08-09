---
summary: How the Go server could store things for the client — a WORLD store (named, mutable, owned) next to an ARTIFACT store (content-addressed, immutable, shared) for derived data like the amplification tiles, over plain REST, with an identity concept from day one so SSO is later a config change rather than a rewrite.
date: 2026-08-07
status: design discussion — superseded in part by decisions/server-storage.md (2026-08-07), which decides the identity, configuration, storage-backend and UI forks this doc left open. The rest stands as the longer argument.
---

# Server storage: worlds, artifacts, and who may write them

Two threads met and produced this: the amplification bake costs minutes
per load and wants a cache
([amplification-artifacts.md](./amplification-artifacts.md)), and the
save/load dialog could offer a reachable server as a location instead of
the download/upload dance. The server today is a Cobra skeleton (`start`
prints "start called", no routes, empty `internal/`), so this is
greenfield.

Nothing here is decided. It is written down so a later decision has
something to argue with.

> **That decision has since been made**, on 2026-08-07:
> [decisions/server-storage.md](../decisions/server-storage.md). It
> settles four forks left open below — the world store's key (a stable
> `uid` in `world.yaml`, not the recipe and not the content hash), how
> the client is told where the storage is (a `/config.json` from
> whoever serves the page, with a relative `apiBase`), the disk backend
> (files, confirming the "no database" line at the end of this doc), and
> the UI shape. It also corrects one idea that is *not* in this doc but
> came up on the way to it: letting the API simply be the page's own
> origin, which breaks as soon as serving and storage are separate
> components. Everything else here stands.

## The reframing: two stores, not two caches

The instinct when thinking about multiplayer is "a shared cache, and
maybe a per-player one too". The more useful cut is not shared vs.
per-player but **what kind of data it is**:

- **Artifacts** (amplification tiles, and anything else derived) are a
  *deterministic function of public inputs*. For a given world and
  parameter set every player gets bit-identical bytes. They are
  immutable, owned by nobody, and inherently shareable — there is no
  privacy dimension, because anyone holding the world could compute them
  themselves.
- **Worlds and saves** are mutable, belong to someone, and need access
  control.

So there is **no need for a per-player artifact cache**: the artifacts
are identical whoever asks. What exists per player is the *world* store
— and access control belongs to the **world**, which its artifacts
inherit. A private world's tiles are private because the world is, not
because the tiles are. That removes an entire axis of complexity.

The resulting tiering, with the world store deliberately *beside* it
rather than inside it:

```
Tier 0   client-local (OPFS / IndexedDB)   what I am looking at, works offline
Tier 1   server artifact store             shared, immutable, deduplicated
Tier 2   compute                           and fills both tiers above

(separate)  world store                    named, mutable, owned
```

## Content addressing, and what it buys

Key the artifact store on *world identity + parameters + pipeline
version* and several problems stop existing:

- **Deduplication** — two players, one world, one copy.
- **Integrity** — the key is the checksum.
- **Idempotence** — a repeated write is a no-op, so no coordination
  between clients racing to bake the same world.
- **No cache invalidation.** A new pipeline version produces new keys;
  the old entries simply become garbage for a size-capped sweep to
  collect. There is nothing to actively invalidate, which is the class
  of bug this avoids entirely.

## Protocol: plain REST over HTTP

Tiles are blobs and HTTP moves blobs. No custom framing, no WebSocket:
`net/http` on one side, `fetch` on the other, and range requests,
compression and later CDN-ability come for free.

```
GET   /v1/worlds/{worldId}/amp/{pipelineVersion}/{stage}/manifest.json
GET   /v1/worlds/{worldId}/amp/{pipelineVersion}/{stage}/tiles/{x}_{y}
PUT   …same paths…
POST  /v1/worlds/{worldId}/amp/{pipelineVersion}/{stage}/present
```

Four deliberate choices in that shape:

**The pipeline version sits in the PATH**, not only inside the manifest.
Versions then coexist for free and an obsolete tree is removable by
prefix. In the manifest alone, a client would have to fetch before
discovering the mismatch.

**Manifest first**, mirroring the save's own `manifest.json`: it
describes the tile grid, dtype and quantisation, and its mere existence
answers "has this been baked?" in one request.

**The `present` endpoint matters more than it looks.** At 8192² with
512-cell tiles there are 128 tiles; discovering which are missing must
not cost 128 `HEAD` requests. One POST with the wanted keys, one list
back, then fetch the gaps. This is the only real addition naive REST
needs here.

**Structured paths rather than one flat content hash**, because a
directory on disk stays inspectable and "drop everything for world X"
becomes `rm -rf`. Cross-world deduplication would buy nothing anyway —
two worlds share no byte-identical terrain tiles.

The world store is the same shape, one level up:

```
GET/PUT/DELETE  /v1/worlds/{worldId}      the .zip as it exists today
GET             /v1/worlds                the caller's list
```

## Authentication: identity from day one, checking later

The mistake would be to build with no notion of identity and retrofit
one. Instead: every request *may* carry `Authorization: Bearer <token>`,
and the server knows three modes. In the local mode a synthetic identity
("local") carries ownership and quota. Every code path then exists from
the start, and SSO later is a config value plus a token validator rather
than a refactor.

**The modes hardened into a decision 2026-08-09 —
[server-auth.md](../decisions/server-auth.md).** `token` became `password`
(the axis is where the users live, not what the header looks like), the
credentials are an htpasswd file mounted from a Secret, and logging in
exchanges them for a JWT the server issues itself — including under `oidc`,
which is a second login method rather than a second token.

## Who may write

Client-computed artifacts under a shared key are a poisoning vector: one
tampered client uploads nonsense terrain and everyone else downloads it.
Three stages, in the order they would arrive:

1. **Local, now** — anyone may write; it does not matter.
2. **Multiplayer v1** — only a world's owner may write its artifacts.
3. **Endgame** — writing is off entirely and the **server computes**.
   That is what the determinism rule in
   [worldmap-amplification.md](../decisions/worldmap-amplification.md)
   is ultimately for, and the read API does not change on the way there.

What matters is only that "writing off" stays a config switch rather
than a redesign.

## Two details that are easy to get wrong

**The version key must cover everything.** A hand-maintained number gets
forgotten — the seed amplitude and the erosion round budget were both
retuned during the bake's own construction, and either would have
invalidated every artifact. A composite key avoids relying on
discipline: a **manual algorithm version** (for the procedure itself,
which cannot be detected automatically) plus a **hash over the
constants** that feed the bake (erosion parameters, cascade table, round
budget), computed at runtime. Value changes then invalidate themselves;
only genuine algorithm changes need a human to remember.

**Store tiles pre-compressed** rather than compressing per response —
terrain compresses well and the CPU cost should be paid once. Together
with the save format's own u16 quantisation
(`worldLayers.bakeLayer`/`decodeLayer`, ~0.14 m at the elevation scale)
that puts a world at roughly 30–40 MB per stage instead of 134.

Storage on disk needs no database to start with: content-addressed
directories and files, with a small index alongside only if per-user
quota or LRU eviction later needs querying. Eviction can be crude
(size cap, drop least-recently-read) precisely because everything is
recomputable.

## Speculation: who computes, and where the code comes from

Adjacent discussion, recorded because the arguments are worth keeping
even though nothing is decided. The starting point: if a worker (a pod,
say) can run the amplification bake, then **both** of the bake's
problems disappear at once — three gigabytes and seven minutes are
unremarkable on a cluster node, and the browser's memory ceiling stops
being the thing that gates 8k.

That does not contradict "the server generates nothing". Generating a
*world* is a creative, human-driven, once-per-world act. *Deriving
presentation detail from a finished world* is mechanical, deterministic
and repeatable — the same family as the queryable save's "answer spatial
queries", only with an expensive answer.

### The scope is a leaf, not the engine

A worry worth defusing: this would not mean porting the generator. The
bake needs four modules, all of them pure functions over typed arrays:

| module | lines | imports | async |
|---|---|---|---|
| `erosion` | 915 | 4 | 11 |
| `flowRouting` | 438 | 1 | 4 |
| `hydrology` | 491 | 5 | 0 |
| `amplify` | 180 | 4 | 0 |

Tectonics, the Archean, rendering and the screens stay TypeScript
forever and would not be touched.

### Determinism is nearly free here

Cross-language ports usually founder on floating point: `pow`, `sin`,
`exp` and `hypot` have no exactly-specified results, so two languages
drift. This pipeline barely uses them. `flowRouting` has no
transcendental call at all (`max`, `floor`, the `SQRT2` constant);
`ridgedNoise` likewise (`floor`, `imul`, `abs`); the hot erosion loops
use `sqrt`, which IEEE 754 *does* specify exactly. The two `Math.pow`
calls inside the stream-power loop are not even reached at the default
exponents — `useSqrtForArea` (m = 0.5) and `slopeExponentIsOne` (n = 1)
route around them. Two `pow` calls remain in the whole pipeline, both
outside hot loops, both trivially replaceable. So the thing that
normally kills such a port is close to a non-issue.

### Shipping the code to the worker

The appealing idea: the client sends the module to the worker, so the
worker holds no copy of the pipeline and version drift becomes
structurally impossible. Two corrections to how that gets framed:

- **JavaScript ships just as easily as WASM.** A Node worker can accept
  a bundle over HTTP and `import()` it; that is no harder than
  transferring a WASM module. Sendability is not what distinguishes
  them.
- **The distinguishing property is SANDBOXING.** Executing shipped JS is
  arbitrary code execution on the server, with filesystem and network.
  Fine while every client is your own build behind your own auth; a
  non-starter the moment a client might not be. WASM is confined by
  construction — memory in, memory out. So WASM is chosen for the trust
  boundary, not for convenience.

And the simplest answer removes the question: **build the worker from
the same repo.** Same commit, same behaviour; drift becomes a deploy
concern, and the pipeline-version hash above catches a mismatch anyway.
Shipping code only pays once workers must serve *heterogeneous client
versions* simultaneously — which self-hosted deployment does not do,
because both roll out together.

### If WASM ever does become the answer

For this code **AssemblyScript** (TypeScript syntax → WASM) would be
closer to a translation than a rewrite: the types and typed arrays are
already there. The one real obstacle is the 15 `async`/`await` sites —
all of them `maybeYield`, cooperative yielding to the browser's UI
thread. A worker may block, so they would simply go.

### The cheap insurance

Whatever is chosen later, one discipline keeps the option open at no
cost today: **those four modules stay free of DOM, Babylon and browser
APIs.** They already are; making it a stated rule is what keeps a future
WASM core a port rather than an excavation.

Recommendation, for whenever this is picked up: a **Node worker built
from the repo** — no code shipping, no rewrite. Revisit only when
untrusted clients or version heterogeneity actually appear. And one
constraint to hold onto: the client must keep its own ability to bake,
so a server stays an *accelerator* rather than a requirement.

## Sequencing

**The world store first, the artifact cache after.** The world store is
small, immediately useful (no more download/upload dance, worlds become
shareable), and it is what establishes identity, configuration and the
client-side plumbing — after which the artifact store is the same
mechanism with different content.

The artifact cache also has a prerequisite that does not exist yet:
**tiling in the client**. That is the same work the memory problem needs
(see [amplification-artifacts.md](./amplification-artifacts.md) — basin
decomposition and streaming tiles), so the two efforts meet there rather
than competing.

## Related

- [amplification-artifacts.md](./amplification-artifacts.md) — what
  would be cached, why it is expensive, and the local-cache option.
- [worldmap-amplification.md](../decisions/worldmap-amplification.md) —
  the determinism rule the whole "server may recompute" story rests on.
- [queryable-world-save.md](../decisions/queryable-world-save.md) — the
  server's "store and answer, don't generate" role, which this extends.
- [world-save-format.md](./world-save-format.md) — the `.zip` the world
  store would hold.
