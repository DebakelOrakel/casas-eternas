import { amplifyElevation } from './surface/amplify'

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
}

export type AmplificationInboundMessage = AmplifyRequestMessage

export interface AmplifyProgressMessage {
  type: 'amplifyProgress'
  // Which part of the bake is running — 'seed' today, 'erosion' and
  // 'hydrology' as those phases land.
  stage: 'seed'
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

function handleAmplify(message: AmplifyRequestMessage): void {
  const started = performance.now()
  const macro = new Float32Array(message.elevation)
  let lastReport = -1
  const result = amplifyElevation(macro, message.macroWidth, message.macroHeight, message.factor, message.seed, (fraction) => {
    // Throttle to whole percent: the postMessage itself is cheap, but the
    // screen re-rendering a readout 4000 times is not.
    const percent = Math.floor(fraction * 100)
    if (percent === lastReport) return
    lastReport = percent
    const progress: AmplifyProgressMessage = { type: 'amplifyProgress', stage: 'seed', fraction }
    self.postMessage(progress)
  })
  const done: AmplifyDoneMessage = {
    type: 'amplifyDone',
    elevation: result.data.buffer as ArrayBuffer,
    width: result.width,
    height: result.height,
    durationMs: performance.now() - started,
  }
  self.postMessage(done, [done.elevation])
}

self.onmessage = (event: MessageEvent<AmplificationInboundMessage>) => {
  if (event.data.type === 'amplify') handleAmplify(event.data)
}
