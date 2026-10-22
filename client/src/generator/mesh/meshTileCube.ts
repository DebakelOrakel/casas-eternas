import { detHypot } from '../core/detMath'
import { type Domain, type GlobeNoise } from '../core/domain'
import { CubeAtlas, IDENTITY, project, rotationAbout, unproject, type CubeTileId, type Mat3, type TileFrame, type Vec3 } from './cubeAtlas'
import {
  tileSpec,
  type TileId, type TileSpec,
} from './meshTile'

// A FINE LEVEL'S TILE ON THE SPHERE (docs/decisions/sphere-tiles.md,
// DEC-0041): the cube atlas's tile (cubeAtlas.ts) as a TileSite, so that
// the engine's `build_tile_mesh_on` builds it as it builds a torus tile.
//
// - THE ATLAS of a level: n × n tiles a face, n the face's quarter of the
//   equator in macro cells over the level's tile side (fork 9: a tile spans
//   TileSpec.cells units at a face's centre), the level's own rotation
//   (fork 4). A tile's id folds the face into its column: x = face · n + i,
//   y = j (fork 8), so ids, stage names and the coordinator stay the
//   torus's.
// - THE FRAME is the tile's gnomonic plane (fork 3), in domain units,
//   shifted by `half` so the tile and its halo lie in [0, side)². Its
//   sides are straight there: the inside test and the clear strip are four
//   lines, as the torus's are.
// - THE EDGE ROW runs along each side from its canonical end (fork 5): a
//   node is the side's point at a fraction of the cube segment, its jitter
//   hashed from the side's owner (the tile with the lower index) and its
//   step — the same point, bit for bit, from both tiles that share it.
// - THE PLACEMENT is a jittered grid per placement level on the level's
//   cube, in face angles (fork 7): a rule of position for the whole world.
//
// Not the torus's quantum: no node is computed in two frames. A node
// shared by two tiles (the edge row) is the same 3D point and the same
// world point from both; its local point is each tile's own.

// The rotation of each level's cube (fork 4): the face edges of one level
// cross the inside of the next level's tiles. Constants of the level's
// pipeline version (the engine's `cube_constants`).
const LEVEL_ROTATIONS: Readonly<Record<number, { axis: Vec3; angle: number }>> = {
  2: { axis: [0, 0, 1], angle: 0 },
  3: { axis: [0.48, 0.6, 0.64], angle: 0.7 },
}

function levelRotation(level: number): Mat3 {
  const r = LEVEL_ROTATIONS[level]
  if (!r) throw new Error(`level ${level} has no cube rotation`)
  if (r.angle === 0) return IDENTITY
  const l = detHypot(r.axis[0], r.axis[1], r.axis[2])
  return rotationAbout(r.axis[0] / l, r.axis[1] / l, r.axis[2] / l, r.angle)
}

// The globe of a sphere domain (its noise space carries the frame).
function globeOf(world: Domain): GlobeNoise {
  if (world.noise.kind !== 'globe') throw new Error('a cube tile needs a sphere world')
  return world.noise
}

const atlases = new Map<string, CubeAtlas>()

// A level's atlas on a world of this width.
export function cubeAtlasOf(world: Domain, level: number): CubeAtlas {
  const spec = tileSpec(level)
  const n = Math.max(1, Math.round(world.width / 4 / spec.cells))
  const key = `${level}:${n}`
  let atlas = atlases.get(key)
  if (!atlas) {
    atlas = new CubeAtlas(n, levelRotation(level))
    atlases.set(key, atlas)
  }
  return atlas
}

export function cubeTileOf(atlas: CubeAtlas, tile: TileId): CubeTileId {
  return { face: Math.floor(tile.x / atlas.n), i: tile.x % atlas.n, j: tile.y }
}

function tileIdOf(atlas: CubeAtlas, level: number, t: CubeTileId): TileId {
  return { level, x: t.face * atlas.n + t.i, y: t.j }
}

// A level's tile grid on the sphere, as the torus's tileGrid says it.
export function cubeTileGrid(world: Domain, level: number): { cols: number; rows: number } {
  const n = cubeAtlasOf(world, level).n
  return { cols: 6 * n, rows: n }
}

// A world point as a unit direction.
export function directionOf(world: Domain, x: number, y: number): Vec3 {
  const globe = globeOf(world)
  const f = { px: 0, py: 0, pz: 0, ex: 0, ey: 0, ez: 0, sx: 0, sy: 0, sz: 0 }
  globe.frame(x, y, f)
  const l = detHypot(f.px, f.py, f.pz)
  return [f.px / l, f.py / l, f.pz / l]
}

// The tile of `level` that holds a world point.
export function cubeTileAt(level: number, x: number, y: number, world: Domain): TileId {
  const atlas = cubeAtlasOf(world, level)
  return tileIdOf(atlas, level, atlas.tileAt(directionOf(world, x, y)))
}

// A tile's frame: its plane and the square its halo fits in.
export interface CubeFrame {
  atlas: CubeAtlas
  cube: CubeTileId
  frame: TileFrame
  // The plane's origin in the frame: local = plane + half.
  half: number
  side: number
  // The four corners in the frame, counter-clockwise (cubeAtlas order).
  corners: [number, number][]
}

export function cubeFrameOf(world: Domain, tile: TileId, halo: number): CubeFrame {
  const atlas = cubeAtlasOf(world, tile.level)
  const cube = cubeTileOf(atlas, tile)
  const radius = globeOf(world).radius
  const frame = atlas.frame(cube, radius)
  const at = { x: 0, y: 0 }
  const plane = atlas.corners(cube).map((p) => {
    project(frame, p, at)
    return [at.x, at.y] as [number, number]
  })
  let extent = 0
  for (const [x, y] of plane) extent = Math.max(extent, Math.abs(x), Math.abs(y))
  const half = Math.ceil(extent + halo)
  return { atlas, cube, frame, half, side: 2 * half, corners: plane.map(([x, y]) => [x + half, y + half]) }
}

// The tiles of the level above that a tile with its halo overlaps (the
// staggered levels turn their cubes, so any of the parent's tiles may):
// the parent tiles at the frame's corners and centre and their neighbours,
// each kept where its quad meets the frame's square in the tile's plane.
export function cubeParentTilesOf(tile: TileId, parentSpec: TileSpec, world: Domain): TileId[] {
  const spec = tileSpec(tile.level)
  const geometry = cubeFrameOf(world, tile, spec.halo)
  const { frame, half, side } = geometry
  const parentAtlas = cubeAtlasOf(world, parentSpec.level)
  const candidates = new Map<number, CubeTileId>()
  const addAround = (t: CubeTileId): void => {
    candidates.set(parentAtlas.indexOf(t), t)
    for (let s = 0; s < 4; s++) {
      const n = parentAtlas.neighbour(t, s).tile
      candidates.set(parentAtlas.indexOf(n), n)
    }
    for (const n of parentAtlas.cornerNeighbours(t)) candidates.set(parentAtlas.indexOf(n), n)
  }
  for (const [x, y] of [[0, 0], [side, 0], [side, side], [0, side], [half, half]]) addAround(parentAtlas.tileAt(unproject(frame, x - half, y - half)))
  const square: [number, number][] = [[0, 0], [side, 0], [side, side], [0, side]]
  const out: TileId[] = []
  const at = { x: 0, y: 0 }
  for (const t of [...candidates].sort((a, b) => a[0] - b[0]).map(([, c]) => c)) {
    const quad: [number, number][] = []
    let behind = false
    for (const p of parentAtlas.corners(t)) {
      if (!project(frame, p, at)) {
        behind = true
        break
      }
      quad.push([at.x + half, at.y + half])
    }
    if (behind || !convexOverlap(square, quad)) continue
    out.push(tileIdOf(parentAtlas, parentSpec.level, t))
  }
  return out
}

// Whether two convex polygons overlap (separating axes; touching counts as
// apart, as the torus's half-open spans do).
function convexOverlap(a: [number, number][], b: [number, number][]): boolean {
  for (const poly of [a, b]) {
    for (let k = 0; k < poly.length; k++) {
      const [x0, y0] = poly[k]
      const [x1, y1] = poly[(k + 1) % poly.length]
      const nx = -(y1 - y0)
      const ny = x1 - x0
      let aMin = Infinity
      let aMax = -Infinity
      for (const [x, y] of a) {
        const d = x * nx + y * ny
        aMin = Math.min(aMin, d)
        aMax = Math.max(aMax, d)
      }
      let bMin = Infinity
      let bMax = -Infinity
      for (const [x, y] of b) {
        const d = x * nx + y * ny
        bMin = Math.min(bMin, d)
        bMax = Math.max(bMax, d)
      }
      if (aMax <= bMin || bMax <= aMin) return false
    }
  }
  return true
}
