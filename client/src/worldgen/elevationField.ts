import type { PlateSeed } from './plateSeeds'
import type { TerrainFeature } from './terrainFeatures'
import { toroidalDistanceSq, wrappedDelta } from './toroidal'
import { domainWarpDelta } from './domainWarp'
import { RIDGE_MEAN } from './ridgedNoise'
import { raftMembership } from './rafts'
import type { Raft } from './rafts'
import { sampleOceanAge } from './oceanAge'

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
// Perp radii calibrated to physical scale: at a ~1/4-Earth-area world
// (~127.5 Mkm² over 2048x1024) one pixel is ~7.8 km, so an 85px half-width
// range spanned ~1300 km — 2-4x wider than real orogens (Andes ~500-700 km,
// Himalaya ~250-400 km) and read as broad massifs swallowing continent
// interiors rather than narrow cordilleras. 28px ≈ 440 km full width lands
// in the realistic band and, as a bonus, sharpens the crest (steeper across-
// ridge falloff). Trench perp scaled down with it, keeping roughly its old
// proportion to the range.
//
// Along radii must stay in proportion to the (now much smaller) perp radii,
// NOT at their original large values: a feature is an oriented ellipse, and
// a very long-but-thin one (the old 220x28 ≈ 8:1) sits tangent to the plate
// boundary and extends its thin needle ~1700 km along that tangent into open
// ocean, where — no fat neighbor left to blend with at that distance — each
// needle shows as an isolated ray. On a curved boundary the adjacent needles
// splay apart, producing a radial starburst fanning out of each plate. A
// range still reads as long because it's a *chain* of these features along
// the boundary (spaced MERGE_RADIUS=40 apart), not one long feature — so the
// along radius only needs to be a few times that spacing for the chain to
// blend continuously, keeping the per-feature ellipse a modest ~3-4:1 rather
// than a needle.
// Each terrain feature is rendered as a finite line SEGMENT (a short stretch
// of its boundary curve) rather than an oriented ellipse: a "capsule" —
// distance to the segment, then a perpendicular profile. This is the
// boundary-curve (distance-to-polyline) model: consecutive features along one
// boundary are short segments that abut/overlap into a continuous ridge, and
// — crucially — a segment is FINITE, so beyond its ends it falls off as a
// rounded cap instead of a long soft gradient. That's what lets ranges be
// realistically narrow (perp ~30px ≈ 470 km) without the radial "starburst"
// the old anisotropic ellipse produced: the ellipse's long soft along-axis
// overshot past every boundary curve/Voronoi vertex as a thin needle into
// open ocean (root cause confirmed via a headless render sweep, 2026-07-24 —
// it survived removing trenches, keeping only active features, and aggressive
// pruning, so it was the shape, not clutter); a capsule can't overshoot past
// its segment ends. Half-length ~ the feature spacing (terrainFeatures'
// MERGE_RADIUS) so consecutive segments chain continuously.
const RANGE_PERP_RADIUS = 30
const RANGE_SEGMENT_HALF_LENGTH = 35
const TRENCH_PERP_RADIUS = 15
const TRENCH_SEGMENT_HALF_LENGTH = 25
// Farthest a feature can influence in any direction — its segment half-length
// plus the perpendicular cap radius. The spatial bucket index must be at
// least this wide/tall in each axis so any in-range feature lands in a point's
// own bucket or a neighbor.
const FEATURE_MAX_REACH = Math.max(RANGE_SEGMENT_HALF_LENGTH + RANGE_PERP_RADIUS, TRENCH_SEGMENT_HALF_LENGTH + TRENCH_PERP_RADIUS)
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
export function computeBlendedBaselines(
  seeds: PlateSeed[],
  baseElevations: number[],
  renderWidth: number,
  renderHeight: number,
  worldWidth: number,
  worldHeight: number,
  warpSeed: number,
): Float32Array {
  const result = new Float32Array(renderWidth * renderHeight)
  const distances = new Float32Array(seeds.length)
  // The render grid can be coarser than the world (a low-res live preview
  // — see renderSimulationImage's elevationScale): each render pixel samples
  // a world coordinate scaled up by worldWidth/renderWidth, covering the
  // whole world at fewer points rather than only a corner of it. At full
  // resolution renderWidth === worldWidth, so scale is 1 and world coord ==
  // pixel, identical to before. Seed positions and BASELINE_BLEND_RADIUS
  // stay in world units throughout.
  const scaleX = worldWidth / renderWidth
  const scaleY = worldHeight / renderHeight
  for (let py = 0; py < renderHeight; py++) {
    const worldY = py * scaleY
    for (let px = 0; px < renderWidth; px++) {
      const worldX = px * scaleX
      // Sampled at a warped point rather than the world coord itself — see
      // domainWarp.ts. toroidalDistanceSq's own wrappedDelta already handles
      // a warped coordinate landing outside [0, worldWidth)/[0, worldHeight),
      // so the result doesn't need re-wrapping into range first.
      const wx = worldX + domainWarpDelta(worldX, worldY, worldWidth, worldHeight, warpSeed, 'x')
      const wy = worldY + domainWarpDelta(worldX, worldY, worldWidth, worldHeight, warpSeed, 'y')
      let nearestDist = Infinity
      for (let i = 0; i < seeds.length; i++) {
        const distance = Math.sqrt(toroidalDistanceSq(wx, wy, seeds[i].x, seeds[i].y, worldWidth, worldHeight))
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
      result[py * renderWidth + px] = baselineSum / weightSum
    }
  }
  return result
}

// Baseline elevation field from raft membership (rafts.ts) — the Phase-1
// replacement for the per-plate-type baseline: oceanic by default,
// continental where rafts cover, with a soft coastal transition straight out
// of the metaball membership band. Warped like the old baseline so coastlines
// stay ragged, and sampled at the render grid (which may be coarser than the
// world — same renderWidth/worldWidth scaling as computeBlendedBaselines had).
// Ocean age-depth is a later phase; this is flat ocean for now.
const RAFT_CONTINENTAL_BASELINE = 0.35
const RAFT_OCEANIC_BASELINE = -0.45
// Age-depth coefficient: the oceanic baseline drops by AGE_DEPTH_K·√age
// (oceanAge.ts), so young ridge crust sits near RAFT_OCEANIC_BASELINE and old
// basin floor sinks well below it — the real √age ocean-depth law.
const AGE_DEPTH_K = 0.045

export function computeRaftBaseline(rafts: Raft[], oceanAge: Float32Array, renderWidth: number, renderHeight: number, worldWidth: number, worldHeight: number, warpSeed: number): Float32Array {
  const result = new Float32Array(renderWidth * renderHeight)
  const scaleX = worldWidth / renderWidth
  const scaleY = worldHeight / renderHeight
  for (let py = 0; py < renderHeight; py++) {
    const worldY = py * scaleY
    for (let px = 0; px < renderWidth; px++) {
      const worldX = px * scaleX
      const wx = worldX + domainWarpDelta(worldX, worldY, worldWidth, worldHeight, warpSeed, 'x')
      const wy = worldY + domainWarpDelta(worldX, worldY, worldWidth, worldHeight, warpSeed, 'y')
      const membership = raftMembership(wx, wy, rafts, worldWidth, worldHeight)
      // Oceanic floor deepens with its age; continental (raft) crust ignores it.
      const oceanicBaseline = RAFT_OCEANIC_BASELINE - AGE_DEPTH_K * Math.sqrt(sampleOceanAge(oceanAge, wx, wy, worldWidth, worldHeight))
      result[py * renderWidth + px] = oceanicBaseline + (RAFT_CONTINENTAL_BASELINE - oceanicBaseline) * membership
    }
  }
  return result
}

// The warped sample point for a pixel — the same warp computeBlendedBaselines
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
    wx: ((rawWx % width) + width) % width,
    wy: ((rawWy % height) + height) % height,
  }
}

// Stateless distance-field query, per the decided A3 model: elevation
// anywhere is the (already blended) baseline plus a distance-weighted
// blend of nearby terrain features' accumulated thickness (converted via
// isostasy), not a value stored per point. A weighted AVERAGE (not sum)
// of overlapping features' contribution — otherwise a cluster of
// features along a long-lived range would stack without bound instead of
// blending into one continuous ridge.
//
// Takes the already-warped sample point (wx, wy) and the precomputed ridged-
// multifractal value there, rather than (x, y) + warpSeed: both are pure
// functions of position that the render worker precomputes once per world and
// caches (see warpedSamplePoint / elevationRenderWorker.ts), so this per-epoch
// hot loop does no warp or ridge noise math at all — only the dynamic feature
// blend and baseline, which are all that actually change epoch to epoch.
export function computeElevation(
  wx: number,
  wy: number,
  blendedBaseline: number,
  featureBuckets: FeatureBuckets,
  width: number,
  height: number,
  ridgeValue: number,
): number {
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
        // Capsule falloff: distance to the feature's finite boundary segment
        // (± half-length along its tangent), then a perpendicular profile.
        // The tangent's arbitrary orientation sign doesn't matter — the
        // segment is symmetric about the feature.
        const offX = wrappedDelta(wx, feature.x, width)
        const offY = wrappedDelta(wy, feature.y, height)
        const along = offX * feature.tangentX + offY * feature.tangentY
        const across = -offX * feature.tangentY + offY * feature.tangentX
        const isTrench = feature.kind === 'trench'
        const halfLength = isTrench ? TRENCH_SEGMENT_HALF_LENGTH : RANGE_SEGMENT_HALF_LENGTH
        const perpRadius = isTrench ? TRENCH_PERP_RADIUS : RANGE_PERP_RADIUS
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
        upliftSum += feature.thickness * THICKNESS_TO_ELEVATION_SCALE * weight
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
  // that uplift so only raised terrain gets rugged (RIDGE_RELATIVE_STRENGTH),
  // centered on RIDGE_MEAN so ridgelines add height and valleys cut down with
  // no net bias, and gated to positive uplift so trenches and rift valleys
  // (negative uplift) stay smooth depressions. ridgeValue is the precomputed
  // ridgedMultifractal sample at this warped point.
  const detail = uplift > 0 ? (ridgeValue - RIDGE_MEAN) * uplift * RIDGE_RELATIVE_STRENGTH : 0
  const elevation = blendedBaseline + uplift + detail
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
