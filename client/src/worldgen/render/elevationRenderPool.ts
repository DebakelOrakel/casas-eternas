import type { TerrainFeature } from '../tectonics/terrainFeatures'
import type { RenderSliceResponse } from './elevationRenderWorker'
// Imported via Vite's `?worker` suffix rather than `new Worker(new URL(...,
// import.meta.url))`: this pool is itself constructed *inside*
// plateSimulationWorker (a worker), and Firefox leaves `import.meta.url`
// empty in a nested worker context, so the URL form resolved to an empty
// source there — the workers were created but never ran, so renderElevations
// hung forever and the map stayed on its blank placeholder (Firefox-only
// white screen; Chrome resolves the nested import.meta.url fine). The
// `?worker` form bakes the (bundled, self-contained) worker URL in at
// transform time instead, so it works the same nested or not, in every
// browser.
import ElevationRenderWorker from './elevationRenderWorker.ts?worker'

declare const self: any

// One worker per logical core (capped — diminishing returns and
// message-passing overhead past a point, and no need to ever guess
// higher than the map has rows for). Workers are created once and
// reused across every render, not respawned per epoch — worker startup
// has real overhead of its own.
const MAX_POOL_SIZE = 8
const MIN_POOL_SIZE = 1

function resolvePoolSize(): number {
  const cores = (self as any).navigator?.hardwareConcurrency ?? 4
  return Math.max(MIN_POOL_SIZE, Math.min(MAX_POOL_SIZE, cores))
}

// Owns a pool of elevationRenderWorker.ts instances and fans the one
// genuinely expensive part of a render (the per-pixel feature-uplift
// query — see that file's own comment) out across them by horizontal
// band. Everything else about a render (Voronoi rasterization, baseline
// blending, redistribution, coloring, boundary lines, labels)
// stays on the calling worker, single-threaded — profiling showed all
// of that combined is under 15% of total render time, not worth the
// complexity of distributing too.
export class ElevationRenderPool {
  private workers: Worker[]
  private nextRequestId = 0

  constructor(poolSize: number = resolvePoolSize()) {
    this.workers = Array.from({ length: poolSize }, () => new ElevationRenderWorker())
  }

  // renderWidth/renderHeight is the output grid (can be coarser than the
  // world for a low-res live preview); worldWidth/worldHeight is the space
  // features/seeds live in. blendedBaselines is at the render resolution.
  async renderElevations(
    renderWidth: number,
    renderHeight: number,
    worldWidth: number,
    worldHeight: number,
    blendedBaselines: Float32Array,
    features: TerrainFeature[],
    warpSeed: number,
  ): Promise<Float32Array> {
    const poolSize = this.workers.length
    const rowsPerWorker = Math.ceil(renderHeight / poolSize)
    const result = new Float32Array(renderWidth * renderHeight)

    const tasks = this.workers.map((worker, i) => {
      const startY = i * rowsPerWorker
      const endY = Math.min(renderHeight, startY + rowsPerWorker)
      if (startY >= endY) return Promise.resolve()

      // .slice() copies (doesn't alias blendedBaselines' own buffer), so
      // transferring the copy's buffer is safe — the shared array every
      // worker reads from stays intact for the next worker's slice.
      const baselineSlice = blendedBaselines.slice(startY * renderWidth, endY * renderWidth)
      const requestId = this.nextRequestId++

      return new Promise<void>((resolve) => {
        const handleMessage = (event: MessageEvent<RenderSliceResponse>) => {
          if (event.data.requestId !== requestId) return
          worker.removeEventListener('message', handleMessage)
          result.set(new Float32Array(event.data.elevations), startY * renderWidth)
          resolve()
        }
        worker.addEventListener('message', handleMessage)
        const message = { type: 'renderSlice', requestId, startY, endY, renderWidth, renderHeight, worldWidth, worldHeight, blendedBaselineSlice: baselineSlice.buffer, features, warpSeed }
        worker.postMessage(message, [message.blendedBaselineSlice])
      })
    })

    await Promise.all(tasks)
    return result
  }

  dispose(): void {
    for (const worker of this.workers) worker.terminate()
  }
}
