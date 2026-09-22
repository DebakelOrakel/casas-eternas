import { runAmplification } from './surface/runAmplification'
import type { AmplifyPhase } from './surface/runAmplification'
import type { WaterBody } from './surface/hydrology'

// The amplification bake's worker (docs/decisions/worldmap-amplification.md).
// Its own worker rather than a job on the generator pipeline: the bake needs
// no simulation state at all — a raster and a few numbers in, a raster out —
// so coupling it to the generator's worker would only entangle two
// lifecycles. It is also spawned from a SCREEN, never from another worker,
// so it stays clear of the nested-worker trouble the render pool has.
//
// The whole bake runs here — upsample and seed roughness, the erosion
// engine, the hydrology re-run — and the progress reports carry the phase
// so the caller can map three phases of unequal length onto one bar.
//
// `self` is typed loosely rather than via `/// <reference lib="webworker" />`
// — same reason as generatorWorker.ts: that lib's ambient globals clash
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
  // Engine iterations to run on the amplified field. 0 skips erosion (the
  // phase-1 behaviour, still useful for isolating the seed layer).
  erosionRounds: number
  // Seed of the engine's lithology lattice (derived from the recipe by
  // world/query.ts).
  lithoSeed: number
  // The WORLD'S OWN erosion settings (spec.erosion.alluvium/rockContrast).
  // The bake must erode the way this world was eroded; undefined falls back
  // to the declared defaults (older saves).
  alluvium?: number
  rockContrast?: number
  // The engine's coarse forcing from the save's forcing layers (Float32,
  // forcingResX × forcingResY). Absent for an old save — the bake then runs
  // neutral forcing, the accepted hard break.
  uplift?: ArrayBuffer
  erodibility?: ArrayBuffer
  forcingResX?: number
  forcingResY?: number
  // Climate inputs for the hydrology re-run, decoded from the save's baked
  // layers. Coarse by nature (they are regional quantities) and simply
  // sampled onto the fine grid — see the decision doc. Absent for a world
  // saved before climate was computed; then the bake stops after erosion.
  precipitation?: ArrayBuffer
  // Temperature on the same coarse grid — needed for LAKES only (evaporation
  // decides which basins stay wet). Absent, the bake returns rivers and no
  // lake layer, and the consumer keeps the save's macro one.
  temperature?: ArrayBuffer
  climateResX?: number
  climateResY?: number
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
  // Lakes re-flooded on the amplified field's own routing, on the same grid
  // as the elevation. Absent when the bake had no temperature to evaporate
  // with — which is NOT "no lakes", but "ask the save's macro layer".
  lakeDepth?: ArrayBuffer
  // The basins behind lakeDepth, absent exactly when it is.
  waterBodies?: WaterBody[]
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
    lithoSeed: message.lithoSeed,
    alluvium: message.alluvium,
    rockContrast: message.rockContrast,
    upliftCoarse: message.uplift ? new Float32Array(message.uplift) : undefined,
    erodibilityCoarse: message.erodibility ? new Float32Array(message.erodibility) : undefined,
    forcingResX: message.forcingResX,
    forcingResY: message.forcingResY,
    precipitation: message.precipitation ? new Float32Array(message.precipitation) : undefined,
    temperature: message.temperature ? new Float32Array(message.temperature) : undefined,
    climateResX: message.climateResX,
    climateResY: message.climateResY,
  }, (phase, fraction) => reporters[phase](fraction))

  const done: AmplifyDoneMessage = {
    type: 'amplifyDone',
    elevation: result.elevation.buffer as ArrayBuffer,
    width: result.width,
    height: result.height,
    riverPoints: result.rivers.points.buffer as ArrayBuffer,
    riverLengths: result.rivers.lengths.buffer as ArrayBuffer,
    lakeDepth: result.lakeDepth ? (result.lakeDepth.buffer as ArrayBuffer) : undefined,
    waterBodies: result.waterBodies ?? undefined,
    durationMs: performance.now() - started,
  }
  const transfer: ArrayBuffer[] = [done.elevation, done.riverPoints, done.riverLengths]
  if (done.lakeDepth) transfer.push(done.lakeDepth)
  self.postMessage(done, transfer)
}

self.onmessage = (event: MessageEvent<AmplificationInboundMessage>) => {
  if (event.data.type === 'amplify') void handleAmplify(event.data)
}
