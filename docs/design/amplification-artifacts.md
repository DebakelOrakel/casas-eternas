---
summary: How the worldmap's amplification bake could stop costing seven minutes every load — tiling as the shared enabler, then caching (local first, server later), plus what could make the bake itself cheaper (basin decomposition, parallel workers, GPU). Analysis and options; the choices are not made.
date: 2026-08-07
status: design discussion — options and analysis, nothing decided
---

# Amplification artifacts: tiling, caching, and making the bake cheaper

The amplification bake ([worldmap-amplification.md](../decisions/worldmap-amplification.md))
works and is measured: **~102 s and ~0.2 GB at 4096×2048, ~444 s and
~3 GB at 8192×4096**. Both numbers hurt in their own way — the seven
minutes are a wait on every load, and three gigabytes of transient
arrays are enough that a browser tab may simply refuse the deepest tier.
This doc collects the options that came out of a design discussion about
that, so a later decision has something to stand on. Nothing here is
decided.

**Confirmed the same day:** the 8192 stage was tried in Safari and the
browser reloaded the page — the tab ran out of memory. So this is not a
"might not fit" risk any more; the memory work below is a
**prerequisite** for the decided 8k target, not an optimisation of it.
(The shipping default is now `AMPLIFY_STAGES = [2]`.) Note also that the
screen's degrade-to-last-good-result path does not help here: it catches
a dead worker, not a dead page.

Two separable problems, and it is worth not conflating them:

- **Peak memory during the bake** — the ~3 GB, which is what makes 8k
  unusable *today*.
- **Repeating the cost** — the minutes paid again on every load, which
  is what caching addresses.

## Tiling: which problem it actually solves

Tiling the *output* (holding only the tiles near the camera, streaming
the rest) addresses **resident** memory after the bake — the 134 MB
raster plus its derived surfaces — and it is what makes any cache
practical, since tiles are the natural unit to store and fetch. It does
**not** touch the bake's peak, which happens while erosion runs over the
whole grid.

Tiling the *erosion* is the harder question, because drainage is global:
a catchment can span the map, and priority-flood depression filling is
inherently non-local (a depression's spill point may be far away). Two
shapes:

- **Rectangular tiles with halos** — the GIS approach (TauDEM, GRASS do
  tiled flow routing this way). Needs overlapping borders and iterative
  edge reconciliation, because rivers run straight through tile walls.
- **Basin decomposition** — cut along **drainage divides**, which are
  natural seams: by definition no water crosses them. Compute the basin
  structure on the cheap macro raster (2048, already available), then
  erode each major catchment independently at fine resolution, with the
  outlet as its only boundary condition.

Basin decomposition looks like the better fit, with one honest caveat:
**divides migrate** during real erosion, and freezing them at the macro
positions is an approximation. It is a defensible one here — the fine
tier is explicitly "invented within the macro authority" (rule 4 of the
decision) and runs only a couple of rounds — but it should be stated
rather than discovered later.

## Making the bake itself cheaper

**Memory audit — done 2026-08-07, and the answer was sobering.** The
guess above ("avoidable copies, plausibly 30–40 %") was mostly wrong:
the pass is already careful — the deposition scratch arrays and thermal
erosion's `delta` are allocated per *call*, not per iteration, so there
is no hidden churn. What the audit found and fixed, both **bit-exact**
(verified cell-by-cell against the pre-change modules — a shared module
the generator depends on may get cheaper, not different):

- **MFD edge targets stored as a direction byte instead of a cell
  index.** An edge's target is always one of the eight neighbours, so
  three bits carry it; the cell index is recomputed on read. This was
  the single largest waste: at ~2.9 edges per cell, 97 MB of a routing's
  327 MB at 4096², four times that at 8192².
- **The filled surface adopted in place** instead of
  `elevations = routing.filled.slice()` on every network refresh, with
  enclosed-water depths stashed sparsely rather than via a second full
  raster.
- **The previous routing released before the next is built** — the flood
  allocates a complete network while the variable still holds the old
  one.

Result: **939 → 832 MB at 4096²** (−11 %), and **2646 MB at 8192²**
against the ~3 GB measured before. The rest is genuine live data,
roughly 70 bytes per cell across a dozen arrays that are all actually in
use at the same moment. The remaining candidates are worse trades: MFD
weights `Float32 → Uint16` would halve another ~11 bytes per cell but is
*not* bit-exact (it perturbs drainage accumulation), and `flowTarget` as
a direction byte would save 3 bytes per cell across 32 call sites in
five files, including the legacy sphere module.

**Conclusion: micro-optimisation does not get 8k into a browser tab.**
2.6 GB earns the same verdict 3 GB did — Safari reloaded the page at the
latter and there is no reason to think the former lands differently.
The next lever has to be structural, which is what the rest of this
section is about: the per-cell cost is close to irreducible, so what has
to shrink is the number of cells held at once.

**Basin decomposition → parallel workers.** The same cut that makes
tiling possible also makes parallelism possible: independent basins, one
worker each, each holding only its own working set. This attacks time
and peak memory *together* and keeps everything on the CPU, so
determinism is untouched. On a multicore machine 4–8× is realistic —
seven minutes becomes one or two. Note that priority flood, the piece
that is inherently sequential (a priority queue), stops being a global
bottleneck once it runs per basin.

**Ocean masking.** Roughly 60–70 % of cells are ocean and nothing
happens there except deposition near coasts. A compact land-only
indexing would cut time and memory by 2–3× — but `erosion.ts` is shared
with the generator, so this is surgery on the common heart, not an
entry point.

**GPU.** Stream-power and thermal erosion are textbook GPU workloads
(local neighbourhood stencils, ~100× potential); flow accumulation has a
known parallel formulation (pointer doubling); priority flood remains
the hard part. The project already has a WebGPU plan
([GPU_TECTONICS_PLAN.md](../../GPU_TECTONICS_PLAN.md), proposed) that
accepted the browser-support tradeoff, so that part is precedent rather
than new. Two caveats:

1. **Determinism across devices.** GPU reductions are not bit-identical
   across hardware. As long as the amplified field is pure presentation
   this costs nothing — but the decision doc's rule 4 promises that a
   server could reproduce the same pipeline if fine heights ever become
   official, and that promise breaks the moment the client computes them
   on the GPU. This needs deciding *before* any GPU code exists, not
   after.
2. **Availability** — the existing plan already notes Chrome/Edge and
   recent Safari, and no stable Firefox. (The project's own Firefox
   trouble turns out to be narrower than feared: the nested-worker
   regression is a **dev-server-only** problem, established 2026-08-07 —
   production builds run fine.)

Suggested order if this is picked up: memory audit → basin
decomposition with workers → tiling + cache → GPU last, and only after
the determinism question is answered.

## Caching: local vs. server

Both are caches over **deterministically recomputable** data, which is
what makes the whole topic low-risk: eviction, corruption, or a missing
entry all have the same consequence — bake again. No migrations, no
backups, no consistency story.

### Local (IndexedDB or OPFS)

Browser-native, on disk, survives reloads and restarts, stores binary
natively (a `Float32Array` goes in and comes back out as one). **OPFS**
is the more modern option — file-like, faster for large blobs, usable
synchronously inside a worker; **IndexedDB** is the conservative,
broadly documented one. Both share the same three caveats:

- **Storage is scoped to the ORIGIN, port included.** Relevant here:
  the client has no `vite.config.*`, so the dev server takes 5173 and
  *increments* when that port is busy — a different port is a different
  store, i.e. a silently empty cache. Pinning the dev port would be a
  prerequisite, and a cheap one.
- **Quota** is a share of free disk (generous in Chrome, more
  conservative in Safari); `navigator.storage.estimate()` reports it.
- **Eviction** happens under disk pressure, and Safari clears data for
  sites unvisited for about a week. `navigator.storage.persist()` can
  request an exemption (granted heuristically). Harmless here, per the
  recomputability above.

Solves: "not again on *this* machine, in *this* browser". Does not
solve: another device, another browser, handing a finished world to
someone else.

### Server-side artifact store

*Worked out further in [server-storage.md](./server-storage.md) —
including the world store beside it, the REST shape, the auth story and
who may write. The sketch below is what that doc grew out of.*

The Go server today is a Cobra skeleton (`start` prints "start called",
no routes, empty `internal/`), so this would be greenfield.

The idea fits the architecture better than it might look: the queryable
save ([queryable-world-save.md](../decisions/queryable-world-save.md))
already casts the server as *stores and answers, does not generate*, and
a tile cache is exactly that role. It also does **not** contradict the
amplification decision's "never serialized" rule — what that rejected
was baking the layer into every *save zip*; a separate artifact store is
a different thing. (Worth stating explicitly wherever this lands, so a
later reader doesn't read a contradiction.)

The design point that decides whether this ages well: build it as a
**content-addressed artifact store**, not as a "client upload cache".
The key is a hash of *world identity + every parameter + pipeline
version*. Then:

- today: the client bakes and `PUT`s tiles, other clients `GET` them;
- later: the Go server bakes them itself (it needs the same maths anyway
  for authoritative queries) and clients only `GET`;
- **the API shape does not change between those two worlds.**

Two things to get right:

- **The pipeline version belongs in the key.** A tuning change
  invalidates every artifact — the seed amplitude and round count were
  both retuned during the bake's own construction, and stale terrain
  served after such a change looks like a physics bug, not a cache bug.
- **Trust boundary.** Client-computed artifacts on a server intended to
  become authoritative are fine for solo and development, but for
  multiplayer the server must recompute or spot-check (determinism makes
  both possible). The cache must never become the only source of truth.

**Size** is comfortable if the artifacts reuse the save format's own
quantisation (`worldLayers.bakeLayer`/`decodeLayer`): u16 at the
elevation scale is ~0.14 m precision, halving 134 MB to ~67 MB per world
and per stage before compression — and terrain compresses well.

### Sequencing thought

The two are complementary, and the usual shape is two-tier: look
locally, then ask the server, otherwise bake (and fill both). If the
server is wanted anyway, starting locally still makes sense — same key,
same tiling, only a different store behind it. The substance is the
**tiling and the key**, and that work pays into both.

Independently of the cache, the storage *interface* the discussion
raised is worth its own consideration: if a server is configured (or
simply reachable at a known local address), the save/load dialog could
offer it as a location. That is small, immediately useful (no more
download/upload dance, worlds become shareable), and it is the frame the
artifact cache later slots into.

## Related

- [server-storage.md](./server-storage.md) — the server side of the
  caching option, worked out: world store vs. artifact store, protocol,
  auth, and who may write.
- [worldmap-amplification.md](../decisions/worldmap-amplification.md) —
  the bake this is about, with the measured costs.
- [resolution-strategy.md](./resolution-strategy.md) — why the macro
  grid stays the authority and the fine tier is derived.
- [queryable-world-save.md](../decisions/queryable-world-save.md) — the
  server's "store and answer, don't generate" role.
- [hex-world-view.md](./hex-world-view.md) — what the amplified terrain
  is ultimately for.
