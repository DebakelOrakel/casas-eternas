import { ELEVATION_TUNING } from './elevationTuneParams'
import type { Domain } from '../core/domain'
import { domainWarpPoint } from './domainWarp'
import { OCEAN_AGE_RES_X, oceanAgeRaster } from '../tectonics/oceanAge'
import { ABYSSAL_FLOOR, RIDGE_CREST, marginParameter, marginProfile } from './elevationScale'
import { continentalHypsometry, hypsometryRelief, hypsometryWeight } from './hypsometry'
import { buildBlobIndex, raftField, sampleOwnerField, raftFieldIndexed, type BlobIndex } from '../crust/raftField'
import type { Raft } from '../crust/raftTypes'
import { detExp, detPow } from '../core/detMath'

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
const baselineWarp = { x: 0, y: 0 }

// The raft baseline (the engine's `raft_baseline_at`) after the warp, with the ocean age at the warped point
// (epochs). `relief`, when given, holds
// hypsometryRelief per cell for the same warped points (NaN = not yet
// computed), and cell `index` is read from it or written into it.
// `margin`, when given (not NaN), is the margin parameter at the point,
// already evaluated.
function baselineAtWarped(wx: number, wy: number, rafts: Raft[], age: number, domain: Domain, warpSeed: number, blobs?: BlobIndex, relief?: Float64Array, index = 0, margin = NaN): number {
  // Ocean floor deepens with its crustal age; the margin profile then shapes
  // everything from that floor up onto the continent, putting the shoreline
  // on a flat shelf instead of mid-slope (see elevationScale.marginProfile).
  const oceanicBaseline = oceanFloorAtAge(age)
  const t = margin === margin ? margin : marginParameter(blobs ? raftFieldIndexed(wx, wy, blobs) : raftField(wx, wy, rafts, domain))
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
// evaluates the baseline per node through the sampler (the engine's `raft_baseline_at`) and
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
// unlike the engine's `warped_sample_point`), and the hypsometry's relief there, filled on
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
