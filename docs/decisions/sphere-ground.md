---
id: DEC-0042
title.en: The ground on the sphere — a cap around an anchor
title.de: Der Boden auf der Kugel — eine Kappe um einen Anker
summary.en: The incubator's ground (the rings, the painter, the tile
  rasters) draws a sphere world as a spherical cap around an anchor near
  the focus. The rings are planned in the anchor's azimuthal equidistant
  plane, as on the torus, and each vertex is then put on the sphere. The
  anchor moves when the focus goes too far from it. The rings reach at
  most a hemisphere; the whole globe stays the generator's view. A tile's
  raster lies in the tile's own frame. Both shapes use one ground with
  two seams, a ground frame and a tile frame.
summary.de: Der Boden des Inkubators (die Ringe, der Maler, die
  Kachelraster) zeigt eine Kugelwelt als Kugelkappe um einen Anker nahe
  dem Fokus. Die Ringe werden in der mittenabstandstreuen Azimutalebene
  des Ankers geplant, wie auf dem Torus, und jeder Vertex danach auf die
  Kugel gesetzt. Der Anker zieht nach, wenn sich der Fokus zu weit
  entfernt. Die Ringe reichen höchstens bis zur Halbkugel; den ganzen
  Globus zeigt weiter der Generator. Das Raster einer Kachel liegt in
  ihrem eigenen Rahmen. Beide Gestalten benutzen einen Boden mit zwei
  Nahtstellen, einem Bodenrahmen und einem Kachelrahmen.
area: ui
stage: decided
createdAt: 2026-10-17
related: [DEC-0025, DEC-0035, DEC-0041]
---

## Where this starts

A sphere world now has its tiles through level 3 (DEC-0041; Brannoch,
2026-10-17: 7083 level-3 tiles, every seam checked). The incubator does
not show them: it skips sphere worlds (`IncubatorScreen.ts`).

The incubator's ground (DEC-0025; `map/groundRings.ts`,
`map/groundPaint.ts`, `screens/incubator/ground*.ts`) works in torus
cells everywhere:

- the rings are concentric squares in the world plane (x, y), and the
  vertices' x and z come from the ring's grid; only the heights are
  built;
- a tile's raster has a corner and a side on the world grid
  (`tileFrame`), and the source finds it with `tileAt` on a
  `torusDomain`;
- the material fields (biome, climate, water) are world rasters, read
  with a wrap in x and in y;
- the seams' normal sums match edge nodes by a whole-tile shift
  (`groundSeams.ts`);
- the metres are the torus's (`TORUS_METERS_PER_CELL`).

The sphere's chart (longitude, latitude) laid flat is not a view: its
east-west scale grows as 1/cos(latitude), and it is infinite at the
poles.

The generator has the same question for its views. It answers it with
two views behind one interface (`map/worldView.ts`: the flat map, the
globe). For the ground the user asked for one system, not two, the same
as the tiles (DEC-0041 fork 10, `TileSite`).

The sphere is 20 000 km round: R = 3183 km.

## Fork 1 — The surface the ground is drawn on

| | the chart laid flat | a tangent plane | a tangent plane, heights lowered by d²/2R | a cap of the sphere | the whole globe |
|---|---|---|---|---|---|
| distortion | grows to infinite at the poles | grows with distance | grows with distance | none in the geometry | none |
| horizon | none | none | approximate | true | true |
| what changes in the rings | nothing | nothing | the heights | the vertices' positions | a second ring system |
| reach | the world | some 100 km | some 1000 km | a hemisphere | the world |

**Answer: a cap of the sphere** (the user's proposal). The lowered tangent
plane is the small-angle form of the cap; the cap is exact for the same
cost, and it lets the rings reach far enough that the view becomes part
of a globe when one zooms out. The whole globe as ground is a second
system; that is what this decision avoids.

The cap is set up in the anchor's frame: the origin at the anchor on the
sphere, +y along its normal. A point at distance d and bearing φ from the
anchor, with height h, is at

    θ = d / R
    (R sinθ cosφ, R cosθ − R + h, R sinθ sinφ)

before the exaggeration. The camera, the light and float precision stay
local, as on the torus. On the torus the same map is the identity.

## Fork 2 — The plane the rings are planned in

| | radial scale | across scale | at d = 1000 km | at 90° |
|---|---|---|---|---|
| azimuthal equidistant | 1 | sinθ/θ | 1, 0.984 | 1, 0.64 |
| gnomonic | 1/cos²θ | 1/cosθ | 1.11, 1.05 | infinite |
| orthographic | cosθ | 1 | 0.95, 1 | 0, 1 |

**Answer: azimuthal equidistant.** A ring's texels keep their size along
the line of sight, and across it they shrink by sinθ/θ only. The rings
keep their square grids, their snapping and their holes in this plane;
the painter paints in it. Only the vertex positions go through fork 1's
map.

## Fork 3 — The anchor

The plane is true near the anchor only. **The anchor moves when the
focus is more than a set distance from it** (about 500 km, to measure:
there the across scale is 0.996). Then every ring is built again, and
the camera is put at the same world point, its heading turned by the
change of north between the two planes. A move of the anchor costs what
a long pan costs today.

## Fork 4 — The reach

**The rings reach at most θ = 90°** (5000 km): beyond the horizon of
every camera that looks at the cap from outside, there is nothing to
draw. The outermost ring is the one that reaches 90°, not the one that
spans the world. The whole globe stays the generator's view
(`map/sphereView.ts`); the incubator does not show the whole sphere.

The painted normals of the outer rings are in the plane's frame, and the
cap tilts the surface by θ. They are turned by θ about the axis across
the bearing, in the shader or when they are painted; for the inner rings
the turn is below what can be seen.

## Fork 5 — The tile's raster frame

| | on the chart | square in the tile's own plane | the tile's rectangle on its cube face |
|---|---|---|---|
| shape of a tile | not square, a strip near the poles | a quad at a slant in the square | the rectangle itself |
| the raster's edge rows | — | cut the sides at a slant | lie on the sides |
| two tiles at a shared side | — | sample it at different points | sample it at the same points |

**Answer: the tile's rectangle on its cube face**, in the face's gnomonic
coordinates (tan ξ, tan η). A tile of the equiangular grid is a
rectangle there, and a side is one segment of the cube for both tiles
that share it (DEC-0041 fork 5), so the raster's first and last rows lie
on the sides, as on the torus. The tile's surface is still read in its
own plane, where it was triangulated (`cubeFrameOf`). The source finds
the tile of a world point with the atlas and reads the raster at the
point's face coordinates. The level-1 rasters lie on level 2's cube
tiles, from the level's mesh sampler, as they lie on level 2's square
tiles on the torus.

First built square in the tile's own plane; on Brannoch's level 2 the
two tiles' reads at a side then differed by 1.5 m (median, p99 29 m) and
by 1.4° in the normal (p99). On the face rectangle: 0.04 m (p99 0.5 m)
and 0.03° (p99) (2026-10-17).

The slope a sphere raster holds is the ground's against the local
vertical, along the tile's axes laid into the local tangent plane. In
the tile's plane the vertical is the tangent point's, which at a corner
of a level-2 tile leans 1.4° from the ground's own.

## Fork 6 — The seams' normals

On the sphere a tile's nodes are world points (DEC-0041), so two tiles
match their edge nodes by the point, not by a shift. A tile's normal
sums are in its own plane; before they are added, a neighbour's sums are
turned into the tile's plane through 3D. The order of the sums stays the
order of the tiles' ids; the two tiles then agree on the normal to the
rounding of the turn, not to the bit.

## Fork 7 — The material fields

The fields stay world rasters on the chart and are read through the
world's `Domain`: on the sphere x wraps and y does not. The water levels
(`waterLevels.ts`) find their neighbours the same way. A field read near
a pole reads its chart's row there; its cells are 62 km and smooth, so no
special case.

## Fork 8 — One interface

The ground gets two seams, like the tiles' `TileSite`:

- a **ground frame**: the plane of the view (metres) to a world point and
  back, the vertex map of fork 1, the metres per cell and the anchor. The
  torus's frame is a shift with the wrap, the one of today. The sphere's
  is forks 1–3.
- a **tile frame**: a tile of a level at a world point, and the point in
  the tile's raster frame. The torus's is the corner and the side of
  today (`tileFrame`); the sphere's is the cube tile's plane.

The rings, the painter, the camera and the scheduling of the builds
stay one code for both shapes. **The torus stays as it is to the byte**:
its rasters and its paints are checked against today's, by data.

## Order of building

1. **The two frames on the torus**, byte-identical: the ground source,
   the worker and the seams through them.
2. **The sphere's tile frame**: the rasters of level 1, 2 and 3 on a
   sphere world, checked against the tiles' heights at their nodes and
   across the seams.
3. **The sphere's ground frame**: the cap, the anchor, the reach, the
   normals' turn. The incubator opens sphere worlds.

## What this does not decide

- Level 4 near the camera.
- How the globe in the generator shows the tiles.
- The game's view of a sphere world.

## Status

2026-10-17: decided with the user.

2026-10-17: order of building, steps 1 and 2 BUILT. The tile frame
(`screens/incubator/groundTiles.ts`) carries the ground source, the
worker and the seams on both shapes. The torus is byte-identical: a
64 × 32 torus with 40 tiles, its tile rasters with their seams, its
level-1 rasters and six painted rings hash the same before and after.
The ground frame of fork 8 is left for step 3, where it first does
something. On Brannoch (level 1, 2 and 3 from the artifacts): a raster
read through the source against the tile's own surface, 0.03 m (level
2) and 0.11 m (level 3) median, p99 2.7 m; across seams 0.04–0.11 m
median, p99 0.6 m, the normal p99 0.1°; level 1's rasters against the
mesh 0.00 m median, p99 19 m, poles included.

Found on the way: 206 of Brannoch's 2359 level-2 tiles held triangles
that span the tile (1195 of them; level 3 none). A raster of such a
tile read the wrong triangle in places (up to 1.2 km off). They were
bootstrap lattice nodes left in the tile's mesh; fixed in the tiles the
same day (sphere-tiles.md, Status).

2026-10-17: order of building, step 3 BUILT — the incubator opens sphere
worlds. The ground frame (`screens/incubator/groundFrame.ts`): the
anchor's azimuthal-equidistant plane, the cap (`capPoint`, `capTurn`),
the anchor's move (`reanchor`). The rings take a shape
(`map/groundRings.ts` `setShape`): their vertices on the cap, the
exaggeration in the vertices, the ring that first reaches 90° the
outermost drawn. The source reads plane cells about the anchor and turns
every slope into the plane's axes (the anchor's east and south carried
to the point); the worker turns the painted normals onto the cap. Two
things the forks did not say:

- THE GROUND TURNS UNDER THE FOCUS. The rings hang from one node that
  turns the cap so the ground under the focus lies flat, its point at
  the focus. Without it the horizon leaned by the focus's distance from
  the anchor in arc — 9° at 500 km. The normal map is painted in the
  anchor's frame, so the shader takes the node's turn
  (`groundNormalPlugin` `setTurn`); the detail tiles stay on the scene's
  x and z, which near the focus are the ground's.
- THE SEA IS PAINTED. The sea's plane (`groundWater.ts`) is the
  torus's; on the sphere the rings lie at the sea's level over the sea
  anyway, and the painter marks the sea as water as it marks a lake
  (`paintSea`), so the shader gives it the water's look.

The anchor moves at 1 500 km (fork 3 said about 500): with the ground
turned, only the plane's scale across the bearing is left, 0.97 there,
and every move builds every ring again. Until a ring's new build
arrives it stays drawn where it stood, CARRIED into the new plane
(`groundRings` `carry`): the turn about the sphere's centre that takes
the focus to the top, then the turn about the vertical by the angle
between the two planes' axes there. At the farthest zoom a pan crosses
1 500 km many times a second; when each move dropped the rings, the
ground was blank in 212 of 301 frames of a 4 s pan (2026-10-18). Carried,
in none; an old point lands on the new cap within 1e-5 cells. A ring
and the ring outside it from different planes are not drawn together
(the outer one has no hole for the inner one): the older plane gives
way.

Checked on Brannoch: the cap's turn takes the normal at the focus to the
scene's up, and a point near the focus lands where the plane puts it,
less the cap's drop. A slope read through a level-1 raster (the tile's
axes) and through the mesh (east and south) comes out the same in the
plane's axes (median 0, p90 9 %, no turn between them). No ring paints a
NaN. The torus is byte-identical (the 64 × 32 check). In Safari (driven
by script; the window was hidden, so frames by hand): the globe at the
farthest zoom, a curved horizon tilted, a re-anchor with the camera put
at the new origin, no error.

Seen and left: the incubator lists a world's tiles whatever their
pipeline version (`IncubatorScreen.ts`), so Brannoch's tiles from before
the lattice fix show (a lattice node at the sea's level in a deep sea
paints a shallow square). The camera keeps the torus's zoom range, so at
the farthest zoom the globe is a disc in the middle of the view. Level
1's facets show as creases in the hillshade on both shapes.

