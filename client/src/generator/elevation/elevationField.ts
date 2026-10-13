import type { TerrainFeature } from '../tectonics/terrainFeatures'
import { ELEVATION_TUNING } from './elevationTuneParams'
import { capsuleWeight } from './capsule'
import type { Domain, DomainGrid } from '../core/domain'
import { domainWarpPoint } from './domainWarp'
import { RIDGE_MEAN } from './ridgedNoise'
import { OCEAN_AGE_RES_X, oceanAgeAt, oceanAgeRaster } from '../tectonics/oceanAge'
import { ABYSSAL_FLOOR, RIDGE_CREST, marginParameter, marginProfile } from './elevationScale'
import { continentalHypsometry, hypsometryRelief, hypsometryWeight } from './hypsometry'
import { buildBlobIndex, raftField, sampleOwnerField, raftFieldIndexed, type BlobIndex } from '../crust/raftField'
import type { Raft } from '../crust/raftTypes'
import { detAsin, detExp, detPow, detSin } from '../core/detMath'

// Farthest a feature can influence in any direction — its segment half-length
// plus the perpendicular cap radius. The spatial bucket index must be at
// least this wide/tall in each axis so any in-range feature lands in a point's
// own bucket or a neighbor.
// The offset `domain.delta` writes into: one per module, so no call
// allocates. Read it at once, before the next delta.
const offset = { x: 0, y: 0 }

// A range's and a trench's perpendicular radius in domain units: the
// tuning states them in metres (DEC-0036 phase 8a), the capsule measures
// in units. On the torus 234 000 / 7 800 is 30 exactly, the old constant.
export function rangePerpRadius(domain: Domain): number {
  return ELEVATION_TUNING.rangePerpRadiusM / domain.metresPerUnit
}
export function trenchPerpRadius(domain: Domain): number {
  return ELEVATION_TUNING.trenchPerpRadiusM / domain.metresPerUnit
}
export function featureMaxReach(domain: Domain): number {
  return Math.max(ELEVATION_TUNING.rangeSegmentHalfLength + rangePerpRadius(domain), ELEVATION_TUNING.trenchSegmentHalfLength + trenchPerpRadius(domain))
}

export interface FeatureBuckets {
  buckets: TerrainFeature[][]
  // The bucket lattice, bucketsX × bucketsY over the domain.
  grid: DomainGrid
  bucketsX: number
  bucketsY: number
  bucketSizeX: number
  bucketSizeY: number
  // Per bucket row, how many columns either side of the query's own a
  // feature in that row may lie and still reach it; −1 for every column.
  // 1 on the torus. Rows past the first and the last are wrapped on the
  // torus and skipped on the sphere (clampRows), where the row beyond a
  // pole is the same row across it, already searched whole.
  rowSpan: Int32Array
  clampRows: boolean
  // The bucket indices nearFeatureBuckets writes, read before its next call.
  near: Int32Array
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
// Sized to featureMaxReach (a feature's longest semi-axis) rather than a
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
//
// THE SPHERE (DEC-0035, step 4d3): a row of buckets is still at least the
// reach tall (a chart row is arc), so ±1 rows hold every feature in reach;
// but a bucket's width in arc shrinks as sin θ toward a pole, so a row is
// searched as far either side as a feature in it can reach in longitude —
// asin(sin α / sin θ) for the cap of arc α about a feature at colatitude θ,
// at the row's smallest sin θ — and whole where a cap in it can hold a pole.
// The column count is even, as every sphere grid's (across a pole is
// column + resX / 2). Without features (the Archean) any lattice serves,
// and it is two buckets by one.
export function buildFeatureBuckets(features: TerrainFeature[], domain: Domain): FeatureBuckets {
  const { width, height } = domain
  const sphere = domain.kind === 'sphere'
  const none = features.length === 0
  const reach = featureMaxReach(domain)
  const fitX = Math.max(1, Math.floor(width / reach))
  const bucketsX = none ? 2 : sphere ? Math.max(2, fitX - (fitX % 2)) : fitX
  const bucketsY = none ? 1 : Math.max(1, Math.floor(height / reach))
  const bucketSizeX = width / bucketsX
  const bucketSizeY = height / bucketsY
  const buckets: TerrainFeature[][] = Array.from({ length: bucketsX * bucketsY }, () => [])
  for (const feature of features) {
    const bx = Math.min(bucketsX - 1, Math.floor(feature.x / bucketSizeX))
    const by = Math.min(bucketsY - 1, Math.floor(feature.y / bucketSizeY))
    buckets[by * bucketsX + bx].push(feature)
  }
  const rowSpan = new Int32Array(bucketsY).fill(1)
  if (sphere) {
    const R = width / (2 * Math.PI)
    const sinReach = detSin(Math.min(Math.PI / 2, reach / R))
    for (let r = 0; r < bucketsY; r++) {
      const sinMin = Math.min(detSin((r * bucketSizeY) / R), detSin(Math.min(Math.PI, ((r + 1) * bucketSizeY) / R)))
      if (!(sinMin > sinReach)) {
        rowSpan[r] = -1
        continue
      }
      // A margin far above the rounding, as discBox's.
      const span = Math.ceil((detAsin(sinReach / sinMin) * R * (1 + 1e-9) + 1e-6) / bucketSizeX)
      rowSpan[r] = 2 * span + 1 >= bucketsX ? -1 : span
    }
  }
  return { buckets, grid: domain.grid(bucketsX, bucketsY), bucketsX, bucketsY, bucketSizeX, bucketSizeY, rowSpan, clampRows: sphere, near: new Int32Array(3 * Math.max(3, bucketsX)) }
}

// The buckets a query at (x, y) — a point in the domain — must search,
// written into `b.near`; returns their count. Each bucket once, in the
// order the torus's 3 × 3 loop always visited them (rows outer, columns
// inner, −1 to +1), so its sums are the same bits.
export function nearFeatureBuckets(b: FeatureBuckets, x: number, y: number): number {
  const { grid, bucketsX, bucketsY, rowSpan, near } = b
  const centerBx = Math.min(bucketsX - 1, Math.floor(x / b.bucketSizeX))
  const centerBy = Math.min(bucketsY - 1, Math.floor(y / b.bucketSizeY))
  let count = 0
  for (let dy = -1; dy <= 1; dy++) {
    const row = centerBy + dy
    if (b.clampRows && (row < 0 || row >= bucketsY)) continue
    const by = grid.wrapRow(row)
    const base = by * bucketsX
    const span = rowSpan[by]
    if (span < 0) {
      for (let bx = 0; bx < bucketsX; bx++) near[count++] = base + bx
      continue
    }
    for (let dx = -span; dx <= span; dx++) near[count++] = base + grid.wrapCol(centerBx + dx)
  }
  return count
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
  return 1 - ELEVATION_TUNING.gdh1OldCoeff * detExp(-ELEVATION_TUNING.gdh1OldDecay * age)
}

export function oceanFloorAtAge(age: number): number {
  return RIDGE_CREST + (ABYSSAL_FLOOR - RIDGE_CREST) * subsidenceFraction(age)
}

// The baseline at ONE world point — the per-point body computeRaftBaseline
// always ran, extracted (2026-08-06) so the micro-tile prototype
// (removed 2026-08-09) could query the baseline at arbitrary FRACTIONAL
// world coordinates: the whole pre-erosion pipeline is analytic/vector, so a
// tile sampled at sub-cell spacing gets genuinely finer terrain, not an
// upscaled raster. Takes UNWARPED world coords and applies the domain warp
// itself, exactly as the grid loop did.
// `blobs`, when given, is an index of these same rafts (crust/raftField
// buildBlobIndex) — for a sweep over many points; the value is the same.
// `oceanAge` is the field per cell of its field mesh (tectonics/oceanAge.ts),
// read here through the mesh's sampler; null (the Archean's: none yet) is
// age 0 everywhere, freshly formed crust, as computeRaftBaseline reads it.
const baselineWarp = { x: 0, y: 0 }
export function raftBaselineAt(worldX: number, worldY: number, rafts: Raft[], oceanAge: Float64Array | null, domain: Domain, warpSeed: number, blobs?: BlobIndex): number {
  domainWarpPoint(worldX, worldY, domain, warpSeed, baselineWarp)
  const age = oceanAge ? oceanAgeAt(oceanAge, domain, baselineWarp.x, baselineWarp.y) : 0
  return baselineAtWarped(baselineWarp.x, baselineWarp.y, rafts, age, domain, warpSeed, blobs)
}

// raftBaselineAt after the warp, with the ocean age at the warped point
// (epochs). `relief`, when given, holds
// hypsometryRelief per cell for the same warped points (NaN = not yet
// computed), and cell `index` is read from it or written into it.
function baselineAtWarped(wx: number, wy: number, rafts: Raft[], age: number, domain: Domain, warpSeed: number, blobs?: BlobIndex, relief?: Float64Array, index = 0): number {
  // Ocean floor deepens with its crustal age; the margin profile then shapes
  // everything from that floor up onto the continent, putting the shoreline
  // on a flat shelf instead of mid-slope (see elevationScale.marginProfile).
  const oceanicBaseline = oceanFloorAtAge(age)
  const t = marginParameter(blobs ? raftFieldIndexed(wx, wy, blobs) : raftField(wx, wy, rafts, domain))
  // Interior relief on top of the margin profile — see hypsometry.ts. Without it
  // the inside of a continent is one flat height, and a shift of the sea
  // (the former water control, the ice's eustasy) a switch rather than a
  // slider.
  let hypsometry = 0
  if (!relief) hypsometry = continentalHypsometry(wx, wy, t, domain, warpSeed)
  else if (t > ELEVATION_TUNING.hypsometryTIn) {
    let r = relief[index]
    if (r !== r) {
      r = hypsometryRelief(wx, wy, domain, warpSeed)
      relief[index] = r
    }
    hypsometry = r * hypsometryWeight(t)
  }
  return marginProfile(t, oceanicBaseline) + hypsometry
}

// The raft field through a blob index (the same bits as the scan): every
// pixel used to ask every blob, which the sphere's dearer distance made a
// matter of seconds per frame.
//
// What of a cell's baseline does not change between renders of one world is
// kept (baselineStaticCache): the warped sample point and the hypsometry's
// relief there. Both are pure functions of (x, y, warpSeed) on the domain,
// and warpSeed is constant for a world's lifetime — the same reasoning as
// the render slice worker's StaticFieldCache (elevationRenderWorker.ts).
// Only the rafts and the ocean age move between renders. Measured
// 2026-10-10 at 2048 × 1024, a render after the first: 2.3 s → 0.55 s on
// the sphere (the warp and the relief on the globe lattice), 0.79 s →
// 0.28 s on the torus. The first render of a size pays the same as before.
//
// The ocean age is read from a chart raster of it (oceanAgeRaster, cell
// centres, bilinear) rather than through the mesh's sampler: a locate per
// pixel is too dear for a render. AGE_RASTER_PER_CELL raster cells per
// field-mesh spacing: 1024 × 512. Measured 2026-10-11 at 2048 × 1024 (seed
// `bench`, 40 epochs after the hand-over) against the sampler per pixel
// (480 ms torus, 550 ms sphere): rasterising takes 93 / 115 ms, the age is
// off by 0.03 epochs on average and by at most 5.8 at a ridge's step from
// age 0 to old floor (900 m of depth there); at 512 × 256 27 / 32 ms, 0.10
// and 14 epochs (1.4 km). The coupled history does not come here — it
// evaluates the baseline per node through the sampler (raftBaselineAt) and
// renders its own terrain; this is the Archean's render and the scripts'.
// A null field (the Archean's: none yet) is age 0 everywhere, freshly
// formed crust.
const AGE_RASTER_PER_CELL = 4
export function computeRaftBaseline(rafts: Raft[], oceanAge: Float64Array | null, renderWidth: number, renderHeight: number, domain: Domain, warpSeed: number): Float32Array {
  const result = new Float32Array(renderWidth * renderHeight)
  const blobs = buildBlobIndex(rafts, domain)
  const cache = baselineStaticCache(renderWidth, renderHeight, domain, warpSeed)
  const { warpedX, warpedY, relief } = cache
  const ageResX = OCEAN_AGE_RES_X * AGE_RASTER_PER_CELL
  const ageResY = Math.max(1, Math.round((ageResX * domain.height) / domain.width))
  const ageGrid = domain.grid(ageResX, ageResY)
  const ages = oceanAge ? oceanAgeRaster(oceanAge, domain, ageResX, ageResY) : null
  for (let i = 0; i < result.length; i++) {
    const age = ages ? ageGrid.sampleBilinearAt(ages, warpedX[i], warpedY[i]) : 0
    result[i] = baselineAtWarped(warpedX[i], warpedY[i], rafts, age, domain, warpSeed, blobs, relief, i)
  }
  return result
}

// Per world and render size: the warped point of every cell, kept in
// doubles (the bits the warp returns — the baseline sums them unwrapped,
// unlike warpedSamplePoint), and the hypsometry's relief there, filled on
// the first render that reaches a cell's continent. The key is everything
// the two depend on: the shape and size of the domain, the render size and
// the seed. Two entries, the live preview's size and the full one; the
// older goes when a third arrives. 24 bytes per cell (48 MB at 2048 × 1024).
interface BaselineStaticCache {
  shape: Domain['kind']
  worldWidth: number
  worldHeight: number
  renderWidth: number
  renderHeight: number
  warpSeed: number
  warpedX: Float64Array
  warpedY: Float64Array
  relief: Float64Array
}

const BASELINE_CACHE_ENTRIES = 2
const baselineCaches: BaselineStaticCache[] = []

function baselineStaticCache(renderWidth: number, renderHeight: number, domain: Domain, warpSeed: number): BaselineStaticCache {
  const { width: worldWidth, height: worldHeight } = domain
  for (const c of baselineCaches) {
    if (
      c.shape === domain.kind &&
      c.worldWidth === worldWidth &&
      c.worldHeight === worldHeight &&
      c.renderWidth === renderWidth &&
      c.renderHeight === renderHeight &&
      c.warpSeed === warpSeed
    ) {
      return c
    }
  }
  const scaleX = worldWidth / renderWidth
  const scaleY = worldHeight / renderHeight
  const warpedX = new Float64Array(renderWidth * renderHeight)
  const warpedY = new Float64Array(renderWidth * renderHeight)
  const relief = new Float64Array(renderWidth * renderHeight).fill(NaN)
  for (let py = 0; py < renderHeight; py++) {
    const worldY = py * scaleY
    for (let px = 0; px < renderWidth; px++) {
      const worldX = px * scaleX
      domainWarpPoint(worldX, worldY, domain, warpSeed, baselineWarp)
      warpedX[py * renderWidth + px] = baselineWarp.x
      warpedY[py * renderWidth + px] = baselineWarp.y
    }
  }
  const cache: BaselineStaticCache = { shape: domain.kind, worldWidth, worldHeight, renderWidth, renderHeight, warpSeed, warpedX, warpedY, relief }
  if (baselineCaches.length >= BASELINE_CACHE_ENTRIES) baselineCaches.shift()
  baselineCaches.push(cache)
  return cache
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
// bucket; the domain's own wrapping makes the later distance checks
// correct regardless, but the bucket lookup isn't covered by that the same
// way.
//
// The warp is sampled where the Domain says (domainWarp.domainWarpPoint): a
// chart offset on the torus, a tangent offset on the sphere moved along the
// globe. The point is brought back as a point (wrapPoint), not one axis at
// a time.
const warped = { x: 0, y: 0 }
export function warpedSamplePoint(x: number, y: number, domain: Domain, warpSeed: number): { wx: number; wy: number } {
  domainWarpPoint(x, y, domain, warpSeed, warped)
  domain.wrapPoint(warped.x, warped.y, warped)
  return { wx: warped.x, wy: warped.y }
}

// THE UPLIFT DECK at a warped point: the features' crustal thickness as
// height, averaged over their capsules, before the plate carries it — the
// load (pipeline/coupledEpoch.ts sinks it by the plate's flexure).
export function upliftDeckAt(wx: number, wy: number, featureBuckets: FeatureBuckets, domain: Domain): number {
  const { buckets, near } = featureBuckets
  const nearCount = nearFeatureBuckets(featureBuckets, wx, wy)
  const rangePerp = rangePerpRadius(domain)
  const trenchPerp = trenchPerpRadius(domain)

  let upliftSum = 0
  let weightSum = 0
  for (let k = 0; k < nearCount; k++) {
    for (const feature of buckets[near[k]]) {
      // Capsule falloff (capsule.ts): the tangent's arbitrary orientation
      // sign doesn't matter — the segment is symmetric about the feature.
      const isTrench = feature.kind === 'trench'
      const halfLength = isTrench ? ELEVATION_TUNING.trenchSegmentHalfLength : ELEVATION_TUNING.rangeSegmentHalfLength
      const perpRadius = isTrench ? trenchPerp : rangePerp
      domain.delta(wx, wy, feature.x, feature.y, offset)
      const weight = capsuleWeight(offset.x, offset.y, feature.tangentX, feature.tangentY, halfLength, perpRadius)
      if (weight <= 0) continue
      upliftSum += feature.thickness * ELEVATION_TUNING.thicknessToElevationScale * weight
      weightSum += weight
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
  return weightSum > 0 ? upliftSum / Math.max(1, weightSum) : 0
}

// The synthesis's height at a warped point: the baseline, the uplift deck
// and its ridged detail, the plains' micro-relief.
//
// The deck is the raw crustal thickness as height. Its isostasy is not
// here: the plate carries the deck as a load (pipeline/coupledEpoch.ts,
// createCoupledTerrain, the flexure on the field mesh), and the caller
// adds the plate's deflection to `blendedBaseline` — a wide deck sinks
// towards its Airy share, a narrow one stands. A deflection is a regional
// answer, so no per-point function can give it; the per-point soft knee
// that stood here until DEC-0036 phase 8b-3 could not tell a plateau from
// a peak (docs/decisions/uplift-soft-knee.md). A caller with no features
// has no deck and passes the baseline alone. No ceiling either: the
// floor (−1, the elevation scale's) stays for the trenches.
export function computeElevation(
  wx: number,
  wy: number,
  blendedBaseline: number,
  featureBuckets: FeatureBuckets,
  domain: Domain,
  ridgeValue: number,
  fineValue = 0,
): number {
  const uplift = upliftDeckAt(wx, wy, featureBuckets, domain)
  // Ridged-multifractal relief on top of the smooth uplift, modulated by
  // that uplift so only raised terrain gets rugged (ELEVATION_TUNING.ridgeRelativeStrength),
  // centered on RIDGE_MEAN so ridgelines add height and valleys cut down with
  // no net bias, and gated to positive uplift so trenches and rift valleys
  // (negative uplift) stay smooth depressions. ridgeValue is the precomputed
  // ridgedMultifractal sample at this warped point.
  const detail = uplift > 0 ? (ridgeValue - RIDGE_MEAN) * uplift * ELEVATION_TUNING.ridgeRelativeStrength : 0
  let elevation = blendedBaseline + uplift + detail
  if (fineValue !== 0 && elevation > 0) elevation += fineValue * Math.min(ELEVATION_TUNING.plainDetailMax, elevation * ELEVATION_TUNING.plainDetailHeightFraction)
  return Math.max(-1, elevation)
}

export function applyMountainRedistribution(
  elevations: Float32Array,
  domain: Domain,
  ownerField: Int32Array,
  ownerResX: number,
  ownerResY: number,
): void {
  const { width, height } = domain
  const ownerGrid = domain.grid(ownerResX, ownerResY)
  // Owner looked up once per pixel and cached, not resampled in the second
  // pass — sampleOwnerField's coordinate math is cheap but pointless to redo
  // 2.1M times twice over.
  const ownerAt = new Int32Array(elevations.length)
  const maxByOwner = new Map<number, number>()
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      const owner = sampleOwnerField(ownerField, ownerGrid, x, y)
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
    elevations[i] = detPow(normalized, ELEVATION_TUNING.mountainRedistributionGamma) * maxLandElevation
  }
}
