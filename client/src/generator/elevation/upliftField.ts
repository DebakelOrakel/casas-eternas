import type { TerrainFeature } from '../tectonics/terrainFeatures'
import { capsuleWeight } from './capsule'
import type { Domain } from '../core/domain'
import { buildFeatureBuckets, nearFeatureBuckets, rangeHalfLength, rangePerpRadius, trenchHalfLength, trenchPerpRadius } from './elevationField'
import { TECTONICS_TUNING } from '../tectonics/tectonicsTuneParams'
import { ELEVATION_TUNING } from './elevationTuneParams'

// U(x) — the tectonic uplift-rate field, the erosion-v2 engine's forcing
// (docs/design/erosion-v2.md, "The tectonics interface"). The v1 pass
// derives its uplift from the finished elevation raster (standing relief as
// its own forcing); v2 wants the CAUSE instead of the effect: where the
// tectonics simulation is actively building terrain right now.
//
// The features already know: every range/trench/rift feature carries the
// shortening rate of its boundary (TerrainFeature.shorteningKmPerMyr — the
// convergence its boundary points close, times the boundary character's
// rate and the age multiplier, as a moving mean of a few Ma). A range whose
// boundary closes is rising; one whose boundary went quiet forces nothing.
// U is the same capsule footprint the elevation kernel uses, weighted by
// that rate.
//
// Trenches and rifts carry a negative rate and so export negative U —
// active subsidence. The engine applies U on land only, which makes
// submarine trenches inert there by construction; rift valleys on land
// genuinely deepen, which is what a rift does.
//
// The capsule is computeElevation's (elevationField.ts) — the shared
// capsule.ts since 2026-09-22 — with the same max(1, weightSum) averaging,
// so U rises exactly where the mountains it feeds actually stand. The
// averaging also keeps the rate per length of boundary: the features of
// one stretch overlap, and each holds the mean of its boundary points.
//
// Scale (DEC-0036 phase 8g): the RATE of crustal thickening, mm/yr (=
// km/Myr) of rock added as height, before the plate's flexure takes its
// share. Mass is conserved across the section: a boundary that shortens at
// v thickens a crust of thickness Hc over the range's cross-section W at
// v Hc / W (TECTONICS_TUNING.orogenCrustM; W the capsule's integral across,
// ELEVATION_TUNING.rangePerpRadiusM — smoothstep's integral over its radius
// is a half, so both sides together give one radius). So a range rises as
// fast as its plates close and stops when they stop. One W for every kind:
// a trench's rate is its share of the arc's (trenchDepthFraction), as the
// thickness was. A hotspot or a flood basalt has no rate (no boundary
// shortens there); their edifices are the synthesis's deck, not the
// history's.
//
// Until phase 8g the field was the features' thickness weighted by their
// recency (thickness × 2^(−epochsSinceDeposit / 12)), normalised per world
// to a peak of 1 (× HISTORY_DEFAULTS.upliftScale 4, so 4 mm/yr at the
// peak). Its rate did not follow the plates, and the world's normaliser was
// a hotspot's pile for the first 15–25 epochs (four of four worlds
// measured): the hotspot's capsule on a continent stood under the full
// rate — the narrow 11–15 km ranges of phase 8f.
//
// The engine reads U × upliftDt (surface/erosionEngine.ts: 19.8 m per
// 20 kyr iteration at U = 1, 0.99 mm/yr), so U is the engine's uplift
// pattern in its own unit up to that 1 %.

// Samples U at `outWidth`×`outHeight` (climate resolution is the intended
// consumer grid — U is smooth by construction) over features living in
// world coordinates on `domain`. Returns mm/yr of crustal thickening
// (negative: thinning); all-zero when no feature shortens.
export function computeUpliftField(
  features: TerrainFeature[],
  domain: Domain,
  outWidth: number,
  outHeight: number,
): Float32Array {
  const result = new Float32Array(outWidth * outHeight)
  if (features.length === 0) return result
  const buckets = buildFeatureBuckets(features, domain)
  // mm/yr of thickening per km/Myr of shortening: Hc / W.
  const thickeningPerShortening = TECTONICS_TUNING.orogenCrustM / ELEVATION_TUNING.rangePerpRadiusM
  const scaleX = domain.width / outWidth
  const scaleY = domain.height / outHeight
  const offset = { x: 0, y: 0 }
  const rangePerp = rangePerpRadius(domain)
  const trenchPerp = trenchPerpRadius(domain)
  const rangeHalf = rangeHalfLength(domain)
  const trenchHalf = trenchHalfLength(domain)
  for (let py = 0; py < outHeight; py++) {
    const wy = py * scaleY
    for (let px = 0; px < outWidth; px++) {
      const wx = px * scaleX
      const nearCount = nearFeatureBuckets(buckets, wx, wy)
      let upliftSum = 0
      let weightSum = 0
      for (let k = 0; k < nearCount; k++) {
        for (const feature of buckets.buckets[buckets.near[k]]) {
          // A hotspot's (plateB −1) or a flood basalt's (−2) feature has
          // no boundary: it neither forces nor dilutes the average.
          if (feature.plateB < 0) continue
          const isTrench = feature.kind === 'trench'
          const halfLength = isTrench ? trenchHalf : rangeHalf
          const perpRadius = isTrench ? trenchPerp : rangePerp
          domain.delta(wx, wy, feature.x, feature.y, offset)
          const weight = capsuleWeight(offset.x, offset.y, feature.tangentX, feature.tangentY, halfLength, perpRadius)
          if (weight <= 0) continue
          upliftSum += (feature.shorteningKmPerMyr ?? 0) * weight
          weightSum += weight
        }
      }
      result[py * outWidth + px] = weightSum > 0 ? (upliftSum / Math.max(1, weightSum)) * thickeningPerShortening : 0
    }
  }
  return result
}
