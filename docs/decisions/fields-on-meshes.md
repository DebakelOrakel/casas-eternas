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
stage: built
createdAt: 2026-10-11
updatedAt: 2026-10-14
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
   7b. The hydrology's raster parts (the routing, the discharge, the
   watersheds, the coast graph, the sediment basins) on the terrain mesh
   (split off phase 7, 2026-10-12).
8. Then the calibration — once, in metres: the constants now in cells
   (DEC-0035, fork 6's list), the plate count and the land fraction. It
   looks at the field mesh's twelve pentagons on purpose: the centroidal
   grid's ∇² keeps an error of about 1.2 % next to them at every spacing
   (phase 3); if a field shows it there, a Heikes–Randall correction is the
   remedy (agreed 2026-10-11).

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

2026-10-14: **phase 8f BUILT — the plates' speed in km/Myr, and the
lengths left in cells.** Measured with `npm run calibrate seeds=12
archeanMa=1000 landShare=30 sweep=1 sweeps=genesis.landShare
sweepSeeds=3` against 8e's run (12 worlds per shape, the same seeds), the
plates' speed new in the calibration (`speedPerEpoch`, `plateSpeed*`: the
velocity at each cell of the ocean age's mesh by its nearest seed's
plate, area-weighted, the mean over epochs 10–40); the diagnosis with the
plates' epochs alone (no erosion) to 200 and 600 epochs, 3 seeds per
shape. Earth: about 50 mm/yr = 50 km/Myr on the mean, 10–30 the
continental plates, up to about 100 the Pacific-type ones, 150–200 the
fastest in the past; the supercontinent cycle 400–600 Ma.

**The diagnosis.** Three causes, none a step size alone.

- *The scale lost its calibration twice.* A plate's motion relaxes toward
  the rigid fit of the mantle's surface flow, the gradient of the
  Poisson potential of the buoyancy — the flow grows with the
  wavelength of the buoyancy, so a supercontinent's broad insulation
  dome drives the fastest plates. The scale (MANTLE_TUNING.flowSpeedScale
  110, at 0.05 of the motion's time unit an epoch) was set when the
  flow's solve stopped short of the broadest modes (fixed in phase 1)
  and the land was a twelfth of the surface (30 % since 8b-1). Measured
  (no erosion, 2 seeds per shape): 18–29 km/Myr at the hand-over (the
  fresh motions), the fit's own speed 50–130 there, 90–135 on the mean
  over epochs 10–40 (175–200 at the peak, epochs 15–25, when the
  Archean's supercontinent domes), 58–125 over 200 epochs (with the
  spin held, below).
- *The sphere moved 25 % further.* The motions were in domain units: the
  sphere's unit is 9.77 km against the torus's 7.8.
- *Small plates spun.* A plate over 1–6 mantle cells near its seed has
  Σ w r² near 0, and its fitted spin was the flow's shear over almost
  nothing: 40–234 rad per unit of spin angle (torus, seed alpha, epochs
  84–92), 15 % of it kept each epoch, and the next epoch the plate's
  Voronoi cell grew back over 2000 cells and its rim ran at 1000–8000
  km/Myr (the area-weighted mean of the world 550–980). The sphere's
  3 × 3 fit has the same singularity about the seed's vertical; it
  stayed under 300 km/Myr in the runs.

There is no force balance in the model (no slab pull, no ridge push, no
basal drag): the plates follow the flow kinematically, and so the
speed is the flow's scale, one constant.

**The changes.**

- *The kinematics in physical units* (tectonics/plateMotion.ts): a
  motion is in domain units (radians) per Ma, an epoch moves it by its
  Ma (`sim.epochMa`, 1); `epochAngleStep` is gone. The tectonics reads
  the flow at its own scale, `TECTONICS_TUNING.mantleFlowSpeedKmPerMyr`
  (km/Myr per unit of the buoyancy's gradient per mantle cell), through
  `domain.metresPerUnit` — the sphere's plates move as far in metres as
  the torus's. The Archean keeps flowSpeedScale (its rafts, bit for bit).
  A fresh plate starts at 11.7–35.1 km/Myr (the torus's old 30–90 units
  per unit at 0.05). The boundary's deposit and its rift/merge
  accumulator are the epoch's convergence in km times
  `upliftPerKm` (the torus's old rate, 0.01 / (0.05 × 7.8 km)).
- *The spin at the mantle's cell*: the fit holds the spin as if the
  plate had one more cell, at rest, one spacing from its seed (Σ w r² +
  w̄ h² on the torus, w̄ h² ŝ ŝᵀ on the sphere): a plate of one cell
  turns no faster than the flow across one cell; a plate of N cells
  moves by about h² / (N r̄²).
- *The scale*: 42.9 km/Myr per unit was the torus's old one (53.7 the
  sphere's); 16 now. At 19 (12 worlds) the 40 epochs ran at 67 / 60
  km/Myr; 16 against 19 on 3 seeds changed nothing else beyond the
  seeds' spread.
- *Not tuned, decided by measurement*: the deposit per km was kept, not
  the deposit per epoch. Keeping the deposit per epoch (upliftPerKm ×
  2.26 at 19, 200 epochs, 3 seeds per shape) let the plate count fall
  to 3 on four of six worlds and run to 25 on two; per km it stayed
  7–17. HISTORY_DEFAULTS.upliftScale 5 against 4 (3 seeds) raised the
  mean land height 40–100 m but the peaks 0.8–0.9 km and the land above
  2000 m to 9 % on the sphere: not changed.

**The worlds** (12 per shape; medians, torus / sphere; before = 8e):

| | Earth | before | after |
|---|---|---|---|
| plate speed, area-weighted mean over epochs 10–40, km/Myr | ~50 | 90–135 (2 seeds, no erosion) | 58 / 52 (p10–p90 41–68 / 43–61) |
| p90 / fastest plate's mean, km/Myr | — / 100–200 | 120–275 / up to 8000 | 99 / 74; 104 / 79 |
| continental / oceanic cells, km/Myr | 10–30 / 50–100 | ~equal | 57 / 58 · 48 / 53 |
| speed at the hand-over, then per 10 epochs (mean) | — | 18–29, 55–105, 125–200, … | 22, 30 / 28, 64 / 56, 65 / 64, 66 / 62 |
| over 600 plain epochs (3 seeds) | — | 51–99 (at 42.9 with the spin held) | 33–43 / 9–26 |
| supercontinent assembly (largest continent ≥ 85 % after < 60 %), interval | 400–600 Ma | 75–160 Ma | 15–175 Ma (torus), noisy; see below |
| plates | — | 14.5 / 12 | 14.5 / 12 |
| land, % (target 30) | — | 30.2 / 25.0 | 32.3 / 27.7 |
| land at landShare 15 / 40 (3 seeds) | — | 15.8 / 37.4 · 13.8 / 37.3 (8b-1, 12 seeds) | 16.6 / 36.4 · 14.3 / 34.6 |
| largest landmass, % of the land | — | 82 / 72 | 68 / 63 |
| ocean depth mean / median, m | 3682 / ~4100 | 3503 / 3605 · 3506 / 3578 | 3987 / 4131 · 4126 / 4262 |
| 0–1 km / 1–4 km / 4–6 km / > 6 km, % of the ocean | 11.7 / 35.2 / 52.1 / 1.0 | 5.7 / 66.9 / 28.4 / 0.35 · 5.7 / 66.1 / 25.9 / 0.26 | 8.5 / 34.3 / 51.6 / 1.7 · 8.8 / 30.6 / 55.5 / 2.6 |
| floor age mean / median, Ma | ~62 / — | 12.7 / 8.4 · 9.9 / 7.2 | 31.5 / 16.6 · 34.6 / 19.6 |
| floor younger than 10 Ma, % | ~10 | 56.4 / 60.2 | 30.2 / 27.4 |
| shelf, % of the ocean | 7.3 | 2.6 / 2.8 | 4.1 / 4.5 |
| mean land height, m (target 700–900) | ~840 | 772 / 709 | 622 / 635 |
| land > 2000 / 3000 / 4500 m, % | ~5 / — / ~0.4 | 4.79 / 1.40 / 0.092 · 4.79 / 0.82 / 0.135 | 4.57 / 1.34 / 0.16 · 4.61 / 0.99 / 0.11 |
| land p99.9, m; peak, m | — | 4456 / 4635; 6015 / 5553 | 4835 / 4583; 6337 / 5674 |
| lakes, % of the land (open) | ~2–4 | 11.2 (4.3) / 6.7 (5.1) | 8.8 (3.5) / 6.5 (4.0) |
| ice, % of the land | ~10 | 38.2 / 13.6 | 35.3 / 13.8 |
| Köppen A / B / C / D / E, % | — | 11.4 / 23.2 / 9.1 / 19.3 / 36.6 · 21.0 / 29.6 / 17.7 / 18.9 / 10.0 | 11.9 / 26.0 / 9.9 / 22.3 / 30.8 · 25.0 / 29.4 / 17.5 / 17.3 / 10.7 |
| a history epoch, s (40 epochs) | — | 10.2 / 11.2 | 9.1 / 10.4 |

The ocean is now Earth's by its depth bands — the 4–6 km floor 52–56 %
(Earth 52), 1–4 km 31–34 % (35) — and its mean is 300–450 m deeper than
Earth's, because its shelves and slopes hold 4 % of it, not 7. The floor
is 2.5–3.5 × as old and still half of Earth's in 40 epochs: it starts at
`oceanAgeInit` 40 Ma at the hand-over, and the plates make it in the
window they have; over 600 plain epochs the mean age is 26–62 Ma. The
land share holds its target at 15 and 30 (±3); at 40 the sphere's three
seeds stand at 34.6 (median, −5.4; 8b-1 measured 37.3 on 12). The mean
land height fell 75–150 m below the 700–900 target, the 1–2 km band of
the land (above 1 km 17 % against 25 on the torus): in 40 Ma the slower
plates close less, and fewer continents collide (the largest landmass
68 / 63 % against 82 / 72); the high ground holds at the 40th epoch.

**The transient peaks** (the calibration's peak every tenth epoch, 24
worlds): above 10 km on 6 worlds after, 3 before; the highest 14.6 km
(epoch 30) after, 11.6 km (epoch 20) before. Torus juliett ends at 11.8
km. Not a node spike: the top node's neighbours stand 100–250 m lower,
and it is a narrow range that climbs about 0.9 km/Ma for 12 epochs, then
holds at 11.5–12.5 km. Two mechanisms that were there before 8f let such
a range escape. (1) The force balance reads a REGIONAL mean height (σ
150 km), so a narrow range in lowland is not held. (2) The buzzsaw cuts
only where the node has ice: juliett's top node had none in 30 of 40
epochs (dry). Before 8f the same seed reached 10.6 km at epoch 12, with
ice at the top in 35 of 40 epochs, and came down to 6.9 km by epoch 40.
8f amplifies them through the uplift: the history's uplift field is
normalised per world (elevation/upliftField, its peak is 1), so its rate
does not follow the plates' speed. A node that drifts through an orogen
at half the speed stays twice as long under the full rate. Golden's
calibration world shows it: its top region moves 78 km in 20 epochs at
16, against 226 km at the old scale (current code at 42.9). Its peak at
epoch 20 is 10.5 km at 16 and 6.1 km at 42.9 (6.9 km before 8f). Not
fixed: tying the uplift's rate to the convergence (a deposit rate per
feature, or the normalisation by a fixed thickness) is a model change.
It would need upliftScale calibrated again.

**The cycle** (600 plain epochs, 3 seeds per shape): the largest
continent's share of the continental area flickers as two continents
touch and part, so the interval between assemblies is noisy: 75–160 Ma
at the old scale (with the spin held), 15–175 Ma at 16 on the torus; on
the sphere one assembly in 600 Ma on one seed, none on the other two. Not
Earth's 400–600 Ma; the cycle is the mantle's (insulation, decay,
diffusion), and its speed of reorganisation is per epoch, not tied to
the plates.

**Found, not fixed.** (1) *Continental plates move as fast as oceanic
ones* (Earth: 2–5 × slower): no keel drag in the model; a speed by the
plate's continental share would be its first step. (2) *Clustered
seeds freeze a world*: on the sphere (seed zulu, 600 plain epochs at 16)
from about epoch 200 eleven seeds of twelve crowd one region, the
mantle's cells flip between them every epoch, a plate with no cell fits
no motion and relaxes toward rest, and the plates move at 6–10 km/Myr
against a fit of 35–50 for 400 epochs (the ocean age frozen with them);
at the old scale the same seed's floor went young everywhere instead.
No merge fires: the accumulators need convergence. Past the screen's
100 epochs, but the fit's nearest-seed footprint is the cause. (3) The
sphere's 40 % land share (above).

**The lengths left in cells, now metres** (DEC-0035 fork 6's list; the
torus's division exact, every value / 7 800 the old number of cells —
a 200-epoch torus run at the old scale prints the same speeds, plates,
land and ocean age at every fifth epoch): `trenchOffsetM` 468 000 (60),
`splitGapM` and `breakupFreshCrustRadiusM` 624 000 (80), `splitMaxDistM`
1 248 000 (160, a square in units² before), terrainFeatures'
`MERGE_RADIUS_M` 312 000 (40), the capsules' `rangeSegmentHalfLengthM`
273 000 (35) and `trenchSegmentHalfLengthM` 195 000 (25), the erodibility's
`sutureRadiusM` 351 000 (45), `sutureHalfLengthM` (the range's), the flood
basalts' `floodRadiusMinM` / `MaxM` 156 000 / 468 000 (20 / 60) and
`floodRadiusPerThicknessM` 15 600 (2); the plumes' separation
`PLUME_MIN_SEPARATION_M` 1 118 208 (0.14 of the chart's height, 1024
cells; 1400 km on the sphere before) and their speed
`PLUME_MAX_SPEED_KM_PER_MYR` 23.4 (3 cells an epoch). Already metres or
Ma: the climate's reaches, the coast's reaches and cliffs, the channel's
areas, the ecology's reaches. Left, with reasons: amplify's
`RELIEF_RADIUS_FRACTION` (1/64 of the level raster's width, 250 km on the
torus) and `RIDGE_OCTAVE_CELLS` (a chart lattice, not read through
globeOctaveOn) — the level bake's synthesis, keyed by AMPLIFY_CONSTANTS,
a change of its artifacts; the migration's costs per climate cell (its
own screen, not in the spec); the mantle's diffusion counted in its cells
(its mesh is by area, 125 km on both shapes); the per-epoch rates and
durations (an epoch is 1 Ma, fixed: they are Ma already, and the
Archean's 5 Ma epochs share MANTLE_TUNING's per-epoch rates by design).

Guards: `make lint`, `harness:roundtrip`, `harness:mesh`, `harness:fields`
pass; `harness:pipeline` passes with one fixture moved (the loaded
hydrology's world grows 24 Archean epochs, not 22: at 22 no river is wide
enough for a course, and the check compares courses). `harness:golden`:
at the slower plates no world of the three had a suture after its 20
coupled epochs. `tectonics.sutures`, `eco.tin.mean` and `eco.tin.rich`
were 0 on all three, and the coverage check failed. So 'november' took
the place of 'zulu', as in phase 1 (decided by the user). Of the 24
seeds from 'bravo' to 'yankee', 5 had a suture after 20 plain plate
epochs, and 2 had tin above 0 in golden's build (delta, november).
november is the more typical one (2 sutures, land 31.6 %, 17 plates).
Golden then re-recorded. Its two largest drifts were not bugs.
`erosion.deltaCells` (+1527 % on calibration) counts every sea cell
whose height rose over the last epoch. The sea level's change moves
every sea node (coupledEpoch's seaShift). After 8f, the sea fell 0.7 m
in calibration's last epoch (it rose 9 m before), so the count took in
nearly the whole ocean. Among the probed seeds the count is 90–124 k or
1.35–1.44 M, by that sign. This is a weakness of the metric from before
8f, reported, not fixed. `elevation.maxM` (6.9 → 10.5 km) is the
transient peak above.
The ocean age's and the mantle's pentagons on the sphere: max |z| 0.76 /
1.79 (median of 12), mean rank 0.36 / 0.46 — no field-mesh operator was
touched.

2026-10-14: **phase 8e BUILT — the ocean depth.** Measured with `npm run
calibrate seeds=12 archeanMa=1000 landShare=30 sweep=0` before and after
(12 worlds per shape, the same seeds); the ocean's distributions are new
in the calibration (scripts/calibrate.mjs, `oceanBands`, the shelf, the
ridges, the trenches, the depth by the floor's age); the diagnosis on 2
seeds per shape with the plates' epochs alone (no erosion) in a copy of
the code. Earth: mean depth 3682 m (Eakins & Sharman 2010), median about
4100 m; the floor by depth, % of the ocean (Charette & Smith 2010):
0–200 m 7.30, 200–1000 m 4.38, 1–4 km 35.22, 4–6 km 52.08, deeper than
6 km 1.02 (6–7 km 0.89, 7–8 km 0.09, deeper 0.04); the deepest 10 935 m;
GDH1 (Stein & Stein 1992) d = 2600 + 365 √t to 20 Ma, 5651 −
2473 e^(−0.0278 t) after; trenches 50–100 km wide, 3–4 km below the
floor around them, deeper on older plates (Grellet & Dubois 1982; Hilde
& Uyeda 1983), some 50 000 km of convergent margins; the mean age of the
ocean floor about 60–64 Ma, 10 % of it younger than 10 Ma.

**The diagnosis.**

- *The depth law is right.* On the open ocean (no margin under the node)
  the depth by the floor's age follows GDH1 within 1–3 % in every band
  (the table below): the floor is as deep as its age says.
- *The age is wrong — the floor is young.* Mean age 11–13 Ma, median
  7–8 Ma, 56–59 % younger than 10 Ma (Earth: ~62 Ma, ~10 %). Two causes.
  (1) The ridges' new crust: a disc of 93.6 km
  (`ridgeFreshCrustRadiusM`) was reset to age 0 around every divergent
  boundary point every epoch, whatever the plates opened; 23–27 % of the
  ocean was younger than 2 Ma (Earth ~2 %). (2) THE PLATES ARE 2–4 ×
  TOO FAST: measured as the cells' displacement per epoch (the torus's
  calibration seed), 18 km/Myr at
  the hand-over, 70–175 km/Myr after 10–20 epochs (the mantle coupling
  fits the motions to the flow), 86 km/Myr after 40 (Earth: 20–100 mm/yr,
  a mean near 50). Fast plates make young floor, and young floor is
  shallow — physically right for the motion, as Earth's Cretaceous
  ocean was shallower under faster spreading. With the plates' step a
  third (epochAngleStep 0.0167, a probe, not a change) the speed is
  48–52 km/Myr and the floor's mean age 41 Ma after 40 epochs, the
  baseline's mean depth 4450 m. The plates' kinematics are the
  calibration's next decision (they are in domain units on purpose,
  see the generator's CLAUDE.md) and move every stage; not changed here.
- *No trench.* The history's engine applies the tectonic uplift on land
  only and the deep ocean is frozen, so the trench features' negative
  thickness never reached the sea floor: the deepest node 5.9 km (torus)
  and 5.8 km (sphere) at the median, nothing below 6 km. The trench features are a poor
  line for one anyway: they stand `trenchOffset` (60 units, 468 km)
  inside the subducting plate, and 840–910 of them were active after 40
  epochs — as a depression they covered 6–11 % of the ocean below 6 km.
- *The shelf is narrow and short.* 2.7 % of the ocean (Earth 7.3 %),
  34–38 km wide at the median (p10 12, p90 80–90 km; Earth 50–80 km
  typical), active margins a little narrower than passive ones (29–37
  against 39–41 km). On the raster baseline alone the mean width is
  38–48 km and the coast 64–66 k km long: the coastline at 8–31 km nodes
  is far smoother and shorter than Earth's, so even an Earth-wide shelf
  would hold about half its share. Not changed (the margin profile's
  stops, elevationScale.MARGIN_STOPS, also place the shoreline and the
  Archean's land).

**The changes.**

- *The ridges' new crust is the strip the plates open* (tectonics/
  oceanAge.advectOceanAge with the seeds where the epoch found them): a
  cell whose departure lands on another plate than its own holds crust
  that did not exist on its plate an epoch ago, so its age is half an
  epoch. At a divergent boundary the strip is as wide as the opening; at
  a convergent or a transform boundary no departure crosses. The disc
  reset per boundary point is gone (`ridgeFreshCrustRadiusM` removed);
  the breakup's reset stays. The floor younger than 2 Ma falls from
  23–27 % to 16–17 %; the floor younger than 10 Ma does not move: the
  plates' speed sets it.
- *A trench where an oceanic plate subducts* (tectonics/trench.ts, a term
  under the history's baseline, elevationField.raftBaselineAt's `below`):
  on the plate boundary itself — at a point, the bisector of its two
  nearest seeds, where the two converge as a subduction or an island arc
  — with a smoothstep cross-section of `trenchHalfWidthM` 50 km either
  side, and a relief below the floor of `trenchReliefPerSubsidence` 1.6 ×
  the floor's thermal subsidence there (2.3, 3.7, 4.8 km on 15, 45,
  150 Ma floor; Earth's Middle America, Peru–Chile and Mariana). In the
  baseline, not in the relief: the slab holds the floor down, no load,
  so the trench moves with the boundary and goes the epoch its
  subduction stops. It fades out at the continental slope's foot
  (elevationScale.SLOPE_FOOT_T), so the shelf and the land keep their
  profile and the land's own subsidence at a trench margin stays the
  engine's. A function of the saved state alone: a restored world
  evaluates the same term.
- *No floor in the history.* The −1 (−9000 m) clamp went from the
  coupled epoch (6 places): a trench on 80 Ma floor reaches 10 km. Every
  consumer was checked: the save holds the mesh's z as float32; the
  colour ramp clamps itself at −1 (its deepest stop); the sample world's
  u16 encoding clamps (the Planet step's picture only); the climate, the
  hydrology, the erosion's frozen ocean and the sea level read the depth
  as a depth. golden's floor invariant is a runaway check now (−15 000 m,
  as the ceiling's +15 000 m). The synthesis (computeElevation) keeps −1
  under its own trench deck, whose thickness sums the boundary's
  convergence past −40 and would cut 20 km deep.

**The worlds** (12 per shape; medians; torus / sphere):

| | Earth | before | after |
|---|---|---|---|
| ocean depth mean, m | 3682 | 3423 / 3408 | 3503 / 3506 |
| p10 / p50 / p90 / p99, m | ~ — / 4100 / — / — | 2411 / 3586 / 4565 / 5500 · 2513 / 3564 / 4398 / 5378 | 2625 / 3605 / 4551 / 5530 · 2571 / 3578 / 4357 / 5239 |
| 0–200 m, % of the ocean | 7.30 | 2.66 / 2.66 | 2.59 / 2.76 |
| 200–1000 m | 4.38 | 3.09 / 2.91 | 3.07 / 2.90 |
| 1–4 km | 35.22 | 63.1 / 65.9 | 66.9 / 66.1 |
| 4–6 km | 52.08 | 30.3 / 27.7 | 28.4 / 25.9 |
| deeper than 6 km | 1.02 | 0.00 / 0.00 | 0.35 / 0.26 |
| deeper than 7 km | 0.13 | 0 / 0 | 0.19 / 0.09 |
| deepest, m (median; the most) | 10 935 | 5915 (6413) / 5761 (6925) | 9815 (10 069) / 8511 (10 041) |
| shelf width, km (active / passive) | 50–80 | 34 (30 / 39) / 38 (38 / 40) | 34 (29 / 41) / 38 (37 / 39) |
| floor 0–2 Ma: share, %; depth, m (GDH1 at its age) | ~2; 2600 at the crest | 16.6 / 18.3; 2615 / 2675 (2600) | 8.2 / 9.7; 2910 / 2970 (2974 / 2988) |
| floor age mean / median, Ma | ~62 / — | 12.8 / 8.1 · 11.1 / 7.3 | 12.7 / 8.4 · 9.9 / 7.2 |
| floor younger than 10 Ma, % | ~10 | 55.8 / 58.7 | 56.4 / 60.2 |
| land, % of the surface | — | 30.2 / 25.0 | 30.2 / 25.0 |
| mean land height, m | — | 769 / 706 | 772 / 709 |
| land > 2000 / 3000 / 4500 m, % | ~5 / — / ~0.4 | 4.58 / 1.43 / 0.077 · 4.72 / 0.82 / 0.124 | 4.79 / 1.40 / 0.092 · 4.79 / 0.82 / 0.135 |
| land p99.9, m; peak, m | — | 4364 / 4662; 5930 / 5524 | 4456 / 4635; 6015 / 5553 |
| lakes, % of the land (open) | ~2–4 | 11.1 (4.2) / 7.0 (5.2) | 11.2 (4.3) / 6.7 (5.1) |
| ice, % of the land | ~10 | 38.3 / 13.2 | 38.2 / 13.6 |
| mean temperature, °C | — | 5.47 / 14.46 | 5.49 / 14.50 |
| Köppen A / B / C / D / E, % | — | 11.3 / 22.9 / 9.3 / 19.5 / 36.4 · 21.2 / 29.7 / 17.4 / 19.0 / 10.1 | 11.4 / 23.2 / 9.1 / 19.3 / 36.6 · 21.0 / 29.6 / 17.7 / 18.9 / 10.0 |

**The depth by the floor's age** (open ocean, median depth / GDH1 at
the bin's median age, m; after; torus · sphere): 0–2 Ma 2910 / 2974 ·
2970 / 2988; 2–5 Ma 3254 / 3278 · 3300 / 3265; 5–10 Ma 3580 / 3579 ·
3609 / 3565; 10–20 Ma 4036 / 4002 · 4100 / 4036; 20–40 Ma 4504 / 4410 ·
4484 / 4367; 40–60 Ma 5110 / 5026 · 5076 / 5007; 60–80 Ma 5430 / 5352 ·
5378 / 5326; 80–120 Ma 5497 / 5383 · 5500 / 5383 (before the same
within 1–3 %; the law's asymptote is ABYSSAL_FLOOR 5700 m against
GDH1's 5651).

The trench gives the ocean its deep tail — a deepest point of 8.5–10 km
in the medians, 10.1 km at the most, a third to a quarter of Earth's
share below 6 km — and the land, its heights, the lakes, the ice, the
climate and Köppen stay within the worlds' spread: no stage above the
sea reads the deep floor. The ocean stays 180 m shallower than Earth's
on the mean and 500 m on the median, and its 4–6 km band half of
Earth's: the floor is young because the plates are fast. The trench's
share below 6 km follows the floor's age too (on 10 Ma floor the trench
reaches 5.6 km). Not checked here: the outer rise, the trenches' sediment
fill, the island arcs at sea (the engine's uplift is on land only, so an
arc in open ocean does not rise in the history either). The ocean age's
pentagons on the sphere: max |z| 1.56 (median of 12; 0.48 before), mean
rank 0.40 (0.36) — inside the hexagons' spread; no field-mesh operator
was touched (the transport's departures are the same; a cell's new
crust is a per-cell mark).

2026-10-13: **phase 8d BUILT — the glacial buzzsaw.** The user's goal:
ranges stand about 1–2 km over their snow line (ELA), as on Earth
(Brozović, Burbank & Meigs 1997; Mitchell & Montgomery 2006; Egholm et
al. 2009), the land above 6000 m falls towards Earth's share, rare 7–9 km
summits stay possible where the uplift outruns the ice, and the planet's
levers reach the mountains' height through the ELA. Measured with `npm
run calibrate seeds=12 archeanMa=1000 landShare=30 sweep=1
sweeps=planet.obliquity,climate.contrast` after (12 worlds per shape, the
sweep on 3), against 8c's run before (the same 12 worlds; 8c′ changed no
world) and the same sweep on HEAD; the diagnosis and the variants on 3
seeds per shape, the history instrumented in a copy of the code.

**The diagnosis** (4 worlds, the land binned by its height over its
ELA, per epoch):

- The high land is under ice: every node more than 500 m over its line
  holds 230–640 m of it. The ice body (glacial.ts, the surface carried
  out at most 3 % over the walls) is a smooth cap over the range, so its
  sliding (thickness × surface slope) is 5–20 m and the cut 0.1–0.2 mm/yr
  — at the peaks, where the uplift is 0.2–1 mm/yr and on a fast range
  2–3 mm/yr. The rivers rest under the ice, so the hillslope and the cap's
  sliding were all that took the peaks down.
- The old buzzsaw term (×2 on the sliding cut within 300 m of the ELA)
  does not reach the land it is for: the peaks stand 2–5 km over the line.
- The glaciers that plane a range — cirque and valley glaciers a few
  kilometres long — are inside a node (8–31 km); the mesh cannot resolve
  them, so they need a law of their own.
- A wide cut comes back as rebound (the plate returns 82 % of it), and so
  does a wide uplift: a range stands where the cut equals the uplift.
- Many of the highest peaks have no snow line to be planed towards: the
  torus's at the poles (the line at sea level, the snow 100–400 mm/yr),
  some of the sphere's in a rainless belt (no ice at any height). Both
  are as on Earth (Antarctica's ranges; the dry Andes) and are left.

**The model** (surface/glacial.ts `glacialErosionOnMesh`, the code
comments have the derivation): the node's own glaciers carry its
accumulation `b` down the drop `R = z − ELA` to the line as plastic ice
(thickness `τy / (ρ g S)`, Nye), so their speed is `u = b R ρ g / τy` —
the glacier's length cancels and the mesh's resolution does not enter —
and the bed erodes with the sliding (Hallet: `ė = Kg u`). So `dR/dt = −κ
b R`, applied over the epoch exactly, `R (1 − e^(−κ b Δt))`: never below
the line and no limit to the step. `κ` = SURFACE_TUNING
`glacialBuzzsawPerBalance` 6.7e-7 per metre, 1/13 of Hallet's `Kg =
1e-4` with `τy = 100 kPa` for a node that is all glacier bed (Kg is known
to an order of magnitude, Koppes et al. 2015). It replaces the Gaussian
term (`glacialBuzzsawBoost`, `glacialBuzzsawBandM` are gone). A wet range
is planed fast, a dry or a polar one slowly, and a lower ELA takes its
ranges down with it. No height cap; the sliding cut keeps its per-epoch
cap (`glacialErosionMaxM`, phase 6), which the buzzsaw does not pass
through. harness:mesh's glacier test checks the bound that holds now: a
node's cut is at most the cap plus its height over its line.
harness:pipeline's test of a loaded world's hydrology grows its world for
22 Archean epochs, not 20: without the Gaussian the 20-epoch world's
trunk river runs through a chain of lakes and has no reach long enough
for a course to compare.

**The variants** (3 seeds per shape, medians, torus / sphere):

| variant | peak, m | > 4500 m, % | > 6000 m, % | land p99.9, m | lakes, % |
|---|---|---|---|---|---|
| before (8c) | 6859 / 7661 | 0.15 / 0.22 | 0.0096 / 0.054 | 4658 / 5456 | 9.7 / 5.8 |
| κ 6.7e-7, the Gaussian kept | 5838 / 5871 | 0.060 / 0.21 | 0 / 0 | 4338 / 4868 | 9.3 / 6.5 |
| **κ 6.7e-7 (chosen)** | 6257 / 5839 | 0.083 / 0.23 | 0.0047 / 0 | 4363 / 4863 | 9.0 / 5.7 |
| κ 1e-6 | 5697 / 5790 | 0.085 / 0.21 | 0 / 0 | 4425 / 4836 | 12.8 / 5.6 |
| κ 2e-6 | 5045 / 5652 | 0.067 / 0.17 | 0 / 0 | 4284 / 4660 | 13.2 / 5.6 |

**The worlds** (12 per shape; medians, the extremes in brackets):

| | Earth | torus before | torus after | sphere before | sphere after |
|---|---|---|---|---|---|
| peak, m | 8849 | 6589 (3727–9373) | 5930 (3501–8545) | 6795 (4615–8628) | 5524 (4545–8105) |
| worlds with a peak ≥ 7 km / ≥ 8 km | — | 5 / 2 | 3 / 1 | 6 / 1 | 1 / 1 |
| peak over its ELA, m | ~1000–1500 | 4600 | 4479 | 2429 | 1685 |
| alpine peak over its ELA, m (the highest with a line above the sea) | — | 2388 (3 seeds) | 2219 | 4199 (3 seeds) | 1685 |
| most land over its ELA, m | — | 5345 | 4977 | 3737 | 2700 |
| land over its ELA, % | — | 38.3 | 38.6 | 11.0 | 11.3 |
| > 2000 m, % of the land | ~5 | 4.70 | 4.58 | 4.81 | 4.72 |
| > 3000 m | — | 1.39 | 1.43 | 0.78 | 0.82 |
| > 4500 m | ~0.4 | 0.152 | 0.077 | 0.179 | 0.124 |
| > 6000 m | ~0.001 | 0.0095 | 0.0024 | 0.0093 | 0.0000 |
| land p99.9, m | — | 4686 | 4364 | 4872 | 4662 |
| largest patch > 4500 m, k km² | Tibet ~2500 | 31 | 18 | 21 | 24 |
| mean land height, m | — | 768 | 769 | 708 | 706 |
| land, % of the surface | — | 30.2 | 30.2 | 25.0 | 25.0 |
| lakes, % of the land (open) | ~2–4 | 11.9 (4.7) | 11.1 (4.2) | 7.2 (5.7) | 7.0 (5.2) |
| ice, % of the land | ~10 | 38.1 | 38.3 | 13.1 | 13.2 |
| mean temperature, °C | — | 5.44 | 5.47 | 14.5 | 14.5 |
| Köppen A / B / C / D / E, % of the land | — | 11.2 / 23.5 / 9.4 / 19.7 / 36.2 | 11.3 / 22.9 / 9.3 / 19.5 / 36.4 | 20.8 / 29.8 / 17.7 / 18.8 / 10.0 | 21.2 / 29.7 / 17.4 / 19.0 / 10.1 |

The buzzsaw takes the top off and leaves the rest: the land above 6000 m
falls 4× on the torus and to nil (median) on the sphere, the peaks by
0.7 and 1.3 km, while the land below 3000 m, the mean height, the land,
the lakes, the ice and the climate stay within the worlds' spread (no
lake is added in the medians: the lakes fell by 0.2–0.8 points, within
the noise). Fast ranges still stand high: one world in
twelve per shape has a peak above 8 km. The torus's highest peak still
stands 4.5 km over its line: on most torus worlds it is a polar range,
where the line lies at the sea and the snow is scarce; the alpine peaks
(a line above the sea) stand 2.2 km over it. The land above 4500 m falls
below Earth's 0.4 % (it was below before): Earth's lies mostly on Tibet,
a dry plateau under its snow line, and the generator makes no plateau as
wide (the largest patch above 4500 m is 18–24 k km²) — the uplift's
matter, not the ice's. The pentagons of the sphere's flexure mesh: max
|z| 1.02 (median of 12), mean rank 0.47 — no field-mesh operator was
touched.

**The levers** (3 seeds per shape; the mean change against the same
seeds' default worlds; torus / sphere):

| | ice, points | > 4500 m, % of the land | > 6000 m | land p99.9, m | peak, m |
|---|---|---|---|---|---|
| tilt 10°, before | +5.7 / +7.9 | −0.077 / +0.002 | −0.008 / −0.012 | −185 / −166 | −164 / +507 |
| tilt 10°, after | +5.9 / +7.9 | −0.018 / −0.016 | −0.003 / +0.002 | −187 / +28 | −178 / +402 |
| tilt 35°, before | −11.7 / −7.6 | +0.147 / +0.007 | +0.007 / +0.003 | +297 / −24 | +144 / −174 |
| tilt 35°, after | −11.0 / −7.5 | +0.007 / +0.025 | −0.003 / −0.001 | +37 / +39 | +16 / −64 |
| contrast 60 %, before | −8.0 / −6.7 | +0.102 / −0.007 | +0.003 / +0.004 | +181 / −7 | +100 / +381 |
| contrast 60 %, after | −8.0 / −6.7 | +0.021 / −0.004 | −0.003 / +0.001 | +35 / +1 | −348 / +164 |
| contrast 140 %, before | +2.2 / +6.3 | −0.109 / −0.003 | −0.003 / −0.004 | −156 / +9 | +153 / −13 |
| contrast 140 %, after | +2.7 / +6.0 | −0.028 / −0.023 | −0.003 / +0.000 | −309 / +101 | −131 / +258 |

The coupling has the sign the physics gives in seven of the eight
cases — more ice (a small tilt, a strong contrast) is less high ground,
less ice more — but it is small against three seeds' noise: 2–3
hundredths of a point of the land above 4500 m (10–20 % of it), up to
300 m of the p99.9. On the sphere it is new (HEAD: under a hundredth).
On the torus HEAD coupled more strongly (±0.08–0.15 points, a third to
a half of the high land): there the ice took the rivers' cut away and
put only the cap's slow sliding in its place, so how much high land
stood depended on where the ice lay; now the buzzsaw holds it near the
line, and the torus's highest ranges are mostly polar, where the snow is
scarce and the buzzsaw slow. The tilt and the contrast move the
ELA most at high latitudes; the ranges at middle latitudes, which the
buzzsaw holds, see little of it. A colder planet as a whole (the
greenhouse) lowers the line everywhere; not swept.

2026-10-13: **phase 8c′ BUILT — a suture's age in Ma.** Found in 8b-2:
the erodibility field (elevation/erodibilityField.ts) read a suture's
age as `currentEpoch − suture.epoch`, in epochs of the continuous axis,
on which an Archean epoch is 5 Ma and a tectonic one 1 Ma — the unit
mistake 8b-2 removed from the cratons' oldness. The age is now
`worldEpochMa(now) − worldEpochMa(stamp)`, and the two limits are in
Ma: `freshSutureMa` 80 and `oldSutureMa` 240, the old 80 and 240 epochs
of the tectonic era at its 1 Ma per epoch, so a suture of the tectonic
era keeps its factor. Regression test in harness:pipeline (a stamp 50
epochs before the end of a 200-epoch Archean, read 20 tectonic epochs
later: 70 epochs, fresh, before; 270 Ma, old, after).

No world changes today: only the tectonic era makes sutures (the
Archean discards its merges, finalizeArchean hands over none), so the
stamp and the clock are both past the hand-over and the two
differences are equal. The fix makes the field correct for any stamp
on the axis. Golden's stage hashes and `npm run calibrate seeds=3
sweep=0 archeanMa=1000 landShare=30` are unchanged. The other readers
of the stamps: the ecology reads the sutures' positions only; the
merge immunity (`noMergeUntilEpoch`) is set and read in the tectonic
era only.

2026-10-13: **phase 8c BUILT — the lakes: the routing follows the
epoch, the folds are averaged over the node.** The user's goal: lakes at
most about 8–10 % of the land. After 8b-3 the lakes (all, the frozen
included) stood at 16.1 % of the land on the torus and 10.9 % on the
sphere, the open water at 7.4 and 8.5 % (12 worlds per shape, medians).
Measured with `npm run calibrate seeds=12 archeanMa=1000 landShare=30
sweep=0` on HEAD and after; the diagnosis and the variants on 2–3 seeds
per shape, with the history instrumented in a copy of the code.

**The diagnosis.** The guess of 8b-3 — the flexural moats beside the
ranges, filled only by later deposits — is not the cause:

- The lake area in a moat (a node the plate lowered by more than 200 m
  over the history, within 300 km of land above 2000 m) is 0.5–2.5
  points of the land; three quarters of the lake area lie more than
  300 km from such land.
- The epoch's last step does not make them: the lakes on the terrain
  without the last epoch's deflection — all of it, or its deposit, cut,
  uplift or other part alone — differ by −2.6 to +2.1 points, in
  both directions.
- Sediment is not short: for most open lakes what arrives in an epoch
  is one to a thousand times their volume.
- The lakes are made and filled inside every epoch. Late in a history
  (torus calibration seed, epochs 30–40) the lakes stand at about 12 %
  of the land when an epoch ends; the motion, the rebuild and the
  baseline add about 1 point, the ice's cut and till 2, the erosion takes
  3.5 off, the coast, the flexure and the sea move it by ±1. Of the lakes
  a world ends with, 60–69 % were flooded when the last epoch's erosion
  started and 23–34 % formed during it.
- What forms them during the run: the epoch's four iterations (1 Myr)
  ran on the routing of its start (`routingEvery` 4). An uplift that
  rises across a river is a dam the river does not see — the stream power
  cuts only towards a lower receiver — and a basin it makes is not one
  the deposits see — their cap is the flood level of the epoch's start.
  At forcing 1 the uplift raises the crust by about a kilometre per
  iteration since 8b-3 (upliftScale 0.5 → 4), so the stale routing costs
  more than before: with upliftScale 0.5 the lakes fall by 2.4–5.4
  points (and the peaks to 1.3–1.5 km). The folds (tectonics/folds.ts,
  λ 15 km) add to it: the history's land nodes are 8–31 km wide, the
  train sampled at their centres is node-to-node noise of ±50 % in the
  uplift, and every rising range gets closed basins between neighbours —
  1.3–2.2 points with the folds off.
- 8b-3's finding 2, the sea-spaced nodes that become land before the next
  remesh: lake area on nodes larger than 20 000 km² is 0–0.1 points of
  the land. Not a cause.

**The variants** (2 seeds per shape; all lakes, points of the land
against HEAD, per world):

| variant | Δ lakes |
|---|---|
| sediment under a basin's level settles as in still water, no donor floor in an enclosed basin | +0.5 to −1.8 |
| the river's base level at a lake's surface, not its bed | 0 to +5.4 |
| the uplift's flexural answer applied during the run | 0 to −1.2 |
| the glacial cut off (a diagnosis) | −0.6 to −1.8 |
| the folds off (a diagnosis) | −1.3 to −2.2 |
| the routing before every iteration | −1.3 to −3.2 |
| **the routing before every iteration and the folds averaged over the node (chosen)** | −1.9 to −11.3 (3 seeds) |

**The model** (the code comments have the reasons):

- *The routing per iteration* (pipeline/coupledEpoch.ts
  `HISTORY_DEFAULTS.routingEvery` 1): the flood, the lake levels and the
  receivers are computed afresh before each of the epoch's iterations,
  on both engines — the pool on its synchronous cadence at depth 1, which
  gives the single engine's bytes (harness:mesh checks it), so the
  screen's session and the job worker's replay still agree. A rising dam
  is a basin at the next iteration, its outlet cuts, and the deposits
  fill it to its level. The history's time grew by 0–6 % (the variants'
  runs side by side).
- *The folds averaged over the node* (tectonics/folds.ts `foldFactorAt`,
  the node's spacing): the train's mean over a window of the node's width
  across the range, sinc(π s / λ) times its centre value. A node as wide
  as the wavelength or wider takes about the mean; a tile's nodes, a few
  kilometres apart, keep the train.

**The worlds** (12 per shape; medians, the extremes in brackets):

| | Earth | torus before | torus after | sphere before | sphere after |
|---|---|---|---|---|---|
| lakes, % of the land | ~2–4 | 16.1 (9.3–20.0) | 11.9 (5.9–17.7) | 10.9 (7.4–21.3) | 7.2 (4.8–13.5) |
| of them open water | — | 7.4 (3.4–10.3) | 4.7 (2.2–8.5) | 8.5 (6.6–17.5) | 5.7 (3.0–13.2) |
| worlds above 10 %, all / open | — | 11 / 2 | 9 / 0 | 7 / 3 | 3 / 1 |
| lake bodies | — | 2705 | 1347 | 2063 | 947 |
| terminal seas | — | 124 | 106 | 70 | 60 |
| land, % of the surface | — | 30.3 | 30.2 | 25.1 | 25.0 |
| > 2000 m, % of the land | ~5 | 5.48 | 4.70 | 6.18 | 4.81 |
| > 3000 m | — | 1.52 | 1.39 | 1.01 | 0.78 |
| > 4500 m | ~0.4 | 0.17 | 0.15 | 0.20 | 0.18 |
| > 6000 m | ~0.001 | 0.0085 | 0.0095 | 0.019 | 0.0093 |
| peak, m | 8849 | 6481 (9454) | 6589 (9372) | 6669 (8319) | 6795 (8628) |
| largest patch > 4500 m, k km² | — | 36 | 31 | 22 | 21 |
| mean land height, m | — | 809 | 768 | 751 | 708 |
| ice, % of the land | ~10 | 37.9 | 38.1 | 13.8 | 13.1 |
| river reaches | — | 2552 | 1922 | 2145 | 1541 |
| mean temperature, °C | — | 5.38 | 5.44 | 14.4 | 14.5 |
| Köppen A / B / C / D / E, % of the land | — | 10.9 / 23.5 / 9.4 / 19.3 / 36.3 | 11.2 / 23.5 / 9.4 / 19.7 / 36.2 | 20.2 / 29.4 / 18.5 / 19.1 / 10.3 | 20.8 / 29.8 / 17.7 / 18.8 / 10.0 |

The open water is now 4.7 and 5.7 % of the land. What is left of the
torus's 11.9 % is mostly frozen: basins under its ice sheets (the torus
holds 38 % of its land under ice), 3.7–7.2 points on the seeds measured —
the beds the ice's cut and load deepen, counted as frozen lakes because
computeLakesOn does not know the ice. Whether a basin under an ice sheet
counts as a lake is a question for the metric, not for the physics; not
changed here. The land's hypsometry moved down a little below the peaks
(> 2000 m −0.8 and −1.4 points, the mean land −41 and −43 m: the rivers
now cut through the dams an uplift raises), the peaks and the land above
4500 m stay within the worlds' spread. The reaches fell by a quarter:
a lake ends a reach, and half the lakes went. The pentagons of the
sphere's flexure mesh: max |z| 0.90 (median of 12), mean rank 0.46 — no
field-mesh operator was touched.

2026-10-13: **phase 8b-3 BUILT — the peaks, by the plate's flexure, no
hard cap.** The user's goal: Himalaya-class ranges must be possible, with
no hard cap. Before, the peaks topped out by two caps: the per-point soft
knee on the synthesis's deck ([uplift-soft-knee.md](./uplift-soft-knee.md),
DEC-0027, 3000/3000 m) and the ±1 = 9000 m clamp (computeElevation, the
engine's kernelUplift, the epoch's steps). Measured with `npm run calibrate
seeds=12 archeanMa=1000 landShare=30` (12 worlds per shape, 40 epochs) on
HEAD and after; the variants on 3 seeds per shape.

**The model** (the code comments have the reasons):

- *The deck's isostasy* (pipeline/coupledEpoch.ts `deckDeflection`): the
  synthesis's uplift deck is the raw crustal thickness as height, and the
  plate carries its positive part as a load on the flexure's mesh, with
  the same elastic thickness per cell as the history; the deflection goes
  into the baseline. A deck wider than the flexural parameter sinks
  towards its Airy share, 1 − ρc / ρm = 0.18; a narrow one stands on the
  plate's strength. The knee is removed. (Only a world with features
  takes this path — a world restored from before its history; the
  screen's history starts at the hand-over, which has none.)
- *The history's uplift is a load* (stepCoupledEpoch, the flexure): the
  engine's uplift (its ledger `upliftNet`, m³) is crustal thickening, or
  a rift's thinning, and the plate takes it with the epoch's cuts and
  deposits — both signs. `HISTORY_DEFAULTS.upliftScale` 0.5 → 4: a wide
  uplift rises 0.73 times as fast as before, a range narrower than the
  flexural parameter up to 8 times.
- *The plateau's force balance* (`collapseFactor`,
  TECTONICS_TUNING.collapseHeightM 4000 m, collapseSmoothingM 150 km):
  the thickening rate falls as 1 − h̄ / H with h̄ the land's regional mean
  height. The flexure is linear and cannot bound a plateau alone.
- *No ceiling*: the clamp keeps its floor (−1, the trenches) only. The
  golden invariant is now a runaway check (15 000 m).
- *A large node's load is spread over its own area*
  (tectonics/flexure.nodeLoadSpreader): the terrain mesh's sea nodes
  reach 160 km, the flexure's cells are 62–78 km, and on the three
  corners of its triangle a 95 000 km² node's cut stood on a ninth of its
  area. On golden's zulu such a node, lowered 2.2 km by the rivers,
  rebounded 19 km (to 18.3 km) — the clamp had hidden it. A node no
  larger than its cell keeps the three corners.

**Two findings on the way.** (1) The negative uplift had to load the
plate too: with the thickening alone, the land at upliftScale 4 fell by
6–9 points in 40 epochs on the torus, 3–4 on the sphere, and on the
torus calibration seed 5 of the 6 points lost in the first 5 epochs were
under a negative U (a rift, a trench's capsule on a coast), far from any
range: the scaled lowering with no rebound. (2) The flexure alone
(collapse off) let the plateaus run: at upliftScale 2.5, zulu stood above
4500 m over 735 000 km², its peak at 12.6 km.

| 3 seeds per shape, medians (torus / sphere) | peak m | > 4500 m % | > 6000 m % | largest patch > 4500 m, k km² | land % |
|---|---|---|---|---|---|
| HEAD (knee, clamp; upliftScale 0.5) | 9000 / 8803 | 0.70 / 0.11 | 0.34 / 0.06 | 281 / 24 | 31.6 / 28.1 |
| thickening load only, 0.5 | 5026 / 1766 | 0.002 / 0 | 0 / 0 | 1 / 0 | 30.0 / 26.4 |
| thickening load only, 2.5 | 11 524 / 8727 | 0.48 / 0.15 | 0.34 / 0.08 | 146 / 28 | 25.4 / 25.3 |
| + collapse H 5000, 4 | 7887 / 8578 | 0.52 / 0.33 | 0.18 / 0.12 | 135 / 29 | 23.0 / 24.1 |
| both signs, H 5000, 2.75 | 7302 / 6418 | 0.16 / 0.10 | 0.003 / 0.018 | 65 / 19 | 31.0 / 27.2 |
| both signs, H 5000, 4 | 7966 / 9102 | 0.43 / 0.32 | 0.074 / 0.10 | 143 / 34 | 30.6 / 27.0 |
| both signs, H 5000, 5.5 | 9025 / 11 569 | 1.07 / 0.91 | 0.30 / 0.35 | 200 / 85 | 30.5 / 26.9 |
| both signs, H 5000 σ 100 km, 4 | 6525 / 7748 | 0.32 / 0.23 | 0.010 / 0.076 | 123 / 29 | 30.6 / 27.1 |
| **both signs, H 4000, 4 (chosen)** | 6451 / 7698 | 0.19 / 0.25 | 0.010 / 0.071 | 44 / 26 | 30.5 / 27.2 |

**The worlds against Earth** (12 per shape; medians, the extremes in
brackets; the land's hypsometry as shares of the land):

| | Earth | torus HEAD | torus after | sphere HEAD | sphere after |
|---|---|---|---|---|---|
| > 2000 m | ~5 % | 5.36 | 5.48 | 5.92 | 6.18 |
| > 3000 m | — | 2.19 | 1.52 | 0.97 | 1.01 |
| > 4500 m | ~0.4 % | 0.47 (2.14) | 0.17 (0.96) | 0.15 (0.99) | 0.20 (0.62) |
| > 6000 m | ~0.001 % | 0.032 (1.50) | 0.0085 (0.18) | 0.000 (0.27) | 0.019 (0.13) |
| land p99, m | — | 3780 | 3385 | 2968 | 2995 |
| land p99.9, m | — | 5154 | 4784 | 4891 | 4896 |
| peak, m | 8849 | 6448 (9000) | 6481 (9455) | 5731 (9000) | 6669 (8320) |
| worlds at the clamp / peak ≥ 7 km / ≥ 8.5 km | — | 2 / 5 / 2 | 0 / 5 / 3 | 1 / 2 / 2 | 0 / 5 / 0 |
| largest patch > 4500 m, k km² | Tibet ~2500 | 115 (859) | 36 (247) | 36 (200) | 22 (97) |
| largest patch > 3000 m, k km² | — | 564 (1561) | 213 (1233) | 212 (603) | 98 (536) |
| peak over its snow line (ELA), m | — | 540 | 4573 | 1084 | 2482 |
| land above the ELA, % | — | 36.9 | 38.4 | 10.8 | 11.2 |
| land, % of the surface | — | 31.2 | 30.3 | 26.2 | 25.1 |
| land and sub-sea basins, % | — | 31.9 | 30.9 | 26.2 | 25.3 |
| lakes, % of the land (liquid) | — | 12.1 (4.0) | 16.1 (7.4) | 6.2 (4.5) | 10.9 (8.5) |
| ice, % of the land | ~10 | 37.7 | 37.9 | 12.2 | 13.8 |

The high ground is now a few narrow ranges, not decks: the land above
4500 m keeps Earth's order, the largest patch above it shrinks three to
four times, and no world stands at a cap; the highest summits are 8.3–9.5
km. Above 6000 m the worlds still hold 9 and 19 times Earth's share (0.009
and 0.019 %): narrow crests a few nodes wide, not plateaus. The peaks
stand 2.5–4.6 km over their snow line — the glacial buzzsaw, a later
step, is the process that cuts them. The land moved −1.0 point (torus)
and −1.0 (sphere) by median, −0.5 to −2.7 per world: the flexural moat
beside a range on a coast drowns its lowland. The lakes rose by half to
three quarters: the moats are the foreland basins, and the model fills
them only with what the next epochs deposit — open for the calibration
of the deposition. The pentagons of the sphere's flexure mesh: the
plate's answer to the final relief at one Te, its Laplacian anomaly
at the twelve pentagons against the hexagons — max |z| 0.89 (median of
12), mean rank 0.49: no artefact.

Golden: 0 hard failures (before the spreading of a large node's load:
zulu's runaway, 18.3 km), re-recorded and re-armed, PASS 0 / 0 / 0.

2026-10-13: **phase 8b-2 BUILT — the temperature gradient and the
planet's levers.** The order agreed: land ✓ → the gradient → the levers →
peaks → the ocean's depth; this step the second and the third, with two
bugs of 8b-1's report. Measured with `npm run calibrate seeds=12
archeanMa=1000 landShare=30` (12 worlds per shape, the sweeps on 3; 96
worlds, about 2 h on ten cores) on HEAD and after; the climate's tuning was
found on the same terrains by a new mode, `calibrate climate
cache=<dir>`, which runs the climate step alone on the terrains a run
left (`cache=`), 20 s a world, and `scripts/earthClimate.mjs shape=sphere`
(Earth's relief on the sphere, now with its zonal means).

**The re-baseline** (HEAD, 30 % land): the sphere's zonal year against
ERA5, 0–10° … 80–90°: +0.2, −0.3, +0.5, +2.1, +3.5, +4.2, +5.5, +5.8,
+8.7 °C; its mean 16.1 °C. Earth's own relief on the sphere: +0.6 … +3.1
(40–50°), +3.6, +3.8, +1.2, +4.0 — the same excess, so the profile, not
the geography. The annual mean is the cheap model's latitude profile
(climate/temperature.ts) plus what the terrain and the sea add; the
energy balance carries only the year's cycle about it, so its diffusion
and carry are no lever for the gradient.

**Tuned** (CLIMATE_TUNING, the reasons beside each constant):

- `tempPoleC` −25 → −33 °C (the equator stays 28): the profile Earth's
  zonal means ask for, less what the terrain and the sea add on the
  sphere worlds, fits −34.5 + 62.5 cos φ; −33 puts every band within
  1.6 °C.
- `ebmRadiation` 8 → 6.5 W/m²K: the colder year took the summers with it
  (on Earth's relief E 15 → 23 % of the land, D 22 → 18); the damping is
  the land's swing. At 6.5 E 19, D 22, the places' swing −0.8 → +0.9 °C.
- `precipBandStormPeak` (new) 1.15: the rain's band factor rises poleward
  of the dry belt to 1.15 at the subpolar front, not to the equator's 1.5
  — the land at 50–60° got 885 mm on the sphere (Earth some 550).

**The levers** (the model rules: decisions/climate-biomes.md's addendum
of today, design/glacial.md's forcing):

- *Contrast and tilt* scale the profile's departure from its AREA MEAN
  (π/4 of cos φ on the sphere, 2/π on the torus), not from cos φ = ½: the
  world's mean stays (temperature.profilePivot).
- *The ice* melts on the warmest month (the annual mean plus half the
  seasonal range) above −1 °C, not on the annual mean above −8 °C — the
  same line at the range where the ice ended (median 13–16 °C on six
  torus worlds), so the tilt, which sets the seasons, sets the ice
  (`SURFACE_TUNING.iceMeltFromWarmestC`; surface/glacial.ts).
- *The day's length*: the rain's bands follow the Hadley cell's edge
  (planetForcing.hadleyEdge, 1/Ω, ⅓ of the span at 24 h) — the dry belt
  at it, the polar front's rain halfway to the pole — and the ocean highs'
  latitudes with it (precipitation.bandFactor, bandLatitude); before only
  the wind's cells moved.

| Sphere, mean of 3 seeds against their defaults | HEAD | after |
|---|---|---|
| contrast 60 / 140 %: mean T | −6.2 / +6.2 °C | −0.1 / +0.0 |
| contrast 60 / 140 %: T 0–10°, 80–90° | −10.5, +8.1 / +10.5, −7.9 °C | −5.1, +16.2 / +5.1, −16.2 |
| contrast 60 / 140 %: ice | −1.1 / +1.0 pts | −6.8 / +6.4 |
| obliquity 10 / 35°: mean T | +4.0 / −5.2 °C | +0.0 / −0.1 |
| obliquity 10 / 35°: ice | +0.7 / −1.0 pts | +8.2 / −7.8 |
| obliquity 10 / 35°: Köppen D, E | −20.7 / +10.3, +9.7 / −2.1 | −18.8 / +8.7, +17.4 / −8.4 |
| rotation 16 / 36 h: dry land's mean latitude (B below 50°) | −0.9 / +1.9° | −6.9 / +7.3° |
| rotation 16 / 36 h: least land rain (5° bands) | −3.3 / +11.7° | −5.0 / +15.0° |
| rotation 16 / 36 h: Köppen D | −1.7 / −5.4 | +1.4 / −9.8 |
| greenhouse −8 / +8: ice | +6.8 / −2.7 pts | +12.2 / −5.9 |

(The torus: contrast moves its mean by −0.4 / +0.1 °C, obliquity its ice
by +6.0 / −12.2 points, the rotation its dry belt by −5.5 / +5.3°.) On
the cached terrains alone (the climate step, the ice at the final
climate's steady state): obliquity 10 / 35° moves the sphere's ice by
+6.7 / −8.0 points, before +1.1 / −1.5.

**The worlds against Earth** (medians of 12; before → after):

| Sphere | 0–10° | 10–20° | 20–30° | 30–40° | 40–50° | 50–60° | 60–70° | 70–80° | 80–90° |
|---|---|---|---|---|---|---|---|---|---|
| T °C, ERA5 | 26.5 | 25.5 | 21.5 | 15.5 | 8.5 | 1.5 | −7 | −16 | −27 |
| T − ERA5, HEAD | +0.2 | −0.3 | +0.5 | +2.1 | +3.5 | +4.2 | +5.5 | +5.8 | +8.7 |
| T − ERA5, after | +0.2 | −0.5 | −0.1 | +0.8 | +1.7 | +1.0 | +0.8 | −0.6 | +1.4 |
| land rain mm, Earth | 1900 | 1100 | 600 | 600 | 650 | 550 | 400 | 250 | 150 |
| HEAD | 1528 | 1074 | 571 | 398 | 749 | 885 | 358 | 265 | 89 |
| after | 1219 | 977 | 601 | 388 | 581 | 612 | 243 | 148 | 42 |

The torus's T − ERA5 after: +0.4, −0.5, −0.2, +0.9, +1.8, +0.9, −0.4,
−2.5, −1.8 (its rows share one area: its mean is 5.4 °C, its ice 38 % of
the land — its latitudes above 60° hold 38 % of it).

| | mean T | ice % of land | lakes % | A | B | C | D | E |
|---|---|---|---|---|---|---|---|---|
| Earth (Beck; E without Antarctica) | 14 | ~10 | — | 23.4 | 26.8 | 12.7 | 22.3 | 14.7 (7.3) |
| sphere HEAD | 16.1 | 3.9 | 6.4 | 21.1 | 33.0 | 20.7 | 18.5 | 3.8 |
| sphere after | 14.4 | 12.2 | 6.2 | 17.8 | 33.7 | 18.5 | 19.2 | 10.1 |
| torus HEAD | 8.2 | 29.8 | 11.0 | 12.1 | 25.7 | 10.7 | 20.9 | 29.8 |
| torus after | 5.4 | 37.7 | 12.1 | 10.5 | 25.6 | 9.2 | 19.1 | 35.3 |

The Köppen shares follow the land: the sphere's land lies at low
latitudes (54 % of it within 30°, Earth's some 40 %), so its D and E stay
short of Earth's and its A, B and C long. C's excess is Cwa — 10 % of all
land below 30°, at 780 m mean height: the coldest month of a highland
tropical margin under 18 °C. It moved little with the gradient (a
warmer equator, 29 °C, took it 10.4 → 10.1 %) and is not the gradient's;
left for the Köppen pass. On Earth's relief on the sphere: A 19 B 25 C 15
D 22 E 19 % (Beck 23 / 27 / 13 / 22 / 15), the groups 11 → 13 points
off; the places' annual mean bias +0.1 → −1.5 °C — the places are coasts
and lowlands, the zonal mean a cold interior's and a sea's too.

**Two bugs, fixed** (each with a REGRESSION test in harness:pipeline that
fails on HEAD):

- *The cratons' oldness* (crust/raftField.computeCratonOldnessField)
  normalised the blobs' birth stamps against the current epoch, both on
  the continuous axis whose Archean epochs are 5 Ma: a margin born at the
  hand-over of a 1000 Ma Archean read 0.33 old 100 epochs later, 0.09 in
  Ma. Measured in Ma now (worldTime.worldEpochMa; `archeanEpochs` passed
  in, the erodibility's too). The golden harness passed the tectonic
  clock alone; it reads the runtime's axis now. Iron, which old cratons
  carry, moved most (calibration seed: mean 0.064 → 0.228).
- *The globe's compaction* (crust/raftLifecycle.compactRafts) took a
  blob's offset from its raft's centroid in the centroid's frame and moved
  the blob by it in its own: a blob across a pole from the centroid was
  pushed away (3 of 12 in the test). On the globe the centroid is the
  blobs' mean direction and each blob moves along the great circle toward
  it in its own frame (compactRaftOnGlobe); the torus is unchanged. The
  sphere's Archean worlds change with it: land after 40 epochs 28.0 →
  26.2 %, plates 13.5 → 12, the largest landmass 63 → 72 % of the land
  (within the history's spread; harness:mesh's sphere world runs 45
  Archean epochs, not 40, to keep its land).

Golden: 0 hard failures, re-recorded and re-armed, PASS 0 / 0 / 0 on
46 × 3 stages.

2026-10-12: **phase 8b-1 BUILT — the land share lever.** The fork: 8a
found the land set by the Archean's crust at the hand-over (7.6 % torus,
8.3 % sphere at the 0.5 gate), the water control (a sea-level offset of
±600 m) moving it by ±1.5 points only. Decided (the user): the water goes,
a **land share target** comes (`genesis.landShare`, 15–40 %, default 30,
in the spec and so in the world id); the sea stands at 0 and only the ice
moves it; a recipe with `genesis.water` is refused on open. The Archean's
NUCLEATION RATE carries it (option B), on the LAND the Archean's render
tests, not on the raft field.

**The controller** (`archean/archeanLand.ts`, deterministic, its one
state the credit in the Archean's snapshot). Each step, after the drift:
the land share — the raft baseline plus the dynamic topography above 0,
area-weighted over the mantle's field mesh (within 0.2 points of a mesh
four times as fine; the hand-over's mesh starts on it to 0.1 points; 7 /
20 ms a step torus / sphere) — and a grant of nuclei, `(aim − land) /
max(10, reachEpoch − epoch) / nucleus share`: the deficit over the epochs
left (feed-forward and feedback in one), a tenth of it a step once there
(the hold), none above the aim; fractional nuclei carry over as credit,
capped at `maxPerEpoch` (12, from 4). The net land of a nucleus is
measured, 0.03 Mkm² (a twentieth of a lone one's). The climb ends at 800
Ma (`reachEpoch` 160), not at 1000: the plates recycle crust younger than
their 150 Ma, and a climb ending at 1000 Ma handed them its youngest —
40 epochs in, worlds stopped at 1000 Ma stood 4–5 points under those
stopped at 1500 Ma; ending at 800 they agree within 1.5. The hold, run
to 2500 Ma (seven seeds, before the aim): within about ±2 points, single
dips of 4 recovered within 25 epochs. The aim compensates the
history (documented, as the brief allowed): the plates' first epochs take
back nothing at 15 % and about a quarter of the excess above it, so the
Archean aims at T + 0.27 (T − 15 %) — 34 % for 30 %, 46.75 % for 40 %.

**Two bugs found on the way, fixed** (both on the land's path):

- **The 0.57.** 8a's mesh land at the hand-over at 0.45–0.74 × the crust
  was not the margin profile or the hypsometry (the Archean's land, its
  raft coastline and the hand-over's mesh agree within 1–2 points): the
  first tectonic epoch recycled it. The tectonic crust sink's age gate
  (150 epochs) counted the continuous epoch axis, on which an Archean
  epoch is five tectonic ones' worth of Ma — every Archean craton read as
  young, and all of it over a downwelling went (seed calibration: 8.1 →
  4.9 % land in epoch 1). The age is in Ma now (`core/worldTime
  .worldEpochMa`); the same world keeps 8.5 %. Tectonic-born crust is
  aged as before, bit for bit.
- **The sphere's rafts over a pole** piled onto themselves: a raft's rigid
  move was the mean of its blobs' east/south flow applied in each blob's
  own frame (seed alpha: 29.4 → 13.3 % land in three epochs, no blob
  recycled). The raft turns as one body on the globe now
  (`crust/raftLifecycle.advanceRaftOnGlobe`; two-shapes.md); the torus
  keeps its chart mean.

**Measured** (`npm run calibrate seeds=12 sweep=0 landShare=… archeanMa=…`,
the Archean to the asked-for age and its gate, the hand-over, 40 coupled
epochs; median (p10–p90)):

| target | stopped at | Archean land, torus / sphere | after 40 epochs, torus | after 40 epochs, sphere |
|---|---|---|---|---|
| 15 % | 1000 Ma | 14.6 / 14.9 | 15.8 (12.8–19.0) | 13.8 (12.2–17.8) |
| 15 % | 1500 Ma | 15.0 / 15.0 | 17.7 (14.3–20.0) | 14.8 (12.1–17.5) |
| 30 % | 1000 Ma | 33.4 / 33.0 | 31.0 (26.5–35.4) | 28.0 (24.1–31.7) |
| 30 % | 1500 Ma | 33.8 / 33.8 | 31.5 (26.7–34.0) | 30.1 (28.3–33.8) |
| 40 % | 1000 Ma | 45.9 / 45.4 | 37.4 (33.3–47.0) | 37.3 (33.7–41.5) |
| 40 % | 1500 Ma | 46.3 / 45.2 | 41.8 (38.3–45.2) | 37.7 (32.3–40.4) |

Every median within ±3 points of its target. The p10–p90 band within ±5
in seven of twelve cells; outside: 30 % at 1000 Ma (torus p90 +5.4,
sphere p10 −5.9), 40 % at 1000 Ma (both shapes, −6.7 / +7.0 torus), 40 %
at 1500 Ma on the sphere (p10 −7.7). The spread is the history's: the
hand-over's land lies within ±1–2 points of the aim. The sphere's history
takes back 2–3 points more than the torus's at 30–40 % — perhaps its
plates, which move in domain units, 25 % further in metres than the
torus's (not measured; the calibration's open item). The aim is reached
at 760 / 748 Ma (median, 30 %); the 0.5 gate at epoch 80 / 90.

**What else moved** (30 %, 1000 Ma, against 8a): the Archean assembles —
3 / 4.5 rafts at the hand-over (10.5 / 12.5), 2 continents, the largest
landmass 81 / 63 % of the land (31 %); plates 14.5 / 13.5 (16 / 16.5);
the highest peak 5.6 / 4.6 km (8.6 / 9.0), mean land height 791 / 762 m
(target 700–900; it was 1 014 / 887); lakes 11.0 / 6.4 % of land; the
ocean's mean depth 3 475 / 3 423 m (4 428); ice 29.8 / 3.9 % of land; a
history epoch 2.3 × as long (more land, more nodes: 362 / 424 s for 40).
Golden re-recorded (0 hard failures; land 28–34 % on its three worlds).

2026-10-12: **phase 8a BUILT — the calibration's measurement, and the
fixes that are units, not taste.** Nothing tuned toward a target yet
(that is 8b).

**The instrument.** `npm run calibrate` (scripts/calibrate.mjs): 12 seeds
per shape at 2048 × 1024, each world a child process (7 at once), built
as the screen builds it — the Archean to the screen's gate
(stabilisedFraction ≥ 0.5, MIN_ARCHEAN_STABILISED; at epoch 58–142), the
hand-over, 40 coupled epochs at HISTORY_DEFAULTS (the screen asks for 30
and stops itself at 100), the static climate, its refinement, the
hydrology on the refined climate, the riparian biomes, the river graph;
the planet's and the genesis's sliders (obliquity 10/35, rotation 16/36 h,
greenhouse ∓8, contrast 60/140, humidity 60/160, water 25/75) swept on 3
seeds. It prints per shape the median, p10, p90, min and max of land,
plates, rafts, landmasses, the heights and the hypsometry, ice, lakes,
Köppen groups (against Beck et al.'s map, scripts/fixtures), the zonal
temperature and land rain per 10° (against rounded ERA5 and GPCC/GPCP
means), rivers, the sea's depth, the time per stage, and the artefact
checks below; `report <run> [<before>]` prints a run against another. 96
worlds take about 50 minutes on ten cores.

**(a) The constants in cells, now metres** (the torus's 7.8 km cell; on
the torus the division is exact, 234 000 / 7 800 = 30): the ranges' and
trenches' cross-section (rangePerpRadiusM 234 000, trenchPerpRadiusM
117 000), the coastline warp (warpAmplitudeM 202 800), the accretion
(blob 546 000, inset 234 000, gap 663 000, reach 1 170 000), the ridge's
fresh crust (93 600), the rift's mantle cooling and reset (2 964 000,
3 120 000), the Archean's crust (nucleus 546 000, consolidation 1 170 000,
attach 1 482 000), the channel's critical catchment (channelAreaMaxM2 /
MinM2, 243 360 / 9 126 km² — the wadis' too), the lakes' match across an
epoch (46 800). Every noise table counted in cells across the map (the
ridged and plain octaves, the warp, the hypsometry, the lithology, the
ecology's provinces) is read on the sphere at the torus's length in
metres (globeNoise.globeOctaveOn, core/domain CALIBRATION_METRES_AROUND).
MESH_TUNING.maxSpacingM stays 7 800 m: the plain octave it resolves is
15.6 km on both shapes now. Golden: 45 of 46 stages byte-identical on all
three worlds; the 46th is the artifact key (AMPLIFY_CONSTANTS names the
channel areas in m² now). Left in domain units on purpose: the plates'
kinematics and the features' spacing along a boundary (plate speeds,
MERGE_RADIUS, the segments' half-lengths, splitGap, trenchOffset) — they
are planet-relative, and moving them is a decision, not a unit.

**(b) Shape parity.** The cause of ~10 plates on the sphere against ~16
on the torus was two counts measured against the chart, not the area:
the mantle's mesh spacing (W / 128 — 156 km on the sphere, 125 km on the
torus — and the convection's lengths are counted in its cells) and the
plates' minimum spacing (0.22 × min(W, H) — 25 % longer in metres on the
sphere, whose globe holds 64 % of the torus's units²). Both are measured
against the world's area now (core/domain domainArea; on the torus
exactly the old numbers): the mantle mesh 9 612 cells at 125 km on the
sphere. The sphere's land (13.7 % against the torus's 7.6 %) came from the
Archean's crust in units (a nucleus 25 % wider in metres on a world of
64 % of the units²); in metres since (a). Over 12 seeds: sphere plates
10.5 → 16.5 (torus 16), land 13.7 → 8.3 % (torus 7.6), rafts 9.5 → 12.5
(10.5), mean land height 1 017 → 887 m (1 014); the torus unchanged.

**(c) Artefacts — measured, none fixed.** The twelve pentagons: a cell's
anomaly (its value less its neighbours' mean) against the hexagons'
anomalies, per field, over the 12 sphere worlds: the pentagons' mean rank
among the hexagons' |anomaly| is 0.04–0.41 (0.5 would be typical), the
mean |z| 0.03–0.52, the median of each world's largest |z| 0.24–1.6
(temperature, rain, pressure, currents, wind, mantle, ocean age); the
single largest, 9.3 (ocean age) and 4.6 (temperature), are one pentagon
in one world each, not a pattern. No Heikes–Randall correction. The seam
x = 0 / W (the jump across it over a column's mean jump): sphere medians
0.14–0.80, max 3.6, the torus (periodic by construction, the control)
1.0–1.1, max 2.9. The pole rows: a sphere chart's top and bottom row
spread 0.31 / 0.22 °C against 1.7 for a row. The zonal mean's largest
second difference per row 0.86 °C against a median 0.06; before (b) one
world had 11.7 °C, its pole row at −56 °C against −37 °C next — one
climate cell over a high polar plateau, relief and not numerics.

**(d) The terminal basins by their water balance** (surface/hydrology
accumulateDischargeOn). A terminal basin (a filled region whose floor
lies below sea level) gathers what reaches it, its nodes push nothing on
inside it, and its exit passes over the spill the inflow less PET × the
basin's area — nothing from an endorheic basin, the surplus from a
brim-full one; computeLakesOn reads the inflow as the basin's sum, not
the largest single arrival plus its rain. The river graph runs no
channel inside a terminal basin (riverGraph: a river meets it as an inlet
or a mouth; the overflow's river starts at the spill as a source).
Torus, 12 worlds: lake share median 4.60 → 4.79 % (per world +0.0 to
+0.4 points), the largest discharge unchanged on every world, reaches
−11.5 (rivers no longer cross terminal basins), land and plates
byte-identical. Golden: zulu's dry basin (2 197 cells, its salt flats)
fills to a lake (lake cells +20 %, its hottest cell 45.9 → 29.4 °C), its
reaches 883 → 701; 0 hard failures, re-recorded.

**The worlds against the targets** (after the fixes, medians, p10–p90;
the targets the user's, for 8b): land 7.6 % (5.6–14.1) torus, 8.3 %
(6.3–10.1) sphere — target 25–35; the highest peak 8.6 / 9.0 km, many
worlds at the 9 000 m clamp — target 8–9; ice 29.5 % of land on the torus
(whose latitudes all have one area), 12.7 % (8.5–20.5) on the sphere;
lakes 4.8 / 3.3 % — target ≤ 8–10; Köppen on the sphere A 25 B 20 C 31
D 12 E 12 % against Earth's 23 / 27 / 13 / 22 / 15; the sphere's mean
temperature 16.8 °C, its zonal means 1–2 °C warm in the tropics, 5 °C at
40–60° and 6–9 °C toward the poles; the land's rain at 40–60° 1 050–1 160
mm against 550–650. The sliders (sphere, mean of 3 seeds): obliquity
10 / 35° moves the mean temperature +4.1 / −5.3 °C and Köppen A +18 / −26,
D −11 / +17 points, the ice share by −0.3 / −1.2 only; the rotation
16 / 36 h moves no Köppen group by more than 4 points; greenhouse ∓8 °C
moves the ice +7.6 / −7.1 points; water 25 / 75 (∓300 m) moves the land
+0.9 / −1.4 points.

2026-10-12: **the save step BUILT — no chart raster left in the save**
(fork 5 as revised, formatVersion 8 kept). With it nothing simulates on
the 2:1 chart and the save holds no chart raster field, so the DEC's
stage is `built`; phase 8 (the calibration, in metres) is separate work
and stays open.

**The inventory** (what the archive still held as chart rasters, and
what became of each):

| Entry | Was | Now |
|---|---|---|
| `elevation.f32` | 2048 × 1024 Float32, the restore raster and the manifest's `elevation` layer — the terrain mesh's rasterisation | removed: the restore and every reader rasterise `mesh/z.f32` (`meshRaster.rasteriseNodeField`, the raster `runtime.renderTerrain` draws after every epoch) |
| `layers/lakeDepth.u8` | 2048 × 1024, the mesh's lakes drawn on the world raster (`waterFieldsFromMesh`) | removed: the water body per node, `mesh/lakeBody.i32` (Int32, an index into `layers/waterBodies.json`, −1 none), and the reader draws the depth with the session's own `waterFieldsFromMesh` |
| `layers/uplift.f32`, `layers/erodibility.f32` | 256 × 128 Float32, the erosion's coarse forcing | removed: a pure function of `state.json` (features, rafts, sutures, the epochs — `erosionForcing.coarseForcingFields`); the reader evaluates it as the generator does |
| `lattice.acc.f32`, `lattice.lock.i16`, `lattice.class.i8` | the boundary detection's accumulated history | kept: not a chart raster — its own point set (`generateDetectionLattice`: 256 × 128 points on the torus, on the sphere each row only the columns its length holds), the plates' simulation state per point, as a mesh's is per node; moving it would be churn |
| `archean.streak.i16` | per cell of the mantle's field mesh since phase 1 | kept (not a raster) |
| `preview.png` | a thumbnail picture | kept (not a field) |

An Archean save loses its `elevation.f32` too (the restore renders the
Archean's state, as it did anyway). Every tectonic save carries its mesh
now, one saved at the hand-over before any epoch included
(`runtime.savedMeshPayload`: the coupled terrain the next epoch starts
from, unrouted). A save holding any of the four removed entries, or a
tectonic one without `mesh/nodes.f32`, is refused
(`savedFields.refuseFormerRasters`, in the screen's load and in
`world/query.openWorld`); the manifest lists tables only.

**The identity.** `deriveWorldId` hashed the elevation raster, the
climate's precipitation cells, the kind and the erosion controls, plus
the mesh's nodes, heights and column. It hashes now, in this order: the
kind, the controls and two presence marks (column, climate) as text, then
the mesh's nodes, heights and column, the annual climate's four fields
per cell, the forcing (uplift, erodibility — what a bake erodes with,
which the raster had stood for), the mantle's and the ocean age's values
— no raster (world/identity.ts). Every world's id moved once; artifacts
keyed by an old id are stale and are made again (accepted, alpha). The
frozen id in `harness:roundtrip` is re-frozen (`5e7492a5133a8979`). A
legacy save without `metadata.uid` derives its uid from the mantle's
values in place of the elevation raster.

**Readers switched.** The generator's restore (`runtime.handleRestoreWorld`:
the mesh decoded, then `renderTerrain`; without a mesh the hand-over's
`createCoupledTerrain`, the screen refuses such a save; an Archean
restore renders its state); `world/query.ts` (every raster a view it
makes: `elevation`, `lakeDepth`, `uplift` / `erodibility`, the climate's
chart and the land fields from the drawn elevation; `worldId` from the
meshes); `loadWorldInputs` (the bake's `elevations`, its forcing, no
`lakeDepth`) and through it the job worker (its land-tile scan reads the
drawn elevation) and the bakes; the incubator (acquires through
query.ts, unchanged); `scripts/sampleWorld.mjs` (opens a save .zip or an
unpacked folder through query.ts and downsamples the mesh's
rasterisation); `harness:mesh measure` (the elevation and the discharge
through query.ts). The Go server reads only `world.yaml` and
`preview.png` (internal/modules/world/save.go); its test's opaque bulk
entry is renamed `mesh/z.f32`.

**Measured** (2048 × 1024, seed `bench`, 100 Archean + 12 coupled epochs,
the climate and the hydrology through the runtime with the pipeline
harness's synthetic pre-mesh renderer, no refinement; Node):

| | torus | sphere |
|---|---|---|
| mesh nodes | 71 715 | 125 614 |
| the save before → after | 13.65 → 6.57 MB | 17.65 → 10.86 MB |
| removed, deflated: elevation / lakeDepth / uplift / erodibility | 7.01 MB / 6.7 KB / 60 KB / 6.1 KB | 6.70 MB / 6.2 KB / 65 KB / 15 KB |
| added: `mesh/lakeBody.i32`, deflated | 3.4 KB | 4.8 KB |
| the reader's elevation = the session's raster | bit for bit | bit for bit |
| the reader's lakes' depth = the session's | bit for bit (3 520 wet pixels) | bit for bit (4 722) |
| the reader: open / elevation / lakeDepth / forcing / worldId | 102 / 497 / 489 / 44 / 14 ms | 161 / 639 / 583 / 99 / 19 ms |

**Determinism** (`harness:pipeline`, 256 × 128): a loaded world's raster
is the session's byte for byte; a save at the hand-over carries its mesh
and one epoch on the loaded world's mesh is the session's bit for bit;
the reader's elevation, lakes and forcing are the session's; the world's
id is the same across save → load → save (the loaded world's climate and
hydrology run again first, as the screen's save does), the same for two
pipelines that made the same world, and another one epoch on. Level 1's
replay across a load lands on the saved mesh bit for bit, as before.

**Golden**: PASS — 0 hard failures, 0 drifted metrics, 0 moved stages,
46 stages byte-identical × 3. No world changed: golden reaches neither the
save nor the identity, and no stage's code moved (the runtime's restore
and serialize are `harness:pipeline`'s). Nothing re-recorded or re-armed.

**What the chart still is.** No simulation on it, and nothing of it in
the save. It is the address and the textures, and three EVALUATIONS that
feed the meshes are still made on a chart grid, each a function, not a
process: the erosion forcing (`uplift`, `erodibility` at 256 × 128,
interpolated at the nodes — normalised by the world's peak), the craton
oldness (256 × 128, read at the nodes) and the climate's terrain (read
from the elevation raster — a cell's mean of its texels). Moving any of
them onto the nodes changes worlds (the interpolation, the peak), so it
is not this step's; they are candidates beside phase 8. Outside the
generator's chain: the migration (its own screen, later) and the raster
erosion engine, which only harness and measuring scripts run.

2026-10-12: the save carries the last epoch per node (`mesh/sedimentFlux.f32`, `mesh/preErosionZ.f32`, `mesh/ice.f32`, still formatVersion 8; one without the first two is refused), so a loaded world's reaches, deltas, coast types, sediment basins and glaciers are the session's.

2026-10-12: phase 7b BUILT — the hydrology's raster parts on the terrain
mesh, both shapes, one path. No hydrology runs on the 2:1 raster any more:
the hydrology stage routes nothing on it (`fillDepressionsAndRouteFlow`
and the flow substrate's raster instance are gone), and the last
transition adapter (the raster routing's rain) went with it.

**The inventory** (what still ran on, or read, the raster at the start):
the raster routing (`flowRouting.fillDepressionsAndRouteFlow`: priority
flood, D8-LTD receivers, MFD edges at 2048 × 1024) and its rain adapter;
the raster discharge it accumulated — read by the map's flow readout, the
save's `discharge` layer, the migration's river corridors (`downsampleMax`
to the chart) and the cell tracer `extractRiverPolylines` (dead since the
graph draws the ribbons); `computeWatersheds` (the overlay); the coast
graph (`coastGraph.ts`: coast cells, an upwind march a cell a step over the
elevation raster, relief over the D8 window, its reaches walked cell by
cell; the water shader's coast type per pixel and `coast.json`'s cells);
the sediment basins (`sedimentBasins.ts`: 8-connected pixel components of
the rasterised before/after, provenance over the raster routing); the
raster wrappers of the substrate functions (`computeLakes`,
`accumulateDischarge`, `accumulateRegimeInputs`, `receiverSlope`,
`channelReferenceSlope`, `isChannelCell`, `buildChannelMask`) and
`riverGraph`'s `routing` input. Already on the mesh: the discharge, the
lakes, the regime, the channel criterion, the river graph and its courses,
the riparian rain, the hydrogeology. Not readers: the bakes and the job
worker (the level and the tiles route their own meshes), the incubator
(level-1 artifacts), the Go server.

**The method.** The discharge is the mesh's (`accumulateDischargeOn` on
the coupled mesh's substrate), the one discharge there is. The watersheds
are node labels (`hydrology.watershedsOn`: popOrder forward, a basin kept
from 12 168 km²). The coast graph runs on the shore nodes
(`coastal.findShore`, the line the history's coast process works on — now
shared, with its upwind march `shoreExposure`, bit for bit): the reaches
walk from shore node to nearest unvisited shore node along the mesh's
edges, cut at a mouth and every 312 km; the relief is the highest ground
of the mesh's surface at the node and the eight compass points 7.8 km out;
a mouth's coast node the nearest within 23.4 km, a delta's coast the shore
nodes within 15.6 km of it. The sediment basins are connected node sets
over the mesh's edges, the thickness the node's against the last epoch's
start (`CoupledTerrain.preErosionZ`), area, volume, centroid (circular
mean on the torus, the globe's mean on the sphere) and provenance by the
nodes' Voronoi areas in km², the graph's mouths read as vertex ids.

**Constants converted** (the torus's 7.8 km world cell, no calibration):

| Was | Now |
|---|---|
| coastReachCells 40 | coastReachM 312 000 (walked length) |
| the coast's fetch march: a world cell a step (fetchCap 192) | coastGraphFetchStepM 7 800 |
| relief: the highest land of the D8 window | coastReliefStepM 7 800 (eight compass points, a diagonal √2 of it) |
| a mouth's coast cell: the nearest within 3 cells | coastMouthReachM 23 400 |
| delta: two cells each way (a row's span on the sphere) | coastDeltaReachM 15 600 |
| sedimentBasinMinCells 4 | sedimentBasinMinAreaKm2 243.36 |
| computeWatersheds minAreaCells 200 | watershedsOn minAreaKm2 12 168 (a display floor, no tuning constant) |

**The display** (fork 5: the chart is the address and the textures): the
discharge and the watershed labels on the world raster from the nodes,
each land pixel its triangle's heaviest land corner's
(`rasteriseNodePart`, the pixels' triangles cached per mesh as the
biomes' are); the coast type on the raster's own shore pixels (a land
pixel with a sea pixel among its eight), the heaviest typed shore corner
(`runtime.coastTypeRaster`); the migration's river corridors the largest
node discharge per chart cell (`runtime.chartMaxOfNodes`). The ribbons
were the graph's already.

**Save** (formatVersion 8 kept): the discharge per node of the saved mesh
(`mesh/discharge.f32`, Float32, m³/s, unthresholded) in place of the
layer `discharge` (u16, 4 m³/s a step, 2048 × 1024); `layers/coast.json`
lists the reaches' `nodes` (vertex ids of the saved mesh; a reach
`nodeStart`, `nodeCount`) in place of `cells`; `sedimentBasins.json`
counts `nodes` and `catchmentKm2`. A save with the layer `discharge` or a
coast over cells is refused (`climateFields.refuseFormerHydrology`, in
`world/query.openWorld`); `world/query.ts` answers `acquire('discharge')`
by rasterising the nodes (the nearest). Readers switched: the screen's
save path (the worker's land payload carries the discharge), query.ts;
the bakes, the job worker, the incubator and the Go server never read
them. `layers/lakeDepth` and `waterBodies.json` stay (the lakes' raster
recovery, the save's own step with the elevation).

**Zulu's largest discharge ×2.7 after phase 7, traced: not a DEC-0036
bug.** The ×2.7 (1.72e7 → 4.61e7) is one catchment of 60 658 world cells
(4.4 × phase 6's largest, 13 732) reaching the sea at (1788, 628). Mapped
onto phase 6's world, 75 % of it drained into an enclosed sub-sea basin
around (1720–1805, 520–555) and stopped there. On phase 7's relief that
basin (floor −43 m) stands brim-full at its spill (level = spill = 206 m),
and the receivers over its flooded surface run from the shore nodes along
the flood's land nodes to the spill without touching a sub-sea node — so
`accumulateDischargeOn`'s rule "the first sub-sea element keeps what
arrives" never fires and the rivers run on over the spill. On phase 6's
relief its basin was brim-full too (level = spill = 305 m), but one
shore node's receiver happened to step onto a −7 m node and kept the
discharge. Not the precipitation sampling: phase 6's nearest-cell rain on
phase 7's terrain gives 4.60e7. The rule is older than DEC-0036 (the flood
from the world ocean, 2026-08-06; the mesh routing, phase 4.3): whether a
terminal sea swallows its rivers depends on which receiver chain the flood
happens to draw, not on the basin's balance. Phase 7's history only
changed the relief under it. For a brim-full basin the rivers running on
is the right answer; a terminal sea below its spill would need the rule
to read the basin's balance (computeLakesOn's) — found, not fixed.

**Golden**: 0 hard failures; the four hydrology stages moved
(`hydro.discharge`, `coast.reaches`, `coast.type`, `sediment.basins`), the
other 42 byte-identical × 3 — the history, the climate, the lakes, the
river graph and the ecology untouched, the coast process's shared shore
code included. Drifted: sediment basins +12 / +15 / +20 % (calibration /
alpha / zulu) and their volume +24 / +14 / +8 %; coast reaches +2 / 0 / +9
%, cliffs 14 → 18, 37 → 17, 20 → 33, beaches +31 / +24 / +13 %, marshes
−6 / +2 / −26 %; `hydro.channelCells` became `hydro.channelNodes`.
`golden.json` re-recorded and the byte guard re-armed: 0 / 0 / 0, 46
stages byte-identical × 3.

**Measured** (2048 × 1024, seed `bench`, 100 Archean + 12 coupled epochs,
the climate, its refinement, then the hydrology through the runtime; Node;
HEAD → 7b on the same terrain, its z's hash equal):

| | torus HEAD | torus 7b | sphere HEAD | sphere 7b |
|---|---|---|---|---|
| hydrologyRun | 4.43 s | 1.83 s | 5.89 s | 3.07 s |
| river reaches, km | 146, 12 150 | the same | 254, 27 240 | the same |
| lakes, share of the land pixels | 2.18 % | the same | 1.05 % | the same |
| largest discharge | 3 746 m³/s | the same | 4 650 m³/s | the same |
| the map's discharge over land, p50 / p90 / p99 (m³/s) | 1.6 / 21 / 275 | 4.8 / 61 / 527 | 1.6 / 23 / 402 | 4.4 / 60 / 835 |
| per node, p50 / p90 / p99 (m³/s) | — | 4.1 / 58 / 481 | — | 4.2 / 66 / 932 |
| watersheds, labels / share of the land | 95 / 46.6 % | 113 / 49.6 % | 137 / 59.8 % | 228 / 67.8 % |
| coast reaches, km, mean | 376, 57 780, 154 | 395, 50 050, 127 | 450, 75 420, 168 | 472, 65 530, 139 |
| coast types r / c / b / m / d | 258 / 13 / 57 / 46 / 2 | 256 / 29 / 75 / 35 / 0 | 262 / 9 / 89 / 90 / 0 | 245 / 8 / 142 / 77 / 0 |
| sediment basins, km³ | 796, 380 900 | 990, 446 600 | 1 167, 420 200 | 1 922, 496 700 |
| the whole save | 19.84 MB | 19.96 MB | 21.55 MB | 21.82 MB |
| discharge in the save (deflated) | 78 KB u16 raster | 178 KB f32 per node | 128 KB | 353 KB |

The map's discharge reads higher at the low end: a pixel shows its
nearest node's discharge, and a node gathers its whole Voronoi cell. The
display rasters (torus / sphere): the watersheds 2.8 / 3.6 ms at the
nodes and 15 / 14 ms on the raster, the discharge 9 / 10 ms, the coast
type 33 / 52 ms, each with the pixels' triangles the hydrology's riparian
raster located already (388 / 449 ms once per mesh); the coast graph
55 / 160 ms (a uniform wind). The hydrology's time fell by the raster
routing (the priority flood over two million cells).

**Checks.** `harness:mesh`: the watersheds closed under the receivers,
the coast graph walks every shore node once along the mesh's edges and is
deterministic, the basins' volume is their nodes' thickness by area.
`harness:pipeline`: the sphere's coast invariants on its mesh, the basins'
centroid on a geodesic lattice (off 0.07–0.15 cells; the torus's circular
mean misses the polar ones by 39.9 and 1.9), the discharge, the watersheds
and the coast's nodes byte-identical between two pipelines, and a loaded
world's discharge, lakes, watersheds, river network and coast walk the
session's, byte for byte, with the save's discharge per node. Not its
reaches' sediment loads (and with them the coast's supply and types, the
courses' deltas): they are the last epoch's erosion flux, which the save
does not carry — older than 7b, found, not fixed. The raster receiver's check (the fall line at 70°N) went with
the raster routing. `harness:roundtrip`: the discharge per node and the
coast's nodes bit for bit, no discharge layer written, the former layer
and a coast over cells refused.

**What the chart still is.** No hydrology simulation on it. It remains
the address and the textures: the elevation raster (the terrain's
rasterisation, the climate's terrain read from it — `climateTerrain`, a
cell's mean — and the save's `elevation.f32`), the lakes' raster recovery
(`waterFieldsFromMesh`: the water shader's level and surface, the dry
floors the climate's land mask reads, the save's `lakeDepth`), the ice
drawn for the map, every land field's and the hydrology's screen rasters,
the climate's 256 × 128 chart for the screen and the save's readers, the
erosion forcing (`uplift` / `erodibility` at 256 × 128, read at the nodes)
and the craton oldness raster (read at the nodes). Simulation on a 2:1
raster outside the generator's chain: the migration (its own screen,
later, on the chart) and the raster erosion engine (`erosionPassV2`, the
engine's FLAG_GRID8 index), which only harness and measuring scripts run
(`harness:mesh measure`, `makeTestSave`, `ridgeBands`);
`scripts/measureHydrology.mjs`, the raster pass's lake census, is deleted
with the raster hydrology it measured (`calibrateHistory.mjs` is the
instrument on the history).

2026-10-12: phase 7 BUILT — the biomes, the Köppen classes, the ecology
with its resources and the hydrogeology on the adaptive terrain mesh
(fork 2), both shapes, one path; every reader of the climate outside it
samples the climate's field mesh at its own points. No stage reads a
climate raster any more, and no climate, biome or ecology raster is left
in the save.

**The inventory** (what still computed on, or read, the 2:1 raster at the
start): the transition adapters — weather.ts's rasters (temperature, wind,
seasonal range, rain, monsoon, currents, their anomaly), climateMesh's
`climateRaster`, `climateVectorRaster`, `climateSeaRaster`,
`climateSeaVectorRaster`, `climateLandRaster`, `climateLandOnlyRaster`
(with `rasterLand`) and `refinement.refinedRasters`; their readers — the
biomes (`computeBiomes`, `computeBiomesFine`, the two `…FromMonths`, the
Köppen fields), the riparian biomes (a bleed over the climate grid), the
ecology (windows over the 2048 raster, halos, oases, slope, ecotones,
`ClimatePixel`), the hydrogeology (the nearest climate cell), the lakes,
the discharge and the regime (the nearest cell), the mean runoff, the
history's ice (`computeIceOnMesh` with the cell's temperature and the
coarse heights), F4's raster ice (`computeIceThickness`, the hydrology's
fallback), the coast (the history's fetch walked over the climate raster,
the coast graph's wind), the column's ledger (`upsampleAt` of the
rasters), the history's cover (coarse biomes), its sea level and land
temperature (raster areas), its water forcing, the bakes (the save's
climate layers), the world id (the precipitation layer), world/query, the
incubator and the screen. The hydrology's own raster parts: the raster
routing and its discharge (the map's and the save's discharge layer, the
watersheds), the coast graph, the sediment basins and the lakes' raster
recovery (`waterFieldsFromMesh`, a rasterisation).

**The scope.** In: all of the above but the hydrology's raster parts. Out,
proposed as **phase 7b**: the raster routing, its discharge layer, the
watersheds, the coast graph and the sediment basins onto the mesh. They
are raster simulation (fork 1), but moving them changes what the save's
`discharge` layer and its `coast.json` cells mean and needs a mesh form of
each algorithm — a phase of its own. Until then the raster routing reads
the nodes' rain drawn onto the world raster, the one adapter left (marked
`removed in phase 7b`).

**The method.** `climate/climatePoints.ts`: the climate as its readers
need it, per cell (`ClimateCells`, Float32) — the temperature REDUCED TO
SEA LEVEL by the rule computeTemperature applied (the cell's own lapse
taken off), the land fields with their sea marks, the refinement's months,
upwelling and rain reliability, the year's wind — and `climateAtPoints`:
at a point the triangle's corners, the temperature less the point's OWN
lapse (so a treeline follows the relief and a summit's cold does not
bleed into the valley), a land field over the land corners only,
renormalised, an island under a cell its latitude's land mean (the
former grid's island rule), the monsoon index as a magnitude with the
heaviest land corner's sign, a sea field over the sea corners. The
biomes and the Köppen classes per point (`biomes.classifyPoints`: the
months when refined, else the annual figures' synthesized months; Alpine
above the treeline). The riparian bonus per node
(`hydrology.riparianPrecipitationOn`): a strength per lake and channel
node, carried to the land by a multi-source Dijkstra over the links with
riparianDecay per riparianDecayLengthM, the strongest reach kept. The
ecology per node (`ecology/ecologyField.ts`): a reach is the cells the
disc of radius r reaches, each taken as the disc of its own area and a
mean weighing each by the area of the lens the two share
(`mesh/meshNeighbourhood.ts`) — on a 7.8 km raster a reach of one pixel
is the old 3 × 3 window; on a coarse land node the 8 km water reach is
the node itself, the water the mesh resolves —, a deposit's halo a
Gaussian of the true distance (the globe's arc on the sphere), an oasis
the cells its reach touches, the slope Green–Gauss over the Voronoi cell,
the ecotone the share of a cell's walls facing another biome per unit of
area in the unit a 7.8 km pixel counted it in. The history's epoch reads
the climate at its nodes too: the ice (the sea-level temperature and the
rain per node), the column's ledger, the cover, the water forcing
(`assembleNodeForcing`'s `waterNodes`), the coast's wind, its fetch walked
over the terrain mesh's own surface; its sea level and mean land
temperature by the climate mesh's cell areas. A world restored without a
mesh gets, at its first stage after the history, the mesh its first
epoch would build (`runtime.landTerrain`; the build is a function of the
plates, so the epoch then starts from the same mesh).

**The display** (fork 5: the chart is the address and the textures):
`climate/climateChart.ts` draws the climate's fields on their 256 × 128
chart for the screen and a save's readers — the former transition
functions, read by no stage. A land field per node goes onto the world
raster by `meshRaster.rasteriseNodePart` (a land pixel reads only its
triangle's land corners — the heaviest for an id —, never a blend with
the sea); the pixels' triangles are located once per terrain mesh
(`triangleRaster`, 12 bytes a pixel) and every layer reuses them. The
screen still reads rasters: the hover readout samples the world raster
the nodes were drawn on (one pixel, the mesh's value there), not the mesh
itself.

**Constants converted** (the torus's 7.8 km pixel and 62.4 km climate
cell, no calibration):

| Was | Now |
|---|---|
| copperRadiusFrac 0.02, tinRadiusFrac 0.019, obsidianRadiusFrac 0.015 (× 1024 pixels) | copperRadiusM 159 744, tinRadiusM 151 757, obsidianRadiusM 119 808 |
| goldLodeRadiusFrac 0.015, silverRadiusFrac 0.018, gemRadiusFrac 0.014 | goldLodeRadiusM 119 808, silverRadiusM 143 770, gemRadiusM 111 821 |
| volcanicProvinceRadiusFrac 0.05 | volcanicProvinceRadiusM 399 360 |
| the slope as a pixel's rise × 8 (pxPerCell) | flatnessRunM 62 400 |
| the ecotone: the share of a pixel's four neighbours | ecotoneCountedOnM 7 800 (the boundary's length per area in that unit) |
| coastReachM, waterReachM, placerReachM, ecotoneReachM rounded to pixels (4, 1, 4, 2) | the metres themselves |
| riparianSpread 1 climate cell, riparianDecay 0.45 per cell | riparianReachM 62 400, riparianDecayLengthM 62 400, riparianDecay 0.45 |
| the coast's fetch: a climate cell a step | coastFetchStepM 62 400 |

**Transition adapters.** Removed: weather.ts's rasters, climateMesh's six
transition functions and `rasterLand`, `refinement.refinedRasters` (their
drawing lives on in climateChart, read by no stage). Gone with them: the
raster biome functions (`computeBiomes`, `computeBiomesFine`,
`…FromMonths`, `computeKoppenField`, `koppenFromMonths`,
`reduceTemperatureToSeaLevel`, `sampleLandBilinear`),
`computeRiparianBiomes`, `ClimatePixel` and the ecology's raster windows
and pole-row averaging, `meanLandRunoff` on the raster (now over the
climate's land cells), F4's raster ice (`surface/iceFlow.ts`; its
invariants moved to glacial.ts), climateField's raster helpers
(`zonalLandMean`, `isLandAtCell`, `sampleDryLandAtCell`), the save's
`restoreLandOnlySentinel`, and the world map's reclassification from the
saved climate layers (map/mapPresentation.ts, waiting for its screen, now
upsamples the saved biome ids). Left: one, the raster routing's rain
(phase 7b). Not a DEC-0036 stage and still on the climate's chart: the
migration (its own screen, later), fed the chart's rain.

**What remains on the raster, and why:** the hydrology's raster parts
(7b, above); the lakes' raster recovery and the elevation raster (the
save's own step); the climate's terrain read from a raster
(`climateTerrain`: the texel under a cell's centre, the cell's mean); the
erosion forcing (`uplift`, `erodibility` at 256 × 128) and the craton
oldness raster, crust fields read at the nodes (nearest, bilinear over
the crust); the screen's textures and readouts.

**Save** (fork 5 as revised, formatVersion 8 kept): the layers
`landMask`, `temperature`, `precipitation`, `precipitationEffective`,
`seasonalAmplitude`, `monsoonIndex`, `koppen`, `waterTable` and `biome`
are gone (the ecology layers went in formatVersion 7). In their place the
annual climate per cell of the climate's mesh — `climate.json` +
`climate/{seaLevelTemperature, precipitation, seasonalAmplitude,
monsoonIndex}.f32`, Float32, the climate the land fields came from: the
refinement's year when refined, else the static climate the hydrology
settled — and the land fields per node of the saved mesh: `mesh/biome.u8`,
`mesh/koppen.u8`, `mesh/waterTable.f32` (world/save/climateFields.ts).
Stored rather than recomputed for the save's READERS: the generator
recomputes all of them on load as before (the climate is the restore
chain's first step, then the hydrology, then the ecology —
`catchUpAfterRestore`; fast and deterministic), but a bake samples the
climate at its own nodes and a game server asks a biome without the
generator's code. A save with the old layers and no `climate.json` is
refused. Readers switched: world/query (rasterises them for its views:
the climate on its chart, the land fields on the world raster), the world
id (hashes the climate's cells in place of the precipitation layer), the
level bake and the tile bake (sample the saved cells at their nodes;
`meanLandRunoff` over the climate's land cells), the job worker's replay
(the last epoch's climate at the level's nodes), the incubator (the
climate's rain in place of the riparian one). The Go server never read
them.

**Measured** (2048 × 1024, seed `bench`, 100 Archean + 12 coupled epochs
at HISTORY_DEFAULTS, then the climate, the refinement, the hydrology and
the ecology through the runtime; Node, one thread):

| | torus HEAD | torus mesh | sphere HEAD | sphere mesh |
|---|---|---|---|---|
| climateRun (the climate, its chart, the biomes at the nodes, their rasters) | 558 ms | 940 ms | 606 ms | 1048 ms |
| climateRefine | 5.86 s | 5.90 s | 5.69 s | 5.86 s |
| hydrologyRun | 5.61 s | 5.20 s | 7.38 s | 6.78 s |
| ecologyRun, first | 1669 ms | 971 ms | 2586 ms | 1996 ms |
| ecologyRun, a slider moved | 277 ms | 333 ms | 301 ms | 378 ms |
| ecologyMonth | 395 ms | 70 ms | 396 ms | 77 ms |
| the whole save | 20.03 MB | 20.02 MB | 21.86 MB | 21.85 MB |

The parts (direct calls on the same chain, torus / sphere): the climate at
the nodes 47 / 59 ms; the biomes 22 / 25 ms (HEAD's coarse and fine from
months 82 / 104); the riparian bonus and its biomes 28 / 52 ms (HEAD
139 / 205); the hydrogeology 14 / 31 ms (HEAD 18 / 31); prepareEcology
553 / 1009 ms (HEAD 1254 / 1903), applyEcology 10 / 13 ms (HEAD 177 /
224); the pixels' triangles 446 / 526 ms once per terrain mesh, then a
layer ~10 ms (the fourteen ecology layers with their climate-cell means
653 / 810 ms including the triangles); the climate's chart 40 / 51 ms,
the refinement's 412 / 497 ms. The history's epoch 1411 → 1591 ms
(torus), 1996 → 2097 ms (sphere): the climate sampled at the nodes twice
an epoch, the biomes classified there.

The biomes' shares of the land (the map's, the riparian corridors, salt
flats and glaciers included), HEAD → mesh: torus temperate forest 18.6 →
17.3 %, glacier 15.7 → 15.6, tropical rainforest 14.8 → 13.5, boreal
11.3 → 13.7, tundra 9.1 → 6.3, temperate rainforest 6.6 → 6.2, steppe 5.8
→ 6.5, savanna 5.3 → 6.3, dry forest 5.1 → 5.4, woodland 3.4 → 3.3; sphere
temperate forest 19.5 → 17.0, tropical rainforest 16.7 → 16.3, woodland
14.0 → 12.4, steppe 10.9 → 11.8, desert 9.4 → 13.0, cold desert 5.9 → 7.0,
boreal 5.3 → 5.2, savanna 4.0 → 5.2. Resource means over the scored
pixels (HEAD → mesh), torus / sphere: carrying capacity 0.441 → 0.467 /
0.482 → 0.495, arable 0.167 → 0.175 / 0.200 → 0.212, fish 0.113 → 0.114 /
0.112 → 0.113, game 0.348 → 0.350 / 0.340 → 0.333, pasture 0.279 → 0.290
/ 0.328 → 0.337, timber 0.549 → 0.552 / 0.529 → 0.484, salt 0.018 → 0.018
/ 0.074 → 0.074, iron 0.151 → 0.156 / 0.174 → 0.178, gold 0.058 → 0.061 /
0.054 → 0.058, copper 0.053 → 0.053 / 0.041 → 0.029, silver 0.024 →
0.024 / 0.026 → 0.017. On Earth's relief (scripts/earthClimate.mjs, each
place sampled at its own height): Köppen groups the same shares, places
16/47 classes and 31 → 32/47 groups, January's error 3.6 → 3.4 °C.

**Checks.** `harness:pipeline`'s sphere checks of the ecology now hold the
pole (the fine raster's first row is the pole itself: one value, land and
sea apart) in place of the averaged pole rows, and the halo's check runs
on a geodesic lattice of the 2048 sphere (east-west / north-south 0.98 at
75°, the equator's 0.98, the half-maximum 19.4 / 19.7 units against
σ√(2 ln 2) = 19.3; the chart's mutation 0.26 = cos 75°). `harness:
roundtrip` holds the climate and the land fields bit for bit, the refusal
of the old layers, the world id over the climate's cells and the query's
chart. The sphere history's seam check compares the mean step across x =
0 with the mean step inside (at most twice): the largest single step was
compared before, and the new world's steepest continental slope crosses
x = 0 (0.140 against 0.121 inside, the mesh's nodes as steep there).
Found, not fixed: the mean step across x = 0 is 1.8 × the inner mean on
HEAD's world too (0.0109 against 0.0062; the mesh world 0.0109 against
0.0058) — a small systematic step at the sphere's chart seam, older than
this phase.

**Golden**: 0 hard failures, 153 metrics drifted, 120 of 138 stages moved
(the history's climate reads at the nodes feed the relief; the plates,
the mantle, the ocean age and the lattice unchanged), coverage kept (88
metrics vary; the biome shares are now the map's per pixel, the
climate's means per cell of its mesh). No seed changed. Main shifts: ice
volume −13 / −23 / −22 %, lake cells −19 %
(calibration, zulu), zulu's largest discharge ×2.7 (not traced; its
placer gold, read against it, −62 %), timber +11 / +25 / +33 % and
pasture −7 / −12 / −13 % — golden's chain now classifies the ecology's
biomes with the riparian bonus, as the worker always did (HEAD's golden
left it out); on the bench world through the runtime timber moved by
+0.5 % (torus) —, the springs +4 / +5 / +10 %, the water table's median
+19 / +35 / +10 %, the land fraction −2.0 / −1.1 / −0.5 %, the climate's
mean temperature unchanged to 0.01 °C.
`golden.json` re-recorded and the byte guard re-armed: 0 / 0 / 0, 46
stages byte-identical × 3.

2026-10-12: phase 6 BUILT — the flexure on the climate's field mesh, both
shapes, one path (`tectonics/flexure.ts`, its caller in
`pipeline/coupledEpoch.ts`). The convolution on a 512 × 256 raster (a
Gaussian of width α per band of Te, σ / cos φ folded onto the row, the
north–south weights by row area, the pole rows averaged) is gone, with
its pole handling and `deflectionAt`.

**The method: the plate equation**, ∇²(D ∇²w) + ρm g w = −ρc g h, the
finite-volume Laplacian applied twice — multiplied by A / (ρm g), K
diag(R / A) K w + A w = −(ρc / ρm) A h with R = D / (ρm g) = α⁴ / 4 per
cell: symmetric positive definite, so CG, matrix-free (two passes of K),
Jacobi, to 1e-10. Chosen over the Gaussian on the mesh because it is the
plate (the forebulge, the profile's true width, a varying D without
bands) and it converges in 40–76 iterations at this spacing. The
restoring force is the mantle's FULL density: the load is the material
change itself, so the Airy limit is ρc / ρm — what the raster's
compensation already was; its kernel width had used ρm − ρc, which made
α 1.53 × wider than the plate it compensated like. Now α is 18–99 km at
sea, 50 km (Te 20) to 127 km (Te 70) on land. The twist term of a
varying D, (1 − ν) ♢⁴(D, w), is left out, as landscape models do. The
nodes' load goes to the cells by the barycentric weights of the triangle
under each node (each node's volume kept whole), Te is asked at the
cells' centres, the deflection is read back at the nodes by the sampler.
No flexure state: the deflection goes into the nodes' z each epoch, so
the save holds nothing new (formatVersion 8 unchanged), and save → load →
continue stays bit-identical through z (pipeline harness).

**The spacing: the climate's mesh, W / 256** (62.4 km torus, 78.1 km
sphere; shared — no new mesh build), not the old raster's 31 km. At W /
512 (152 000 cells) the solve took ~1 s an epoch with any preconditioner
at hand (CG Jacobi 589 iterations to 1e-10, SSOR(1.5) 131 and still
1.1 s), because the iterations grow as (α / spacing)²; at W / 256 they
are 61–76 (torus) and 39–46 (sphere), 84–96 ms an epoch. ILU(0) diverges
on this matrix (positive off-diagonals, not an M-matrix), and the
two-level preconditioner's constant aggregates misjudge a fourth-order
operator (2000 BiCGSTAB iterations, not converged). The price: a young
orogen's α (50 km) is under a cell, so its half wavelength πα spans 2.5
cells — the answer there is the mesh's, its volume still exact; a
craton's spans 6. No constant was stated in cells (FLEXURE_CELL was the
raster's own size), so none converts.

**The analytic check** (`harness:fields` [4c]): a Gaussian strip of load
(σ 125 km, 1000 m) on a uniform plate of α 250 km against the line load's
profile q / 2α · e^(−|x|/α) (cos + sin)(|x|/α) convolved with it —
trough −437.6 m, forebulge +17.26 m at 848 km. The torus at 156 / 78 /
39 km: L2 2.31e-2 / 5.68e-3 / 1.40e-3, order 2.04 / 2.02, the forebulge
+17.11 m at 863 km (39 km); the sphere's equator 2.26e-2 / 5.50e-3 /
1.89e-3 (the plane's answer, the globe's curvature (α / R)² ≈ 0.6 % the
floor), +17.59 m at 847 km. ∫w dA over the compensated load 1 to 3e-11 on
both. CG iterations 59 / 240 / 984 (torus), 99 / 387 / 1645 (sphere). The
mutation (the cells' areas wrong) moves the integral by 2.7e-3.
`harness:mesh` holds the ridge: under it −1138 m (Te 20), beside it a
foreland basin, beyond it a forebulge of +20.6 m at 406 km (Te 70; πα +
the ridge's half width 447 km), the compensation 0.81818182. The
pipeline harness's sphere check: a unit load's integral 1.00000000 at the
equator, at 70° and at the pole; with the chart's areas 0.882.

**Measured** (2048 × 1024, seed `bench`, 100 Archean + 12 coupled epochs
at HISTORY_DEFAULTS, Node, one thread, run one after another):

| | torus HEAD | torus mesh | sphere HEAD | sphere mesh |
|---|---|---|---|---|
| flexure per epoch, mean | 127.5 ms | 96.3 ms | 137.6 ms | 84.3 ms |
| CG iterations | — | 61–76 | — | 39–46 |
| whole coupled epoch, mean | 1669 ms | 1208 ms | 1762 ms | 1680 ms |
| rebound max / mean of the epochs' maxima | 814 / 291 m | 2456 / 681 m | 868 / 357 m | 1616 / 668 m |
| subsidence max / mean | 345 / 206 m | 672 / 332 m | 1080 / 333 m | 615 / 374 m |
| the deposits and ice alone: trough / forebulge | −274 / 0 m | −253 / +11.2 m | −245 / 0 m | −370 / +6.5 m |
| area lifted > 1 cm by them | 0 % | 8.4 % | 0 % | 10.9 % |
| ∫w dA / compensated load, the epoch's / a unit load at equator, 70°, pole | 1.00000000 all | 1.00000000 all | 1.00000000 all | 1.00000000 all |

(The torus HEAD's whole epoch includes machine noise: its flexure is 31 ms
of the 461 ms.) The extremes are larger because the plate is narrower than
the kernel was: a point load's equivalent area is 2α² for the plate,
2πσ² for the Gaussian at σ = α_old — about seven times more concentrated
at Te 20. The load-weighted α of the last epoch is 61 km (torus), 64 km
(sphere), πα 191 / 200 km; the forebulge crest nearest the deepest trough
(young sea floor, α 18 km) lies 125 / 81 km from it.

**Golden**: 0 hard failures, 134 metrics drifted, 117 of 138 stages moved
(the flexure feeds the relief, so everything after the first epoch),
coverage kept (85 metrics vary). No seed changed. Main shifts: highest
point 2170 → 3194 m (calibration), 3079 → 3505 (alpha), 5392 → 5178
(zulu); ice volume −21 / −10 %; sediment volume +18 / −8 %; land 8.51 →
8.68 % (calibration); biome shares within a tenth of a point.
`golden.json` re-recorded and the byte guard re-armed: 0 / 0 / 0, 46
stages byte-identical × 3.

2026-10-12: phase 5 BUILT — the climate refinement and its phenomena on
the climate's field mesh, both shapes, one path (`climate/refinement.ts`,
`phenomena.ts`, `reliability.ts`, `storms.ts`): the months' sea-level air,
the plateau heat, pressure and wind, the ocean, the cold tongue and the
ocean highs, the rain, the overturning's warmth, fog and föhn, the rain's
reliability and ENSO, cyclones, tornadoes, blizzards, dust and thunder —
every part per cell, the lengths in metres. No raster, no pole handling
(the pole-row averaging of fog, föhn, reliability and storms is gone).

**The method.** The basins east-west (the cold tongue's place, the
ocean highs' flank, the ENSO basins) are the seas along the parallels:
per zonal band of the mesh a ring of points along its centre parallel,
one per mesh spacing of its true length, each the land or sea of its cell
(`climateMesh.basinRows`; on the torus a band is a row of cells and a
ring has the old row's 256 points). The ocean highs are smoothed by the
mesh's Gaussian; the fog's sea is the nearest sea cell over the links
(`distanceToSea`), its distance the straight one between the centres;
the föhn's and the tornado's barrier the highest texel of the cells
upwind every 62.4 km along the great circle (`ClimateTerrain.
peakElevation`, the texels' owners shared with the mean). The tracks
(cyclones, dust) step 62.4 km along the great circle (`Domain.advance`),
read the reached cell's wind carried into the point's frame
(`Domain.transport`), and find the cell by a walk over the links in each
cell's tangent plane; a cyclone launches from every other warm sea cell
weighted by its area over the mean.

**Constants converted** (the torus's 62.4 km climate cell, no
calibration):

| Was | Now |
|---|---|
| fogReachCells 2 (and the implicit first cell) | fogReachM 124 800, fogFullWithinM 62 400 |
| foehnReachCells 4 | foehnReachM 249 600 |
| tornadoReachCells 12 | tornadoReachM 748 800 |
| ensoReachCells 20 (and the same basin within 3 cells) | ensoReachM 1 248 000, ensoSameBasinM 187 200 |
| dustSteps 20 | dustTrackM 1 248 000 |
| cycloneSteps 60 | cycloneTrackM 3 744 000 |
| one cell a step (cyclones, dust, the looks upwind) | climateTrackStepM 62 400 (the keeps per step unchanged) |
| oceanHighBasinCells 40 | oceanHighBasinM 2 496 000 |
| oceanHighSmoothCells 8 (three box passes) | oceanHighSmoothSigmaM 529 000 (σ = √(8 · 9) cells) |

**Transition adapters.** Removed: refinement.ts's raster ↔ mesh
conversions (its land raster, `toMesh`, the transition rasters of every
step), its box blur (`blur`), `eastwardInBasin` and `basinFlank`;
`climateMesh.climateVectorFromRaster`; `map/vectorMarks.
rasterVectorReader` (and `globeVectorAt`) and the screen's raster
fallback for the marks (`sampleVector`): every wind and current mark
reads a field mesh in its point's own frame, the refinement's year and
months and its currents included, and a raster without its mesh has no
marks. Added, marked for phase 7: `refinement.refinedRasters` (the
refinement on the climate raster, once per refinement in the worker: the
biomes, the ecology, the hydrology's climate and the screen's textures,
readouts and month player read it) and `climateMesh.
climateLandOnlyRaster` (a land field that is 0 on the sea). Remaining for
phase 7, as before: weather.ts's rasters and climateMesh's
`climateRaster`, `climateVectorRaster`, `climateSeaRaster`,
`climateSeaVectorRaster`, `climateLandRaster`.

**Save** (fork 5 as revised, formatVersion 8 kept): the refinement's
quantised raster layers (`layers/temperature.01` … `layers/thunder`,
`layers/enso.json`; world/save/refinedLayers.ts, fieldSpec's
REFINED_FIELDS, worldLayers' REFINED_LAYERS) are gone. In their place
`refined/<field>.f32` per field, Float32 per cell of the climate mesh
(months × cells for the five month stacks), and `refined.json` (cells,
spacing, months, fields and units, the wind's unit, ENSO's period and
strength; world/save/refinedFields.ts). Float32, not Float64: no
simulation continues from the refinement, and the session itself keeps
these Float32 values (`RefinedClimate`), so a load is the session's to
the bit and is adopted without computing (the layers were u8/u16,
clipped at their ranges, the rain's sea mark lost). A save with the old
layers and no `refined.json`, with a field missing, or of another mesh
(`refinement.refinementFits`) is refused. The annual climate layers
(temperature, precipitation, seasonalAmplitude, monsoonIndex, koppen,
landMask) stay rasters for the save's own step. Readers: only the
screen read the refined layers (and roundtrip); the job worker, the
bake, world/query, the incubator and the Go server never did.

**Measured** (2048 × 1024, seed `bench`, 100 Archean + 12 coupled
epochs at HISTORY_DEFAULTS, the climate and the refinement on the mesh
rasterised to 2048, Node, one thread; the same worlds — the refinement
feeds nothing back):

| | torus HEAD | torus mesh | sphere HEAD | sphere mesh |
|---|---|---|---|---|
| climate (computeWeather) | 364 ms | 374 ms | 279 ms | 282 ms |
| the refinement | 4.84 s | 4.54 s | 4.24 s | 4.04 s |
| of it: phenomena / storms / reliability | 15 / 74 / 2 ms | 55 / 239 / 2 ms | 51 / 242 / 1 ms | 77 / 756 / 1 ms |
| its rasters (refinedRasters, worker) | — | 370 ms | — | 407 ms |
| the refinement in the save, deflated | 2.83 MB | 6.83 MB | 2.92 MB | 4.63 MB |
| the whole save | 15.14 MB | 19.14 MB | 16.57 MB | 18.28 MB |

Zonal means over land, the refined year (0–15° … 75–90°): temperature
torus 25.8 / 22.8 / 14.2 / 3.2 / −6.3 / −16.6 → 25.8 / 22.8 / 14.2 /
3.1 / −6.4 / −16.6 °C, sphere 25.2 / 23.4 / 14.0 / 5.1 / −5.1 / −10.3 →
the same to 0.1 °C (January and July within 0.3 °C); rain torus 1912 /
982 / 730 / 808 / 405 / 95 → 1859 / 946 / 686 / 782 / 373 / 93 mm,
sphere 1427 / 864 / 450 / 876 / 596 / 698 → 1361 / 834 / 416 / 903 /
637 / 712 mm. ENSO the same (torus 5.0 years at strength 1, the sphere
none). The fog's land mean 0.011 → 0.020 (torus), 0.013 → 0.009
(sphere). On Earth's relief (scripts/earthClimate.mjs): groups off 9 →
6 points, places 16/47 classes both, rain ×1.71 → ×1.77, the refinement
5.3 → 5.4 s. Two refinements give the same bytes; a refinement read back
through the save's form and handed back is adopted to the bit — values,
rasters, refined climate and the rivers after it (pipeline harness).

The storms' tracks cost: a cyclone step is a great-circle advance, a
transport and a walk, against the raster's index arithmetic; launching
from every cell doubled it (the sphere's 1.4 s), the walk by the
sampler's locate tripled it (19 s on Earth through the torus's
distanceSq; the tangent-plane walk is the fix).

**The sphere's seeds** (`SPHERE_SEED=c2…c6 node scripts/pipeline.mjs
sphere`): every refined field is now held smooth round each pole
(ringRoughness; the raster pole-row check had nothing left to check) and
passes on all five, as do the winds and currents across the poles. c2
and c4 pass whole; c3 (20.5 %), c5 (22.0 %) and now c6 (15.2 %, the
bound 15 %; it passed in phase 4 — the refined rain moved its lakes) fail
only the lakes' plausibility — found, not fixed. c5 also failed the seam
check on the months' cycle, 2.4 °C across x = 0: a fog step on a
fogbound coast (fog share 0.36–0.39 on both sides, no föhn), not a seam —
the cycle carries the fog and the föhn, which switch per cell and month,
so it left the seam check's smooth fields. The sphere filter takes
263–290 s a seed; the whole pipeline harness 743 s.

**Golden**: 0 hard failures, 0 drifted metrics, 0 moved stages — the
golden worlds never refine (its "refinement" is the hydrology's climate
pass); `ClimateTerrain.meanElevation` through the shared texel owners
kept its bytes. `golden.json` re-recorded and the guard re-armed (both
unchanged): 0 / 0 / 0, 46 stages byte-identical × 3.

2026-10-11: phase 4 BUILT — the ocean on the climate's field mesh, both
shapes, one path (`climate/oceanCurrents.ts`, `energyBalance.ts`,
`salinity.ts`): the wind-driven currents, the sea surface they make,
the anomaly carried inland, the Ekman upwelling, the salt and the
overturning's inflow, and the energy balance's year. The land is the
terrain's at the cells' centres (ClimateTerrain.land); the landmasses
and the seas are connected parts of the mesh's graph
(`climateMesh.meshComponents`), the rivers' mouths a Dijkstra over its
links (`distanceToSea`, now the continentality's too, byte-identical).
The cyclic line solver (`cyclicLine.ts`), the row lines, the
pole-row averaging and the sweep counts are gone.

**The method.** The Stommel balance ∇²ψ + β ∂ψ/∂x = curl τ in finite
volumes: the Laplacian's flux across each wall, the β term the flux of
β ψ carried due east (`fieldOperators.eastWallNormals`, the wall times
the east component of its normal, the mean of the two cells' views, so
exactly antisymmetric); the curl the divergence of the wind turned by
90° in each cell's frame; the velocity ψ's gradient turned back. The
island rule: the largest landmass by area holds ψ = 0, every other one
that touches the sea one unknown whose row is its cells' rows summed —
which telescopes to its coast exactly, both fluxes being antisymmetric.
The energy balance per harmonic: (B + iωkC) T̂ − D ∇²T̂ + a (u · ∇) T̂ =
(1 − α) Ŝ, the carry first-order upwind over the walls, in its real form
(two unknowns a cell, interleaved). The overturning's potential ∇²χ = −s
with no flux into land: its water now rises in the sea it sank in, each
connected sea its own balance — the reason the old Gauss-Seidel never
converged (an enclosed sea's Neumann problem had no solution); CG then
converges. The SST and the salt by the semi-Lagrangian transport
(linear, monotone, as the bilinear raster sample was), the departures
along the great circle by the midpoint rule; the anomaly carried
inland by a march upwind along the great circle in steps of the mesh's
spacing; the upwelling the masked divergence (`divergence(…, within)`:
no flux through a coast).

**The solver.** Not symmetric: BiCGSTAB (`fieldOperators.solveBiCGSTAB`),
to a relative residual of 1e-10, the true residual recomputed. Its
preconditioner is two-level (`twoLevelPreconditioner`): ILU(0) on the
matrix's own pattern (`sparseMatrix`, `ilu0`), then a coarse correction
on aggregates — patches of the graph within 6 links (the energy
balance's 12 in its interleaved form, real and imaginary apart), each
island its own — with the coarse matrix PᵀAP factored densely. The
coarse level carries an island's one value along its coast, which
ILU(0) relaxes slowly. Restarted GMRES was tried and stagnated (1400–
3000 products); a post-smoothing pass cost more than it saved. The
inflow keeps CG with Jacobi (symmetric, singular). Iterations to 1e-10
(bench worlds, 2048 × 1024; residual reached):

| solve | torus | sphere | HEAD (raster) |
|---|---|---|---|
| currents, 22–25 / 10 islands | 45–47 (Jacobi ~1100 on a 5-island test world; ILU(0) alone 200–280 to 1e-8) | 44–47 | 700 Gauss-Seidel sweeps, 0.078 of the field off its 2800-sweep value |
| energy balance, year / half year | 30–31 / 40–41 | 31 / 37–38 | 400 sweeps (converged, 0.0000 °C) |
| overturning's inflow (CG) | 784–786 | 688–690 | 700 sweeps, 0.11–0.22 of the field off its 2800-sweep value |

`harness:fields` [4b] holds the solver: a manufactured (∇² + β ∂x − α)ψ
= f, β by latitude, on both shapes at 312 to 39 km — second order (2.00
to 2.03), the same answer with Jacobi, ILU(0) and two levels, the
two-level iterations 17–32 (sphere) and 29–49 (torus), not growing with
the mesh as Jacobi's (79 → 721) and ILU(0)'s (25 → 206; torus 48 → 419)
do; and Stommel's analytic basin (a box of 6000 × 3000 km on the torus,
β = 1 / 300 km) through the stage's own solve: 3.5 / 3.0 % off at 78 / 39
km (the coast's jag of a cell, first order at best), the gyre's centre at
0.16–0.17 of the basin from its WESTERN shore; the mutation (β turned)
puts it at 0.83–0.84.

**Constants converted** (the torus's 62.4 km climate cell, as phase 3):

| Was | Now |
|---|---|
| currentsBeta 0.4 per cell | currentsBoundaryWidthM 156 000 (β = cos φ / it) |
| currentsAdvectStep 4 cells | currentsAdvectStepM 249 600 |
| currentsInlandReachCells 30, currentsInlandDecayCells 15 | currentsInlandReachM 1 872 000, currentsInlandDecayM 936 000 |
| ebmExchange 40 W/m²K per neighbour | ebmDiffusionWPerK 40 × 62 400² |
| ebmCarryPerWind 100 per cell | ebmCarryPerWindM 100 × 62 400 |
| the upwelling's divergence per cell | × climateGradientLengthM (62 400) |
| currentsSolveIters 700, ebmSolveIters 400, conveyorSolveIters 700 | gone (a residual of 1e-10) |

**Transition adapters.** Removed: weather.ts's (the wind and the
temperature rasterised for the currents, the SST change brought back
at the centres); the screen's currents read their raster (the static
currents' marks read the mesh through `WorkerClimateDataMessage.
currentsMesh`, as the wind's). Added, marked: `climateMesh.
climateVectorFromRaster` (phase 5: the refinement's input wind onto
the mesh, each pixel's vector carried to the cell before it is
weighed), `climateSeaRaster` / `climateSeaVectorRaster` (phase 7: a sea
field rasterised with 0 on the raster's land, the readers' old form),
and refinement.ts's `eastwardInBasin` / `basinFlank` (phase 5, moved
there: the equatorial cold tongue's and the ocean highs' rows). The
refinement runs its ocean and its year on the mesh and takes the rest
back on the raster (phase 5).

**Save**: the static climate's currents and SST are not saved — they are
recomputed on load with the climate. The refinement's currents
(currentU / V), currentAnomaly, upwelling, salinity and deepWater stay
the save's quantised raster layers (formatVersion 6's refined layers,
written from the transition rasters); they move with the refinement
(phase 5) and the save's own step. formatVersion 8 unchanged.

**Measured** (2048 × 1024, seed `bench`, 100 Archean + 12 coupled
epochs at HISTORY_DEFAULTS, Node, one thread):

| | torus HEAD | torus mesh | sphere HEAD | sphere mesh |
|---|---|---|---|---|
| climate per climate epoch (4 of 12) | 409 ms | 402 ms | 404 ms | 298 ms |
| climateRun on the 2048 raster | 364 ms | 351 ms | 371 ms | 262 ms |
| of it: currents + SST | 308 ms | 255 ms (currents 204) | 306 ms | 171 ms (currents 116) |
| the refinement | 5.39 s | 4.53 s | 5.77 s | 4.04 s |
| of it: energy balance / inflow | 582 / 1415 ms | 552 / 362 ms | 855 / 1598 ms | 438 / 198 ms |
| whole coupled epoch | 1268 ms | 1260 ms | 1774 ms | 1767 ms |

The gyres (the static currents rasterised, sea only, 15–45°; HEAD →
mesh): the same sense of rotation, the subtropical gyres clockwise in
the top hemisphere and anticlockwise in the bottom (mean vorticity
−4.3e-2 / +4.3e-2 → −3.7e-2 / +3.5e-2 torus, −2.7e-2 / +2.8e-2 →
−4.1e-2 / +3.9e-2 sphere); the western boundary's meridional speed over
the eastern's 1.30 → 1.43 (torus), 1.39 → 1.31 (sphere), the refined
currents' 1.54 → 2.17 and 2.12 → 1.98. Zonal means follow the wind (the
westerlies' band +0.29…0.33 → +0.23…0.30 torus); on the sphere the
currents are stronger after the normalisation (mean 0.147 → 0.224), the
raster's fastest cell having been a pole row's. The SST anomaly over
the sea, p5 / p95: torus −0.96 / 1.17 → −0.82 / 0.82 °C (min −10.1 →
−7.4, max 4.6 → 4.2), sphere −1.16 / 2.17 → −1.43 / 2.26 °C (max 9.7 →
9.3); the refined, torus −1.66 / 2.30 → −1.24 / 2.38, sphere −1.49 /
4.76 → −1.71 / 5.26 °C. Two runs give the same bytes; save → load →
continue is bit-identical (pipeline harness).

**Golden**: 0 hard failures, 101 metrics drifted, 117 of 138 stages
moved (the climate's and everything after it — the history's sea
surface feeds its erosion; the plates, the mantle, the ocean age, the
boundary lattice and `climate.wind` unchanged, so the CG's move into
`conjugateGradient` kept the mantle's bytes), coverage kept (85
metrics vary). No seed changed. Main shifts: ice volume −4 / +2 % (the
calibration's, zulu's), lake cells +13 % (alpha), river reaches −2 to
−4 %, rich fishing grounds +27–29 % (calibration, zulu), zulu's highest
point 5677 → 5392 m, biome shares within a tenth of a point.
`golden.json` re-recorded and the byte guard re-armed: 0 / 0 / 0, 46
stages byte-identical × 3.

**The sphere's seeds** (pipeline harness, `SPHERE_SEED=c2…c6 node
scripts/pipeline.mjs sphere`; each run's world varies with the Archean's
timing): the polar seas' current check now asks each pole apart and
SKIPS a pole with no sea poleward of 75° with the reason in its line
(c2 and c6 had both poles under land, c3 the north) — no NaN; the
currents themselves are finite everywhere (the field check). The
refined seasonal range joins the mesh-fed fields held smooth round a
pole (its months carry the mesh's cycle). c2, c4 and c6 pass whole; c3
and c5 fail only the lakes' plausibility (20.5 and 22.0 % of the land
under lakes, the bound 15 %; phase 3 saw it on c5 and HEAD's c6) —
found, not fixed. The sphere filter takes 293–308 s a seed (HEAD's c4
256 s); the whole pipeline harness 688 s (HEAD 525 s).

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
