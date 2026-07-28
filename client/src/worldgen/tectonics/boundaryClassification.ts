import type { PlateType } from './plateTypes'
import type { BoundaryMotionClass } from './plateVelocityDecomposition'

export type BoundaryCharacter =
  | 'foldMountains' // continental-continental convergent
  | 'subductionArc' // oceanic-continental convergent (asymmetric: uplift on the continental side)
  | 'islandArc' // oceanic-oceanic convergent (asymmetric: uplift on the younger, less-dense side)
  | 'riftValley' // divergent, at least one continental side
  | 'midOceanRidge' // oceanic-oceanic divergent
  | 'transformFault' // any pair, shear-dominated

export interface BoundaryClassification {
  character: BoundaryCharacter
  // Which plate of the pair actually accumulates uplift — for
  // subduction/island-arc collisions this is asymmetric (the subducting
  // side doesn't build its own mountains); fold mountains build on both
  // sides at once, same as a real continent-continent collision.
  upliftSide: 'a' | 'b' | 'both'
  // Multiplier on top of the raw convergence rate — separate per-epoch
  // age-based tuning (younger collisions build faster) applies on top of
  // this in plateSimulation.ts, not here.
  rate: number
  // Direction the deposited amount pushes elevation: +1 builds up
  // (mountains, arcs, ridges), -1 sinks (rift valleys stretching/thinning
  // the crust), 0 deposits nothing. Divergent boundaries don't all sink —
  // mid-ocean ridges are young, hot, volcanically active crust that sits
  // *higher* than the surrounding old ocean floor despite being
  // divergent, so this can't just be inferred from convergence's own
  // sign. Transform is 0 (not -1/+1 with a near-zero rate, actually 0) —
  // real strike-slip faults produce both slight pressure ridges and
  // slight sag-pond dips depending on exact fault-bend geometry we don't
  // model, so picking either sign would be arbitrary; staying flat until
  // real bend geometry exists to justify a direction is more honest than
  // guessing.
  elevationSign: 1 | 0 | -1
}

const FOLD_MOUNTAIN_RATE = 1.0
const SUBDUCTION_RATE = 0.8
const ISLAND_ARC_RATE = 0.6
const RIFT_VALLEY_RATE = 0.5
const MID_OCEAN_RIDGE_RATE = 0.3
const TRANSFORM_RATE = 0.15

// Convergent-motion classification: (plate type pairing) decides the
// mountain-building character, per the decided elevation model's
// boundary table. Age decides which side of an oceanic-oceanic pair
// subducts — older, denser crust sinks, uplift happens on the younger
// side — the same tiebreak the initial-state doc calls for.
export function classifyBoundary(typeA: PlateType, ageA: number, typeB: PlateType, ageB: number, motionClass: BoundaryMotionClass): BoundaryClassification {
  if (motionClass === 'transform') {
    return { character: 'transformFault', upliftSide: 'both', rate: TRANSFORM_RATE, elevationSign: 0 }
  }

  const bothContinental = typeA === 'continental' && typeB === 'continental'
  const bothOceanic = typeA === 'oceanic' && typeB === 'oceanic'

  if (motionClass === 'convergent') {
    if (bothContinental) return { character: 'foldMountains', upliftSide: 'both', rate: FOLD_MOUNTAIN_RATE, elevationSign: 1 }
    if (bothOceanic) {
      const upliftSide = ageA <= ageB ? 'a' : 'b'
      return { character: 'islandArc', upliftSide, rate: ISLAND_ARC_RATE, elevationSign: 1 }
    }
    return { character: 'subductionArc', upliftSide: typeA === 'continental' ? 'a' : 'b', rate: SUBDUCTION_RATE, elevationSign: 1 }
  }

  // Divergent: mid-ocean ridges rise (young volcanic crust), rift valleys
  // sink (stretching/thinning) — opposite signs despite both being
  // divergent, which is why elevationSign is its own explicit field
  // rather than derived from convergence's sign.
  if (bothOceanic) return { character: 'midOceanRidge', upliftSide: 'both', rate: MID_OCEAN_RIDGE_RATE, elevationSign: 1 }
  return { character: 'riftValley', upliftSide: 'both', rate: RIFT_VALLEY_RATE, elevationSign: -1 }
}
