---
summary: How the top level of the detail ladder runs — level 1 stays the one global level, level 2 is computed per tile; square tiles of 8 × 8 macro cells (~62 km) at ~120 m spacing; new nodes placed by a world-wide deterministic rule so neighbours agree; each tile computes with a halo and keeps its interior; only the tile's edge line is pinned to the parent surface, so tiles stay independent and seams close; the river network stays frozen; one artifact per tile; ordered one tile at a time from the Finishing step.
date: 2026-09-29
area: generator
stage: decided
status: decided 2026-09-29; the tile's mesh, its bake, its artifact and its job built 2026-09-29/30 (mesh/meshTile.ts, pipeline/meshTileBake.ts, world/meshTileArtifacts.ts); the pick in the Finishing step 2026-09-30. Refines fork 3 of adaptive-mesh.md (the ladder, the tile) with the numbers and the seam rule it left open.
---

# Tile jobs

## The fork

decisions/adaptive-mesh.md, fork 3, decided that detail comes as a ladder
of mesh levels: the lower levels run globally (one job per level, the
river network may still rebuild), the top level runs per tile (parents
immutable, network frozen), each tile deterministic from (parent state,
tile id, seed). It left open how many levels run globally, the tile's size
and node budget, how tiles meet, and how a tile is ordered. Level 1 is
built (2026-09-23: 17 M nodes on a real world, 349 MB, 155 s single-
threaded).

## Answers

1. **Level 1 is the one global level; level 2 is the top level, per
   tile.** Level 1 came out at ten times its parent's nodes rather than
   four, because the synthesis roughness is relief the density rule
   refines; a global level 2 at that rate is ~170 M nodes, past what one
   job should hold. Damping that feedback first (the level's floor above
   the synthesis wavelength) would bring a global level 2 to ~70 M and
   only move the problem a level down.

2. **Tiles are squares of 8 × 8 macro cells, ~62 km a side** (a climate
   cell's size), aligned to the macro grid, and level 2 aims at ~120 m
   spacing (the "128K" of design/adaptive-mesh.md) as the floor. A
   2048 × 1024 world holds 256 × 128 = 32 768 tiles. Measured 2026-09-30
   on a saved world with 12 % land (4 078 land tiles; its level 1: 2.7 M
   nodes, 20 s, 54 MB): a mountain tile (1 700–3 400 m) 48 000 nodes at
   a mean edge of 300 m, a plain 19 000 at 510 m; ~2 s a job at 12
   rounds, ~0.95 GB peak (most of it level 1 read whole), 0.7–1.7 MB an
   artifact. The density rule reads level 1's relief, which is smoother
   than the tile's own, so the 125 m floor is rarely reached.

3. **Seams: world-wide node placement, a halo, and a pinned edge line.**
   - New nodes are placed by a rule of their POSITION, the same for the
     whole world, not per tile: two neighbours generate the same nodes
     where they overlap, and so the same triangles. This is what spares
     the constrained Delaunay triangulation the code does not have.
   - Each tile computes over itself plus a halo (about one macro cell)
     and keeps only its interior. The halo makes the triangulation and
     the flow directions at the edge right; it is not output.
   - **Only the edge line is pinned** — one row of nodes, at the parent
     surface (level 1 plus the same synthesis). Both neighbours therefore
     hold the same height on their shared edge; the interior erodes up to
     it, the edge acting as a fixed level water leaves by, or enters by
     with level 1's discharge. The seam closes; the slope may kink there
     slightly.
   - Rejected: a pinned band (no fresh detail across it, a visible line
     every 62 km) and blending the overlap between neighbours (detail
     everywhere, but a tile's ground would depend on its neighbour's job,
     which breaks the tile as a function of parent, tile id and seed —
     ordering one tile alone, in any order, would no longer be clean).

4. **The network is frozen.** A river crossing the edge enters with level
   1's discharge; the tile reshapes hillslopes and gully heads, not the
   network.

5. **One artifact per tile**, stage `L2:x,y` (the tile's column and row).
   The artifact window counts a world's tiles.

6. **Ordered one tile at a time from the Finishing step** ("refine a
   region": pick a tile on the map), which needs the world's level 1.
   All land tiles as one batch comes later.

7. **The tile's transient duration** is a parameter from the parents'
   age; fixed at first, measured when built.

## How the seam holds (as built)

The tile's mesh (`client/src/generator/mesh/meshTile.ts`) does without a
constrained triangulation:

- The edge line is a row of nodes at a fixed step (512 a side, ~122 m),
  and no other node stands within 0.55 of a step of it. The circle on each
  step as a diameter is then empty, so every step is a Delaunay edge and
  no triangle crosses the line: the triangles inside a tile depend only
  on the points inside it and on the row.
- The new nodes come from a jittered grid per placement level, hashed by
  the global cell, accepted where the density rule (at budget 1/16, read
  from the parent surface) asks for that spacing or finer.
- The window is triangulated as a small torus of its own; its wrap-around
  triangles lie in the halo.
- Positions are put on a world grid of 2^-20 cells before they enter the
  float32 mesh, so a node is the same number in any tile's frame.

`npm run harness:mesh` checks that two neighbours share the edge nodes at
the same heights, every step of the line is an edge, a wider halo changes
no triangle inside the tile, and the same holds across the world's seam.

The tile's bake (`client/src/generator/pipeline/meshTileBake.ts`) freezes
the halo and PINS the edge row: the engine's `pinnedZ` holds a node at a
height through every iteration and makes it a seed of the flood, so the
tile drains over its edge. A level-1 river that crosses the edge inward
adds its discharge to the drainage weight of the first node inside. The
water weights are normalised by the world's mean land water, not the
tile's, so that discharge is in the engine's unit.

Two engine consequences, both general:

- A water component that touches no frozen node is no longer taken for
  the ocean when pinned seeds exist — on a tile it is a depression.
- The flood keeps a flooded node strictly above the level it was reached
  from in float32. At the tile's reach length (1/64 cell) the step of
  1e-7 per cell vanished in float32 above ~270 m, and lake surfaces came
  out level with no receiver. The raster cannot meet the case; the macro
  mesh only on flats above ~4 500 m.

The tile as a job and an artifact (2026-09-30):

- The request is stage 2 with a tile scope,
  `{"worldUid": …, "stage": 2, "scope": {"kind": "tile", "x": …, "y": …}}`;
  the jobs module hands the worker `tile: {x, y}` and names the result
  `L2:x,y`. Stage 1 stays the whole world; each stage accepts only its
  own scope.
- The worker reads the world's level 1 from the artifact store it writes
  to (same rounds, same pipeline version) and fails with a message when
  it is not there: a tile needs its level 1 first.
- The artifact (`world/meshTileArtifacts.ts`) holds the tile's inside
  only — the edge row, the nodes within it and their triangles, positions
  in cells from the tile's corner. Not the periodic codec: a tile has a
  boundary. Its pipeline version carries level 1's constants, the rounds
  and every constant of the tile (`TILE_CONSTANTS`).
- The artifact window counts a world's tiles on its L2 chip.

Where the ladder may go next — level 1 as a replayed history, more tile
levels, a coordinator for the tiles: [design/tile-coordinator.md](../design/tile-coordinator.md).
