---
summary: How world generation fits into the client/server architecture — what runs where and why.
date: 2026-07-20
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
and not an ongoing state to keep advancing: the final plate list
(identity, position, type — Euler-pole axis/speed no longer matter once
nothing moves) plus the final terrain-feature list from A3's
boundary-curve-local state (position, accumulated thickness, which side
subducts, and which plate each feature belongs to). That's small enough
to transfer outright, and cheap plain arithmetic to query, no shader or
texture lookup required. This is also why A3 (boundary-curve-local state)
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
