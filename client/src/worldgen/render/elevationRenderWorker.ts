import { buildFeatureBuckets, computeElevation, warpedSamplePoint } from '../elevation/elevationField'
import { FINE_DETAIL_SEED_SALT, fineDetailNoise, ridgedMultifractal } from '../elevation/ridgedNoise'
import type { TerrainFeature } from '../tectonics/terrainFeatures'

// Computes raw (unshaped, unclamped-differently, uncolored) elevation for
// one horizontal band [startY, endY) of the map — spawned and owned by
// elevationRenderPool.ts, itself running inside the generator pipeline
// (a worker nested inside a worker). This is the one piece of a render
// actually worth distributing: profiling showed the per-pixel feature-
// uplift query is ~88% of total render time, with everything else
// (Voronoi rasterization, baseline blending, redistribution, coloring)
// together barely registering — so only this loop gets parallelized,
// coordinated and composited back together on the calling worker.
//
// `self` typed loosely rather than via `/// <reference lib="webworker" />`
// — same lib conflict reasoning as worldgenWorker.ts.
declare const self: any

interface RenderSliceRequest {
  type: 'renderSlice'
  requestId: number
  // Render rows this slice covers, and the render grid it belongs to. The
  // render grid may be coarser than the world (a low-res live preview): each
  // render pixel (px, py) samples world coord (px * worldWidth/renderWidth,
  // py * worldHeight/renderHeight), so features/seeds (which live in world
  // units) are covered across the whole map at fewer sample points. At full
  // res renderWidth === worldWidth and the scale is 1.
  startY: number
  endY: number
  renderWidth: number
  renderHeight: number
  worldWidth: number
  worldHeight: number
  blendedBaselineSlice: ArrayBuffer
  features: TerrainFeature[]
  warpSeed: number
}

export interface RenderSliceResponse {
  type: 'sliceRendered'
  requestId: number
  startY: number
  elevations: ArrayBuffer
}

// Per-world static precompute for this worker's band: the warped sample
// point and the ridged-multifractal value at every pixel. Both are pure
// functions of (x, y, warpSeed), and warpSeed is constant for a world's
// lifetime, so recomputing them every epoch (as the per-pixel query used to)
// is pure waste — the domain warp is 2 fBm evaluations and the ridge 4
// octaves per pixel, none of which change between epochs. This gets built
// once per world (lazily, on the first render for a given warpSeed) and
// reused for every subsequent epoch; only the dynamic feature/baseline blend
// runs per epoch. The band ([startY, endY)) is stable per worker across a
// world's renders (the pool assigns each worker a fixed row range), so the
// cache stays valid until a new world (new warpSeed or resized map) arrives.
interface StaticFieldCache {
  warpSeed: number
  startY: number
  endY: number
  renderWidth: number
  renderHeight: number
  worldWidth: number
  worldHeight: number
  warpedX: Float32Array
  warpedY: Float32Array
  ridge: Float32Array
  // fineDetailNoise at the same warped points — the plains micro-relief
  // computeElevation's fineValue parameter consumes. warpSeed-constant like
  // ridge, so cached with it.
  fine: Float32Array
}

let staticCache: StaticFieldCache | null = null

function getStaticFieldCache(
  warpSeed: number,
  startY: number,
  endY: number,
  renderWidth: number,
  renderHeight: number,
  worldWidth: number,
  worldHeight: number,
): StaticFieldCache {
  if (
    staticCache &&
    staticCache.warpSeed === warpSeed &&
    staticCache.startY === startY &&
    staticCache.endY === endY &&
    staticCache.renderWidth === renderWidth &&
    staticCache.renderHeight === renderHeight &&
    staticCache.worldWidth === worldWidth &&
    staticCache.worldHeight === worldHeight
  ) {
    return staticCache
  }
  const scaleX = worldWidth / renderWidth
  const scaleY = worldHeight / renderHeight
  const rowCount = endY - startY
  const warpedX = new Float32Array(renderWidth * rowCount)
  const warpedY = new Float32Array(renderWidth * rowCount)
  const ridge = new Float32Array(renderWidth * rowCount)
  const fine = new Float32Array(renderWidth * rowCount)
  const fineSeed = (warpSeed ^ FINE_DETAIL_SEED_SALT) >>> 0
  for (let py = startY; py < endY; py++) {
    const rowOffset = (py - startY) * renderWidth
    const worldY = py * scaleY
    for (let px = 0; px < renderWidth; px++) {
      const idx = rowOffset + px
      const worldX = px * scaleX
      const { wx, wy } = warpedSamplePoint(worldX, worldY, worldWidth, worldHeight, warpSeed)
      warpedX[idx] = wx
      warpedY[idx] = wy
      ridge[idx] = ridgedMultifractal(wx, wy, worldWidth, worldHeight, warpSeed)
      fine[idx] = fineDetailNoise(wx, wy, worldWidth, worldHeight, fineSeed)
    }
  }
  staticCache = { warpSeed, startY, endY, renderWidth, renderHeight, worldWidth, worldHeight, warpedX, warpedY, ridge, fine }
  return staticCache
}

self.onmessage = (event: MessageEvent<RenderSliceRequest>) => {
  const { requestId, startY, endY, renderWidth, renderHeight, worldWidth, worldHeight, blendedBaselineSlice, features, warpSeed } = event.data
  const baselineSlice = new Float32Array(blendedBaselineSlice)
  // Rebuilt locally from the FULL feature list (not just ones inside this
  // band) rather than trying to hand each worker a pre-filtered slice —
  // a feature just outside this band's row range can still be within
  // FEATURE_FALLOFF_RADIUS of a pixel just inside it, and rebuilding is
  // cheap regardless (buildFeatureBuckets measured under 1ms even for
  // the full map). Buckets are in world units (features live in world
  // coordinates), independent of the render grid's resolution.
  const buckets = buildFeatureBuckets(features, worldWidth, worldHeight)
  const cache = getStaticFieldCache(warpSeed, startY, endY, renderWidth, renderHeight, worldWidth, worldHeight)

  const rowCount = endY - startY
  const elevations = new Float32Array(renderWidth * rowCount)
  for (let py = startY; py < endY; py++) {
    const rowOffset = (py - startY) * renderWidth
    for (let px = 0; px < renderWidth; px++) {
      const idx = rowOffset + px
      elevations[idx] = computeElevation(cache.warpedX[idx], cache.warpedY[idx], baselineSlice[idx], buckets, worldWidth, worldHeight, cache.ridge[idx], cache.fine[idx])
    }
  }

  const message: RenderSliceResponse = { type: 'sliceRendered', requestId, startY, elevations: elevations.buffer }
  self.postMessage(message, [message.elevations])
}
