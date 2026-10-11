import type { PlateSeed } from './plateSeeds'
import { globeFrame, type Domain, type GlobeNoise } from '../core/domain'
import { mantleMesh, type MantleFlow } from '../mantle/mantleField'
import { detAcos, detCos, detSin } from '../core/detMath'

// The offset `domain.delta` writes into: one per module, so no call
// allocates. Read it at once, before the next delta.
const offset = { x: 0, y: 0 }

// Flat-torus analog of a real tectonic plate's Euler-pole rotation, stored in a
// RIGID-BODY form: a drift (translation) plus a spin (rotation about the plate's
// own centroid). This is equivalent to a single Euler pole — a rotation about an
// offset center decomposes exactly into rotation-about-centroid + a constant
// drift — but it's the form the future mantle-field coupling needs (a net flow
// under a plate fits cleanly to drift+spin, whereas migrating a single pole does
// not). See docs/decisions/evolving-euler-poles.md. For now the motion is still
// generated once and fixed for the plate's life; the field-driven update comes in
// Phase M2. Rotating about a *shared* center was considered and rejected (only
// concentric shear, not independent convergent/divergent/transform boundaries).
//
// ON THE SPHERE (DEC-0035, step 4d3) a rigid motion of the surface IS one
// rotation about an axis through the centre, and the plates move as such:
// `EulerMotion`, an Euler pole (a unit vector in the globe's frame,
// Domain.noise.frame) and an angular rate about it. The torus keeps the
// drift + spin form above (`RigidMotion`), its data and its arithmetic
// untouched. One type for both, `PlateMotion`; the functions below are the
// interface the rest of tectonics uses (the velocity at a point, a point
// moved forward and back, a motion fitted to the mantle flow, relaxed
// toward one, or made to move with a velocity at a point), and each one
// tells the two forms apart by the motion's own fields (isEulerMotion) —
// a sphere world holds only Euler motions, a torus world only rigid ones.
export type PlateMotion = RigidMotion | EulerMotion

export interface RigidMotion {
  // Translation per unit spin-angle (the same abstract time unit angularSpeed
  // used) — the velocity a point AT the centroid has.
  driftX: number
  driftY: number
  // Signed angular speed about (centroidX, centroidY): direction (sign) + rate.
  spin: number
  // The plate's reference point the spin turns about (its seed at generation).
  // Fixed — velocity is invariant to this choice since drift compensates.
  centroidX: number
  centroidY: number
}

// A plate's motion on the sphere: the rotation about the unit axis
// (poleX, poleY, poleZ) — the Euler pole, in the globe's frame, where
// Domain.noise.frame puts a point — at `rate` radians per unit of the
// torus's spin-angle time (so a velocity ω × r is in domain units per
// that unit, like the torus's drift, and an epoch is a turn by
// rate · epochAngleStep). Right-handed about the pole, rate ≥ 0: a motion
// at rest keeps its last pole and has rate 0.
export interface EulerMotion {
  poleX: number
  poleY: number
  poleZ: number
  rate: number
}

export function isEulerMotion(motion: PlateMotion): motion is EulerMotion {
  return 'rate' in motion
}

// The globe the sphere's motions are written in.
function globeOf(domain: Domain): GlobeNoise {
  const space = domain.noise
  if (space.kind !== 'globe') throw new Error('an Euler motion moves on a globe; this domain has none')
  return space
}

// Frames and a point held per module, so the hot loops allocate nothing.
const frameA = globeFrame()
const locatePoint = { x: 0, y: 0 }

// The motion of ω = (wx, wy, wz) as an EulerMotion, its pole kept from
// `previous` when ω is 0.
function eulerOf(wx: number, wy: number, wz: number, previous?: EulerMotion): EulerMotion {
  const rate = Math.sqrt(wx * wx + wy * wy + wz * wz)
  if (rate === 0) return { poleX: previous?.poleX ?? 0, poleY: previous?.poleY ?? 0, poleZ: previous?.poleZ ?? 1, rate: 0 }
  return { poleX: wx / rate, poleY: wy / rate, poleZ: wz / rate, rate }
}

// The point (x, y) turned by `angle` radians about the unit axis k
// (Rodrigues: v cos a + (k × v) sin a + k (k · v)(1 − cos a)), named in
// the chart again. Exact up to rounding, so a turn by −angle returns.
function rotateOnGlobe(x: number, y: number, kx: number, ky: number, kz: number, angle: number, domain: Domain): { x: number; y: number } {
  const globe = globeOf(domain)
  globe.frame(x, y, frameA)
  const vx = frameA.px
  const vy = frameA.py
  const vz = frameA.pz
  const c = detCos(angle)
  const s = detSin(angle)
  const kv = (kx * vx + ky * vy + kz * vz) * (1 - c)
  const rx = vx * c + (ky * vz - kz * vy) * s + kx * kv
  const ry = vy * c + (kz * vx - kx * vz) * s + ky * kv
  const rz = vz * c + (kx * vy - ky * vx) * s + kz * kv
  globe.locate(rx, ry, rz, locatePoint)
  return { x: locatePoint.x, y: locatePoint.y }
}

// The Euler pole of a fresh sphere plate: at an arc of 30° to 90° from its
// seed (sin θ from 0.5 to 1 — Earth's plates turn about poles of that order
// from their interiors), in a random direction, at the rate that gives the
// seed the torus's speed range, LINEAR_SPEED_MIN_PX..MAX_PX. The same four
// draws per plate as the torus.
const EULER_POLE_ARC_MIN = Math.PI / 6
const EULER_POLE_ARC_MAX = Math.PI / 2

function generateEulerMotion(seed: PlateSeed, domain: Domain, random: () => number): EulerMotion {
  const globe = globeOf(domain)
  globe.frame(seed.x, seed.y, frameA)
  const arc = EULER_POLE_ARC_MIN + random() * (EULER_POLE_ARC_MAX - EULER_POLE_ARC_MIN)
  const azimuth = random() * Math.PI * 2
  const targetSpeed = LINEAR_SPEED_MIN_PX + random() * (LINEAR_SPEED_MAX_PX - LINEAR_SPEED_MIN_PX)
  const direction = random() < 0.5 ? 1 : -1
  // The pole: the seed's unit vector turned by `arc` toward the azimuth's
  // tangent direction, cos(azimuth) east + sin(azimuth) south.
  const R = globe.radius
  const ca = detCos(arc)
  const sa = detSin(arc)
  const ce = detCos(azimuth)
  const se = detSin(azimuth)
  const tx = ce * frameA.ex + se * frameA.sx
  const ty = ce * frameA.ey + se * frameA.sy
  const tz = ce * frameA.ez + se * frameA.sz
  const kx = (frameA.px / R) * ca + tx * sa
  const ky = (frameA.py / R) * ca + ty * sa
  const kz = (frameA.pz / R) * ca + tz * sa
  // |v| at the seed = rate · R · sin(arc).
  const rate = targetSpeed / (R * sa)
  return eulerOf(direction * rate * kx, direction * rate * ky, direction * rate * kz)
}

// How far a plate's own rotation center is placed from its seed, as a multiple
// of the typical spacing between seeds (see the pre-refactor note: keeps the
// implied rotation well-behaved on the torus via wrapped deltas).
const ROTATION_RADIUS_MIN_FACTOR = 0.5
const ROTATION_RADIUS_MAX_FACTOR = 2.5

// Target linear speed, in world pixels per full unit of angular speed, at the
// plate's own seed; spin is derived to reproduce it at whatever radius the plate
// ended up with. The range was originally chosen to make a legible velocity arrow
// on a debug overlay that no longer exists — it survives as the calibration these
// numbers were actually fitted to, not as something still checkable on screen.
const LINEAR_SPEED_MIN_PX = 30
const LINEAR_SPEED_MAX_PX = 90

export function generatePlateMotions(seeds: PlateSeed[], domain: Domain, random: () => number): PlateMotion[] {
  if (domain.noise.kind === 'globe') return seeds.map((seed) => generateEulerMotion(seed, domain, random))
  const typicalSpacing = Math.sqrt((domain.width * domain.height) / seeds.length)
  return seeds.map((seed) => {
    // Same draw as before (an offset Euler center + a signed angular speed),
    // then decomposed into the equivalent drift+spin about the seed. Keeps the
    // motion distribution identical to the pre-refactor generator.
    const radius = (ROTATION_RADIUS_MIN_FACTOR + random() * (ROTATION_RADIUS_MAX_FACTOR - ROTATION_RADIUS_MIN_FACTOR)) * typicalSpacing
    const angle = random() * Math.PI * 2
    const centerX = seed.x + detCos(angle) * radius
    const centerY = seed.y + detSin(angle) * radius
    const targetSpeed = LINEAR_SPEED_MIN_PX + random() * (LINEAR_SPEED_MAX_PX - LINEAR_SPEED_MIN_PX)
    const direction = random() < 0.5 ? 1 : -1
    const spin = (direction * targetSpeed) / radius
    // Velocity of the centroid (= seed) under rotation about the offset center:
    // ω · ẑ × (centroid − center). ẑ × (rx, ry) = (−ry, rx).
    domain.delta(seed.x, seed.y, centerX, centerY, offset)
    const rx = offset.x
    const ry = offset.y
    return { driftX: -ry * spin, driftY: rx * spin, spin, centroidX: seed.x, centroidY: seed.y }
  })
}

// Instantaneous linear velocity at `point`: drift + spin · (ẑ × r), where r is
// the wrapped offset from the centroid to the point. Equivalent to the old
// ω × r about an offset Euler center (drift folds in the center offset).
// On the sphere ω × r, r the point's position R · u, read in its east/south
// frame: tangent by construction, |v| = rate · R · sin θ (θ the arc to the
// pole).
export function getVelocityAt(point: PlateSeed, motion: PlateMotion, domain: Domain): { vx: number; vy: number } {
  if (isEulerMotion(motion)) {
    globeOf(domain).frame(point.x, point.y, frameA)
    const wx = motion.poleX * motion.rate
    const wy = motion.poleY * motion.rate
    const wz = motion.poleZ * motion.rate
    const vx = wy * frameA.pz - wz * frameA.py
    const vy = wz * frameA.px - wx * frameA.pz
    const vz = wx * frameA.py - wy * frameA.px
    return { vx: vx * frameA.ex + vy * frameA.ey + vz * frameA.ez, vy: vx * frameA.sx + vy * frameA.sy + vz * frameA.sz }
  }
  domain.delta(point.x, point.y, motion.centroidX, motion.centroidY, offset)
  const rx = offset.x
  const ry = offset.y
  return { vx: motion.driftX - ry * motion.spin, vy: motion.driftY + rx * motion.spin }
}

// Advances a point by one finite motion step: rotate about the centroid by
// `spin · step`, then translate by `drift · step` (wrapped). Replaces the old
// pure rotation advection (Domain.rotateAround) — a rigid transform (rotation + translation),
// the drift+spin form of the same per-epoch move.
// On the sphere the turn about the Euler pole by rate · step.
export function advancePointByMotion(x: number, y: number, motion: PlateMotion, step: number, domain: Domain): { x: number; y: number } {
  if (isEulerMotion(motion)) return rotateOnGlobe(x, y, motion.poleX, motion.poleY, motion.poleZ, motion.rate * step, domain)
  const rotated = domain.rotateAround(x, y, motion.centroidX, motion.centroidY, motion.spin * step)
  domain.advance(rotated.x, rotated.y, motion.driftX * step, motion.driftY * step, rotated)
  return rotated
}

// The inverse of advancePointByMotion — used for ocean-age's backward
// semi-Lagrangian step (where does the material now here come FROM). Undo the
// translation first, then the rotation: p = R(−θ)(p' − drift·step).
// On the sphere the turn back, by −rate · step.
export function reversePointByMotion(x: number, y: number, motion: PlateMotion, step: number, domain: Domain): { x: number; y: number } {
  if (isEulerMotion(motion)) return rotateOnGlobe(x, y, motion.poleX, motion.poleY, motion.poleZ, -motion.rate * step, domain)
  const untranslatedX = x - motion.driftX * step
  const untranslatedY = y - motion.driftY * step
  return domain.rotateAround(untranslatedX, untranslatedY, motion.centroidX, motion.centroidY, -motion.spin * step)
}

// Fits each plate's rigid motion {drift, spin} to the mantle flow under its
// footprint (every cell of the mantle's field mesh assigned to its nearest
// plate seed → least-squares rigid fit about that seed, each cell weighted by
// its area). This is the TARGET motion; the caller blends it with the previous
// motion for inertia. centroid = current seed.
//
// Lives here rather than beside the field it reads: it speaks PlateSeed in and
// PlateMotion out, so keeping it in `mantle/` would have made the substrate
// depend on what rides on it. It iterates the MANTLE's cells, hence the import.
//
// On the sphere the rigid fit is ω's: the least-squares ω with ω × r_i
// closest to the flow u_i (the cell's east/south flow as a 3D tangent
// vector) over the plate's cells, each weighted by its area:
// Σ w (|r|² I − r rᵀ) ω = Σ w (r × u), a 3 × 3 system per plate.
export function fitMotionsToFlow(seeds: PlateSeed[], flow: MantleFlow, domain: Domain): PlateMotion[] {
  if (domain.noise.kind === 'globe') return fitEulerMotionsToFlow(seeds, flow, domain)
  const { mesh, totalArea } = mantleMesh(domain)
  // Areas in units of the mean cell: 1 per cell on the torus's even hexagons,
  // so a sum below counts cells as the raster's did.
  const unit = mesh.count / totalArea
  const n = seeds.length
  const sumUx = new Float64Array(n)
  const sumUy = new Float64Array(n)
  const sumCross = new Float64Array(n)
  const sumRsq = new Float64Array(n)
  const weight = new Float64Array(n)
  for (let i = 0; i < mesh.count; i++) {
    const wx = mesh.x[i]
    const wy = mesh.y[i]
    const best = nearestSeed(seeds, wx, wy, domain)
    const w = mesh.area[i] * unit
    const ux = flow.east[i]
    const uy = flow.south[i]
    domain.delta(wx, wy, seeds[best].x, seeds[best].y, offset)
    const rx = offset.x
    const ry = offset.y
    sumUx[best] += w * ux
    sumUy[best] += w * uy
    sumCross[best] += w * (rx * uy - ry * ux)
    sumRsq[best] += w * (rx * rx + ry * ry)
    weight[best] += w
  }
  return seeds.map((seed, p) => ({
    driftX: weight[p] > 0 ? sumUx[p] / weight[p] : 0,
    driftY: weight[p] > 0 ? sumUy[p] / weight[p] : 0,
    spin: sumRsq[p] > 1e-6 ? sumCross[p] / sumRsq[p] : 0,
    centroidX: seed.x,
    centroidY: seed.y,
  }))
}

// The seed nearest (x, y), the first of equals.
function nearestSeed(seeds: PlateSeed[], x: number, y: number, domain: Domain): number {
  let best = 0
  let bestSq = Infinity
  for (let p = 0; p < seeds.length; p++) {
    const d = domain.distanceSq(x, y, seeds[p].x, seeds[p].y)
    if (d < bestSq) {
      bestSq = d
      best = p
    }
  }
  return best
}

function fitEulerMotionsToFlow(seeds: PlateSeed[], flow: MantleFlow, domain: Domain): EulerMotion[] {
  const globe = globeOf(domain)
  const { mesh } = mantleMesh(domain)
  const n = seeds.length
  // Per plate the six entries of the symmetric matrix (xx, yy, zz, xy, xz,
  // yz) and the right-hand side.
  const m = new Float64Array(n * 6)
  const b = new Float64Array(n * 3)
  for (let i = 0; i < mesh.count; i++) {
    const wx = mesh.x[i]
    const wy = mesh.y[i]
    const w = mesh.area[i]
    const best = nearestSeed(seeds, wx, wy, domain)
    const ue = flow.east[i]
    const us = flow.south[i]
    globe.frame(wx, wy, frameA)
    const ux = ue * frameA.ex + us * frameA.sx
    const uy = ue * frameA.ey + us * frameA.sy
    const uz = ue * frameA.ez + us * frameA.sz
    const rx = frameA.px
    const ry = frameA.py
    const rz = frameA.pz
    const rr = rx * rx + ry * ry + rz * rz
    const o = best * 6
    m[o] += w * (rr - rx * rx)
    m[o + 1] += w * (rr - ry * ry)
    m[o + 2] += w * (rr - rz * rz)
    m[o + 3] -= w * rx * ry
    m[o + 4] -= w * rx * rz
    m[o + 5] -= w * ry * rz
    b[best * 3] += w * (ry * uz - rz * uy)
    b[best * 3 + 1] += w * (rz * ux - rx * uz)
    b[best * 3 + 2] += w * (rx * uy - ry * ux)
  }
  return seeds.map((_, p) => {
    const o = p * 6
    // A plate over one cell, or a thin strip, leaves the spin about its own
    // vertical unconstrained (the matrix is singular along r): a ridge of a
    // millionth of the trace keeps that spin at 0 rather than at random,
    // and changes a well-posed fit by nothing measurable.
    const ridge = (m[o] + m[o + 1] + m[o + 2]) * 1e-6
    const a = m[o] + ridge
    const d = m[o + 1] + ridge
    const f = m[o + 2] + ridge
    const bb = m[o + 3]
    const c = m[o + 4]
    const e = m[o + 5]
    // [[a, bb, c], [bb, d, e], [c, e, f]] solved by its adjugate.
    const c00 = d * f - e * e
    const c01 = c * e - bb * f
    const c02 = bb * e - c * d
    const c11 = a * f - c * c
    const c12 = bb * c - a * e
    const c22 = a * d - bb * bb
    const det = a * c00 + bb * c01 + c * c02
    if (!(Math.abs(det) > 0)) return eulerOf(0, 0, 0)
    const b0 = b[p * 3]
    const b1 = b[p * 3 + 1]
    const b2 = b[p * 3 + 2]
    return eulerOf((c00 * b0 + c01 * b1 + c02 * b2) / det, (c01 * b0 + c11 * b1 + c12 * b2) / det, (c02 * b0 + c12 * b1 + c22 * b2) / det)
  })
}

// A plate's motion relaxed toward the fitted one by `rate` (the mantle
// coupling's inertia), in place. The torus: drift and spin each moved by
// the fraction, the reference point taken from the fit. The sphere: the
// angular velocity ω = rate · pole moved by the fraction, a vector.
export function relaxMotionToward(motion: PlateMotion, target: PlateMotion, fraction: number): void {
  if (isEulerMotion(motion) && isEulerMotion(target)) {
    const wx = motion.poleX * motion.rate
    const wy = motion.poleY * motion.rate
    const wz = motion.poleZ * motion.rate
    const relaxed = eulerOf(
      wx + (target.poleX * target.rate - wx) * fraction,
      wy + (target.poleY * target.rate - wy) * fraction,
      wz + (target.poleZ * target.rate - wz) * fraction,
      motion,
    )
    motion.poleX = relaxed.poleX
    motion.poleY = relaxed.poleY
    motion.poleZ = relaxed.poleZ
    motion.rate = relaxed.rate
    return
  }
  if (isEulerMotion(motion) || isEulerMotion(target)) throw new Error('a torus motion and a sphere motion cannot be blended')
  motion.driftX += (target.driftX - motion.driftX) * fraction
  motion.driftY += (target.driftY - motion.driftY) * fraction
  motion.spin += (target.spin - motion.spin) * fraction
  motion.centroidX = target.centroidX
  motion.centroidY = target.centroidY
}

// The motion that moves the point (x, y) with velocity (vx, vy) and does
// not turn about it — a new plate born between two flanks. The torus: that
// drift and no spin, about the point. The sphere: ω = (r × v) / |r|², the
// rotation whose ω × r is v and whose pole lies a quarter turn from the
// point.
export function motionMovingAt(x: number, y: number, vx: number, vy: number, domain: Domain): PlateMotion {
  if (domain.noise.kind !== 'globe') return { driftX: vx, driftY: vy, spin: 0, centroidX: x, centroidY: y }
  globeOf(domain).frame(x, y, frameA)
  const ux = vx * frameA.ex + vy * frameA.sx
  const uy = vx * frameA.ey + vy * frameA.sy
  const uz = vx * frameA.ez + vy * frameA.sz
  const rx = frameA.px
  const ry = frameA.py
  const rz = frameA.pz
  const rr = rx * rx + ry * ry + rz * rz
  return eulerOf((ry * uz - rz * uy) / rr, (rz * ux - rx * uz) / rr, (rx * uy - ry * ux) / rr)
}

// The arc, in radians, from a point to a motion's Euler pole — for a check
// of the velocity's rigidity (|v| = rate · R · sin θ). The sphere only.
export function arcToEulerPole(x: number, y: number, motion: EulerMotion, domain: Domain): number {
  const globe = globeOf(domain)
  globe.frame(x, y, frameA)
  const R = globe.radius
  const dot = (frameA.px * motion.poleX + frameA.py * motion.poleY + frameA.pz * motion.poleZ) / R
  return detAcos(Math.max(-1, Math.min(1, dot)))
}
