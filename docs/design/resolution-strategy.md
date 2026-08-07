---
summary: Why the tectonics/erosion sim resolution and the final world's detail resolution are separate layers, not one grid to enlarge.
date: 2026-07-23
status: direction agreed, not yet implemented
---

# Resolution Strategy — Sim Grid vs. World Detail

Records the conclusion of a design discussion about a question that keeps
recurring as "is the 2048×1024 grid too big / too small for the big
detailed world we eventually want?". The short answer is that "too big"
is the wrong axis: **the authoritative simulation resolution and the
final world's detail resolution are two different layers**, and wanting a
large, detailed world does *not* mean enlarging the grid the physics runs
on. Conflating the two is the actual thing to avoid.

Context: the world is a flat torus (wrap in both axes), not a sphere —
see the world-gen generator under `client/src/worldgen/`. Nothing here
depends on that choice, but it's the world this strategy is written
against.

## Two resolutions that are currently one grid

The `2048×1024` raster today does double duty: it is *both* the grid
erosion runs on *and* the raster the map is rendered/textured at. Those
two jobs have opposite resolution economics, and the design already
contains the seam to separate them.

- **The tectonic elevation field is already resolution-free.**
  `computeElevation(x, y)` (`client/src/worldgen/elevationField.ts`) is a
  *function* — a blended per-plate baseline plus distance-weighted
  terrain-feature falloffs plus the domain-warp offset — not a stored
  raster. It can be evaluated at 2048, at 8192, or at a single query
  point, and detail there costs nothing extra and is not bounded by any
  grid. This is the whole point of the A3/A2 "query the field anywhere"
  model and of the compact frozen-snapshot upload to a GPU-less server
  (see [world-gen.md](./world-gen.md)).

- **Erosion is fundamentally grid-locked.** Priority-flood depression
  filling, D8/MFD flow routing, and stream-power incision
  (`client/src/worldgen/erosion.ts`) operate on a stored `Float32Array`,
  mutating discrete cells. Their output is a *raster*, not a function.
  Once a field is eroded, the "evaluable at any resolution" property is
  gone — you have a fixed-resolution height array whose valley/river
  detail exists only at that grid's resolution.

So the tension is real but narrow: it lives entirely in the erosion
layer, not in the tectonic field, and only because the two currently
share one grid.

## Where world detail actually comes from

Detail for a large world does **not** come from a larger *global*
erosion raster. It comes from a two-tier scheme — the standard approach
for planet-scale terrain (Outerra, No Man's Sky, planetary renderers)
and the one that fits this project's own vision (cube-sphere LoD,
regional hex maps *deterministic from position* — see
[vision.md](../vision.md)):

- **Macro (global, coarse, authoritative).** Tectonics plus large-scale
  hydraulic erosion, run on a deliberately coarse grid. Establishes
  *where* continents, mountain ranges, and major river basins are. Small
  enough to store and to ship to the server as the frozen snapshot.

- **Micro (local, procedural, on demand).** When detail is needed at a
  specific location (the hex region around a settlement), it is
  *synthesized* procedurally — ridged multifractal plus a local erosion
  pass, conditioned on the coarse field's own slope / flow / elevation at
  that spot. Deterministic from position, so it is regenerated rather
  than stored.

Because the fine detail is synthesized locally at query/play time, the
resolution of the *global* erosion grid does not cap the detail of the
*playable* world.

## The one place the global grid genuinely matters

Drainage is non-local: a river integrates its entire upstream basin, so a
continental-scale river course cannot be invented by local synthesis
alone. That is exactly what the global erosion pass is *for* — the trunk
rivers and basin boundaries. But that structure is low-frequency and does
not need high resolution to capture: `1024×512` (even `512×256`) already
resolves ranges and major drainage. Tributaries and texture come from the
local micro layer on top.

## Practical resolution guidance

- Erosion cost scales linearly with cell count × iterations.
  `2048×1024` = ~2.1M cells is ~10s for the current one-shot end-of-run
  pass — fine for a once-per-world, user-driven step.
- It becomes too expensive only if erosion is coupled *per epoch* with
  tectonic uplift (the Cordonnier-style interleaving discussed for
  mountain realism) — there `1024×512` or coarser is the point of
  dropping the authoritative grid, purely for that per-epoch budget, not
  because 2048 is inherently too big.
- Going *larger* than 2048 globally is the wrong direction: `8192×4096`
  = ~33M cells (16×) is ~2.5 min per pass, several ~130MB arrays, and a
  frozen snapshot the server architecture wants to keep *small* balloons
  absurdly. Most of those extra cells are ocean or gentle plains that buy
  nothing.

## Compositing caveat

Coarse erosion bilinearly upsampled goes mushy — sharp valleys and
ridgelines blur. So the coarse global pass should supply only the
*low-frequency* drainage structure; the *high* frequencies (crisp ridges
and channels) come from the procedural micro layer on top, never from
upscaling the coarse erosion raster.

## Status

Direction agreed, not yet implemented. Today's code still runs erosion at
the full render resolution as a single end-of-run pass; the macro/micro
split and the local procedural-amplification layer are future work. The
seam that makes the split cheap already exists
(`ElevationRenderPool.renderElevations` / the analytic `computeElevation`
query — see [world-gen.md](./world-gen.md) and
[GPU_TECTONICS_PLAN.md](../../GPU_TECTONICS_PLAN.md)).

**Update 2026-08-07:** a middle tier now exists as a decision — the
worldmap's one-time 8192×4096 amplification bake at load (upsample +
seed roughness + real erosion + re-run hydrology), see
[worldmap-amplification.md](../decisions/worldmap-amplification.md).
It does NOT touch this doc's conclusions: the 2048 grid stays the sole
authority and the only persisted form ("going larger globally is the
wrong direction" was and is about the sim/save grid); the bake is a
derived, never-serialized presentation layer, and this doc's procedural
micro tier remains the plan below the bake's ~2 km reach.
