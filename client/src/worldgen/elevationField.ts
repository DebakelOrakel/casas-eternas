import type { PlateSeed } from './plateSeeds'
import type { TerrainFeature } from './terrainFeatures'
import { toroidalDistanceSq, wrappedDelta } from './toroidal'
import { domainWarpDelta } from './domainWarp'
import { ridgedMultifractal, RIDGE_MEAN } from './ridgedNoise'

// A terrain feature is no longer an isotropic blob but an oriented ridge
// segment: its influence reaches far ALONG its own boundary tangent
// (feature.tangentX/Y) and only a short distance ACROSS it. Two effects
// fall out of that anisotropy, both deliberate:
//  - Along-axis reach is generous (well past terrainFeatures' MERGE_RADIUS
//    of 40) so consecutive features laid down along one boundary overlap
//    heavily end-to-end and blend into a single *continuous linear range*,
//    instead of the row of distinct rounded blobs an isotropic radial
//    falloff produced (the previous model had to keep widening a single
//    radius to fight exactly that, and still read as domes, not ridges).
//  - Across-axis reach is much shorter, so the range has a real ridge
//    cross-section with a crest, not a broad dome.
// A trench (the paired subduction depression) is narrower still across its
// axis than a range — deep and tight, the way a real trench reads against
// its broad companion arc.
const RANGE_ALONG_RADIUS = 220
const RANGE_PERP_RADIUS = 85
const TRENCH_ALONG_RADIUS = 180
const TRENCH_PERP_RADIUS = 45
// The largest distance any feature can influence in an arbitrary world
// direction (its longest semi-axis) — the spatial bucket index must be at
// least this wide/tall in each axis to keep the "any in-range feature is
// in this or a neighbor bucket" guarantee, since a feature oriented
// diagonally reaches this far along either world axis.
const FEATURE_MAX_REACH = Math.max(RANGE_ALONG_RADIUS, RANGE_PERP_RADIUS, TRENCH_ALONG_RADIUS, TRENCH_PERP_RADIUS)
// Converts accumulated crustal thickness into actual elevation — a
// simple isostasy-style relation (thicker/more compressed crust sits
// higher), not a real buoyancy simulation. Dropped from 0.06 to 0.02
// early on because most boundaries were reaching the elevation clamp
// within under a minute — but that was fixed independently since (decay
// now caps thickness at a real equilibrium instead of growing without
// bound, and baseline blending means a tall peak reads as a smooth rise
// rather than a stark discontinuity), so there's headroom to push this
// back up a bit without reintroducing that problem.
const THICKNESS_TO_ELEVATION_SCALE = 0.035

// How strongly ridged-multifractal detail (ridgedNoise.ts) modulates
// uplifted terrain, as a fraction of the local uplift itself — the detail
// added at a point is (ridge - RIDGE_MEAN) * uplift * this. Scaling by the
// local uplift is deliberate: flat plains and ocean (no uplift) stay
// perfectly smooth, foothills get a little texture, and a high massif gets
// proportionally rugged crests and valleys — mountain roughness reads as a
// consequence of how much the crust was raised, not a uniform noise layer
// bolted over everything. Tune by eye; higher = more dramatic ridging.
const RIDGE_RELATIVE_STRENGTH = 0.5

// Each plate's baseline (plateBaseline.ts) is otherwise a flat per-plate
// constant, which reads as a hard, geologically-meaningless step right at
// every cell boundary — visible even between two same-type neighbors
// with barely different jitter — regardless of anything uplift is
// doing. computeBlendedBaselines below smooths this out by blending
// every plate within this radius of a point, not just the nearest one.
// Wider than FEATURE_FALLOFF_RADIUS deliberately — a real coastal shelf
// is a broader, gentler feature than a mountain range's own falloff, not
// a narrower one, and this was the harshest-looking transition on the
// map (an ocean/continent step is a bigger elevation swing than most
// uplift ever produces) despite blending at all — narrow blend width
// plus a steep step was still reading as harsh.
const BASELINE_BLEND_RADIUS = 220

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

// Per-pixel baseline, blended across every plate whose distance is within
// BASELINE_BLEND_RADIUS of the *nearest* plate's own distance — a gap, not
// an absolute distance from each seed. Weighting by raw distance from each
// seed was tried first and doesn't work: a large plate's own seed can sit
// far enough from its own boundary that every seed (including its own) is
// already outside the blend radius by the time you reach the boundary, so
// the blend silently falls back to a flat, unblended baseline exactly
// where it mattered most. Measuring the gap to the nearest distance
// instead means the *nearest* plate always has weight 1 (gap 0) and any
// other plate contributes precisely in proportion to how close the pixel
// is to being equally near to it — which is large near an actual boundary
// and negligible deep in a cell's interior, regardless of that cell's
// absolute size. This also avoids the earlier top-2 blend's discontinuity
// (which plate counts as "second-nearest" could flip to an unrelated
// third plate mid-cell) since every plate's weight is a continuous
// function of its own gap, with no hard cutoff to trip over.
export function computeBlendedBaselines(seeds: PlateSeed[], baseElevations: number[], width: number, height: number, warpSeed: number): Float32Array {
  const result = new Float32Array(width * height)
  const distances = new Float32Array(seeds.length)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Sampled at a warped point rather than (x, y) itself — see
      // domainWarp.ts. toroidalDistanceSq's own wrappedDelta already
      // handles a warped coordinate landing outside [0, width)/[0,
      // height), so the result doesn't need re-wrapping into range first.
      const wx = x + domainWarpDelta(x, y, width, height, warpSeed, 'x')
      const wy = y + domainWarpDelta(x, y, width, height, warpSeed, 'y')
      let nearestDist = Infinity
      for (let i = 0; i < seeds.length; i++) {
        const distance = Math.sqrt(toroidalDistanceSq(wx, wy, seeds[i].x, seeds[i].y, width, height))
        distances[i] = distance
        if (distance < nearestDist) nearestDist = distance
      }
      let weightSum = 0
      let baselineSum = 0
      for (let i = 0; i < seeds.length; i++) {
        const gap = distances[i] - nearestDist
        if (gap > BASELINE_BLEND_RADIUS) continue
        const falloff = 1 - gap / BASELINE_BLEND_RADIUS
        const weight = falloff * falloff * (3 - 2 * falloff)
        baselineSum += baseElevations[i] * weight
        weightSum += weight
      }
      result[y * width + x] = baselineSum / weightSum
    }
  }
  return result
}

// Ridged-multifractal relief added on top of the smooth tectonic uplift,
// modulated by that uplift so only raised terrain gets rugged (see
// RIDGE_RELATIVE_STRENGTH). Centered on RIDGE_MEAN so ridgelines add height
// and valleys cut down with no net bias, and gated to positive uplift so
// trenches and rift valleys (negative uplift) stay smooth depressions
// rather than getting ridged. Sampled at the same warped point as the rest
// of the field so it moves together with the coastline/uplift warp.
function ridgedDetail(wx: number, wy: number, uplift: number, width: number, height: number, warpSeed: number): number {
  if (uplift <= 0) return 0
  const ridge = ridgedMultifractal(wx, wy, width, height, warpSeed)
  return (ridge - RIDGE_MEAN) * uplift * RIDGE_RELATIVE_STRENGTH
}

// Stateless distance-field query, per the decided A3 model: elevation
// anywhere is the (already blended) baseline plus a distance-weighted
// blend of nearby terrain features' accumulated thickness (converted via
// isostasy), not a value stored per point. A weighted AVERAGE (not sum)
// of overlapping features' contribution — otherwise a cluster of
// features along a long-lived range would stack without bound instead of
// blending into one continuous ridge.
export function computeElevation(
  x: number,
  y: number,
  blendedBaseline: number,
  featureBuckets: FeatureBuckets,
  width: number,
  height: number,
  warpSeed: number,
): number {
  // Same warped sample point computeBlendedBaselines used for this same
  // (x, y) — both independently recompute it from the same pure inputs
  // rather than passing it across the render-pool worker boundary, so a
  // mountain range's own uplift query warps together with the baseline
  // it's stacked on instead of drifting apart from it (see domainWarp.ts).
  // Wrapped into [0, width)/[0, height) here — unlike computeBlendedBaselines,
  // this warped point also drives a bucket *index* below, and
  // Math.floor(negative or >=width) would pick the wrong (or an
  // out-of-bounds) bucket; toroidalDistanceSq's own wrapping makes the
  // later distance checks correct regardless, but the bucket lookup isn't
  // covered by that the same way.
  const rawWx = x + domainWarpDelta(x, y, width, height, warpSeed, 'x')
  const rawWy = y + domainWarpDelta(x, y, width, height, warpSeed, 'y')
  const wx = ((rawWx % width) + width) % width
  const wy = ((rawWy % height) + height) % height

  const { buckets, bucketsX, bucketsY, bucketSizeX, bucketSizeY } = featureBuckets
  const centerBx = Math.min(bucketsX - 1, Math.floor(wx / bucketSizeX))
  const centerBy = Math.min(bucketsY - 1, Math.floor(wy / bucketSizeY))

  let upliftSum = 0
  let weightSum = 0
  for (let dy = -1; dy <= 1; dy++) {
    const by = (((centerBy + dy) % bucketsY) + bucketsY) % bucketsY
    for (let dx = -1; dx <= 1; dx++) {
      const bx = (((centerBx + dx) % bucketsX) + bucketsX) % bucketsX
      for (const feature of buckets[by * bucketsX + bx]) {
        // Anisotropic ridge falloff: decompose the (wrapped) offset from
        // the feature into components along its own boundary tangent and
        // across it, then measure distance in units where 1.0 is the
        // reach on each axis separately. Along-axis reach is long (ridges
        // stay continuous end-to-end), across-axis short (a real crest,
        // not a dome); a trench is tighter still across its axis. The
        // decomposition is sign-agnostic — only the squared components
        // matter — so the tangent's arbitrary orientation sign is
        // irrelevant.
        const offX = wrappedDelta(wx, feature.x, width)
        const offY = wrappedDelta(wy, feature.y, height)
        const along = offX * feature.tangentX + offY * feature.tangentY
        const across = -offX * feature.tangentY + offY * feature.tangentX
        const alongRadius = feature.kind === 'trench' ? TRENCH_ALONG_RADIUS : RANGE_ALONG_RADIUS
        const perpRadius = feature.kind === 'trench' ? TRENCH_PERP_RADIUS : RANGE_PERP_RADIUS
        const na = along / alongRadius
        const np = across / perpRadius
        const normalizedDistSq = na * na + np * np
        if (normalizedDistSq >= 1) continue
        const falloff = 1 - Math.sqrt(normalizedDistSq)
        // Smoothstep (3t² - 2t³) rather than a plain square — both have
        // zero slope right at the radius edge (no visible seam where a
        // feature's influence cuts off), but smoothstep also flattens out
        // near the feature's own center instead of peaking sharply there,
        // reading as a rounder, less blob-like bump overall.
        const weight = falloff * falloff * (3 - 2 * falloff)
        upliftSum += feature.thickness * THICKNESS_TO_ELEVATION_SCALE * weight
        weightSum += weight
      }
    }
  }
  const uplift = weightSum > 0 ? upliftSum / weightSum : 0
  const elevation = blendedBaseline + uplift + ridgedDetail(wx, wy, uplift, width, height, warpSeed)
  return Math.max(-1, Math.min(1, elevation))
}

// Redistribution exponent (a standard procedural-terrain technique — e.g.
// Sebastian Lague's terrain series applies the same curve to raw Perlin
// output): raises normalized land elevation to a power > 1, which pulls
// low/mid values down much further than it pulls already-high ones —
// most land reads as noticeably flatter while genuinely strong uplift
// still produces a sharp, prominent peak, without changing anything
// about how uplift itself accumulates.
//
// Crucially, "normalized" here means dividing by *this map's own* actual
// highest land elevation, not the theoretical ±1 clamp — the tectonic
// model rarely drives raw elevation anywhere near that clamp in
// practice (peaks in a typical run top out around 0.5-0.7), so applying
// the power curve against the fixed 0..1 domain was tried first and
// crushed every peak along with the plains: even the map's actual
// highest point was still a small fraction of "1", so it got squashed
// down like everything else, and nothing ever reached the color ramp's
// snow-cap band. Normalizing against the map's own achieved max first
// (then rescaling back afterward) means the highest point always ends
// up back near its own original height — genuinely prominent — while
// everything below it is compressed in proportion to how far below the
// peak it started.
//
// Ocean (elevation <= 0) is left untouched. Raise
// MOUNTAIN_REDISTRIBUTION_GAMMA for flatter plains with more dramatic
// peaks, lower it (toward 1) for today's more continuous, gradual slope.
const MOUNTAIN_REDISTRIBUTION_GAMMA = 2.5

export function applyMountainRedistribution(elevations: Float32Array): void {
  let maxLandElevation = 0
  for (let i = 0; i < elevations.length; i++) {
    if (elevations[i] > maxLandElevation) maxLandElevation = elevations[i]
  }
  if (maxLandElevation <= 0) return
  for (let i = 0; i < elevations.length; i++) {
    const elevation = elevations[i]
    if (elevation <= 0) continue
    const normalized = elevation / maxLandElevation
    elevations[i] = Math.pow(normalized, MOUNTAIN_REDISTRIBUTION_GAMMA) * maxLandElevation
  }
}
