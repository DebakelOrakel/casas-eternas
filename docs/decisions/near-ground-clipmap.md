---
summary: How the ground's geometry is structured. Today a camera-following high-resolution patch lies over a world-sized low-resolution mesh, and the two meet on a seam that cannot be made to disappear. Decided — build only what is looked at: concentric rings around the camera from the descent down, tiles built on demand in the map register, and one sampling pyramid under both. The world-sized mesh goes.
date: 2026-08-15
updated: 2026-10-03
area: ui
stage: building
status: decided 2026-08-15. BUILT for the incubator 2026-10-03 — the rings (map/groundRings.ts) are its only ground at every zoom, on a fixed ladder of spacings, each ring painted off the main thread with textures finer than its quads (map/groundPaint.ts); the generator keeps the patch and the relief levels. See "Built 2026-10-03" at the end. A prerequisite for showing a 16K bake, not a sequel to baking one.
---

# One Ground Per Register

## The fork

The near view draws its ground twice. A camera-following patch of high
resolution is laid over the world-sized relief mesh, and wherever the two
disagree the lower one shows through the upper as a second sheet of
terrain. The question is not how to hide that seam. It is whether the near
field should be an INSET over a world-sized mesh at all.

## What forced it

Three separate reasons put more than one ground mesh in the scene, and it is
worth keeping them apart, because only the third one produces an overlap:

1. **Wrap copies.** The world is a torus, so every world-sized mesh is drawn
   nine times. Those copies abut; they do not overlap.
2. **The LOD ladder** — flat plane, coarse relief (1024×512), fine relief
   (2048×1024). Only ever ONE is shown. The fine level is 2 M vertices held
   whole, which is why the ladder exists at all: at map zoom every wrap copy
   of it is in frame.
3. **The near-field inset.** A world-sized mesh at near-field resolution does
   not exist: 4096×2048 is 16.8 M triangles PER COPY. So the near field is a
   camera-following window of high resolution over a world of low. **This is
   the pair that overlaps.**

And it overlaps badly, because the relief levels are fixed at those
subdivisions whatever tier is loaded: above a 4K raster the fine mesh sees
every second cell, its vertices stand 7.8 km apart, and it spans that with
STRAIGHT triangles, while the patch samples the same surface every ~200 m.
Wherever a chord passes above the surface it approximates, the near ground is
inside the mesh. Measured on a v8 4K bake (2026-08-15): 16 % of land points
on the fine level, median 31 m deep, p99 327 m; on the coarse level 24 %,
median 96 m, p99 880 m — and worse the higher the ground.

Two things were tried before the structure was questioned, and both are
instructive:

- **Rendering groups** (built 2026-08-15): the near ground draws in its own
  group, and Babylon clears the depth buffer between groups, so the relief
  cannot show through it. It works — and it moved the seam rather than
  removing it. What is visible now is the patch's RIM, where it blends back
  into the plain surface and meets a mesh triangulated too coarsely to agree
  with it. A clean line instead of a messy interpenetration.
- **The camera measured its altitude from SEA LEVEL** (found and fixed the
  same day). Over a mountain range the descent's floor is inside the
  mountain, so every near-field look in the mountains was taken at a grazing
  angle from a nearly submerged camera — the geometry that makes any
  disagreement between two surfaces maximally visible. Fixing it did not
  remove the seam, but it explains why the seam was reported from the
  mountains and nowhere else.

## The options

**A. Keep the pair, treat the seam.** Rendering groups (done), plus
displacing the relief levels from a MINIMUM over the raster cells each vertex
stands for, so the chord sits at or below the surface it approximates. No
render-order assumption, but it lowers ridges at the coarse level — a change
to the map register's own look, to fix a defect the map register does not
have.

**B. Tie the relief resolution to the tier.** Honest and simple: the fine
mesh stops skipping cells. 16.8 M triangles per wrap copy at 4K, four times
that at 8K, against a memory budget that is already the binding constraint.
Rejected on arithmetic.

**C. A camera-centred ring stack from the descent down.** Concentric rings
around the focus, each covering twice the extent at half the resolution,
stitched with skirts. CHOSEN.

**D. One ring stack for BOTH registers.** Rejected, and the reason is worth
recording because it sounds like the tidier answer: a clipmap's entire saving
comes from distance VARYING across the view. Looking straight down at the
whole world, everything is equally far, the rings degenerate to a single
resolution, and that is the world-sized mesh again. One system for both
registers buys uniformity and delivers nothing.

**E. A TILED map register** — same principle as C, different structure.
Uniform resolution, because the map's distances are uniform, but built and
kept only for the tiles actually in frame.

The first argument for it was that nine wrap copies mean nine times the
memory, and that one is simply wrong: the copies are Babylon INSTANCES
(`base.createInstance`), so they share one vertex buffer — one geometry, nine
draw calls. The correct argument survives the correction and is bigger. The
fine level is a world-sized mesh of 2.1 M vertices: with positions, normals,
uvs and indices, ~120 MB of buffers, resident WHOLE while a deep-zoomed frame
shows a small fraction of it. Not nine times too much — once too much, by the
factor between "the world" and "what is on screen".

## The decision

**Build only what is looked at, in the structure each register's geometry
calls for.** From the descent down, one stack of concentric rings centred on
the camera focus (C). In the map register, a TILED ground of uniform
resolution where only the tiles in frame are built and kept (E). The
world-sized mesh goes away in both, for different reasons: distance varies in
one, and only a fraction of the world is on screen in the other.

Within a register the grounds are alternatives, never both drawn — the same
relationship the LOD levels already have, and the property that makes the
whole class of seam-between-two-grounds defects impossible rather than merely
rare.

All three reasons for multiple meshes fall away inside the near register, not
just the third:

- **The wrap copies disappear.** Nine copies exist BECAUSE the meshes are
  world-sized. A camera-centred stack is not: wrapping becomes a property of
  how the height field is SAMPLED (uv modulo), not of how geometry is
  duplicated. Note this saves draw calls and bookkeeping, NOT memory — the
  copies were always instances over one buffer.
- **The LOD switch disappears.** No flat/coarse/fine to swap between;
  resolution falls continuously outward.
- **The inset disappears.** The innermost ring IS the near field.

And the arithmetic runs the right way. Nine rings at 128² carry the view from
a 57.6 km inner ring out to world scale for ~150 k vertices — an order of
magnitude LESS than today's fine level before its nine copies, with more
detail where the camera is.

**What ring 0 is, is open again.** It was going to be a hex lattice —
vertices on tile centres and corners, six triangles per tile — because that
is what lets a developed tile flatten its own seven vertices and actually CUT
the ground. That was built and measured on 2026-08-15 (`map/hexNearMesh.ts`,
192 tiles across) and REMOVED the same day: the cutting was correct and
invisible, since developable ground spans about 0.2 m across a 300 m tile,
and without the cutting the lattice cost 130k vertices against the square
patch's 37k for a 17 % gain in vertex spacing. See
[design/hex-world-view.md](../design/hex-world-view.md) for the full account.

So ring 0 is a square grid like the rest until something needs it not to be.
The ring stack does not depend on which it is — the rings carry silhouette
and distance falloff, and tile-shaped geometry is a demand that would come
from whatever finally answers "what does a developed tile look like", not
from this decision.

**The handover is the register boundary that already exists**: the
orthographic→perspective flip at zoom 1, where the projection changes, the
sky and fog arrive and the exaggeration starts fading. One seam between the
two systems, at the place the two registers already touch, rather than a
second threshold to keep in step with the first.

## What this buys for 16K

Both structures SAMPLE the height field; neither owns it. Rings need coarse
values at the edge and full resolution only near the camera; map tiles need
one resolution but only where the frame is. Both want the same thing
underneath: a sampling PYRAMID, read at the level the geometry asking is
built at. A 16K bake (134 M cells; 537 MB as Float32, and the artifact on
disk is 395 MB — measured 2026-08-15) then never has to be resident whole —
neither as raster nor as vertex buffers.

With the present structure that is not available at all. A world-sized mesh
displaced from the raster wants the entire field at once, by construction,
and holds ~120 MB of buffers for it at the fine level. The memory ceiling on
8K, and the whole 16K question the near-field plan's step 3 exists to
measure, are downstream of this decision.

Which is also the honest ordering note: this decision is a PREREQUISITE for
16K, not a sequel to it. Step 3 measures whether a 16K bake can be produced;
this is what decides whether it could ever be shown. Step 3 has since run
(2026-08-15): a 16K bake IS producible — 41.9 minutes, 8.5 GB peak, and it
carves valleys 50 % deeper than 8K — and it is still not showable, which is
exactly the split this paragraph predicted. The tier stays off in the app
until this decision is built.

## Consequences

- `ToroidalMapView`'s near-detail patch goes, and with it the rim blend,
  `PATCH_COVERAGE`, and the altitude-scaled spacing.
- The rendering-group split stays useful but stops being load-bearing: with
  one ground there is nothing to draw over. Its cost (the near group has no
  occlusion against the terrain group, so distant rivers show through ridges)
  should be re-examined once it is no longer paying for anything.
- `pickGround` and the river ribbons' drape follow the rings instead of the
  patch, as does anything later laid on the ground.
- The map register keeps its LOOK entirely — paper texture, hillshade, wash,
  exaggeration — and changes its geometry: the coarse and fine relief levels
  become tiles built on demand for the frame. The flat plane at far zoom can
  stay exactly as it is; it is one quad.

## Still open

- Ring count and per-ring resolution — 128² × 9 is an arithmetic sketch, not
  a measurement.
- How the rings are stitched: skirts, or matched edge vertices with the outer
  ring's spacing. Skirts are cheaper and hide the T-junctions; matched edges
  are exact and constrain the inner ring's boundary.
- Whether the rings recentre continuously or snap to their own grid. Snapping
  keeps the sampled heights stable frame to frame (no crawling), which is the
  classic reason clipmaps snap.
- What the ribbons ride on across a ring boundary.
- The map register's tile size and how tiles are evicted — the same
  least-recently-used question the artifact store already answers for
  artifacts, one level down.
- Whether the two registers share one tile/ring sampler or keep two. They want
  the same pyramid; they do not want the same geometry.
- Whether the map register ever folds into the ring stack. No — see option D;
  the shared thing is the principle and the sampler, not the structure.

## Built 2026-10-03

The incubator's ground is the rings alone, from the whole world down to a
kilometre over it. What changed against the sketch above, and why:

- **A fixed ladder of spacings** (30 m · 2^k, 13 rings to span the world),
  not an innermost spacing that follows the altitude. The zoom decides which
  rings are drawn — a ring whose texels fall under a pixel is left out and
  the ring outside it has no hole — so a zoom never rebuilds a ring's grid.
  With the spacing following the altitude every power of two rebuilt all
  of them at once, and the stairs wandered with the camera (2026-10-02).
- **The look is in the textures, not the quads.** Each ring carries an
  albedo and a world-space normal map of 512 or 1024 texels a side over
  its 192 quads (map/groundPaint.ts, the normals read through
  map/groundNormalPlugin.ts). The quads carry the silhouette and the
  shadows; everything finer than a quad is painted. This is what the
  legacy world map did with its 4K hillshade over a coarse mesh, and what
  every game whose mountains read from above does.
- **Painted off the main thread**, two workers each holding the level and
  the tiles, one build in flight per worker, the most urgent ring first
  (the one whose texels are nearest the pixel, then outward). A ring stays
  where it stood until its new build arrives, geometry and textures
  swapped in together; the ring outside covers the gap meanwhile.
- **Levels blend at the rim.** A ring reads the finest level its texels
  can show (level 3 to ring 5, level 2 to ring 7, level 1 beyond), and
  over its outer half slides to the outer ring's level: each level stands
  its peaks a few hundred metres higher than the level below, and at a hard
  edge the relief and the snow line stepped.
- **Interpolated normals, not blurred heights.** The tiles are
  triangulations; at the map's exaggeration every facet showed. The tile
  sampler now interpolates vertex normals (as the level's sampler already
  did), softened by half a node spacing against the nodes' jitter.
- The camera leans in by itself as the view narrows (flat above 200 km,
  50° at 20 km, 68° at 2 km), one curve across the orthographic-to-
  perspective handover, and keeps its height over the drawn ground.

- **Detail under the texels** (same day, later): the painter writes
  MATERIAL weights per texel (rock, bare, snow, canopy; grass the rest),
  and the shader lays tiling detail textures under the albedo by them —
  made in code (map/groundDetail.ts: grass, strata rock, scree, snow,
  canopy, a macro mottle), a 2D array texture read at two wavelengths,
  HEX-TILED (Mikkelsen 2022: a triangle grid, a random turn and offset
  of the texture per vertex, the three around a pixel mixed) so no
  repetition shows, the micro tile within a few altitudes of the eye. Photo textures (CC0) remain the option to compare
  against.
- **Levels by the texel, not by the ring.** Each level's share of the
  ground fades with the texel size (level 3 under ~450 m, level 2 under
  1 500 m), so two rings with one texel size draw one ground. A level per
  ring put the range in a square where ring 5 (level 3) met ring 6
  (level 2).
- **Previews.** Every ring is built first at a quarter side (a sixteenth
  of the work), enlarged bilinearly, and built in full once the tiles it
  wanted are in.

- **Rasters, not meshes, under the painter** (same day, later). A ring's
  paint was nearly all triangle location in the tiles' meshes. Each tile
  is now sampled once onto a regular grid of height and slope
  (screens/incubator/groundRaster.ts: 75 m cells on level 3, 250 m on
  level 2, level 1 at 2 km on level 2's tile grid), into a
  SharedArrayBuffer every painting worker reads; the main thread keeps
  the registry and evicts by bytes (700 MB, least recently painted
  first). Four workers, two of which hold level 1's mesh and raster it on
  demand. Coarser texels than any level's nodes read the save's own
  raster (level 0). A build arrived is applied one per frame, and a
  preview is enlarged in the worker: the 300 ms frames during a pan are
  gone (now ≤ 31 ms), a pan settles in ~3 s (was 11). Not server
  artifacts on purpose: a raster is five times its mesh and takes as
  long to fetch as to make, and the painted look changes too often to
  store. The fetched world is kept in cache storage and revalidated
  with If-None-Match.

- **Centred on the near edge, not the focus.** Tilted, the nearest
  ground is at the frame's bottom and its pixels the smallest; the rings
  now centre on the frustum's lower edge on the ground as the tilt opens
  past half the field of view, so the finest ring covers the foreground
  and the coarser ones run toward the horizon (the user's point,
  2026-10-03). A ring that stands keeps what it shows until its full
  build arrives; previews are only for an outer ring's first build.
- Every ring owns its vertex arrays: Babylon keeps the array handed to
  an update as the buffer's data, and one array for all rings made every
  ring's bounds the last ring's.

Open: the tile seams show as a ridge of ~50 m along every tile edge,
which is the bake's, not the drawing's (the user's call: fix in the
generator later); pan lag is still seconds of soft ground on the outer
rings (1024² paints of 2–3 s each); vegetation exists as a canopy surface,
not as instances.
