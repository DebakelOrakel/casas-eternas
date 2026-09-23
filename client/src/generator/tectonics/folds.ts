import { capsuleWeight } from '../elevation/capsule'
import { ELEVATION_TUNING } from '../elevation/elevationTuneParams'
import { wrappedDelta } from '../core/toroidal'
import { wrapValue } from '../core/field'
import type { FeatureBuckets } from '../elevation/elevationField'
import { METERS_PER_CELL } from '../core/mapConfig'
import { TECTONICS_TUNING } from './tectonicsTuneParams'

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
export function foldFactorAt(buckets: FeatureBuckets, x: number, y: number, width: number, height: number): number {
  const { bucketsX, bucketsY, bucketSizeX, bucketSizeY } = buckets
  const centerBx = Math.min(bucketsX - 1, Math.floor(x / bucketSizeX))
  const centerBy = Math.min(bucketsY - 1, Math.floor(y / bucketSizeY))
  let bestWeight = 0
  let across = 0
  for (let dy = -1; dy <= 1; dy++) {
    const by = wrapValue(centerBy + dy, bucketsY)
    for (let dx = -1; dx <= 1; dx++) {
      const bx = wrapValue(centerBx + dx, bucketsX)
      for (const feature of buckets.buckets[by * bucketsX + bx]) {
        if (feature.kind !== 'range' || feature.thickness <= 0) continue
        const offX = wrappedDelta(x, feature.x, width)
        const offY = wrappedDelta(y, feature.y, height)
        const weight = capsuleWeight(offX, offY, feature.tangentX, feature.tangentY, ELEVATION_TUNING.rangeSegmentHalfLength, ELEVATION_TUNING.rangePerpRadius)
        if (weight <= bestWeight) continue
        bestWeight = weight
        // The signed distance across the range: along its normal.
        across = -offX * feature.tangentY + offY * feature.tangentX
      }
    }
  }
  if (bestWeight <= 0) return 1
  const wavelengthUnits = (TECTONICS_TUNING.foldWavelengthKm * 1000) / METERS_PER_CELL
  return 1 + TECTONICS_TUNING.foldAmplitude * Math.cos((2 * Math.PI * across) / wavelengthUnits)
}
