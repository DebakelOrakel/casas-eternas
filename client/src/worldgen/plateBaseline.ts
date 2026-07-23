import type { PlateType } from './plateTypes'

// Baseline elevation per plate, in the -1..1 (0 = sea level) convention —
// the "base" term the isostasy-style elevation query (elevationField.ts)
// adds terrain-feature uplift on top of. Continental crust is less dense
// than oceanic crust and floats higher on the mantle (isostasy), which is
// why continents and ocean floors sit at different baseline elevations
// even before any collision ever happens.
const CONTINENTAL_BASELINE = 0.35
const OCEANIC_BASELINE = -0.45
const BASELINE_JITTER = 0.1

export function generateBaseElevations(types: PlateType[], random: () => number): number[] {
  return types.map((type) => {
    const base = type === 'continental' ? CONTINENTAL_BASELINE : OCEANIC_BASELINE
    return base + (random() * 2 - 1) * BASELINE_JITTER
  })
}

// Real oceanic crust cools and densifies as it ages away from the ridge
// that formed it, and sinks as a result — the well-established "age-
// depth" relationship, where depth grows roughly with the square root of
// age. Our terrain-feature uplift has no equivalent counterweight: every
// oceanic-oceanic boundary interaction (both midOceanRidge, a divergent
// character, AND islandArc, a convergent one — see
// boundaryClassification.ts) deposits *positive* elevationSign uplift
// with nothing else ever pushing purely-oceanic crust back down over
// time, only THICKNESS_DECAY_PER_EPOCH's slow 1%/epoch relaxation toward
// (not below) the fixed baseline above. Confirmed empirically: over a
// few hundred epochs, oceanic seafloor visibly trended toward
// accumulating enough ridge/arc uplift to rise above sea level in more
// and more places, with no mechanism to reverse it. This applies a
// small per-epoch-age subsidence specifically to oceanic plates' own
// baseline (continental crust doesn't thermally subside the same way,
// so left alone) — a deliberately minimal fix targeting the actual
// missing mechanism, not a full density/thickness isostasy rewrite: the
// existing baseline+uplift model doesn't track real crustal thickness or
// density at all, and doesn't need to in order to fix this specific
// imbalance.
const OCEANIC_SUBSIDENCE_SCALE = 0.02

export function computeAgedBaseElevations(baseElevations: number[], types: PlateType[], ages: number[]): number[] {
  return baseElevations.map((base, i) => (types[i] === 'oceanic' ? base - OCEANIC_SUBSIDENCE_SCALE * Math.sqrt(ages[i]) : base))
}
