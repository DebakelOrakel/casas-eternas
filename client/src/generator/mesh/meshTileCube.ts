import { detAtan, detCos, detHypot } from '../core/detMath'
import { torusDomain, type Domain, type GlobeNoise } from '../core/domain'
import { RIDGE_GLOBE_OFFSET } from '../surface/amplify'
import { CubeAtlas, IDENTITY, project, rotationAbout, sideEnds, sidePoint, unproject, type CubeTileId, type Mat3, type TileFrame, type Vec3 } from './cubeAtlas'
import { hilbertOrder } from './hilbert'
import { bootstrapLattice } from './lattice'
import {
  CLEAR_FRACTION, EDGE_JITTER, EDGE_SALT_ROW, hash01, JITTER, LEVEL_SALT, stepOf, tileSpec,
  type TileId, type TileOptions, type TileParent, type TilePiece, type TileSite, type TileSpec,
} from './meshTile'
import type { DenseRegion } from './meshSampler'
import type { PeriodicTriangulation } from './periodicDelaunay'

// A FINE LEVEL'S TILE ON THE SPHERE (docs/decisions/sphere-tiles.md,
// DEC-0041): the cube atlas's tile (cubeAtlas.ts) as a TileSite, so that
// meshTile.buildTileMeshOn builds it as it builds a torus tile.
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
// pipeline version (cubeConstants).
const LEVEL_ROTATIONS: Readonly<Record<number, { axis: Vec3; angle: number }>> = {
  2: { axis: [0, 0, 1], angle: 0 },
  3: { axis: [0.48, 0.6, 0.64], angle: 0.7 },
}
// The placement hashes' salt per face, apart from the levels'.
const FACE_SALT = 4096

// Every number of the cube atlas that shapes a level's tile, for the tile
// artifact's pipeline version on a sphere world.
export function cubeConstants(level: number): Record<string, number> {
  const r = LEVEL_ROTATIONS[level]
  // The synthesis on the globe (meshRefine.levelSynthesis): its model and
  // its ridge mean's correction.
  // cubeFrameFill: the frame's empty part filled (cubeSite.fill), since
  // 2026-10-17.
  return { cubeAxisX: r.axis[0], cubeAxisY: r.axis[1], cubeAxisZ: r.axis[2], cubeAngle: r.angle, cubeFaceSalt: FACE_SALT, cubeEdgeModel: 1, cubeGlobeSynthesis: 1, cubeRidgeGlobeOffset: RIDGE_GLOBE_OFFSET, cubeFrameFill: 1 }
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

// A unit direction as a world point.
export function worldPointOf(world: Domain, p: Vec3, out: { x: number; y: number }): void {
  globeOf(world).locate(p[0], p[1], p[2], out)
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

// The parent's nodes as unit directions, once per parent mesh.
const parentDirections = new WeakMap<object, Float64Array>()
function directionsOf(parent: TileParent): Float64Array {
  let xyz = parentDirections.get(parent.mesh)
  if (!xyz) {
    const { mesh } = parent
    xyz = new Float64Array(mesh.vertexSlots * 3)
    for (let v = 0; v < mesh.vertexSlots; v++) {
      if (!mesh.vAlive[v]) continue
      const p = directionOf(mesh.domain, mesh.vx[v], mesh.vy[v])
      xyz[3 * v] = p[0]
      xyz[3 * v + 1] = p[1]
      xyz[3 * v + 2] = p[2]
    }
    parentDirections.set(parent.mesh, xyz)
  }
  return xyz
}

export function cubeSite(parent: TileParent, tile: TileId, options: TileOptions): TileSite {
  const { seed } = options
  // The world the parent lies on, one macro cell per unit.
  const world = parent.mesh.domain
  const spec: TileSpec = tileSpec(tile.level)
  const halo = options.halo ?? spec.halo
  const geometry = cubeFrameOf(world, tile, halo)
  const { atlas, cube, frame, half, side, corners } = geometry
  const steps = spec.edgeSteps
  // The four sides as lines in the frame: a point, the inward unit normal,
  // and the side's clear strip (its own step: the sides differ in length).
  const lines = [0, 1, 2, 3].map((s) => {
    const [ax, ay] = corners[(s + 3) % 4]
    const [bx, by] = corners[s]
    const length = detHypot(bx - ax, by - ay)
    return { ax, ay, nx: -(by - ay) / length, ny: (bx - ax) / length, clear: CLEAR_FRACTION * (length / steps) }
  })
  const distance = (s: number, x: number, y: number): number => (x - lines[s].ax) * lines[s].nx + (y - lines[s].ay) * lines[s].ny
  const inside = (x: number, y: number): boolean => distance(0, x, y) > 0 && distance(1, x, y) > 0 && distance(2, x, y) > 0 && distance(3, x, y) > 0
  const inClear = (x: number, y: number): boolean => lines.some((line, s) => Math.abs(distance(s, x, y)) < line.clear)
  // Within the halo: the quad grown by `halo` on every side — the torus's
  // band, not the frame's whole square, which a turned quad leaves half
  // empty.
  const nearTile = (x: number, y: number): boolean => distance(0, x, y) > -halo && distance(1, x, y) > -halo && distance(2, x, y) > -halo && distance(3, x, y) > -halo
  const at = { x: 0, y: 0 }
  // A direction into the frame, or false off it.
  const toFrame = (p: Vec3, out: { x: number; y: number }): boolean => {
    if (!project(frame, p, out)) return false
    out.x += half
    out.y += half
    return out.x >= 0 && out.y >= 0 && out.x < side && out.y < side
  }
  const own = atlas.indexOf(cube)
  return {
    kind: 'cube', tile, spec, halo, side, originX: Number.NaN, originY: Number.NaN,
    localDomain: () => torusDomain(side, side, 0, world.metresPerUnit),
    inside,
    inClear,
    edgeRow(emit) {
      const local = { x: 0, y: 0 }
      const point = { x: 0, y: 0 }
      for (let s = 0; s < 4; s++) {
        const { a, b, reversed } = sideEnds(atlas, cube, s)
        const across = atlas.neighbour(cube, s)
        const theirs = atlas.indexOf(across.tile)
        // The side's owner names it: the same line from both tiles.
        const line = own < theirs ? own * 4 + s : theirs * 4 + across.side
        for (let m = 0; m < steps; m++) {
          const k = reversed ? steps - m : m
          const offset = k === 0 || k === steps ? 0 : EDGE_JITTER * (2 * hash01(line, k, EDGE_SALT_ROW + LEVEL_SALT * spec.level, seed) - 1)
          const p = sidePoint(atlas, a, b, k === 0 ? 0 : k === steps ? 1 : (k + offset) / steps)
          project(frame, p, local)
          worldPointOf(world, p, point)
          emit(local.x + half, local.y + half, point.x, point.y)
        }
      }
    },
    parentNodes(parent, emit) {
      const xyz = directionsOf(parent)
      const { mesh } = parent
      // Nothing past the frame's corner can be in it.
      const reach = detCos(Math.min(Math.PI / 2, (half * Math.SQRT2 * 1.01) / frame.radius))
      const c = frame.centre
      for (let v = 0; v < mesh.vertexSlots; v++) {
        if (!mesh.vAlive[v]) continue
        const px = xyz[3 * v]
        const py = xyz[3 * v + 1]
        const pz = xyz[3 * v + 2]
        if (px * c[0] + py * c[1] + pz * c[2] < reach) continue
        if (!toFrame([px, py, pz], at) || !nearTile(at.x, at.y) || inClear(at.x, at.y)) continue
        emit(at.x, at.y, v)
      }
    },
    placement(level, s, emit) {
      // The grid's step in face angles: a whole number of cells a face.
      const m = Math.max(1, Math.round((Math.PI / 2) * frame.radius / s))
      const delta = Math.PI / 2 / m
      const salt = 2 * level + LEVEL_SALT * spec.level
      // The frame's corners as directions, for each face's bounds: the
      // square maps to a convex quad on any face plane it is in front of,
      // so its extremes there are at its corners.
      const square: Vec3[] = [[0, 0], [side, 0], [side, side], [0, side]].map(([x, y]) => atlas.toCube(unproject(frame, x - half, y - half)))
      const local = { x: 0, y: 0 }
      const point = { x: 0, y: 0 }
      for (let face = 0; face < 6; face++) {
        let xiMin = Infinity
        let xiMax = -Infinity
        let etaMin = Infinity
        let etaMax = -Infinity
        let behind = false
        for (const q of square) {
          const t = atlas.faceTangents(face, q)
          if (!t) {
            behind = true
            break
          }
          const xi = detAtan(t[0])
          const eta = detAtan(t[1])
          xiMin = Math.min(xiMin, xi)
          xiMax = Math.max(xiMax, xi)
          etaMin = Math.min(etaMin, eta)
          etaMax = Math.max(etaMax, eta)
        }
        if (behind) continue
        const i0 = Math.max(0, Math.floor((xiMin + Math.PI / 4) / delta))
        const i1 = Math.min(m - 1, Math.floor((xiMax + Math.PI / 4) / delta))
        const j0 = Math.max(0, Math.floor((etaMin + Math.PI / 4) / delta))
        const j1 = Math.min(m - 1, Math.floor((etaMax + Math.PI / 4) / delta))
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            const faceSalt = salt + FACE_SALT * face
            const xi = -Math.PI / 4 + (i + 0.5 + JITTER * (2 * hash01(i, j, faceSalt, seed) - 1)) * delta
            const eta = -Math.PI / 4 + (j + 0.5 + JITTER * (2 * hash01(i, j, faceSalt + 1, seed) - 1)) * delta
            const p = atlas.facePoint(face, xi, eta)
            if (!toFrame(p, local) || !nearTile(local.x, local.y) || inClear(local.x, local.y)) continue
            worldPointOf(world, p, point)
            emit(local.x, local.y, point.x, point.y)
          }
        }
      }
    },
    // The frame's square outside the quad grown by the halo, on a grid of
    // the coarsest placement step, half a step in.
    fill(emit) {
      const s = stepOf(spec.placementLevels[0], spec)
      const point = { x: 0, y: 0 }
      for (let y = s / 2; y < side; y += s) {
        for (let x = s / 2; x < side; x += s) {
          if (nearTile(x, y)) continue
          worldPointOf(world, unproject(frame, x - half, y - half), point)
          emit(x, y, point.x, point.y)
        }
      }
    },
    worldPoint(x, y, placedX, placedY, out) {
      if (Number.isNaN(placedX)) {
        worldPointOf(world, unproject(frame, x - half, y - half), out)
        return
      }
      out.x = placedX
      out.y = placedY
    },
  }
}

// A world point into a cube tile's frame (meshTileBake's crossings), or
// false off it.
export function cubeToFrame(world: Domain, geometry: CubeFrame, x: number, y: number, out: { x: number; y: number }): boolean {
  if (!project(geometry.frame, directionOf(world, x, y), out)) return false
  out.x += geometry.half
  out.y += geometry.half
  return out.x >= 0 && out.y >= 0 && out.x < geometry.side && out.y < geometry.side
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

// Every tile of a level on the sphere, with sample points inside it in
// world points — what a land test reads the save's raster at. `perSide`
// samples along each of the tile's directions.
export function cubeTileSamples(world: Domain, level: number, perSide: number, visit: (tile: TileId, xs: number[], ys: number[]) => void): void {
  const atlas = cubeAtlasOf(world, level)
  const point = { x: 0, y: 0 }
  for (let index = 0; index < atlas.tileCount; index++) {
    const cube = atlas.tileOfIndex(index)
    const corners = atlas.corners(cube)
    const xs: number[] = []
    const ys: number[] = []
    for (let b = 0; b < perSide; b++) {
      for (let a = 0; a < perSide; a++) {
        // Bilinear over the corners' directions: inside the convex quad.
        const u = (a + 0.5) / perSide
        const v = (b + 0.5) / perSide
        const p: Vec3 = [0, 1, 2].map((k) => (1 - u) * (1 - v) * corners[0][k] + u * (1 - v) * corners[1][k] + u * v * corners[2][k] + (1 - u) * v * corners[3][k]) as Vec3
        worldPointOf(world, p, point)
        xs.push(point.x)
        ys.push(point.y)
      }
    }
    visit(tileIdOf(atlas, level, cube), xs, ys)
  }
}

// The patchwork parent on the sphere (meshTile.tileParentFromTiles' rule):
// the pieces' nodes, which a sphere tile stores as world points, a node on
// a shared edge row once, triangulated on the world's sphere (the empty
// rest spanned by long triangles no tile reads). Answers the chart region
// the pieces cover with their node count, for the sampler's dense grid.
export function cubeTileParentFromTiles(pieces: TilePiece[], world: Domain): { mesh: PeriodicTriangulation; z: Float32Array; region: DenseRegion } {
  const { width, height } = world
  const seen = new Map<string, number>()
  const xs: number[] = []
  const ys: number[] = []
  const zs: number[] = []
  for (const piece of pieces) {
    for (let i = 0; i < piece.count; i++) {
      const x = piece.nodes[2 * i]
      const y = piece.nodes[2 * i + 1]
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
  // As the torus's patchwork: into the bootstrap lattice, the lattice
  // removed farthest from the pieces first, a point that landed on a
  // lattice node inserted again.
  const mesh = bootstrapLattice(world, PATCH_LATTICE_CELLS)
  const latticeCount = mesh.vertexSlots
  const mapping = new Int32Array(xs.length)
  const again: number[] = []
  for (let n = 0; n < xs.length; n++) {
    mapping[n] = mesh.insert(ox[n], oy[n])
    if (mapping[n] < latticeCount) again.push(n)
  }
  const region = chartBounds(xs, ys, world)
  const cx = world.wrapX(region.x + region.width / 2)
  const cy = region.y + region.height / 2
  const away = new Float64Array(latticeCount)
  const lattice: number[] = []
  for (let v = 0; v < latticeCount; v++) {
    away[v] = world.distanceSq(mesh.vx[v], mesh.vy[v], cx, cy)
    lattice.push(v)
  }
  lattice.sort((a, b) => away[b] - away[a] || a - b)
  for (const v of lattice) if (mesh.vAlive[v]) mesh.remove(v)
  for (const n of again) mapping[n] = mesh.insert(ox[n], oy[n])
  const z = new Float32Array(mesh.vertexSlots)
  for (let n = 0; n < xs.length; n++) z[mapping[n]] = zs[order[n]]
  return { mesh, z, region: { ...region, nodes: xs.length } }
}

// The bootstrap lattice's spacing for a patchwork, in cells (meshTile's).
const PATCH_LATTICE_CELLS = 16

// The chart rectangle around world points, east-west from the first one;
// the whole chart's width where they straddle a pole.
function chartBounds(xs: number[], ys: number[], world: Domain): { x: number; y: number; width: number; height: number } {
  const { width } = world
  let minX = 0
  let maxX = 0
  let minY = Infinity
  let maxY = -Infinity
  for (let i = 0; i < xs.length; i++) {
    const dx = world.wrapX(xs[i] - xs[0] + width / 2) - width / 2
    minX = Math.min(minX, dx)
    maxX = Math.max(maxX, dx)
    minY = Math.min(minY, ys[i])
    maxY = Math.max(maxY, ys[i])
  }
  if (maxX - minX > width / 2) return { x: 0, y: minY, width, height: maxY - minY }
  return { x: world.wrapX(xs[0] + minX), y: minY, width: maxX - minX, height: maxY - minY }
}
