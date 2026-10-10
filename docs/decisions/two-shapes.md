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
updatedAt: 2026-10-09
related: [DES-0017, DEC-0029, DEC-0015, DEC-0024]
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
- `kind` goes into `deriveWorldId` and `derivePipelineVersion`, for both
  shapes. That changes the id of every flat world saved before it, and
  with it the keys of their artifacts; accepted — the old worlds and
  their artifacts are made again, not migrated.
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

## What this does not decide

- Hex tiles on a sphere (Goldberg polyhedron or patches) —
  [hex-tiling.md](./hex-tiling.md) is torus-snapped throughout, and
  DES-0017 asks the question; it waits for the game's answer.
- Polar fidelity, and the mantle's pole rows — DES-0017's open questions.
- Whether the flat map gets a camera reset like the globe's.

## Status

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
