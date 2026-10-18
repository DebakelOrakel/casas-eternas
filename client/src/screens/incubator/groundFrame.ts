import type { Domain, GlobeFrame } from '../../generator/core/domain'
import { MAP_WORLD_HEIGHT, MAP_WORLD_WIDTH, UNITS_PER_METER } from '../../map/mapSceneSettings'

// THE GROUND FRAME (docs/decisions/sphere-ground.md, forks 1–4 and 8):
// where the scene's plane lies on the world. The rings, the painter and
// the camera work in one plane on both shapes; this says what a point of
// it is.
//
// On the torus the plane is the world's chart laid flat, as the incubator
// always had it: scene x, z to cells by the map's own scale, to the bit.
// On the sphere it is the azimuthal-equidistant plane about an ANCHOR
// (Domain.fromPlane): the scene's origin is the anchor, x east and z south
// of it, a scene unit UNITS_PER_METER of a metre of arc. The rings put
// their vertices on the cap of the sphere over it (capPoint), and the
// anchor moves when the focus goes too far from it (fork 3).
//
// The painter works in PLANE CELLS: on the torus the world's cells, on the
// sphere the anchor's chart point plus the offset in the sphere's domain
// units. A source turns them into world points (planeToWorld).

export interface GroundFrame {
  readonly kind: Domain['kind']
  // Metres per plane cell.
  readonly metresPerCell: number
  // The anchor's chart point (the sphere), or null (the torus).
  readonly anchor: { x: number; y: number } | null
  // The sphere's radius in scene units (0 on the torus).
  readonly radius: number
  // A scene point in plane cells.
  cellX(sceneX: number): number
  cellY(sceneZ: number): number
  // A scene length in plane cells.
  cells(sceneLength: number): number
}

export function torusFrame(world: Domain): GroundFrame {
  const { width, height } = world
  return {
    kind: 'torus',
    metresPerCell: world.metresPerUnit,
    anchor: null,
    radius: 0,
    // Texel px of the map shows world x = px, so the plane's centre u = ½
    // is cell (width/2 − ½).
    cellX: (x) => (x / MAP_WORLD_WIDTH + 0.5) * width - 0.5,
    cellY: (z) => (z / MAP_WORLD_HEIGHT + 0.5) * height - 0.5,
    cells: (s) => s / UNITS_PER_METER / world.metresPerUnit,
  }
}

export function sphereFrame(world: Domain, anchorX: number, anchorY: number): GroundFrame {
  const unitsPerCell = UNITS_PER_METER * world.metresPerUnit
  return {
    kind: 'sphere',
    metresPerCell: world.metresPerUnit,
    anchor: { x: anchorX, y: anchorY },
    radius: (world.metresAround / (2 * Math.PI)) * UNITS_PER_METER,
    cellX: (x) => anchorX + x / unitsPerCell,
    cellY: (z) => anchorY + z / unitsPerCell,
    cells: (s) => s / unitsPerCell,
  }
}

// A plane point (cells) as a world point, about the anchor.
export function planeToWorld(world: Domain, anchor: { x: number; y: number }, px: number, py: number, out: { x: number; y: number }): void {
  world.fromPlane(px, py, anchor.x, anchor.y, out)
}

// The plane's two axes at a world point, as unit 3D vectors in the
// globe's frame: the anchor's east and south carried along the great
// circle to the point. The azimuthal-equidistant plane keeps the bearing
// from the anchor, so these are its axes' directions at the point; their
// lengths it does not keep across the bearing (sin θ / θ), and a slope is
// read along the direction.
export function planeAxesAt(world: Domain, anchor: { x: number; y: number }, x: number, y: number, a1: number[], a2: number[]): void {
  if (world.noise.kind !== 'globe') throw new Error('plane axes need a globe')
  const g: GlobeFrame = scratchFrame
  world.noise.frame(x, y, g)
  const c = scratchCarry
  world.transport(1, 0, anchor.x, anchor.y, x, y, c)
  a1[0] = c.x * g.ex + c.y * g.sx
  a1[1] = c.x * g.ey + c.y * g.sy
  a1[2] = c.x * g.ez + c.y * g.sz
  world.transport(0, 1, anchor.x, anchor.y, x, y, c)
  a2[0] = c.x * g.ex + c.y * g.sx
  a2[1] = c.x * g.ey + c.y * g.sy
  a2[2] = c.x * g.ez + c.y * g.sz
}
const scratchFrame: GlobeFrame = { px: 0, py: 0, pz: 0, ex: 0, ey: 0, ez: 0, sx: 0, sy: 0, sz: 0 }
const scratchCarry = { x: 0, y: 0 }

// A plane point on the cap (fork 1): (x, z) in scene units from the
// anchor, h over the sphere (scene units, the exaggeration in), radius R.
// Into out[at..at+2]: (R + h) · n − (0, R, 0), n the sphere's normal there.
export function capPoint(x: number, z: number, h: number, radius: number, out: Float32Array, at: number): void {
  const d = Math.sqrt(x * x + z * z)
  if (d < 1e-12) {
    out[at] = x
    out[at + 1] = h
    out[at + 2] = z
    return
  }
  const theta = d / radius
  const r = radius + h
  const s = Math.sin(theta) / d
  out[at] = r * s * x
  out[at + 1] = r * Math.cos(theta) - radius
  out[at + 2] = r * s * z
}

// A vector of the plane's frame (y up) turned onto the cap at (x, z): the
// turn that takes the plane's up to the cap's normal there, about the
// horizontal axis across the bearing. In place, v[at..at+2].
export function capTurn(x: number, z: number, radius: number, v: Float32Array | number[], at: number): void {
  const d = Math.sqrt(x * x + z * z)
  if (d < 1e-12) return
  const theta = d / radius
  const ux = x / d
  const uz = z / d
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  // In the bearing's vertical plane: the radial part r and the up part y
  // turn by θ; the part across the bearing stays.
  const vx = v[at]
  const vy = v[at + 1]
  const vz = v[at + 2]
  const r = vx * ux + vz * uz
  const across = -vx * uz + vz * ux
  const r2 = r * c + vy * s
  const y2 = vy * c - r * s
  v[at] = r2 * ux - across * uz
  v[at + 1] = y2
  v[at + 2] = r2 * uz + across * ux
}

// The anchor moved to the world point under a scene point (fx, fz) of the
// old frame: the new anchor, and the angle (radians, from x toward z) by
// which the ground's directions turn in the scene from the old frame to
// the new — a camera keeps its view by turning its yaw by −α.
export function reanchor(world: Domain, frame: GroundFrame, fx: number, fz: number): { anchorX: number; anchorY: number; alpha: number } {
  const old = frame.anchor!
  const to = { x: 0, y: 0 }
  planeToWorld(world, old, frame.cellX(fx), frame.cellY(fz), to)
  const c = { x: 0, y: 0 }
  world.transport(1, 0, old.x, old.y, to.x, to.y, c)
  // The old plane's x axis at the new anchor, in the new plane's (east,
  // south): carried along the great circle the old plane's x is the old
  // anchor's east, and the new plane's axes are the new anchor's own.
  return { anchorX: to.x, anchorY: to.y, alpha: Math.atan2(c.y, c.x) }
}

// A ring's painted normals (map/groundPaint.ts: RGBA, xyz · ½ + ½) turned
// onto the cap, in place: texel (i, j) lies at plane cell x0 + (i + ½) ·
// pitch, y0 + (j + ½) · pitch, the anchor at (ax, ay), the sphere
// `radius` cells round its centre. The alpha (the water flag) stays.
export function capTurnNormals(normals: Uint8Array, texels: number, x0: number, y0: number, pitch: number, ax: number, ay: number, radius: number): void {
  const v = [0, 0, 0]
  for (let j = 0; j < texels; j++) {
    const z = y0 + (j + 0.5) * pitch - ay
    for (let i = 0; i < texels; i++) {
      const x = x0 + (i + 0.5) * pitch - ax
      const p = (j * texels + i) * 4
      v[0] = normals[p] / 127.5 - 1
      v[1] = normals[p + 1] / 127.5 - 1
      v[2] = normals[p + 2] / 127.5 - 1
      capTurn(x, z, radius, v, 0)
      // Unit again (the bytes are not), and held to a byte: a flat normal
      // read back as 1.004 rounded to 256, which a byte keeps as 0 — a
      // normal pointing down.
      const l = Math.hypot(v[0], v[1], v[2]) || 1
      for (let k = 0; k < 3; k++) normals[p + k] = Math.min(255, Math.max(0, Math.round(((v[k] / l) * 0.5 + 0.5) * 255)))
    }
  }
}
