---
summary: The open points of the adaptive-mesh direction (design/adaptive-mesh.md), decided one by one on 2026-09-22 — density rule, versioning, where tiles are refined, the harness, flexural isostasy, no erosion sliders, map/ samples the mesh directly, remeshing with hysteresis, water levels in the save, the feature graph as artifact then save member, a domain object for the topology, and the build order with ocean masking first.
date: 2026-09-22
area: generator
stage: decided
status: decided 2026-09-22; step 0 BUILT the same day (ocean masking — the engine computes on an active set of land, basins and a shelf band, the deep ocean frozen; the strip flood retired for one serial flood over the active set; the fluvial and sediment walks basin-parallel over the receiver forest cut at the coast; a per-basin flood dropped on measurement, see ADAPTIVE_MESH_PLAN.md); step 1 BUILT the same day (the water-body list in the save, shores as the level's iso-line at draw time); step 2 BUILT the same day (the river feature graph, ribbons derived from it, graph in the bake artifact, invariants as a harness layer); step 3 BUILT the same day (pattern from physics, meanders by the bend model, braids and deltas drawn; courses stored with the graph); forerunners F6 (flow regime per reach, wadis), F3 (dynamic topography, 400 m per unit of mantle anomaly) F5 (coast type per reach, drawn), F1 (sediment basins with provenance) F4 (ice thickness by balance-flux inversion, in the bake and at 2048) and F7 (an iteration is 20 000 years, the age slider in Myr) BUILT the same day. Twelve forks settled in one session, (1) and (8) amended the same day for the sediment record, (5) for a Te field and dynamic topography, (13) climate, (14) river course and (15) sediment added the same day, folds, cover and hydrogeology added to the build order the same day; the constants (spacings, tile budget, elastic thickness, hysteresis thresholds) are to be measured when the step is built, not decided here. Build order below; step 0 (ocean masking) is the first thing to start.
---

# The adaptive mesh, decided

## The fork

[design/adaptive-mesh.md](../design/adaptive-mesh.md) agreed a direction:
one adaptive mesh from tectonics to the near ground, a feature graph as
the erosion's product, a river-course generator below the channel head,
and tectonics coupled to erosion as the last step. It left twelve
questions open. This doc records the answer to each, plus three (13–15) that
the review of the result raised, the options that
were on the table, and why. Nothing here is built.

## What was decided

### 1. Density rule: relief + discharge + curvature + sediment column

Target spacing `h = clamp(min(h_relief, h_discharge, h_curvature,
h_column), h_min, h_max)`, with a coarse floor in the ocean. Discharge
means water AND ice flux, so a glaciated valley densifies like a trunk
river once the ice model exists ([design/glacial.md](../design/glacial.md)). ONE function,
used by the macro mesh and by every tile; the two differ only by a budget
scalar. Rejected: relief + discharge (ridges without a river stay coarse),
discharge only (mountains stay at synthesis quality). The constants of
each term are measured when step 4 is built.

The fourth term was added the same day, after the decision on remeshing
(8) showed where the first three coarsen: exactly in the basins and
worn forelands, where relief and discharge are small and the sediment
columns are thick. `h_column` keeps a node fine while its column is
non-trivial (several layers, appreciable thickness), so the record stays
resolved where it counts for the resource layer. It does nothing before
step 5, when no column exists.

### 2. Versioning: one counter, one bump

`AMPLIFICATION_ALGO_VERSION` stays the single counter. It is bumped ONCE
when the mesh lands; every change while the mesh is being built runs
under that number, and the rule's parameters go through the constants
hash like every other constant. A separate mesh counter was considered
and dropped: after step 4 every raster artifact is a rasterisation of the
mesh, so a mesh change invalidates the rasters anyway — two counters
would only pretend they were independent.

### 3. Tile refinement: on the server, as an artifact

The detail transient (insert nodes in a tile, short erosion run) is
computed once on the server, per tile, and stored in the artifact store —
the same path as today's 4K/8K bakes and the planned cluster jobs. The
client only downloads. A tile is a clipmap tile window with a fixed node
budget, deterministic from (parent state, tile id, seed). Rejected:
computing on the player's machine (seconds of wait while exploring, every
machine repeats the work) and a hybrid (two code paths that must agree
exactly).

Clarified the same day: there is no "4K/8K bake" at the end, and not one
bake either, but one model with two kinds of job. **History** is the
generator run itself — the macro mesh over all epochs — whose result is
the save; it may run as a server job for long histories but stays one
run with one result. **Detail** is the per-tile job above. The global
raster tiers go, because resolution stops being a property of the world
and becomes a property of where one looks. The tile is refined as a
**ladder** of two or three levels of rising budget, each a constrained
refinement of the one below, each its own job and artifact — the
sampling pyramid of near-ground-clipmap.md as a mesh. Because parent
nodes are immutable, level two needs only level one, never the whole
mesh; the far clipmap rings sample the macro mesh directly, with no job.
The number of levels is measured when built. Until step 4 the raster
bakes stay and receive steps 0–3 and the forerunners; step 4 replaces
them, it does not add to them.

Amended the same day, on two review points: the tile is a steady-state
transient under parents with a history, and the tile may not rebuild
the macro network. Determinism is not the obstacle — a tile is a
function of (parent state, tile id, seed) either way — independence is:
a tile that captures a river running through its neighbour invalidates
a neighbour computed from the old network. So the ladder's levels are
not all alike:

- **Lower levels run globally.** Level 1 (ten times the macro budget,
  order 10⁷ nodes) is feasible as one world run: one server job,
  upstream-ordered, and on this level the network MAY rebuild. Being a
  world run it gets time: it resumes the history loop at a checkpoint
  epoch, tectonics included, at the higher density, to the end. Detail
  down to the kilometre is history, not transient. The feature graph
  freezes after the last global level, not after the macro, and the
  course generator (14) runs there, globally.
- **The top level runs per tile.** Full density (10⁸–10⁹ nodes for the
  world, tens of gigabytes) exists only per tile, and there the parents
  stay immutable. What a tile could rebuild at a hundred metres is
  gully heads and hollows, nothing the graph knows; the price "network
  frozen" moves from kilometres to a hundred metres, where it stops
  being one. The tile transient's duration is a parameter from the
  parent's age — at that scale hillslopes equilibrate in millennia,
  which is the state reality shows.

Where the line between global and per-tile levels lies is a budget
question, not a physical one: as many levels global as one world run
completes in acceptable time. Three kinds of job follow: the macro
**history** in the generator screen (interactive, the save); the
**global bake**, one server job per global level; the **tile bakes**,
many, ahead or on approach. Its picture differs from the macro preview
in detail because the network may rebuild at the finer level: the same
world, finer, bounded to the epochs after the checkpoint.

**The snapshot is the save's root; everything after it is an artifact.**
The global bake needs the complete state at epoch N — nodes with
position, height, layers, plate membership; mantle field, rafts,
climate, ice. Two ways were weighed. Replay (recompute the history from
spec and seed at the higher density) keeps the save small and was
rejected: it presumes client and server compute bit-identically, and
`Math.exp` and its relatives are not guaranteed identical across
JavaScript engines or even V8 versions, while the erosion is chaotic
enough that one bit in epoch 3 is another river network in epoch 30 —
measured on the split bake. So the generator run writes a **snapshot at
epoch N into the save** (the save already has a snapshot notion in
`state.json`; this is the same, mesh instead of raster; the run rewrites
it at each epoch inside the window of the last N, and the save carries
the last one). The snapshot is data, not a computation path, so the
global bake depends only on itself.

The snapshot does NOT go into the artifact store: the store is defined
as derived and evictable — recomputable from the save at a cost — and
the snapshot is the root that is not recomputable. By the world-layer
test it is save. What the store holds is everything derived from it:
the global bake is deterministic from the snapshot on the server alone,
so the world state at level 1 is a legitimate artifact, evictable and
recomputable, and the tiles hang on it. The save becomes smaller, not
larger: spec, snapshot at N, the macro end state only as a preview; the
authoritative end state is the global bake. Two consequences for the
identities: `worldId` (the content hash) hashes the snapshot, since
everything derived keys on it; and the rule "never bake from the live
rasters, always through the save" holds unchanged — the global bake
reads the serialised snapshot, never the generator's memory.

### 4. Harness: rasterised metrics plus graph invariants

The golden harness keeps its layers. The mesh stage adds: rasterisation
to 2048 so the existing metrics with tolerance still apply; graph
invariants as a new layer (acyclic, discharge monotone downstream, every
mouth in sea or lake, shores closed); and the hash guard over the
rasterised field plus the serialised graph. Rejected: invariants only
(heights unchecked), bytes only (breaks on every change without saying
what).

### 5. Isostasy: flexural

The coupled model compensates erosion with an elastic plate: the load is
distributed over a flexural wavelength, so foreland basins next to a
range emerge from the model rather than from a feature rule. Cost
accepted: an elastic thickness `Te` as parameter, crustal thickness as
node state, and a solver on the mesh — no FFT on a TIN, so either an
iterative solve on the macro mesh or a convolution with the flexural
kernel (radius from `Te`). Rejected: Airy per node (over-compensates
narrow loads, no basins), and "none first, measure later" (calibrates
twice).

Amended the same day, on the review of what a uniform `Te` misses.
`Te` is a FIELD, derived from two quantities the generator already has:
craton oldness (`crust/raftField`, today driving erodibility) and
lithosphere age in the ocean (the GDH1 age). Cratons are stiff, young
orogens and rifts weak, ocean floor by age between. The same craton
oldness sets the initial crustal thickness of a node (old cores have deep
roots). A variable `Te` rules out the kernel convolution, which assumes
one `Te`: the solver is the iterative one on the macro mesh with local
flexural rigidity; a convolution with the kernel radius taken from `Te`
at the load point is the fallback if the solve proves too costly.

**Dynamic topography** is the second addition: the mantle field
(`mantle/mantleField.ts`, an anomaly on a 128×64 raster evolved per
epoch, today driving only the plates) becomes an additive height term
per node — upwelling lifts, downwelling sags, over thousands of
kilometres, sampled from the mantle raster with one measured amplitude.
Two rules: it is not crustal material, so it never enters the land
budget or the crust sink, only the height; and it is instantaneous, not
history — when the upwelling moves on, the plateau subsides. Erosion
sees it because it is height, which is what cuts plateaus and fills
sagging basins. Because it is instantaneous it works as a forerunner on
today's raster (step 4c below): a term in the elevation synthesis that
evaluates the mantle field at the end.

### 6. Sliders: no erosion sliders

Erosion runs inside every tectonic epoch, so it inherits the tectonics'
start and stop; there is no erosion start of its own any more. Epoch
length is a tectonics parameter. Landscape age is not a slider: a range
worn down is one that had quiet epochs after its orogeny, and running
more epochs is how a world gets older. `alluvium` and `rockContrast` are
material properties and move to the crust panel. `landscapeAge`,
strength and refresh go. Rejected: an uplift/kappa slider (a physical
ratio the history already sets).

### 7. map/ samples the mesh directly

No raster between the mesh and the map. `map/` gets point location
(point-in-triangle over a spatial bucket), hillshade from triangle
normals, biomes classified per sample, and the ring-0 hex lattice
samples the mesh like every other ring. Every raster path in `map/` is
replaced; the `map → generator` edge stays within its rule, because
sampling is a pure field function. Rejected: rasterising per tile (a
second substrate in disguise) and keeping the 2048 raster as the map's
authority (the sibling world the direction exists to avoid).

### 8. Remeshing: hysteresis, full inheritance, deterministic order

Between epochs a node is inserted where the local spacing exceeds 1.5×
target and removed where it falls under 0.5×. A new node interpolates its
whole state from its neighbours: height, sediment thickness, age,
provenance. Determinism: insertion in Hilbert order, the triangulation
single-threaded, only the solver parallel (the solver's strip count is
already part of the result). Rejected: insert-only (worn ranges stay
dense forever) and full re-triangulation per epoch (resamples the
history, the raster's problem again).

Amended the same day, on the loss the two operations actually cause.
Insertion is near lossless: every layer is indexed by epoch, so a new
node interpolates thickness LAYER BY LAYER between neighbours whose
columns align — structure kept, resolution that of the parents. Removal
is the loss, and it is bounded two ways: (a) a node is removed only when
its column is trivial — the fourth density term in (1) keeps every other
node fine regardless of relief; (b) a removed node's column is merged
into its neighbours, layer by layer and weighted by Voronoi area, so mass
and age are conserved and only spatial resolution drops. Insert-only was
reconsidered and stays rejected: subduction removes nodes anyway, but a
mesh that never thins where a range is worn down grows two- to threefold
over a history for no information gain.

### 9. Water levels: computed in the generator, carried by the save

Hydrology produces a small list per basin — basin id, water level,
outlet — and the save carries it (a format bump). The `lakeDepth` layer
stays, derived, for consumers that still read it. The bake re-floods and
emits the same list for its resolution. Shores are iso-lines of the level
on the finest terrain present, drawn at draw time, never stored as
lines. Rejected: bake only (the generator view keeps the staircase) and
deriving the level at load from the u8 depth layer (its quantisation
would sit in the level).

### 10. Feature graph: artifact first, save member later

While the graph is derived from the raster (steps 2–3) it is
deterministic from the save and lives in the artifact store, keyed like
a bake. Once the save IS the mesh (step 4) the graph is output of the
same erosion run as the field and joins the save. Rejected: in the save
from the start (a save bump per graph change) and artifact forever
(re-derivation at every load after step 4).

### 11. Topology: a domain object

The mesh takes a domain — point set, periodicity, neighbour search,
distance — behind one interface. The torus is implemented; a sphere is a
second domain with no lat-lon problem, per
[design/two-topologies.md](../design/two-topologies.md). Hex-on-sphere
remains that doc's open question and does not block the mesh. Rejected:
hard-coding periodicity (cheaper now, expensive later) and deciding the
sphere first (delays everything here).

### 12. Order: ocean masking first

Ocean masking and basin decomposition in the raster bake come before the
lake iso-lines: bake time drops at once (the ocean is most of the cells),
and both are independent of the mesh.

### 13. Climate: planetary forcing first, surface response per epoch

Added the same day, after the review of what the coupled model still
lacks: a static climate, computed once on the final terrain, cannot let a
rising range cast its rain shadow over the epochs that erode it. Climate
splits in two:

- **Planetary forcing** — obliquity, eccentricity and precession, solar
  constant and greenhouse (mean temperature), rotation period (cells,
  Coriolis), water fraction. Depends on the planet, not on the relief,
  and is evaluable anywhere. It becomes a stage **Planet** before the
  genesis, where size and water already live, with a schedule over the
  epochs (cycles in obliquity and eccentricity, greenhouse with
  volcanism). The domain object of (11) is born there: on a sphere
  latitude is real, on the torus a declared mapping, and the forcing
  acts on `latitude(p)` either way.
- **Surface response** — rain shadow, continentality, currents from the
  land-sea layout, monsoon. Depends on the relief and is recomputed
  **per epoch** as part of step 5, on a coarse raster (order 256×128)
  rasterised from the macro mesh, with today's climate code. A rain
  shadow is a hundred-kilometre feature; the erosion history runs at
  macro budget; nothing here needs the TIN or full resolution.
- The **final climate** at full resolution on the final terrain stays
  the last stage, for the biomes, as today.

What it buys beyond the rain shadow: a climate history. Ice volume and
sea level per epoch fall out of the same forcing and are the
precondition of the glacial and coastal processes noted in
[design/adaptive-mesh.md](../design/adaptive-mesh.md); and every
sediment layer records the climate at deposition, so provenance becomes
concrete (coal from swamps, evaporites from arid closed basins,
carbonates from warm shelves). Rejected: keeping climate static (no
history, the two processes above have nothing to hang on) and running
the full-resolution climate per epoch (cost without gain at macro
budget). The new sliders need catalog keys, proposed when the stage is
built.

### 14. River course: physics picks the pattern, a curve model makes the meanders

Added the same day, on the review's point that everything below the
channel head was procedural. The course generator of step 3 is three
tiers:

- **Pattern type from physics, free.** Straight, meandering, braided or
  anastomosing follows from slope, discharge, sediment load and bank
  strength (the Parker criterion; vegetation from the biome as bank
  strength). All four are reach attributes. The generator decides
  nothing; it draws what the reach says.
- **Meanders as a simulation, not a template.** The reach's centreline
  as a curve, migrated by the bend model of Ikeda, Parker and Sawai:
  lateral migration proportional to curvature weighted over a distance
  upstream; a cutoff when two loops touch, the cut loop an oxbow.
  One-dimensional, thousands of points per reach, deterministic from
  reach and seed over a fixed step count. Emergent: meander belts whose
  width scales with discharge, oxbows, cutoffs, the migration envelope
  as floodplain with levees and scroll bars as deposits; bedrock
  reaches migrate slowly, so incised meanders exist.
- **Braids and delta channels stay drawn, with a physical core.** The
  channel count and width come from load and slope; the pattern is a
  rule. Delta lobe switching becomes a graph process (avulsion when
  aggradation gives another path a height advantage), so lobes with an
  age emerge and only the channels within them are drawn.

Rejected: two-dimensional braiding physics (a cellular Murray–Paola
model). It needs a 10–50 m grid over the braidplain and thousands of
steps — minutes per reach against milliseconds for a meander — for a
chaotic snapshot that is statistically the drawn pattern anyway, and a
braided river is rebuilt at every flood, so one snapshot is as right as
another. Too much for something with little effect on the picture. If
ever wanted, its one bounded place is the tile job after step 4.

What stays out until step 5: terraces from an incision history, and a
migration duration per reach that is a constant rather than an age.

### 15. Sediment: ξ–q stays, becomes layers, may dam

Added the same day, after a review point that turned out overstated:
the v2 engine already routes sediment (Davy & Lague ξ–q, settling
length `L = max(floor, ξ·√Q)` on land, a short constant under water,
freeboard for deltas) and is mass-conserving; land deposition exists.
What is missing is narrower, and step 5 takes it in four pieces:

- **Deposits become layers.** Today a deposit only raises `z`. In the
  coupled model it is a layer with thickness, age, provenance and grain
  class, and a node's erodibility is that of its top layer — a filled
  valley is soft, an exhumed bedrock floor hard, with no new physics.
- **The anti-dam cap goes.** "No deposit may dam the valley that feeds
  it" (the donor floor) is a raster necessity: a dammed valley would be
  a lake the router cannot see. Fans, valley fills and landslide-dammed
  lakes are made by exactly that backing-up. On the mesh with water
  levels per basin (9) damming is legitimate: the dam makes a basin,
  the basin routes over its outlet, the sediment fills it until it
  silts up. Lakes become transient forms with an age. The 2026-07-27
  failure (unbounded land aggradation damming everything) does not
  return, because the dam is now a modelled basin, not a hole in the
  router.
- **Two grain classes.** Fans are coarse and steep, floodplains fine and
  flat; the coast and the dunes need sand apart from mud, the resources
  too. Coarse settles short, fine far; provenance carries the class.
  The smallest addition with the longest reach.
- **Rates in years.** `kappaDt` folds `dt·K` and the age axis is
  iterations; coupling needs rates per epoch in years, or the ratio of
  uplift to erosion is arbitrary. Already in the calibration list.

Rejected: a capacity-based transport-limited model. ξ–q covers both
limits through the settling length, which is why it was chosen.

## Build order

| # | Step | Produces | Presupposes |
|---|---|---|---|
| 0 | Ocean masking + basin decomposition in the raster bake | kernels run over land only; bake per basin | — |
| 1 | Lakes and coasts as water level + iso-line | per-basin level list in the save (format bump); shores as iso-lines in generator view and bake | — |
| 2 | Feature graph as the erosion's output | rivers as reaches with attributes, divides, shores; artifact; hex ports and ribbons read it | 1 |
| 3 | River-course generator on the graph | pattern type from physics; meanders by 1-D centreline migration with cutoffs (oxbows, floodplain envelope); braids drawn from physical numbers; delta lobe avulsion on the graph; deterministic per reach; synthesis takes the curves as constraints | 2 |
| 4 | Erosion on the TIN | domain object, density rule, engine ported; save becomes the mesh, graph joins the save, `map/` samples the mesh, tiles baked on the server; the one version bump | 0, 2 |
| 4a | Sediment basins as features | provenance for the resource layer without coupling; cheap, any time | — |
| 4b | Planet stage | planetary forcing sliders with a schedule over the epochs; the domain object born here; any time before 5 | — |
| 4c | Dynamic topography | mantle anomaly as a height term in today's elevation synthesis; one amplitude, measured; any time | — |
| 5 | Coupling tectonics and erosion | height per epoch on nodes, Lagrangian drift, remeshing, flexural isostasy, sediment as layers with two grain classes and no anti-dam cap, sediment budget into the crust sink, flexure with a `Te` field, dynamic topography per epoch, climate per epoch on a coarse raster with ice volume and sea level as by-products, mass wasting and solifluction in the hillslope kernel, a fold term in the uplift at convergent margins, a cover factor per epoch from the coarse climate acting on erodibility, critical slope and bank strength (with a land-plants moment on the Planet-stage schedule); erosion sliders removed | 4, 4a, 4b, 4c |
| 5a | Hydrogeology as a classification | springs at layer contacts as graph features, flow regime per reach, water table per node by a Dupuit estimate; no process; the regime forerunner from climate alone any time | 5 |
| 6 | Glacial, then coast | own decisions after 5; sketches in design/glacial.md and design/coast.md; the forerunners (ice thickness without erosion in the bake, coast type per reach without physics) any time | 5 |

Each step pays on its own. Tile refinement (the engine's detail role)
belongs to step 4 and becomes visible with the near-field step "hex mesh
replaces the patch" in
[near-ground-clipmap.md](./near-ground-clipmap.md).

## Measured when built, not decided here

- The spacing constants of the three density terms, `h_min`, `h_max`,
  the ocean floor.
- The node budget per tile, the number of levels in the tile ladder,
  and how many of them run globally; the window N of epochs the global
  bake re-runs.
- The `Te` field's range, the dynamic-topography amplitude, the default
  epoch length, the coarse climate raster's size, the fold wavelength
  and amplitude, the cover factor's three coefficients.
- Whether 1.5× / 0.5× hysteresis holds up over many epochs.

## Related

- [design/adaptive-mesh.md](../design/adaptive-mesh.md) — the reasoning
  and the conversation this decides.
- [design/amplification-artifacts.md](../design/amplification-artifacts.md)
  — the cost ordering that puts ocean masking first.
- [near-ground-clipmap.md](./near-ground-clipmap.md) — the rings and tiles
  step 4 feeds.
- [design/two-topologies.md](../design/two-topologies.md) — the sphere as
  a second domain.
