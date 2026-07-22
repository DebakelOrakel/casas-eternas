import type { PlateSeed } from './plateSeeds'
import { wrappedDelta } from './toroidal'

// Flat-torus analog of a real tectonic plate's Euler-pole rotation: each
// plate rotates about its own independent center point at its own
// angular speed, rather than having a separate "drift vector" plus a
// separate "self-spin" — one rotation naturally covers both ends of that
// spectrum depending on how far the center sits from the plate itself
// (far => mostly drifting in a near-straight line locally, near/inside
// => mostly spinning in place), the same way a real Euler pole does on a
// sphere. Rotating every plate about one *shared* center (e.g. the map's
// center) was considered and rejected: it only produces concentric shear
// bands (everything co-rotating around one axis), not the independently-
// varying convergent/divergent/transform motion real plate boundaries
// need — see the design discussion this followed from.
export interface PlateMotion {
  centerX: number
  centerY: number
  // Signed — direction (sign) and speed (magnitude) of rotation about
  // (centerX, centerY). Chosen so that the resulting linear speed at the
  // plate's own seed lands in a visually reasonable range (see
  // generatePlateMotions), not from any physically-meaningful unit yet.
  angularSpeed: number
}

// How far a plate's own rotation center is placed from its seed, as a
// multiple of the typical spacing between seeds — keeps the center
// "reasonably near" its own plate, which is what keeps the flat-map
// rotation well-behaved (see toroidal.ts's wrapped-delta approach this
// relies on): a torus doesn't admit arbitrary rotations as *global*
// isometries, but rotating one bounded plate's neighborhood around a
// nearby local center, using wrapped deltas, is perfectly well-posed.
const ROTATION_RADIUS_MIN_FACTOR = 0.5
const ROTATION_RADIUS_MAX_FACTOR = 2.5

// Target linear speed (pixels) at the plate's own seed — this is what's
// actually tuned for a reasonable-looking arrow; angularSpeed is then
// derived to reproduce it at whatever radius that plate ended up with
// (angularSpeed = speed / radius), rather than picking angularSpeed
// directly and letting arrow length vary wildly with radius.
const LINEAR_SPEED_MIN_PX = 30
const LINEAR_SPEED_MAX_PX = 90

export function generatePlateMotions(seeds: PlateSeed[], width: number, height: number, random: () => number): PlateMotion[] {
  const typicalSpacing = Math.sqrt((width * height) / seeds.length)
  return seeds.map((seed) => {
    const radius = (ROTATION_RADIUS_MIN_FACTOR + random() * (ROTATION_RADIUS_MAX_FACTOR - ROTATION_RADIUS_MIN_FACTOR)) * typicalSpacing
    const angle = random() * Math.PI * 2
    const centerX = seed.x + Math.cos(angle) * radius
    const centerY = seed.y + Math.sin(angle) * radius
    const targetSpeed = LINEAR_SPEED_MIN_PX + random() * (LINEAR_SPEED_MAX_PX - LINEAR_SPEED_MIN_PX)
    const direction = random() < 0.5 ? 1 : -1
    const angularSpeed = (direction * targetSpeed) / radius
    return { centerX, centerY, angularSpeed }
  })
}

// Instantaneous linear velocity at `point` given a rigid rotation about
// (centerX, centerY) — the flat-plane version of the sphere's ω × r:
// r is the (wrapped) offset from the rotation center to the point,
// velocity is r rotated 90° and scaled by angular speed.
export function getVelocityAt(point: PlateSeed, motion: PlateMotion, width: number, height: number): { vx: number; vy: number } {
  const rx = wrappedDelta(point.x, motion.centerX, width)
  const ry = wrappedDelta(point.y, motion.centerY, height)
  return { vx: -ry * motion.angularSpeed, vy: rx * motion.angularSpeed }
}
