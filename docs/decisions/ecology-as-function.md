---
id: DEC-0030
title.en: Ecology as a function, not a raster
title.de: Ökologie als Funktion, nicht als Raster
summary.en: The ecology fields become a local rule over the coarse climate, the fine
  terrain and water, and the tectonic features, evaluated at whatever
  resolution one looks at (2048 in the generator, the tile's own in a detail
  job), instead of a raster stored at one resolution. The climate stays at
  62 km and is downscaled by the terrain where a tile needs it. The save
  carries the inputs, not the fields.
summary.de: Die Ökologiefelder werden zu einer lokalen Regel über das grobe Klima, das
  feine Gelände mit Wasser und die tektonischen Merkmale, ausgewertet in der
  Auflösung, die man gerade ansieht (2048 im Generator, die eigene einer
  Kachel in einem Detail-Job), statt als Raster in einer Auflösung
  gespeichert. Das Klima bleibt bei 62 km und wird dort, wo eine Kachel es
  braucht, über das Gelände verfeinert. Das Save trägt die Eingaben, nicht
  die Felder.
area: generator
stage: building
createdAt: 2026-09-29
concepts: [resource.carryingCapacity, generator.concept.resource-roles]
related: [DEC-0008]
---

## The fork

The ecology fields (carrying capacity and 13 resources, see
[ecology.md](./ecology.md)) are computed on the 256×128 climate grid,
62 km a cell, stored in the save at that grid, and read by the migration
at that grid. The finished map is meant to zoom to the ground: some 122 m
a cell ("128K", [design/adaptive-mesh.md](../design/adaptive-mesh.md)),
the 300 m hex of [hex-tiling.md](./hex-tiling.md), in tiles computed on
demand ([adaptive-mesh.md](./adaptive-mesh.md), fork 3: no global raster
tiers, resolution is where one looks). What resolution must the climate
and the ecology have for a tile at that level to get realistic data, and
in what structure?

## Options

- **A. A finer stored raster.** Ecology (and perhaps climate) at 2048 or
  more, in the save. Sharper in the generator, but it stores results, not
  inputs: 29 MB of u8 at 2048 for fourteen fields, and still 64 times too
  coarse for a 122 m tile. Every finer level would need a finer raster.
- **B. A local rule, evaluated where one looks.** Each ecology field is a
  function of inputs that already exist: the coarse climate interpolated
  to the point, the fine terrain (slope, material), the water (rivers,
  water table, lakes, coast) and the tectonic features (points and
  belts). The generator evaluates it at 2048 to show it; a detail job
  evaluates it at the tile's own resolution. Nothing of it is stored at a
  resolution.
- **C. Vector features.** A deposit as a point with a radius, a fishing
  ground or a floodplain as an area, an oasis as a point. Sharp at any
  zoom and small. It fits the resources that are features by nature, not
  the continuous fields (arable, game, carrying capacity).

## Answer

**B, with C where a resource is a feature.** The climate stays coarse and
is downscaled by the terrain in the tile.

- **The climate stays at 62 km.** It changes slowly over hundreds of
  kilometres; what changes it within a cell is the terrain: height
  (lapse), windward and lee (rain), slope aspect (sun), cold-air pools in
  valleys, coastal fog. A tile derives these from the coarse climate and
  its own terrain (downscaling, as the 1 km climate maps of the Earth are
  made from coarse models and a height model). A finer stored climate
  would only store the interpolation every tile can do itself. The
  fine biomes do this today at 2048 (interpolated sea-level temperature,
  then the pixel's own lapse).
- **The ecology is a local rule.** Every field is written as: the
  climate at the point (interpolated, later downscaled) × the local
  terrain × the local water × the features near it. Most of it has this
  form already (2026-09-29); what binds it to the 62 km cell is the
  cell-neighbour rules (coastalness, the ecotone, the fish's richest
  neighbour) and the reductions of fine inputs to the cell (river water,
  shelf share, well share, the fine biomes' mean). Those become
  neighbourhoods and distances in metres, not in cells.
- **Only what is not local is carried globally.** These are the inputs
  the rule cannot derive from a tile alone:

  | Quantity | Why not local | Carrier |
  |---|---|---|
  | A river's discharge | the whole catchment | macro mesh; a tile inherits the inflow at its edge |
  | The water table's reference | the distance to the next channel | macro mesh + the tile's channels |
  | Ore, tin and gold provinces | the tectonic history | points and belts (vector) |
  | Upwelling, sea temperature | the whole basin | 62 km grid |
  | Soil layers, sediment | the erosion history | the mesh's columns |
  | The climate | the atmosphere | 62 km grid |

  All of these exist. The macro level is enough; the detail comes from
  the tile.
- **The save carries the inputs.** The ecology fields are not stored, or
  at most as a preview. Loading evaluates the rule again. (To check when
  built: that every input is in the save or rebuilt on load; the fine
  biomes and the water table are hydrology products.)
- **The generator shows the rule at 2048**, on the biome map's raster,
  so the ecology overlays and the biome map agree. The migration keeps
  its grid for now and reads the carrying capacity reduced to it; moving
  it is its own step.

## What this changes

- `world/save/fieldSpec.ts` says climate and ecology "are regional
  quantities and stay coarse". The climate still does. The ecology is no
  longer a property of a grid, and `query.ts`'s "climate, biome and
  ecology have exactly one tier" becomes "evaluated at the tier asked
  for" for ecology (and, by the same argument, the biomes).
- The ecology's constants that are counts of cells (the coast reach
  `fishFullSeaNeighbours`, `ecotoneFullShare`, the ore radii as world
  fractions) are measured again in metres when the rule leaves the cell.

## Build order

1. **Free the rule from the cell.** Write each field as a function of
   the point's inputs; the cell-neighbour rules become distances in
   metres. Evaluate it at 2048 in the generator. Measure against the
   62 km fields (the Earth scratch runs of 2026-09-29, the golden worlds).
2. **The save stores inputs.** Drop the fourteen ecology layers from the
   save or keep them as a preview; the loader evaluates the rule. A save
   format change.
3. **Vector features** for the point-like resources (deposits, oases,
   salt flats), where a feature reads better than a field.
4. **Downscaling in the tile.** The climate by height, windward and lee,
   aspect and cold-air pools, then the rule at the tile's resolution. With
   the detail jobs of [adaptive-mesh.md](./adaptive-mesh.md), not before.

The biomes follow the same path; they are a local rule too.

## Step 1, built (2026-09-29)

`ecology/ecologyField.ts`: `prepareEcology` evaluates the physics per pixel
of the world raster, `applyEcology` the step's sliders, `computeEcology`
both. The climate is read at the pixel by a bilinear over the cells that
fit (land or sea), the temperature at sea level with the pixel's own
lapse. The neighbour rules are reaches in metres (`coastReachM`,
`waterReachM`, `ecotoneReachM`); the slope is the pixel's, read against a
climate cell's length. The worker sends the fine fields as one byte a
pixel (29 MB for fourteen, 117 MB as floats) with the cell means beside
them.

Measured on Earth (scratch runs of the refined climate with its rivers,
the value at the place's own pixel): arable's farmland against the rest
0.17 against 0.04 (×4.3; was ×2.75 per cell, Tanta 0.31 → 0.51 on the
Nile's strip); fish's rich coasts against the poor 0.28 against 0.14
(×2.05; was ×2.3 per cell) once the shelf counted as its share within
reach (as any shelf pixel within reach ×1.55); salt 0.26 against 0.01
(was 0.27 against 0.01). As cell means, the carrying capacity 0.35 →
0.29: the fish and the irrigation reach a strip, no longer the whole
cell.

Recalibrated the same day, on the golden worlds against the old means per
cell: bog iron and placer gold had become strips (iron and gold means
−60 %). Placer gold now reaches 30 km from its river (its gravels and
terraces), bog iron counts waterlogged ground (the water table at the
surface) at 0.15 of a river's wet ground; both back within some 10 % of
the old means. A stream below a floor feeds no fish and waters no field
(on Earth the land with a trace of fish 72 → 13 %). The fish field shows
the sea's richness on the sea itself: the fishing grounds.

## Step 2, built (2026-09-29)

The save carries no ecology layers (formatVersion 7); a loaded world
computes the ecology from its inputs: the sliders from world.yaml, the
features and cratons from the simulation's snapshot, the terrain from the
mesh, the months, upwelling and rain reliability from the refined climate
the save holds, and the fine biomes, rivers, lakes, salt flats, water table
and oases from the hydrology computed on load. Measured on Earth (the
refined climate through the save's encoding and back, the ecology on both):
the mean difference per pixel is nil; 0.01 % of the pixels differ by more
than 0.05, in pasture and timber only, where the rounding tips a pixel's
biome over a class border. A reader without the generator finds no ecology
in the save; none asks for one yet.

## Status

decided 2026-09-29; steps 1 and 2 BUILT the same day — the rule runs per
pixel at 2048×1024 (prepareEcology, some 2 s, kept by the worker while only
the sliders move; applyEcology, some 0.3 s), the map and its readout show
it, the migration reads its means per climate cell, the save carries its
inputs only (formatVersion 7). Steps 3–4 open.
