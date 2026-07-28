import type { TerrainFeature } from '../tectonics/terrainFeatures'
import { wrappedDelta } from '../core/toroidal'
import { domainWarpDelta } from './domainWarp'
import { RIDGE_MEAN } from './ridgedNoise'
import { sampleOceanAge } from '../tectonics/oceanAge'
import { ABYSSAL_FLOOR, RIDGE_CREST, marginParameter, marginProfile } from './elevationScale'
import { wrapValue } from '../core/field'
import { raftField } from '../crust/raftField'
import type { Raft } from '../crust/raftTypes'

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
//
// Deliberately UNCHANGED by the metre recalibration, against the initial
// expectation that dropping the land baseline from 0.35 to 0.04 would need this
// roughly tripled to compensate. Measured instead (50-epoch run, 2440 features):
// land median 360 m, p90 1681 m — against Earth's ~300 m and ~1600 m. It was
// already right; what was wrong was the baseline underneath it eating most of
// the range. Lowering it to 0.030 or 0.027 was tried and only made the
// distribution worse (p90 1451 / 1314) without removing the clamp saturation,
// because that saturation isn't the mountain distribution at all — it's
// plateSimulation's FLOOD_BASALT_DEPOSIT of 50, which at any scale in this range
// is a single deposit worth more than the entire ±1 clamp. Pre-existing, and
// unaffected either way by the recalibration.
//
// Note this is the ONE knob between crustal thickness and height, which is why
// none of the deposition/decay constants in plateSimulation.ts, nor the boundary
// rates in boundaryClassification.ts, needed touching: they are all in thickness
// units and keep their proportions to each other automatically.
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

// Ocean depth from crustal age. Was RAFT_OCEANIC_BASELINE − 0.045·√age, the
// textbook √age law — which is right for YOUNG crust and wrong in exactly the
// way that mattered here: √age is unbounded, and oceanAge.ts ages crust by +1
// every epoch forever. Starting from OCEAN_AGE_INIT = 40 that reached the −1
// elevation clamp at age 149, i.e. epoch 109 of a run that typically goes 300
// to 800. Past that point every ocean cell away from a spreading ridge was
// pinned flat at the clamp: the age-depth law — the entire reason the age field
// exists — stopped producing any basin shape at all, the hillshade had nothing
// to shade, and the continent→ocean drop grew to its maximum possible size and
// kept growing with runtime. Confirmed by direct computation, not inferred.
//
// The real plate-cooling model (GDH1 and friends) doesn't run away: √age only
// holds for the first ~20 Ma of a plate's ~180 Ma life, after which subsidence
// decays exponentially toward an asymptotic depth as the lithosphere reaches
// thermal equilibrium with the mantle below it. Using that shape here means the
// floor CANNOT reach the clamp no matter how long the sim runs — it's bounded by
// construction rather than by a constant that has to be re-checked against the
// longest run anyone might do.
//
// The shape used is GDH1 (Stein & Stein 1992), the standard two-branch fit to
// real bathymetry: √age while the plate is young and cooling fast, switching at
// 20 Ma to an exponential approach to the equilibrium depth. Taken as a
// dimensionless 0..1 fraction of total subsidence, so the actual depths stay
// ours — RIDGE_CREST and ABYSSAL_FLOOR set where the curve starts and ends, and
// only its SHAPE comes from the literature.
//
// One epoch is read as one million years here, which is what lets GDH1's
// published coefficients be used as-is; it's also roughly what oceanAge's
// MAX_SEAFLOOR_AGE = 180 already implied.
//
// A single plain exponential was tried first and is the obvious cheaper thing to
// write, but it misses badly exactly where ocean floor is most visible: it has a
// finite slope at age 0 where the real curve has √age's near-vertical one, so
// young crust subsides far too slowly — measured up to 490 m too shallow across
// the 5-40 Ma band, i.e. across most of the floor around every spreading ridge.
// The two branches meet at 20 Ma to within half a metre, so the seam is not
// visible.
const GDH1_YOUNG_MAX_AGE = 20
const GDH1_YOUNG_COEFF = 365 / (5651 - 2600)
const GDH1_OLD_COEFF = 2473 / (5651 - 2600)
const GDH1_OLD_DECAY = 0.0278

// Fraction 0..1 of an ocean plate's total subsidence completed at `age` epochs.
function subsidenceFraction(age: number): number {
  if (age < GDH1_YOUNG_MAX_AGE) return GDH1_YOUNG_COEFF * Math.sqrt(age)
  return 1 - GDH1_OLD_COEFF * Math.exp(-GDH1_OLD_DECAY * age)
}

export function oceanFloorAtAge(age: number): number {
  return RIDGE_CREST + (ABYSSAL_FLOOR - RIDGE_CREST) * subsidenceFraction(age)
}

export function computeRaftBaseline(rafts: Raft[], oceanAge: Float32Array, renderWidth: number, renderHeight: number, worldWidth: number, worldHeight: number, warpSeed: number, seaLevelOffset = 0): Float32Array {
  const result = new Float32Array(renderWidth * renderHeight)
  const scaleX = worldWidth / renderWidth
  const scaleY = worldHeight / renderHeight
  for (let py = 0; py < renderHeight; py++) {
    const worldY = py * scaleY
    for (let px = 0; px < renderWidth; px++) {
      const worldX = px * scaleX
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
      result[py * renderWidth + px] = marginProfile(t, oceanicBaseline) - seaLevelOffset
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
