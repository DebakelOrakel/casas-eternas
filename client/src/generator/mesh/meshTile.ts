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
import type { MeshSampler } from './meshSampler'
import { compactMesh, permute } from './meshSerial'
import type { PeriodicTriangulation } from './periodicDelaunay'
import { barycentric } from './remesh'

// THE TILE OF THE TOP LEVEL (docs/decisions/tile-jobs.md): level 2 is not
// refined globally but one tile at a time, each tile a function of the
// parent level, its id and the seed. This file builds a tile's mesh — the
// nodes and their triangulation, with the heights before any erosion.
//
// The seam rule, and what makes it hold without a constrained
// triangulation:
//
// - THE EDGE LINE. Each side of a tile carries a row of nodes at a fixed
//   step (TILE_EDGE_STEPS a side, ~122 m), at the parent surface plus the
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
//   TILE_CELLS / 2^k macro cells), a node accepted where the density rule
//   asks for that spacing or finer, and dropped where a parent node or a
//   node of a coarser level stands within half the level's step. So a
//   tile's nodes do not depend on the tile — only on where they are.
//
// The triangulation is a small torus over the tile plus its halo: the
// existing periodic triangulation, not a planar one. Its wrap-around
// triangles lie in the halo, which is computed and not kept.
//
// The density rule is the one of meshDensity.ts at TILE_BUDGET, evaluated
// on the PARENT surface (its nodes' relief and discharge, interpolated at
// the point) and not on the tile's own synthesis: the rule refined the
// synthesis roughness when level 1 read its own heights (tile-jobs.md,
// answer 1), and a target from the parent is a function of position.

// A tile is TILE_CELLS × TILE_CELLS macro cells, aligned to the macro grid.
export const TILE_CELLS = 8
// The halo around the tile in macro cells: nodes computed and not kept.
export const TILE_HALO_CELLS = 1
// Nodes per side on the edge line: TILE_CELLS / 512 = 1/64 cell, ~122 m
// at 7.8 km a cell, a power of two so every step is exact in floating point.
export const TILE_EDGE_STEPS = 512
// The level's density budget against the macro mesh: 1/16 puts the floor
// at 125 m (the "128K" of design/adaptive-mesh.md) and flat land at
// ~490 m. Not levelBudget(2): level 1 is the one global level and the
// tiles jump three halvings past it.
export const TILE_BUDGET = 1 / 16
// The tile level's number — its synthesis seed and its artifact stage.
export const TILE_LEVEL = 2

// The placement levels: level k has a step of TILE_CELLS / 2^k cells.
// 4 is 3.9 km (the deep ocean's spacing at TILE_BUDGET is 2.5 km), 9 is
// 122 m (the floor, 125 m).
const PLACEMENT_LEVELS = [4, 5, 6, 7, 8, 9]
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
// position is therefore put on a world grid of 2^-20 cells (7 mm) first:
// a multiple of it minus the frame's whole-cell origin is exact in float32
// up to 16 cells, so the node is the same point in any frame.
const POSITION_QUANTUM = 2 ** -20
// Hash salts of the edge row's offsets, apart from the placement levels'.
const EDGE_SALT_ROW = 101
const EDGE_SALT_COL = 102
const MAX_SIDE = 16
const quantise = (v: number): number => Math.round(v / POSITION_QUANTUM) * POSITION_QUANTUM

export const TILE_ROLE_NEW = 0
export const TILE_ROLE_PARENT = 1
export const TILE_ROLE_EDGE = 2
export const TILE_ROLE_HALO = 3

export interface TileId {
  x: number
  y: number
}

// The tile grid of a world whose macro raster is width × height.
export function tileGrid(width: number, height: number): { cols: number; rows: number } {
  return { cols: Math.floor(width / TILE_CELLS), rows: Math.floor(height / TILE_CELLS) }
}

// The parent level as the tile reads it: the WHOLE level-1 mesh, because
// the parent surface on the edge line must be the same in both tiles that
// share it, and a window of the parent would triangulate differently at
// its border.
export interface TileParent {
  mesh: PeriodicTriangulation
  z: Float32Array
  // Per node m³/s; the density rule's discharge term. Null: inert.
  discharge: Float32Array | null
  sampler: MeshSampler
}

export interface TileOptions {
  // The world's detail seed (the save's).
  seed: number
  // The macro raster's size in cells.
  width: number
  height: number
  // The halo in macro cells; TILE_HALO_CELLS unless a check varies it.
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
  const halo = options.halo ?? TILE_HALO_CELLS
  const side = TILE_CELLS + 2 * halo
  if (side >= MAX_SIDE) throw new Error(`a tile's halo of ${halo} cells is past the float32-exact frame`)
  const originX = tile.x * TILE_CELLS - halo
  const originY = tile.y * TILE_CELLS - halo
  const lo = halo
  const hi = halo + TILE_CELLS
  const step = TILE_CELLS / TILE_EDGE_STEPS
  const clear = CLEAR_FRACTION * step
  const inClear = (x: number, y: number): boolean =>
    Math.abs(x - lo) < clear || Math.abs(x - hi) < clear || Math.abs(y - lo) < clear || Math.abs(y - hi) < clear
  const inside = (x: number, y: number): boolean => x > lo && x < hi && y > lo && y < hi
  const toWorldX = (x: number): number => wrapValue(originX + x, width)
  const toWorldY = (y: number): number => wrapValue(originY + y, height)

  const surface = parentSurface(parent, options)
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
  const { cols, rows } = tileGrid(width, height)
  const along = (line: number, first: number, k: number, salt: number, count: number): number => {
    const global = (((first * TILE_EDGE_STEPS + k) % (count * TILE_EDGE_STEPS)) + count * TILE_EDGE_STEPS) % (count * TILE_EDGE_STEPS)
    const offset = global % TILE_EDGE_STEPS === 0 ? 0 : EDGE_JITTER * (2 * hash01(line, global, salt, seed) - 1)
    return quantise((k + offset) * step)
  }
  const rowLine = (ty: number): number => ((ty % rows) + rows) % rows
  const colLine = (tx: number): number => ((tx % cols) + cols) % cols
  const addEdge = (x: number, y: number): void => add(x, y, surface.synthesisedAt(toWorldX(x), toWorldY(y)), TILE_ROLE_EDGE)
  for (let k = 0; k < TILE_EDGE_STEPS; k++) {
    addEdge(lo + along(rowLine(tile.y), tile.x, k, EDGE_SALT_ROW, cols), lo)
    addEdge(hi, lo + along(colLine(tile.x + 1), tile.y, k, EDGE_SALT_COL, rows))
    addEdge(lo + along(rowLine(tile.y + 1), tile.x, k + 1, EDGE_SALT_ROW, cols), hi)
    addEdge(lo, lo + along(colLine(tile.x), tile.y, k + 1, EDGE_SALT_COL, rows))
  }

  // The occupancy grid the placement tests against: the parents first,
  // then each level's accepted nodes after the level (a level is tested
  // against the coarser ones only, so its own order does not matter).
  const grid = new PointGrid(side, PLACEMENT_LEVELS.length > 0 ? stepOf(PLACEMENT_LEVELS[PLACEMENT_LEVELS.length - 1]) * 2 : 1)

  // The parent nodes in the window.
  for (let v = 0; v < parent.mesh.vertexSlots; v++) {
    if (!parent.mesh.vAlive[v]) continue
    const x = wrapValue(quantise(parent.mesh.vx[v]) - originX, width)
    const y = wrapValue(quantise(parent.mesh.vy[v]) - originY, height)
    if (x >= side || y >= side || inClear(x, y)) continue
    add(x, y, parent.z[v], inside(x, y) ? TILE_ROLE_PARENT : TILE_ROLE_HALO)
    grid.add(x, y)
  }

  // The new nodes, level by level.
  for (const level of PLACEMENT_LEVELS) {
    const s = stepOf(level)
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
        const x = wrapValue(quantise((iw + 0.5 + JITTER * (2 * hash01(iw, jw, 2 * level, seed) - 1)) * s) - originX, width)
        const y = wrapValue(quantise((jw + 0.5 + JITTER * (2 * hash01(iw, jw, 2 * level + 1, seed) - 1)) * s) - originY, height)
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
  const built = hexLattice(domain, stepOf(PLACEMENT_LEVELS[0]))
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

function stepOf(level: number): number {
  return TILE_CELLS / (1 << level)
}

// The parent surface at a world point: its height plus the level's
// synthesis, and the density rule's target spacing (in cells) from the
// parent nodes' relief and discharge. Both are memoised where they are
// costly — the relief per macro cell, the target per parent node.
function parentSurface(parent: TileParent, options: TileOptions): { synthesisedAt(x: number, y: number): number; targetAt(x: number, y: number): number } {
  const { width, height } = options
  const { mesh, z, discharge, sampler } = parent
  const cellHeight = new Map<number, number>()
  const heightOfCell = (cx: number, cy: number): number => {
    const key = cy * width + cx
    let h = cellHeight.get(key)
    if (h === undefined) {
      h = sampler.heightAt(cx, cy)
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
  const synthesise = levelSynthesis({ seed: options.seed, level: TILE_LEVEL, budget: TILE_BUDGET, width, height }, reliefPoint)

  const targets = new Map<number, number>()
  const relief = new Float64Array(2)
  const targetOfNode = (v: number): number => {
    let h = targets.get(v)
    if (h === undefined) {
      reliefAt(mesh, z, v, METERS_PER_CELL, ELEVATION_METERS, relief)
      h = targetSpacingM(relief[0], discharge ? discharge[v] : 0, relief[1], 0, z[v] * ELEVATION_METERS, TILE_BUDGET) / METERS_PER_CELL
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
