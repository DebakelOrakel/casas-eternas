import { type Domain } from '../core/domain'

// A TILE OF A FINE LEVEL (docs/decisions/tile-jobs.md; the levels,
// docs/decisions/detail-ladder.md step 5): the levels below level 1 are not
// refined globally but one tile at a time, each tile a function of the
// parent level, its id and the seed. This file builds a tile's mesh — the
// nodes and their triangulation, with the heights before any erosion. A
// level's tile is a TileSpec (TILE_SPECS); the rules below hold for each.
//
// The seam rule, and what makes it hold without a constrained
// triangulation:
//
// - THE EDGE LINE. Each side of a tile carries a row of nodes at a fixed
//   step (TileSpec.edgeSteps a side), at the parent surface plus the
//   level's synthesis — both functions of position, so the two tiles that
//   share a side put the same nodes at the same heights on it.
// - THE CLEAR STRIP. No other node stands within CLEAR_FRACTION of a step
//   of an edge line. Then the circle on each step of the row as a diameter
//   is empty, so every step is an edge of the Delaunay triangulation (an
//   empty diametral circle makes a Delaunay edge), and no triangle crosses
//   the line. The triangles inside the tile then depend only on the points
//   inside it and on the row: the halo, the neighbour and the wrap-around
//   of the local torus below cannot reach them.
// - THE ROW IS JITTERED along its line (EDGE_JITTER of a step, by a hash of
//   the node's place on the line; the corners stay). On an even row, four
//   nodes near a corner — two on each side — lie on one circle whenever
//   their distances from the corner multiply alike, and a circle through
//   four points is a tie the triangulation breaks by insertion order: a
//   wider halo flipped the diagonal. Measured on the harness tile before
//   the jitter: 6 of 71 056 inside triangles differed.
// - THE NEW NODES. Placed by a rule of their position, the same for the
//   whole world: a jittered grid per placement level (a cell of level k is
//   TileSpec.cells / 2^k macro cells), a node accepted where the density rule
//   asks for that spacing or finer, and dropped where a parent node or a
//   node of a coarser level stands within half the level's step. So a
//   tile's nodes do not depend on the tile — only on where they are.
//
// The triangulation is a small torus over the tile plus its halo: the
// existing periodic triangulation, not a planar one. Its wrap-around
// triangles lie in the halo, which is computed and not kept.
//
// The density rule is the one of the engine's mesh_density.rs at the level's budget, evaluated
// on the PARENT surface (its nodes' relief and discharge, interpolated at
// the point) and not on the tile's own synthesis: the rule refined the
// synthesis roughness when level 1 read its own heights (tile-jobs.md,
// answer 1), and a target from the parent is a function of position.

// A LEVEL'S TILE. Square, aligned to the macro grid, its grid shifted by
// half of its own tile against the level above so that level's seams run
// through the inside of this one's tiles (detail-ladder.md, fork 5; a
// shift by half the PARENT's tile would put them on this level's seams).
export interface TileSpec {
  // The level: its artifact stage and its synthesis seed.
  level: number
  // The tile's side in macro cells.
  cells: number
  // The grid's shift in macro cells: tile (x, y) starts at
  // (x · cells + offset, y · cells + offset).
  offset: number
  // The density budget against the macro mesh (meshBakeStage.levelBudget).
  budget: number
  // The halo around the tile in macro cells: nodes computed and not kept.
  halo: number
  // Nodes per side on the edge line, a power of two so every step is exact.
  edgeSteps: number
  // The placement levels: level k has a step of cells / 2^k cells.
  placementLevels: readonly number[]
  // Every position is put on a world grid of this many cells (see
  // `quantise` below); the frame stays float32-exact up to 2^24 of it.
  quantum: number
}

export const TILE_SPECS: Readonly<Record<number, TileSpec>> = {
  // L2: 16 cells (125 km), budget 1/4 — floor ~500 m. Edge step 1/16 cell
  // (488 m); placement from 2 cells (the deep ocean's spacing at 1/4 is
  // ~10 km) to 1/16. A frame of 18 cells needs the coarser quantum.
  2: { level: 2, cells: 16, offset: 0, budget: 1 / 4, halo: 1, edgeSteps: 256, placementLevels: [3, 4, 5, 6, 7, 8], quantum: 2 ** -18 },
  // L3: the tile of tile-jobs.md — 8 cells (62 km), budget 1/16, floor
  // 125 m (the "128K" of design/adaptive-mesh.md), flat land ~490 m. Edge
  // step 1/64 cell (~122 m); placement from 1/2 cell (3.9 km; the deep
  // ocean's spacing at 1/16 is 2.5 km) to 1/64.
  3: { level: 3, cells: 8, offset: 4, budget: 1 / 16, halo: 1, edgeSteps: 512, placementLevels: [4, 5, 6, 7, 8, 9], quantum: 2 ** -20 },
}

export function tileSpec(level: number): TileSpec {
  const spec = TILE_SPECS[level]
  if (!spec) throw new Error(`level ${level} has no tiles`)
  return spec
}
export const TILE_ROLE_EDGE = 2

// A tile: its level and its column and row on that level's grid.
export interface TileId {
  level: number
  x: number
  y: number
}

// A level's tile grid on a world whose macro raster is width × height.
export function tileGrid(width: number, height: number, spec: TileSpec): { cols: number; rows: number } {
  return { cols: Math.floor(width / spec.cells), rows: Math.floor(height / spec.cells) }
}

// Where a tile starts on the macro grid (its corner, before the halo).
export function tileCorner(tile: TileId, spec: TileSpec): { x: number; y: number } {
  return { x: tile.x * spec.cells + spec.offset, y: tile.y * spec.cells + spec.offset }
}

// The tiles of the level above that a tile with its halo overlaps — its
// patchwork parent (detail-ladder.md step 5): one to four, the grids being
// staggered. `world`: the domain, one macro cell per unit.
export function parentTilesOf(tile: TileId, parentSpec: TileSpec, world: Domain): TileId[] {
  const spec = tileSpec(tile.level)
  const corner = tileCorner(tile, spec)
  const { cols, rows } = tileGrid(world.width, world.height, parentSpec)
  const tiles = world.grid(cols, rows)
  const span = (start: number, wrap: (i: number) => number): number[] => {
    const first = Math.floor((start - spec.halo - parentSpec.offset) / parentSpec.cells)
    const last = Math.floor((start + spec.cells + spec.halo - parentSpec.offset - 1e-9) / parentSpec.cells)
    const out: number[] = []
    for (let i = first; i <= last; i++) out.push(wrap(i))
    return [...new Set(out)]
  }
  const out: TileId[] = []
  for (const y of span(corner.y, (j) => tiles.wrapRow(j))) for (const x of span(corner.x, (i) => tiles.wrapCol(i))) out.push({ level: parentSpec.level, x, y })
  return out
}
