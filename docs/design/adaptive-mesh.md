---
summary: One adaptive mesh for the terrain, from tectonics to the near ground — an irregular node network whose density follows relief and discharge, carrying history in the macro and detail in the tiles; a feature graph (rivers, divides, shores) as the erosion's real product; a river-course generator below the channel head; and tectonics coupled to erosion as the final step. The direction agreed in conversation on 2026-09-22; the details and the decision are for a later session.
date: 2026-09-22
area: generator
stage: idea
status: direction agreed 2026-09-22 ("so machen wir's, noch nicht jetzt"); no decision doc yet, nothing built. Grew out of the adaptive-mesh note in amplification-artifacts.md. A follow-up session is to settle the open questions at the end and turn this into a decisions/ doc.
---

# One adaptive mesh, history and detail

This doc records a design conversation. The starting question was the
adaptive-mesh note in
[amplification-artifacts.md](./amplification-artifacts.md): if the
adaptive mesh does not pay in time or memory (the oceans are already
handled), what else does it give? The conversation ended somewhere
larger than the note: a shape for the whole terrain pipeline. The
shape is agreed; nothing below it is decided in detail.

## Findings, in the order they came

**The oceans are pinned, not masked.** `coastMask` and `statusMask`
fix the coastline. Every kernel still iterates every cell, and the
engine's state arrays are allocated for the full raster. The fluvial
walk skips z ≤ 0 cheaply; flood, MFD, hillslope and marine do not.
The "ocean masking" lever in amplification-artifacts.md is still open.

**What a TIN gives beyond cost.**

- The output becomes vector. A river is a chain of edges, a lake a set
  of cells, a coast a constraint edge of the triangulation. Today rivers
  are re-extracted from the raster by D8 after the fact (a staircase,
  then smoothed) and draped. On a TIN the river node sits where the
  process put it, with attributes (discharge, width) on the node, at any
  zoom.
- Resolution becomes a budget per node instead of a global number.
  Density follows curvature and discharge.
- It does not invent detail. Below the node spacing, relief still comes
  from synthesis (`fineValue`, ridge noise). "Bake rivers into the mesh"
  is true; "finer mountains" is true only where nodes are placed.
- Hillslope diffusion wants uniform density; density jumps act like
  numerical diffusion and blunt valleys. Remeshing between rounds
  interpolates, a small loss each time.

**The algorithms are graph algorithms; the raster is the special case.**
Stream power, the Braun–Willett implicit solver, the receiver stack and
priority flood run on any directed graph. The first landscape-evolution
models (Cascade, Braun & Sambridge 1997; CHILD, Tucker et al.) ran on
TINs; FastScape and Landlab run on both. So "adaptive meshes are the
basis of these algorithms" is historically true, not a requirement. Our
engine is raster-specialised: D8 offsets, MFD with a fixed stride of 8,
hillslope over the east/south neighbours only, the strip flood with
`ENGINE_STRIPS` as part of the result. On a graph these become edge
length and Voronoi area (finite volume), and the strip flood becomes a
plain priority flood per basin.

**What a TIN changes for D8 and MFD.**

- The direction bias goes. A grid has eight directions; rivers run
  parallel and kink at 45°. The engine pays for this today with the LTD
  scan (`kernelLtdScan`, the Orlandini correction). On a random TIN with
  about six neighbours in random directions, steepest descent is
  unbiased on average; LTD is not needed.
- MFD becomes physical: weight = slope × Voronoi facet length, instead
  of Freeman weights over eight fixed directions.
- Not solved by the mesh: the hybrid (MFD for area, single receiver for
  incision) is a model choice. Every constant counted in cells
  (`baseAreaKm2`, `settleFloorKm`, `deltaMinDrainageCells`) becomes a
  per-node area.
- The drawn rivers gain more than the erosion does: the erosion already
  has LTD, the rendering uses plain D8 and shows the staircase.

**The arithmetic of "128K".** World = 2048 × 7.8 km ≈ 16 000 × 8 000 km.

| Level | Cell | Cells | Land (~35 %) |
|---|---|---|---|
| 16K (measured: 42 min, 8.5 GB) | 975 m | 134 M | ~47 M |
| 128K | 122 m | 8.6 G | ~3 G |
| 300 m hex (hex-tiling.md, fork 2) | 300 m | | ~580 M hexes |

A TIN with 128K-equivalent density along channels down to the channel
head (drainage density ~1 km/km², ~50 M km of channel) is 10⁸–10⁹
nodes: one to two orders below the raster, not three. It fits no tab
and no single bake. The vector approach changes the memory, not the
need to tile and stream. The world never exists whole at that level;
only the tiles ever visited do.

**Where erosion physics ends.** Stream power still holds at 122 m for
channels; the network down to the channel head is fully resolved,
hillslopes barely. What erosion adds below ~100–300 m is hillslope form
(convex ridges, concave valley heads), which diffusion gives cheaply.
What it never gives, at any resolution, is the fine river course:
meanders, braiding and floodplains are lateral processes (bank
migration) that no model of this class computes. A finer mesh does not
make the river pretty. The fine course is its own generator, running on
the river line (Peytavie et al. 2019, "Procedural Riverscapes").

**Lakes: a representation problem, not a resolution problem.** Lakes
are a per-cell depth raster, nearest-sampled at texel resolution
(`map/mapPresentation.ts`). The square staircase seen in the detail
view is the outline of a cell set; it stays at every resolution, only
smaller. Voronoi cells do not fix it: a lake as a union of Voronoi cells
is a polygon of cell borders too, random instead of square — crumpled
instead of stepped. What fixes it: **the lake as a water level, not a
cell set.** Store per basin (seed cell, surface elevation); the shore is
the iso-line of that elevation on whatever the finest terrain is, inside
the basin. It follows every refinement and every synthesis below it
without anyone recomputing it. Coasts the same: the iso-line of sea
level. This works today, without a TIN, and is the largest single visible
gain.

**Two layers, not polylines alone.**

1. **Field** (raster or TIN): the substrate for erosion, accumulation,
   sediment. Authority for the large form. Coarse.
2. **Feature graph**: a planar graph of curves with attributes. Rivers
   (centreline, width, discharge), divides (watershed boundaries, the
   dual of the river network, extractable from the field), shores and
   coasts (iso-lines). Authority for where every line is, at fine scale.

The fine terrain is synthesised from both: river-bed profile along the
curve, ridge profile, noise between (Génevaux et al. 2013,
hydrology-based terrain primitives). This is the "hydrology-aware
synthesis" of worldmap-amplification.md with the graph as a first-class
product instead of a by-product.

Against polylines alone: erosion cannot run on curves (area, sediment,
hillslopes need a field); topology (confluences, a river meeting a
shore, a divide meeting a coast) is free on a mesh and real work on a
curve set (a planar graph structure, robust intersection); curves
derived from the field must be re-derived when the field changes, so
they are derived once, after the last erosion step, then frozen and
authoritative; and the renderer wants heights per vertex in the end, so
layer 1 must exist fine too, as synthesis.

Practicability per feature: shores and coasts high (iso-lines, known,
immediate); river position high (ribbons exist; missing: width, profile,
cutting into the terrain); fine river course medium (its own generator,
deterministic per reach); divides medium (extracting watersheds is easy;
serration and cols are synthesis). Tiling by catchment fits: a tile is a
subtree of the river graph, its borders are divides, themselves edges of
the graph.

**Deltas.** The course generator shapes them, the erosion decides them.
Whether and how large a delta grows stays with the erosion (sediment
budget, freeboard, the lobe in `sedimentWalk`). What the generator adds
is the form the erosion model structurally cannot: **downstream
bifurcation.** The receiver tree has one outlet per cell; a delta is a
tree in the opposite direction (distributaries, levees, oxbows). On the
raster the delta is a fan of cells; in the graph it is a subgraph that
splits at the delta apex, with channels whose banks are iso-lines of the
water level. Same pattern as meanders: place and budget from physics,
shape from the generator.

**Tectonics does not need the mesh to start there.** The pre-erosion
stages are already resolution-independent; the raster is only a
sampling: plates are seeds, motion and boundary classification on the
plate lattice; rafts are metaballs; uplift, erodibility and ocean age
are derived fields evaluable at any point; elevation is ridged noise
plus domain warp on the uplift field (`elevation/elevationField.ts`),
evaluable at any point — which is why `fineValue` works in the bake at
all. Mountains are synthesised from fields there, not shaped. That is
already the form a TIN needs: place nodes, evaluate the fields there.
The tectonics also carries an **ageing in the vector already**: ranges
and volcanoes are features with an epoch, they drift with their plate,
merge, get pruned, hotspot chains subside with age, sutures crossfade on
their age, cratons are hard (`elevation/erodibilityField.ts`). A proxy
for "erosion over the epochs": not mass removed, but amplitude and
erodibility set by age.

The one erosion step in the generator (`erosionPassV2` on 2048) is the
same engine the bake calls on 4k/8k. One stage, two callers. A TIN
engine replaces both at once.

**Coupling tectonics and erosion (thought experiment, then adopted as
the last step).** Elevation becomes state per epoch, advected with the
plate; uplift comes incrementally; erosion runs per epoch on the
accumulated state; sediment lands in basins that are later uplifted and
eroded again. This is the model of goSPL / Badlands + GPlates (Salles et
al.), which run on unstructured meshes for the reason below.

Realism gained, in order of value:

1. **Drainage history.** Today the river network is a pure consequence
   of the final terrain. Coupled, there are antecedent rivers (the river
   was there before the mountain and cuts across it: Indus,
   Brahmaputra), captures, reversals (the Amazon when the Andes rose),
   rift flanks splitting a network. A qualitatively new class; the final
   state does not contain the information.
2. **Stratigraphy.** Material removed in epoch n lies in epoch n+3 as
   sedimentary rock in an uplifted foreland. Sedimentary mountains,
   coal, salt, limestone become places with a history, not random
   fields. For the resource layer this is the real gain.
3. **Worn vs. sharp per orogen** instead of per world. Today landscape
   age is a global slider plus suture age. Coupled, it follows the
   history: three epochs active, five dormant = Appalachians. The slider
   becomes the physical ratio uplift rate / kappa.
4. Shelves and passive margins from sediment, migrating delta lobes.

What it costs, and why it is a new model, not a new mesh:

- **Isostasy.** Erosion without compensation flattens mountains over
  epochs because nothing lifts them back. Real erosion removes and the
  root rises (Airy / flexural). Without isostasy the coupling gives wrong
  heights; with it, it is a second model (crustal thickness as state).
  The rafts know area, not thickness. The largest piece.
- **Land conservation.** The crust sink keeps land conserved (2026-07-28,
  measured). Erosion pushing mass into the sea during the epochs reaches
  exactly there; the sediment budget must return to the crust model.
- **Advection on a raster blurs.** Drift per epoch resamples the terrain;
  valleys at 2048 are 1–3 cells wide, every resampling eats them. On a
  TIN the nodes move with the plate (Lagrangian) without resampling; at
  convergent boundaries nodes are consumed, at rifts created. **Coupling
  practically needs the TIN; the TIN does not need coupling.** The drift
  advection is the argument for the mesh that the cost analysis did not
  have.
- **Runtime and workflow.** Erosion times the epoch count instead of
  once. The stage separation in the generator goes: the erosion
  parameters then shape the tectonic history; "tectonics done, adjust
  erosion" no longer exists.
- **Calibration from scratch.** Supercontinent timing, the water slider,
  compaction are all measured on today's interplay.

A cheap forerunner that works today: extend the feature-ageing proxy so
sediment basins exist as features with provenance (a foreland basin next
to a range, age, volume from the range amplitude). That gives
stratigraphy for the resources without coupling. Drainage history exists
only with the full model.

**The erosion engine stays, in two roles.** Not lost, split:

1. **History** (the generator's erosion, today one run after tectonics).
   Dissolves as a stage: it becomes erosion per epoch, and "erosion after
   tectonics" is simply the last epoch. The terrain at the end of the
   tectonics IS eroded; there is no un-eroded state any more. The
   sliders that drive this stage (age, strength, refresh) go; what
   remains are physical rates acting through the whole history.
2. **Detail** (the bake's erosion, today 4k/8k, later per tile). Stays,
   as the step that refines the mesh locally. The coupled history runs at
   macro density because it runs N epochs. It delivers the network with
   history: trunk rivers, basins, divides, sediment. Refinement inserts
   nodes inside a tile, the parent nodes at the border stay fixed, and a
   short transient on the new nodes produces the fine network below
   (tributaries, valley heads, hillslope form). Same engine, another
   caller, a short run.

The difference is no longer "simulation vs. presentation" but **history
vs. detail**: 1 decides what is where and why; 2 fills what lies between
the parent nodes without moving anything 1 decided. That is also why 2
can be deterministic from (parent state, tile id, seed): it may not
invent anything the neighbouring tile would see differently.

**The macro mesh is already adaptive, with a smaller budget.** One mesh,
one density rule, two budgets. The macro mesh is dense where relief and
discharge are, thin on cratons and plains, nearly empty in the ocean —
roughly 4k-equivalent in orogens and along trunk rivers, kilometre
spacing on plains, ten kilometres in the ocean. The tile continues the
same rule in its window with ten to a hundred times the budget. And the
macro mesh is in motion: because density follows discharge and the mesh
exists during the epochs, it is rebuilt between epochs (nodes appear
where an orogen rises, a river's course densifies as it establishes,
nodes may leave where a mountain is worn down), plus the Lagrangian
motion with the plate. The nodes carry the history (age, sediment,
provenance) — impossible on a raster, whose cells are fixed in place.
The tile only inserts: existing nodes keep position and height, edges
stay (a trunk river is a parent edge and runs through unchanged), new
nodes fill the gaps with a synthesis height as start value, and the
short transient orders them. A constrained Delaunay refinement, not a
new triangulation. Two rules follow: the density rule is ONE function
(relief, discharge, curvature → target spacing) in macro and tile alike,
or the seam shows; and what a parent node says is final — children
inherit, children do not contradict. The generator's visual check then
shows the macro mesh, rasterised: coarse, but the same world that later
becomes fine, not a sibling world from another substrate.

## The shape agreed

1. One adaptive mesh (periodic Delaunay on the torus) from tectonics to
   the near ground. Density = one rule of relief, discharge, curvature.
2. Tectonics evaluates its fields on the nodes; no change to its model.
3. Erosion runs on the mesh in two roles: history (per epoch, macro
   budget, coupled to drift) and detail (per tile, on inserted nodes,
   parents immutable).
4. The erosion's product is a feature graph: rivers with attributes,
   divides, shores and coasts as iso-lines of a water level. Frozen after
   the last step, authoritative for line positions.
5. Below the channel head: a river-course generator on the graph
   (meanders, deltas with bifurcation, floodplains), then synthesis with
   the graph's curves as constraints.
6. Lakes and coasts are water levels; their shores are iso-lines on the
   finest terrain present.

## Build order, each step paying on its own

1. Lakes and coasts as water level + iso-line. Today, no rewrite, the
   most visible gain.
2. Feature graph as the erosion's output (rivers with attributes,
   divides, shores), frozen after the last step.
3. Course generator on the graph (meanders, deltas, floodplains),
   deterministic per reach.
4. Erosion on the TIN, replacing the raster substrate under 2 and 3.
   Brings bias and cost, not picture.
5. Coupling tectonics and erosion. Presupposes 2 and 4. The third large
   site.

Independent of all five and still worth doing first for the raster
bake: ocean masking and basin decomposition, as amplification-artifacts.md
already orders them.

## Open for the decision session

- The density rule itself (which quantities, which spacing at which
  value), and how a change to it is versioned (it is part of every
  artifact's identity).
- Tile size and node budget per tile; whether detail refinement runs
  online (on approach, seconds) or as a server bake per tile.
- The isostasy model for the coupling (Airy per node? flexural?) and
  how the crust sink and land conservation take the sediment budget.
- Which sliders survive: age, strength and refresh go; what replaces
  them (uplift/kappa ratio, epoch length).
- Harness strategy: the golden harness compares raster bytes; a mesh
  needs either rasterisation to compare, or graph-level invariants.
- Determinism of remeshing (periodic Delaunay must be seed-stable;
  insertion order is part of the result).
- Remeshing between epochs: criteria for adding and removing nodes,
  and how much a node carries across (height, sediment, age).
- Relation to [two-topologies.md](./two-topologies.md): a TIN is
  topology-agnostic, which removes the lat-lon problem for a sphere
  and leaves only the point set and the periodicity to swap.
- What happens to `map/`'s raster consumers (hillshade, biomes, the
  clipmap rings): rasterise per tile from the mesh, or sample the mesh
  directly.

## References

- Braun & Sambridge 1997, "Modelling landscape evolution on geological
  time scales: a new method based on irregular spatial discretization"
  (Cascade).
- Tucker et al. 2001, CHILD.
- Braun & Willett 2013, the O(n) implicit stream-power solver (already
  the engine's core).
- Salles et al. 2020, goSPL — global landscape evolution on an
  unstructured mesh coupled to plate reconstructions.
- Génevaux et al. 2013, "Terrain generation using procedural models
  based on hydrology".
- Peytavie et al. 2019, "Procedural Riverscapes".
