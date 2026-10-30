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
summation order does not) — the engine, which ports these formulas, keeps the same rule. A vector read
across a pole (its east is the far side's west) needs thought; a scalar does
not.

`generatorWorker.ts` is the entry point and stays at this root, but it is **only
transport** — twenty-odd lines wiring `self` to the pipeline. The pipeline is
`pipeline/runtime.ts`: it holds a handle on the world in the Rust engine's
WASM build (DEC-0044, `pipeline/engine.ts`), which computes every stage, and
orchestrates the steps, the stages and the picture. It takes its emitter and
its engine from the host (`setEmitter`, `setEngine`) and touches no browser
API itself, so it can be driven directly from Node — which is the only way
this part of the generator can be tested at all. `pipeline/messages.ts` is the message contract.

**The history runs on ONE step loop** (`runtime.ts` `startLoop`, both eras,
2026-10-11): a step and its render, then exactly one timer for the next
step. Never a `setInterval`, never a second timer: a stop clears the one
timer, a step in flight finishes as the settled picture, nothing starts
after the stop. A step that throws ends the loop with `stageFailed` and a
settled picture.

Where this is going: [docs/design/generator-pipeline.md](../../../docs/design/generator-pipeline.md).

The simulation itself is the engine's: its modules are in
`engine/crates/casas-engine/src/` under the same directories and the same
names in snake_case (`surface/erosion_engine.rs`, `tectonics/plate_simulation.rs`,
`climate/refinement.rs` …). What is left here is the generator's transport,
the read side (decode, sample, rasterise a save or an artifact) and what the
screen draws (2026-10-22: the rest of the TypeScript simulation removed).

```
pipeline/   messages (the worker contract), runtime (the stage state, the step loop, the
            handlers; it holds the world in the engine), engine (the engine as TypeScript
            sees it), engineWasm (the WASM build, loaded once per worker),
            engineConstants (the numbers the pipeline versions come from, the engine's),
            replayPlan (a world's runs as the engine's Replay takes them), stages (the
            pipeline as data)
core/       mapConfig, toroidal, rng, field (the shared samplers), minHeap, interpolation,
            domain (the topology: periodicity, distance and latitude), detMath (exp, log,
            sin, cos … the same bits in every JS engine), worldTime, inputParams
mesh/       the terrain mesh's read side: periodicDelaunay (the triangulation on a
            domain), lattice, hilbert, meshDensity (MESH_TUNING),
            meshSerial (the save's form: Hilbert numbering, varint connectivity, the
            canonical rebuild), meshSampler (point location over a hint grid — what map/
            reads the mesh through), meshRaster (node fields on a grid;
            rasteriseNodePart for the part of the nodes that holds a field),
            meshHydrology (the water fields on the raster from the mesh),
            meshNeighbourhood (a node's neighbourhood in metres); the fine levels'
            tiles: meshTile (the torus), meshTileCube and cubeAtlas (the sphere),
            tileLayout (by the world's shape), tileSampler (a tile's surface as a lookup)
fields/     fieldMesh (the field mesh: geometry, sampler, chart rasters in and out,
            SavedField), fieldOperators
planet/     the Planet stage's controls, their forcing, the sample world
mantle/     the mantle's field mesh and its saved values
archean/    the Archean's controls, its snapshot types, the coastline-warp seed
tectonics/  the controls, the plates' types and motion, the snapshot and event types
            (plateSimulationTypes), oceanAge, terrainFeatures, volcanoes, plumes
crust/      the rafts' types and fields (raftField: the owner field, the craton age)
elevation/  elevationScale (what a height MEANS), elevationField, elevationTuneParams,
            domainWarp, ridgedNoise, globeNoise, hypsometry, dynamicTopography,
            elevationColor
surface/    the shapes a save holds (hydrology: the water bodies and their levels;
            riverGraph: the feature graph; coastGraph, coastal, surfaceTypes),
            surfaceTuneParams, erosionForcingFields (the erosion controls' type)
climate/    the climate's field mesh and chart (climateMesh, climateField, climateChart),
            the climate at a point (climatePoints), the biomes and Köppen classes, the
            refinement's types, colours and tuning
ecology/    the ecology's field ids and fine codec, colours and controls (the rules and
            their tuning are the engine's: ecology_field.rs, ecology_tune_params.rs)
render/     the picture: the relief's shade, the elevation image, the continent names
```

**A new simulated field goes on a mesh, not on the 2:1 raster** (DEC-0036,
`docs/decisions/fields-on-meshes.md`). The rules below hold for the
engine's stages, where the fields are computed now, and for the read side
here. A coarse global field (mantle, ocean
age, climate, flexure) lives on the field mesh (`fields/`), a fine land field
on the adaptive terrain mesh; the chart is the address, the textures and the
save. Read a field mesh through its `FieldSampler`, never by a grid index;
write it out with `rasteriseField` (cell centres, the DomainGrid's convention).
Its vectors are east/south pairs in each cell's own frame — carry a
neighbour's into the cell's frame before adding it (the engine's `carry_from`). Phase 0 (the operators),
phase 1 (the mantle), phase 2 (the ocean age), phase 3 (the static
climate), phase 4 (the ocean and the energy balance), phase 5 (the
refinement and the phenomena), phase 6 (the flexure), phase 7 (biomes,
Köppen, ecology, resources, hydrogeology on the terrain mesh), phase 7b
(the hydrology's discharge, watersheds, coast reaches and sediment basins
on the terrain mesh; no routing on the 2:1 raster) and the save step (no
chart raster in the save: the elevation, the lakes' depth and the erosion
forcing are made by whoever reads it — world/query.ts) are built. A solve runs to a RESIDUAL (its
SolveReport), never to a sweep count: a non-symmetric operator takes
BiCGSTAB, a symmetric one CG, and a singular one (a Neumann
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
the engine's `forcingOfSnapshot` from `state.json` — the session's own
functions, so the views are the session's rasters bit for bit.

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

## Before touching anything: the checks

**The world is computed by the Rust engine** (`engine/`, DEC-0044) since
2026-10-21: the generator's runtime and the job worker call it, and a
change to what a world IS goes there. The TypeScript simulation went with
fork 7c, as far as it was not interwoven with the READ SIDE — the modules
that decode, sample and rasterise a save or an artifact (the load, the
incubator, the screen's hover), which stay TypeScript for now (fork 7b)
and must give the engine's bits. The rest of the old simulation was
removed on 2026-10-22; a change to a stage goes to the engine.

```
cd client && npm run harness:roundtrip       # the save format; 0.2 s
node engine/scripts/smoke.mjs                # native against WASM, the read side against the engine; ~3 min
cd client && npm run harness:pipeline        # the pipeline's behaviour; ~5 min
```

The calibration's instrument (`scripts/calibrate.mjs`) and golden, mesh
and fields went with the simulation; the calibration gets its instrument
again on the engine when it starts again.

**What each covers:**

- `npm run harness:pipeline` covers `pipeline/runtime.ts`: message ordering
  and cache invalidation, driven headless on a small world with the
  engine's WASM build — hand-over, resets, save→restore, the stage chain,
  invalidation, stopping a pass mid-flight. Run it after touching anything
  under `pipeline/`. What it does NOT reach is the screen — panel
  switching, button state and the DOM half of a reset are unguarded.
- `npm run harness:roundtrip` covers the save format — quantisation, the
  recipe's layout, the identity hashes, the artifact bytes and the shared
  zip reader, in 0.2 s — and checks that every constant the pipeline
  versions name moves them. Run it after touching anything under
  `world/save/` or `storage/`.
- `node engine/scripts/smoke.mjs` covers the engine's two builds against
  each other and the read side against the engine: the terrain's raster
  from the saved mesh, the lakes from the saved water bodies, the forcing
  from the snapshot.

## Parameters and identity

The tuning that makes a world is the engine's (`climate_tune_params.rs`,
`tectonics_tune_params.rs` …), and the pipeline versions hash it as the
engine gives it (`pipeline/engineConstants.ts`, `world/worldTuning.ts`,
`world/meshArtifacts.ts` MESH_BAKE_CONSTANTS). The `xyTuneParams.ts`
objects left here (climate, elevation, surface) serve
the read side and the screen; they are not hashed. Each controllable stage
declares its sliders in an `xyInputParams.ts` (min/max/step/default/unit/i18n
key), and `world/save/worldSpec.ts` turns those declarations into the
save's recipe. The reasoning is in `docs/design/architecture-unification.md`.

**A tuning file exports ONE object, and callers read it under its full name** —
`CLIMATE_TUNING.x`, never a destructured local and never an `as TUNE` import.
The full name is what keeps every use site findable by grep. Both shortcuts
were tried and removed the same day.

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
and the field meshes' values — rather than the recipe, because the recipe
cannot distinguish two worlds stopped at different tectonic epochs; and
`riverDensity` is deliberately excluded from the key even though the bake
reads it, because including it orphaned 17–67 MB of artifact per slider
position. `harness:roundtrip` checks that every constant MESH_BAKE_CONSTANTS
lists moves the version.

## Traps that have bitten before

**Math is not the same in every engine.** `Math.exp`, `log`, `sin`, `cos`,
`tan`, `atan2`, `pow`, `hypot` and `**` may differ in the last bit between
V8 (Chrome, the Node job worker) and JavaScriptCore (Safari); a world made in
Safari was made again by the server identically up to epoch 93 of 151, then
not (2026-10-02). Use `core/detMath.ts` (`detExp`, `detSin`, `sq` …) — a
port of fdlibm out of exact operations only. `make lint` refuses the others
in `generator/`, `render/` excepted; the engine's `det_math` test holds its
values against the fdlibm port's, confirmed in both JavaScript engines.

**The simulation's mechanics are the engine's.** How the erosion routes
(MFD area, single-flow incision, D8-LTD on a grid), how the history moves,
rebuilds and compacts the mesh each epoch, and the erosion engine's graph
index are described where they live: `engine/crates/casas-engine/src/surface/`
and `mesh/`, and `docs/decisions/rust-engine.md`.

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
Firefox, and the worker is created but never runs. No nested worker is
left today; the rule holds for the next one. (The Firefox failure is
dev-server only; production builds are fine.)
