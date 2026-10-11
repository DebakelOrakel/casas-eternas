---
id: DEC-0036
title.en: Every field on a mesh — the 2:1 chart for display and storage only
title.de: Jedes Feld auf einem Netz — die 2:1-Karte nur für Anzeige und Speicher
summary.en: The generator's raster stages leave the 2:1 chart. The coarse global fields
  (mantle, ocean age, climate with its refinement, flexure) go onto a uniform
  field mesh, the Goldberg dual of a subdivided icosahedron on the sphere and
  a hexagonal lattice on the torus. The fine land fields (biomes, ecology,
  resources, hydrogeology) go onto the adaptive terrain mesh that already
  exists. The chart stays as the address and the textures; the save holds
  the meshes' values, no raster field (old saves are refused). Both
  shapes take the one path; the golden values break per phase, on purpose.
  The calibration of the sphere's raster constants waits for it.
summary.de: Die Raster-Stufen des Generators verlassen die 2:1-Karte. Die groben, globalen
  Felder (Mantel, Ozeanalter, Klima samt Verfeinerung, Flexur) kommen auf ein
  gleichmässiges Feldnetz, auf der Kugel das Goldberg-Dual eines unterteilten
  Ikosaeders, auf dem Torus ein Hex-Gitter. Die feinen Landfelder (Biome,
  Ökologie, Ressourcen, Hydrogeologie) kommen auf das adaptive Geländenetz,
  das es schon gibt. Die Karte bleibt Adresse und Textur; der Save hält die
  Werte der Netze, kein Rasterfeld (alte Saves werden abgelehnt). Beide
  Gestalten nehmen den einen Weg; die Golden-Werte brechen je Phase, gewollt.
  Die Kalibrierung der Raster-Konstanten der Kugel wartet darauf.
area: generator
stage: building
createdAt: 2026-10-11
updatedAt: 2026-10-11
related: [DES-0025, DEC-0035, DES-0017, DEC-0029]
---

Decided 2026-10-11, after the sphere's steps 0 to 4 ran on the raster with
pole handling ([two-shapes.md](./two-shapes.md), DEC-0035, fork 5 (a)) and
its size was set to a 20 000 km equator (fork 6). The idea sketch is
[fields-on-a-mesh.md](../design/fields-on-a-mesh.md) (DES-0025).

## The problem

The physical fields that are rasters in the 2:1 chart are uneven on the
sphere. A cell is 9.8 km north–south everywhere, but east–west it is
9.8 km at the equator and cos φ of that toward the poles:

| Field | Raster | Cell at the equator | at 75° |
|---|---|---|---|
| mantle | 128 × 64 | 156 km | 40 km |
| ocean age | 256 × 128 | 78 km | 20 km |
| climate and refinement | 256 × 128 | 78 km | 20 km |
| flexure, ecology, biomes | 2048 × 1024 | 9.8 km | 2.5 km |

The equator is coarser than the torus (7.8 km), the poles are finer than
needed (about 36 % of the raster work), and every raster stage carries pole
handling: averaged pole rows, cyclic line solves past 45° or 60°, sub-steps,
polar filters. Each of these was a source of a bug found on the way (the
belts that slid over the pole, the corner reads mirrored without the column
shift, the pole-row vector average that must never happen). And about
twenty constants are stated in cells, so on the sphere they mean 25 % more
in metres than on the torus — calibrating them now would be undone by this
change.

## Fork 1 — Which fields leave the chart

**Options.** (a) The coarse global fields only. (b) Every field the
generator simulates. (c) None (keep fork 5 (a), pole handling).

**Answer: (b).** No simulation runs on the 2:1 raster after this. The chart
stays an address and the textures; the save leaves it too (fork 5).

**Why.** Half a move keeps both kinds of code, and the fine land fields
have the same pole problem as the coarse ones. With (b) the calibration is
done once, in metres.

## Fork 2 — On which mesh

**Options.** (a) One uniform mesh for every field. (b) A uniform field mesh
for the coarse global fields and the adaptive terrain mesh for the fine land
fields.

**Answer: (b).**

- **The field mesh**: mantle, ocean age, climate with its refinement and
  phenomena, flexure. Global, smooth, the same resolution everywhere; its
  spacing is a choice per field, free of the chart (about 78 km for the
  climate, about 24 000 nodes on the sphere; about 156 km for the mantle,
  about 6 000).
- **The adaptive terrain mesh** (DEC-0029): biomes, ecology, resources,
  hydrogeology. It is dense on land and thin at sea — exactly where these
  fields need detail. The ecology's windows (maxWithin, halos, oases) become
  neighbourhoods in metres on that mesh.

**Why.** The land fields need land detail, which a uniform mesh pays for
over the whole sea; the adaptive mesh has it already. The global fields need
the opposite.

## Fork 3 — The field mesh's form

**Options.** (a) Values on the triangles of a subdivided icosahedron (the
primal form, as ICON). (b) Values on its vertices, each owning its Voronoi
cell — the Goldberg dual: 12 pentagons, the rest hexagons (as MPAS).

**Answer: (b).** On the torus its counterpart is the hexagonal lattice
(mesh/lattice.ts hexLattice); on the sphere the geodesic lattice of step
4d4 (geodesicLattice) is the start.

**Why.** Six neighbours (five at twelve places) are more even for diffusion
and transport than a triangle's three. The finite-volume fluxes run across
the cell walls, which the mesh code computes already (voronoiArea, edge
lengths, cotangents); the triangulation stays for locate and barycentric
interpolation. The twelve pentagons need no special code when the true areas
and wall lengths are used. And the Goldberg cells are one answer to the open
question of hex tiles on a sphere (DES-0017). The values sit at the cell
centres (collocated): the climate is diagnostic, so velocities on the edges
(a C-grid) are not needed.

## Fork 4 — The torus

**Options.** (a) The torus takes the same path. (b) The torus keeps its
raster.

**Answer: (a).** One code for both shapes; only the field mesh differs. The
golden values break, on purpose, once per phase; each phase is re-armed
(`harness:golden:hash`) after its metrics are checked against their bands.

**Why.** Two paths double every later change and let the shapes drift
apart, which DEC-0035 exists to prevent.

## Fork 5 — The save format

**Answer (revised the same day): no raster field in the save.** A save
holds the meshes' values — the field mesh's per cell, the terrain mesh's
per node — and what identifies each mesh (it is rebuilt from the Domain and
its spacing, deterministically). The chart rasters are made from them at
load, for the textures and the readouts. No backward compatibility: the
generator is alpha, an older save is refused with a clear message, not
migrated (the user's call: "mit der Brechstange"). Each phase moves its own
field out of the archive; the remaining layers (elevation, ocean age, the
lattice, the ecology and climate layers) go in a step of their own, with
everything that reads them (the world id's hash, the artifacts, the bake,
the sample baker).

(First answered "unchanged — rasterised into the chart as today"; revised
2026-10-11 before phase 1 was built.)

## The operators

Built once, on any field mesh, each checked against an analytic answer
before any stage uses it:

- **diffusion**: finite volumes on the Voronoi cells (flux = difference ×
  wall length / centre distance, divided by the cell's area);
- **gradient**: least squares over a cell's neighbours, in its tangent
  plane;
- **transport**: semi-Lagrangian — the departure point along the great
  circle (the Domain's advance), then locate and barycentric interpolation;
- **elliptic solves** (the currents' stream function, the energy balance,
  the mantle's Poisson): iterative (conjugate gradients, multigrid where it
  pays) in place of the row and ring solvers;
- **sampling** for every reader: a field sampler (locate + barycentric) in
  place of grid indices (upsampleAt, sampleElevationAtCell and the like);
- **rasterising** for the textures and the save (rasteriseNodeField).

The checks are the climate models' standard ones (Williamson et al.): a cap
advected over the pole, diffusion of spherical harmonics against the exact
decay, conservation of mass and energy — numbers, not pictures.

## Order of work

Each phase is agreed before it starts and measured after (sphere and torus,
2048 × 1024: time, the field's metrics, its continuity).

0. The field mesh and the operators, with their checks; no stage uses them.
1. The mantle — small and isolated: the pilot for the solvers and the time.
2. The ocean age — transported with the plates.
3. The static climate: temperature, pressure, wind, precipitation.
4. The ocean currents and the energy balance — the hard solvers.
5. The refinement and the phenomena.
6. The flexure.
7. Biomes, ecology, resources and hydrogeology on the terrain mesh.
8. Then the calibration — once, in metres: the constants now in cells
   (DEC-0035, fork 6's list), the plate count and the land fraction.

The tectonics' own calibration (plate count, land fraction, the radii of
ranges and rifts, the mesh's spacing) does not depend on this and may be
done before or beside it.

## What it costs, what to watch

- The largest change since the adaptive mesh: the climate is about 4 700
  lines, then the mantle, the ocean age, the flexure and the ecology.
- The solvers are the risk. Graph solvers converge more slowly than line
  solvers; computeSinkInflow does not converge today on either shape.
- Time: a neighbour list costs about 1.5–2 × a row per node, against fewer
  nodes and no sub-steps — an estimate, measured in phase 1.
- Determinism: the operators use detMath and a fixed order, as the
  generator does everywhere.

## Status

2026-10-11: phase 3 BUILT — the static climate on the field mesh, both
shapes, one path (`climate/climateMesh.ts`; temperature, wind,
seasonality, monsoon, precipitation, pressure). The mesh is the ocean
age's (W / 256, shared through `fields/fieldMesh.sharedFieldMesh`).

**The grid first.** The sphere's field mesh is the geodesic lattice
relaxed toward a centroidal tessellation (`mesh/lattice.ts`
centroidalGeodesicLattice: Lloyd's iteration on the globe, 300 steps
over-relaxed by 1.8, fixed, only exact operations); the terrain mesh
keeps the plain lattice. The mantle and the ocean age take it too (one
construction). Measured (`harness:fields`, plain → relaxed):

| | plain geodesic | centroidal |
|---|---|---|
| cell areas, 156 / 78 km | × 1.99 / × 2.04 | × 1.38 / × 1.52 (pentagons 0.69 of the mean, hexagons 0.85–1.04) |
| min wall at 78 km | 23.3 km | 29.4 km |
| gradient, L2 order / L∞ order | 1.55–1.94 / 0.79–1.36 | 1.89–2.08 / 1.05–1.32 |
| Poisson / Helmholtz error at 78 km | 4.72e-4 / 2.58e-4 (226 / 165 its) | 4.48e-4 / 2.45e-4 (211 / 155 its) |
| diffusion decay, l = 4, at 78 km | 3.90e-4 | 2.61e-4 |
| ∇² pointwise, L2 order (l = 2..4) | 1.66–1.94 | 1.20–1.89 |
| ∇² pointwise, L∞ | first order (0.74–1.04) | does not converge: 0.9–1.2 % at every spacing, at the hexagons next to a pentagon |
| build at 78 km / 156 km | 49 / 34 ms | 706 / 196 ms |

So the relaxation evens the areas and improves everything a stage
consumes (the gradient, the solves, the diffusion, the transport, 1–6 %
more accurate), but NOT the L∞ order hoped for: on a centroidal grid the
finite-volume Laplacian's truncation error next to the pentagons is of
order 1 (a known property, Peixoto 2016, J. Comput. Phys. 310); its
solutions still converge at second order (supraconvergence). A
Heikes–Randall "tweak" (generators moved until each link bisects its
wall) would give the second order; a quick centring heuristic was tried
and did not get there (L∞ at 78 km 1.5e-3, like the plain grid). The
harness's bands follow: ∇² L2 order > 1, L∞ bounded (< 2e-2, not
growing), areas within × 1.6, the gradient's L2 order > 1.8 and L∞ > 1.

**The method.** Each stage's arithmetic on the mesh, in metres; every
constant stated in cells is the length it meant on the torus (the
former 62.4 km climate cell), so the torus's climate changes by the
method only:

| Was | Now |
|---|---|
| tempPlateauRadiusCells 3 (three box passes) | tempPlateauSigmaM 216 000 (Gaussian σ = √(3·4) cells) |
| pressureSmoothCells 6 | pressureSmoothSigmaM 404 000 (σ = √(6·7) cells) |
| seasonContinentalityScale 45 cells | seasonContinentalityScaleM 2 808 000 |
| precipAdvectStep 2 cells per wind unit | precipAdvectStepM 124 800 |
| precipOrogLeverPx 20 world px | precipOrogLeverM 156 000 |
| the orography's half cell (implicit) | precipOrogHalfSpanM 31 200 |
| the monsoon's and the pressure's ∇ per cell, the blocking's next cell | climateGradientLengthM 62 400 |

The smoothing is explicit diffusion to κt = σ² / 2 in convex steps
(fieldOperators.smoothGaussian); the gradients least squares; the
moisture's departures along the great circle, linear in the triangle;
the continentality a Dijkstra over the cells' links (a path within 15 %
of the straight line, the raster's 4-neighbour steps within 41 %); the
pressure's row mean a zonal mean over bands as tall as the torus
lattice's rows (on the torus a band IS a row). Dead and deleted: the
polar filter of the monsoon's and the pressure's gradients, the pole-row
averaging of the seasonality, the box blur's cos φ rows (the refinement
keeps its own copy, phase 5). The terrain is read at each cell's centre
(the texel under it: the lapse, the land test, the plateau, the coast)
and area-weighted only for the relief the pressure's wind meets.

**Transition adapters** (`// DEC-0036 transition: removed in phase N`):
weather.ts — the wind and the temperature rasterised for the currents
and applyOceanSST, the SST change brought back at the cells' centres
(phase 4); the climate raster of every field for the readers outside
(phase 7: the ice, the coast, the ledger, the lakes, the biomes, the
ecology, the save's layers, the overlays and readouts; land fields keep
their sentinel, an island under a cell takes its latitude's land mean,
climateMesh.climateLandRaster); refinement.ts — its pressure, its wind,
its base temperature and its rain on the mesh, its raster fields brought
there at the centres, and its box blur (phase 5); map/vectorMarks.ts and
the screen — the refinement's winds and the currents read as rasters
(phase 5). The static wind's marks read the mesh through its sampler in
each point's own frame (worst direction error 0.0016 against 0.014 for
the raster, scripts/symbolPlacement.mjs); the screen builds the mesh from
the world's shape (0.7 s once on the sphere).

**Save**: the save holds no static climate state — the climate is
recomputed on load, the epochs' weather is not saved. Its quantised
climate layers (temperature, precipitation, seasonalAmplitude,
monsoonIndex, landMask) stay rasters, written from the transition
rasters, and move in the save's own step. formatVersion 8 unchanged.

**Measured** (2048 × 1024, seed `bench`, 100 Archean + 12 coupled
epochs at HISTORY_DEFAULTS, Node, one thread). The relaxed mantle mesh
makes the sphere a different world; the torus's is the same world:

| | torus HEAD | torus mesh | sphere HEAD | sphere mesh |
|---|---|---|---|---|
| climate per climate epoch (4 of 12) | 375 ms | 404 ms | 398 ms | 398 ms |
| climateRun on the 2048 raster | 351 ms | 367 ms | 411 ms | 402 ms |
| whole coupled epoch | 1216 ms | 1240 ms | 2308 ms | 1778 ms (87 k nodes, HEAD 152 k) |

Of a climate run on the sphere: the currents' raster 128 ms, the two
seasons' rain 169, temperature 11, wind 3, the rasters out ~30; the
climate mesh's first build 0.8 s. Zonal means over land, torus (same
world), HEAD → mesh: temperature 25.8 → 25.7, 22.9 → 22.9, 13.8 → 13.8,
2.8 → 2.8, −5.8 → −6.0, −18.2 → −18.3 °C; rain 1518 → 1539, 712 → 710,
495 → 501, 886 → 872, 256 → 268, 38 → 38 mm (0–15° … 75–90°). The
sphere's (different worlds, land 7–27 % → 4–15 % by band): temperature
25.0 → 25.1, 22.4 → 23.3, 13.0 → 13.7, 4.6 → 4.9, −5.6 → −5.6, −14.2 →
−11.7 °C; rain 1447 → 1520, 654 → 915, 462 → 425, 931 → 878, 278 → 322,
53 → 61 mm. Two runs give the same bytes; save → load → continue is
bit-identical (pipeline harness).

**Golden**: 0 hard failures, 121 metrics drifted, 120 of 138 stages
moved (the climate's and everything after it; the plates, rafts,
mantle and land fraction unchanged — the torus golden worlds keep their
geometry). Main shifts: ice volume +4 / −7 / −7 %, lake cells −12 / −14
/ +18 %, river reaches −2 / +3 / +24 %, highest point 1910 → 2146, 3103 →
3025 m (zulu unchanged), zulu's hottest cell 45.2 → 36.9 °C, biome shares
within a few tenths of a point. No seed changed. `golden.json`
re-recorded and the byte guard re-armed: 0 / 0 / 0, 46 stages
byte-identical × 3.

**The sphere's pole checks** (pipeline harness): the fields made on the
mesh have no pole row; rasterised, a pole row is a ring 0.35° round the
pole, so those are held smooth round it (the largest step between
neighbouring pixels under a quarter of the ring's range; a star gives
about 1) instead of one value; the raster's own fields keep the old
check. The sphere climate test through the runtime for
the seeds c2–c6 (each run's world varies with the Archean's timing):
the pole checks — scalars, temperature, winds and currents — pass on all
five (the climate's own temperature round a pole steps at most 0.02 °C
from pixel to pixel; the refined year, its raster warmth included, at
most 0.37 °C; on HEAD c5's pole row spread 1.14 °C). What still fails
is not the static climate's: c2 and c6 have land on both poles, so the
polar seas' current check reads no sea (NaN, phase 4's subject); c5 has
19 % of its land under lakes (HEAD c6 the same, 19 %); c6 one river
reach rises over a metre (found, not fixed). c3 and c4 pass whole.

2026-10-11: phase 2 BUILT — the ocean age on the field mesh, both shapes,
one path (`tectonics/oceanAge.ts`). Spacing = the domain's width / 256
(the old raster's equator cell): 37 888 hexagons at 62.4 km on the torus
(the raster had 32 768 cells), 24 012 Goldberg cells at 78.1 km on the
sphere. Each epoch every cell's departure is its centre turned back
EXACTLY by its nearest plate's own motion (reversePointByMotion, as the
raster did; fieldOperators `departuresFromPoints`) — not the midpoint rule
on a velocity field, which would sample across a plate boundary and mix
two plates. The value there is the clipped Hermite transport (decided
above), then +1 epoch, capped at 180, and 0 under continental crust,
whose membership is asked at the cells' centres before the plates move
(the 128 × 64 membership raster and its sampler are gone). The ridge and
breakup resets walk the mesh from the cell holding the boundary point
(every centre within the radius). Readers per point (the baseline per
node, the flexure's Te) go through the sampler; the render's baseline
(the Archean's render and the scripts' — the history renders its own
terrain) through a 1024 × 512 raster of it, 93–115 ms (the sampler per
pixel 480–550 ms; mean 0.03 epochs off, at most 5.8 at a ridge's step).
The Archean has no field (null: age 0).

**Save** (fork 5 as revised, NOT a new formatVersion: the phases are one
move, version 8 stays): `oceanAge.f64` (Float64 per cell) + `oceanAge.json`
({ cells, spacingM }) in place of `oceanAge.f32`. A tectonic save without
them — a version-8 save from a phase-1 build among them — or of another
mesh is refused on open. The replay snapshot, the job worker's checkpoint
and the hand-over carry the mesh values (`fields/fieldMesh.SavedField`,
shared with the mantle). Save → load → continue is bit-identical
(pipeline harness).

**Measured** (2048 × 1024, seed `bench`, 100 Archean + 12 coupled epochs
at HISTORY_DEFAULTS, Node, one thread; the ocean-age step with its
membership timed on the state before each epoch). The ocean age feeds
nothing back into the plates, so plates and land are the same worlds:

| | torus HEAD | torus mesh | sphere HEAD | sphere mesh |
|---|---|---|---|---|
| ocean-age step per epoch | 9.9 ms | 22.4 ms | 26.6 ms | 37.4 ms |
| whole coupled epoch | 1170 ms | 1222 ms | 2243 ms | 2316 ms |
| plates at the hand-over / after 12 | 13 / 13 | 13 / 13 | 8 / 8 | 8 / 8 |
| land after 12 | 5.6 % | 5.6 % | 19.0 % | 19.0 % |
| highest node | 4452 m | 4680 m | 6011 m | 5880 m |
| ocean depth mean / p10 / p50 / p90 | 4393 / 2608 / 5068 / 5199 m | 4414 / 2610 / 5084 / 5200 m | 4419 / 2631 / 5128 / 5230 m | 4423 / 2631 / 5132 / 5231 m |

After 12 epochs most floor still holds its initial 40 + 12. The field's
character after 100 plain epochs more (+ 1 coupled), over the ocean:

| | torus HEAD | torus mesh | sphere HEAD | sphere mesh |
|---|---|---|---|---|
| mean age | 47.4 | 50.6 | 31.1 | 32.1 |
| p50 / p90 age | 31.4 / 127.3 | 30.9 / 141.0 | 15.6 / 104.9 | 16.1 / 120.1 |
| area aged 0–1 / 80–120 / 120–180 | 15.0 / 12.3 / 12.5 % | 14.4 / 8.3 / 17.9 % | 26.9 / 4.9 / 8.2 % | 26.9 / 3.2 / 10.0 % |
| young band at ridges, age ≤ 2 / 5 / 10 | 218 / 270 / 367 km | 220 / 281 / 376 km | 264 / 307 / 390 km | 263 / 304 / 388 km |
| ocean depth mean / p50 / p90 | 3750 / 4225 / 5584 m | 3758 / 4226 / 5626 m | 3127 / 2995 / 5356 m | 3126 / 2992 / 5307 m |

(The band's width is the area aged ≤ k over the ridges' length, the
length the age-0 area over the reset's diameter, 2 × 94 km on the torus.)
The young band is set by the reset radius and stays as it was; the old
floor keeps its age — the bilinear raster smeared the oldest crust into
its neighbours each epoch, the clipped Hermite does not (p90 +14 epochs).
The step costs 2.3 × (torus) and 1.4 × (sphere) the raster's: the
membership at 37 888 centres instead of 8 192 and a locate per departure;
4 % of an epoch.

**Golden**: 40 of 46 stages moved per world — the ocean age and everything
downstream of the baseline; the mantle, the boundary lattice's three
arrays, `climate.wind` and `artifact.pipelineVersion` did not, and the
plate, raft, feature, suture and volcano counts are unchanged — 107
metrics drifted, 0 hard failures, coverage kept (85 metrics
vary). No seed changed. Main shifts: land 8.40 → 8.46 % (calibration),
13.80 → 13.82 % (alpha), 15.86 → 15.85 % (zulu); plates 13 / 12 / 14
unchanged; highest point 1973 → 1910, 3184 → 3103, 5321 → 5609 m; deepest
−5439 → −5480, −5506 → −5506, −5759 → −6497 m. `golden.json`
re-recorded and the byte guard re-armed: 0 hard failures, 0 drifts, 46
stages byte-identical × 3.

2026-10-11: phase 1 BUILT — the mantle on the field mesh, both shapes, one
path (`mantle/mantleField.ts`). Spacing = the domain's width / 128 (the old
raster's equator cell): 9 472 hexagons at 124.8 km on the torus (the raster
had 8 192), 6 252 Goldberg cells at 156.3 km on the sphere (12 pentagons).
A diffusion pass is the raster's (κ dt = weight · h² / 4) as the explicit
finite-volume step, the flow the CG Poisson solve (1e-8) and the
least-squares gradient; membership is asked at the cell centres. Plume
sites, plate seeds (extrema over the Voronoi neighbours), nucleation
streaks, the plume hill-climb and the motion fit (area-weighted) walk the
mesh; recycling and the Archean's raft drift read it through the sampler;
dynamic topography per node through the sampler, the render's through a
256 × 128 corner raster (≤ 9 m off ±550 m, 14 ms at 2048 × 1024 against 400
for a locate per pixel). The pole rows, the line solver, the sub-steps and
the stride of nucleation candidates are gone. The 128 × 64 chart raster
survives only as the overlay (rasteriseMantle).

**Save** (fork 5 as revised): `mantle.f64` (Float64 per cell) + `mantle.json`
({ cells, spacingM }), `archean.mantle.f64` / `.json` and
`archean.streak.i16` per cell; formatVersion 8. A save without them, or of
another mesh, is refused on open. Save → load → continue is bit-identical
(pipeline harness: the replay lands on the saved mesh across a load).

**Measured** (2048 × 1024, seed `bench`, 100 Archean + 12 coupled epochs at
HISTORY_DEFAULTS, Node, one thread; the mantle's own work timed on a clone
of the state):

| | torus HEAD | torus mesh | sphere HEAD | sphere mesh |
|---|---|---|---|---|
| mantle per Archean epoch | 19.6 ms | 20.6 ms | 22.7 ms | 12.0 ms |
| mantle per coupled epoch (with the fit) | 21.6 ms | 22.7 ms | 30.9 ms | 16.6 ms |
| tectonics per coupled epoch | 47 ms | 50 ms | 84 ms | 66 ms |
| whole coupled epoch (different worlds) | 1159 ms | 1209 ms | 1988 ms | 2249 ms |
| plates at the hand-over / after 12 | 14 / 14 | 13 / 13 | 10 / 10 | 8 / 8 |
| plumes at the hand-over / after 12 | 4 / 3 | 5 / 3 | 2 / 1 | 3 / 2 |
| convection cells (extrema), epoch 25 / 100 | 21 / 14 | 22 / 13 | 11 / 10 | 13 / 8 |
| land at the hand-over / after 12 | 8.4 / 6.0 % | 7.7 / 5.7 % | 17.9 / 13.8 % | 16.2 / 17.3 % |
| field range at epoch 100 | −1.17…2.06 | −1.44…1.93 | −0.87…2.26 | −1.38…2.03 |
| length rms / rms ∣∇∣, epoch 25 / 100 | 329 / 432 km | 348 / 464 km | 424 / 548 km | 423 / 555 km |
| flow RMS, epoch 25 / 100 | 163 / 178 | 187 / 212 | 173 / 187 | 242 / 188 |

The CG solve is 85–90 % of the mantle's time (190 iterations on the torus,
152 on the sphere); the raster's Gauss-Seidel stopped at 260 sweeps short of
convergence at the longest wavelengths, so the converged flow is 10–30 %
stronger. The field's character (range, smoothness, cell and plume counts)
is the raster's.

**Golden**: every stage but `climate.wind` and `artifact.pipelineVersion`
moved (132 of 138), the metrics far past their bands as different worlds
(land 19.2 → 8.0 %, 6.5 → 13.8 %, 9.9 → 4.7 %), and no world kept a suture,
so tin was 0 on all three and the coverage check failed. The seed `bravo`
was replaced by `zulu`, of 24 probed seeds one of three with a suture and the
first tried that yields tin (golden.mjs, SEEDS); `golden.json` re-recorded and the byte
guard re-armed on the new worlds: 0 hard failures, 0 drifts, 46 stages
byte-identical × 3.

2026-10-11: decided for phase 2 — the ocean age is transported
semi-Lagrangian with the clipped Hermite interpolation (fieldOperators.ts
transportScalar with its gradient and `clip`): linear interpolation smears
the young ridges' age stripes away over the epochs; the clip keeps every
value inside its neighbours' range, so no age goes negative (mass +0.75 %
a revolution in Williamson test 1, against 0.007 % unclipped). The cell
frame is east/south, the Domain's (agreed the same day).

2026-10-11: DECIDED. Nothing built.

2026-10-11: phase 0 BUILT — the field mesh and its operators, used by no
stage (golden unchanged). `client/src/generator/fields/`: `fieldMesh.ts`
(the mesh, its geometry, the sampler, the chart rasters) and
`fieldOperators.ts` (the operators). `npm run harness:fields`
(`client/scripts/fields.mjs`, ~30 s, in `make test`) holds each operator
against an analytic answer at 312, 156, 78 and 39 km.

**The form.** Values on the vertices of `bootstrapLattice`'s triangulation
(geodesic on the sphere, hex on the torus), each owning its Voronoi cell.
Per cell, in Float64 and in metres: centre, unit vector, frame, true area;
per directed edge (CSR, a fixed order): wall, centre distance, the
neighbour's offset in the cell's tangent plane, the frame turn, the
least-squares gradient weights. The frame is the Domain's, east and SOUTH
(+y), so a vector goes into `Domain.advance` without a sign. Fields are
Float64Array; Float32 only where a field leaves (the raster). At 78 km
the sphere has 24 012 cells (mean √area 72.8 km; the areas vary × 2.0 on
the plain geodesic grid), the torus 24 190.

**Accuracy** (relative, area-weighted; the orders over 312 to 39 km, the
diffusion decay's over 312 to 78 km):

| Check | Sphere at 78 km | Sphere order | Torus at 78 km | Torus order |
|---|---|---|---|---|
| ∇² of Y_l, l = 1..4 / of Fourier modes (L2) | 1.4e-4 – 9.1e-4 | 1.7–1.9 | 5.9e-5 – 5.2e-3 | 2.0 |
| the same, L∞ | 2.4e-4 – 1.8e-3 | 0.7–2.0 (1.0 at the finest) | 6.1e-5 – 5.2e-3 | 1.7–2.0 |
| diffusion decay against exp(λκt), l = 4 | 3.9e-4 | 1.97 | 3.9e-5 | |
| gradient (L2) | 2.5e-4 – 1.7e-3 | 1.5–1.9 | 1.2e-4 – 1.0e-2 | 1.9–2.0 |
| divergence of the exact gradient (L2) | 1.9e-4 – 1.6e-3 | 1.8–2.0 | 1.2e-4 – 1.0e-2 | 1.9–2.0 |
| Poisson / Helmholtz against exact | 4.7e-4 / 2.6e-4 | 2.0 | 1.5e-3 | 2.0 |
| sampling at random points (RMS) | 4.2e-4 | 2.0 | 1.2e-3 | 2.0 |
| areas against 4πR² / W·H | 4e-15 | | 4e-14 | |

The sphere's L∞ is first order: the plain geodesic grid is irregular along
the icosahedron's edges and about the pentagons (Heikes & Randall 1995).
A tweaked or centroidal grid would make it second order; not needed for
phase 1, kept in mind for the climate.

**The solver.** Conjugate gradients with a Jacobi preconditioner on the
symmetric form (−K + αA)φ = −Af, to a relative residual of 1e-10: 226
iterations (Poisson) and 165 (Helmholtz) at 78 km on the sphere, 109 on
the torus, about doubling per halving of the spacing. Poisson removes the
right-hand side's mean (a closed surface). Implicit diffusion is the same
solve (α = 1 / κ dt): 49 iterations a step at 29 × the explicit limit.

**Transport.** Williamson test 1, α = 90°: a cosine bell over both poles,
one revolution, departures by the midpoint rule along the great circle.
Linear interpolation is monotone and diffusive (L2 0.43 at 78 km, Courant
~1). The default form extends each corner HALF way to the departure with
its gradient, Σ w_k (φ_k + ½ ∇φ_k · δ_k), exact for quadratics (the full
extension doubles the cubic-Hermite weight and blows up within a
revolution — measured): L2 1.9e-2 at 78 km, Courant ~1 (8.0e-3 at Courant
~4), order 1.9–2.2, mass drift 0.01 %, undershoot −7.5 of a 1000 bell; a
clip to the triangle's range makes it monotone (L2 2.3e-2, mass +0.75 %).
A vector carried by a solid-body wind turns by the trajectory's geodesic
curvature to 1e-6 of |v|max — the exact covariant answer.

**Timings** (ms, Node, one thread):

| Operator | Sphere 156 km | Sphere 78 km | Torus 156 km | Torus 78 km |
|---|---|---|---|---|
| build the mesh | 17 | 78 | 13 | 48 |
| build the sampler | 4.7 | 18 | 3.7 | 14 |
| ∇² / explicit diffusion step | 0.04 / 0.13 | 0.15 / 0.24 | 0.04 / 0.06 | 0.15 / 0.24 |
| gradient / divergence | 0.05 / 0.14 | 0.18 / 0.47 | 0.04 / 0.12 | 0.17 / 0.48 |
| departures (once per wind) | 12 | 47 | 5 | 19 |
| transport, linear / Hermite / vector | 0.02 / 0.10 / 0.11 | 0.08 / 0.40 / 0.41 | 0.02 / 0.10 / 0.05 | 0.08 / 0.39 / 0.15 |
| Poisson solve / one implicit step | 11 / 2.8 | 59 / 11 | 4.0 / 1.7 | 29 / 6.6 |
| 100 000 samples | 28 | 30 | 23 | 24 |
| rasterise 256 × 128 / 2048 × 1024 | 7.4 / 424 | 7.7 / 432 | 6.2 / 312 | 7.6 / 327 |
| from a raster: centres 256 × 128 / area-weighted 2048 × 1024 | 0.2 / 791 | 0.9 / 797 | 0.1 / 746 | 0.4 / 762 |

**Mutations.** Each ingredient removed, its check fails: the walls (mean
wall: ∇² error 1.2 on the sphere; on the near-regular torus the order
falls to 0), the areas (0.13), the frame turn (divergence 0.72), the
tangent plane (chart offsets: gradient 0.16), the half extension (L2
140).
