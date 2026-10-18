import type { Domain, GlobeFrame } from '../../generator/core/domain'
import { detHypot } from '../../generator/core/detMath'
import { project, type CubeAtlas, type TileFrame, type Vec3 } from '../../generator/mesh/cubeAtlas'
import type { MeshSampler } from '../../generator/mesh/meshSampler'
import { tileCorner, tileGrid, tileSpec, type TileId } from '../../generator/mesh/meshTile'
import { cubeAtlasOf, cubeTileOf } from '../../generator/mesh/meshTileCube'
import { tileAtOn } from '../../generator/mesh/tileLayout'
import type { TileSurfaceSampler } from '../../generator/mesh/tileSampler'
import { seamReach, type TileRim } from './groundSeams'

// THE TILE FRAME (docs/decisions/sphere-ground.md, fork 5): where a tile's
// raster lies, and how a world point finds it. The ground source, the
// worker and the seams ask this, not the world's shape.
//
// On the torus a raster lies on the world grid: its corner and its side in
// cells, a world point in it by the wrap (what the incubator always did,
// to the bit). On the sphere it lies on the tile's rectangle of its cube
// face, in the face's gnomonic coordinates (tan ξ, tan η): there the
// tile's sides are the rectangle's, so the raster's first and last rows
// and columns lie ON the sides, as on the torus — and two tiles that
// share a side sample it at the same points, the side being one segment
// of the cube for both (DEC-0041 fork 5). A raster laid square in the
// tile's own plane cut the sides at a slant, and the two tiles' reads at
// a side differed by 1.5 m (median) and 1.4° in the normal (p99) on
// Brannoch's level 2 (2026-10-17). The tile's surface is still read in
// its own plane, where it was triangulated. Level 1's rasters lie on level
// 2's tiles on both shapes.
//
// THE SLOPE a sphere raster holds is the ground's against the LOCAL
// vertical, along the tile's axes laid into the local tangent plane: in
// the tile's plane the vertical is the tangent point's, which at a corner
// of a level-2 tile leans 1.4° from the ground's own, and flat ground read
// there would slope by 2.4 % — the other way in the next tile.

// Level 1's rasters share level 2's tile grid.
export const LEVEL1_GRID_LEVEL = 2

// Where a raster lies: its side (frame units) and its corner on the world
// grid (the torus), or the tile on its cube face (the sphere).
export interface RasterFrame {
  cells: number
  cornerX: number
  cornerY: number
  plane: TilePlane | null
}

export interface TilePlane {
  atlas: CubeAtlas
  // The tile's rectangle on its face: frame x = 0 … cells is s0 … s1.
  face: number
  s0: number
  s1: number
  t0: number
  t1: number
  // The tile's own plane, which its surface is read in: a sampler point
  // is a plane point + half.
  frame: TileFrame
  half: number
}

export interface GroundTiles {
  readonly world: Domain
  // Metres per frame unit.
  readonly metresPerCell: number
  // The point the next tileAt and inFrame read, as a world point.
  at(x: number, y: number): void
  // The tile of `level`'s grid that holds the point.
  tileAt(level: number): TileId
  // The point in a raster's frame (into out.x, out.y), and whether the
  // tile holds it.
  inFrame(frame: RasterFrame, out: { x: number; y: number }): boolean
  // A tile's raster frame (level 1's: of the level-2 tile with its x, y).
  frameOf(tile: TileId): RasterFrame
  // The axes a slope at the point is along, unit 3D vectors: a raster's
  // (the sphere: its tile's axes laid into the tangent plane), or with no
  // frame the point's east and south (the level's mesh sampler). On the
  // torus the world's x and z.
  slopeAxes(frame: RasterFrame | null, t1: number[], t2: number[]): void
  // A tile artifact's nodes as its sampler (tileSampler.ts) reads them,
  // and the side of the square they lie in.
  samplerNodes(frame: RasterFrame, nodes: Float32Array): { nodes: Float32Array; cells: number }
  // A tile's sampler (over samplerNodes) as the raster reads it, at frame
  // points: the sphere's turns its normals to the local vertical.
  rasterSampler(frame: RasterFrame, sampler: TileSurfaceSampler): TileSurfaceSampler
  // Level 1's raster over a frame from the level's mesh: n × n samples, 3
  // floats each (groundRaster.ts).
  rasteriseLevel1(base: MeshSampler, frame: RasterFrame, n: number, out: Float32Array): void
  // The tiles around one, no tile twice.
  neighbours(tile: TileId): TileId[]
  // The key of a node of a neighbour's rim in this tile's terms (the
  // tile's own nodes: from = tile), or null when the rim is the tile's own
  // or wraps onto it.
  rimKey(tile: TileId, from: TileId): ((x: number, y: number) => string) | null
  // A neighbour's normal sum i in this tile's sampler frame, into out.
  rimSum(tile: TileId, rim: TileRim, i: number, out: [number, number, number]): void
  // The raster samples a neighbour's rim can change: a test of frame
  // points, for a tile with these (artifact) nodes and triangles.
  reseamArea(frame: RasterFrame, nodes: Float32Array, triangles: Uint32Array, role: Uint8Array, n: number): (tile: TileId, rim: TileRim) => ((x: number, y: number) => boolean) | undefined
}

// How far a point on a sphere tile's side is moved toward the tangent
// point to land in the tile's triangulation (the plane's units scaled).
const SHRINKS = [1, 1 - 1e-7, 1 - 1e-6, 1 - 1e-5, 1 - 1e-4, 1 - 1e-3]

const gridLevel = (level: number): number => (level === 1 ? LEVEL1_GRID_LEVEL : level)
const wrap = (v: number, n: number): number => ((v % n) + n) % n

export function groundTilesOf(world: Domain): GroundTiles {
  return world.kind === 'sphere' ? sphereTiles(world) : torusTiles(world)
}

// ------------------------------------------------------------- the torus

function torusTiles(world: Domain): GroundTiles {
  const { width, height } = world
  let px = 0
  let py = 0
  // A neighbour's offset in tiles (−1, 0, 1 each), across the wrap.
  const offset = (from: TileId, to: TileId): { dx: number; dy: number } => {
    const { cols, rows } = tileGrid(width, height, tileSpec(from.level))
    const near = (d: number, n: number): number => {
      const m = ((d % n) + n) % n
      return m > n / 2 ? m - n : m
    }
    return { dx: near(to.x - from.x, cols), dy: near(to.y - from.y, rows) }
  }
  return {
    world,
    metresPerCell: world.metresPerUnit,
    at(x, y) {
      px = x
      py = y
    },
    tileAt: (level) => tileAtOn(level, px, py, world),
    inFrame(frame, out) {
      out.x = wrap(px - frame.cornerX, width)
      out.y = wrap(py - frame.cornerY, height)
      return out.x <= frame.cells && out.y <= frame.cells
    },
    frameOf(tile) {
      const spec = tileSpec(gridLevel(tile.level))
      const corner = tileCorner({ level: spec.level, x: tile.x, y: tile.y }, spec)
      return { cells: spec.cells, cornerX: corner.x, cornerY: corner.y, plane: null }
    },
    samplerNodes: (frame, nodes) => ({ nodes, cells: frame.cells }),
    slopeAxes(_frame, t1, t2) {
      t1[0] = 1
      t1[1] = 0
      t1[2] = 0
      t2[0] = 0
      t2[1] = 0
      t2[2] = 1
    },
    rasterSampler: (_frame, sampler) => sampler,
    rasteriseLevel1(base, frame, n, out) {
      const { cells, cornerX, cornerY } = frame
      const step = cells / (n - 1)
      const normal = new Float64Array(3)
      for (let j = 0; j < n; j++) {
        const y = cornerY + j * step
        for (let i = 0; i < n; i++) {
          const x = cornerX + i * step
          const p = (j * n + i) * 3
          out[p] = base.heightAt(x, y)
          base.normalAt(x, y, normal)
          out[p + 1] = normal[1] > 1e-6 ? -normal[0] / normal[1] : 0
          out[p + 2] = normal[1] > 1e-6 ? -normal[2] / normal[1] : 0
        }
      }
    },
    // The eight tiles around one, on the level's grid (which wraps). Fewer
    // where the grid is narrower than three tiles.
    neighbours(tile) {
      const { cols, rows } = tileGrid(width, height, tileSpec(tile.level))
      const seen = new Set<string>([`${tile.x},${tile.y}`])
      const out: TileId[] = []
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = (((tile.x + dx) % cols) + cols) % cols
          const y = (((tile.y + dy) % rows) + rows) % rows
          if (seen.has(`${x},${y}`)) continue
          seen.add(`${x},${y}`)
          out.push({ level: tile.level, x, y })
        }
      }
      return out
    },
    // A node by its position in the tile's own frame: a neighbour's
    // shifted by whole tiles, exact, both being on the level's quantum.
    rimKey(tile, from) {
      if (from === tile) return (x, y) => `${x},${y}`
      const { dx, dy } = offset(tile, from)
      if (dx === 0 && dy === 0) return null
      const cells = tileSpec(tile.level).cells
      return (x, y) => `${x + dx * cells},${y + dy * cells}`
    },
    rimSum(_tile, rim, i, out) {
      out[0] = rim.sums[3 * i]
      out[1] = rim.sums[3 * i + 1]
      out[2] = rim.sums[3 * i + 2]
    },
    // Per side, how far in a change of its edge normals reaches; a corner
    // neighbour reaches the corner's two sides' reach.
    reseamArea(frame, nodes, triangles, role, n) {
      const cells = frame.cells
      const [left, right, bottom, top] = seamReach(nodes, triangles, role, cells)
      const step = cells / (n - 1)
      return (tile, rim) => {
        const { dx, dy } = offset(tile, rim.tile)
        return (x, y) =>
          (dx === 0 || (dx < 0 ? x <= left + step : cells - x <= right + step)) &&
          (dy === 0 || (dy < 0 ? y <= bottom + step : cells - y <= top + step))
      }
    },
  }
}

// ------------------------------------------------------------ the sphere

const dot = (a: ArrayLike<number>, b: ArrayLike<number>): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

// The tile's axes laid into the tangent plane at p (unit): t1 along e1,
// t2 along e2, orthonormal.
function localAxes(frame: TileFrame, p: Vec3, t1: number[], t2: number[]): void {
  const a = dot(frame.e1, p)
  t1[0] = frame.e1[0] - a * p[0]
  t1[1] = frame.e1[1] - a * p[1]
  t1[2] = frame.e1[2] - a * p[2]
  const l1 = detHypot(t1[0], t1[1], t1[2])
  t1[0] /= l1
  t1[1] /= l1
  t1[2] /= l1
  // p × t1 or t1 × p, whichever lies along e2.
  t2[0] = p[1] * t1[2] - p[2] * t1[1]
  t2[1] = p[2] * t1[0] - p[0] * t1[2]
  t2[2] = p[0] * t1[1] - p[1] * t1[0]
  if (dot(t2, frame.e2) < 0) {
    t2[0] = -t2[0]
    t2[1] = -t2[1]
    t2[2] = -t2[2]
  }
}

function sphereTiles(world: Domain): GroundTiles {
  if (world.noise.kind !== 'globe') throw new Error('sphere tiles need a globe')
  const globe = world.noise
  const radius = globe.radius
  const g: GlobeFrame = { px: 0, py: 0, pz: 0, ex: 0, ey: 0, ez: 0, sx: 0, sy: 0, sz: 0 }
  // The point, as a unit direction, and its east and south.
  const p: Vec3 = [0, 0, 1]
  const east = [1, 0, 0]
  const south = [0, 0, 1]
  const at2 = { x: 0, y: 0 }
  const frames = new Map<string, RasterFrame>()
  const idOf = (level: number, atlas: CubeAtlas, face: number, i: number, j: number): TileId => ({ level, x: face * atlas.n + i, y: j })
  const frameOf = (tile: TileId): RasterFrame => {
    const level = gridLevel(tile.level)
    const key = `${level}:${tile.x},${tile.y}`
    let frame = frames.get(key)
    if (!frame) {
      const atlas = cubeAtlasOf(world, level)
      const cube = cubeTileOf(atlas, { level, x: tile.x, y: tile.y })
      // The corners' gnomonic coordinates are exact: a cube corner's
      // components are the TANS table's.
      const lo = atlas.faceTangents(cube.face, atlas.cubeCorner(cube, 0, 0))!
      const hi = atlas.faceTangents(cube.face, atlas.cubeCorner(cube, 1, 1))!
      const plane = atlas.frame(cube, radius)
      let extent = 0
      for (const c of atlas.corners(cube)) {
        project(plane, c, at2)
        extent = Math.max(extent, Math.abs(at2.x), Math.abs(at2.y))
      }
      frame = {
        // The level's tile side: a tile is π / 2n of arc at a face's
        // centre, n = width / 4 / cells (meshTileCube.cubeAtlasOf).
        cells: tileSpec(level).cells,
        cornerX: 0,
        cornerY: 0,
        plane: { atlas, face: cube.face, s0: lo[0], s1: hi[0], t0: lo[1], t1: hi[1], frame: plane, half: extent * (1 + 1e-6) },
      }
      frames.set(key, frame)
    }
    return frame
  }
  // A direction's place in a frame (into out); false off the tile.
  const place = (frame: RasterFrame, d: Vec3, out: { x: number; y: number }): boolean => {
    const pl = frame.plane!
    const st = pl.atlas.faceTangents(pl.face, pl.atlas.toCube(d))
    if (!st) return false
    out.x = ((st[0] - pl.s0) / (pl.s1 - pl.s0)) * frame.cells
    out.y = ((st[1] - pl.t0) / (pl.t1 - pl.t0)) * frame.cells
    return out.x >= 0 && out.y >= 0 && out.x <= frame.cells && out.y <= frame.cells
  }
  // A frame point's direction, the point held to the tile.
  const directionAt = (frame: RasterFrame, x: number, y: number): Vec3 => {
    const pl = frame.plane!
    const fx = Math.min(1, Math.max(0, x / frame.cells))
    const fy = Math.min(1, Math.max(0, y / frame.cells))
    return pl.atlas.faceDirection(pl.face, pl.s0 + fx * (pl.s1 - pl.s0), pl.t0 + fy * (pl.t1 - pl.t0))
  }
  const directionOf = (x: number, y: number): Vec3 => {
    globe.frame(x, y, g)
    const l = detHypot(g.px, g.py, g.pz)
    return [g.px / l, g.py / l, g.pz / l]
  }
  const t1 = [0, 0, 0]
  const t2 = [0, 0, 0]
  return {
    world,
    metresPerCell: world.metresPerUnit,
    at(x, y) {
      globe.frame(x, y, g)
      const l = detHypot(g.px, g.py, g.pz)
      p[0] = g.px / l
      p[1] = g.py / l
      p[2] = g.pz / l
      east[0] = g.ex
      east[1] = g.ey
      east[2] = g.ez
      south[0] = g.sx
      south[1] = g.sy
      south[2] = g.sz
    },
    tileAt(level) {
      const atlas = cubeAtlasOf(world, level)
      const t = atlas.tileAt(p)
      return idOf(level, atlas, t.face, t.i, t.j)
    },
    inFrame: (frame, out) => place(frame, p, out),
    frameOf,
    slopeAxes(frame, a, b) {
      if (frame) {
        localAxes(frame.plane!.frame, p, a, b)
        return
      }
      a[0] = east[0]
      a[1] = east[1]
      a[2] = east[2]
      b[0] = south[0]
      b[1] = south[1]
      b[2] = south[2]
    },
    // In the tile's own plane, where it was triangulated.
    samplerNodes(frame, nodes) {
      const pl = frame.plane!
      const out = new Float32Array(nodes.length)
      for (let i = 0; i < nodes.length; i += 2) {
        project(pl.frame, directionOf(nodes[i], nodes[i + 1]), at2)
        out[i] = at2.x + pl.half
        out[i + 1] = at2.y + pl.half
      }
      return { nodes: out, cells: 2 * pl.half }
    },
    rasterSampler(frame, sampler) {
      const pl = frame.plane!
      const { e1, e2, centre } = pl.frame
      const s = new Float64Array(5)
      const q = { x: 0, y: 0 }
      // The frame point in the tile's plane. A point on a side may miss
      // the float32 triangulation by a hair: it is moved toward the
      // tangent point until a triangle holds it.
      const read = (x: number, y: number, out: Float64Array): Vec3 | null => {
        const d = directionAt(frame, x, y)
        project(pl.frame, d, q)
        for (const shrink of SHRINKS) {
          if (sampler.surfaceAt(q.x * shrink + pl.half, q.y * shrink + pl.half, out)) return d
        }
        return null
      }
      return {
        heightAt(x, y) {
          return read(x, y, s) ? s[0] : NaN
        },
        surfaceAt(x, y, out) {
          const d = read(x, y, out)
          if (!d) return false
          // The normal from the tile's plane (x along e1, y up along the
          // tangent point, z along e2) to the world, then to the local
          // axes at the point.
          const w = [
            out[1] * e1[0] + out[2] * centre[0] + out[3] * e2[0],
            out[1] * e1[1] + out[2] * centre[1] + out[3] * e2[1],
            out[1] * e1[2] + out[2] * centre[2] + out[3] * e2[2],
          ]
          localAxes(pl.frame, d, t1, t2)
          out[1] = dot(w, t1)
          out[2] = dot(w, d)
          out[3] = dot(w, t2)
          return true
        },
      }
    },
    rasteriseLevel1(base, frame, n, out) {
      const pl = frame.plane!
      const step = frame.cells / (n - 1)
      const normal = new Float64Array(3)
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const d = directionAt(frame, i * step, j * step)
          globe.locate(d[0], d[1], d[2], at2)
          const x = at2.x
          const y = at2.y
          const k = (j * n + i) * 3
          out[k] = base.heightAt(x, y)
          // The mesh's normal (east, up, south at the point) to the
          // world, then to the tile's local axes.
          base.normalAt(x, y, normal)
          globe.frame(x, y, g)
          const w = [normal[0] * g.ex + normal[1] * d[0] + normal[2] * g.sx, normal[0] * g.ey + normal[1] * d[1] + normal[2] * g.sy, normal[0] * g.ez + normal[1] * d[2] + normal[2] * g.sz]
          localAxes(pl.frame, d, t1, t2)
          const up = dot(w, d)
          out[k + 1] = up > 1e-6 ? -dot(w, t1) / up : 0
          out[k + 2] = up > 1e-6 ? -dot(w, t2) / up : 0
        }
      }
    },
    neighbours(tile) {
      const atlas = cubeAtlasOf(world, tile.level)
      const cube = cubeTileOf(atlas, tile)
      const out = new Map<string, TileId>()
      const add = (t: { face: number; i: number; j: number }): void => {
        const id = idOf(tile.level, atlas, t.face, t.i, t.j)
        if (id.x !== tile.x || id.y !== tile.y) out.set(`${id.x},${id.y}`, id)
      }
      for (let side = 0; side < 4; side++) add(atlas.neighbour(cube, side).tile)
      for (const t of atlas.cornerNeighbours(cube)) add(t)
      return [...out.values()]
    },
    // A node by its world point: the artifacts hold the same float32
    // point in every tile that has the node (DEC-0041).
    rimKey(tile, from) {
      if (from !== tile && from.x === tile.x && from.y === tile.y) return null
      return (x, y) => `${x},${y}`
    },
    // The sums are in the neighbour's plane: turned into this tile's
    // through the world.
    rimSum(tile, rim, i, out) {
      const a = frameOf(rim.tile).plane!.frame
      const b = frameOf(tile).plane!.frame
      const sx = rim.sums[3 * i]
      const sy = rim.sums[3 * i + 1]
      const sz = rim.sums[3 * i + 2]
      const w = [sx * a.e1[0] + sy * a.centre[0] + sz * a.e2[0], sx * a.e1[1] + sy * a.centre[1] + sz * a.e2[1], sx * a.e1[2] + sy * a.centre[2] + sz * a.e2[2]]
      out[0] = dot(w, b.e1)
      out[1] = dot(w, b.centre)
      out[2] = dot(w, b.e2)
    },
    // The box (in the frame) of the triangles that touch the nodes the rim
    // shares, and a sample around it.
    reseamArea(frame, nodes, triangles, role, n) {
      const step = frame.cells / (n - 1)
      return (_tile, rim) => {
        const keys = new Set<string>()
        for (let i = 0; i < rim.positions.length; i += 2) keys.add(`${rim.positions[i]},${rim.positions[i + 1]}`)
        const shared = new Uint8Array(role.length)
        let any = false
        for (let v = 0; v < role.length; v++) {
          if (keys.has(`${nodes[2 * v]},${nodes[2 * v + 1]}`)) {
            shared[v] = 1
            any = true
          }
        }
        if (!any) return () => false
        let x0 = Infinity
        let y0 = Infinity
        let x1 = -Infinity
        let y1 = -Infinity
        const done = new Uint8Array(role.length)
        for (let t = 0; t < triangles.length; t += 3) {
          const a = triangles[t], b = triangles[t + 1], c = triangles[t + 2]
          if (!shared[a] && !shared[b] && !shared[c]) continue
          for (const v of [a, b, c]) {
            if (done[v]) continue
            done[v] = 1
            place(frame, directionOf(nodes[2 * v], nodes[2 * v + 1]), at2)
            x0 = Math.min(x0, at2.x)
            x1 = Math.max(x1, at2.x)
            y0 = Math.min(y0, at2.y)
            y1 = Math.max(y1, at2.y)
          }
        }
        return (x, y) => x >= x0 - step && x <= x1 + step && y >= y0 - step && y <= y1 + step
      }
    },
  }
}
