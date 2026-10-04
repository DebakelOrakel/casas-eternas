import { torusDomain } from '../core/domain'
import { wrapValue } from '../core/field'
import { METERS_PER_CELL } from '../core/mapConfig'
import { ELEVATION_METERS } from '../elevation/elevationScale'
import { localReliefAt } from '../surface/amplify'
import { hilbertOrder } from './hilbert'
import { hexLattice } from './lattice'
import { targetSpacingM } from './meshDensity'
import { levelSynthesis } from './meshRefine'
import { reliefAt } from './meshRelief'
import type { DenseRegion, MeshSampler } from './meshSampler'
import { compactMesh, permute } from './meshSerial'
import type { PeriodicTriangulation } from './periodicDelaunay'
import { barycentric } from './remesh'

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
// The density rule is the one of meshDensity.ts at the level's budget, evaluated
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

// A level's node is accepted where step · ACCEPT ≥ target: the finest
// accepted step then lies between 0.8 and 1.6 targets.
const ACCEPT = 1.25
// A node's jitter within its cell, as a fraction of the step either way.
// ±0.25 keeps two nodes of one level at least half a step apart.
const JITTER = 0.25
// No node but the edge row within this fraction of the edge step of an
// edge line: over half the longest step, so every diametral circle of the
// row is empty.
// A step of the jittered row is up to 1 + 2 · EDGE_JITTER steps long, so
// its diametral circle reaches 0.75 of a step from the line.
const EDGE_JITTER = 0.25
const CLEAR_FRACTION = 0.8

// Node positions are float32 in the mesh (periodicDelaunay rounds on
// insert), in the TILE'S frame — so a node would round differently in two
// frames, and a wider halo would move every node by a float32 step. Every
// position is therefore put on a world grid of TileSpec.quantum cells
// first (2^-20, 7 mm, for L3): a multiple of it minus the frame's
// whole-cell origin is exact in float32 up to 2^24 quanta (16 cells at
// 2^-20), so the node is the same point in any frame.
const maxSide = (spec: TileSpec): number => 16_777_216 * spec.quantum
const quantise = (v: number, spec: TileSpec): number => Math.round(v / spec.quantum) * spec.quantum
// Hash salts of the edge row's offsets, apart from the placement levels'.
const EDGE_SALT_ROW = 101
const EDGE_SALT_COL = 102
// The placement hashes' salt per level, so two levels' grids that meet
// at one step do not place the same nodes.
const LEVEL_SALT = 64

// Every number that shapes a level's tile, for the tile artifact's
// pipeline version (world/meshTileArtifacts.ts): a change to any of them
// is a different tile.
export function tileConstants(spec: TileSpec): Record<string, number> {
  return {
    tileCells: spec.cells,
    tileOffset: spec.offset,
    tileHaloCells: spec.halo,
    tileEdgeSteps: spec.edgeSteps,
    tileBudget: spec.budget,
    tileLevel: spec.level,
    tileQuantum: spec.quantum,
    tileLevelSalt: LEVEL_SALT,
    // Every placement level, not its two ends (2026-10-01): a level added
    // or removed between them changed the tile under the same key.
    ...Object.fromEntries(spec.placementLevels.map((level, i) => [`tilePlacement${i}`, level])),
    tileEdgeSaltRow: EDGE_SALT_ROW,
    tileEdgeSaltCol: EDGE_SALT_COL,
    tileAccept: ACCEPT,
    tileJitter: JITTER,
    tileEdgeJitter: EDGE_JITTER,
    tileClearFraction: CLEAR_FRACTION,
    // The inflow at every edge node from upstream tiles (detail-ladder.md
    // step 5): 1. A change to how water crosses is a different tile.
    tileInflowModel: 1,
  }
}

export const TILE_ROLE_NEW = 0
export const TILE_ROLE_PARENT = 1
export const TILE_ROLE_EDGE = 2
export const TILE_ROLE_HALO = 3

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

// The parent level as the tile reads it. For level 2 the WHOLE level-1
// mesh, because the parent surface on the edge line must be the same in
// both tiles that share it, and a window of the parent would triangulate
// differently at its border. For level 3 the level-2 tiles the tile
// overlaps, joined (tileParentFromTiles): their union triangulates as
// each tile did inside, its edge rows being edges in both neighbours.
export interface TileParent {
  mesh: PeriodicTriangulation
  z: Float32Array
  // Per node m³/s; the density rule's discharge term. Null: inert.
  discharge: Float32Array | null
  sampler: MeshSampler
  // The global level the synthesis reads its relief from: the relief looks
  // ~32 cells around (amplify.localReliefAt), past any patch of tiles —
  // level 1 for every tile level, so neighbours read the same relief.
  macro: MeshSampler
}

// The tiles of the level above that a tile with its halo overlaps — its
// patchwork parent (detail-ladder.md step 5): one to four, the grids being
// staggered.
export function parentTilesOf(tile: TileId, parentSpec: TileSpec, width: number, height: number): TileId[] {
  const spec = tileSpec(tile.level)
  const corner = tileCorner(tile, spec)
  const { cols, rows } = tileGrid(width, height, parentSpec)
  const span = (start: number, count: number): number[] => {
    const first = Math.floor((start - spec.halo - parentSpec.offset) / parentSpec.cells)
    const last = Math.floor((start + spec.cells + spec.halo - parentSpec.offset - 1e-9) / parentSpec.cells)
    const out: number[] = []
    for (let i = first; i <= last; i++) out.push(((i % count) + count) % count)
    return [...new Set(out)]
  }
  const out: TileId[] = []
  for (const y of span(corner.y, rows)) for (const x of span(corner.x, cols)) out.push({ level: parentSpec.level, x, y })
  return out
}

// A tile's inside as a parent piece: its nodes in cells from its corner,
// its heights (the tile artifact's, world/meshTileArtifacts.ts).
export interface TilePiece {
  tile: TileId
  count: number
  nodes: Float32Array
  z: Float32Array
}

// The patchwork parent's mesh: the pieces' nodes in world positions, a
// node on a shared edge row once, triangulated on the world's torus (the
// empty rest of the world is spanned by long triangles no tile reads).
// Answers the region the pieces cover too, with their node count: the
// sampler's dense hint grid (meshSampler.ts, DenseRegion).
export function tileParentFromTiles(pieces: TilePiece[], width: number, height: number): { mesh: PeriodicTriangulation; z: Float32Array; region: DenseRegion } {
  const seen = new Map<string, number>()
  const xs: number[] = []
  const ys: number[] = []
  const zs: number[] = []
  for (const piece of pieces) {
    const corner = tileCorner(piece.tile, tileSpec(piece.tile.level))
    for (let i = 0; i < piece.count; i++) {
      const x = wrapValue(corner.x + piece.nodes[2 * i], width)
      const y = wrapValue(corner.y + piece.nodes[2 * i + 1], height)
      const key = `${x},${y}`
      if (seen.has(key)) continue
      seen.set(key, xs.length)
      xs.push(x)
      ys.push(y)
      zs.push(piece.z[i])
    }
  }
  const order = hilbertOrder(xs, ys, xs.length, width, height)
  const ox = new Float64Array(xs.length)
  const oy = new Float64Array(xs.length)
  for (let n = 0; n < xs.length; n++) {
    ox[n] = xs[order[n]]
    oy[n] = ys[order[n]]
  }
  // Into the bootstrap lattice, the lattice removed after; a point that
  // lands on a lattice node (tile corners sit on its grid) is inserted
  // again once the lattice is gone, as buildTileMesh does. Not compacted:
  // the codec's canonical rebuild cannot take the long triangles across
  // the empty world; a reader walks the live slots.
  const mesh = hexLattice(torusDomain(width, height), PATCH_LATTICE_CELLS)
  const latticeCount = mesh.vertexSlots
  const mapping = new Int32Array(xs.length)
  const again: number[] = []
  for (let n = 0; n < xs.length; n++) {
    mapping[n] = mesh.insert(ox[n], oy[n])
    if (mapping[n] < latticeCount) again.push(n)
  }
  // The lattice goes FARTHEST FROM THE PIECES FIRST. In index order each
  // removal left a longer fan across the emptied rows for the next, ~0.6 s
  // for a median level-3 tile's 9 500 nodes, two thirds of its bake; far
  // first keeps the stars small (~80 % less), leaves shorter edges across
  // the empty world, and the pieces' triangles come out the same — the
  // tiles byte for byte (2026-10-04, Calvessor, 60 tiles).
  const region = piecesBounds(pieces, width, height)
  const cx = region.x + region.width / 2
  const cy = region.y + region.height / 2
  const lattice: number[] = []
  const away = new Float64Array(latticeCount)
  for (let v = 0; v < latticeCount; v++) {
    const dx = mesh.domain.deltaX(mesh.vx[v], cx)
    const dy = mesh.domain.deltaY(mesh.vy[v], cy)
    away[v] = dx * dx + dy * dy
    lattice.push(v)
  }
  lattice.sort((a, b) => away[b] - away[a] || a - b)
  for (const v of lattice) if (mesh.vAlive[v]) mesh.remove(v)
  for (const n of again) mapping[n] = mesh.insert(ox[n], oy[n])
  const z = new Float32Array(mesh.vertexSlots)
  for (let n = 0; n < xs.length; n++) z[mapping[n]] = zs[order[n]]
  return { mesh, z, region: { ...region, nodes: xs.length } }
}

// The square the pieces cover, from the first piece's corner, on the torus:
// the pieces are neighbours, so each lies within half a period of the first.
function piecesBounds(pieces: TilePiece[], width: number, height: number): { x: number; y: number; width: number; height: number } {
  const first = tileCorner(pieces[0].tile, tileSpec(pieces[0].tile.level))
  let minX = 0
  let minY = 0
  let maxX = 0
  let maxY = 0
  for (const piece of pieces) {
    const spec = tileSpec(piece.tile.level)
    const corner = tileCorner(piece.tile, spec)
    const dx = wrapValue(corner.x - first.x + width / 2, width) - width / 2
    const dy = wrapValue(corner.y - first.y + height / 2, height) - height / 2
    minX = Math.min(minX, dx)
    minY = Math.min(minY, dy)
    maxX = Math.max(maxX, dx + spec.cells)
    maxY = Math.max(maxY, dy + spec.cells)
  }
  return { x: wrapValue(first.x + minX, width), y: wrapValue(first.y + minY, height), width: maxX - minX, height: maxY - minY }
}

// The bootstrap lattice's spacing for a patchwork, in cells: coarse, the
// lattice only holds the world's empty rest until the pieces are in.
const PATCH_LATTICE_CELLS = 16

export interface TileOptions {
  // The world's detail seed (the save's).
  seed: number
  // The macro raster's size in cells.
  width: number
  height: number
  // The halo in macro cells; the spec's unless a check varies it.
  halo?: number
}

export interface TileMesh {
  tile: TileId
  // The local frame: node (x, y) of `mesh` is world point
  // (originX + x, originY + y), wrapped. The mesh's domain is the tile
  // plus its halo on either side, as a torus of its own.
  originX: number
  originY: number
  halo: number
  mesh: PeriodicTriangulation
  // Heights before erosion, elevation units.
  z: Float32Array
  // TILE_ROLE_* per node.
  role: Uint8Array
}

export function buildTileMesh(parent: TileParent, tile: TileId, options: TileOptions): TileMesh {
  const { width, height, seed } = options
  const spec = tileSpec(tile.level)
  const halo = options.halo ?? spec.halo
  const side = spec.cells + 2 * halo
  if (side >= maxSide(spec)) throw new Error(`a tile's halo of ${halo} cells is past the float32-exact frame`)
  const corner = tileCorner(tile, spec)
  const originX = corner.x - halo
  const originY = corner.y - halo
  const lo = halo
  const hi = halo + spec.cells
  const step = spec.cells / spec.edgeSteps
  const q = (v: number): number => quantise(v, spec)
  const clear = CLEAR_FRACTION * step
  const inClear = (x: number, y: number): boolean =>
    Math.abs(x - lo) < clear || Math.abs(x - hi) < clear || Math.abs(y - lo) < clear || Math.abs(y - hi) < clear
  const inside = (x: number, y: number): boolean => x > lo && x < hi && y > lo && y < hi
  const toWorldX = (x: number): number => wrapValue(originX + x, width)
  const toWorldY = (y: number): number => wrapValue(originY + y, height)

  const surface = parentSurface(parent, options, spec)
  const xs: number[] = []
  const ys: number[] = []
  const zs: number[] = []
  const roles: number[] = []
  const add = (x: number, y: number, z: number, role: number): void => {
    xs.push(x)
    ys.push(y)
    zs.push(z)
    roles.push(role)
  }

  // The edge line: the four sides, each corner once. A node's offset along
  // its line comes from the line (its column or row of tiles, wrapped) and
  // its step counted from the world's origin — what the tile across the
  // line counts too.
  const { cols, rows } = tileGrid(width, height, spec)
  const steps = spec.edgeSteps
  const along = (line: number, first: number, k: number, salt: number, count: number): number => {
    const global = (((first * steps + k) % (count * steps)) + count * steps) % (count * steps)
    const offset = global % steps === 0 ? 0 : EDGE_JITTER * (2 * hash01(line, global, salt + LEVEL_SALT * spec.level, seed) - 1)
    return q((k + offset) * step)
  }
  const rowLine = (ty: number): number => ((ty % rows) + rows) % rows
  const colLine = (tx: number): number => ((tx % cols) + cols) % cols
  const addEdge = (x: number, y: number): void => add(x, y, surface.synthesisedAt(toWorldX(x), toWorldY(y)), TILE_ROLE_EDGE)
  for (let k = 0; k < steps; k++) {
    addEdge(lo + along(rowLine(tile.y), tile.x, k, EDGE_SALT_ROW, cols), lo)
    addEdge(hi, lo + along(colLine(tile.x + 1), tile.y, k, EDGE_SALT_COL, rows))
    addEdge(lo + along(rowLine(tile.y + 1), tile.x, k + 1, EDGE_SALT_ROW, cols), hi)
    addEdge(lo, lo + along(colLine(tile.x), tile.y, k + 1, EDGE_SALT_COL, rows))
  }

  // The occupancy grid the placement tests against: the parents first,
  // then each level's accepted nodes after the level (a level is tested
  // against the coarser ones only, so its own order does not matter).
  const levels = spec.placementLevels
  const grid = new PointGrid(side, levels.length > 0 ? stepOf(levels[levels.length - 1], spec) * 2 : 1)

  // The parent nodes in the window.
  for (let v = 0; v < parent.mesh.vertexSlots; v++) {
    if (!parent.mesh.vAlive[v]) continue
    const x = wrapValue(q(parent.mesh.vx[v]) - originX, width)
    const y = wrapValue(q(parent.mesh.vy[v]) - originY, height)
    if (x >= side || y >= side || inClear(x, y)) continue
    add(x, y, parent.z[v], inside(x, y) ? TILE_ROLE_PARENT : TILE_ROLE_HALO)
    grid.add(x, y)
  }

  // The new nodes, level by level.
  for (const level of levels) {
    const s = stepOf(level, spec)
    const cols = Math.round(width / s)
    const rows = Math.round(height / s)
    const i0 = Math.floor(originX / s)
    const j0 = Math.floor(originY / s)
    const i1 = Math.ceil((originX + side) / s)
    const j1 = Math.ceil((originY + side) / s)
    const accepted: number[] = []
    for (let j = j0; j < j1; j++) {
      const jw = ((j % rows) + rows) % rows
      for (let i = i0; i < i1; i++) {
        const iw = ((i % cols) + cols) % cols
        // The world position from the WRAPPED cell, so a node is the
        // same number whichever side of the world's seam a frame reaches
        // it from; then into the frame.
        const salt = 2 * level + LEVEL_SALT * spec.level
        const x = wrapValue(q((iw + 0.5 + JITTER * (2 * hash01(iw, jw, salt, seed) - 1)) * s) - originX, width)
        const y = wrapValue(q((jw + 0.5 + JITTER * (2 * hash01(iw, jw, salt + 1, seed) - 1)) * s) - originY, height)
        if (x < 0 || y < 0 || x >= side || y >= side || inClear(x, y)) continue
        const wx = toWorldX(x)
        const wy = toWorldY(y)
        if (s * ACCEPT < surface.targetAt(wx, wy)) continue
        if (grid.near(x, y, s / 2)) continue
        add(x, y, surface.synthesisedAt(wx, wy), inside(x, y) ? TILE_ROLE_NEW : TILE_ROLE_HALO)
        accepted.push(x, y)
      }
    }
    for (let a = 0; a < accepted.length; a += 2) grid.add(accepted[a], accepted[a + 1])
  }

  // The triangulation, the points inserted in Hilbert order.
  const count = xs.length
  const domain = torusDomain(side, side)
  const order = hilbertOrder(xs, ys, count, side, side)
  const ox = new Float64Array(count)
  const oy = new Float64Array(count)
  for (let n = 0; n < count; n++) {
    ox[n] = xs[order[n]]
    oy[n] = ys[order[n]]
  }
  // Inserted into the bootstrap lattice, the lattice removed after — as
  // meshBuild.triangulatePoints does, but a point that lands exactly on a
  // lattice node (the edge row sits on a 1/64 grid, which the lattice can
  // meet) is inserted again once the lattice is gone, instead of vanishing
  // with the lattice node it collapsed onto.
  const built = hexLattice(domain, stepOf(levels[0], spec))
  const latticeCount = built.vertexSlots
  const mapping = new Int32Array(count)
  const again: number[] = []
  for (let n = 0; n < count; n++) {
    mapping[n] = built.insert(ox[n], oy[n])
    if (mapping[n] < latticeCount) again.push(n)
  }
  for (let v = 0; v < latticeCount; v++) if (built.vAlive[v]) built.remove(v)
  for (const n of again) mapping[n] = built.insert(ox[n], oy[n])
  const slotZ = new Float32Array(built.vertexSlots)
  const slotRole = new Float32Array(built.vertexSlots)
  for (let n = 0; n < count; n++) {
    slotZ[mapping[n]] = zs[order[n]]
    slotRole[mapping[n]] = roles[order[n]]
  }
  const { mesh, order: canonical } = compactMesh(built)
  const z = permute(slotZ, canonical)
  const role = Uint8Array.from(permute(slotRole, canonical))
  return { tile, originX, originY, halo, mesh, z, role }
}

// A tile's node as a world point.
export function tileWorldX(tile: TileMesh, x: number, width: number): number {
  return wrapValue(tile.originX + x, width)
}
export function tileWorldY(tile: TileMesh, y: number, height: number): number {
  return wrapValue(tile.originY + y, height)
}

function stepOf(level: number, spec: TileSpec): number {
  return spec.cells / (1 << level)
}

// The parent surface at a world point: its height plus the level's
// synthesis, and the density rule's target spacing (in cells) from the
// parent nodes' relief and discharge. Both are memoised where they are
// costly — the relief per macro cell, the target per parent node.
function parentSurface(parent: TileParent, options: TileOptions, spec: TileSpec): { synthesisedAt(x: number, y: number): number; targetAt(x: number, y: number): number } {
  const { width, height } = options
  const { mesh, z, discharge, sampler } = parent
  const cellHeight = new Map<number, number>()
  const heightOfCell = (cx: number, cy: number): number => {
    const key = cy * width + cx
    let h = cellHeight.get(key)
    if (h === undefined) {
      h = parent.macro.heightAt(cx, cy)
      cellHeight.set(key, h)
    }
    return h
  }
  const cellRelief = new Map<number, number>()
  const reliefOfCell = (cx: number, cy: number): number => {
    const key = cy * width + cx
    let r = cellRelief.get(key)
    if (r === undefined) {
      r = localReliefAt(heightOfCell, cx, cy, width, height)
      cellRelief.set(key, r)
    }
    return r
  }
  // Bilinear over the relief cells, as core/field.sampleBilinearGrid reads
  // the level-1 refinement's relief raster.
  const reliefPoint = (x: number, y: number): number => {
    const x0 = Math.floor(x)
    const y0 = Math.floor(y)
    const x1 = (x0 + 1) % width
    const y1 = (y0 + 1) % height
    const tx = x - x0
    const ty = y - y0
    const top = reliefOfCell(x0, y0) * (1 - tx) + reliefOfCell(x1, y0) * tx
    const bottom = reliefOfCell(x0, y1) * (1 - tx) + reliefOfCell(x1, y1) * tx
    return top * (1 - ty) + bottom * ty
  }
  const synthesise = levelSynthesis({ seed: options.seed, level: spec.level, budget: spec.budget, width, height }, reliefPoint)

  const targets = new Map<number, number>()
  const relief = new Float64Array(2)
  const targetOfNode = (v: number): number => {
    let h = targets.get(v)
    if (h === undefined) {
      reliefAt(mesh, z, v, METERS_PER_CELL, ELEVATION_METERS, relief)
      h = targetSpacingM(relief[0], discharge ? discharge[v] : 0, relief[1], 0, z[v] * ELEVATION_METERS, spec.budget) / METERS_PER_CELL
      targets.set(v, h)
    }
    return h
  }
  const bary = new Float64Array(3)
  return {
    synthesisedAt: (x, y) => synthesise(x, y, sampler.heightAt(x, y)),
    targetAt(x, y) {
      const t = sampler.triangleAt(x, y)
      barycentric(mesh, t, x, y, bary)
      return bary[0] * targetOfNode(mesh.tris[3 * t]) + bary[1] * targetOfNode(mesh.tris[3 * t + 1]) + bary[2] * targetOfNode(mesh.tris[3 * t + 2])
    },
  }
}

// A position hash in [0, 1): the global cell (i, j), a salt and the seed.
function hash01(i: number, j: number, salt: number, seed: number): number {
  let h = (seed ^ Math.imul(i, 0x27d4eb2d) ^ Math.imul(j, 0x165667b1) ^ Math.imul(salt, 0x9e3779b1)) | 0
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

// Points in buckets over the local square, for "is anything within r".
class PointGrid {
  private readonly n: number
  private readonly size: number
  private readonly buckets = new Map<number, number[]>()

  constructor(side: number, size: number) {
    this.size = size
    this.n = Math.ceil(side / size)
  }

  add(x: number, y: number): void {
    const key = Math.floor(y / this.size) * this.n + Math.floor(x / this.size)
    let bucket = this.buckets.get(key)
    if (!bucket) {
      bucket = []
      this.buckets.set(key, bucket)
    }
    bucket.push(x, y)
  }

  near(x: number, y: number, r: number): boolean {
    const r2 = r * r
    const c0 = Math.max(0, Math.floor((x - r) / this.size))
    const c1 = Math.min(this.n - 1, Math.floor((x + r) / this.size))
    const d0 = Math.max(0, Math.floor((y - r) / this.size))
    const d1 = Math.min(this.n - 1, Math.floor((y + r) / this.size))
    for (let d = d0; d <= d1; d++) {
      for (let c = c0; c <= c1; c++) {
        const bucket = this.buckets.get(d * this.n + c)
        if (!bucket) continue
        for (let k = 0; k < bucket.length; k += 2) {
          const dx = bucket[k] - x
          const dy = bucket[k + 1] - y
          if (dx * dx + dy * dy < r2) return true
        }
      }
    }
    return false
  }
}
