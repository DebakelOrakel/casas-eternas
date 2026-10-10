---
id: DEC-0035
title.en: Two shapes, one generator — the seams
title.de: Zwei Gestalten, ein Generator — die Nähte
summary.en: How the torus and the sphere share one generator and one screen without a
  tangle. Three seams: the generator reaches the shape only through Domain
  (with a lint gate), both shapes keep their data in one 2:1 chart (the
  sphere's in longitude and latitude, as an address, while its mesh is
  computed on the globe), and the screen draws through a WorldView with a
  flat and a globe implementation. The shape is the save's kind, FlatWorld
  or SphereWorld, and part of the world's id; the steps are a plan per
  shape. Order: extract WorldView, thread Domain with the torus
  byte-identical, then the sphere.
summary.de: Wie Torus und Kugel einen Generator und einen Screen teilen, ohne sich zu
  verheddern. Drei Nähte: Der Generator erreicht die Gestalt nur über
  Domain (mit Lint-Sperre), beide Gestalten halten ihre Daten in einer
  2:1-Karte (die Kugel in Länge und Breite, als Adresse, während ihr Netz
  auf der Kugel gerechnet wird), und der Screen zeichnet über eine
  WorldView mit einer flachen und einer Kugel-Umsetzung. Die Gestalt ist
  das kind des Saves, FlatWorld oder SphereWorld, und Teil der Welt-ID;
  die Schritte ein Plan je Gestalt. Reihenfolge: WorldView
  herauslösen, Domain durchziehen mit bitgleichem Torus, dann die Kugel.
area: generator
stage: decided
createdAt: 2026-10-09
updatedAt: 2026-10-10
related: [DES-0017, DEC-0029, DEC-0015, DEC-0024, DES-0025]
---

## Where this starts

The sphere's first step exists (2026-10-09, `client/src/map/sphereView.ts`):
an ocean globe in a scene of its own, picked from the world list. Before
anything of the generator runs on it, the question is how the two shapes
share code without the three side-by-side attempts removed on 2026-09-20
coming back as branches inside one tree.

[two-topologies.md](../design/two-topologies.md) (DES-0017) analysed the
generator when it was rasters throughout. Since then the history runs on
the adaptive mesh ([adaptive-mesh.md](./adaptive-mesh.md), DEC-0029),
whose decision 11 already put the world's topology behind one interface,
`Domain` (`generator/core/domain.ts`). That changes the substrate question
and is the starting point here.

Two sides need a seam: the ENGINE (what computes) and the DISPLAY (what
draws), with a contract between them.

## Fork 1 — The engine reaches the shape only through Domain

**Options.** (a) A `Domain` interface every stage takes, with a torus and
a sphere implementation. (b) A shape flag the stages branch on. (c) Two
engines.

**Answer: (a).** `Domain` answers everything topological: the distance of
two points, the local difference, latitude, a cell's area and its scale
per row, the raster's neighbour rule (on the sphere: across the pole),
moving a point by a motion (on the sphere a true Euler-pole rotation), and
the coordinate noise is sampled at (2D periodic on the torus, a 3D unit
vector on the sphere).

For the mesh a 2D `delta` is not enough on a sphere. The Domain gives a
triangle's corners in a LOCAL TANGENT PLANE; the triangulation stays the
same code, as it already unwraps every triangle in the frame of one of its
corners.

**The rule, with a gate.** Outside `core/domain.ts` nothing imports
`core/toroidal`. A lint check enforces it, as one enforces `detMath`
(2026-10-02). On 2026-10-09, 23 files in `generator/` still do (ten of
them in tectonics); the index arithmetic that wraps rows and columns
without the module (`% width`) is the second half of that work, and the
harder one to find.

**Why.** (b) spreads the shape into every stage and is the tangle this
doc exists to avoid. (c) is the removed attempts again. (a) exists already
for the mesh; it is finished, not invented.

## Fork 2 — One chart, 2:1, for both shapes

**Options.** (a) Both shapes keep their data in one 2:1 chart: x, y on the
torus, longitude and latitude (equirectangular) on the sphere. (b) A
storage form per shape (a cube map, an icosahedral index for the sphere).

**Answer: (a)** — as an ADDRESS, not as geometry.

- The sphere's mesh is computed on the globe: distances, areas, triangles,
  the density rule (in metres) and the erosion go through unit vectors and
  the tangent plane. A triangle at the pole is as large as one at the
  equator where the density rule asks the same. The mesh never sees the
  chart's distortion.
- Its nodes are stored at (longitude, latitude) in the chart, so the save,
  the artifacts and the tools keep their form.
- Only what lies in the chart AS A RASTER is distorted — textures and the
  raster stages left (mantle, climate): their rows narrow toward the pole
  (cell width ∝ cos φ). The Domain's per-row area and scale carry that;
  the display oversamples the poles. Cube textures can replace that later
  without touching the mesh.

**The shape is the save's `kind`.** `world.yaml` already says `kind:
FlatWorld` (`world/worldRecord.ts`); a sphere is `kind: SphereWorld`. One
place says the shape, and nothing beside it:

- `kind` is READ and checked on load: `FlatWorld` is the torus,
  `SphereWorld` the sphere, anything else is refused as an unknown world.
  The old `kind: World` of the first saves is not accepted any more.
- `kind` goes into `deriveWorldId`, for both shapes. That changes the id
  of every flat world saved before it, and with it the keys of their
  artifacts; accepted — the old worlds and their artifacts are made again,
  not migrated. Not into `derivePipelineVersion`: that hashes the code's
  constants and knows no world, and the world id already keeps a torus's
  and a sphere's artifacts apart (changed when built, 2026-10-10).
- `manifest.json`'s `world.topology: 'torus'` goes: it said the same thing
  a second time, and two places for one fact can disagree.

One tree, one generator, one parameter — and the parameter is the kind
the save already had. (Decided first as a spec field `topology`, changed
the same day: the kind was there and said it already.)

**Why.** The chart keeps everything that is not geometry unchanged. A
storage form per shape would double the save format, the artifact layout
and every harness, for a distortion the mesh does not have.

## Fork 3 — The screen draws through a WorldView

**Options.** (a) An interface in `map/`, `WorldView`, with a flat and a
globe implementation; the screen talks to it alone. (b) The screen keeps
talking to the flat view and switches to the globe where it must.

**Answer: (a).** A `WorldView` takes layers as textures in chart
coordinates (the globe wraps them round itself), optionally the mesh with
heights for relief, and answers which chart point lies under the pointer;
it holds its own camera, with a reset, and is disposed as one. The
implementations: the flat one around today's `ToroidalMapView`, and the
globe, `sphereView`.

The legend, the hover readout, the overlays and the scale speak chart
coordinates, so they work on both shapes.

**The steps are a plan per shape** (`screens/generator/steps.ts`): the
same list for both today, the sphere's own once it differs.

**Why.** Today the generator screen talks to the flat view in hundreds of
places; (b) would add a second set of such places for every feature. The
sphere's first step already had to hide the flat view's legend, scale
bar, layer list and readout by hand — the symptom (a) removes.

## Fork 4 — The order of work

1. This decision; DES-0017 brought to the mesh's state.
2. Extract `WorldView` from the screen, with the flat implementation only
   and no change in behaviour. The largest refactor; worth it without the
   sphere too.
3. Thread the 23 direct torus imports, and the wrap arithmetic beside
   them, through `Domain`, and add the lint gate.
   The guard: the golden harness stays BYTE-IDENTICAL for the torus.
4. Then `sphereDomain`, and the generator onto the sphere stage by stage,
   each behind its harness check.

Steps 2 and 3 change existing code without changing what it does; each
is agreed before it starts.

## Fork 5 — The rasters at the poles

**Options.** (a) Pole handling in the raster: the sphere's `DomainGrid`
gives the metric (cell area and scale ∝ cos φ) and the neighbours across
the pole (longitude + 180°), and each raster stage averages or filters
its pole rows and sub-steps where it needs to. (b) Move the mantle and the
climate off the raster onto a coarse, uniform mesh
([fields-on-a-mesh.md](../design/fields-on-a-mesh.md), DES-0025). (c) Keep
the poles under ice and sea, where a coarse treatment does not show.

**Answer: (a), for now.** Land at the poles must be possible, which rules
out (c). (b) is the more correct shape in principle and is kept for a
later pass; (a) is smaller and probably enough.

**Why.** The vector layer and the mesh are computed on the globe and have
no pole problem; only the rasters do, and for them (a) is the climate
models' usual remedy.

## What this does not decide

- Hex tiles on a sphere (Goldberg polyhedron or patches) —
  [hex-tiling.md](./hex-tiling.md) is torus-snapped throughout, and
  DES-0017 asks the question; it waits for the game's answer.
- Whether the flat map gets a camera reset like the globe's.

## Status

2026-10-10: step 4d5 BUILT — the coupled epoch runs on the sphere: the
plates, the nodes' motion, the rebuild and remesh, the erosion engine, the
column, the climate of the epoch, the ice, the coast and the flexure, and
the history loop through the runtime (the tectonics step's epochs); step 2
stays locked. THE RASTERS BY FORK 5 (a): a raster stage now measures in
lengths. New on `DomainGrid`: `tapsAt` (a semi-Lagrangian departure from a
cell's centre by an offset in equator cells — on the sphere along the great
circle, so an east-west step near a pole is its length and a step across a
pole lands on the far side; with `sampleTaps`, found once per cell),
`cellDisplaced` (the cell such a step reaches), `interpolate` (the bilinear
form the forcing and the flexure readers were written in, across the pole on
the sphere) and a mask on `averagePoleRows`. Per stage: the temperature's
plateau blur (`pressure.blur`) takes as many of a row's cells east-west as
span its radius, and its pole rows are one value; the ocean currents solve
Stommel's equation in the grid's finite-volume metric (east-west 1 / cos φ,
the row edges, the cell areas; the island rule with the same face weights;
the curl of the wind on the globe), the rows from 45° on relaxed as LINES
(each run of sea a tridiagonal system against its coasts, a row all sea as
a ring), as the mantle's flow solve does — point Gauss-Seidel left a pole
row near its start; the SST and the rain advect from departures on the
globe, the sea of a pole row averaged each iteration; the air carries the
sea's anomaly inland along the globe; the continentality is a distance in
length (a label-correcting BFS); the monsoon's gradient is taken over one
equator cell east-west, the polar filter (a pole row's neighbours are a km
apart, and a coast the coarse raster resolves by chance read 80× as
steep); the orographic rain reads its points through `displace` and
`advance`. The latitude needs no change: the torus's linear row mapping IS
the sphere's |φ| / 90° at the row centre (`harness:pipeline` checks it row
by row). No stage needed sub-steps: the climate's schemes are
semi-Lagrangian or implicit, and the engine's explicit kernels run on the
mesh, which has no pole. The flexure blurs east-west with σ / cos φ of a
row's own cells (folded onto the row once wider than it) and north-south
with each source row's load spread by the rows' areas and normalised at
the source, so ∫ G dA = 1 wherever a load lies (equator, 70° and pole to
1e-6; area weights off, a polar load answered 5×); the load is binned per
cell area; its pole rows are one value. The epoch's sea level and mean land
temperature are by area. THE REST: `upsampleAt` and `deflectionAt` read
through `interpolate` (the forcing's half-cell convention kept on both
shapes: 0.35° of latitude on the sphere); the lithology lattice is the
globe noise's on the sphere; the coast's offsets go through `delta` (until
now the torus's minimum image by hand) and its fetch marches a great
circle. FRAME ON THE GLOBE, decided by measurement against the exact
sphere on a real sphere world at budget 4: the erosion index's cotangent
facets are the exact Voronoi edges to a median 1.4e-5 and a p99 1.1e-3 on
2048 × 1024 (1.3e-3 and 9.7e-3 on 256 × 128) — kept, since an edge's two
slots read one facet (mass conserved either way) and the areas are exact.
The sampler's vertex normals were not, for a different reason than
frame(): a triangle's normal found in its first corner's frame was added
unturned at the other corners — up to 0.6° off above 80°, p99 2 % of the
slope over 3°; now carried by `Domain.transport`, ≤ 0.002°. PROOF:
`harness:pipeline` runs a sphere world's Archean, hand-over and eroding
epochs through the runtime (finite, land and sea, no seam, the saved mesh
a valid globe), and on the modules at 256 × 128 six epochs beside the torus
of the same seed: the globe valid every epoch (V − E + F = 2, Delaunay,
cells 3e-15 off 4πR²), everything finite, the column's ledger closed
(306 036 against 291 225 km³), deposits bounded by supply,
a sane climate, temperature falling to both poles (N 24.3 > 8.6 > −12.6 °C,
S 24.7 > 8.5 > −12.2 by area), no seam in z, temperature or rain, the
same bytes twice, a restore that continues them, the hydrogeology's
invariants (390 springs), a continent turned onto the north pole (all land
above 80°N, valid and finite, −33 °C); and four primitives with a mutation
each — the sea of a pole row one temperature (unaveraged 1.2 °C apart), a
departure its length away near and across a pole (stepping the chart 124
cells off), the flexure's integral above, the blur as wide east-west as
north-south at 60° (counting cells 0.5). `harness:mesh` [1g] checks the
facets and the normals (with the transport left out: 0.74° against
0.001°). At 2048 × 1024 (seed `harness`, 100 Archean epochs, 12 epochs at
the history's defaults, Node, one thread): the mesh valid, no seam, land
9.7–11 %, the bands N 26.9 > 8.9 > −13.0 °C. COST, the same run: an epoch
1.47 s on the sphere against 1.33 on the torus — 1.10×, not the 0.65–0.8
the area promised: the nodes are 0.83× (58.7 k against 70.6 k mean; the
density follows land and coast, and the sphere has 0.75× the torus's land
area, not 0.64×), a node costs 1.33× (25.0 against 18.8 µs), and the
climate and flexure rasters keep their cell count. Per epoch, torus /
sphere, ms: rebuild and remesh 503 / 440, erosion 168 / 164, climate (every
third epoch) 130 / 140, flexure 67 / 110, baseline 114 / 156, forcing 93 /
132, tectonics 50 / 91, membership 10 / 36, lakes 85 / 89, ice 93 / 83,
coast 16 / 24 — the sphere's extra is its trig (the Domain's distance and
advance, the 3D noise), not the mesh. Found, not changed: the column's
craton product goes negative where a deposit lies over no crust (the
oldness field's −1 enters it; both shapes); on a world with almost no sea
the ice's sea level runs away (the ice over a vanishing ocean's area, to
−18 km on a small sphere — the small spheres are 80–100 % land); the
history's first remesh doubles the build's node count (35 k → 66 k on the
torus, 27 k → 59 k on the sphere). Not reached yet: the stages after the
history — the hydrology step's raster routing refuses a row table on the
sphere (`flowRouting.largestWaterComponent`), and the climate step's
refinement (the pressure wind's gradients, the basin rows) is not
pole-filtered. Golden harness byte-identical; the mesh harness's torus
build hash unchanged.

2026-10-10: step 4d4 BUILT — the adaptive mesh runs on the sphere
(the mesh itself; its erosion, flexure and climate are the coupled epoch's,
4d5, and step 2 stays locked). ONE TRIANGULATION: `PeriodicTriangulation`
keeps its topology code for both shapes — halfedges, splits, flips, the
ear clipping of a removal, the Lawson stack, the walk — and only its
geometry methods take a globe path (`globe`, from `domain.kind`). A node
keeps its chart position as its address and caches its unit vector,
derived from the stored float32 position, so a reload rebuilds the same
geometry. The predicates are exact in 3D, not a projection: the
orientation is the sign of det[a, b, c], the in-circle which side of the
plane through a, b, c the fourth point lies on (the spherical Delaunay
triangulation is the convex hull), with an absolute tolerance on top of
the relative one for the unit vectors' last bit; the circumcentre is the
plane's normal, a Voronoi cell a fan of spherical triangles (Van
Oosterom–Strackee), an edge the arc from its chord. The winding is the
chart's on both shapes (det < 0 on the globe), so the shared code reads
one sign. `frame` stays the log map, for the callers that want a local
picture (the sampler's normals, the erosion index's cotangents — close on
the globe, to O(ℓ²/R²); whether 4d5 wants them exact is its question).
`barycentric` moved into the triangulation: on the globe the weights of
the flat triangle the ray meets. THE BOOTSTRAP: `bootstrapLattice` — the
torus's hex lattice, the sphere's geodesic one (the icosahedron, each face
cut n × n, n matching the hex lattice's node area; turned off the poles
and the seam, since every (x, 0) is the north pole). THE REST: the remesh
places a node along an edge and across it through `displace`, `transport`
and `advance` (the torus's additions in their order, so its bits stay);
the codec, the canonical rebuild, the sampler's hint grid and the
rasteriser work unchanged over the chart; the routing and the density rule
were shape-free already. `createCoupledTerrain` builds a sphere world's
terrain. `harness:mesh` [1g], 5 s: on a 512 × 256 sphere, a synthetic
world (a continent across the seam, a massif on the south pole) builds
35 060 nodes in 0.2 s, against independent checks — V − E + F = 2, every
triangle wound one way, no point in a circumcircle across any edge (by
angle), the Voronoi cells 1e-14 off 4πR², settled in the hysteresis band
and a fixed point of the remesh; locate holds 3 131 points from far hints
(both poles at 16 longitudes, the seam), no fallback; 600 inserts and
5 094 removals stay Delaunay, none lost; a perturbed remesh goes to 0
long edges and crowded nodes 2 936 → 360 (the coarsen's four rounds, as
on the torus), an extensive field kept to 1e-9; the codec bit for bit;
`triangulatePoints` keeps every moved node; the raster without a seam and
with constant pole rows; the same bytes twice; the routing's reaches the
arcs; a real sphere world (Archean, two plate epochs, 256 × 128) starts
its coupled terrain valid (35 625 nodes). Cost: 6.3 µs a node against
the torus's 5.2 at 512; at 2048 × 1024 1.02 M nodes in 6.9 s against
0.95 M in 5.4. Found, not changed: a point landing exactly on a lattice
node collapses onto it and leaves with the lattice in `triangulatePoints`
(both shapes; meshTile inserts such points again). Tiles stay torus-only.
Golden harness byte-identical; the mesh harness's torus output and byte
hash unchanged.

2026-10-10: step 4d3 BUILT — the plate simulation runs on the sphere
(`stepEpoch`, the plate half of the coupled epoch; the mesh, the erosion
and the climate on the sphere are 4d4 and 4d5, and step 2 stays locked).
THE MOTION: on the sphere a plate turns about an Euler pole —
`EulerMotion` (a unit pole in the globe's frame and a rate) beside the
torus's drift + spin, now `RigidMotion`, in one union `PlateMotion`
(`tectonics/plateMotion.ts`). Its functions are the interface the rest of
tectonics uses, and each tells the forms apart by the motion's fields, so
the torus's data and arithmetic are as they were: the velocity ω × r in
the point's east/south frame, a point turned by Rodrigues and named in the
chart again (new `GlobeNoise.locate`, the inverse of `frame`), back by the
negative angle; the fit to the mantle flow the area-weighted least-squares
ω over the plate's cells, Σ w (|r|² I − r rᵀ) ω = Σ w (r × u), in 3D;
the coupling's inertia `relaxMotionToward` (ω relaxed as a vector), a
ridge plate's pure drift `motionMovingAt` (ω = r × v / |r|²). A fresh
plate's pole lies 30°–90° from its seed, its rate gives the seed the
torus's 30–90 units per time unit. THE REST through the Domain: new
`Domain.transport` carries a tangent vector from one point's frame to
another's (parallel transport along the great circle; the same two numbers
on the torus) — the boundary normal from the seeds to the boundary point,
the rift normal to each blob it pushes, a feature's and a suture's axis
after they move, a seam tangent to its seam; the trench, the accretion and
the split move as points (`advance`); the detection lattice keeps per row
the points its length holds, area-uniform; the ocean age's pole rows are
averaged after the advection and a reset, the reset's cells are the
disc's box (`discBox`); the feature buckets search a row as far in
longitude as a feature in it can reach (all of it where a cap may hold a
pole), the rows clamped at the poles — one query, `nearFeatureBuckets`,
for the elevation, the folds and the uplift field, in the torus's order.
`deserializePlateSimulation` takes the shape. `harness:pipeline` runs the
hand-over and 30 epochs at 2048 × 1024 beside the torus (seed `harness`):
everything finite and on the domain, pole rows constant, plates 10 → 10
(torus 19 → 19; over 200 epochs 10 → 8 and 19 → 19), mean seed speed
66.6 (torus 51.1), land 0.124 (0.053), 17.8 % of the lattice on a
boundary (18.1 %), 3.1 s for the 30 epochs (1.7 s); a turn by ±ω returns
to 1.9e-15 R, the velocity is rigid and |v| = |ω| R sin θ to 1e-14, the
fit finds a rigid flow's ω to 9e-6, the feature query near a pole misses
none. Golden harness byte-identical.

2026-10-10: 3D noise on the sphere BUILT — the coordinate noise is sampled
where the Domain says: `Domain.noise` is the chart on the torus (the
periodic 2D lattices, unchanged) and the globe on the sphere, whose
`frame` gives a point's position R · u and its east and south axes. The
ridged and fine noise (`ridgedMultifractalOn`, `fineDetailNoiseOn`), the
hypsometry and the slope-conditioned detail texture sample a 3D value
noise there (`elevation/globeNoise.ts`: the same octave tables, one cell
of width / cellsX, trilinear with smoothstep, an integer hash, the
spread gained back to the 2D noise's, the lattice turned off the globe's
axes so it is isotropic at every latitude, the ridged mean taken back to
RIDGE_MEAN). The warp is a 3D vector field there, its tangent part moving
the point along the globe (`domainWarpPoint`, through `advance`). One
value at each pole, no seam, as rough east-west as north-south at 60°
(the chart's lattice was 1.5× rougher east-west), the torus's spread:
`harness:pipeline` checks all four. The paths whose period is not the
world's (the level bake, the lithology lattice, the map's textures) do
not run on a sphere world and keep the chart lattice. Golden harness
byte-identical.

2026-10-10: step 4d2 BUILT — a sphere world runs its first step. The
screen sends its shape with `genesisInit`, the worker builds
`sphereDomain` (`domainOfKind`), and the Archean and its render run on it;
the step's layers are painted into the globe's textures and laid on it
(never step 0's: those are the flat sample world's), with the legend, the
layer list and the readout. Steps 2+ stay locked. Per stage:
the mantle on the grid's finite-volume metric (new
`DomainGrid.edgeScale`), the blur's east-west share sub-stepped near a
pole, the flow solve's high-latitude rows relaxed as cyclic lines, the
field averaged at the pole rows, mean and RMS area-weighted; the nuclei
offered per area; the raft scatters and the blob index filed by
`DomainGrid.discBox` (a cap's rows and its widest longitude span); the
point moves through `advance` and the new `Domain.displace` (advance
without the wrap, which keeps the torus's unwrapped sums); the warped
sample point wrapped as a point; the render's last row and the land
fraction through the grid (area-weighted). The sphere's distance caches
each point's trig, and its grids are kept per size. Left: the noise
lattices (warp, ridged, hypsometry) are sampled in chart units on the
sphere, stretched toward the poles and not single-valued at a pole; the
feature query is the torus's (the Archean has no features). Saving a
sphere world writes `SphereWorld` with its own data; it cannot be opened
yet. `harness:pipeline` runs the sphere's Archean through the runtime and
at 2048 × 1024 beside the torus. Golden harness byte-identical. Next:
4d3, the tectonics on the sphere.

2026-10-10: step 4c BUILT — the globe can show the layers
(`GlobeWorldView.setLayersShown`, the unshaded composite on the lit
globe), and its chart is laid as Babylon's sphere lays its UVs (u from +x
toward −z, v from the north pole), so a texel shows where `chartAt`
answers. No screen shows them yet: a sphere world has no layers until its
stages run (4d).

2026-10-10: step 4d1 BUILT — `Domain.advance(x, y, dx, dy, out)`, the
inverse of `delta`: the point reached by a tangent offset in the start's
frame. On the torus it is `wrapX(x + dx)`, `wrapY(y + dy)`; on the sphere
the exp map along the great circle, in delta's frame at a pole too. Four
sites moved as the proof (the drift in `advancePointByMotion`, the plumes'
climb, the two-sided terrain features, the raft blob merge); the other
point moves follow stage by stage. `harness:mesh` checks advance against
delta. Golden harness byte-identical.

2026-10-10: step 4b BUILT — `sphereDomain(width, height)` beside the
torus in `core/domain.ts`: the 2:1 chart as longitude × colatitude (y = 0
the north pole), distances on the globe of radius W / 2π, `delta` the log
map in b's east/south tangent frame (at a pole the frame follows b's
meridian), `rotateAround` an Euler rotation. `Domain.wrapPoint` is new:
crossing a pole turns the longitude by half, which wrapX/wrapY alone
cannot say. The sphere's grid steps across the pole to column + resX / 2,
samples continuously across it, gives exact band areas and
`averagePoleRows` (a no-op on the torus); its `rowTable` refuses a margin.
`harness:mesh` checks it; no stage runs on it yet. Golden harness
byte-identical. Next: 4d, the stages onto the sphere.

2026-10-10: step 4a BUILT — `Domain.delta(ax, ay, bx, by, out)`, the
offset from b to a in b's local frame, replaces `deltaX`/`deltaY`; 33
call sites moved (the mesh's triangle unwrapping among them), the `out`
object held per caller so the hot loops allocate nothing. Golden harness
byte-identical against the tree before 3a; timings unchanged. Next: 4b,
the sphere Domain and its grid with pole handling (fork 5).

2026-10-10: step 3c BUILT — `world.yaml`'s kind is read and checked
(`worldKindOf`, `WorldRecord.kind`), written from the world's shape, and
hashed into `deriveWorldId`; every world saved before has a new id, and
its artifacts are made again. The generator restores only `FlatWorld`.
Stage 3 of fork 4 complete; step 4 (the sphere Domain) not started.

2026-10-10: step 3b BUILT — the raster side: every raster wrap in
`generator/` goes through a `DomainGrid` from `domain.grid(resX, resY)`
(wraps, indices, neighbours, the samplers, neighbour tables for the hot
loops; `rowScale`/`cellArea` 1 on the torus), threaded from the stage
that owns the Domain; a second lint gate refuses `core/field.ts`'s wrap
and samplers outside `core/`. The periodic noise lattices
(`ridgedNoise`, `domainWarp`, `hypsometry`) are excepted: the sphere
replaces the noise, not its wrap. Steps 3a and 3b together checked
against the tree before 3a with the golden harness's byte hashes: three
worlds × 46 stages byte-identical. Step 3c (the kind in the world id) not
started.

2026-10-10: step 3a BUILT — the vector layer reaches the torus only
through `Domain` (with `rotateAround` added); a lint gate in `make lint`
refuses `core/toroidal` imports outside `core/domain.ts`. (The golden
run of that day had no byte hashes recorded, so it proved the metrics
only; the byte check against the tree before 3a came with 3b, below.)

2026-10-10: step 2 of fork 4 BUILT — `client/src/map/worldView.ts` (with
chart points as fractions u, v), `flatWorldView.ts` around the map plane,
its camera and river ribbons, and the globe (`sphereView.ts`) as the second
implementation; the generator screen asks the view on screen for the
pointer, the scales and the camera. The layers are still painted into the
flat view alone: a sphere world has none yet. The scale bar and the
temperature scale are hidden on the globe for now: they read it through
chartAt, but the orbit camera zooms by swooping, which they do not suit
as built — their globe form is to be thought through. Steps 3 and 4 not
started.

2026-10-09: decided in conversation; fork 2 changed the same day from a
spec field to the save's `kind`, the manifest's duplicate removed with it. Built: the sphere's first step only
(`client/src/map/sphereView.ts`, the shape picked from the world list, the
later steps locked). None of the four steps of fork 4 is started.
