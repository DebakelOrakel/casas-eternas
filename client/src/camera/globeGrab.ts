// THE GLOBE'S DRAG, AS PURE ARITHMETIC (2026-10-11): the orbit rig
// (orbitSwoopCamera.ts) turns the globe with it; scripts/globeGrab.mjs
// checks it. Plain numbers, no scene, so that the check reads the code that
// runs.
//
// THE VIEW IS A LONGITUDE AND A LATITUDE, NO ROLL. The camera never moves on
// a drag; the view pivot turns under it. Which way the pivot faces is two
// angles:
//  - the latitude φ of the view centre (the point under the camera, the
//    hover direction c) about the pivot's +y,
//  - the longitude λ: how far the pivot is turned about its +y.
// The pivot's +y always lies in the plane of c and u, where u is the
// screen's up on the globe at c (the camera's own up, world +y, along the
// surface). The camera's look and up lie in that plane too, so the pivot's
// +y shows straight up on the screen, whatever path the drag took. Turns
// about two screen axes, the old drag, add a roll on every curved path; two
// angles cannot.
//
// The pivot's +y is the UNLEANED vertical, not the globe's axis. The globe
// hangs below the pivot leaned by its obliquity and turned about its own
// (leaned) axis by its spin (globeFrameRotation): the drawn axis leans on
// the screen by the obliquity, as the opening view shows it, and the drag
// does not take that lean away (2026-10-11, asked for after a first try
// that kept the leaned axis up).
//
// So the rotation from the pivot's frame to the world is
//
//   V(λ, φ) = Rot(n, φ0 − φ) · Ry(λ),   n = c × u,
//
// with φ0 the latitude of c when the pivot is unturned (90° less the rig's
// hover angle): V(0, φ0) is the identity, the opening view. Ry turns about
// the vertical, then Rot tips the vertical in the c–u plane until c is at
// latitude φ. The latitude stays short of the vertical's poles
// (LATITUDE_LIMIT): past one the view would come out upside down.
//
// THE DRAG HOLDS THE GRABBED POINT. On pointer down, the cursor's ray meets
// the globe at a point g; the rig keeps g in the globe's own frame (it
// turns with the spin) and brings it into the pivot's frame every frame.
// While the drag goes on, solveGrab finds the (λ, φ) that put g back on the
// cursor's ray: φ such that the cursor's point has g's latitude about the
// new vertical, then λ such that it has g's longitude. Without roll there
// is one degree of freedom less than a free rotation has, but a point on
// the sphere needs only two: the fit is exact, except where the cursor's
// point is further from the screen's vertical plane than g's latitude
// allows (a grab near a pole of the vertical, dragged to the side) or the
// latitude is at its limit. There the view goes as near as it can.
//
// Off the globe (past the limb), the cursor's point is the point of the
// silhouette nearest to its ray: at the limb that is the point the ray
// touches, so the grab does not jump when the cursor leaves the globe.

export type Vec3 = [number, number, number]
// Row-major 3 × 3, applied to a column vector: v' = M v.
export type Mat3 = [number, number, number, number, number, number, number, number, number]

// The view centre's latitude stays inside ±85°.
export const LATITUDE_LIMIT = (85 * Math.PI) / 180

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s]
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const normalize = (a: Vec3): Vec3 => scale(a, 1 / Math.hypot(a[0], a[1], a[2]))
// The angle in (−π, π] that is a whole number of turns from `angle`.
export const wrapAngle = (angle: number): number => angle - 2 * Math.PI * Math.round(angle / (2 * Math.PI))

export const mulMat = (a: Mat3, b: Mat3): Mat3 => {
  const out = new Array(9) as Mat3
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]
  }
  return out
}
export const transpose = (m: Mat3): Mat3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]
export const mulVec = (m: Mat3, v: Vec3): Vec3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
]

// The turn about +y by `angle`, as Babylon's rotation.y turns: +x toward −z.
export const rotationY = (angle: number): Mat3 => {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return [c, 0, s, 0, 1, 0, -s, 0, c]
}
// The turn about +z by `angle`, as Babylon's rotation.z turns: +x toward +y.
export const rotationZ = (angle: number): Mat3 => {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return [c, -s, 0, s, c, 0, 0, 0, 1]
}
// The turn about the unit axis `n` by `angle` (Rodrigues), in the same
// sense as the two above.
export const rotationAbout = (n: Vec3, angle: number): Mat3 => {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const t = 1 - c
  const [x, y, z] = n
  return [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c,
  ]
}

// The quaternion (x, y, z, w) of a rotation matrix, as Babylon's Quaternion
// takes it: it turns a vector as the matrix does.
export const quaternionOfMatrix = (m: Mat3): [number, number, number, number] => {
  const trace = m[0] + m[4] + m[8]
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1)
    return [(m[7] - m[5]) * s, (m[2] - m[6]) * s, (m[3] - m[1]) * s, 0.25 / s]
  }
  if (m[0] > m[4] && m[0] > m[8]) {
    const s = 2 * Math.sqrt(1 + m[0] - m[4] - m[8])
    return [0.25 * s, (m[1] + m[3]) / s, (m[2] + m[6]) / s, (m[7] - m[5]) / s]
  }
  if (m[4] > m[8]) {
    const s = 2 * Math.sqrt(1 + m[4] - m[0] - m[8])
    return [(m[1] + m[3]) / s, 0.25 * s, (m[5] + m[7]) / s, (m[2] - m[6]) / s]
  }
  const s = 2 * Math.sqrt(1 + m[8] - m[0] - m[4])
  return [(m[2] + m[6]) / s, (m[5] + m[7]) / s, 0.25 * s, (m[3] - m[1]) / s]
}

// The longitude of a direction in a frame whose +y is its pole: it grows as
// rotationY turns, so rotationY(λ) adds λ to it.
export const longitudeOf = (v: Vec3): number => Math.atan2(-v[2], v[0])
export const latitudeOf = (v: Vec3): number => Math.asin(Math.max(-1, Math.min(1, v[1] / Math.hypot(v[0], v[1], v[2]))))

export interface GlobeViewBasis {
  // The view centre's direction (unit, from the globe's centre to the
  // camera's hover point), the screen's up along the surface there, and the
  // screen's horizontal axis n = c × u, about which the vertical tips.
  c: Vec3
  u: Vec3
  n: Vec3
  // The latitude of c when the pivot is unturned: V(0, φ0) is the identity.
  phi0: number
}

// The basis of a camera that hovers over `hoverDirection` with world +y as
// its up.
export function globeViewBasis(hoverDirection: Vec3): GlobeViewBasis {
  const c = normalize(hoverDirection)
  const u = normalize(add([0, 1, 0], scale(c, -c[1])))
  return { c, u, n: cross(c, u), phi0: Math.asin(c[1]) }
}

// V(λ, φ): from the pivot's frame to the world.
export const viewRotation = (basis: GlobeViewBasis, lambda: number, phi: number): Mat3 =>
  mulMat(rotationAbout(basis.n, basis.phi0 - phi), rotationY(lambda))

// The globe's own frame in the pivot's: leaned about the pivot's z by
// `lean` (the obliquity), then turned about its own, leaned +y by `turn`
// (the spin) — as Babylon composes a node with rotation.z = lean and a
// child with rotation.y = turn.
export const globeFrameRotation = (lean: number, turn: number): Mat3 => mulMat(rotationZ(lean), rotationY(turn))

// Where the cursor's ray (origin, unit direction; world, globe at the
// origin) meets the globe: the nearer crossing, or off the globe the point
// of the silhouette nearest to the ray. On the unit sphere of directions.
export function surfaceUnderRay(origin: Vec3, direction: Vec3, radius: number): { point: Vec3; onGlobe: boolean } {
  const b = dot(origin, direction)
  const c = dot(origin, origin) - radius * radius
  const disc = b * b - c
  if (disc >= 0) {
    const t = -b - Math.sqrt(disc)
    if (t > 0) return { point: normalize(add(origin, scale(direction, t))), onGlobe: true }
  }
  // The silhouette: the circle of tangent points, centred on the line to
  // the eye at radius² / |o| from the globe's centre. Its point toward the
  // ray is along the ray's part across that line.
  const distance = Math.sqrt(dot(origin, origin))
  const toEye = scale(origin, 1 / distance)
  const across = add(direction, scale(toEye, -dot(direction, toEye)))
  const acrossLength = Math.hypot(across[0], across[1], across[2])
  if (acrossLength < 1e-12) return { point: toEye, onGlobe: false }
  const along = radius / distance
  const out = Math.sqrt(Math.max(0, 1 - along * along))
  return { point: add(scale(toEye, along), scale(across, out / acrossLength)), onGlobe: false }
}

// The (λ, φ) that put `grabbed` (unit, in the pivot's frame) on `target`
// (unit, world): exact where it can be, else as near as it can. The
// answer nearest to (λNow, φNow) when there are two; λ is kept a whole
// number of turns from λNow, so that it changes smoothly.
export function solveGrab(basis: GlobeViewBasis, grabbed: Vec3, target: Vec3, lambdaNow: number, phiNow: number, phiLimit = LATITUDE_LIMIT): { lambda: number; phi: number } {
  const { c, u } = basis
  // The vertical is a(φ) = sin φ · c + cos φ · u, so the target's height on it
  // is t · a = R sin(φ + δ). It must be g's: sin φg.
  const tc = dot(target, c)
  const tu = dot(target, u)
  const r = Math.hypot(tc, tu)
  let phi = phiNow
  if (r > 1e-9) {
    const delta = Math.atan2(tu, tc)
    const s = grabbed[1] / r
    if (Math.abs(s) <= 1) {
      const a1 = wrapAngle(Math.asin(s) - delta)
      const a2 = wrapAngle(Math.PI - Math.asin(s) - delta)
      // Only a vertical on the screen's upper side is a view (|φ| < 90°).
      const valid = [a1, a2].filter((a) => Math.abs(a) < Math.PI / 2)
      if (valid.length > 0) phi = valid.reduce((best, a) => (Math.abs(a - phiNow) < Math.abs(best - phiNow) ? a : best))
    } else {
      // Out of reach: the vertical as near to the target's side as it goes.
      phi = wrapAngle(Math.sign(s) * (Math.PI / 2) - delta)
      if (Math.abs(phi) >= Math.PI / 2) phi = Math.sign(phi) * (Math.PI / 2)
    }
  }
  phi = Math.max(-phiLimit, Math.min(phiLimit, phi))
  // The longitude: the target in the pivot's frame at the new latitude, less
  // g's own longitude.
  const tipped = mulVec(transpose(rotationAbout(basis.n, basis.phi0 - phi)), target)
  const lambda = lambdaNow + wrapAngle(longitudeOf(tipped) - longitudeOf(grabbed) - lambdaNow)
  return { lambda, phi }
}

// THE VELOCITY AT RELEASE: a straight line fitted (least squares) through
// the view's last samples, those of the last `windowSeconds`. One sample
// per frame, so a pointer that stops before the release gives a velocity
// that falls to zero, and a burst of events in one frame is spread over
// the window.
export interface VelocityEstimator {
  add(time: number, lambda: number, phi: number): void
  // Radians per second, (λ, φ); zero with fewer than two samples.
  velocity(): { lambda: number; phi: number }
  clear(): void
}

export function createVelocityEstimator(windowSeconds = 0.1): VelocityEstimator {
  let samples: { time: number; lambda: number; phi: number }[] = []
  return {
    add(time, lambda, phi) {
      samples.push({ time, lambda, phi })
      samples = samples.filter((s) => time - s.time <= windowSeconds)
    },
    velocity() {
      if (samples.length < 2) return { lambda: 0, phi: 0 }
      const n = samples.length
      const meanT = samples.reduce((sum, s) => sum + s.time, 0) / n
      const meanL = samples.reduce((sum, s) => sum + s.lambda, 0) / n
      const meanP = samples.reduce((sum, s) => sum + s.phi, 0) / n
      let tt = 0
      let tl = 0
      let tp = 0
      for (const s of samples) {
        tt += (s.time - meanT) ** 2
        tl += (s.time - meanT) * (s.lambda - meanL)
        tp += (s.time - meanT) * (s.phi - meanP)
      }
      return tt > 0 ? { lambda: tl / tt, phi: tp / tt } : { lambda: 0, phi: 0 }
    },
    clear() {
      samples = []
    },
  }
}

// THE MOMENTUM: after the release the velocity falls as e^(−t / τ). One
// frame of `dt` seconds moves by the exact integral, v τ (1 − e^(−dt / τ)),
// and leaves v e^(−dt / τ): the path and the stop are the same at any frame
// rate.
export function momentumStep(velocity: number, dt: number, timeConstant: number): { move: number; velocity: number } {
  const decay = Math.exp(-dt / timeConstant)
  return { move: velocity * timeConstant * (1 - decay), velocity: velocity * decay }
}
