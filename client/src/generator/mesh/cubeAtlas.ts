import { detAtan, detCos, detSin, detTan } from '../core/detMath'

// THE CUBE ATLAS: a fine level's tiles on the sphere
// (docs/decisions/sphere-tiles.md, DEC-0041). The six faces of a cube, each
// split into n × n tiles on an EQUIANGULAR grid (fork 2): a face point is
// two angles (ξ, η) in [−π/4, π/4], uniform on the grid, and every grid
// line is a great circle — so a tile is a quad whose four sides are
// great-circle arcs. A level turns its cube by a rotation of its own (fork
// 4), so its face edges run through the inside of the next level's tiles.
//
// Geometry only, on unit vectors: the caller turns a chart point into a
// direction (Domain.noise.frame) and back (Domain.noise.locate).
//
// EXACT CORNERS. Two tiles that share a corner or a side must compute the
// same 3D point for it, also from two faces. A corner is a CUBE point
// whose three components come from one table, TANS (TANS[0] = −1 and
// TANS[n] = 1 exactly, TANS[n − k] = −TANS[k]), never from a tangent
// evaluated per face — tan(π/4) is not 1 in floating point. So a cube
// corner is the same triple from every face that has it, and the level's
// rotation turns the same triple into the same bits.

export type Vec3 = [number, number, number]
// A rotation, row-major: world = M · cube.
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number]

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]

// The rotation about the unit axis (x, y, z) by `angle` radians.
export function rotationAbout(x: number, y: number, z: number, angle: number): Mat3 {
  const c = detCos(angle)
  const s = detSin(angle)
  const t = 1 - c
  return [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c,
  ]
}

// A face: the axis through its centre and its two in-face axes, all of
// the cube's frame. (u, v, c) is right-handed, so (i, j) runs
// counter-clockwise seen from outside.
interface Face {
  c: Vec3
  u: Vec3
  v: Vec3
}

const FACES: readonly Face[] = [
  { c: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
  { c: [-1, 0, 0], u: [0, -1, 0], v: [0, 0, 1] },
  { c: [0, 1, 0], u: [-1, 0, 0], v: [0, 0, 1] },
  { c: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { c: [0, 0, 1], u: [0, 1, 0], v: [-1, 0, 0] },
  { c: [0, 0, -1], u: [0, 1, 0], v: [1, 0, 0] },
]
export const FACE_COUNT = FACES.length

// A tile of a cube atlas.
export interface CubeTileId {
  face: number
  i: number
  j: number
}

// The sides of a tile, in order: i low, j low, i high, j high.
export const SIDE_I_LOW = 0
export const SIDE_J_LOW = 1
export const SIDE_I_HIGH = 2
export const SIDE_J_HIGH = 3

// The plane of one tile: gnomonic, tangent at the tile's centre (fork 3).
// A great circle is a straight line in it.
export interface TileFrame {
  // The tangent point and the plane's two axes, unit vectors.
  centre: Vec3
  e1: Vec3
  e2: Vec3
  // Length units per unit of the plane at the tangent point (the
  // domain's radius, so the plane counts in domain units).
  radius: number
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function normalise(a: Vec3): Vec3 {
  const l = Math.sqrt(dot(a, a))
  return [a[0] / l, a[1] / l, a[2] / l]
}

function turn(m: Mat3, a: Vec3): Vec3 {
  return [
    m[0] * a[0] + m[1] * a[1] + m[2] * a[2],
    m[3] * a[0] + m[4] * a[1] + m[5] * a[2],
    m[6] * a[0] + m[7] * a[1] + m[8] * a[2],
  ]
}

function turnBack(m: Mat3, a: Vec3): Vec3 {
  return [
    m[0] * a[0] + m[3] * a[1] + m[6] * a[2],
    m[1] * a[0] + m[4] * a[1] + m[7] * a[2],
    m[2] * a[0] + m[5] * a[1] + m[8] * a[2],
  ]
}

export class CubeAtlas {
  readonly n: number
  readonly rotation: Mat3
  // TANS[k] = tan(−π/4 + k · π/(2n)), exact at both ends and symmetric.
  private readonly tans: Float64Array

  constructor(n: number, rotation: Mat3 = IDENTITY) {
    if (!Number.isInteger(n) || n < 1) throw new Error(`a cube atlas needs n ≥ 1 tiles a face side, got ${n}`)
    this.n = n
    this.rotation = rotation
    const tans = new Float64Array(n + 1)
    for (let k = 0; k <= n; k++) {
      // From the nearer end, so TANS[n − k] is exactly −TANS[k].
      const m = Math.min(k, n - k)
      const value = m === 0 ? 1 : detTan(Math.PI / 4 - (m * Math.PI) / (2 * n))
      tans[k] = k * 2 < n ? -value : k * 2 === n ? 0 : value
    }
    this.tans = tans
  }

  get tileCount(): number {
    return FACE_COUNT * this.n * this.n
  }

  // A tile's index in [0, tileCount): face, then row j, then column i.
  indexOf(tile: CubeTileId): number {
    return (tile.face * this.n + tile.j) * this.n + tile.i
  }

  tileOfIndex(index: number): CubeTileId {
    const n = this.n
    return { face: Math.floor(index / (n * n)), j: Math.floor(index / n) % n, i: index % n }
  }

  // The tile that holds a direction (any length but 0). A point on a side
  // goes to the tile with the higher grid index there, on its face.
  tileAt(p: Vec3): CubeTileId {
    const q = turnBack(this.rotation, p)
    const face = faceOf(q)
    const { c, u, v } = FACES[face]
    const along = dot(q, c)
    const xi = detAtan(dot(q, u) / along)
    const eta = detAtan(dot(q, v) / along)
    const step = Math.PI / (2 * this.n)
    const clamp = (k: number): number => Math.min(this.n - 1, Math.max(0, k))
    return { face, i: clamp(Math.floor((xi + Math.PI / 4) / step)), j: clamp(Math.floor((eta + Math.PI / 4) / step)) }
  }

  // A tile corner (a, b in {0, 1}: i side, j side) as a CUBE point — not
  // normalised, every component from the TANS table or ±1, so the same
  // corner is the same triple from every tile and face that has it.
  cubeCorner(tile: CubeTileId, a: 0 | 1, b: 0 | 1): Vec3 {
    const { c, u, v } = FACES[tile.face]
    const s = this.tans[tile.i + a]
    const t = this.tans[tile.j + b]
    // c, u and v are axis vectors with one ±1 each: a component is one of
    // ±1, ±s, ±t, exact.
    return [c[0] + s * u[0] + t * v[0], c[1] + s * u[1] + t * v[1], c[2] + s * u[2] + t * v[2]]
  }

  // A tile corner as a world direction (unit).
  corner(tile: CubeTileId, a: 0 | 1, b: 0 | 1): Vec3 {
    return turn(this.rotation, normalise(this.cubeCorner(tile, a, b)))
  }

  // The four corners in counter-clockwise order seen from outside.
  corners(tile: CubeTileId): [Vec3, Vec3, Vec3, Vec3] {
    return [this.corner(tile, 0, 0), this.corner(tile, 1, 0), this.corner(tile, 1, 1), this.corner(tile, 0, 1)]
  }

  // The tile's centre: the direction at its two mid angles.
  centre(tile: CubeTileId): Vec3 {
    const { c, u, v } = FACES[tile.face]
    const step = Math.PI / (2 * this.n)
    const s = detTan(-Math.PI / 4 + (tile.i + 0.5) * step)
    const t = detTan(-Math.PI / 4 + (tile.j + 0.5) * step)
    return turn(this.rotation, normalise([c[0] + s * u[0] + t * v[0], c[1] + s * u[1] + t * v[1], c[2] + s * u[2] + t * v[2]]))
  }

  // The inward normals of the planes of the four sides (SIDE_* order): a
  // direction p is inside the tile when dot(p, n) ≥ 0 for all four.
  sideNormals(tile: CubeTileId): [Vec3, Vec3, Vec3, Vec3] {
    const [p00, p10, p11, p01] = this.corners(tile)
    // Counter-clockwise from outside: cross(a, b) of consecutive corners
    // points into the tile's side of the plane.
    return [normalise(cross(p01, p00)), normalise(cross(p00, p10)), normalise(cross(p10, p11)), normalise(cross(p11, p01))]
  }

  inside(tile: CubeTileId, p: Vec3, normals = this.sideNormals(tile)): boolean {
    return normals.every((nrm) => dot(p, nrm) >= 0)
  }

  // The tile across a side, and which of its sides that is. Found by a
  // point just past the side's middle, so it holds across face edges with
  // no table of how the faces turn against each other.
  neighbour(tile: CubeTileId, side: number): { tile: CubeTileId; side: number } {
    const corners = this.corners(tile)
    const a = corners[(side + 3) % 4]
    const b = corners[side]
    const mid = normalise([a[0] + b[0], a[1] + b[1], a[2] + b[2]])
    const nrm = this.sideNormals(tile)[side]
    const eps = 1e-6 / this.n
    const across = this.tileAt([mid[0] - eps * nrm[0], mid[1] - eps * nrm[1], mid[2] - eps * nrm[2]])
    const theirs = this.sideNormals(across)
    let best = 0
    for (let k = 1; k < 4; k++) if (dot(theirs[k], nrm) < dot(theirs[best], nrm)) best = k
    return { tile: across, side: best }
  }

  // The tiles that share only a corner with this one: four in general, one
  // fewer for each of the cube's eight corners the tile has (three tiles
  // meet there, not four).
  cornerNeighbours(tile: CubeTileId): CubeTileId[] {
    const own = this.indexOf(tile)
    const sides = new Set([0, 1, 2, 3].map((s) => this.indexOf(this.neighbour(tile, s).tile)))
    const out = new Map<number, CubeTileId>()
    const eps = 1e-6 / this.n
    for (const corner of this.corners(tile)) {
      // Around the corner: points a little off it in many directions.
      const e1 = normalise(cross(corner, Math.abs(corner[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]))
      const e2 = cross(corner, e1)
      for (let k = 0; k < 24; k++) {
        const angle = (k + 0.5) * (Math.PI / 12)
        const c = detCos(angle) * eps
        const s = detSin(angle) * eps
        const at = this.tileAt([corner[0] + c * e1[0] + s * e2[0], corner[1] + c * e1[1] + s * e2[1], corner[2] + c * e1[2] + s * e2[2]])
        const index = this.indexOf(at)
        if (index !== own && !sides.has(index)) out.set(index, at)
      }
    }
    return [...out.values()]
  }

  // A direction in the cube's frame (the level's rotation undone).
  toCube(p: Vec3): Vec3 {
    return turnBack(this.rotation, p)
  }

  // The world direction at face angles (ξ, η).
  facePoint(face: number, xi: number, eta: number): Vec3 {
    const { c, u, v } = FACES[face]
    const s = detTan(xi)
    const t = detTan(eta)
    return turn(this.rotation, normalise([c[0] + s * u[0] + t * v[0], c[1] + s * u[1] + t * v[1], c[2] + s * u[2] + t * v[2]]))
  }

  // A cube-frame direction's gnomonic coordinates on a face (tan ξ, tan η),
  // or null where it is not in front of that face's plane.
  faceTangents(face: number, q: Vec3): [number, number] | null {
    const { c, u, v } = FACES[face]
    const along = dot(q, c)
    if (along <= 0) return null
    return [dot(q, u) / along, dot(q, v) / along]
  }

  // The tile's plane (fork 3).
  frame(tile: CubeTileId, radius: number): TileFrame {
    const centre = this.centre(tile)
    // e1 along the tile's i direction, e2 completes a right-handed frame
    // with the outward normal.
    const [p00, p10] = [this.corner(tile, 0, 0), this.corner(tile, 1, 0)]
    const d: Vec3 = [p10[0] - p00[0], p10[1] - p00[1], p10[2] - p00[2]]
    const e1 = normalise([d[0] - dot(d, centre) * centre[0], d[1] - dot(d, centre) * centre[1], d[2] - dot(d, centre) * centre[2]])
    const e2 = cross(centre, e1)
    return { centre, e1, e2, radius }
  }
}

// The face whose axis is nearest a cube-frame direction.
function faceOf(q: Vec3): number {
  const ax = Math.abs(q[0])
  const ay = Math.abs(q[1])
  const az = Math.abs(q[2])
  if (ax >= ay && ax >= az) return q[0] >= 0 ? 0 : 1
  if (ay >= az) return q[1] >= 0 ? 2 : 3
  return q[2] >= 0 ? 4 : 5
}

// A direction into a tile's plane, in its length units; null behind the
// plane's horizon (90° or more from the tangent point).
export function project(frame: TileFrame, p: Vec3, out: { x: number; y: number }): boolean {
  const along = dot(p, frame.centre)
  if (along <= 0) return false
  out.x = (frame.radius * dot(p, frame.e1)) / along
  out.y = (frame.radius * dot(p, frame.e2)) / along
  return true
}

// A point of a tile's plane back to a unit direction.
export function unproject(frame: TileFrame, x: number, y: number): Vec3 {
  const s = x / frame.radius
  const t = y / frame.radius
  const { centre: c, e1, e2 } = frame
  return normalise([c[0] + s * e1[0] + t * e2[0], c[1] + s * e1[1] + t * e2[1], c[2] + s * e1[2] + t * e2[2]])
}

// A point of a side, canonical (fork 5): the side from cube corner A to
// cube corner B, at fraction f along the CUBE segment between them, as a
// world direction. Whichever tile asks, it passes the two corners in the
// same order (sideEnds), so the point is the same bits from both.
// At f = 0 and f = 1 it is the corner itself: a + 1 · (b − a) is not b in
// floating point, and a corner is shared by two sides of each tile.
export function sidePoint(atlas: CubeAtlas, a: Vec3, b: Vec3, f: number): Vec3 {
  const q: Vec3 = f === 0 ? a : f === 1 ? b : [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1]), a[2] + f * (b[2] - a[2])]
  return turn(atlas.rotation, normalise(q))
}

// A side's two cube corners in the canonical order: lexicographic on the
// cube triple, so both tiles that share the side run it the same way.
// `reversed` says whether that is against the tile's own order (corner
// (side + 3) % 4 to corner side).
export function sideEnds(atlas: CubeAtlas, tile: CubeTileId, side: number): { a: Vec3; b: Vec3; reversed: boolean } {
  const cube: Vec3[] = [atlas.cubeCorner(tile, 0, 0), atlas.cubeCorner(tile, 1, 0), atlas.cubeCorner(tile, 1, 1), atlas.cubeCorner(tile, 0, 1)]
  const from = cube[(side + 3) % 4]
  const to = cube[side]
  const before = from[0] - to[0] || from[1] - to[1] || from[2] - to[2]
  return before < 0 ? { a: from, b: to, reversed: false } : { a: to, b: from, reversed: true }
}
