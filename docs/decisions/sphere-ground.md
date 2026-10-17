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

| | the raster on the chart | the raster in the tile's own plane |
|---|---|---|
| shape of a tile | not square, a strip near the poles | the square of DEC-0041 fork 3 |
| what exists | nothing | `cubeFrameOf`, the tile's gnomonic plane |

**Answer: in the tile's own plane.** A sphere tile's raster is sampled
on a regular grid in its gnomonic plane, where its sides are straight
(DEC-0041 fork 3). The source finds the tile of a world point with
`tileAtOn` and reads the raster at the point's frame coordinates. The
level-1 rasters lie on level 2's cube tiles, from the level's mesh
sampler, as they lie on level 2's square tiles on the torus.

## Fork 6 — The seams' normals

On the sphere a tile's nodes are world points (DEC-0041), so two tiles
match their edge nodes by the point, not by a shift. A tile's normal
sums are in its own plane; before they are added, a neighbour's sums are
turned into the tile's plane through 3D. The order of the sums stays the
order of the tiles' ids, so both tiles get the same bits.

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
