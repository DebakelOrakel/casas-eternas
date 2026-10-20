---
id: DEC-0044
title.en: A Rust engine
title.de: Eine Rust-Engine
summary.en: The generator gets a second engine, written in Rust, for speed
  only. Two measured spikes on a level-1 history give 2.3–2.8× on one
  core and about 6× more where the work is parallel, with the same bits as
  the TypeScript code. The new engine keeps the behaviour, not the bytes:
  it is a new pipeline version. Level 0 runs in the browser as WASM,
  levels 1–3 run natively in the worker; both builds give the same bits.
summary.de: Der Generator bekommt eine zweite Engine in Rust, nur wegen der
  Geschwindigkeit. Zwei gemessene Spikes an einer Level-1-Historie geben
  2.3–2.8× auf einem Kern und etwa 6× mehr, wo die Arbeit parallel ist,
  mit denselben Bits wie der TypeScript-Code. Die neue Engine behält das
  Verhalten, nicht die Bytes: Sie ist eine neue Pipeline-Version. Level 0
  läuft im Browser als WASM, Level 1–3 nativ im Worker; beide Builds
  geben dieselben Bits.
area: generator
stage: building
createdAt: 2026-10-19
updatedAt: 2026-10-20
related: [DES-0001, DES-0006, DEC-0039, DEC-0032, DEC-0043]
---

## Where this starts

The engine is frozen since 2026-10-15: no model or calibration change, only
performance changes that keep the bytes. A level-1 history on a real world
takes about one minute per epoch, and the worker uses little more than one
core. The question was whether a port to a compiled language gives enough
speed to be worth a second engine. Speed is the only reason; if the gain is
small, there is no port.

Earlier documents touch the question:

- [DES-0001](../design/world-gen.md) keeps "duplicate vs. WASM" as an open
  thread. It thinks of Go compiled to WASM, for client/server agreement, not
  for speed. This document closes that thread in another direction.
- [DES-0006](../design/server-storage.md), "Speculation: who computes, and
  where the code comes from", recommends a Node worker built from the repo,
  and names AssemblyScript as the path if WASM is ever needed. Its reasons
  were the trust boundary and version drift, not speed. Its "cheap
  insurance" (the pipeline modules stay free of DOM and browser APIs) is
  what makes this port possible.
- [DEC-0039](./artifacts-by-content.md), fork 1, keys an artifact by
  `(worldId, pipelineVersion, stage)` because the engine is byte-identical
  across JS engines (`generator/core/detMath.ts`). The Rust engine keeps
  that property inside itself and gets its own `pipelineVersion`.

## Vocabulary

Agreed 2026-10-20, because the three words had more than one meaning each:

- **Generator** — the product: what a player uses to make a world, with
  its screen. It uses an engine; it computes nothing itself.
- **Engine** — the implementation that computes. There are two: the
  TypeScript engine (today `client/src/generator/`) and the Rust engine.
  The freeze of 2026-10-15 applies to the TypeScript engine.
- **Pipeline** — the order of the levels and stages inside an engine
  (L0 → L1 → L2/L3). The directory `generator/pipeline/` keeps its name.
- **Pipeline version** — the identity of the results: the engine plus its
  constants. One pipeline version belongs to one engine. The Rust engine
  gets its own prefix (for example `r1-` in place of `v11-`). The artifact
  key, the UI label and `world.yaml` do not change.
- **Solver** — a part of an engine that solves one problem: the erosion
  solver, the flow solver. In the TypeScript engine the erosion solver is
  still called `ErosionEngine`; it is not renamed, because that engine
  goes.

New text says "JS runtime" for V8 or JavaScriptCore, not "JS engine".

## The measurements

All on the world `b39d5739` (sphere), level 1, budget 1, on an Apple M4
with 10 cores. The spike code is not in the repository.

### The level-1 profile, 20 epochs

Mean wall time 63 s per epoch, 1.04–1.40 cores used. Seconds per epoch:

| Stage | Mean | Epoch 20 (4.24 M nodes) |
|---|---:|---:|
| forcing | 22.4 | 36.6 |
| erosion | 8.9 | 12.6 |
| baseline | 7.3 | 10.4 |
| lakes | 7.2 | 9.3 |
| ice | 5.8 | 9.0 |
| remesh (every 3rd epoch) | 3.9 | 14.2 (epoch 18) |
| rebuild | 2.5 | 3.7 |
| membership | 1.5 | 2.0 |
| climate, flexure, coast, tectonics | 3.6 | 5.0 |
| **wall** | **63.0** | **88.7** |

The node count grows from 1.03 M to 4.24 M. Forcing grows faster than the
node count. The CPU profile puts the cause in `columnMeanHeight`
(`pipeline/coupledEpoch.ts`): a breadth-first search for every node to
`wedgeRadiusM` (10 km). At epoch 12 the neighbourhoods hold 202 M members,
about 55 per node, and the count per node increases with the density.

### Spike 1 — `columnMeanHeight`

The neighbourhood search and the mean, from dumped inputs:

| Variant | Epoch 3 | Epoch 12 |
|---|---:|---:|
| TypeScript, as written | 9.6 s | 30.0 s |
| TypeScript, fused (no neighbour list) | 9.0 s | 27.2 s |
| Rust, 1 core | 3.2 s | 10.2 s |
| Rust, 10 cores | 0.54 s | 1.8 s |

All results are bit-equal to the TypeScript output. The fused TypeScript
variant separates the gain of the language from the gain of the algorithm:
the algorithm gives about 10 %, the language about 2.7×.

### Spike 2 — the globe Delaunay

The remesh is mostly field evaluation (density target, raft baseline);
the Delaunay core is a small part of it. The spike ports only the core:
insert, locate and legalise on the sphere. The dump captured the rebuild
of one epoch, 3.78 M inserts into a base of 92 k vertices.

| Variant | Time |
|---|---:|
| TypeScript | 2340 ms |
| Rust, 1 core | 1030 ms |

The triangles and twins are identical, and so are the counts: 11 224 461
walk steps, 12 687 289 flips. The insert order makes this work serial.
`sin` and `cos` from the `libm` crate differ from `detMath` by 1 ulp in
1.3 % of the vector components; the triangulation is still the same, but
the fix is a port of `detMath`, not `libm`.

### The projection

Not measured end to end: 2.3–2.8× on one core everywhere, plus the
parallel stages on 10 cores, gives an estimated 4–6× per level-1 epoch.

## Fork 1 — Port or not

- **Keep TypeScript** and make it faster inside the freeze.
- **Port the hot stages** and call them from TypeScript.
- **A new engine in Rust.**

**Answer: a new engine.** The fused TypeScript variant shows that the
algorithm alone gives little; the language and the cores give the rest. A
port of only the hot stages crosses the boundary between the two languages
on each stage of each epoch and copies the mesh each time, and it leaves
the worker on one core everywhere else.

## Fork 2 — The same bytes as TypeScript, or the same behaviour

- **Byte-identical to the TypeScript engine**, under the freeze.
- **The same behaviour**, its own bytes.

**Answer: the same behaviour.** It is a new engine, so the freeze does not
apply to it. Byte identity with TypeScript would forbid every change of
order that makes the work parallel, and the parallel stages are where the
largest gain is. The engine gets a new `pipelineVersion`; old worlds keep
the version they were made with. The test is behaviour: the existing world
zips are the input, and the outputs are compared by their statistics and
by eye, not by hash. Where a stage happens to give the same bits (both
spikes did), that is a useful check, not a requirement.

The order is: first the engine, then the generator uses it.

## Fork 3 — Where each level runs

- **WASM everywhere**, in the browser and in the worker.
- **Native everywhere**; the browser asks the server for level 0.
- **Level 0 as WASM in the browser, levels 1–3 native in the worker.**

**Answer: the last.** The browser must create a world without a server, so
level 0 needs WASM. Levels 1–3 always run in a worker, so they can use the
native build with all cores and SIMD, without the limits of a browser.

## Fork 4 — Bits between WASM and native

**Answer: the WASM build and the native build give the same bits.** The
client does not check level 1. But level 1 replays the history that level 0
made, and the parts of it that do not depend on the budget (the plates, the
Archean) must arrive at the same state. Whether the terrain feeds back into
the plates is not yet checked; until it is, the rule holds for the whole
engine. The rules:

- **One maths library**, a port of `detMath` (fdlibm). No `std` or `libm`
  transcendental function in the engine.
- **No fast-math** and no fused multiply-add the compiler chooses itself.
  Fast-math lets the compiler reorder and contract operations, so each
  build and each target gives other bits.
- **Parallel reductions in fixed blocks**, combined in a fixed order,
  independent of the number of threads.
- **No iteration over a `HashMap`** where the order reaches the output.
- **`u32`/`u64`, not `usize`**, in everything that reaches the output; WASM
  is 32-bit.
- **No relaxed SIMD.**
- **One canonical NaN** where a NaN can reach the output.

## Fork 5 — How the engine arrives

- **Stage by stage**: each Rust stage replaces its TypeScript stage in the
  generator as soon as it is ready.
- **All at once, tested only at the end**: one full run, compared by its
  statistics.
- **All at once, tested module by module**: each module is compared with
  its TypeScript module while it is written; the generator changes only
  when the engine is complete.

**Answer: the last.** The simulation is chaotic: one different bit in an
early epoch gives other plates after twenty (measured with the split
bakes). A full run alone shows that the world is different, but not why
or where. The module tests find an error where it starts. Stage-by-stage
replacement would give speed earlier, but would mix the two engines in
one world and make the generator depend on both for a long time.

**The module tests.** Real inputs are dumped from the world `b39d5739`, as
in the spikes, and both engines compute them:

- where the work is serial or independent per node, the result must be
  bit-equal to TypeScript;
- where a reduction changes its order, a tolerance applies.

**A faithful mode.** The engine keeps a mode without reordered reductions.
If a full run in this mode gives the hash of the TypeScript run, the
comparison is exact. The fast mode is then compared by statistics only.

**The full comparison.** A full run of `b39d5739` against pipeline v11, by
values fixed before the run: land share, hypsometry, plate count, river
lengths, lakes, ice, biome shares, and time. The natural spread comes from
v11 with 3–5 seeds; the Rust engine behaves the same when it is inside
that spread.

**The phases:**

1. The frame: `engine/` as a Cargo workspace, a native build for the Node
   worker (napi) and a WASM build; the toolchain in make, CI and Docker.
2. The `detMath` port, with its hash test against the TypeScript values.
3. The mesh: Delaunay, neighbours, neighbourhoods, remesh.
4. The modules from the bottom up: core, fields, tectonics and Archean,
   surface, climate, pipeline. Each one with its module test, then made
   parallel, then measured.
5. Levels 1–3 native, level 0 as WASM, with a check that both builds give
   the same bits.
6. The full run and the comparison.
7. The generator and the worker change to the new engine; the TypeScript
   engine goes.

## Not decided — versioned pipelines

With its own engine, a pipeline can be a release of its own. The direction
from the discussion of 2026-10-19:

- A worker image per pipeline, tagged with the `pipelineVersion` (the hash
  of the engine). The native build and the WASM build come from the same
  source and report the same hash.
- The jobs module scales one worker Deployment per pipeline, found by a
  label (today one, DEC-0043, fork 3), and the task subject carries the
  pipeline (`jobs.task.<pool>.<pipeline>.*`). A worker then sees only the
  tasks it can compute. Today a worker with another pipeline takes a level
  task, refuses the replay, and the whole job fails.
- Old worlds stay refinable while the image of their pipeline is kept; this
  needs a rule for how long.
- An external worker cannot use an image. It loads the native build for
  its platform and pipeline from the server, by hash, or runs the WASM
  module in a runtime (slower).
- The browser needs only the WASM of the current pipeline.

This changes the subjects and the scaler, so it is its own fork when it
comes.

## Status

DECIDED 2026-10-19: the port is worth it. The spikes are outside the
repository.

BUILDING since 2026-10-20:

- Phase 1, the frame (`engine/`, `make engine`): the native build loads in
  Node. The WASM build waits for a toolchain with the wasm32 target
  (rustup reads `engine/rust-toolchain.toml`).
- Phase 2, `det_math`: bit-equal to `core/detMath.ts` in 1 101 special
  cases and in 23 sample sets of 100 000 arguments each, and it gives the
  hash `harness:mesh` holds (`dadf96b6`). `engine/clippy.toml` refuses the
  std functions it replaces; `make lint` refuses a stale fixture.
- Phase 3, the mesh, begun: `periodic_delaunay` with the part of `domain`
  it reads, on the torus and the sphere. A scenario of each (inserts,
  removals, duplicates, edge midpoints, a clone, queries, the Voronoi
  areas) gives the TypeScript state, bit for bit, after every step. On the
  dumped rebuild of `b39d5739`'s epoch 12, 3.78 M inserts give the same
  triangles, twins and unit vectors, in 1.2 s against 2.3 s. The
  tolerances of the predicates are not reached by the scenarios' random
  points; a change of them goes unseen by the test.
- Phase 3, the mesh building: `hilbert`, `lattice` (hex, geodesic,
  centroidal), `mesh_density`, `mesh_state`, `mesh_relief`, `remesh`,
  `mesh_build`, with `rng` (mulberry32) and the domain's advance, displace
  and transport. Bit-equal to TypeScript in a build of ~42 k nodes on each
  shape, its rebuild from moved points, and a remesh with an intensive, an
  extensive and a stacked field.
- Phase 3 complete with `mesh_neighbourhood`, and of phase 4 the erosion's
  graph index (`mesh_erosion`: the frozen ocean, the shelf band, the
  cotangent facets) with `min_heap`. Bit-equal in the same scenarios. On the
  dumped epoch 12 of `b39d5739`, the column mean height (202 M members over
  3.7 M slots) gives the TypeScript values for every slot, in 10.1 s on one
  core against 30.0 s, and in 2.0 s on 10 cores.
- Parallel stages run on rayon behind the cargo feature `parallel`, which
  the native build turns on and the WASM build leaves off. The work is cut
  into fixed blocks and put together in their order, so both give the same
  bits; `make test` and `make lint` run the engine in both.
- Phase 4 begun with `fields`: the field mesh (geometry, sampler, rasters)
  and every operator (diffusion, gradient, divergence, semi-Lagrangian
  transport, CG, BiCGSTAB, ILU(0), the two-level preconditioner).
  Bit-equal on both shapes at 150 km, the solvers' iterations and residuals
  included.
- The whole domain (`core/domain.ts`: both shapes, their grids and
  samplers, `core/field.ts`, `core/toroidal.ts`) and with it the field
  mesh's raster readers. Bit-equal over random points and every grid method
  on four domains, odd and even grids among them.
- The mantle (`mantle/`) and the raft field it reads (`crust/raftField`:
  the metaball field, its blob index, the craton age, the owner field),
  with `core/interpolation` and `core/worldTime`. Bit-equal over ten
  epochs of the field, its flow and its samples on both shapes.
- The tectonics, first part: the tuning, `plate_motion` (generation, the
  velocity, a point moved and back, the fit to the mantle flow, the
  relaxation), the velocity decomposition, the detection lattice, the
  boundary detection and classification, the terrain features and the
  volcanoes. Bit-equal on both shapes.
- The tectonics, second part: the ocean age (the exact departure, the
  ridges' new crust, the resets), the flexure (the plate equation by CG,
  the load spreader) and the plumes. The ocean age, the flexure and the
  climate share one field mesh, as in TypeScript; the caller holds it
  (`SharedFieldMesh`). Bit-equal on both shapes.
- The elevation (`elevation/`: the scale and the margin profile, the
  capsule, the ridged and the fine noise, the globe's noise, the warp, the
  hypsometry, the elevation field with its feature buckets, the baseline
  and the uplift deck), with the trench and the folds. The noises' lattice
  hashes sum in doubles before the cut to 32 bits, as JavaScript does; an
  exact integer hash gives other bits, and the test sees it. Bit-equal on
  both shapes.
- The tectonic epoch, whole: the plate simulation and its six phases
  (`tectonics/epoch/`: the mantle's coupling, the drift, the boundary pass
  with the carriers' margins, the raft events, the plate churn, the
  pruning), with the raft lifecycle and the names (`crust/`). The field
  meshes a world's stages share are one `WorldMeshes` the caller holds
  and hands from phase to phase, as the TypeScript caches are one per
  domain. From one synthetic snapshot, 120 epochs on each shape give the
  TypeScript state after every epoch, every event type but the
  supercontinent's among them: 15 s against 52 s, on one core. The
  fixture takes a minute to make, so `make test` checks it, not
  `make lint`.
- The Archean (`archean/`: the world from its seed string, the nucleation
  and the land share lever, the step, the snapshot, the hand-over to the
  plates), with the dynamic topography's point query. From the seed
  string, 200 Archean epochs (saved and restored at the 100th), the
  hand-over and 20 tectonic epochs give the TypeScript state after every
  step on both shapes: 7 s against 24 s. With this, a world is made from
  its seed to the tectonics in Rust; what is left of level 0 is the
  coupled history (surface, climate, the pipeline).
- The erosion solver (`surface/erosionEngine*`: the routing, the
  walks, the kernels, the single scheme and the pool's pipelined one with
  its synchronous variant) and the run on the mesh (`runMeshErosion`).
  Bit-equal on a 256 × 128 raster of each shape (the full forcing, the
  status rule with pinned heights, an early stop) and on a mesh of each
  shape (the single scheme, extra frozen nodes, both pool schemes run by
  TypeScript on worker threads). The per-node kernels and the leaf
  segments of the walks run in parallel blocks. On a 2048 × 1024 torus
  (483 k active cells), 8 iterations take 0.66 s on one core and 0.37 s
  on 10, against 1.34 s for the single TypeScript solver. The flood
  stays serial: its pop order is the result. The run's two tallies are
  summed over the TypeScript pool's worker ranges (`leaf_workers`),
  because TypeScript's sums are grouped by them: the exported volume, in
  the snapshot as `sedimentExportM3`, depends on how many workers the
  TypeScript pool has.
- The erosion forcing: U (`elevation/upliftField`), the crust's K factors
  (`elevation/erodibilityField`), the grid half of the assembly per node
  and per raster cell with the controls' parameters
  (`surface/erosionForcingFields`), and the coarse fields from the plate
  simulation (`pipeline/erosionForcing.coarseForcingFields`; the raster
  solver's assembly with the climate as water is not ported, only the
  measuring scripts run it). Bit-equal on both shapes after 30 epochs of
  the synthetic simulation, with flood basalts added; the epoch and the
  forcing tests build that simulation from one module on each side.
- The static climate, first part (`climate/`: the tuning, the chart's
  latitude and calendar, the climate's mesh with its bands, the distance
  to the sea, the graph's parts and the seas along the parallels, the
  terrain it reads; the temperature, the wind, the seasonality, the rain
  with the refinement's inputs, the monsoon, the ocean with the Stommel
  solve, the upwelling and the overturning's inflow; `computeWeather`),
  with `planet/planetForcing`. The climate's mesh is the world's
  `SharedFieldMesh`, as in TypeScript. Bit-equal on an analytic terrain
  with dry floors on both shapes, at the default controls and at moved
  ones and a moved planet: `computeWeather` takes 127 ms on the torus and
  90 ms on the sphere on one core, against 350 and 261 ms.
- The static climate, second part: the climate at points
  (`climate/climatePoints`: the cells, their saved values, the climate at
  any point set with the island rule and the monsoon's sign), the
  Köppen–Geiger classes and the biomes (`koppen`, `biomes`; their colours
  and label keys are presentation and stay in TypeScript). Bit-equal on
  6 000 random points per shape, land on sea cells among them, with the
  static cells and with cells that carry months, upwelling and the rain's
  variability, the biomes with and without a rain override, and 20 000
  random years for the classes. `climateCellsFromRefined` comes with the
  refinement.
- The climate's refinement (`climate/refinement` with `pressure`,
  `energyBalance`, `phenomena`, `reliability`, `storms`, `salinity`), and
  `climateCellsFromRefined`: with it the climate is ported whole but for
  its chart and its colours. Bit-equal on an analytic 2048 × 1024 terrain
  on both shapes, at the default levers and at moved ones with a moved
  planet, every field, every solve's report, and the climate at points
  and the biomes it gives: `refineClimate` takes 1.9 s on the torus and
  1.6 s on the sphere on one core, against 4.3 and 3.7 s. Rust works out
  the raster's owners per terrain again where TypeScript keeps them per
  mesh; the months are independent of each other and not yet run in
  parallel.
- The surface stages, first part: the sediment column's layers
  (`mesh/meshColumn`: open, deposit, cut, the bytes), the cover, the
  surface's tuning, the ice on the mesh with its glacial cut and till
  (`surface/glacial`) and the coast (`surface/coastal`: the shore, the
  waves' exposure, the cut, the drift along the shore with its rings).
  Bit-equal on a built mesh of each shape with a synthetic climate that
  holds ice at the poles and a drift that deposits and exports.
- The surface stages, second part: the hydrology over the flow
  substrate (`surface/hydrology`: the discharge with the terminal basins'
  water balance, the lakes, terminal seas and dry basins, the regime's
  inputs with and without months, the channel criterion, the watersheds,
  the riparian moisture; the water bodies on a raster), the mesh as the
  substrate with its routing and its water on a raster
  (`mesh/meshHydrology`), the node fields on rasters (`mesh/meshRaster`)
  and the mesh's codec and canonical form (`mesh/meshSerial`). Bit-equal
  on a built mesh of each shape, lakes, terminal and dry basins among the
  bodies.

Open: the
crates and the boundary to TypeScript, the Rust toolchain in make, CI and
Docker, and the check whether the terrain feeds back into the plates. `columnMeanHeight` grows with the density by its algorithm;
changing that is a behaviour change and not part of the port.
