import { createPlateSimulation, getInitialPlateEvents, stepEpoch } from './plateSimulation'
import type { PlateSimulation, SimEvent } from './plateSimulation'
import { renderSimulationImage } from './elevationMapImage'
import type { BoundaryHighlight, LocationHighlight, RenderSimulationOptions } from './elevationMapImage'
import type { ContinentLabelPlacement } from './continentLabelLayout'
import { ElevationRenderPool } from './elevationRenderPool'
import { DEFAULT_EROSION_PASS_PARAMS, runErosionPass } from './erosion'
import type { ErosionPhase } from './erosion'
import { OCEAN_AGE_RES_X, OCEAN_AGE_RES_Y } from './oceanAge'

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
  // Raft model (see docs/decisions/continental-crust-rafts.md): starting land
  // coverage and how tightly continents cluster (both 0..1), and how many
  // separate continents (cratons) to seed.
  landFraction: number
  clustering: number
  cratonCount: number
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
// Runs a stream-power erosion pass (erosion.ts) once against the most
// recently rendered raw elevation field and re-renders — a one-shot
// action like 'reset', not a toggle, so there's only ever one message
// type for it. Deliberately not something that keeps running alongside
// live epoch-stepping: per docs/design/world-gen.md, geography is meant
// to settle into a frozen shape once tectonics stops, and erosion is a
// denudation pass over that settled shape, not a coupled per-epoch
// process — WorldGenScreen.ts only enables the button while the sim is
// stopped.
export interface WorkerErodeMessage {
  type: 'erode'
}
// Discards whatever erosion has done and re-renders from the elevations
// last seen right when tectonics stopped producing new ones (see
// preErosionElevations below) — a no-op if erosion hasn't touched
// anything since then, since that snapshot only ever updates from a
// non-erosion render.
export interface WorkerResetErosionMessage {
  type: 'resetErosion'
}
// Requests a WorkerExportDataMessage — see that interface for what it
// contains and why. A read of existing state, not a computation, so
// (unlike erode/resetErosion) this doesn't need to be gated behind
// renderInFlight.
export interface WorkerExportMessage {
  type: 'export'
}
export type WorkerInboundMessage =
  | WorkerInitMessage
  | WorkerStartMessage
  | WorkerStopMessage
  | WorkerErodeMessage
  | WorkerResetErosionMessage
  | WorkerExportMessage

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
  continentNames: (string | null)[]
  events: SimEvent[]
  // True for the once-per-round redraws an 'erode' request posts while
  // it's still running (see runErodeRequest) — everything about the
  // message is otherwise a normal full render (map texture, stats), but
  // WorldGenScreen.ts needs to know NOT to treat this one as "the
  // erosion operation is done" the way it would a plain render, or the
  // erode/reset-erosion buttons would re-enable and the status readout
  // would clear partway through. Always false/omitted for every other
  // render (init, epoch-driven, resetErosion, and the actual final
  // render an erode request ends with).
  intermediate?: boolean
  // DEBUG-ONLY: a coarse, nearest-neighbor-downsampled grid of the same
  // post-redistribution elevations the color map itself uses (see
  // SimulationRenderResult.elevations) — feeds the temporary 3D relief
  // preview in WorldGenScreen.ts (see toggleDebug3DView). Not part of
  // the real terrain pipeline; delete this field (and the preview
  // itself) once the actual hex-tile terrain system exists. Sent on
  // every render rather than only when the preview is open, to keep the
  // message shape uniform — the grid is small (debugHeightmapGridWidth x
  // debugHeightmapGridHeight floats) so the always-on cost is negligible.
  debugHeightmapGrid: ArrayBuffer
  debugHeightmapGridWidth: number
  debugHeightmapGridHeight: number
}

// Sent repeatedly (throttled to once per whole-percent change, not once
// per runErosionPass onProgress call — that's ~500+ calls for the
// default params) while an 'erode' request is in flight; nothing is sent
// for 'resetErosion', since that's a single already-computed render with
// no meaningful sub-progress of its own.
export interface WorkerErosionProgressMessage {
  type: 'erosionProgress'
  phase: ErosionPhase
  fraction: number
}

// Everything a future hex-tile importer needs, sent in response to
// WorkerExportMessage. Two genuinely different kinds of data, for a
// reason worth keeping straight: `plates`/`rafts`/`oceanAge`/
// `terrainFeatures` are the compact, stateless "recipe" the tectonics
// field is generated from (see docs/design/world-gen.md's "frozen
// snapshot") — re-queryable at any resolution or point, motion/kinematics
// deliberately omitted since those stop mattering once nothing's still
// moving, same as that doc already settled. `elevations` is different in
// kind, not just a convenience duplicate of the same information: erosion
// has no such compact recipe (it's the result of an iterative D8/thermal
// simulation over a discrete grid, not a stateless function of position),
// so its contribution can only ship as the actual raster it ran on.
//
// Crust type is no longer a plate property (see the raft decision doc):
// `plates` are the bare kinematic units (position + age), continental
// crust is the separate `rafts` set, and the ocean floor's depth comes
// from the coarse `oceanAge` field. Together they reproduce the baseline
// `computeRaftBaseline` builds — no per-plate type/baseElevation needed.
export interface WorkerExportDataMessage {
  type: 'exportData'
  seed: string
  epoch: number
  width: number
  height: number
  landFraction: number
  plates: {
    x: number
    y: number
    age: number
  }[]
  // Continental crust: metaball rafts (name + union of soft blobs). A point
  // is land where the summed blob field crosses the membership threshold —
  // see rafts.ts / elevationField.ts's computeRaftBaseline.
  rafts: {
    name: string | null
    blobs: { x: number; y: number; radius: number }[]
  }[]
  // Coarse ocean-floor age field (resX*resY, row-major), driving age-depth
  // on oceanic points. Cell centers at (i+0.5); sampled bilinearly wrapped.
  oceanAge: {
    resX: number
    resY: number
    values: ArrayBuffer
  }
  terrainFeatures: {
    x: number
    y: number
    thickness: number
    // Orientation + kind are part of the elevation model now (anisotropic
    // ridge falloff, trench vs. range cross-section — see
    // elevationField.ts), so a faithful server-side reproduction of the
    // terrain needs them, not just position/thickness.
    tangentX: number
    tangentY: number
    kind: string
    plateA: number
    plateB: number
  }[]
  // Float32Array bytes, width*height, row-major — pre-redistribution
  // physical values (see SimulationRenderResult.rawElevations), not the
  // cosmetic display-gamma-curved ones, since this is meant as real data
  // for a future importer, not something tuned to look good on screen.
  elevations: ArrayBuffer
}

let sim: PlateSimulation | null = null
let renderOptions: RenderSimulationOptions = {}
let epochIntervalMs = 400
let intervalId: ReturnType<typeof setInterval> | undefined
let pendingEvents: SimEvent[] = []
// The last render's pre-redistribution elevation field — physical input
// an 'erode' request needs (see WorkerErodeMessage). Kept up to date by
// every renderAndPost call, not just ones that happen while stopped, so
// erosion always has *something* to act on the first time it's used
// without needing a dedicated "prepare for erosion" render first.
let lastRawElevations: Float32Array | null = null
// PlateSimulation itself doesn't retain the original seed string (only
// the numeric hashes derived from it) — tracked here separately so
// WorkerExportDataMessage can include it.
let currentSeedString: string | null = null
// A second, deliberately less-eagerly-updated snapshot: the raw
// elevations from the last *non*-erosion render only (see renderAndPost
// — only updated when precomputedElevations wasn't supplied). Erosion
// overwrites lastRawElevations every time it runs, so without this
// there's no way back to "what tectonics actually produced" once you've
// clicked Erode even once — regenerating from scratch would mean
// re-running the whole live epoch-stepping loop again, not an instant
// revert. WorkerResetErosionMessage re-renders from this instead.
let preErosionElevations: Float32Array | null = null

interface ActivePlateHighlight {
  plateIndex: number
  startEpoch: number
}
let activePlateHighlights: ActivePlateHighlight[] = []

// Subduction removes the oceanic plate from sim.seeds entirely (see
// applyMerge), so there's no surviving plateIndex left to represent "the
// thing that just happened" — it's tracked by the event's own boundary
// coordinate instead and rendered as a point highlight (see
// LOCATION_HIGHLIGHT_RADIUS in elevationMapImage.ts) rather than tinting
// the whole plate that absorbed it.
interface ActiveLocationHighlight {
  x: number
  y: number
  startEpoch: number
}
let activeLocationHighlights: ActiveLocationHighlight[] = []

// A split's new plate is tracked here as a specific (plateIndex,
// otherPlateIndex) pair rather than as a plain plateHighlights entry —
// just the one shared edge between the new plate and the flank it split
// away from gets drawn (see BOUNDARY_HIGHLIGHT_RADIUS in
// elevationMapImage.ts), not the new plate's whole boundary, which may
// end up touching unrelated neighbors too.
interface ActiveBoundaryHighlight {
  plateIndex: number
  otherPlateIndex: number
  startEpoch: number
}
let activeBoundaryHighlights: ActiveBoundaryHighlight[] = []

const HIGHLIGHT_LIFESPAN_EPOCHS = 18

// DEBUG-ONLY, see WorkerRenderedMessage.debugHeightmapGrid — delete
// alongside that field and the preview it feeds once the real hex-tile
// terrain system exists. Nearest-neighbor, not averaged/box-filtered —
// fine for a coarse sanity-check preview, but can alias/miss narrow
// peaks or ridgelines thinner than one source-grid cell; not something
// worth fixing for a throwaway view.
const DEBUG_HEIGHTMAP_GRID_WIDTH = 256
const DEBUG_HEIGHTMAP_GRID_HEIGHT = 128
function downsampleDebugHeightmapGrid(elevations: Float32Array, width: number, height: number): Float32Array {
  const grid = new Float32Array(DEBUG_HEIGHTMAP_GRID_WIDTH * DEBUG_HEIGHTMAP_GRID_HEIGHT)
  for (let gy = 0; gy < DEBUG_HEIGHTMAP_GRID_HEIGHT; gy++) {
    const sy = Math.min(height - 1, Math.floor((gy / DEBUG_HEIGHTMAP_GRID_HEIGHT) * height))
    for (let gx = 0; gx < DEBUG_HEIGHTMAP_GRID_WIDTH; gx++) {
      const sx = Math.min(width - 1, Math.floor((gx / DEBUG_HEIGHTMAP_GRID_WIDTH) * width))
      grid[gy * DEBUG_HEIGHTMAP_GRID_WIDTH + gx] = elevations[sy * width + sx]
    }
  }
  return grid
}

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

// precomputedElevations, when passed, is an erosion pass's output (see
// the 'erode' handler below) — always explicitly set (even to undefined)
// rather than left alone, since renderOptions is a shared, reused-every-
// call object and an erosion-triggered call's value would otherwise leak
// into the next ordinary epoch-driven render. intermediate marks a
// once-per-round redraw fired mid-erosion (see runErodeRequest) — see
// WorkerRenderedMessage.intermediate for why the client needs to know.
// Downscale factor for the live-preview elevation query while the sim is
// actively stepping — see RenderSimulationOptions.elevationScale. 2 renders
// the field on a 1024x512 grid (a quarter of the pixels) and bilinearly
// upscales, for a several-times-faster preview at a slightly softer
// elevation shading; plate outlines/overlays stay full-res. Any render that
// feeds erosion/export, or the crisp paused view, uses scale 1 instead.
const PREVIEW_RENDER_SCALE = 2

async function renderAndPost(precomputedElevations?: Float32Array, intermediate = false, elevationScale = 1): Promise<void> {
  if (!sim) return
  renderOptions.precomputedElevations = precomputedElevations
  renderOptions.elevationScale = elevationScale

  const plateHighlights = new Map<number, number>()
  const nowEpoch = sim.epoch
  for (let i = activePlateHighlights.length - 1; i >= 0; i--) {
    const hl = activePlateHighlights[i]
    const age = nowEpoch - hl.startEpoch
    if (age >= HIGHLIGHT_LIFESPAN_EPOCHS) {
      activePlateHighlights.splice(i, 1)
      continue
    }
    const progress = age / HIGHLIGHT_LIFESPAN_EPOCHS
    const alpha = 1.0 - progress
    const existing = plateHighlights.get(hl.plateIndex) ?? 0
    plateHighlights.set(hl.plateIndex, Math.max(existing, alpha))
  }
  renderOptions.plateHighlights = plateHighlights

  const locationHighlights: LocationHighlight[] = []
  for (let i = activeLocationHighlights.length - 1; i >= 0; i--) {
    const hl = activeLocationHighlights[i]
    const age = nowEpoch - hl.startEpoch
    if (age >= HIGHLIGHT_LIFESPAN_EPOCHS) {
      activeLocationHighlights.splice(i, 1)
      continue
    }
    const progress = age / HIGHLIGHT_LIFESPAN_EPOCHS
    locationHighlights.push({ x: hl.x, y: hl.y, alpha: 1.0 - progress })
  }
  renderOptions.locationHighlights = locationHighlights

  const boundaryHighlights: BoundaryHighlight[] = []
  for (let i = activeBoundaryHighlights.length - 1; i >= 0; i--) {
    const hl = activeBoundaryHighlights[i]
    const age = nowEpoch - hl.startEpoch
    if (age >= HIGHLIGHT_LIFESPAN_EPOCHS) {
      activeBoundaryHighlights.splice(i, 1)
      continue
    }
    const progress = age / HIGHLIGHT_LIFESPAN_EPOCHS
    boundaryHighlights.push({ plateIndexA: hl.plateIndex, plateIndexB: hl.otherPlateIndex, alpha: 1.0 - progress })
  }
  renderOptions.boundaryHighlights = boundaryHighlights

  const result = await renderSimulationImage(sim, renderPool, renderOptions)
  lastRawElevations = result.rawElevations
  if (precomputedElevations === undefined) preErosionElevations = result.rawElevations
  const eventsToSend = pendingEvents
  pendingEvents = []
  const debugHeightmapGrid = downsampleDebugHeightmapGrid(result.elevations, sim.width, sim.height)

  const message: WorkerRenderedMessage = {
    type: 'rendered',
    buffer: result.buffer.buffer as ArrayBuffer,
    width: sim.width,
    height: sim.height,
    landFraction: result.landFraction,
    epoch: sim.epoch,
    labelPlacements: result.labelPlacements,
    continentNames: sim.continentNames,
    events: eventsToSend,
    intermediate,
    debugHeightmapGrid: debugHeightmapGrid.buffer as ArrayBuffer,
    debugHeightmapGridWidth: DEBUG_HEIGHTMAP_GRID_WIDTH,
    debugHeightmapGridHeight: DEBUG_HEIGHTMAP_GRID_HEIGHT,
  }
  // Transfers both underlying ArrayBuffers instead of copying them —
  // safe because both renderSimulationImage and
  // downsampleDebugHeightmapGrid allocate a fresh array every call, so
  // there's no reference to either now-neutered buffer left to reuse.
  self.postMessage(message, [message.buffer, message.debugHeightmapGrid])
}

// Runs one 'erode' request end to end — extracted out of the onmessage
// dispatcher (which stays a plain sync function) since runErosionPass is
// itself async now (see erosion.ts's maybeYield: it periodically yields
// to a real macrotask boundary during its long loops, which is what lets
// its onProgress-driven postMessage calls below actually reach the main
// thread live instead of arriving in one burst after the whole ~10+
// second pass finishes).
async function runErodeRequest(rawElevations: Float32Array, width: number, height: number): Promise<void> {
  // Throttled to once per whole-percent change rather than every
  // onProgress call (~500+ for the default params) — that's plenty of
  // granularity for a UI percentage readout without flooding postMessage.
  let lastReportedPercent = -1
  const erosionResult = await runErosionPass(
    rawElevations,
    width,
    height,
    DEFAULT_EROSION_PASS_PARAMS,
    (phase, fraction) => {
      const percent = Math.round(fraction * 100)
      if (percent === lastReportedPercent) return
      lastReportedPercent = percent
      const progressMessage: WorkerErosionProgressMessage = { type: 'erosionProgress', phase, fraction }
      self.postMessage(progressMessage)
    },
    // Redraws once per round rather than on every fine-grained progress
    // tick — a full redraw (Voronoi rasterization, boundary/highlight
    // blending, labels) costs nearly as much as the erosion computation
    // itself per call, so doing it at every one of the ~50-190 progress
    // ticks would roughly double or triple the total wait for little
    // added benefit over 5 visible in-progress steps.
    (roundElevations) => renderAndPost(roundElevations, true),
  )
  await renderAndPost(erosionResult.elevations)
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
    sim = createPlateSimulation(message.seed, message.plateCount, message.landFraction, message.clustering, message.cratonCount, message.width, message.height)
    currentSeedString = message.seed
    pendingEvents = getInitialPlateEvents(sim)
    activePlateHighlights = []
    activeLocationHighlights = []
    activeBoundaryHighlights = []
    lastRawElevations = null
    preErosionElevations = null
    renderOptions = message.renderOptions
    epochIntervalMs = message.epochIntervalMs
    renderAndPost()
  } else if (message.type === 'start') {
    if (intervalId !== undefined) return
    intervalId = setInterval(() => {
      if (!sim || renderInFlight) return
      const tickEvents = stepEpoch(sim)
      pendingEvents.push(...tickEvents)
      for (const ev of tickEvents) {
        if (ev.type === 'oceanic_subducted' && ev.x !== undefined && ev.y !== undefined) {
          activeLocationHighlights.push({ x: ev.x, y: ev.y, startEpoch: sim.epoch })
        } else if (ev.type === 'oceanic_created' && ev.plateIndex !== undefined && ev.otherPlateIndex !== undefined) {
          // A rift's new plate always pairs with a 'continental_split'
          // event on the same tick when the rift was continental — that
          // one is intentionally skipped below rather than also getting
          // a plateHighlights entry for the (unchanged, pre-existing)
          // continental plate; this boundary highlight already shows
          // where the split happened.
          activeBoundaryHighlights.push({ plateIndex: ev.plateIndex, otherPlateIndex: ev.otherPlateIndex, startEpoch: sim.epoch })
        } else if (ev.type === 'continental_split') {
          // no-op — see the oceanic_created branch's comment above
        } else if (ev.plateIndex !== undefined) {
          activePlateHighlights.push({ plateIndex: ev.plateIndex, startEpoch: sim.epoch })
        }
      }
      renderInFlight = true
      // Live preview renders at a coarser scale for speed (see
      // PREVIEW_RENDER_SCALE); erosion/export force full res of their own.
      renderAndPost(undefined, false, PREVIEW_RENDER_SCALE).finally(() => {
        renderInFlight = false
      })
    }, epochIntervalMs)
  } else if (message.type === 'stop') {
    stopTicking()
    // Re-render once at full resolution so the paused view is crisp (the
    // live preview above renders coarser) and lastRawElevations is refreshed
    // to a full-res field for any subsequent erode/export. Skipped if a
    // render is still in flight (the erode handler forces full res anyway).
    if (sim && !renderInFlight) {
      renderInFlight = true
      renderAndPost(undefined, false, 1).finally(() => {
        renderInFlight = false
      })
    }
  } else if (message.type === 'erode') {
    if (!sim || !lastRawElevations || renderInFlight) return
    // Multi-second at this grid size (a 2048x1024 priority-flood plus up
    // to 100 stream-power iterations, repeated for
    // DEFAULT_EROSION_PASS_PARAMS.rounds) — doesn't block the main UI
    // thread regardless (this is a dedicated worker already separate
    // from rendering/input), but see runErodeRequest's own comment for
    // why it's async rather than a tight synchronous loop.
    const currentSim = sim
    renderInFlight = true
    ;(async () => {
      // Refresh to a full-resolution field first: the live preview renders
      // coarser (PREVIEW_RENDER_SCALE), so lastRawElevations may be an
      // upscaled low-res field, and erosion must run on the crisp full-res
      // elevation rather than a blurred preview.
      await renderAndPost(undefined, false, 1)
      if (lastRawElevations) await runErodeRequest(lastRawElevations, currentSim.width, currentSim.height)
    })().finally(() => {
      renderInFlight = false
    })
  } else if (message.type === 'resetErosion') {
    if (!sim || !preErosionElevations || renderInFlight) return
    renderInFlight = true
    renderAndPost(preErosionElevations).finally(() => {
      renderInFlight = false
    })
  } else if (message.type === 'export') {
    if (!sim || !lastRawElevations || currentSeedString === null) return
    // .slice(), not the live array itself — transferring lastRawElevations.buffer
    // directly would neuter it, and the erode handler still needs to read
    // lastRawElevations after this.
    const elevations = lastRawElevations.slice()
    // .slice() for the same neutering reason as elevations — the sim keeps
    // running (and advecting) this field after the export.
    const oceanAgeValues = sim.oceanAge.slice()
    const exportMessage: WorkerExportDataMessage = {
      type: 'exportData',
      seed: currentSeedString,
      epoch: sim.epoch,
      width: sim.width,
      height: sim.height,
      landFraction: lastRawElevations.reduce((count, e) => count + (e > 0 ? 1 : 0), 0) / lastRawElevations.length,
      plates: sim.seeds.map((seed, i) => ({
        x: seed.x,
        y: seed.y,
        age: sim!.ages[i],
      })),
      rafts: sim.rafts.map((raft) => ({
        name: raft.name,
        blobs: raft.blobs.map((blob) => ({ x: blob.x, y: blob.y, radius: blob.radius })),
      })),
      oceanAge: {
        resX: OCEAN_AGE_RES_X,
        resY: OCEAN_AGE_RES_Y,
        values: oceanAgeValues.buffer as ArrayBuffer,
      },
      terrainFeatures: sim.features.map((feature) => ({
        x: feature.x,
        y: feature.y,
        thickness: feature.thickness,
        tangentX: feature.tangentX,
        tangentY: feature.tangentY,
        kind: feature.kind,
        plateA: feature.plateA,
        plateB: feature.plateB,
      })),
      elevations: elevations.buffer as ArrayBuffer,
    }
    self.postMessage(exportMessage, [exportMessage.elevations, exportMessage.oceanAge.values])
  }
}
