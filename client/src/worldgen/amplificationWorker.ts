import { amplifyElevation, erosionParamsForCellSize } from './surface/amplify'
import { DEFAULT_EROSION_PASS_PARAMS, erosionParamsWithControls, runErosionPass } from './surface/erosion'

// The amplification bake's worker (docs/decisions/worldmap-amplification.md).
// Its own worker rather than a job on plateSimulationWorker: the bake needs
// no simulation state at all — a raster and a few numbers in, a raster out —
// so coupling it to the generator's worker would only entangle two
// lifecycles. It is also spawned from a SCREEN, never from another worker,
// so it stays clear of the nested-worker trouble the render pool has.
//
// Phase 1 does upsample + seed roughness only; erosion and the hydrology
// re-run land here next, which is why the message shape already carries the
// stage in its progress reports.
//
// `self` is typed loosely rather than via `/// <reference lib="webworker" />`
// — same reason as plateSimulationWorker: that lib's ambient globals clash
// with the project tsconfig's "DOM" lib, which this file also picks up.
declare const self: any

export interface AmplifyRequestMessage {
  type: 'amplify'
  // The authoritative macro elevation raster (transferred; the caller keeps
  // its own copy of the save's data).
  elevation: ArrayBuffer
  macroWidth: number
  macroHeight: number
  // Linear refinement factor: 2 → 4096x2048 (~3.9 km/cell), 4 → 8192x4096
  // (~1.95 km/cell, the decided target).
  factor: number
  // Derived from the world so a given world always bakes identically.
  seed: number
  // Erosion rounds to run on the amplified field. 0 skips erosion (the
  // phase-1 behaviour, still useful for isolating the seed layer).
  erosionRounds: number
  // The WORLD'S OWN erosion settings, as recorded in its save
  // (spec.erosion.erosionStrength / drainageRefresh). The bake must erode
  // the way this world was eroded — a world tuned for gentle incision
  // should not come back from an amplification bake carved like a world
  // tuned for aggressive incision. Undefined falls back to the defaults
  // (older saves, or a save that never recorded them).
  erosionStrength?: number
  drainageRefresh?: number
}

export type AmplificationInboundMessage = AmplifyRequestMessage

export interface AmplifyProgressMessage {
  type: 'amplifyProgress'
  // Which part of the bake is running — 'hydrology' joins as that phase
  // lands.
  stage: 'seed' | 'erosion'
  fraction: number
}

export interface AmplifyDoneMessage {
  type: 'amplifyDone'
  elevation: ArrayBuffer
  width: number
  height: number
  // Wall-clock milliseconds, so the screen (and a human) can see what the
  // bake actually costs at this resolution.
  durationMs: number
}

export type AmplificationOutboundMessage = AmplifyProgressMessage | AmplifyDoneMessage

// Throttled to whole percent per stage: postMessage is cheap, but a screen
// re-rendering its readout thousands of times is not.
function makeProgressReporter(stage: 'seed' | 'erosion'): (fraction: number) => void {
  let lastPercent = -1
  return (fraction: number) => {
    const percent = Math.floor(fraction * 100)
    if (percent === lastPercent) return
    lastPercent = percent
    const progress: AmplifyProgressMessage = { type: 'amplifyProgress', stage, fraction }
    self.postMessage(progress)
  }
}

async function handleAmplify(message: AmplifyRequestMessage): Promise<void> {
  const started = performance.now()
  const macro = new Float32Array(message.elevation)
  const result = amplifyElevation(macro, message.macroWidth, message.macroHeight, message.factor, message.seed, makeProgressReporter('seed'))

  let field = result.data
  if (message.erosionRounds > 0) {
    // The seeded field IS the tectonic surface as far as this pass is
    // concerned: runErosionPass reads its input both as the terrain to
    // erode and as the uplift envelope it may not exceed, which is exactly
    // the contract we want here — the macro world (refined) stays the
    // ceiling, so amplification can carve INTO the authoritative shape but
    // never inflate past it.
    // Order matters only for readability, not arithmetic: the world's own
    // slider settings first (what this world's erosion MEANS), then the
    // per-cell rescaling (what the finer grid needs), then the round budget.
    const withControls = erosionParamsWithControls(DEFAULT_EROSION_PASS_PARAMS, {
      strength: message.erosionStrength,
      networkRefreshes: message.drainageRefresh,
    })
    const params = {
      ...erosionParamsForCellSize(withControls, 1 / message.factor),
      rounds: message.erosionRounds,
    }
    const reportErosion = makeProgressReporter('erosion')
    const eroded = await runErosionPass(field, result.width, result.height, params, (_phase, fraction) => reportErosion(fraction))
    field = eroded.elevations
  }

  const done: AmplifyDoneMessage = {
    type: 'amplifyDone',
    elevation: field.buffer as ArrayBuffer,
    width: result.width,
    height: result.height,
    durationMs: performance.now() - started,
  }
  self.postMessage(done, [done.elevation])
}

self.onmessage = (event: MessageEvent<AmplificationInboundMessage>) => {
  if (event.data.type === 'amplify') void handleAmplify(event.data)
}
