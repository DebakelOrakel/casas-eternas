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
