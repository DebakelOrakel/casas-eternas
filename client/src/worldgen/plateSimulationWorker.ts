import { createPlateSimulation, stepEpoch } from './plateSimulation'
import type { PlateSimulation } from './plateSimulation'
import { renderSimulationImage } from './elevationMapImage'
import type { RenderSimulationOptions } from './elevationMapImage'
import type { ContinentLabelPlacement } from './continentLabelLayout'

// Runs the whole simulation off the main thread: stepping an epoch and
// rendering the full 2048x1024 raster (a per-pixel query against every
// plate and every terrain feature — see elevationField.ts) is heavy
// enough that doing it synchronously on the main thread stalls camera
// panning/input for the duration of every tick. The worker owns the
// PlateSimulation instance entirely — only the rendered RGBA buffer (and
// the couple of numbers the UI displays) cross back over.
//
// `self` is typed loosely rather than via `/// <reference lib="webworker" />`
// — that lib's ambient globals (self, postMessage, MessageEvent, ...)
// conflict with the project tsconfig's "DOM" lib, which this same file
// also picks up since it's under the single `src` tsconfig include.
declare const self: any

export interface WorkerInitMessage {
  type: 'init'
  seed: string
  plateCount: number
  continentalCount: number
  width: number
  height: number
  epochIntervalMs: number
  renderOptions: RenderSimulationOptions
}
export interface WorkerStartMessage {
  type: 'start'
}
export interface WorkerStopMessage {
  type: 'stop'
}
export type WorkerInboundMessage = WorkerInitMessage | WorkerStartMessage | WorkerStopMessage

export interface WorkerRenderedMessage {
  type: 'rendered'
  buffer: ArrayBuffer
  width: number
  height: number
  landFraction: number
  epoch: number
  // Placement geometry only — no font/text rendering available inside
  // the worker (no Canvas2D), so the main thread draws the actual labels
  // once this arrives (see WorldGenScreen.ts).
  labelPlacements: ContinentLabelPlacement[]
}

let sim: PlateSimulation | null = null
let renderOptions: RenderSimulationOptions = {}
let epochIntervalMs = 400
let intervalId: ReturnType<typeof setInterval> | undefined

function renderAndPost(): void {
  if (!sim) return
  const result = renderSimulationImage(sim, renderOptions)
  const message: WorkerRenderedMessage = {
    type: 'rendered',
    buffer: result.buffer.buffer as ArrayBuffer,
    width: sim.width,
    height: sim.height,
    landFraction: result.landFraction,
    epoch: sim.epoch,
    labelPlacements: result.labelPlacements,
  }
  // Transfers the underlying ArrayBuffer instead of copying it — safe
  // because renderSimulationImage allocates a fresh Uint8Array every call,
  // so there's no reference to the now-neutered buffer left to reuse.
  self.postMessage(message, [message.buffer])
}

function stopTicking(): void {
  if (intervalId === undefined) return
  clearInterval(intervalId)
  intervalId = undefined
}

self.onmessage = (event: MessageEvent<WorkerInboundMessage>) => {
  const message = event.data
  if (message.type === 'init') {
    stopTicking()
    sim = createPlateSimulation(message.seed, message.plateCount, message.continentalCount, message.width, message.height)
    renderOptions = message.renderOptions
    epochIntervalMs = message.epochIntervalMs
    renderAndPost()
  } else if (message.type === 'start') {
    if (intervalId !== undefined) return
    intervalId = setInterval(() => {
      if (!sim) return
      stepEpoch(sim)
      renderAndPost()
    }, epochIntervalMs)
  } else if (message.type === 'stop') {
    stopTicking()
  }
}
