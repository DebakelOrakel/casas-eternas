---
id: DEC-0047
title.en: The incubator's cells
title.de: Die Zellen des Inkubators
summary.en: The incubator computes on the generator's field mesh at 10 km,
  unrelaxed, not on the world raster. Its cells are of near one size
  everywhere with six neighbours at their true distances, so the spread
  has no octagon fronts and the poles hold cells. The mesh is made in the
  incubator's one worker in seconds; one map of texels to cells serves the
  drawing.
summary.de: Der Inkubator rechnet auf dem Feldnetz des Generators mit 10 km,
  ungeglättet, nicht auf dem Weltraster. Seine Zellen sind überall fast
  gleich groß, mit sechs Nachbarn in ihrem wahren Abstand, so dass die
  Ausbreitung keine achteckigen Fronten hat und die Pole Zellen haben. Das
  Netz entsteht im einen Worker des Inkubators in Sekunden; eine Zuordnung
  von Texeln zu Zellen dient dem Zeichnen.
area: mechanics
stage: built
createdAt: 2026-10-26
related: [DES-0032, DEC-0046]
---

## Where this starts

The incubator's steps ([DES-0032](../design/incubator.md)) first computed
on the save's world raster, 2048 × 1024 on Morvane, with level 1 sampled
onto it. On a sphere that raster is a longitude–latitude grid: a cell at
60° is half as wide as at the equator, the poles have none, and a spread
over its eight neighbours runs in octagons. The settlement then needed
more than one lifeway per cell, a good moment to change what a cell is.
The generator already has a mesh that does not have these faults: the
icosahedron's dual on the sphere, hexagons on the torus.

## Fork 1 — the grid: DECIDED — the generator's field mesh

- **A. The world raster** (as built). Simple; the chart and the save use
  it. Cells of unequal size on the sphere, none at the poles, fronts along
  eight directions.
- **B. Level 1's own nodes.** The terrain's true resolution; 8.3 M nodes
  on Morvane, too many for the browser beside the chart.
- **C. The generator's field mesh** (`fields/fieldMesh.ts`) at a spacing
  of the incubator's own.

**C.** One mesh for every step, cells of near one size, six neighbours at
their true distances. Every step works on a graph (`nbrStart`, `nbr`,
`distKm`) and does not know the topology.

## Fork 2 — the spacing: DECIDED — 10 km

The world raster's cell was 9.8 km at Morvane's equator. 10 km keeps the
numbers that were set on it (the spread's speeds, the villages' rings)
near where they were: 1.47 M cells of 50 to 105 km² on Morvane.

## Fork 3 — relaxed or not: DECIDED — not

The generator relaxes its mesh (centroidal iterations) for its fields.
At 10 km that took 43 s; unrelaxed 2.4 s, the areas 50 to 105 km². The
incubator's rules are not sensitive to that spread. `createFieldMesh`
takes `relax`, and `geodesicLattice` gives the unrelaxed points.

## Fork 4 — the sea depth of a cell: DECIDED — its shallowest sea texel

The land bridges need the sea depth. The mean over a cell's sea left 1.5 %
of Morvane's sea on the shelf (to 120 m) and no bridge: people reached
31 % of the ice-free land. The shallowest sea texel, as a point sample did
before, brings them back: 83 %.

## Consequences

- One worker (`incubatorWorker.ts`) makes the mesh and holds it; the old
  four workers each read the raster on their own. The cells take 8 s on
  Morvane, the map of texels to cells (`rasterOwners`) included.
- The overlay draws through that map: a texel shows its cell. Marks and
  arrows take a cell's centre (`u`, `v`).
- Small islands merge with their cells: Morvane has 75 landmasses on the
  cells against 85 on the raster.
- The results moved little: the spread's reach 80 % → 83 %, farmers 12 736
  raster cells → 15 362 cells, herders 9 288 → 9 041. The third farming
  centre went.

## Status

Built 2026-10-26.
