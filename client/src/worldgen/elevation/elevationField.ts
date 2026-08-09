import type { TerrainFeature } from '../tectonics/terrainFeatures'
import { ELEVATION_TUNING } from './elevationTuneParams'
import { wrappedDelta } from '../core/toroidal'
import { domainWarpDelta } from './domainWarp'
import { RIDGE_MEAN } from './ridgedNoise'
import { sampleOceanAge } from '../tectonics/oceanAge'
import { ABYSSAL_FLOOR, RIDGE_CREST, marginParameter, marginProfile } from './elevationScale'
import { continentalHypsometry } from './hypsometry'
import { wrapValue } from '../core/field'
import { raftField, sampleOwnerField } from '../crust/raftField'
import type { Raft } from '../crust/raftTypes'

// Farthest a feature can influence in any direction — its segment half-length
// plus the perpendicular cap radius. The spatial bucket index must be at
// least this wide/tall in each axis so any in-range feature lands in a point's
// own bucket or a neighbor.
const FEATURE_MAX_REACH = Math.max(ELEVATION_TUNING.rangeSegmentHalfLength + ELEVATION_TUNING.rangePerpRadius, ELEVATION_TUNING.trenchSegmentHalfLength + ELEVATION_TUNING.trenchPerpRadius)

export interface FeatureBuckets {
  buckets: TerrainFeature[][]
  bucketsX: number
  bucketsY: number
  bucketSizeX: number
  bucketSizeY: number
}

// Spatial hash over the terrain features, bucket size at least as large
// as the maximum feature reach in each axis — any feature within range of
// a given point is guaranteed to land in that point's own bucket or one of
// its 8 immediate neighbors, so a per-pixel query only ever has to check
// those 9 buckets instead of every feature that exists. Rendering the
// full 2048x1024 raster against every feature directly (no bucketing)
// was cheap early on but degraded badly as features accumulated over a
// long run — confirmed empirically: bumping how far plates move per
// epoch (a separate, since-reverted change) pushed the per-pixel-scans-
// all-features version into hanging the main thread for 10+ seconds.
//
// Sized to FEATURE_MAX_REACH (a feature's longest semi-axis) rather than a
// single isotropic radius, since features are now anisotropic ridge
// segments — an in-range feature can still be up to its along-tangent
// reach away in any world direction if it happens to point that way.
//
// Bucket count uses floor (not ceil) of width/height over that reach, and
// the actual per-axis bucket size is then derived back from that count —
// deliberately, so every bucket ends up at LEAST the max reach wide/tall,
// never shorter. Sizing buckets at exactly the reach via ceil() leaves a
// short leftover bucket wherever the map dimension isn't an exact multiple
// of it, and that short bucket breaks the "±1 neighbor bucket" guarantee
// right where it matters most: at the wrap seam. A point near y=0 can have
// a feature within range as far down as the wrapped side, but a short last
// bucket doesn't reach that far — so the feature gets silently missed only
// for points near that specific wrap edge, producing a real, measured
// elevation discontinuity there (confirmed with the previous radius: ~13x
// the color difference of a typical interior row).
export function buildFeatureBuckets(features: TerrainFeature[], width: number, height: number): FeatureBuckets {
  const bucketsX = Math.max(1, Math.floor(width / FEATURE_MAX_REACH))
  const bucketsY = Math.max(1, Math.floor(height / FEATURE_MAX_REACH))
  const bucketSizeX = width / bucketsX
  const bucketSizeY = height / bucketsY
  const buckets: TerrainFeature[][] = Array.from({ length: bucketsX * bucketsY }, () => [])
  for (const feature of features) {
    const bx = Math.min(bucketsX - 1, Math.floor(feature.x / bucketSizeX))
    const by = Math.min(bucketsY - 1, Math.floor(feature.y / bucketSizeY))
    buckets[by * bucketsX + bx].push(feature)
  }
  return { buckets, bucketsX, bucketsY, bucketSizeX, bucketSizeY }
}

// Baseline elevation field from the raft crust field (rafts.ts) — this replaced
// the old per-plate-type baseline entirely: oceanic by default, continental
// where rafts cover. Warped so coastlines stay ragged, and sampled at the render
// grid (which may be coarser than the world — the renderWidth/worldWidth scaling
// below covers the whole world at fewer points).
//
// The ocean→continent transition used to be a plain lerp across the metaball
// membership band between a fixed -0.45 ocean baseline and a fixed +0.35
// continental one. Both halves of that are gone: depth now follows the advected
// ocean-age field (oceanFloorAtAge), and the transition is a shaped continental
// margin with a real shelf (elevationScale.marginProfile), which is what keeps a
// coastline off the steepest part of the drop.

// Fraction 0..1 of an ocean plate's total subsidence completed at `age` epochs.
function subsidenceFraction(age: number): number {
  if (age < ELEVATION_TUNING.gdh1YoungMaxAge) return ELEVATION_TUNING.gdh1YoungCoeff * Math.sqrt(age)
  return 1 - ELEVATION_TUNING.gdh1OldCoeff * Math.exp(-ELEVATION_TUNING.gdh1OldDecay * age)
}

export function oceanFloorAtAge(age: number): number {
  return RIDGE_CREST + (ABYSSAL_FLOOR - RIDGE_CREST) * subsidenceFraction(age)
}

// The baseline at ONE world point — the per-point body computeRaftBaseline
// always ran, extracted (2026-08-06) so the micro-tile prototype
// (surface/tileErosion.ts) can query the baseline at arbitrary FRACTIONAL
// world coordinates: the whole pre-erosion pipeline is analytic/vector, so a
// tile sampled at sub-cell spacing gets genuinely finer terrain, not an
// upscaled raster. Takes UNWARPED world coords and applies the domain warp
// itself, exactly as the grid loop did.
export function raftBaselineAt(worldX: number, worldY: number, rafts: Raft[], oceanAge: Float32Array, worldWidth: number, worldHeight: number, warpSeed: number, seaLevelOffset = 0): number {
  const wx = worldX + domainWarpDelta(worldX, worldY, worldWidth, worldHeight, warpSeed, 'x')
  const wy = worldY + domainWarpDelta(worldX, worldY, worldWidth, worldHeight, warpSeed, 'y')
  // Ocean floor deepens with its crustal age; the margin profile then shapes
  // everything from that floor up onto the continent, putting the shoreline
  // on a flat shelf instead of mid-slope (see elevationScale.marginProfile).
  const oceanicBaseline = oceanFloorAtAge(sampleOceanAge(oceanAge, wx, wy, worldWidth, worldHeight))
  const t = marginParameter(raftField(wx, wy, rafts, worldWidth, worldHeight))
  // The water knob: the whole solid surface sits lower relative to a sea level
  // that stays at zero. Applied here rather than to the anchors because the two
  // are identical and this is one subtraction — see WATER_OFFSET_MAX_M.
  // Interior relief on top of the margin profile — see hypsometry.ts. Without it
  // the inside of a continent is one flat height, which is what made the water
  // control a switch rather than a slider.
  return marginProfile(t, oceanicBaseline) + continentalHypsometry(wx, wy, t, worldWidth, worldHeight, warpSeed) - seaLevelOffset
}

export function computeRaftBaseline(rafts: Raft[], oceanAge: Float32Array, renderWidth: number, renderHeight: number, worldWidth: number, worldHeight: number, warpSeed: number, seaLevelOffset = 0): Float32Array {
  const result = new Float32Array(renderWidth * renderHeight)
  const scaleX = worldWidth / renderWidth
  const scaleY = worldHeight / renderHeight
  for (let py = 0; py < renderHeight; py++) {
    const worldY = py * scaleY
    for (let px = 0; px < renderWidth; px++) {
      const worldX = px * scaleX
      result[py * renderWidth + px] = raftBaselineAt(worldX, worldY, rafts, oceanAge, worldWidth, worldHeight, warpSeed, seaLevelOffset)
    }
  }
  return result
}

// The warped sample point for a pixel — the same warp computeRaftBaseline
// applies (domainWarp.ts), so a mountain's uplift query warps together with
// the baseline it sits on rather than drifting apart from it. A pure function
// of (x, y, warpSeed), and warpSeed is constant for a world's lifetime, so
// the render worker precomputes this once per world and caches it across
// epochs instead of recomputing the warp noise every epoch (see
// elevationRenderWorker.ts). Wrapped into [0, width)/[0, height) because the
// result drives a bucket *index* in computeElevation — Math.floor of a
// negative or overflowing coord would pick the wrong (or an out-of-bounds)
// bucket; toroidalDistanceSq's own wrapping makes the later distance checks
// correct regardless, but the bucket lookup isn't covered by that the same
// way.
export function warpedSamplePoint(x: number, y: number, width: number, height: number, warpSeed: number): { wx: number; wy: number } {
  const rawWx = x + domainWarpDelta(x, y, width, height, warpSeed, 'x')
  const rawWy = y + domainWarpDelta(x, y, width, height, warpSeed, 'y')
  return {
    wx: wrapValue(rawWx, width),
    wy: wrapValue(rawWy, height),
  }
}

export function computeElevation(
  wx: number,
  wy: number,
  blendedBaseline: number,
  featureBuckets: FeatureBuckets,
  width: number,
  height: number,
  ridgeValue: number,
  fineValue = 0,
): number {
  const { buckets, bucketsX, bucketsY, bucketSizeX, bucketSizeY } = featureBuckets
  const centerBx = Math.min(bucketsX - 1, Math.floor(wx / bucketSizeX))
  const centerBy = Math.min(bucketsY - 1, Math.floor(wy / bucketSizeY))

  let upliftSum = 0
  let weightSum = 0
  for (let dy = -1; dy <= 1; dy++) {
    const by = wrapValue((centerBy + dy), bucketsY)
    for (let dx = -1; dx <= 1; dx++) {
      const bx = wrapValue((centerBx + dx), bucketsX)
      for (const feature of buckets[by * bucketsX + bx]) {
        // Capsule falloff: distance to the feature's finite boundary segment
        // (± half-length along its tangent), then a perpendicular profile.
        // The tangent's arbitrary orientation sign doesn't matter — the
        // segment is symmetric about the feature.
        const offX = wrappedDelta(wx, feature.x, width)
        const offY = wrappedDelta(wy, feature.y, height)
        const along = offX * feature.tangentX + offY * feature.tangentY
        const across = -offX * feature.tangentY + offY * feature.tangentX
        const isTrench = feature.kind === 'trench'
        const halfLength = isTrench ? ELEVATION_TUNING.trenchSegmentHalfLength : ELEVATION_TUNING.rangeSegmentHalfLength
        const perpRadius = isTrench ? ELEVATION_TUNING.trenchPerpRadius : ELEVATION_TUNING.rangePerpRadius
        // Within the segment (|along| <= halfLength) the nearest point is
        // straight across, so distance is the perpendicular offset — a narrow
        // crest. Past an end, the nearest point is that endpoint, so distance
        // grows radially — a rounded cap that stops the feature overshooting
        // into open ocean the way the old ellipse's long soft axis did.
        const clampedAlong = along < -halfLength ? -halfLength : along > halfLength ? halfLength : along
        const overshoot = along - clampedAlong
        const distance = Math.sqrt(overshoot * overshoot + across * across)
        if (distance >= perpRadius) continue
        const falloff = 1 - distance / perpRadius
        // Smoothstep (3t² - 2t³) rather than a plain square — both have
        // zero slope right at the radius edge (no visible seam where a
        // feature's influence cuts off), but smoothstep also flattens out
        // near the crest instead of peaking sharply, reading as a rounder
        // ridge profile.
        const weight = falloff * falloff * (3 - 2 * falloff)
        upliftSum += feature.thickness * ELEVATION_TUNING.thicknessToElevationScale * weight
        weightSum += weight
      }
    }
  }
  // Divide by max(1, weightSum), not weightSum itself. A plain weighted
  // average (÷weightSum) makes the falloff weight cancel wherever a single
  // feature is the only contributor — uplift collapses to that feature's
  // full thickness everywhere inside its ellipse, giving a flat-topped
  // patch with a hard edge instead of a bump that fades with distance.
  // That was invisible while features were fat enough to overlap
  // everywhere, but once they're narrow, an isolated (e.g. drifted) feature
  // in open ocean shows as a sharp streak — the "starburst" artifact.
  // Clamping the denominator at 1 keeps proper averaging where features
  // densely overlap (weightSum >= 1, so no unbounded stacking along a
  // range) while letting sparse/edge coverage (weightSum < 1) actually
  // attenuate by the falloff, so isolated features fade out smoothly.
  const uplift = weightSum > 0 ? upliftSum / Math.max(1, weightSum) : 0
  // Ridged-multifractal relief on top of the smooth uplift, modulated by
  // that uplift so only raised terrain gets rugged (ELEVATION_TUNING.ridgeRelativeStrength),
  // centered on RIDGE_MEAN so ridgelines add height and valleys cut down with
  // no net bias, and gated to positive uplift so trenches and rift valleys
  // (negative uplift) stay smooth depressions. ridgeValue is the precomputed
  // ridgedMultifractal sample at this warped point.
  const detail = uplift > 0 ? (ridgeValue - RIDGE_MEAN) * uplift * ELEVATION_TUNING.ridgeRelativeStrength : 0
  let elevation = blendedBaseline + uplift + detail
  if (fineValue !== 0 && elevation > 0) elevation += fineValue * Math.min(ELEVATION_TUNING.plainDetailMax, elevation * 0.5)
  return Math.max(-1, Math.min(1, elevation))
}

export function applyMountainRedistribution(
  elevations: Float32Array,
  width: number,
  height: number,
  ownerField: Int32Array,
  ownerResX: number,
  ownerResY: number,
): void {
  // Owner looked up once per pixel and cached, not resampled in the second
  // pass — sampleOwnerField's coordinate math is cheap but pointless to redo
  // 2.1M times twice over.
  const ownerAt = new Int32Array(elevations.length)
  const maxByOwner = new Map<number, number>()
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      const owner = sampleOwnerField(ownerField, ownerResX, ownerResY, x, y, width, height)
      ownerAt[i] = owner
      const elevation = elevations[i]
      if (elevation <= 0) continue
      if (elevation > (maxByOwner.get(owner) ?? 0)) maxByOwner.set(owner, elevation)
    }
  }
  for (let i = 0; i < elevations.length; i++) {
    const elevation = elevations[i]
    if (elevation <= 0) continue
    const maxLandElevation = maxByOwner.get(ownerAt[i]) ?? 0
    if (maxLandElevation <= 0) continue
    const normalized = elevation / maxLandElevation
    elevations[i] = Math.pow(normalized, ELEVATION_TUNING.mountainRedistributionGamma) * maxLandElevation
  }
}
