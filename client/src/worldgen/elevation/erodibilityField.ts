import type { Raft, Suture } from '../crust/raftTypes'
import type { TerrainFeature } from '../tectonics/terrainFeatures'
import { computeCratonOldnessField } from '../crust/raftField'
import { ELEVATION_TUNING } from './elevationTuneParams'
import { wrappedDelta, toroidalDistanceSq } from '../core/toroidal'

// The K(x) inputs — the erosion-v2 engine's erodibility, assembled from the
// crust's own history (docs/design/erosion-v2.md, "The tectonics
// interface"). The engine's fine-scale rock contrast stays the procedural
// lithology noise (resolution-independent, from seed); THIS field is the
// smooth, story-carrying multiplier on top of it:
//
//   - ancient cratons are HARD (they have survived every cycle since the
//     Archean — that is what a craton is): erodibility down with the
//     metaball-weighted crust age the rafts already track (RaftBlob.birthEpoch,
//     the same field that places the Ecology layer's iron).
//   - fresh collision belts are SOFT (crushed, faulted, steep): erodibility
//     up along young sutures — the persistent, never-pruned collision
//     history kept for the Ecology layer's tin/gold provenance.
//   - old sutures are metamorphic roots: modestly hard once the belt has
//     cooled (the same record, read at the other end of its age axis).
//   - flood-basalt provinces are caprock: hard where a plume's basalt
//     sheet lies (terrain features with plateB === -2 — the same marker
//     collectVolcanoes reads).
//
// All four are smooth stories on the 100 km scale, so the field lives at a
// coarse grid (climate resolution is the intended consumer, like U's) and
// the engine multiplies its per-cell lithology noise by the bilinear
// upsample. Values are multiplicative K factors centred on 1; the absolute
// numbers below are CALIBRATION PLACEHOLDERS until P2's calibration pass
// (equilibrium heights vs the tuned range, golden-gated) pins them.

export interface ErodibilityFieldParams {
  // K multiplier at full craton oldness (1.0 → this, linearly with the
  // 0..1 oldness field).
  cratonHardness: number
  // K multiplier peak for a suture younger than freshSutureEpochs …
  youngSutureSoftness: number
  freshSutureEpochs: number
  // … and for one older than oldSutureEpochs (linear crossfade between).
  oldSutureHardness: number
  oldSutureEpochs: number
  // K multiplier under a flood-basalt sheet.
  floodBasaltHardness: number
  // Capsule radius for a suture's belt, world cells. Wider than a range's
  // crest radius: a collision belt is a province, not a ridge line.
  sutureRadius: number
  sutureHalfLength: number
  // A flood province's radius scales with the feature's thickness (the
  // sheet keeps growing while the plume feeds it), clamped to this range.
  floodRadiusMin: number
  floodRadiusMax: number
  floodRadiusPerThickness: number
}

export const DEFAULT_ERODIBILITY_FIELD_PARAMS: ErodibilityFieldParams = {
  cratonHardness: 0.45,
  youngSutureSoftness: 1.5,
  freshSutureEpochs: 80,
  oldSutureHardness: 0.8,
  oldSutureEpochs: 240,
  floodBasaltHardness: 0.55,
  sutureRadius: 45,
  sutureHalfLength: ELEVATION_TUNING.rangeSegmentHalfLength,
  floodRadiusMin: 20,
  floodRadiusMax: 60,
  floodRadiusPerThickness: 2,
}

// Smoothstep capsule weight — the same footprint family the elevation and
// uplift kernels use, local to this module because its radii differ.
function capsuleWeight(
  offX: number,
  offY: number,
  tangentX: number,
  tangentY: number,
  halfLength: number,
  perpRadius: number,
): number {
  const along = offX * tangentX + offY * tangentY
  const across = -offX * tangentY + offY * tangentX
  const clamped = along < -halfLength ? -halfLength : along > halfLength ? halfLength : along
  const overshoot = along - clamped
  const distance = Math.sqrt(overshoot * overshoot + across * across)
  if (distance >= perpRadius) return 0
  const falloff = 1 - distance / perpRadius
  return falloff * falloff * (3 - 2 * falloff)
}

// The smooth K-factor field at `outWidth`×`outHeight` over a world of
// `width`×`height` cells. Neutral is 1.0 everywhere; ocean floor stays
// neutral (the engine's marine steps have their own physics).
export function computeErodibilityField(
  rafts: Raft[],
  sutures: Suture[],
  features: TerrainFeature[],
  currentEpoch: number,
  width: number,
  height: number,
  outWidth: number,
  outHeight: number,
  params: ErodibilityFieldParams = DEFAULT_ERODIBILITY_FIELD_PARAMS,
): Float32Array {
  const result = new Float32Array(outWidth * outHeight).fill(1)
  const cellW = width / outWidth
  const cellH = height / outHeight

  // Cratons: linear toward cratonHardness with the oldness field (-1 = no
  // crust → neutral).
  const oldness = computeCratonOldnessField(rafts, currentEpoch, outWidth, outHeight, width, height)
  for (let i = 0; i < result.length; i++) {
    if (oldness[i] >= 0) result[i] *= 1 + (params.cratonHardness - 1) * oldness[i]
  }

  // Sutures: each cell takes the STRONGEST single suture influence rather
  // than a product over all of them — collision belts overlap where
  // continents met repeatedly, and stacking multipliers there would run
  // the factor to extremes no single geology story tells. Young and old
  // effects crossfade on the suture's age.
  if (sutures.length > 0) {
    for (let py = 0; py < outHeight; py++) {
      const wy = (py + 0.5) * cellH
      for (let px = 0; px < outWidth; px++) {
        const wx = (px + 0.5) * cellW
        let strongest = 1
        let strongestDeviation = 0
        for (const suture of sutures) {
          const weight = capsuleWeight(
            wrappedDelta(wx, suture.x, width),
            wrappedDelta(wy, suture.y, height),
            suture.tangentX,
            suture.tangentY,
            params.sutureHalfLength,
            params.sutureRadius,
          )
          if (weight <= 0) continue
          const age = currentEpoch - suture.epoch
          const oldFraction = Math.min(1, Math.max(0,
            (age - params.freshSutureEpochs) / (params.oldSutureEpochs - params.freshSutureEpochs)))
          const target = params.youngSutureSoftness * (1 - oldFraction) + params.oldSutureHardness * oldFraction
          const factor = 1 + (target - 1) * weight
          const deviation = Math.abs(factor - 1)
          if (deviation > strongestDeviation) { strongestDeviation = deviation; strongest = factor }
        }
        result[py * outWidth + px] *= strongest
      }
    }
  }

  // Flood-basalt caprock: radial smoothstep per province, strongest wins
  // (same stacking argument as sutures).
  const floods = features.filter((f) => f.plateB === -2)
  if (floods.length > 0) {
    for (let py = 0; py < outHeight; py++) {
      const wy = (py + 0.5) * cellH
      for (let px = 0; px < outWidth; px++) {
        const wx = (px + 0.5) * cellW
        let strongestWeight = 0
        for (const flood of floods) {
          const radius = Math.min(params.floodRadiusMax,
            Math.max(params.floodRadiusMin, Math.abs(flood.thickness) * params.floodRadiusPerThickness))
          const distanceSq = toroidalDistanceSq(wx, wy, flood.x, flood.y, width, height)
          if (distanceSq >= radius * radius) continue
          const falloff = 1 - Math.sqrt(distanceSq) / radius
          const weight = falloff * falloff * (3 - 2 * falloff)
          if (weight > strongestWeight) strongestWeight = weight
        }
        if (strongestWeight > 0) {
          result[py * outWidth + px] *= 1 + (params.floodBasaltHardness - 1) * strongestWeight
        }
      }
    }
  }

  return result
}
