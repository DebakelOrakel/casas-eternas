import { createPlateSimulation, stepEpoch } from './plateSimulation'
import type { PlateSimulation } from './plateSimulation'
import { renderSimulationImage } from './elevationMapImage'
import type { RenderSimulationOptions } from './elevationMapImage'
import type { ContinentLabelPlacement } from './continentLabelLayout'
import { ElevationRenderPool } from './elevationRenderPool'

// Runs the whole simulation off the main thread: stepping an epoch and
// rendering the full 2048x1024 raster (a per-pixel query against every
// plate and every terrain feature — see elevationField.ts) is heavy
// enough that doing it synchronously on the main thread stalls camera
// panning/input for the duration of every tick. The worker owns the
// PlateSimulation instance entirely — only the rendered RGBA buffer (and
// the couple of numbers the UI displays) cross back over.
//
// This worker is itself a coordinator, not the one doing the expensive
// per-pixel work anymore — it owns a pool of further-nested workers (see
// elevationRenderPool.ts) that the actual elevation query gets farmed
// out to, since profiling showed that single loop is ~88% of render
// time and is trivially parallel (every pixel's elevation is independent
// of every other pixel, given the current seeds/features state).
// stepEpoch itself stays right here, sequential — it has real epoch-to-
// epoch dependencies (boundary detection depends on current seeds,
// deposits depend on boundary detection, rift/merge depend on deposits)
// that can't be farmed out the same way.
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
// Created once and reused for the lifetime of this worker — pool workers
// have their own startup cost, not worth paying every epoch.
const renderPool = new ElevationRenderPool()
// Renders are now async (they await the pool) — without this guard, a
// render that takes longer than epochIntervalMs would still be in
// flight when the next interval tick fires, and that tick's stepEpoch
// call would mutate sim.seeds/features while the in-flight render's
// pool dispatch is still reading them. Skipping the whole tick (not just
// the render) when busy keeps stepEpoch and an in-flight render from
// ever overlapping — the simulation simply paces itself to whatever the
// render pool can actually keep up with, rather than risking a torn
// read.
let renderInFlight = false

async function renderAndPost(): Promise<void> {
  if (!sim) return
  const result = await renderSimulationImage(sim, renderPool, renderOptions)
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
      if (!sim || renderInFlight) return
      stepEpoch(sim)
      renderInFlight = true
      renderAndPost().finally(() => {
        renderInFlight = false
      })
    }, epochIntervalMs)
  } else if (message.type === 'stop') {
    stopTicking()
  }
}
