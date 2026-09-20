---
summary: Could the flat-torus generator also run a sphere, with one code base and a topology parameter? A first analysis of what the generator already shares, where the torus is actually baked in, which sphere substrate keeps the most, and where the real cost sits (outside the generator). Draft — to be refined.
date: 2026-09-20
area: generator
stage: idea
status: draft — first analysis from a design conversation, numbers are estimates from grep and line counts; nothing decided, nothing built. Not a reconstruction of the removed sphere generator (see world-topology-torus.md); the question is whether the flat generator can be parameterised.
---

# Two topologies, one generator

The torus was chosen over the sphere before any rationale was written
([world-topology-torus.md](../decisions/world-topology-torus.md)), and
the sphere tree was removed on 2026-09-20 together with the Mars and
world-map screens. This doc asks a different question than "bring the
sphere back": **with everything the flat generator has learned since,
could ONE generator run both topologies, selected by a parameter, with
as little new code as possible?** It is the analysis, not the decision.

## What is already shared

The flat generator is only about one third "flat".

- **Point geometry, not rasters, up to the elevation stage.** Rafts are
  metaball blobs (`crust/raftTypes.ts`), plates are seeds plus a rigid
  motion (`tectonics/plateSeeds.ts`, `plateMotion.ts`), relief is a set
  of oriented capsules (`tectonics/terrainFeatures.ts`), sutures, plumes
  and volcanoes are point lists. Their only contact with the torus is
  `toroidalDistanceSq`, `wrappedDelta` and `rotateAroundCenter` in
  `core/toroidal.ts`. The raft lifecycle (merge, breakup, accretion) does
  not know what surface it runs on.
- **Climate already treats y as latitude** — the "cylinder decree" in
  [climate-biomes.md](../decisions/climate-biomes.md). Temperature, wind
  bands, seasonality and monsoon are latitude functions today.
- **The raster is 2048×1024, a 2:1 aspect** — exactly an equirectangular
  grid. The save format, the artifact store, the four harnesses and the
  index arithmetic in every raster stage are unchanged by a lat-lon
  sphere.
- **Grid sizes are parameters, not constants.** Only two files read
  `MAP_WIDTH`/`MAP_HEIGHT`; 79 signatures take `(width, height)`.

## Where the torus is actually baked in

Counted 2026-09-20 (`grep` for the toroidal helpers and for wrap
arithmetic):

| module | LOC | wrap sites | what they do |
|---|---|---|---|
| core | 481 | — | `toroidal.ts`, samplers in `field.ts` wrap both axes |
| mantle | 228 | 5 | diffusion + Poisson on a doubly periodic grid |
| archean + crust + tectonics | ~4000 | ~93 | distances, deltas, plate motion, boundary lattice |
| elevation | 1647 | 26 | capsule distances; noise and domain warp are **periodic in both axes** by construction |
| surface | 4993 | ~39 (+61 index sites) | D8 neighbours, priority flood, erosion engine, hydrology, amplify |
| climate | 1421 | 15 | advection of wind and currents wraps both axes |
| ecology + migration | 1156 | 22 | distance queries only |
| render | 885 | 11 | equirect texture, hillshade neighbours |
| pipeline | 1904 | 0 | topology-agnostic |

## Which sphere substrate keeps the most

Three candidates. The choice decides the reuse, so it is the first fork.

**A. Lat-lon raster with pole handling** (what the removed sphere did:
longitude wraps, poles clamp, `cellAreaWeight`). Keeps the raster, the
save, the artifacts, the harnesses and all index arithmetic. New: a
per-row metric (cell width ∝ cos φ) wherever a slope, an area, Kt or
talus is computed; a pole rule for neighbours (across the pole means
x + width/2 and y reflected); pole rows in the Poisson solve. Cost is
the polar distortion — real, but ice caps and polar ocean hide it, and
the equirect texture drapes straight onto a sphere mesh. **Maximum
overlap; recommended starting point.**

**B. Cube-sphere** (six faces). Near-uniform area, no polar singularity.
But every raster stage needs either an edge indirection or a halo
exchange, the save carries six rasters, the harnesses compare per face,
and the erosion engine — which loops `for y, for x` over one array — is
surgery. Much less overlap.

**C. Graph (icosahedral / adaptive mesh).** The same direction as the
adaptive mesh noted in
[amplification-artifacts.md](./amplification-artifacts.md): torus and
sphere both become graph + metric + embedding, and the topology is a
non-question. Also a rewrite of the whole raster stack (surface,
climate, mantle, render), slower and heavier than index arithmetic. Only
if the adaptive mesh is wanted for its own reasons.

## The shape of the shared code (for A)

**The vector layer moves to 3D.** Blobs, seeds and features carry a unit
vector; distance is the angle; the local delta is taken in the tangent
frame. Plate motion becomes a **true Euler-pole rotation**, which
replaces `rotateAroundCenter`'s locally-unwrapped emulation and the
"fixed-Euler-pole ceiling" that
[continental-crust-rafts.md](../decisions/continental-crust-rafts.md)
works around. On the sphere this part gets simpler, not harder.

**Noise loses its periodicity.** `periodicValueNoise2D` exists only
because the torus needs a seam-free tile; on the sphere the ridged
multifractal and the domain warp sample 3D noise at the unit vector.
About 200 lines, new.

**A `Topology` value replaces `(width, height)`.** It answers: distance,
local delta, neighbour of a cell, row scale, cell area, point ↔ cell,
advance a point by a motion, sample noise at a point. The 79 signatures
that take `(width, height)` take it instead. That threading is the bulk
of the mechanical work and is exactly what the golden hash harness
(layer 4) guards: **the torus must stay byte-identical while the sphere
is built.**

**Topology is a spec field.** `topology: 'torus' | 'sphere'` in the
recipe, in `deriveWorldId` and in `derivePipelineVersion`. One tree, one
generator, one parameter — the opposite of the three side-by-side
attempts removed on 2026-09-20.

Estimated sharing by module (estimates, to be refined):

| module | shared | sphere-specific |
|---|---|---|
| core | ~70 % | `Topology` module; samplers get a y-policy |
| mantle | ~80 % | pole rows in diffusion and Poisson |
| archean + crust + tectonics | ~85 % | distances and motion via `Topology`; lifecycle untouched |
| elevation | ~80 % | 3D noise and warp; capsules in the tangent frame |
| surface | ~90 % | neighbour rule and cos φ weights at every slope and area; **where the bugs will live** |
| climate | ~90 % | clamp advection at the poles |
| ecology + migration | ~95 % | almost nothing |
| render | ~80 % | texture is already equirect |
| pipeline | ~98 % | the spec field |

Order of magnitude: 1.5–2.5k new lines plus the mechanical threading.

## The real cost is outside the generator

- **Hex tiling.** A hex lattice does not exist on a sphere: either a
  Goldberg polyhedron (twelve pentagons) or local hex patches with
  seams. [hex-tiling.md](../decisions/hex-tiling.md) and
  [near-ground-clipmap.md](../decisions/near-ground-clipmap.md) are
  torus-snapped throughout. This was a main reason for the torus, and it
  must be answered before any generator work starts — otherwise the
  generator serves a game that cannot run on it.
- **`map/`** is torus rendering (`ToroidalMapView`, wrap copies, the
  ring/tile ground). The sphere needs its own view; the removed screen
  was ~1.2k lines.
- **Harness time.** Golden builds four worlds; two topologies double it.

## Open questions

1. Is a sphere wanted for the *game*, or for the generator as a tool?
   The hex answer follows from this.
2. Polar fidelity: is "hidden under ice and ocean" acceptable, or does
   the world need land at the poles?
3. Mantle at the poles: pole rows in the lat-lon Poisson, or a small
   icosahedral solver just for the 128×64 mantle?
4. Which stage goes first? The vector layer (rafts, plates, features in
   3D) is self-contained and improves the torus too (real Euler poles);
   it can land before any raster stage knows about the sphere.

## Related

- [world-topology-torus.md](../decisions/world-topology-torus.md) — the
  pivot this doc revisits
- [plate-tectonics-initial-state.md](../decisions/plate-tectonics-initial-state.md)
  — the A2 sphere substrate originally decided
- [evolving-euler-poles.md](../decisions/evolving-euler-poles.md) — the
  motion model the 3D vector layer would simplify
- [amplification-artifacts.md](./amplification-artifacts.md) — the
  adaptive mesh, candidate C's sibling
