import type { TerrainFeature } from '../tectonics/terrainFeatures'
import { ELEVATION_TUNING } from './elevationTuneParams'
import { capsuleWeight } from './capsule'
import { wrappedDelta } from '../core/toroidal'
import { buildFeatureBuckets } from './elevationField'
import { wrapValue } from '../core/field'

// U(x) — the tectonic uplift-rate field, the erosion-v2 engine's forcing
// (docs/design/erosion-v2.md, "The tectonics interface"). The v1 pass
// derives its uplift from the finished elevation raster (standing relief as
// its own forcing); v2 wants the CAUSE instead of the effect: where the
// tectonics simulation is actively building terrain right now.
//
// The features already know. Every range/trench/rift feature carries its
// accumulated crustal thickness AND `epochsSinceDeposit` — how long since
// its boundary last built on it. An actively-fed orogen is rising; a
// feature whose boundary wandered off decays and should force nothing. So
// U is the same capsule footprint the elevation kernel uses, weighted by
// RECENCY: thickness × exp(-epochsSinceDeposit / activityHalfLifeEpochs·ln2).
//
// Trenches and rifts carry negative thickness and so export negative U —
// active subsidence. The engine applies U on land only, which makes
// submarine trenches inert there by construction; rift valleys on land
// genuinely deepen, which is what a rift does.
//
// The capsule is computeElevation's (elevationField.ts) — the shared
// capsule.ts since 2026-09-22 — with the same max(1, weightSum) averaging,
// so U rises exactly where the mountains it feeds actually stand.
//
// Scale: the result is normalized so its largest magnitude is 1.0 — the
// engine's upliftDt carries the physical rate, and the P2 calibration
// (equilibrium heights vs the tuned range, golden-gated) owns the mapping.
// Normalizing per world keeps upliftDt's meaning stable across worlds with
// one active orogen or ten.
//
// `epochsSinceDeposit` is a proxy for a true deposit-rate tracker (a
// per-feature EMA of thickness added per epoch, maintained in stepEpoch).
// The proxy reads an old, tall, barely-touched range as fully active the
// epoch it receives one small deposit; the EMA upgrade sharpens that and
// belongs to the epoch loop, noted here so the interface's next step is
// on record.

export interface UpliftFieldParams {
  // Epochs for a feature's activity to halve once deposits stop. Small
  // enough that a dead boundary's range stops forcing within tens of
  // epochs; large enough that the every-other-epoch cadence of deposits
  // (epochsSinceDeposit increments on the off epochs) reads as fully
  // active rather than flickering.
  activityHalfLifeEpochs: number
}

export const DEFAULT_UPLIFT_FIELD_PARAMS: UpliftFieldParams = {
  activityHalfLifeEpochs: 12,
}

// Samples U at `outWidth`×`outHeight` (climate resolution is the intended
// consumer grid — U is smooth by construction) over features living in
// world coordinates `width`×`height`. Returns values in [-1, 1] after the
// per-world peak normalization; all-zero when no feature is active.
export function computeUpliftField(
  features: TerrainFeature[],
  width: number,
  height: number,
  outWidth: number,
  outHeight: number,
  params: UpliftFieldParams = DEFAULT_UPLIFT_FIELD_PARAMS,
): Float32Array {
  const result = new Float32Array(outWidth * outHeight)
  if (features.length === 0) return result
  const buckets = buildFeatureBuckets(features, width, height)
  const { bucketsX, bucketsY, bucketSizeX, bucketSizeY } = buckets
  const decayPerEpoch = Math.log(2) / params.activityHalfLifeEpochs
  const scaleX = width / outWidth
  const scaleY = height / outHeight
  for (let py = 0; py < outHeight; py++) {
    const wy = py * scaleY
    for (let px = 0; px < outWidth; px++) {
      const wx = px * scaleX
      const centerBx = Math.min(bucketsX - 1, Math.floor(wx / bucketSizeX))
      const centerBy = Math.min(bucketsY - 1, Math.floor(wy / bucketSizeY))
      let upliftSum = 0
      let weightSum = 0
      for (let dy = -1; dy <= 1; dy++) {
        const by = wrapValue(centerBy + dy, bucketsY)
        for (let dx = -1; dx <= 1; dx++) {
          const bx = wrapValue(centerBx + dx, bucketsX)
          for (const feature of buckets.buckets[by * bucketsX + bx]) {
            const isTrench = feature.kind === 'trench'
            const halfLength = isTrench ? ELEVATION_TUNING.trenchSegmentHalfLength : ELEVATION_TUNING.rangeSegmentHalfLength
            const perpRadius = isTrench ? ELEVATION_TUNING.trenchPerpRadius : ELEVATION_TUNING.rangePerpRadius
            const weight = capsuleWeight(wrappedDelta(wx, feature.x, width), wrappedDelta(wy, feature.y, height), feature.tangentX, feature.tangentY, halfLength, perpRadius)
            if (weight <= 0) continue
            const activity = Math.exp(-feature.epochsSinceDeposit * decayPerEpoch)
            upliftSum += feature.thickness * activity * weight
            weightSum += weight
          }
        }
      }
      result[py * outWidth + px] = weightSum > 0 ? upliftSum / Math.max(1, weightSum) : 0
    }
  }
  let peak = 0
  for (let i = 0; i < result.length; i++) {
    const magnitude = Math.abs(result[i])
    if (magnitude > peak) peak = magnitude
  }
  if (peak > 0) {
    for (let i = 0; i < result.length; i++) result[i] /= peak
  }
  return result
}
