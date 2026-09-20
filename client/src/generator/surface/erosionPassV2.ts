import type { FlowRouting } from './flowRouting'
import {
  ErosionEngine,
  DEFAULT_ENGINE_PARAMS,
  type ErosionEngineParams,
  type ErosionForcing,
} from './erosionEngine'
import { PipelinedErosionEngine, type PipelineOptions, type WorkerLike } from './erosionEnginePool'
import { engineFlowRouting } from './erosionEngineBridge'

// EROSION V2 — the pipeline-facing pass (docs/design/erosion-v2.md, the P2
// switchover). Wraps the engine in v1's runErosionPass CONTRACT — the same
// { elevations, routing, accumulation, preFillElevations } result — so the
// generator pipeline swaps implementations without its consumers moving.
//
// Two deliberate contract SHIFTS, both improvements the caller must know:
//
//   - `elevations` is the engine's honest z: depressions are NOT baked to
//     their spill (v1 returned the flood-filled surface and then needed
//     the enclosed-water restore hack to dig sub-sea basins back out).
//     Closed basins keep their true floor; lakes are the hydrology's job,
//     via the routing this same result carries.
//   - `preFillElevations` therefore equals `elevations` (a separate copy,
//     since the pipeline hands them to different owners). Under v1 they
//     differed by exactly the baked fill; the rivers/lakes pass keeps
//     working because what it actually wants — basins intact — is now
//     true of BOTH fields.
//
// The BAKE (runAmplification) deliberately stays on v1 until P3: bake
// grids are untested memory territory for the engine's stride-8 MFD (see
// erosionEngineState.ts's sizing note).
//
// Age is iterations; the caller owns the mapping from its slider. Runs
// pooled+pipelined when the caller supplies workers (the browser's worldgen
// worker, behind cross-origin isolation), single-threaded otherwise (Node
// harnesses, and any browser without SAB).

export interface ErosionPassV2Result {
  elevations: Float32Array
  routing: FlowRouting
  accumulation: Float32Array
  preFillElevations: Float32Array
}

export interface ErosionPassV2Options {
  // The landscape age, in engine iterations — the product's central axis
  // (P0: age 25 keeps inherited relief and dendritic texture, age 400 is
  // the smooth equilibrium).
  age: number
  // Routing refresh cadence for the synchronous paths (K ≤ 8 validated).
  routingEvery?: number
  // Present → pooled + pipelined execution. The factory owns the substrate
  // (browser `?worker` form or Node worker_threads).
  pool?: { createWorker: () => WorkerLike } & PipelineOptions
  // Fraction 0..1, once per iteration.
  onProgress?: (fraction: number) => void
  // A copy of the terrain every ~eighth of the run — the pipeline redraws
  // the map from it, same cadence philosophy as v1's per-round redraws.
  onChunkComplete?: (elevations: Float32Array, chunk: number) => void | Promise<void>
  // Checked between iterations; true stops early and returns the partial
  // result (the age slider's stop button).
  shouldCancel?: () => boolean
  params?: ErosionEngineParams
}

const PROGRESS_CHUNKS = 8

export async function runErosionPassV2(
  rawElevations: Float32Array,
  width: number,
  height: number,
  forcing: ErosionForcing,
  options: ErosionPassV2Options,
): Promise<ErosionPassV2Result> {
  const params = options.params ?? DEFAULT_ENGINE_PARAMS
  const chunkSize = Math.max(1, Math.ceil(options.age / PROGRESS_CHUNKS))

  if (options.pool) {
    const { createWorker, ...pipeline } = options.pool
    const engine = await PipelinedErosionEngine.create(width, height, rawElevations, forcing, createWorker, pipeline, params)
    try {
      let done = 0
      while (done < options.age) {
        const step = Math.min(chunkSize, options.age - done)
        engine.run(step, (iteration) => options.onProgress?.((done + iteration + 1) / options.age))
        done += step
        if (options.onChunkComplete) await options.onChunkComplete(engine.z.slice(), done / chunkSize)
        if (options.shouldCancel?.()) break
      }
      const popped = engine.finalizeRouting()
      return {
        elevations: engine.z.slice(),
        preFillElevations: engine.z.slice(),
        routing: engineFlowRouting(engine.activeEngineViews, width, height, popped),
        accumulation: engine.activeEngineViews.accumulation,
      }
    } finally {
      await engine.close()
    }
  }

  const engine = new ErosionEngine(width, height, rawElevations, forcing, params)
  const routingEvery = options.routingEvery ?? 4
  let done = 0
  while (done < options.age) {
    const step = Math.min(chunkSize, options.age - done)
    engine.run(step, routingEvery, (iteration) => options.onProgress?.((done + iteration + 1) / options.age))
    done += step
    if (options.onChunkComplete) await options.onChunkComplete(engine.z.slice(), done / chunkSize)
    if (options.shouldCancel?.()) break
  }
  engine.refreshRouting()
  return {
    elevations: engine.z.slice(),
    preFillElevations: engine.z.slice(),
    routing: engineFlowRouting(engine.views, width, height, engine.poppedCount),
    accumulation: engine.views.accumulation,
  }
}
