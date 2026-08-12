---
summary: How world generation fits into the client/server architecture — what runs where and why.
date: 2026-07-20
area: worldgen
stage: built
---

# World Generation — Design

This doc is about how the pieces fit together architecturally, as opposed
to the docs in [`docs/decisions/`](../decisions/), which record specific
forks with options and a chosen answer. Meant to grow with further design
notes over time, not just this one topic.

## Client/server split

World generation splits into two pieces with very different lifecycles,
and the architecture follows that split rather than a blanket
"client vs. server" line:

- **World creation — the multi-epoch tectonics simulation.** Runs exactly
  once per world, is the expensive/complex part (rift/merge thresholds,
  epoch stepping — see
  [plate-tectonics-simulation.md](../decisions/plate-tectonics-simulation.md)),
  and is where the "watch it happen, rerun, tune it" experience lives.
  A human always drives this — there's no requirement for headless or
  automated world creation. It lives entirely client-side
  (TypeScript/Babylon.js); there's no need for a Go implementation, since
  it never runs more than once per world and nothing else depends on
  re-running it.
- **Terrain field evaluation — answering "what's the elevation/
  traversability here?" for a query point, given the finished world.**
  Needs to run forever, on both sides, for the life of the world: the
  server needs it natively for pathfinding and every other height-aware
  game rule (the server is authoritative and needs to know all about the
  world, not just store an opaque blob the client uploaded), and the
  client needs it for rendering.

Geography is static once world creation stops — gameplay doesn't need
plates to keep drifting, so nothing at query time needs kinematics,
rotation math, or an ongoing simulation step. What gets uploaded to the
server at world-creation time is a *frozen snapshot*, not an opaque blob
and not an ongoing state to keep advancing:

- the final **plate list** (identity, position — Euler-pole axis/speed no
  longer matter once nothing moves; crust type is no longer a plate
  property, see the raft subsystem below);
- the **rafts** — continental crust as metaball blob sets (name + blob
  centers/radii), the source of truth for where land is;
- the coarse **ocean-age field** (a small raster) that drives oceanic
  depth via the age-depth √ law;
- the final **terrain-feature list** from A3's boundary-curve-local state
  (position, accumulated thickness, orientation, range vs. trench, and
  which plates each feature belongs to).

That's small enough to transfer outright, and cheap plain arithmetic to
query, no shader or texture lookup required. This is also why A3 (boundary-curve-local state)
matters architecturally beyond just realism: a full-surface raster (A1)
would fight this requirement no matter how fast it was to produce, since
the problem is storing/querying it everywhere it's needed — including a
server with no GPU — not how fast it was to compute in the first place.

Not part of that frozen snapshot: the first working implementation
(`client/src/worldgen/crust.ts`) also keeps a dense fixed sample grid
purely to *detect* new boundary activity while world creation is actively
running. That grid is scratch state for the world-creation phase only —
once creation stops, nothing downstream needs it, only the terrain
features it fed do.

Not yet decided: how the shared field-evaluation logic gets implemented
on both sides — reimplement the same (small, pure-function) evaluation in
both TypeScript and Go, easy to test for parity, vs. implement once in Go
and compile to WASM for the client to call into, removing any risk of
client/server disagreement about terrain at the cost of Go-WASM's
runtime/init overhead (worth a quick prototype before committing either
way).

## Continental crust: the raft subsystem

The tectonics simulation runs on **two decoupled layers**, which is worth
spelling out because "a plate is continental or oceanic" is the intuitive
model and the code deliberately does *not* work that way. Full rationale
and the phased build log are in
[continental-crust-rafts.md](../decisions/continental-crust-rafts.md);
this is the architectural shape.

- **Plates** (`plateSeeds`/`plateMotion`/`voronoiRaster`) are the purely
  *kinematic* layer — Voronoi seeds with Euler-pole motion, age, and
  boundary tectonics. A plate has no crust type of its own. Plate sizes
  are deliberately skewed (a few large, many small) rather than equal-area
  cells, matching real plate-size distribution.
- **Rafts** (`rafts.ts`) are continental crust: persistent sets of soft
  metaball **blobs** (center + radius) whose thresholded union is a
  continent's outline. Rafts *ride on* plates (each raft drifts with the
  plate under it) but are conserved independently — they never subduct.
  Over a run they **grow** at subduction arcs (accretion welds a margin
  blob onto the overriding continent), **merge** on collision (suturing),
  and **split** at a continental rift (breakup) — the supercontinent cycle.
  Land fraction is therefore *emergent and conserved*, not a fixed knob:
  it starts at the initial-land-fraction slider and evolves.
- **Oceanic crust** is simply everywhere no raft covers. Its depth comes
  from a coarse, full-surface **ocean-age field** (`oceanAge.ts`)
  advected with plate motion each epoch and reset to zero at divergent
  boundaries — a deliberately bounded exception to the "no full-surface
  accumulator" stance (it's a smooth, large-scale scalar, unlike an
  uplift raster).

The elevation baseline (`computeRaftBaseline` in `elevationField.ts`) is
then a pure per-point query over these: oceanic-with-age-depth by default,
lerped up to the continental baseline by raft membership, with the domain
warp ruffling coastlines. The A3 terrain-feature layer (capsule ridge and
trench chains) sits on top, unchanged by the raft model — it hangs off
boundary classification, not off any per-plate type.

There is one **remaining bridge**: boundary classification still reads a
*derived* per-plate type (`derivePlateTypes` — a plate counts as
continental if a raft covers its seed) rather than asking raft geometry
directly on each side of a boundary. It's a faithful stand-in in practice;
moving classification onto direct raft geometry is deferred.

## Why GPU availability doesn't change the elevation model choice

The client has GPU access (Babylon.js/WebGL), the server doesn't. Worth
noting explicitly that this didn't reopen the A3 decision:

- A3 was chosen for structural reasons, not compute-cost ones — A1's
  blob-vs-range problem is a modeling defect, not a performance one. A
  GPU makes A1 faster to compute, not correctly shaped.
- A3's compact representation is what makes it transferable to and
  queryable by a GPU-less server at all, independent of how it was
  produced.
- Where the GPU does genuinely help: sampling the finished A3 field at
  high resolution for rendering (turning the compact data into pixels),
  and giving a smooth live preview during world creation, since A3's
  evaluation is a stateless per-point query that can be redrawn every
  epoch without maintaining a persistent accumulator texture the way A1
  would need.

## Rendering pipeline notes

From building the live world-creation preview
(`client/src/screens/worldgen/WorldGenScreen.ts`):

- **Superseded: 3D vertex displacement + cel-shaded outline.** The first
  working version displaced mesh vertices by elevation and used
  Babylon's stencil-based outline renderer for a coastline. Abandoned
  for two reasons: mesh resolution traded directly against the
  epoch-step animation budget (every vertex costs a plate lookup plus an
  elevation query), and the outline technique turned out to fundamentally
  require the outlined mesh's own body to actually render (to populate
  the stencil buffer) — incompatible with hiding a smooth reference
  sphere behind bumpy displaced terrain, which is what a clean coastline
  line would have needed. Lighting angle mattered more than mesh
  resolution for perceived detail in that version (a raking
  `DirectionalLight` plus a tight specular term revealed real geometric
  detail that a straight-overhead `HemisphericLight` flattened out) —
  noted here since the same principle would resurface if 3D terrain
  relief is revisited later.
- **Current: flat sphere, equirectangular texture.** No vertex
  displacement, no outline renderer. Each epoch, an RGBA texture is
  generated by directly querying the elevation field per-texel
  (`nearestPlateIndex` + `elevationAt`) at the sphere's own default UV
  convention (u = longitude/2π, v = polar angle from the +Y pole / π),
  uploaded via `RawTexture.CreateRGBATexture`. Land/water get a very
  faint tint blended in from white (matching the app's white theme, not
  a bright saturated map), and coastlines are detected as a sea-level
  sign crossing between horizontally/vertically adjacent texels — far
  simpler than the old mesh-adjacency approach, since a texel's
  neighbors are just its grid neighbors (wrap at the longitude seam,
  clamp at the poles), no vertex welding needed. Trades pole-area
  distortion (inherent to equirectangular projection) for full decoupling
  from render-mesh resolution: image detail is now a texel-count choice
  with no per-frame animation cost, not a render-mesh-vertex-count
  choice that was paid every epoch.
- **Per-texel elevation queries needed a spatial index once texture
  resolution replaced mesh-vertex resolution as the query volume** — the
  same `elevationAt` scan that was fine at mesh-vertex scale (~19k
  queries) cost ~15s per texture at 2048x1024 (2.1M queries). Fixed with
  a numeric-keyed grid bucket index over `crust.terrainFeatures`
  (`buildTerrainFeatureIndex`/`TerrainFeatureIndex` in `crust.ts`) —
  string-keyed bucket lookups were tried first and gave zero measured
  speedup (string construction/hashing ate the entire saving versus not
  scanning the full list), which is why the index is numeric-keyed.
  Result: flat ~600ms per 1024x512 texture regardless of terrain-feature
  count, instead of cost scaling linearly with feature count.

## Open threads for later

- Shared field-evaluation implementation strategy (duplicate vs. WASM) —
  not decided.
- Rivers/lakes and climate/biomes design notes to be added here as they
  firm up.
