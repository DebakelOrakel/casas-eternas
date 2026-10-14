# generator — the flat-torus generator

The world **wraps in both X and Y**. Every distance, offset and rotation between
points goes through the `Domain` (`core/domain.ts`), never `core/toroidal.ts`
directly — `make lint` refuses that import (DEC-0035,
`docs/decisions/two-shapes.md`); a plain `dx = a - b` is a bug near the seam.
A raster wraps through the `DomainGrid` its Domain gives (`domain.grid(resX,
resY)`: `wrapCol`, `index`, `neighbour`, the samplers, and `colTable` /
`rowTable` for hot loops), never `wrapValue` or `% width` — `make lint`
refuses `core/field.ts`'s wrap and samplers outside `core/` too, the
periodic noise lattices excepted. See `docs/decisions/world-topology-torus.md`.
What a unit or a cell measures in metres is the Domain's too
(`domain.metresPerUnit`, `domain.metresAround`; DEC-0035 fork 6) — `make
lint` refuses `core/mapConfig.ts`'s shape constants elsewhere.

**A raster stage measures in lengths, not in cells** (DEC-0035 fork 5, step
4d5): the sphere's rows narrow as cos φ. A step east-west costs
`grid.rowScale(y)`, a cell weighs `grid.cellArea(y)`, a face between rows
`grid.edgeScale(y)` (0 at a pole); a semi-Lagrangian departure goes through
`grid.tapsAt` + `sampleTaps`, a step to a displaced cell through
`grid.cellDisplaced`, a track that marches through `grid.displaced`, a
figure drawn in the plane about a point back through `Domain.fromPlane`;
a field the stage smooths ends with
`grid.averagePoleRows`. On the torus every one of these is 1 or the old
arithmetic, so write each formula so that it IS the torus's operations when
the weights are 1 (`1 * x`, `x / 1` and `x + 0` keep the bits; a changed
summation order does not) — golden then stays byte-identical. A vector read
across a pole (its east is the far side's west) needs thought; a scalar does
not.

`generatorWorker.ts` is the entry point and stays at this root, but it is **only
transport** — twenty-odd lines wiring `self` to the pipeline. The pipeline is
`pipeline/runtime.ts`: it holds every stage's live state as module-level `let`s
and orchestrates everything below. It takes its emitter and its elevation
renderer from the host (`setEmitter`, `setElevationRenderer`) and touches no
browser API itself, so it can be driven directly from Node — which is the only
way this part of the generator can be tested at all, since the golden harness
does not reach it. `pipeline/messages.ts` is the message contract.

**The history runs on ONE step loop** (`runtime.ts` `startLoop`, both eras,
2026-10-11): a step and its render, then exactly one timer for the next
step. Never a `setInterval`, never a second timer: a stop clears the one
timer, a step in flight finishes as the settled picture, nothing starts
after the stop. A step that throws ends the loop with `stageFailed` and a
settled picture.

Where this is going: [docs/design/generator-pipeline.md](../../../docs/design/generator-pipeline.md).

```
pipeline/   messages (the worker contract), runtime (stage state + handlers)
core/       mapConfig, toroidal, rng, field (the shared samplers), minHeap, interpolation,
            domain (the topology: periodicity, distance and latitude on the torus),
            detMath (exp, log, sin, cos … the same bits in every JS engine)
mesh/       the adaptive mesh (ADAPTIVE_MESH_PLAN.md phase 4): periodicDelaunay (the
            triangulation on a domain — one topology code, the geometry planar on the
            torus and exact 3D on the sphere), lattice (the bootstrap: hex on the torus,
            geodesic on the sphere), hilbert (the insertion
            order), meshDensity (the ONE density rule, MESH_TUNING), meshState (per-node
            fields that survive remeshing), meshRelief, remesh (hysteresis insert/remove),
            meshBuild (fields in, mesh out), meshErosion (the erosion engine's graph index
            from the triangulation, the run adapter), meshRaster (node fields sampled on a
            grid), meshSerial (the save's form: Hilbert numbering, varint connectivity,
            the canonical rebuild), meshSampler (point location over a hint grid,
            heights, fields and normals at a point — what map/ reads the mesh through),
            meshRefine (one rung of the ladder: a parent refined to a finer budget,
            parents kept, new nodes from the parent surface plus synthesis),
            meshTile (the top level's tile: nodes placed by position, a pinned
            edge row every tile shares with its neighbour, the tile plus its halo
            triangulated as a small torus — docs/decisions/tile-jobs.md),
            meshColumn (phase 5.2: the sediment column per node as epoch-indexed
            layers with provenance — a stacked MeshState field, cut from the top,
            the save's mesh/column.bin), meshNeighbourhood (DEC-0036 phase 7: a
            node's neighbourhood in metres — the cells a reach touches, a mean by
            the area of each inside it —, halos, discs, the slope, a boundary's
            length per area: the ecology's windows on the mesh).
            meshRaster.rasteriseNodePart draws a field a part of the nodes holds
            (the land's) onto a raster without blending in the other part.
            pipeline/coupledEpoch.ts is phase 5's loop over it: z = baseline + relief
            per node, nodes drift with their plates, the mesh is rebuilt and remeshed
            each epoch (subduction and rifting), erosion runs inside the epoch.
            `node scripts/calibrateHistory.mjs key=value …` prints what a setting does
            to a world over N epochs — the calibration's instrument, not a gate.
            The generator's erosion stage runs on it
            (pipeline/meshErosionStage.ts), the lakes and the river graph run on it
            (meshHydrology: the flow substrate) and the save carries it; the map and the
            raster consumers still read its 2048 rasterisation until 4.4
fields/     the field mesh (DEC-0036): fieldMesh (a uniform mesh over a Domain at a spacing
            in metres — Goldberg cells on the sphere, relaxed into a centroidal grid since
            phase 3 (mesh/lattice.ts centroidalGeodesicLattice), hexagons on the torus — its
            geometry, the sampler, the chart rasters in and out, sharedFieldMesh: one mesh
            per domain and spacing, the stages that ask for the same one share it),
            fieldOperators (diffusion, Gaussian smoothing, gradient, divergence,
            semi-Lagrangian transport, the Helmholtz/Poisson CG solve, and since
            phase 4 the general solvers: conjugateGradient, BiCGSTAB, a sparse
            matrix, ILU(0) and a two-level aggregation preconditioner).
            `npm run harness:fields` holds each against an analytic answer
planet/     the Planet stage's controls and their forcing (obliquity, orbit, sun, rotation) —
            what depends on the planet and not on the relief; the climate reads it
mantle/     the buoyancy field BOTH eras run on — the substrate, so it depends only
            on core/, crust/ and fields/ and never on tectonics/; on the field mesh
            since DEC-0036 phase 1 (mantleMesh: the mesh per domain, mantleAt the
            sampler, rasteriseMantle the overlay; the save holds its cell values)
archean/    the Archean era; hands over to tectonics via finalizeArchean.ts, which
            is the ONLY archean file that may import from tectonics/
tectonics/  plate*, boundary*, oceanAge (on the field mesh since DEC-0036 phase 2: oceanAgeMesh,
            oceanAgeAt the sampler, the transport by the plates' exact departures,
            the ridges' new crust where a departure crosses to another plate),
            trench (phase 8e: the trench under the history's baseline, on the
            boundary where an oceanic plate subducts), terrainFeatures, volcanoes,
            tectonicsTuneParams (tuning constants), epoch/ (the per-epoch phases),
            flexure (phase 5.3: Te as a field, the plate's deflection to a load
            change; since DEC-0036 phase 6 the plate equation ∇²(D∇²w) + ρm g w = −ρc g h
            solved by CG on the climate's field mesh, read back at the nodes), folds (phase
            5.7: the buckling train across a range as a modulation of the uplift)
crust/      continental crust as rafts — deliberately decoupled from the plates
            (docs/decisions/continental-crust-rafts.md); crustTuneParams holds the
            raft rules both eras pass in
elevation/  elevationScale (what a height MEANS), elevationField, domainWarp, ridgedNoise,
            globeNoise (the 3D lattice the sphere samples its noise on, Domain.noise)
surface/    flowRouting (the raster engine's routing vocabulary), erosionEngine* (the engine,
            its state, pool, worker), erosionPassV2, flowSubstrate (what the hydrology
            reads of the mesh), hydrology (the discharge, the lakes, the channel criterion,
            the watersheds, riparianPrecipitationOn: the rivers' wet margin per node),
            riverGraph (the feature graph), riverCourse, coastGraph (the coast reaches on
            the mesh's shore nodes), sedimentBasins (node sets),
            cover (phase 5.5: the vegetation's hold per biome — one table for the
            erodibility, the critical slope and the river banks), hydrogeology (phase 5a:
            springs, the regime with baseflow, the water table — a classification over the
            column, no process; per node of the mesh), glacial (phase 6: the epoch's ice
            on the mesh at its steady state, the cut it does, the till it leaves; F4's
            raster forerunner iceFlow went in DEC-0036 phase 7), coastal (phase 7: the
            waves' cut at the shore and the one-line drift along it; findShore and
            shoreExposure, which the coast graph shares), amplify
            (the mesh level's synthesis layers and the level bake's constants)
climate/    the static climate on the field mesh since DEC-0036 phase 3 (climateMesh: the
            mesh W / 256, shared with the ocean age, the terrain read onto it, the zonal
            means, the distance to the sea, the landmasses and seas as graph components):
            temperature, wind, seasonality, monsoon,
            precipitation, pressure; since phase 4 the ocean too (oceanCurrents: the
            Stommel solve with the island rule, the SST, upwelling, the overturning's
            inflow; energyBalance: the year's cycle; salinity); since phase 5 the
            refinement too (refinement: the months, pressure and wind, the ocean highs
            and the cold tongue by basinRows — the seas along the parallels — the rain;
            phenomena, reliability, storms: tracks along great circles). Since phase 7
            every reader outside the climate samples it at ITS points (climatePoints:
            ClimateCells — the temperature reduced to sea level, the land fields with
            their sea marks, the months — and climateAtPoints, each point its own
            lapse, the land fields over the land corners); biomes classify per point
            (biomes.classifyPoints, the Köppen class too); climateChart draws the
            climate on its 256 × 128 chart for the screen and a save's readers — no
            stage reads it
ecology/    the ecology and the resources per node of the terrain mesh (DEC-0036 phase 7):
            the climate at the nodes, the reaches in metres (mesh/meshNeighbourhood),
            the screen's rasters from the nodes (ecologyRasters)
migration/  still on the climate's chart (its own screen, later); render/
```

**A new simulated field goes on a mesh, not on the 2:1 raster** (DEC-0036,
`docs/decisions/fields-on-meshes.md`). A coarse global field (mantle, ocean
age, climate, flexure) lives on the field mesh (`fields/`), a fine land field
on the adaptive terrain mesh; the chart is the address, the textures and the
save. Read a field mesh through its `FieldSampler`, never by a grid index;
write it out with `rasteriseField` (cell centres, the DomainGrid's convention).
Its vectors are east/south pairs in each cell's own frame — carry a
neighbour's through `carryFrom` before adding it. Phase 0 (the operators),
phase 1 (the mantle), phase 2 (the ocean age), phase 3 (the static
climate), phase 4 (the ocean and the energy balance), phase 5 (the
refinement and the phenomena), phase 6 (the flexure), phase 7 (biomes,
Köppen, ecology, resources, hydrogeology on the terrain mesh), phase 7b
(the hydrology's discharge, watersheds, coast reaches and sediment basins
on the terrain mesh; no routing on the 2:1 raster) and the save step (no
chart raster in the save: the elevation, the lakes' depth and the erosion
forcing are made by whoever reads it — world/query.ts) are built. A solve runs to a RESIDUAL (its
SolveReport), never to a sweep count: a non-symmetric operator takes
`solveBiCGSTAB`, a symmetric one CG, and a singular one (a Neumann
problem) a right-hand side balanced per connected part. A length in a
stage on the mesh is in METRES (the mesh's, `domain.metresPerUnit`), never
in cells — and so is every physical length a tuning object states (a
range's cross-section, a craton's radius, a critical catchment in m²;
DEC-0036 phase 8a, written so the torus's division is exact, 234 000 /
7 800 = 30). A planetary COUNT is measured against the world's area
(`domainArea`: the plates' spacing, the mantle mesh's cells), and a noise
table counted in cells across the map is read on the sphere at the
torus's metres (`globeOctaveOn`). The plates' kinematics too since phase
8f: a motion is in domain units (and radians) per Ma, a speed the tuning
states in km/Myr (`plateMotion.kmPerMyr`, `mantleFlowSpeedKmPerMyr`), the
features' spacing along a boundary in metres (`MERGE_RADIUS_M`, the
segments' half-lengths, `splitGapM`). A stage not yet moved reads a moved field through an adapter
marked `// DEC-0036 transition: removed in phase N` — grep for it before
touching the phase it names (none is left since phase 7b). A stage that
needs the climate samples it at its own points
(climate/climatePoints.ts), never on the chart. A field mesh's values are SAVED as values (Float64, with
the mesh's cell count and spacing — `fields/fieldMesh.SavedField`), never as
a raster: the mesh rebuilds deterministically, and a load then continues bit
for bit (`mantle.f64` + `mantle.json`, `oceanAge.f64` + `oceanAge.json`).
A diagnostic field that no simulation continues from may be Float32 when the
session keeps the same Float32 values it saves (the refinement: `refined.json`
+ `refined/*.f32`, world/save/refinedFields.ts; the annual climate the land
fields came from: `climate.json` + `climate/*.f32`). A terrain-mesh field is
saved per node in the saved mesh's numbering (`mesh/biome.u8`,
`mesh/koppen.u8`, `mesh/waterTable.f32`, `mesh/discharge.f32`,
world/save/climateFields.ts; what the last epoch left, `mesh/sedimentFlux.f32`,
`mesh/preErosionZ.f32`, `mesh/ice.f32`, worldArchive.MESH_EPOCH_FILES); a table that names nodes names them by
vertex id of the saved mesh (`layers/coast.json`'s `nodes`; the water body
per node, `mesh/lakeBody.i32`, indexes `layers/waterBodies.json`). **The
save holds no chart raster** (DEC-0036's save step): a field a reader can
make from what the save holds — a rasterisation, a function of the
snapshot — is not saved; save what a load cannot derive, per node or per
cell, and let world/query.ts draw the raster.

## Resolutions — check before you sample

Fields do **not** share one grid. This is the single most common source of wrong
answers here.

| Grid | Size | Holds |
|---|---|---|
| World / macro raster | 2048×1024, 7800 m per cell (the sphere's 9766 m at the equator: `domain.metresPerUnit`, DEC-0035 fork 6) | elevation and lakeDepth (rasterisations of the mesh's heights and lakes, made again on load — not in the save); the screen's rasters of the terrain-mesh fields (the discharge, the watersheds, the coast type among them) |
| Terrain mesh | adaptive, 8–31 km on land at the history's budget 4, up to 160 km at sea | biome, Köppen class, ecology and resources, water table (DEC-0036 phase 7), the lakes, the discharge, the river graph, the watersheds, the coast reaches and the sediment basins (phase 7b) |
| Climate | field mesh, spacing W / 256 (the ocean age's): temperature, wind, seasonality, monsoon, precipitation, pressure (DEC-0036 phase 3), the currents, the SST, upwelling, salt, the year's cycle (phase 4), the whole refinement with its phenomena, reliability and storms (phase 5); 256×128 (~62 km per cell) only as its chart, for the screen and a save's readers | — |
| Ocean age | field mesh, spacing W / 256: 37 888 cells at 62 km (torus), 24 012 at 78 km (sphere); a 1024×512 raster only inside the render's baseline | oceanAge (epochs) |
| Flexure | field mesh, spacing W / 256 (the climate's, shared); no state kept, the deflection goes into the nodes' z each epoch | the epoch's load, Te, the deflection |
| Mantle | field mesh, spacing by area, √(world area / (128 × 64)) (DEC-0036 phase 8a): 9 472 cells at 125 km (torus), 9 612 at 125 km (sphere); 128×64 only as the overlay | mantle buoyancy and flow |

The save holds no raster layer (DEC-0036's save step, 2026-10-12): the
climate, the land fields and the discharge are mesh values (phases 7 and
7b), the lakes a water body per node, the terrain the mesh, and
`world/query.ts` makes every raster view on open — the elevation by
`rasteriseNodeField`, the lakes' depth by `waterFieldsFromMesh`, the
forcing's `uplift` / `erodibility` (256 × 128) by
`erosionForcing.coarseForcingFields` from `state.json` — the session's
own functions, so the views are the session's rasters bit for bit.

Note what a coarse save layer means for a field that is computed finely: the
reduction is a *choice*, and `downsampleMax` is the wrong one for anything
sampled per point. `lakeDepth` used to take it, which let a single lake cell
claim its whole 62 km cell and inflated saved lake area 4× (2026-08-09).

**The save is the sole authority.** A finer mesh level is derived: level 1
the save's recipe replayed at its budget (`world/replay.ts`, since
2026-10-01), the tiles refined from it — artifacts, never serialized into a
save and never fed back into the generator. "Finest available" is therefore
never the right rule for picking a source. (The 4k/8k raster amplification that
this rule was written for went on 2026-09-29.)

Ocean is marked by a different sentinel per aspect — `OCEAN_PRECIP`,
`OCEAN_AMPLITUDE`, `ECOLOGY_OCEAN` (which is `-1`, so "no negatives" is the wrong
invariant for ecology fields) — plus plain `elevation > 0` in other places. Do
not assume; look up which one the field you touched uses.

## Before touching anything: the harnesses

```
cd client && npm run harness:roundtrip       # the save format; 0.2 s
cd client && npm run harness:mesh            # the adaptive mesh; ~5 s
cd client && npm run harness:fields          # the field mesh's operators; ~30 s
cd client && npm run harness:pipeline        # the pipeline's behaviour; ~13 min
cd client && npm run harness:golden          # the generator; ~20 min (4 world builds at 2048×1024, 4 coupled epochs each)
cd client && npm run harness:golden:record   # re-record the metric baseline, on purpose
cd client && npm run harness:golden:hash     # arm the refactor guard (layer 4)
cd client && npm run calibrate               # the calibration's distributions; ~1 h, not a gate
```

`npm run calibrate` (scripts/calibrate.mjs, DEC-0036 phase 8a) builds many
worlds of both shapes at 2048 × 1024 the way the screen does (the Archean
to its 0.5 gate, or to `archeanMa=` as a player stops it, at `landShare=`;
40 coupled epochs, the climate step with its refinement,
the hydrology) and prints the distributions the calibration is judged on,
with the planet's and the genesis's sliders swept; `report <run.json>
[<before.json>]` prints a run against another; `cache=<dir>` keeps each
world's terrain after its history, and `climate cache=<dir>` runs the
climate step alone on those terrains (20 s a world — a climate constant
or lever judged without the history). Judge a tuning change there,
not on a harness world (their land is out of proportion).

`golden` has three permanent layers: **invariants** (no baseline, so a failure is always a
bug), **determinism** (one seed built twice in the same run, hashed against
itself), and **metrics** (magnitudes against `golden.json` with per-metric
tolerances, default 2 %, reported as deltas). It loads the real modules through
Vite's SSR pipeline because these modules use extensionless imports.

**Refactoring? Arm layer 4 first.** `npm run harness:golden:hash` freezes a
per-stage byte hash into `golden-hashes.json`, and every later `npm run harness:golden`
reports any stage that moved. Delete the file when the refactor lands — the
layer exists only while the file does. It is needed because the other three
cannot make this check: metrics carry a 2 % tolerance, so a sub-percent shift
passes green, and determinism only ever compares a run against itself inside one
process. The baseline is machine-local and gitignored; record it where you work.

**Know its blind spots:**

- It does **not** cover `pipeline/runtime.ts`. Message ordering and cache
  invalidation are invisible to a field check — that is `npm run harness:pipeline`'s job
  (see its own header). It drives the real pipeline headless on a small world:
  hand-over, resets, save→restore, the stage chain, invalidation, stopping a pass
  mid-flight. Run it after touching anything under `pipeline/`. What it still does
  NOT reach is the screen — panel switching, button state and the DOM half of a
  reset are unguarded.
- It does **not** cover the level bake's terrain — `npm run harness:mesh`
  bakes level 1 and checks that parents are kept, no node crosses the coast, the
  same save bakes the same level and the artifact reads back identical (the
  artifact cache depends on that absolutely). The artifact KEY is guarded
  separately — `npm run harness:roundtrip` checks that every constant
  AMPLIFY_CONSTANTS lists actually moves the pipeline version.
- It does **not** cover the adaptive mesh — `npm run harness:mesh` does, in seconds
  on a synthetic world: the triangulation's structure, the density rule's
  convergence inside its hysteresis band, state conservation through a
  remesh, determinism. Its `measure <save.zip>` mode reports node counts on
  a real save; that is how MESH_TUNING's constants were set.
- It does **not** cover the save format. That is `npm run harness:roundtrip`'s job —
  quantisation, the recipe's layout, the identity hashes, the artifact bytes and
  the shared zip reader, in 0.2 s. Run it after touching anything under
  `world/save/` or `storage/`.
- Before blaming a golden failure on your change, `git stash` and re-run to see
  whether it already fails on `HEAD`.

## Parameters and identity

Every module with tuning has an `xyTuneParams.ts` holding ONE object; genesis,
erosion, climate, hydrology, ecology and migration also declare their sliders in
an `xyInputParams.ts` (min/max/step/default/unit/i18n key), and `world/save/worldSpec.ts`
turns those declarations into the save's recipe. The reasoning is in
`docs/design/architecture-unification.md`.

Deliberately still outside a tuning object: `elevationScale.ts` (a definition
module and a fifteen-file contract), each module's EXPORTED constants (an export
is a cross-module contract and moves separately), and `surface/`'s
`DEFAULT_*_PARAMS` (function arguments with defaults, not module constants).

**A tuning file exports ONE object, and callers read it under its full name** —
`TECTONICS_TUNING.splitGapM`, never a destructured local and never an
`as TUNE` import. The object is what makes the constants hashable at all
(`derivePipelineVersion` takes a `Record<string, number>`); the full name is what
keeps every use site findable by grep. Both shortcuts were tried and removed the
same day.

**Not every constant belongs in a tuning object.** Only those whose change alters
the generated world. Grid sizes, unit anchors (`elevationScale` calls itself the
place that says what a height MEANS), enum ids and sentinels are structural;
colours, decimation and exaggeration are presentation — a colour change must
never invalidate an artifact. Slider endpoints are a third thing again: they are
the input's schema, so they belong with `xyInputParams`.

**A hash belongs to the consumer, not to the module.** Do not add a canonical
`hashParams()` anywhere. `world/identity.ts` explains why in detail, and it
was learned expensively: `deriveWorldId` hashes the world's state as the save
holds it — the terrain mesh's bytes, the climate's cells, the erosion forcing
and the field meshes' values (no raster since DEC-0036's save step; the
elevation and precipitation rasters until then) — rather than the recipe,
because the recipe cannot distinguish two worlds stopped at different
tectonic epochs; and `riverDensity` is deliberately excluded from the key even
though the bake reads it, because including it orphaned 17–67 MB of artifact per
slider position.

Tuning constants *are* hashed, via `derivePipelineVersion`, but only one module
feeds it today.

## Traps that have bitten before

**Math is not the same in every engine.** `Math.exp`, `log`, `sin`, `cos`,
`tan`, `atan2`, `pow`, `hypot` and `**` may differ in the last bit between
V8 (Chrome, the Node job worker) and JavaScriptCore (Safari); a world made in
Safari was made again by the server identically up to epoch 93 of 151, then
not (2026-10-02). Use `core/detMath.ts` (`detExp`, `detSin`, `sq` …) — a
port of fdlibm out of exact operations only. `make lint` refuses the others
in `generator/`, `render/` excepted; `harness:mesh` holds a hash of
detMath's values confirmed in both engines.

**Routing differs by step, and conflating them is a recurring mistake.** Erosion
is hybrid: drainage-area *accumulation* is MFD, stream-power *incision* is
single-flow. Rivers in `hydrology.ts` are pure single-flow for both — MFD
smeared the drawn channels into valley-floor bands. On the mesh the
single-flow receiver is the steepest descent over a node's star, per reach
length; on the raster engine's grid (erosionEngine's FLAG_GRID8) it is
D8-LTD, not plain steepest descent (2026-08-15 — plain D8's rounding error
accumulates into axis-parallel streaks, and worse the finer the grid). The
hydrology's own raster routing (`fillDepressionsAndRouteFlow`) went in
DEC-0036 phase 7b.

**The overlay canvas is displayed vertically mirrored.** Draw "up" as `+y`; text
needs a further 180°. It is a vertical mirror, not a 180° rotation — arrow
directions depend on that distinction. Affects `render/continentLabelRenderer.ts`
and the paint layers in `screens/generator/`.

**Vector overlays must wrap.** The compositor canvas does not wrap, so a label or
marker straddling the seam gets clipped and the tiling then repeats the clipped
copy. Any new vector paint layer drawing at specific map coordinates goes through
`paintWrapped`; full-raster layers already cover the canvas and do not need it.

**Workers spawned from inside a worker use the `?worker` import form**, not
`new URL(..., import.meta.url)` — `import.meta.url` is empty in a nested worker in
Firefox, and the worker is created but never runs. The render pool that
`pipeline/runtime.ts` constructs is exactly this case. (The Firefox failure is
dev-server only; production builds are fine.)

**Erosion deletes the material it removes** — there is no excavation budget. That
is a deliberate, documented unrealism; marine deltas are a separate shipped
mechanism. A sediment-budget attempt failed because erosion and deposition only
discriminate mountain from plain when they compete in one sweep.

**The generator erodes on the mesh, inside the tectonics' epochs; the raster
is a rasterisation** (phase 4.3 then 5.1, 2026-09-23). There is no erosion
run: `pipeline/coupledEpoch.stepCoupledEpoch` moves the mesh's nodes with
their plates, rebuilds and remeshes it, swaps the tectonic baseline under the
relief and runs the engine for the epoch's length (`sim.epochMa`, the world
clock's `TECTONIC_MA_PER_EPOCH`; `HISTORY_DEFAULTS` holds the iterations,
budget and uplift scale). The runtime rasterises z and sediment flux to 2048
after every epoch for the hydrology, the climate and the map; the raster is
therefore DERIVED and the save holds none — a load rasterises `mesh/` again
(`renderTerrain`, byte for byte the session's); `mesh/` is the terrain, and a restored mesh
must step to the same bytes as the session's — which is why positions are
float32 on insert and the mesh is renumbered through the codec after every
epoch (`mesh/meshSerial.compactMesh`). Do not hand the engine a mesh that has
not been compacted and expect a reload to match. The erosion step is gone
(2026-09-29); its former sliders are the tectonics panel's
(`tectonics/tectonicsInputParams.ts`), its readout the climate step's.

**The hydrology runs over a flow substrate** (phase 4.3, 2026-09-23).
`surface/flowSubstrate.ts` is the one interface the discharge, the lakes, the
channel criterion, the regime, the watersheds, the river graph and the
sediment basins read; the mesh is its one instance since DEC-0036 phase 7b
(the raster routing's went). Write a new hydrology rule against the substrate
(`…On(sub, …)`), never against `width`/`height` and cell arithmetic, and read a
graph node's place from `node.x/y` or `cellX/cellY`, never from `cell` as a
raster index — a mesh graph's cells are vertex ids.

**The erosion engine runs on a graph, not on a grid** (phase 4.2, 2026-09-23).
`EngineIndex` is a CSR neighbour table with a reach length, a Voronoi facet and
a reverse edge per directed edge and an area per node; the raster is one
instance (eight D8 slots, facets only across the four sides, area 1 —
`FLAG_GRID8` is the one place a kernel may assume the slot order, the LTD
scan), the mesh the other (`mesh/meshErosion.ts`). A kernel that indexes
`nbr[cell * 8 + slot]` or counts in cells is wrong on the mesh even if the
raster harnesses pass; walk `nbrStart[i]..nbrStart[i + 1]` and multiply by
`areaRel` / `lenRel`. `harness:mesh` runs the engine on a mesh and checks the
sediment budget closes; golden runs it on the raster.
