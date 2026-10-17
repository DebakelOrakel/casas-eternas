---
id: DEC-0041
title.en: Tiles on the sphere — a cube atlas
title.de: Kacheln auf der Kugel — ein Würfel-Atlas
summary.en: The fine levels (L2, L3) tile the sphere with the six faces of
  a cube, each face split into n × n tiles on an equiangular grid. A tile
  is a quad whose sides are great-circle arcs; it is triangulated in its
  own gnomonic plane, where those sides are straight. Each level turns its
  cube by a fixed rotation, so its seams run through the inside of the
  tiles of the next level. The torus keeps its square tiles; both shapes
  get their tiles from one atlas interface. Not the icosahedron, not
  HEALPix.
summary.de: Die feinen Ebenen (L2, L3) kacheln die Kugel mit den sechs
  Flächen eines Würfels, jede Fläche in n × n Kacheln auf einem
  winkeltreuen Gitter. Eine Kachel ist ein Viereck mit Grosskreisbögen als
  Seiten; sie wird in ihrer eigenen gnomonischen Ebene trianguliert, in
  der diese Seiten gerade sind. Jede Ebene dreht ihren Würfel um eine feste
  Rotation, sodass ihre Nähte durch das Innere der Kacheln der nächsten
  Ebene laufen. Der Torus behält seine quadratischen Kacheln; beide
  Gestalten erhalten ihre Kacheln über eine Atlas-Schnittstelle. Weder
  Ikosaeder noch HEALPix.
area: generator
stage: decided
createdAt: 2026-10-17
related: [DEC-0032, DEC-0031, DEC-0035, DES-0017, DES-0022]
---

## Where this starts

A sphere world runs up to step 4 (ecology). Step 5 (finishing) is locked
for it: the level bake and the tiles are torus-only
([two-shapes.md](./two-shapes.md), Status: "Tiles stay torus-only"; the
level bake "does not run on a sphere world").

The tiles of today ([tile-jobs.md](./tile-jobs.md),
[detail-ladder.md](./detail-ladder.md), `client/src/generator/mesh/meshTile.ts`)
depend on these properties:

- a square tile in macro cells, with a halo that is computed and not kept;
- a pinned EDGE LINE on each side, the same nodes at the same heights for
  the two tiles that share the side;
- new nodes placed by a rule of their position only, the same for the
  whole world;
- a triangulation over the tile and its halo, the existing periodic one;
- a FLOW ORDER across edges (the coordinator's graph, DES-0022);
- STAGGERED GRIDS: each level is shifted by half its tile against the
  level above, so the seams of one level are eroded again inside the
  tiles of the next.

The question was how to tile a sphere and keep these properties. The
engine freeze (2026-10-15) does not apply: the tiles refine a finished
history and do not change the simulation.

## Fork 1 — Which tiling

| | cube (6 faces × n × n) | icosahedron (20 triangles × n²) | HEALPix (12 × quadtree) | latitude-longitude |
|---|---|---|---|---|
| tile shape | quad | triangle | curved quad | quad, triangles at the poles |
| fits a square frame and raster | yes | no: about half of the frame is outside the tile | partly | yes |
| special points | 8 corners, 3 tiles meet | 12 corners, 5 tiles meet | 8 | 2 poles |
| area spread | about 1.4 (equiangular) | smallest | none (equal area) | unbounded at the poles |
| torus code that carries over | nearly all | frame, sampler and edges new | much new | much, but the poles new |

**Answer: the cube.** Its tiles are quads with four children and
neighbours across edges, the shape that the torus tiles have now. The
torus becomes an atlas of one face that wraps, the sphere an atlas of six.

The icosahedron gives no gain on the torus: the torus is flat, there is
no curvature to spread, so there it is only a triangle lattice, worse for
square rasters. Its one advantage is a match with a Goldberg hex grid, if
the game takes one on the sphere (DES-0017, open). The game's hexes are a
layer above the mesh and do not need the same tiles.

## Fork 2 — The projection of a face

**Answer: equiangular.** A face point is two angles (ξ, η), each in
[−π/4, π/4], and the grid is uniform in the angles. The tile areas then
spread by 1.39 (largest tile against smallest, measured at n = 40),
against 5.2 (3√3) for a grid uniform on the plain gnomonic face. On both grids each grid
line is a great circle (a plane through the centre of the sphere), so a
tile side is a great-circle arc.

## Fork 3 — The plane a tile is triangulated in

**Answer: the tile's own gnomonic plane**, tangent at the tile's centre.
A gnomonic projection maps every great circle to a straight line, so:

- the four sides of the tile are straight in its plane, and the edge-line
  rule (a row of nodes with a clear strip makes each step a Delaunay edge)
  holds unchanged;
- a side is straight in the planes of BOTH tiles that share it, also
  across a cube edge and at a cube corner;
- the halo of a tile at a cube edge reaches into the next face without a
  special case: its points are projected into the same plane.

The triangulation stays the existing periodic one over the frame and its
halo; its wrap-around triangles lie in the halo, as today. Inside a tile
the plane's scale differs from the sphere by less than 0.2 % (a tile
spans about 1° (L3) to 2.3° (L2) of arc on a sphere of 20 000 km).

The inside test of a tile is four half-spaces in 3D: a point p is inside
when `dot(p, nᵢ) ≥ 0` for the normals nᵢ of the planes of its four sides.

## Fork 4 — Staggering

The torus shifts each level by half a tile. On the cube, a shift by half
a tile breaks at the face edges: the 12 cube edges would be seams on
every level.

**Answer: each level turns its cube.** A level's atlas is the cube under
a fixed rotation of its own, so the face edges of one level run through
the inside of the tiles of the next. A tile of a level reads its parent
by area (as today, where the staggered grids already break the nesting),
so the rotation does not matter to it. The rotations are constants of the
pipeline; a change to one is a change to the level's pipeline version.

## Fork 5 — Seams across faces

The edge line asks for the same nodes at the same heights from both
sides. Two tiles on two faces compute positions in two planes.

**Answer: a canonical side.** Each side has one owner (the tile with the
lower id), which parametrises the side by its angle along the arc. A node
on the side is a quantised arc position, turned into a 3D point by one
formula. Both tiles derive the 3D point from it and then project it into
their own plane. A height is a function of the 3D point, never of plane
coordinates. The quantum (`TileSpec.quantum`) is a grid on the face
angles; it keeps every 3D point exact enough to be the same in both tiles.

## Fork 6 — Corners

At the 8 cube corners three tiles meet, not four. In its plane a corner
tile is a convex quad with one angle of 120°.

**Answer: no special case in the tile.** Fork 3's inside test and fork
5's canonical sides hold for any convex quad. Only the atlas's neighbour
table knows that a corner has three tiles; the flow order and the vertex
neighbours come from it.

## Fork 7 — Placement grids

New nodes are placed on a jittered grid per placement level, a rule of
position for the whole world.

**Answer: one grid per placement level on the level's cube**, in the face
angles. A grid cell belongs to exactly one face; the existing rule (drop
a node where a parent node or a coarser level's node stands within half
the step) keeps candidates near a face edge from crowding. The density
rule stays the one of `meshDensity.ts`, evaluated at the 3D point.

## Fork 8 — Tile ids and jobs

A torus tile is `(level, x, y)`. A sphere tile is `(level, face, i, j)`.

**Answer: the face folds into the column** (changed while building,
2026-10-17): a sphere tile is `(level, x, y)` with x = face · n + i and
y = j. Ids, stage names (`L2:x,y`), artifact keys and the coordinator's
`TileRef` stay as they are, on both shapes; the Go side changed nothing.
The flow edges across a face edge come from the atlas's neighbour table.

## Fork 9 — Tile size

**Answer: n per face from macro cells** (changed while building,
2026-10-17): a face edge is a quarter of the chart's width, and a tile
spans `TileSpec.cells` units at a face's centre, as a torus tile spans
that many cells. At 2048 × 1024 that is n = 32 (L2) and n = 64 (L3), tiles
of 156 km and 78 km on a sphere of 20 000 km. In units, the placement
steps, the edge steps and the halo stay the torus's numbers; the density
rule places the nodes in metres either way.

## Fork 10 — One interface

**Answer: a tile atlas** in `generator/mesh/`, beside `Domain`: the tiles
of a level, a tile's frame (its plane and the projection into it), the
inside test, the sides with their owner and parametrisation, the
neighbours with their orientation. Two implementations: the torus atlas
(one face, square tiles in macro cells, the half-tile shift, wrap) and the
cube atlas. `meshTile.ts`, the tile sampler and the coordinator's plan ask
the atlas and no longer the torus directly. The torus through the atlas
must stay byte-identical: the golden harness and the mesh harness's build
hash check it.

## Order of building

1. **Level 1 on the sphere.** The replay at level 1's budget and the level
   artifact for a sphere world (`replayLevel`, `levelHydrology`, the
   artifact format). Measure first what of it runs today.
2. **The atlas on the torus.** The torus tiles through the atlas,
   byte-identical.
3. **The cube atlas and L2 on the sphere.** Then L3.
4. **The finishing step unlocked** for a sphere world.

## What this does not decide

- The game's hex grid on the sphere (DES-0017).
- Level 4 near the camera, and how the globe draws the tiles.
- The L1 replay's cost on the sphere: step 1 measures it.

## Status

2026-10-17: decided with the user.

2026-10-17: the cube atlas's geometry BUILT, not yet used
(`client/src/generator/mesh/cubeAtlas.ts`): the faces, the equiangular
grid with exact corners (the TANS table), the level's rotation, the tile
at a direction, the inside test, the neighbours across sides and corners,
the tile's gnomonic plane, the canonical side points. `harness:mesh` [1c]
checks it: every corner the same bits from every tile, 6n² + 2 corners,
mutual neighbours, 24 tiles at the cube's corners, every direction in one
tile, a side the same points from both tiles and straight in both planes
(1e-15), and at n = 40 on 20 000 km a centre tile of 125.0 km, the areas
spread 1.39.

2026-10-17: order of building, step 1 BUILT — level 1 on the sphere. The
replay, the level's waters and the artifact ran on the sphere already;
three places assumed the torus: the worker's recipe had no shape (a
sphere world was replayed as a torus), the level's mesh decoded on a
torus (`meshLevelMesh` takes the shape now), and `WorldInputs` did not
say the world's kind (`kind`, from `World.kind`). The worker plans no
tiles for a sphere world and refuses a sphere tile until step 3.
`harness:pipeline` ("level 1 of a sphere world"): a 256 × 128 sphere
replayed at level 1's budget (101 k nodes, 20 s), its waters, the
artifact read back and decoded on the sphere. Not yet run on a world a
player made: the screen's finishing step stays locked for a sphere world
(step 4).

2026-10-17: order of building, steps 2–4 BUILT.
- **The site** (`meshTile.ts`): a tile is built on a `TileSite` — its
  frame, its edge row, its parents, its placement — by one builder
  (`buildTileMeshOn`); `torusSite` is the torus's code as it was, and
  `harness:mesh` [3] holds the torus's tiles, bakes, patchwork, plan and
  upstream inflow byte for byte. `tileLayout.ts` picks the shape.
- **The sphere's site** (`meshTileCube.ts`): forks 3–7 as decided; the
  halo is the quad grown by `halo`, not the frame's square (a turned quad
  left it half empty: 33 k halo nodes against 27 k new ones, now 8 k).
  The patchwork of level 3 is triangulated on the sphere; a sphere tile's
  artifact stores its nodes as world points (float32), so a node two
  tiles share has one name.
- **The synthesis on the globe**: a sphere tile's synthesis reads the same
  tables on the 3D lattice (meshRefine.levelSynthesis, `sphere`), so it
  neither stretches toward a pole nor turns about it; the ridged table's
  globe mean is 0.0097 above the chart's (measured, RIDGE_GLOBE_OFFSET).
- **One tile version a level for both shapes**: the cube's constants are
  in it (meshTileArtifacts.ts), so changing one makes the torus's tiles
  again too — against a version per shape every reader of a stage would
  have to ask the world's shape for.
- **The worker** plans and bakes a sphere world's tiles; the finishing step
  is unlocked for a sphere world (the migration stays locked); the
  incubator leaves sphere worlds out.
- `harness:mesh` [1t] on [1g]'s sphere world: a tile at a cube corner meets
  its four neighbours on three faces (the shared row bit for bit, every
  step an edge of both triangulations); a tile with a pole at its corner
  likewise; a wider halo changes nothing inside; the bake pins the edge,
  erodes and drains the inside; the artifact reads back; level 3's tiles
  on their patchworks of level 2 meet; an upstream tile's outflow is the
  tile's inflow (38.93 out, 38.93 in); the plan is acyclic and whole.
  Level 1's rivers enter cube tiles (a 512 × 256 sphere, one-off).
- Not run yet: a sphere world a player made, through a real worker.
