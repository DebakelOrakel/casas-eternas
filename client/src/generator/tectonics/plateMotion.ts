import type { PlateSeed } from './plateSeeds'
import { rotateAroundCenter, toroidalDistanceSq, wrappedDelta } from '../core/toroidal'
import { wrapValue } from '../core/field'
import { MANTLE_RES_X, MANTLE_RES_Y } from '../mantle/mantleField'
import { detCos, detSin } from '../core/detMath'

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
export interface PlateMotion {
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

export function generatePlateMotions(seeds: PlateSeed[], width: number, height: number, random: () => number): PlateMotion[] {
  const typicalSpacing = Math.sqrt((width * height) / seeds.length)
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
    const rx = wrappedDelta(seed.x, centerX, width)
    const ry = wrappedDelta(seed.y, centerY, height)
    return { driftX: -ry * spin, driftY: rx * spin, spin, centroidX: seed.x, centroidY: seed.y }
  })
}

// Instantaneous linear velocity at `point`: drift + spin · (ẑ × r), where r is
// the wrapped offset from the centroid to the point. Equivalent to the old
// ω × r about an offset Euler center (drift folds in the center offset).
export function getVelocityAt(point: PlateSeed, motion: PlateMotion, width: number, height: number): { vx: number; vy: number } {
  const rx = wrappedDelta(point.x, motion.centroidX, width)
  const ry = wrappedDelta(point.y, motion.centroidY, height)
  return { vx: motion.driftX - ry * motion.spin, vy: motion.driftY + rx * motion.spin }
}

// Advances a point by one finite motion step: rotate about the centroid by
// `spin · step`, then translate by `drift · step` (wrapped). Replaces the old
// pure rotateAroundCenter advection — a rigid transform (rotation + translation),
// the drift+spin form of the same per-epoch move.
export function advancePointByMotion(x: number, y: number, motion: PlateMotion, step: number, width: number, height: number): { x: number; y: number } {
  const rotated = rotateAroundCenter(x, y, motion.centroidX, motion.centroidY, motion.spin * step, width, height)
  return {
    x: wrapValue((rotated.x + motion.driftX * step), width),
    y: wrapValue((rotated.y + motion.driftY * step), height),
  }
}

// The inverse of advancePointByMotion — used for ocean-age's backward
// semi-Lagrangian step (where does the material now here come FROM). Undo the
// translation first, then the rotation: p = R(−θ)(p' − drift·step).
export function reversePointByMotion(x: number, y: number, motion: PlateMotion, step: number, width: number, height: number): { x: number; y: number } {
  const untranslatedX = x - motion.driftX * step
  const untranslatedY = y - motion.driftY * step
  return rotateAroundCenter(untranslatedX, untranslatedY, motion.centroidX, motion.centroidY, -motion.spin * step, width, height)
}

// Fits each plate's rigid motion {drift, spin} to the mantle flow under its
// footprint (every coarse mantle cell assigned to its nearest plate seed →
// least-squares rigid fit about that seed). This is the TARGET motion; the caller
// blends it with the previous motion for inertia. centroid = current seed.
//
// Lives here rather than beside the field it reads: it speaks PlateSeed in and
// PlateMotion out, so keeping it in `mantle/` would have made the substrate
// depend on what rides on it. It iterates the MANTLE grid, hence the import.
export function fitMotionsToFlow(seeds: PlateSeed[], flow: Float32Array, worldWidth: number, worldHeight: number): PlateMotion[] {
  const n = seeds.length
  const sumUx = new Float64Array(n)
  const sumUy = new Float64Array(n)
  const sumCross = new Float64Array(n)
  const sumRsq = new Float64Array(n)
  const count = new Int32Array(n)
  for (let gy = 0; gy < MANTLE_RES_Y; gy++) {
    const wy = ((gy + 0.5) / MANTLE_RES_Y) * worldHeight
    for (let gx = 0; gx < MANTLE_RES_X; gx++) {
      const wx = ((gx + 0.5) / MANTLE_RES_X) * worldWidth
      let best = 0
      let bestSq = Infinity
      for (let p = 0; p < n; p++) {
        const d = toroidalDistanceSq(wx, wy, seeds[p].x, seeds[p].y, worldWidth, worldHeight)
        if (d < bestSq) {
          bestSq = d
          best = p
        }
      }
      const i = gy * MANTLE_RES_X + gx
      const ux = flow[i * 2]
      const uy = flow[i * 2 + 1]
      const rx = wrappedDelta(wx, seeds[best].x, worldWidth)
      const ry = wrappedDelta(wy, seeds[best].y, worldHeight)
      sumUx[best] += ux
      sumUy[best] += uy
      sumCross[best] += rx * uy - ry * ux
      sumRsq[best] += rx * rx + ry * ry
      count[best] += 1
    }
  }
  return seeds.map((seed, p) => ({
    driftX: count[p] ? sumUx[p] / count[p] : 0,
    driftY: count[p] ? sumUy[p] / count[p] : 0,
    spin: sumRsq[p] > 1e-6 ? sumCross[p] / sumRsq[p] : 0,
    centroidX: seed.x,
    centroidY: seed.y,
  }))
}
