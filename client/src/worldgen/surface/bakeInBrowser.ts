import type { AmplificationInboundMessage, AmplificationOutboundMessage } from '../amplificationWorker'

// Running one amplification stage in a worker, as a promise.
//
// Extracted from WorldMapScreen when the GENERATOR gained bake buttons — a
// second caller is the trigger, not tidiness. What was worth extracting is
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
// measured run (stage 2, 79 s: ~70 s erosion against ~10 s hydrology, with
// seeding too brief to sample) — honest proportions rather than equal thirds.
export const AMPLIFY_PHASE_BANDS: Record<string, [number, number]> = {
  seed: [0, 0.05],
  erosion: [0.05, 0.9],
  hydrology: [0.9, 1],
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
  erosionStrength?: number
  drainageRefresh?: number
  riverDensity?: number
  precipitation?: Float32Array
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
      erosionStrength: request.erosionStrength,
      drainageRefresh: request.drainageRefresh,
      riverDensity: request.riverDensity,
      precipitation: request.precipitation ? (request.precipitation.slice().buffer as ArrayBuffer) : undefined,
      climateResX: request.climateResX,
      climateResY: request.climateResY,
    }
    worker.postMessage(inbound, [inbound.elevation])
  })
}
