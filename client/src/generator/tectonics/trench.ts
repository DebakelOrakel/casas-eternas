import type { Domain } from '../core/domain'
import { derivePlateTypes } from '../crust/raftField'
import { oceanFloorAtAge, type BaselineTerm } from '../elevation/elevationField'
import { RIDGE_CREST, SLOPE_FOOT_T } from '../elevation/elevationScale'
import { classifyBoundary } from './boundaryClassification'
import { classifyBoundaryMotion } from './plateVelocityDecomposition'
import type { PlateSimulation } from './plateSimulationTypes'
import { TECTONICS_TUNING } from './tectonicsTuneParams'

// THE TRENCH (DEC-0036 phase 8e): the floor the slab holds down where an
// oceanic plate subducts, as a term under the tectonic baseline
// (elevationField.raftBaselineAt's `below`). The history's engine applies
// the tectonic uplift on land only and the deep ocean is frozen, so before
// this term the history's ocean had no trench at all (its deepest point
// 5.8–5.9 km on the calibration's worlds, Earth's 10.9 km).
//
// WHERE: on the plate boundary itself — a trench is the subducting plate's
// leading edge (not the trench features of the synthesis, which stand
// TECTONICS_TUNING.trenchOffsetM inside the subducting plate and pile up
// wherever a boundary has been). At a point, the nearest two plates and
// the point's distance to their bisector, the boundary; the boundary is a
// trench where the two converge as a subduction or an island arc
// (boundaryClassification, the classification the boundary pass makes).
// The cross-section is a smoothstep from the axis to TECTONICS_TUNING
// .trenchHalfWidthM either side: Earth's trenches are 50–100 km wide.
//
// HOW DEEP: the trench's relief below the floor beside it grows with the
// down-going plate's age (Grellet & Dubois 1982; Hilde & Uyeda 1983): some
// 2 km on 15 Ma floor (Middle America), 3.5–4 km on 45 Ma floor
// (Peru–Chile, 7–8 km deep), 5 km on 150 Ma floor (Mariana, 10.9 km);
// Earth's trenches lie 3–4 km below the floor around them. The relief is a
// multiple of the floor's own thermal subsidence at the point
// (oceanFloorAtAge − RIDGE_CREST): the cooled plate's negative buoyancy,
// which pulls the slab down, is what that subsidence measures (isostasy).
// TECTONICS_TUNING.trenchReliefPerSubsidence 1.6 gives 2.3, 3.7 and 4.8 km
// for the three.
//
// A term of the BASELINE, not of the relief: the slab's pull holds the
// floor down — no load the plate carries — so the trench moves with the
// boundary and is gone the epoch its subduction stops, as the floor
// rebounds when the slab goes. The trench's inner wall is the overriding
// plate's continental slope, so the term fades to nothing at the slope's
// foot (SLOPE_FOOT_T): the shelf and the land keep their profile, and the
// land's own subsidence at a trench margin stays the engine's (the
// trench features' negative uplift, elevation/upliftField.ts).
//
// A function of the simulation's saved state alone (the seeds, their
// motions and ages, the rafts): a restored world evaluates the same term.
export function trenchDepression(sim: PlateSimulation): BaselineTerm | undefined {
  const domain: Domain = sim.domain
  const { seeds, motions, ages } = sim
  if (seeds.length < 2) return undefined
  const types = derivePlateTypes(seeds, sim.rafts, domain)
  const halfWidth = TECTONICS_TUNING.trenchHalfWidthM / domain.metresPerUnit
  const point = { x: 0, y: 0 }
  return (x, y, margin, age) => {
    if (margin >= SLOPE_FOOT_T) return 0
    domain.wrapPoint(x, y, point)
    let a = -1
    let b = -1
    let da = Infinity
    let db = Infinity
    for (let p = 0; p < seeds.length; p++) {
      const d = domain.distanceSq(point.x, point.y, seeds[p].x, seeds[p].y)
      if (d < da) {
        db = da
        b = a
        da = d
        a = p
      } else if (d < db) {
        db = d
        b = p
      }
    }
    // The distance to the bisector of the two seeds.
    const ab = Math.sqrt(domain.distanceSq(seeds[a].x, seeds[a].y, seeds[b].x, seeds[b].y))
    const s = ab > 0 ? (db - da) / (2 * ab) : Infinity
    if (!(s < halfWidth)) return 0
    const motion = classifyBoundaryMotion(point, seeds[a], motions[a], seeds[b], motions[b], domain).motionClass
    if (motion !== 'convergent') return 0
    const character = classifyBoundary(types[a], ages[a], types[b], ages[b], motion).character
    if (character !== 'subductionArc' && character !== 'islandArc') return 0
    const f = 1 - s / halfWidth
    const gate = 1 - margin / SLOPE_FOOT_T
    return TECTONICS_TUNING.trenchReliefPerSubsidence * (oceanFloorAtAge(age) - RIDGE_CREST) * f * f * (3 - 2 * f) * gate * gate
  }
}
