import type { AmplificationInboundMessage, AmplificationOutboundMessage } from '../amplificationWorker'
import type { WaterBody } from './hydrology'
import { deserializeRiverGraph } from './riverGraph'
import type { RiverGraph } from './riverGraph'

// Running one amplification stage in a worker, as a promise.
//
// Extracted from the world map screen when the GENERATOR gained bake buttons —
// a second caller was the trigger, not tidiness. The map screen has since been
// removed (2026-09-20) and the generator is the caller left. What was worth extracting is
// small but easy to get subtly wrong twice: the macro raster must be COPIED
// before transfer (later stages re-read it, and a transferred buffer is gone),
// the worker must be terminated on every exit including the error path, and a
// stage that dies has to reject rather than hang, because the deepest tier can
// simply be refused by the browser.
//
// Progress arrives per phase with a fraction; the caller decides what to do
// with it. No DOM and no screen state here — the two callers report it very
// differently (a panel readout on one, a notification on the other).

// Turning the pipeline's per-phase progress into ONE fraction that only grows.
//
// Lives here, in the smallest module both callers can reach, because the two
// places that report bake progress must not drift: the pipeline reports a
// fraction WITHIN its current phase, so a bake reads `erosion 84%` and then
// `hydrology 0%`, and a bar fed that directly empties itself near the end.
// Each phase therefore owns a band of the whole. The widths come from the
// measured runs on the golden world with the pooled engine (2026-09-22,
// after the erosion moved to the active set: stage 2 in 10.7 s as 5.3 s
// seed / 1.1 s erosion / 4.0 s hydrology, stage 4 in 49 s as 24 / 5.5 /
// 19) — honest proportions rather than equal thirds.
export const AMPLIFY_PHASE_BANDS: Record<string, [number, number]> = {
  seed: [0, 0.5],
  erosion: [0.5, 0.6],
  hydrology: [0.6, 1],
}

// Undefined for a phase with no band — the cluster runner's `pending` and
// `running`, where any bar would be invented rather than measured.
export function amplifyPhaseFraction(phase: string, within: number): number | undefined {
  const band = AMPLIFY_PHASE_BANDS[phase]
  if (!band) return undefined
  return band[0] + (band[1] - band[0]) * Math.max(0, Math.min(1, within))
}

export interface BrowserBakeRequest {
  macro: Float32Array
  macroWidth: number
  macroHeight: number
  factor: number
  detailSeed: number
  erosionRounds: number
  lithoSeed: number
  alluvium?: number
  rockContrast?: number
  // The engine's coarse forcing from the save's forcing layers; absent for
  // an old save (neutral forcing — the accepted hard break).
  uplift?: Float32Array
  erodibility?: Float32Array
  forcingResX?: number
  forcingResY?: number
  precipitation?: Float32Array
  // For the lake half of the hydrology re-run; rivers do not need it.
  temperature?: Float32Array
  climateResX?: number
  climateResY?: number
}

// WHAT A BAKE PRODUCES. It lives here, with the thing that produces it, rather
// than in the artifact store that happens to persist it — a store is a consumer
// of this shape, and having the generator import it back from storage was the
// last edge pointing the wrong way up the layering.
export interface AmplificationArtifact {
  elevation: Float32Array
  width: number
  height: number
  riverPoints: Float32Array
  riverLengths: Uint32Array
  // Lake depth on the amplified grid, or null when this bake produced none
  // (no climate, or a region bake). Null means "keep the macro layer the save
  // carries", which is also what every artifact written before this layer
  // existed reads back as.
  lakeDepth: Float32Array | null
  // The basins behind the lake layer, in this artifact's texel coordinates
  // (see hydrology.WaterBody). Null when lakeDepth is, and for every artifact
  // written before the list existed.
  waterBodies: WaterBody[] | null
  // The river feature graph on this artifact's grid; null for a region
  // bake, a world without climate, a family member (its cells are indices
  // of the finest raster) and every artifact written before it existed.
  riverGraph: RiverGraph | null
}

export interface BrowserBakeResult {
  artifact: AmplificationArtifact
  durationMs: number
}

// Rejects if the worker fails. The usual cause is memory — which is the whole
// reason AMPLIFY_BAKE_STAGES exists, and why the caller must not treat a
// rejection as a bug to report loudly.
export function bakeStageInBrowser(
  request: BrowserBakeRequest,
  onProgress: (phase: string, fraction: number) => void,
  onWorker: (worker: Worker) => void = () => {},
): Promise<BrowserBakeResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../amplificationWorker.ts', import.meta.url), { type: 'module' })
    onWorker(worker) // so a caller can terminate it when its world is superseded
    let settled = false
    const finish = (): void => {
      settled = true
      worker.terminate()
    }

    worker.onmessage = (event: MessageEvent<AmplificationOutboundMessage>) => {
      if (settled) return
      const message = event.data
      if (message.type === 'amplifyProgress') {
        onProgress(message.stage, message.fraction)
        return
      }
      finish()
      resolve({
        artifact: {
          elevation: new Float32Array(message.elevation),
          width: message.width,
          height: message.height,
          riverPoints: new Float32Array(message.riverPoints),
          riverLengths: new Uint32Array(message.riverLengths),
          lakeDepth: message.lakeDepth ? new Float32Array(message.lakeDepth) : null,
          waterBodies: message.waterBodies ?? null,
          riverGraph: message.riverGraphJson && message.riverGraphCells ? deserializeRiverGraph(message.riverGraphJson, new Int32Array(message.riverGraphCells), message.riverGraphCoursePoints ? new Float32Array(message.riverGraphCoursePoints) : undefined) : null,
        },
        durationMs: message.durationMs,
      })
    }
    worker.onerror = () => {
      if (settled) return
      finish()
      reject(new Error('the amplification worker failed'))
    }

    // A COPY is transferred: the caller's macro raster stays live, because a
    // staged chain re-reads it for the next factor.
    const inbound: AmplificationInboundMessage = {
      type: 'amplify',
      elevation: request.macro.slice().buffer as ArrayBuffer,
      macroWidth: request.macroWidth,
      macroHeight: request.macroHeight,
      factor: request.factor,
      seed: request.detailSeed,
      erosionRounds: request.erosionRounds,
      lithoSeed: request.lithoSeed,
      alluvium: request.alluvium,
      rockContrast: request.rockContrast,
      uplift: request.uplift ? (request.uplift.slice().buffer as ArrayBuffer) : undefined,
      erodibility: request.erodibility ? (request.erodibility.slice().buffer as ArrayBuffer) : undefined,
      forcingResX: request.forcingResX,
      forcingResY: request.forcingResY,
      precipitation: request.precipitation ? (request.precipitation.slice().buffer as ArrayBuffer) : undefined,
      temperature: request.temperature ? (request.temperature.slice().buffer as ArrayBuffer) : undefined,
      climateResX: request.climateResX,
      climateResY: request.climateResY,
    }
    worker.postMessage(inbound, [inbound.elevation])
  })
}
