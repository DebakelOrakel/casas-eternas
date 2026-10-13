import { capsuleWeight } from '../elevation/capsule'
import { ELEVATION_TUNING } from '../elevation/elevationTuneParams'
import type { Domain } from '../core/domain'
import { nearFeatureBuckets, rangePerpRadius, type FeatureBuckets } from '../elevation/elevationField'
import { TECTONICS_TUNING } from './tectonicsTuneParams'
import { detCos, detSin } from '../core/detMath'

// The offset `domain.delta` writes into: one per module, so no call
// allocates. Read it at once, before the next delta.
const offset = { x: 0, y: 0 }

// FOLDS (ADAPTIVE_MESH_PLAN.md phase 5.7): at a convergent margin the
// uplift is not a smooth dome but a train of anticlines and synclines
// ACROSS the convergence direction — the crust buckles under the
// shortening, at a wavelength of a few times its competent thickness
// (order 10–20 km) — so the range rises as parallel ridges and valleys
// before any river has cut one. The term is periodic in the distance from
// the range's axis along the range's normal: uplift × (1 + amplitude ·
// cos(2π d / λ)), an anticline on the axis; it modulates the uplift, it
// adds none, so the range's budget is the same. No thrusts, no state: the
// fold is a pattern in the forcing, the relief remembers it. A dip is the
// pattern's gradient over a node's neighbours when something wants one
// (hydrogeology, 5a); nothing does yet.
//
// The nearest active range feature by capsule weight sets the axis a node
// folds against; a node under no range folds not at all (factor 1). The
// mesh resolves the train where it is dense (an orogen's nodes stand
// 2–4 km apart, four to seven per wavelength); the raster at 7.8 km does
// not, which is one more thing the mesh sees that the raster averaged.

// The uplift's multiplier at a world point, from the range features.
//
// `spacingUnits`: the width of the cell the factor stands for (a mesh
// node's, √ of its Voronoi area, domain units); 0 for a point. The train is
// averaged over that width across the range — the mean of the cosine over
// a window of width s is sinc(π s / λ) times its value at the centre — so a
// node as wide as the wavelength or wider takes the train's mean, nearly 1,
// and not the value at its centre. Sampled at the centre (until DEC-0036
// phase 8c), the history's nodes (8–31 km on land against λ 15 km) took
// the train as node-to-node noise of ±amplitude in the uplift: closed
// basins between neighbours wherever a range rose, measured as 1–2 points
// of the land under lakes (npm run calibrate, foldAmplitude 0 against
// 0.5).
export function foldFactorAt(buckets: FeatureBuckets, x: number, y: number, domain: Domain, spacingUnits = 0): number {
  const nearCount = nearFeatureBuckets(buckets, x, y)
  let bestWeight = 0
  let across = 0
  const perpRadius = rangePerpRadius(domain)
  for (let k = 0; k < nearCount; k++) {
    for (const feature of buckets.buckets[buckets.near[k]]) {
      if (feature.kind !== 'range' || feature.thickness <= 0) continue
      domain.delta(x, y, feature.x, feature.y, offset)
      const offX = offset.x
      const offY = offset.y
      const weight = capsuleWeight(offX, offY, feature.tangentX, feature.tangentY, ELEVATION_TUNING.rangeSegmentHalfLength, perpRadius)
      if (weight <= bestWeight) continue
      bestWeight = weight
      // The signed distance across the range: along its normal.
      across = -offX * feature.tangentY + offY * feature.tangentX
    }
  }
  if (bestWeight <= 0) return 1
  const wavelengthUnits = (TECTONICS_TUNING.foldWavelengthKm * 1000) / domain.metresPerUnit
  const window = (Math.PI * spacingUnits) / wavelengthUnits
  const mean = window > 0 ? detSin(window) / window : 1
  return 1 + TECTONICS_TUNING.foldAmplitude * mean * detCos((2 * Math.PI * across) / wavelengthUnits)
}
