import { runAmplification } from './surface/runAmplification'
import type { AmplifyPhase } from './surface/runAmplification'

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
  // Climate inputs for the hydrology re-run, decoded from the save's baked
  // layers. Coarse by nature (they are regional quantities) and simply
  // sampled onto the fine grid — see the decision doc. Absent for a world
  // saved before climate was computed; then the bake stops after erosion.
  precipitation?: ArrayBuffer
  climateResX?: number
  climateResY?: number
  // The world's own river-density setting (spec.hydrology.riverDensity).
  riverDensity?: number
}

export type AmplificationInboundMessage = AmplifyRequestMessage

export interface AmplifyProgressMessage {
  type: 'amplifyProgress'
  stage: 'seed' | 'erosion' | 'hydrology'
  fraction: number
}

export interface AmplifyDoneMessage {
  type: 'amplifyDone'
  elevation: ArrayBuffer
  width: number
  height: number
  // Rivers re-extracted from the amplified field's OWN routing (empty when
  // the world carried no climate to route with). Texel coordinates are in
  // the amplified grid — the same width/height above, which the renderer
  // must use as its texel space.
  riverPoints: ArrayBuffer
  riverLengths: ArrayBuffer
  // Wall-clock milliseconds, so the screen (and a human) can see what the
  // bake actually costs at this resolution.
  durationMs: number
}

export type AmplificationOutboundMessage = AmplifyProgressMessage | AmplifyDoneMessage

// Throttled to whole percent per stage: postMessage is cheap, but a screen
// re-rendering its readout thousands of times is not.
function makeProgressReporter(stage: AmplifyProgressMessage['stage']): (fraction: number) => void {
  let lastPercent = -1
  return (fraction: number) => {
    const percent = Math.floor(fraction * 100)
    if (percent === lastPercent) return
    lastPercent = percent
    const progress: AmplifyProgressMessage = { type: 'amplifyProgress', stage, fraction }
    self.postMessage(progress)
  }
}

// A thin wrapper around surface/runAmplification: the bake itself lives there
// so the SERVER's baker runs the identical pipeline. An artifact carries a key
// derived from its inputs, so a browser bake and a server bake of one world
// must produce the same bytes — which two copies of the pipeline could only do
// until someone edited one.
async function handleAmplify(message: AmplifyRequestMessage): Promise<void> {
  const started = performance.now()
  const reporters: Record<AmplifyPhase, (fraction: number) => void> = {
    seed: makeProgressReporter('seed'),
    erosion: makeProgressReporter('erosion'),
    hydrology: makeProgressReporter('hydrology'),
  }
  const result = await runAmplification({
    elevation: new Float32Array(message.elevation),
    macroWidth: message.macroWidth,
    macroHeight: message.macroHeight,
    factor: message.factor,
    seed: message.seed,
    erosionRounds: message.erosionRounds,
    erosionStrength: message.erosionStrength,
    drainageRefresh: message.drainageRefresh,
    precipitation: message.precipitation ? new Float32Array(message.precipitation) : undefined,
    climateResX: message.climateResX,
    climateResY: message.climateResY,
    riverDensity: message.riverDensity,
  }, (phase, fraction) => reporters[phase](fraction))

  const done: AmplifyDoneMessage = {
    type: 'amplifyDone',
    elevation: result.elevation.buffer as ArrayBuffer,
    width: result.width,
    height: result.height,
    riverPoints: result.rivers.points.buffer as ArrayBuffer,
    riverLengths: result.rivers.lengths.buffer as ArrayBuffer,
    durationMs: performance.now() - started,
  }
  self.postMessage(done, [done.elevation, done.riverPoints, done.riverLengths])
}

self.onmessage = (event: MessageEvent<AmplificationInboundMessage>) => {
  if (event.data.type === 'amplify') void handleAmplify(event.data)
}
