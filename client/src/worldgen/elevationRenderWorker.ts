import { buildFeatureBuckets, computeElevation } from './elevationField'
import type { TerrainFeature } from './terrainFeatures'

// Computes raw (unshaped, unclamped-differently, uncolored) elevation for
// one horizontal band [startY, endY) of the map — spawned and owned by
// elevationRenderPool.ts, itself running inside plateSimulationWorker.ts
// (a worker nested inside a worker). This is the one piece of a render
// actually worth distributing: profiling showed the per-pixel feature-
// uplift query is ~88% of total render time, with everything else
// (Voronoi rasterization, baseline blending, redistribution, coloring)
// together barely registering — so only this loop gets parallelized,
// coordinated and composited back together on the calling worker.
//
// `self` typed loosely rather than via `/// <reference lib="webworker" />`
// — same lib conflict reasoning as plateSimulationWorker.ts.
declare const self: any

interface RenderSliceRequest {
  type: 'renderSlice'
  requestId: number
  startY: number
  endY: number
  width: number
  height: number
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

self.onmessage = (event: MessageEvent<RenderSliceRequest>) => {
  const { requestId, startY, endY, width, height, blendedBaselineSlice, features, warpSeed } = event.data
  const baselineSlice = new Float32Array(blendedBaselineSlice)
  // Rebuilt locally from the FULL feature list (not just ones inside this
  // band) rather than trying to hand each worker a pre-filtered slice —
  // a feature just outside this band's row range can still be within
  // FEATURE_FALLOFF_RADIUS of a pixel just inside it, and rebuilding is
  // cheap regardless (buildFeatureBuckets measured under 1ms even for
  // the full map).
  const buckets = buildFeatureBuckets(features, width, height)

  const rowCount = endY - startY
  const elevations = new Float32Array(width * rowCount)
  for (let y = startY; y < endY; y++) {
    const rowOffset = (y - startY) * width
    for (let x = 0; x < width; x++) {
      const idx = rowOffset + x
      elevations[idx] = computeElevation(x, y, baselineSlice[idx], buckets, width, height, warpSeed)
    }
  }

  const message: RenderSliceResponse = { type: 'sliceRendered', requestId, startY, elevations: elevations.buffer }
  self.postMessage(message, [message.elevations])
}
