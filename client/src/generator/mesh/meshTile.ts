import { torusDomain, type Domain } from '../core/domain'
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
export const ACCEPT = 1.25
// A node's jitter within its cell, as a fraction of the step either way.
// ±0.25 keeps two nodes of one level at least half a step apart.
export const JITTER = 0.25
// No node but the edge row within this fraction of the edge step of an
// edge line: over half the longest step, so every diametral circle of the
// row is empty.
// A step of the jittered row is up to 1 + 2 · EDGE_JITTER steps long, so
// its diametral circle reaches 0.75 of a step from the line.
export const EDGE_JITTER = 0.25
export const CLEAR_FRACTION = 0.8

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
export const EDGE_SALT_ROW = 101
export const EDGE_SALT_COL = 102
// The placement hashes' salt per level, so two levels' grids that meet
// at one step do not place the same nodes.
export const LEVEL_SALT = 64

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
    // A bootstrap lattice node left in the mesh is a node with its height,
    // role and world point (buildTileMeshOn), since 2026-10-17.
    tileLatticeNodes: 1,
    // The patchwork's points rounded to float32 before they are inserted
    // (tileParentFromTiles), since 2026-10-17.
    tilePatchRounded: 1,
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
  const world = torusDomain(width, height)
  const seen = new Map<string, number>()
  const xs: number[] = []
  const ys: number[] = []
  const zs: number[] = []
  for (const piece of pieces) {
    const corner = tileCorner(piece.tile, tileSpec(piece.tile.level))
    for (let i = 0; i < piece.count; i++) {
      // Where the triangulation will store it (float32): a point is found
      // where it is passed, and one passed a hair from a lattice node that
      // rounds onto it became a second node at the same place, which no
      // removal next to it survives (2026-10-17, a level-3 tile of a flat
      // world: "the link polygon has no ear").
      const x = Math.fround(world.wrapX(corner.x + piece.nodes[2 * i]))
      const y = Math.fround(world.wrapY(corner.y + piece.nodes[2 * i + 1]))
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
  const mesh = hexLattice(world, PATCH_LATTICE_CELLS)
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
  const region = piecesBounds(pieces, world)
  const cx = region.x + region.width / 2
  const cy = region.y + region.height / 2
  const lattice: number[] = []
  const away = new Float64Array(latticeCount)
  const offset = { x: 0, y: 0 }
  for (let v = 0; v < latticeCount; v++) {
    mesh.domain.delta(mesh.vx[v], mesh.vy[v], cx, cy, offset)
    const dx = offset.x
    const dy = offset.y
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
function piecesBounds(pieces: TilePiece[], world: Domain): { x: number; y: number; width: number; height: number } {
  const { width, height } = world
  const first = tileCorner(pieces[0].tile, tileSpec(pieces[0].tile.level))
  let minX = 0
  let minY = 0
  let maxX = 0
  let maxY = 0
  for (const piece of pieces) {
    const spec = tileSpec(piece.tile.level)
    const corner = tileCorner(piece.tile, spec)
    const dx = world.wrapX(corner.x - first.x + width / 2) - width / 2
    const dy = world.wrapY(corner.y - first.y + height / 2) - height / 2
    minX = Math.min(minX, dx)
    minY = Math.min(minY, dy)
    maxX = Math.max(maxX, dx + spec.cells)
    maxY = Math.max(maxY, dy + spec.cells)
  }
  return { x: world.wrapX(first.x + minX), y: world.wrapY(first.y + minY), width: maxX - minX, height: maxY - minY }
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
  // The local frame of a torus tile: node (x, y) of `mesh` is world point
  // (originX + x, originY + y), wrapped. The mesh's domain is the tile
  // plus its halo on either side, as a torus of its own. NaN on the
  // sphere, whose frame is the tile's plane (meshTileCube.ts).
  originX: number
  originY: number
  halo: number
  mesh: PeriodicTriangulation
  // Heights before erosion, elevation units.
  z: Float32Array
  // TILE_ROLE_* per node.
  role: Uint8Array
  // Each node's world point (the chart, one macro cell per unit).
  worldX: Float64Array
  worldY: Float64Array
  // How the tile lies on the world.
  site: TileSite
}

// WHERE A TILE LIES (docs/decisions/sphere-tiles.md, fork 10): its local
// frame and the rules that place its nodes, for one shape. The torus's is
// below (torusSite); the sphere's is meshTileCube.ts. buildTileMeshOn is
// the one builder over either.
export interface TileSite {
  readonly kind: 'torus' | 'cube'
  readonly tile: TileId
  readonly spec: TileSpec
  readonly halo: number
  // The frame's side: the local mesh is a torus of side × side, the tile
  // and its halo inside it.
  readonly side: number
  // The triangulation's own domain over the frame.
  localDomain(): Domain
  // Inside the tile (not its edge line, not its halo).
  inside(x: number, y: number): boolean
  // Within the clear strip of an edge line.
  inClear(x: number, y: number): boolean
  // The edge line's nodes: local point and world point, each corner once.
  edgeRow(emit: (x: number, y: number, wx: number, wy: number) => void): void
  // The parent's nodes in the frame, the clear strip left out.
  parentNodes(parent: TileParent, emit: (x: number, y: number, v: number) => void): void
  // A placement level's candidates in the frame (its grid of step `s`,
  // jittered), the clear strip left out: local point and world point.
  placement(level: number, s: number, emit: (x: number, y: number, wx: number, wy: number) => void): void
  // Frozen nodes for the part of the frame the tile and its halo leave
  // empty (local point and world point), or none: without them the
  // bootstrap lattice cannot be removed there (buildTileMeshOn).
  fill?(emit: (x: number, y: number, wx: number, wy: number) => void): void
  // A node's world point after the triangulation: from its local point as
  // the mesh holds it, or the world point it was placed at (NaN for a
  // node that was not placed: a lattice node left in the mesh).
  worldPoint(x: number, y: number, placedX: number, placedY: number, out: { x: number; y: number }): void
  // The origin of a torus tile's frame (NaN on the sphere).
  readonly originX: number
  readonly originY: number
}

// The torus's site: a square of the macro grid, its grid shifted by the
// spec's offset, the frame the square plus its halo.
export function torusSite(parent: TileParent, tile: TileId, options: TileOptions): TileSite {
  const { width, height, seed } = options
  // The world the parent lies on, one macro cell per unit.
  const world = parent.mesh.domain
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
  const toWorldX = (x: number): number => world.wrapX(originX + x)
  const toWorldY = (y: number): number => world.wrapY(originY + y)
  return {
    kind: 'torus', tile, spec, halo, side, originX, originY,
    localDomain: () => torusDomain(side, side),
    inside,
    inClear,
    edgeRow(emit) {
      // The edge line: the four sides, each corner once. A node's offset
      // along its line comes from the line (its column or row of tiles,
      // wrapped) and its step counted from the world's origin — what the
      // tile across the line counts too.
      const { cols, rows } = tileGrid(width, height, spec)
      const steps = spec.edgeSteps
      // The tiles over the world, and the edge steps along their lines.
      const tiles = world.grid(cols, rows)
      const edgeSteps = world.grid(cols * steps, rows * steps)
      const alongRow = (i: number): number => edgeSteps.wrapCol(i)
      const alongCol = (j: number): number => edgeSteps.wrapRow(j)
      const along = (line: number, first: number, k: number, salt: number, wrapStep: (i: number) => number): number => {
        const global = wrapStep(first * steps + k)
        const offset = global % steps === 0 ? 0 : EDGE_JITTER * (2 * hash01(line, global, salt + LEVEL_SALT * spec.level, seed) - 1)
        return q((k + offset) * step)
      }
      const rowLine = (ty: number): number => tiles.wrapRow(ty)
      const colLine = (tx: number): number => tiles.wrapCol(tx)
      const addEdge = (x: number, y: number): void => emit(x, y, toWorldX(x), toWorldY(y))
      for (let k = 0; k < steps; k++) {
        addEdge(lo + along(rowLine(tile.y), tile.x, k, EDGE_SALT_ROW, alongRow), lo)
        addEdge(hi, lo + along(colLine(tile.x + 1), tile.y, k, EDGE_SALT_COL, alongCol))
        addEdge(lo + along(rowLine(tile.y + 1), tile.x, k + 1, EDGE_SALT_ROW, alongRow), hi)
        addEdge(lo, lo + along(colLine(tile.x), tile.y, k + 1, EDGE_SALT_COL, alongCol))
      }
    },
    parentNodes(parent, emit) {
      for (let v = 0; v < parent.mesh.vertexSlots; v++) {
        if (!parent.mesh.vAlive[v]) continue
        const x = world.wrapX(q(parent.mesh.vx[v]) - originX)
        const y = world.wrapY(q(parent.mesh.vy[v]) - originY)
        if (x >= side || y >= side || inClear(x, y)) continue
        emit(x, y, v)
      }
    },
    placement(level, s, emit) {
      const cols = Math.round(width / s)
      const rows = Math.round(height / s)
      const lattice = world.grid(cols, rows)
      const i0 = Math.floor(originX / s)
      const j0 = Math.floor(originY / s)
      const i1 = Math.ceil((originX + side) / s)
      const j1 = Math.ceil((originY + side) / s)
      for (let j = j0; j < j1; j++) {
        const jw = lattice.wrapRow(j)
        for (let i = i0; i < i1; i++) {
          const iw = lattice.wrapCol(i)
          // The world position from the WRAPPED cell, so a node is the
          // same number whichever side of the world's seam a frame reaches
          // it from; then into the frame.
          const salt = 2 * level + LEVEL_SALT * spec.level
          const x = world.wrapX(q((iw + 0.5 + JITTER * (2 * hash01(iw, jw, salt, seed) - 1)) * s) - originX)
          const y = world.wrapY(q((jw + 0.5 + JITTER * (2 * hash01(iw, jw, salt + 1, seed) - 1)) * s) - originY)
          if (x < 0 || y < 0 || x >= side || y >= side || inClear(x, y)) continue
          emit(x, y, toWorldX(x), toWorldY(y))
        }
      }
    },
    worldPoint(x, y, _placedX, _placedY, out) {
      out.x = world.wrapX(originX + x)
      out.y = world.wrapY(originY + y)
    },
  }
}

export function buildTileMesh(parent: TileParent, tile: TileId, options: TileOptions): TileMesh {
  return buildTileMeshOn(torusSite(parent, tile, options), parent, options)
}

// A tile's mesh on its site: the edge row, the parents, the new nodes level
// by level, triangulated over the frame.
export function buildTileMeshOn(site: TileSite, parent: TileParent, options: TileOptions): TileMesh {
  const { tile, spec, side } = site
  const surface = parentSurface(parent, options, spec)
  const xs: number[] = []
  const ys: number[] = []
  const zs: number[] = []
  const roles: number[] = []
  const wxs: number[] = []
  const wys: number[] = []
  const add = (x: number, y: number, z: number, role: number, wx: number, wy: number): void => {
    xs.push(x)
    ys.push(y)
    zs.push(z)
    roles.push(role)
    wxs.push(wx)
    wys.push(wy)
  }

  site.edgeRow((x, y, wx, wy) => add(x, y, surface.synthesisedAt(wx, wy), TILE_ROLE_EDGE, wx, wy))

  // The occupancy grid the placement tests against: the parents first,
  // then each level's accepted nodes after the level (a level is tested
  // against the coarser ones only, so its own order does not matter).
  const levels = spec.placementLevels
  const grid = new PointGrid(side, levels.length > 0 ? stepOf(levels[levels.length - 1], spec) * 2 : 1)

  // The parent nodes in the window.
  site.parentNodes(parent, (x, y, v) => {
    add(x, y, parent.z[v], site.inside(x, y) ? TILE_ROLE_PARENT : TILE_ROLE_HALO, parent.mesh.vx[v], parent.mesh.vy[v])
    grid.add(x, y)
  })

  // The new nodes, level by level.
  for (const level of levels) {
    const s = stepOf(level, spec)
    const accepted: number[] = []
    site.placement(level, s, (x, y, wx, wy) => {
      if (s * ACCEPT < surface.targetAt(wx, wy)) return
      if (grid.near(x, y, s / 2)) return
      add(x, y, surface.synthesisedAt(wx, wy), site.inside(x, y) ? TILE_ROLE_NEW : TILE_ROLE_HALO, wx, wy)
      accepted.push(x, y)
    })
    for (let a = 0; a < accepted.length; a += 2) grid.add(accepted[a], accepted[a + 1])
  }

  // The empty part of the frame, frozen at level 1's height.
  site.fill?.((x, y, wx, wy) => add(x, y, parent.macro.heightAt(wx, wy), TILE_ROLE_HALO, wx, wy))

  // The triangulation, the points inserted in Hilbert order.
  const count = xs.length
  const domain = site.localDomain()
  const order = hilbertOrder(xs, ys, count, side, side)
  const ox = new Float64Array(count)
  const oy = new Float64Array(count)
  // Where the triangulation will store them (float32), so a point that
  // rounds onto a lattice node is found on it (tileParentFromTiles).
  for (let n = 0; n < count; n++) {
    ox[n] = Math.fround(xs[order[n]])
    oy[n] = Math.fround(ys[order[n]])
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
  // A lattice node the triangulation refuses to remove (its link too
  // long: no point near it, in a sparse sea or, on the sphere before the
  // frame was filled, in the frame's empty part) stays a node. Until
  // 2026-10-17 it kept no height (0, the sea's level, in a deep sea), the
  // role of a new node and on the sphere no world point; now it is one of
  // the tile's nodes like any other: its world point from its local
  // point, the parent surface's height there, inside or halo.
  const survivors: number[] = []
  for (let v = 0; v < latticeCount; v++) if (built.vAlive[v]) survivors.push(v)
  for (const n of again) mapping[n] = built.insert(ox[n], oy[n])
  const slotZ = new Float32Array(built.vertexSlots)
  const slotRole = new Float32Array(built.vertexSlots)
  const slotWX = new Float64Array(built.vertexSlots)
  const slotWY = new Float64Array(built.vertexSlots)
  const slotLattice = new Float32Array(built.vertexSlots)
  for (const v of survivors) {
    slotLattice[v] = 1
    slotWX[v] = Number.NaN
    slotWY[v] = Number.NaN
  }
  for (let n = 0; n < count; n++) {
    slotZ[mapping[n]] = zs[order[n]]
    slotRole[mapping[n]] = roles[order[n]]
    slotWX[mapping[n]] = wxs[order[n]]
    slotWY[mapping[n]] = wys[order[n]]
  }
  const { mesh, order: canonical } = compactMesh(built)
  const z = permute(slotZ, canonical)
  const role = Uint8Array.from(permute(slotRole, canonical))
  const placedX = permute64(slotWX, canonical)
  const placedY = permute64(slotWY, canonical)
  const lattice = survivors.length > 0 ? permute(slotLattice, canonical) : null
  const worldX = new Float64Array(mesh.vertexSlots)
  const worldY = new Float64Array(mesh.vertexSlots)
  const at = { x: 0, y: 0 }
  for (let v = 0; v < mesh.vertexSlots; v++) {
    if (!mesh.vAlive[v]) continue
    site.worldPoint(mesh.vx[v], mesh.vy[v], placedX[v], placedY[v], at)
    worldX[v] = at.x
    worldY[v] = at.y
    if (lattice && lattice[v]) {
      z[v] = surface.synthesisedAt(at.x, at.y)
      role[v] = site.inside(mesh.vx[v], mesh.vy[v]) ? TILE_ROLE_NEW : TILE_ROLE_HALO
    }
  }
  return { tile, originX: site.originX, originY: site.originY, halo: site.halo, mesh, z, role, worldX, worldY, site }
}

// meshSerial.permute for Float64 values.
function permute64(values: Float64Array, order: Int32Array): Float64Array {
  const out = new Float64Array(order.length)
  for (let i = 0; i < order.length; i++) out[i] = values[order[i]]
  return out
}

// A tile's node as a world point (`world`: one macro cell per unit).
export function tileWorldX(tile: TileMesh, x: number, world: Domain): number {
  return world.wrapX(tile.originX + x)
}
export function tileWorldY(tile: TileMesh, y: number, world: Domain): number {
  return world.wrapY(tile.originY + y)
}

export function stepOf(level: number, spec: TileSpec): number {
  return spec.cells / (1 << level)
}

// The parent surface at a world point: its height plus the level's
// synthesis, and the density rule's target spacing (in cells) from the
// parent nodes' relief and discharge. Both are memoised where they are
// costly — the relief per macro cell, the target per parent node.
export function parentSurface(parent: TileParent, options: TileOptions, spec: TileSpec): { synthesisedAt(x: number, y: number): number; targetAt(x: number, y: number): number } {
  const { width, height } = options
  const { mesh, z, discharge, sampler } = parent
  const macroGrid = mesh.domain.grid(width, height)
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
      r = localReliefAt(heightOfCell, cx, cy, macroGrid)
      cellRelief.set(key, r)
    }
    return r
  }
  // Bilinear over the relief cells, as DomainGrid.sampleBilinear reads the
  // level-1 refinement's relief raster.
  const reliefPoint = (x: number, y: number): number => {
    const x0 = Math.floor(x)
    const y0 = Math.floor(y)
    const x1 = macroGrid.wrapCol(x0 + 1)
    const y1 = macroGrid.wrapRow(y0 + 1)
    const tx = x - x0
    const ty = y - y0
    const top = reliefOfCell(x0, y0) * (1 - tx) + reliefOfCell(x1, y0) * tx
    const bottom = reliefOfCell(x0, y1) * (1 - tx) + reliefOfCell(x1, y1) * tx
    return top * (1 - ty) + bottom * ty
  }
  const synthesise = levelSynthesis({ seed: options.seed, level: spec.level, budget: spec.budget, width, height, ...(mesh.domain.kind === 'sphere' ? { sphere: mesh.domain } : {}) }, reliefPoint)

  const targets = new Map<number, number>()
  const relief = new Float64Array(2)
  const unitM = mesh.domain.metresPerUnit
  const targetOfNode = (v: number): number => {
    let h = targets.get(v)
    if (h === undefined) {
      reliefAt(mesh, z, v, unitM, ELEVATION_METERS, relief)
      h = targetSpacingM(relief[0], discharge ? discharge[v] : 0, relief[1], 0, z[v] * ELEVATION_METERS, spec.budget) / unitM
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
export function hash01(i: number, j: number, salt: number, seed: number): number {
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
