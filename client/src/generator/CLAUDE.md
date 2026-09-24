# generator — the flat-torus generator

The world **wraps in both X and Y**. Every distance, sample and neighbour lookup
must go through the toroidal helpers in `core/`; a plain `dx = a - b` is a bug
near the seam. See `docs/decisions/world-topology-torus.md`.

`generatorWorker.ts` is the entry point and stays at this root, but it is **only
transport** — twenty-odd lines wiring `self` to the pipeline. The pipeline is
`pipeline/runtime.ts`: it holds every stage's live state as module-level `let`s
and orchestrates everything below. It takes its emitter and its elevation
renderer from the host (`setEmitter`, `setElevationRenderer`) and touches no
browser API itself, so it can be driven directly from Node — which is the only
way this part of the generator can be tested at all, since the golden harness
does not reach it. `pipeline/messages.ts` is the message contract.

Where this is going: [docs/design/generator-pipeline.md](../../../docs/design/generator-pipeline.md).

```
pipeline/   messages (the worker contract), runtime (stage state + handlers)
core/       mapConfig, toroidal, rng, field (the shared samplers), minHeap, interpolation,
            domain (the topology: periodicity, distance and latitude on the torus)
mesh/       the adaptive mesh (ADAPTIVE_MESH_PLAN.md phase 4): periodicDelaunay (the
            triangulation on a domain), lattice (the bootstrap), hilbert (the insertion
            order), meshDensity (the ONE density rule, MESH_TUNING), meshState (per-node
            fields that survive remeshing), meshRelief, remesh (hysteresis insert/remove),
            meshBuild (fields in, mesh out), meshErosion (the erosion engine's graph index
            from the triangulation, the run adapter), meshRaster (node fields sampled on a
            grid), meshSerial (the save's form: Hilbert numbering, varint connectivity,
            the canonical rebuild), meshSampler (point location over a hint grid,
            heights, fields and normals at a point — what map/ reads the mesh through),
            meshRefine (one rung of the ladder: a parent refined to a finer budget,
            parents kept, new nodes from the parent surface plus synthesis),
            meshColumn (phase 5.2: the sediment column per node as epoch-indexed
            layers with provenance — a stacked MeshState field, cut from the top,
            the save's mesh/column.bin).
            pipeline/coupledEpoch.ts is phase 5's loop over it: z = baseline + relief
            per node, nodes drift with their plates, the mesh is rebuilt and remeshed
            each epoch (subduction and rifting), erosion runs inside the epoch.
            `node scripts/calibrateHistory.mjs key=value …` prints what a setting does
            to a world over N epochs — the calibration's instrument, not a gate.
            The generator's erosion stage runs on it
            (pipeline/meshErosionStage.ts), the lakes and the river graph run on it
            (meshHydrology: the flow substrate) and the save carries it; the map and the
            raster consumers still read its 2048 rasterisation until 4.4
planet/     the Planet stage's controls and their forcing (obliquity, orbit, sun, rotation) —
            what depends on the planet and not on the relief; the climate reads it
mantle/     the buoyancy field BOTH eras run on — the substrate, so it depends only
            on core/ and crust/ and never on tectonics/
archean/    the Archean era; hands over to tectonics via finalizeArchean.ts, which
            is the ONLY archean file that may import from tectonics/
tectonics/  plate*, boundary*, oceanAge, terrainFeatures, volcanoes,
            tectonicsTuneParams (tuning constants), epoch/ (the per-epoch phases),
            flexure (phase 5.3: Te as a field, the plate's deflection to a load
            change on a coarse raster, read back at the mesh's nodes), folds (phase
            5.7: the buckling train across a range as a modulation of the uplift)
crust/      continental crust as rafts — deliberately decoupled from the plates
            (docs/decisions/continental-crust-rafts.md); crustTuneParams holds the
            raft rules both eras pass in
elevation/  elevationScale (what a height MEANS), elevationField, domainWarp, ridgedNoise
surface/    flowRouting, erosionEngine* (the engine, its state, pool, worker), erosionPassV2,
            hydrology, riverGraph (the feature graph), riverCourse, coastGraph, sedimentBasins,
            iceFlow, cover (phase 5.5: the vegetation's hold per biome — one table for the
            erodibility, the critical slope and the river banks), hydrogeology (phase 5a:
            springs, the regime with baseflow, the water table — a classification over the
            column, no process), glacial (phase 6: the epoch's ice on the mesh at its
            steady state, the cut it does, the till it leaves), coastal (phase 7: the
            waves' cut at the shore and the one-line drift along it), amplify,
            runAmplification
climate/ ecology/ migration/ render/
```

## Resolutions — check before you sample

Fields do **not** share one grid. This is the single most common source of wrong
answers here.

| Grid | Size | Holds |
|---|---|---|
| World / macro raster | 2048×1024, 7800 m per cell | elevation, discharge, lakeDepth, biome |
| Climate | 256×128 (~62 km per cell) | temperature, precipitation, seasonality, monsoon, all ecology |
| Ocean age | 256×128 | oceanAge |
| Mantle | 128×64 | mantle buoyancy and flow |

In the baked save (`world/save/worldLayers.ts`) only the layers marked `fullRes`
are on the world raster — today `biome`, `lakeDepth`, `discharge` and `elevation`.
Everything else is written at climate resolution.

Note what a coarse save layer means for a field that is computed finely: the
reduction is a *choice*, and `downsampleMax` is the wrong one for anything
sampled per point. `lakeDepth` used to take it, which let a single lake cell
claim its whole 62 km cell and inflated saved lake area 4× (2026-08-09).

**The 2048 macro raster is the sole authority and the only persisted form.** The
4k/8k amplification bake is derived presentation: it may refine the macro shapes,
never contradict them, is never serialized into a save, and is never fed back
into the generator (`docs/decisions/worldmap-amplification.md`, rule 4). "Finest
available" is therefore never the right rule for picking a source.

Ocean is marked by a different sentinel per aspect — `OCEAN_PRECIP`,
`OCEAN_AMPLITUDE`, `ECOLOGY_OCEAN` (which is `-1`, so "no negatives" is the wrong
invariant for ecology fields) — plus plain `elevation > 0` in other places. Do
not assume; look up which one the field you touched uses.

## Before touching anything: the harnesses

```
cd client && npm run harness:roundtrip       # the save format; 0.2 s
cd client && npm run harness:mesh            # the adaptive mesh; ~5 s
cd client && npm run harness:pipeline        # the pipeline's behaviour; ~50 s
cd client && npm run harness:amplify         # the amplification bake; ~13 s
cd client && npm run harness:golden          # the generator; ~20 min (4 world builds at 2048×1024, 4 coupled epochs each)
cd client && npm run harness:golden:record   # re-record the metric baseline, on purpose
cd client && npm run harness:golden:hash     # arm the refactor guard (layer 4)
```

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
- It does **not** cover the amplification bake's terrain — that is
  `npm run harness:amplify`'s job since 2026-08-09. It bakes a small world
  through the real `runAmplification` and checks invariants, determinism (which
  the artifact cache depends on absolutely: two machines baking one world must
  agree byte for byte) and, opt-in, a byte baseline. The artifact KEY is guarded
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
`TECTONICS_TUNING.splitGap`, never a destructured local and never an
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
was learned expensively: `deriveWorldId` hashes the output *rasters* (and, since
phase 5.8, the mesh snapshot's own bytes when the save carries one) rather than
the recipe, because the recipe cannot distinguish two worlds stopped at different
tectonic epochs; and `riverDensity` is deliberately excluded from the key even
though the bake reads it, because including it orphaned 17–67 MB of artifact per
slider position.

Tuning constants *are* hashed, via `derivePipelineVersion`, but only one module
feeds it today.

## Traps that have bitten before

**Routing differs by step, and conflating them is a recurring mistake.** Erosion
is hybrid: drainage-area *accumulation* is MFD, stream-power *incision* is
single-flow. Rivers in `hydrology.ts` are pure single-flow for both — MFD
smeared the drawn channels into valley-floor bands. The single-flow receiver
itself is D8-LTD, not plain steepest descent, since 2026-08-15
(`flowRouting.computeLtdFlowTargets` — plain D8's rounding error accumulates
into axis-parallel streaks, and worse the finer the grid).

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
relief and runs the engine for the epoch's length (`sim.epochMa`, the
tectonics panel's `epochLength`; `HISTORY_DEFAULTS` holds the iterations,
budget and uplift scale). The runtime rasterises z and sediment flux to 2048
after every epoch for the hydrology, the climate and the map; `elevation.f32`
in a save is therefore DERIVED; `mesh/` is the terrain, and a restored mesh
must step to the same bytes as the session's — which is why positions are
float32 on insert and the mesh is renumbered through the codec after every
epoch (`mesh/meshSerial.compactMesh`). Do not hand the engine a mesh that has
not been compacted and expect a reload to match. The erosion panel keeps its
readout and the bakes; its former sliders are the tectonics panel's
(`tectonics/tectonicsInputParams.ts`).

**The hydrology runs over a flow substrate** (phase 4.3, 2026-09-23).
`surface/flowSubstrate.ts` is the one interface the discharge, the lakes, the
channel criterion, the regime and the river graph read; the raster routing and
the mesh are its instances. Write a new hydrology rule against the substrate
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
sediment budget closes; `harness:amplify` and golden run it on the raster.
