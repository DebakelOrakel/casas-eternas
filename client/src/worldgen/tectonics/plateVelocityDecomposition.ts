import type { PlateMotion } from './plateMotion'
import { getVelocityAt } from './plateMotion'
import type { PlateSeed } from './plateSeeds'
import { wrappedDelta } from '../core/toroidal'

export type BoundaryMotionClass = 'convergent' | 'divergent' | 'transform'

export interface BoundaryConvergence {
  // Rate the gap between the two plates is closing — positive =
  // convergent, negative = divergent.
  normal: number
  // Lateral shear component along the boundary — magnitude only matters
  // for classification, sign isn't independently meaningful here.
  tangential: number
  motionClass: BoundaryMotionClass
}

// How much bigger the tangential component needs to be than the normal
// component for a boundary point to read as primarily transform/shear
// rather than convergent or divergent with some incidental shear.
const TRANSFORM_DOMINANCE_RATIO = 2

// Full normal + tangential decomposition of relative plate velocity at a
// boundary point, per the decided A3 model: convergence "varies
// continuously along the boundary's length (head-on collision fading
// into oblique shear along the same boundary is a natural consequence)."
export function classifyBoundaryMotion(
  point: PlateSeed,
  seedA: PlateSeed,
  motionA: PlateMotion,
  seedB: PlateSeed,
  motionB: PlateMotion,
  width: number,
  height: number,
): BoundaryConvergence {
  const velocityA = getVelocityAt(point, motionA, width, height)
  const velocityB = getVelocityAt(point, motionB, width, height)
  const relVx = velocityA.vx - velocityB.vx
  const relVy = velocityA.vy - velocityB.vy

  // Unit vector from B's seed toward A's seed — the direction along
  // which the distance between the two plates is measured, wrapped like
  // everything else on this map.
  const dirX = wrappedDelta(seedA.x, seedB.x, width)
  const dirY = wrappedDelta(seedA.y, seedB.y, height)
  const dirLength = Math.sqrt(dirX * dirX + dirY * dirY) || 1
  const normalX = dirX / dirLength
  const normalY = dirY / dirLength
  // Tangential is normal rotated 90°.
  const tangentX = -normalY
  const tangentY = normalX

  // The A-to-B distance shrinks (converges) when relative velocity
  // points opposite the "B toward A" direction — hence the negation, so
  // that positive here means convergent, not divergent.
  const normal = -(relVx * normalX + relVy * normalY)
  const tangential = relVx * tangentX + relVy * tangentY

  const motionClass: BoundaryMotionClass =
    Math.abs(tangential) > Math.abs(normal) * TRANSFORM_DOMINANCE_RATIO ? 'transform' : normal > 0 ? 'convergent' : 'divergent'

  return { normal, tangential, motionClass }
}
