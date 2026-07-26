import { createPlateSimulation, getInitialPlateEvents, stepEpoch, serializePlateSimulation, deserializePlateSimulation } from './plateSimulation'
import type { PlateSimulation, SimEvent, PlateSimulationSnapshot } from './plateSimulation'
import { renderSimulationImage } from './elevationMapImage'
import type { PlateArrow, RenderSimulationOptions } from './elevationMapImage'
import type { ContinentLabelPlacement } from './continentLabelRenderer'
import { ElevationRenderPool } from './elevationRenderPool'
import { DEFAULT_EROSION_PASS_PARAMS, runErosionPass, fillDepressionsAndRouteFlow } from './erosion'
import type { ErosionPhase, FlowRouting, ErosionPassParams } from './erosion'
import { accumulateDischarge, extractRiverPolylines, computeLakes, computeRiparianBiomes, maxDischargeOverLand, meanLandRunoff, densityToCriticalArea, channelThreshold } from './hydrology'
import { MANTLE_RES_X, MANTLE_RES_Y } from './mantleField'
import type { TerrainFeature } from './terrainFeatures'
import { computeTemperature } from './climate/temperature'
import { computeWind } from './climate/wind'
import { computeOceanCurrents, applyOceanSST } from './climate/oceanCurrents'
import { computeSeasonalAmplitude } from './climate/seasonality'
import { computeSeasonalPrecipitation } from './climate/monsoon'
import { computeBiomes } from './climate/biomes'
import { CLIMATE_RES_X, CLIMATE_RES_Y } from './climate/climateField'
import { computeEcology } from './ecology/ecologyField'
import { computeCratonOldnessField } from './rafts'
import { computeMigration } from './migration/migrationField'
import type { MigrationOrigin } from './migration/migrationField'
import { downsampleMax } from './worldSave/worldLayers'

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
  // Multiplier on the fluvial time step — dials erosion strength up (deeper valleys,
  // more drainage rearrangement) at essentially no extra compute (it scales dh per
  // step, not the step count). Default 1.
  strength?: number
  // How many times to re-derive the drainage network per round (see
  // ErosionPassParams.networkRefreshes) — the lever that lets rivers migrate/capture,
  // at one extra priority-flood each. Default = DEFAULT_EROSION_PASS_PARAMS'.
  networkRefreshes?: number
}
// Discards whatever erosion has done and re-renders from the elevations
// last seen right when tectonics stopped producing new ones (see
// preErosionElevations below) — a no-op if erosion hasn't touched
// anything since then, since that snapshot only ever updates from a
// non-erosion render.
export interface WorkerResetErosionMessage {
  type: 'resetErosion'
}
// Requests the in-flight erosion pass stop at the next round boundary. The partial
// result is kept (lastRawElevations), so a later 'erode' continues from there.
export interface WorkerStopErosionMessage {
  type: 'stopErosion'
}
// Requests the climate step (temperature so far) be computed on the current,
// possibly-eroded elevation — see docs/decisions/climate-biomes.md. Replies
// with a WorkerClimateDataMessage.
export interface WorkerComputeClimateMessage {
  type: 'computeClimate'
  // Global temperature offset in °C (greenhouse) — see computeTemperature.
  temperatureOffset: number
  // Equator↔pole spread multiplier (1 = default) — see computeTemperature.
  temperatureContrast: number
  // Global precipitation multiplier (1 = default) — see computePrecipitation.
  humidity: number
  // Latitudinal shift of the whole zonal climate band (equator + poles), as a
  // fraction of map height (0 = default; +ve moves the equator toward the bottom).
  // Lets a continent stuck at the cold pole seam be brought under the warm equator.
  // See climateField.shiftedYNorm.
  equatorOffset: number
}
// Requests a rivers/lakes (hydrology) compute on the current topography, using
// the precipitation cached from the last computeClimate as the water source.
// `riverDensity` (0–100) is an intuitive knob the worker maps to an actual
// discharge threshold against the computed maximum (higher density = lower
// threshold = more/smaller rivers). Routing + discharge are cached in the
// worker, so a density-only change re-extracts cheaply without re-routing.
// Replies with WorkerHydrologyDataMessage.
export interface WorkerComputeHydrologyMessage {
  type: 'computeHydrology'
  riverDensity: number
}
// Requests an ecology (resource/suitability) compute on the current climate. Uses
// the cached climate temperature+precipitation as the productivity inputs and the
// sim's volcanoes for the province layer. PHASE 1: the carrying-capacity field
// only. Replies with WorkerEcologyDataMessage. See docs/decisions/ecology.md.
export interface WorkerComputeEcologyMessage {
  type: 'computeEcology'
  // Global carrying-capacity gain (%, 100 = neutral) — level knob.
  carryingCapacity: number
  // Spatial concentration (-100..100, 0 = physics as-is) — shape knob.
  concentration: number
  // Fold-out knobs. provinceStrength 0..1 (L2 volcanic-soil provinces); tinRarity
  // 0..1 (tighter tin radius); weights = per-field abundance multipliers.
  provinceStrength: number
  tinRarity: number
  weights: Record<string, number>
}
// Requests an initial-migration compute: multi-source least-cost dispersal from the
// given origins over the physical cost field, using the cached carrying capacity for
// density. Replies with WorkerMigrationDataMessage. See anthropology-initial-migration.md.
export interface WorkerComputeMigrationMessage {
  type: 'computeMigration'
  origins: MigrationOrigin[]
  spreadBudget: number
  seaCrossing: number
}
// Requests the full sim snapshot (+ ocean-age + current elevation) for saving —
// replies with a WorkerWorldDataMessage.
export interface WorkerSerializeWorldMessage {
  type: 'serializeWorld'
}
// Restores a saved world: rebuild the sim from the snapshot + ocean-age raster,
// inject the stored (post-erosion) elevation, and render it — no replay, no
// re-erosion. `seed` is the original seed string, carried in the save format
// (currently unused by the worker on restore, kept for forward compatibility).
export interface WorkerRestoreWorldMessage {
  type: 'restoreWorld'
  seed: string
  snapshot: PlateSimulationSnapshot
  oceanAge: ArrayBuffer
  elevation: ArrayBuffer
}
export type WorkerInboundMessage =
  | WorkerInitMessage
  | WorkerStartMessage
  | WorkerStopMessage
  | WorkerErodeMessage
  | WorkerResetErosionMessage
  | WorkerStopErosionMessage
  | WorkerComputeClimateMessage
  | WorkerComputeHydrologyMessage
  | WorkerComputeEcologyMessage
  | WorkerComputeMigrationMessage
  | WorkerSerializeWorldMessage
  | WorkerRestoreWorldMessage

export interface WorkerRenderedMessage {
  type: 'rendered'
  buffer: ArrayBuffer
  // Neutral relief base (Uint8, 0 = ocean) for the climate/rivers panels — the
  // screen expands it to a light-blue-water / white-shaded-land RGBA. See
  // SimulationRenderResult.relief.
  relief: ArrayBuffer
  // Coarse mantle buoyancy field (Float32, mantleResX*mantleResY) + the fixed
  // hotspot plume points — for the tectonics "Mantle" overlay (hot=upwelling red,
  // cold=downwelling blue + plume markers). See mantleField.ts.
  mantle: ArrayBuffer
  mantleResX: number
  mantleResY: number
  hotspots: { x: number; y: number }[]
  // Volcanic features for distinct markers: hotspot cones (plateB = -1), flood-basalt
  // provinces (plateB = -2), and volcanic arcs (the `volcanic` range features — Andes/
  // island-arc chains). `kind` picks the marker style; `thickness` sizes it. See
  // plateSimulation.ts.
  volcanoes: { x: number; y: number; thickness: number; kind: 'hotspot' | 'flood' | 'arc' }[]
  width: number
  height: number
  landFraction: number
  epoch: number
  // Overlay source data for the toggleable main-thread layers (no font or
  // Canvas2D in the worker, so nothing is drawn here — the screen composites
  // boundaries, arrows, names, and event markers on top of `buffer`).
  // Full-res plate-boundary mask (1 = on a Voronoi edge), as raw bytes.
  boundaryMask: ArrayBuffer
  // Per-plate velocity arrows (world coords) for the motion overlay.
  plateArrows: PlateArrow[]
  // Per-raft continent-name label geometry for the names overlay.
  raftLabels: ContinentLabelPlacement[]
  // Current plate (Voronoi seed) count — for the tectonics panel stats.
  plateCount: number
  // Sim events this render batch — the screen turns continent-scale ones
  // into notifications + geologic map markers (see the event overlay).
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

// The computed climate rasters (coarse grid — see climate/climateField.ts).
// Grows per phase.
export interface WorkerClimateDataMessage {
  type: 'climateData'
  resX: number
  resY: number
  // Temperature in °C, Float32, resX*resY row-major.
  temperature: ArrayBuffer
  // Prevailing wind, Float32 interleaved [u0,v0,…], resX*resY cells
  // (u = eastward, v = toward the bottom/"south"). See climate/wind.ts.
  wind: ArrayBuffer
  // Ocean surface currents, Float32 interleaved [u0,v0,…], normalized to max 1,
  // zero on land. See climate/oceanCurrents.ts.
  currents: ArrayBuffer
  // Annual precipitation mm/yr, Float32, resX*resY row-major; land only (ocean
  // cells carry OCEAN_PRECIP). See climate/precipitation.ts.
  precipitation: ArrayBuffer
  // Annual temperature amplitude °C (summer−winter range), Float32. See
  // climate/seasonality.ts.
  seasonalAmplitude: ArrayBuffer
  // Monsoon / precipitation-seasonality index (Float32, 0..1; OCEAN_PRECIP on ocean).
  // See climate/monsoon.ts.
  monsoonIndex: ArrayBuffer
  // Whittaker biome id per cell (Uint8; ocean = Biome.Ocean). See climate/biomes.ts.
  biomes: ArrayBuffer
}

// Rivers/lakes result for the hydrology overlay. Phase 1: river segments only
// (lakes + riparian biome feedback come in later phases). See worldgen/hydrology.ts.
export interface WorkerHydrologyDataMessage {
  type: 'hydrologyData'
  // Connected river polylines for the scene-space ribbon overlay: `riverPoints`
  // is Float32 [x, y, widthPx, …] (texel coords) with all polylines concatenated,
  // `riverLengths` is Uint32 point-counts per polyline. See extractRiverPolylines.
  riverPoints: ArrayBuffer
  riverLengths: ArrayBuffer
  // Lake water depth per full-res cell (Float32, 0 = dry). Only populated when the
  // hydrology was re-routed (lakes don't depend on the river-density knob); a
  // density-only re-extract sends an empty buffer, meaning "lakes unchanged". See
  // computeLakes.
  lakeDepth: ArrayBuffer
  // Biomes RE-classified with the riparian moisture bonus from rivers/lakes
  // (Uint8, coarse climate grid — replaces the climate step's water-free biomes).
  // Empty when no climate is available to reclassify. See computeRiparianBiomes.
  biomes: ArrayBuffer
}

// The computed ecology fields (coarse climate grid), keyed by field id so the
// set can grow per sub-step without changing the message shape. Each is Float32,
// resX*resY, land only (ECOLOGY_OCEAN sentinel on water). See ecology/ecologyField.ts.
export interface WorkerEcologyDataMessage {
  type: 'ecologyData'
  resX: number
  resY: number
  fields: { id: string; data: ArrayBuffer }[]
}

// The initial-migration result (coarse climate grid). See migration/migrationField.ts.
export interface WorkerMigrationDataMessage {
  type: 'migrationData'
  resX: number
  resY: number
  race: ArrayBuffer // Int8 owning race per cell (-1 = unreached)
  density: ArrayBuffer // Float32 population per cell
  flow: ArrayBuffer // Float32 accumulated population up the tree (arrow width)
  predecessor: ArrayBuffer // Int32 parent cell toward the origin (-1 = root/unreached)
}

// The data a world SAVE needs (see the save/load feature): the JSON-able sim
// snapshot plus the two large float rasters carried as binary buffers. The
// caller (WorldGenScreen) packages these into the zip alongside world.yaml.
export interface WorkerWorldDataMessage {
  type: 'worldData'
  snapshot: PlateSimulationSnapshot
  oceanAge: ArrayBuffer
  elevation: ArrayBuffer
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
// A second, deliberately less-eagerly-updated snapshot: the raw
// elevations from the last *non*-erosion render only (see renderAndPost
// — only updated when precomputedElevations wasn't supplied). Erosion
// overwrites lastRawElevations every time it runs, so without this
// there's no way back to "what tectonics actually produced" once you've
// clicked Erode even once — regenerating from scratch would mean
// re-running the whole live epoch-stepping loop again, not an instant
// revert. WorkerResetErosionMessage re-renders from this instead.
let preErosionElevations: Float32Array | null = null
// Set by a 'stopErosion' message; the in-flight runErosionPass polls it at each round
// boundary and returns its partial result (which then becomes lastRawElevations).
let erosionStopRequested = false

// Hydrology (rivers/lakes) cache. Precipitation from the last computeClimate is
// the river water source; routing + discharge are the expensive parts, cached
// so a threshold-only re-extract is cheap. `hydrologyDirty` forces a rebuild
// after any topography or climate change (set wherever those happen).
let lastClimatePrecip: Float32Array | null = null
let lastClimateTemperature: Float32Array | null = null
let lastClimateSeasonalAmplitude: Float32Array | null = null
let lastClimateMonsoonIndex: Float32Array | null = null
// Water-free biomes cached for the ecology step (game/pasture read biome type).
let lastClimateBiomes: Uint8Array | null = null
// Ocean currents cached for the ecology step (fish upwelling reads them).
let lastClimateCurrents: Float32Array | null = null
// The last erosion's pre-fill elevations (basins still intact) — the terrain the
// hydrology runs on, so lakes have depressions to fill. null when the current
// terrain wasn't produced by erosion (fresh tectonics / restore), in which case
// hydrology falls back to the final elevations (few lakes — erosion drains them).
let lastLakeBasinElevations: Float32Array | null = null
let lastHydrologyRouting: FlowRouting | null = null
let lastHydrologyDischarge: Float32Array | null = null
let lastHydrologyLakeDepth: Float32Array | null = null
let lastHydrologyMaxDischarge = 0
let lastHydrologyMeanRunoff = 0
let hydrologyDirty = true
// Carrying-capacity field cached from the last computeEcology — the initial-
// migration step reads it as the population/density driver.
let lastEcologyCarryingCapacity: Float32Array | null = null

// Event markers no longer live here — they moved to the main thread as
// wall-clock-faded overlay markers driven by the forwarded sim events (see
// WorldGenScreen's event overlay). The worker just relays events; it does
// not track or bake any highlight state.

// World-cell size for grid-thinning the volcanic-arc markers: a long subduction zone
// has one range feature every ~MERGE_RADIUS (40px), so hundreds accumulate — one
// (tallest) cone per this-size cell keeps the arc reading as a dotted chain without
// flooding the marker layer. Hotspots/flood basalts are few, so they're never thinned.
const ARC_MARKER_CELL = 60

// Volcanic markers for the mantle overlay: hotspot cones (plateB -1) + flood-basalt
// provinces (plateB -2), both always shown, plus ACTIVE volcanic arcs (subduction/
// island arcs still being fed at their boundary — epochsSinceDeposit small — with real
// relief), grid-thinned so a busy world doesn't send thousands. See TerrainFeature.volcanic.
function collectVolcanoes(features: TerrainFeature[]): { x: number; y: number; thickness: number; kind: 'hotspot' | 'flood' | 'arc' }[] {
  const out: { x: number; y: number; thickness: number; kind: 'hotspot' | 'flood' | 'arc' }[] = []
  const arcByCell = new Map<number, TerrainFeature>()
  for (const f of features) {
    if (f.plateB === -1) out.push({ x: f.x, y: f.y, thickness: Math.abs(f.thickness), kind: 'hotspot' })
    else if (f.plateB === -2) out.push({ x: f.x, y: f.y, thickness: Math.abs(f.thickness), kind: 'flood' })
    else if (f.volcanic && f.epochsSinceDeposit < 8 && Math.abs(f.thickness) > 3) {
      const key = Math.floor(f.y / ARC_MARKER_CELL) * 100000 + Math.floor(f.x / ARC_MARKER_CELL)
      const cur = arcByCell.get(key)
      if (!cur || Math.abs(f.thickness) > Math.abs(cur.thickness)) arcByCell.set(key, f)
    }
  }
  for (const f of arcByCell.values()) out.push({ x: f.x, y: f.y, thickness: Math.abs(f.thickness), kind: 'arc' })
  return out
}

// Current fold-mountain (continent-continent collision) belts, for the ecology
// layer's tin / lode-gold / gem provenance: 'range' features that are NON-volcanic
// (excludes subduction/island arcs) and non-subsiding (excludes oceanic ridges),
// with real positive uplift, and a real plate pair (excludes hotspot -1 / flood
// basalt -2 and rift-valley troughs, which are negative). On-crust (unlike the
// fixed-coord sutures), so they don't drift off into the ocean.
function collectOrogens(features: TerrainFeature[]): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = []
  for (const f of features) {
    if (f.kind === 'range' && !f.volcanic && !f.subsides && f.thickness > 3 && f.plateB >= 0) out.push({ x: f.x, y: f.y })
  }
  return out
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

// Bumped whenever the world is REPLACED (a fresh init, or a restored save).
// A render captures it at the start; if a newer init/restore superseded the
// world while its (async) render was in flight, that stale render is discarded
// — otherwise a slow initial pool render can land AFTER a fast precomputed
// restore render and overwrite the just-loaded world (only visible when
// loading quickly, before the initial render finished).
let worldGeneration = 0

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
  const gen = worldGeneration
  renderOptions.precomputedElevations = precomputedElevations
  renderOptions.elevationScale = elevationScale

  const result = await renderSimulationImage(sim, renderPool, renderOptions)
  // A newer init/restore replaced the world while this render was in flight —
  // discard it before it clobbers lastRawElevations or posts a stale frame.
  if (gen !== worldGeneration) return
  lastRawElevations = result.rawElevations
  hydrologyDirty = true // topography changed → rivers/lakes must re-route
  lastLakeBasinElevations = null // stale until the next erosion re-captures basins
  if (precomputedElevations === undefined) preErosionElevations = result.rawElevations
  const eventsToSend = pendingEvents
  pendingEvents = []

  const volcanoes = collectVolcanoes(sim.features)

  const message: WorkerRenderedMessage = {
    type: 'rendered',
    buffer: result.buffer.buffer as ArrayBuffer,
    relief: result.relief.buffer as ArrayBuffer,
    // Copy (not transfer) — sim.mantle is retained + mutated each epoch.
    mantle: sim.mantle.slice().buffer as ArrayBuffer,
    mantleResX: MANTLE_RES_X,
    mantleResY: MANTLE_RES_Y,
    hotspots: sim.hotspots,
    volcanoes,
    width: sim.width,
    height: sim.height,
    landFraction: result.landFraction,
    epoch: sim.epoch,
    boundaryMask: result.boundaryMask.buffer as ArrayBuffer,
    plateArrows: result.plateArrows,
    raftLabels: result.raftLabels,
    plateCount: sim.seeds.length,
    events: eventsToSend,
    intermediate,
  }
  // Transfers the underlying ArrayBuffers instead of copying them — safe
  // because renderSimulationImage (buffer + boundaryMask) allocates fresh
  // arrays every call, so there's no reference to any now-neutered buffer
  // left to reuse.
  self.postMessage(message, [message.buffer, message.relief, message.mantle, message.boundaryMask])
}

// Runs one 'erode' request end to end — extracted out of the onmessage
// dispatcher (which stays a plain sync function) since runErosionPass is
// itself async now (see erosion.ts's maybeYield: it periodically yields
// to a real macrotask boundary during its long loops, which is what lets
// its onProgress-driven postMessage calls below actually reach the main
// thread live instead of arriving in one burst after the whole ~10+
// second pass finishes).
async function runErodeRequest(rawElevations: Float32Array, width: number, height: number, opts: { strength?: number; networkRefreshes?: number } = {}): Promise<void> {
  // Throttled to once per whole-percent change rather than every
  // onProgress call (~500+ for the default params) — that's plenty of
  // granularity for a UI percentage readout without flooding postMessage.
  let lastReportedPercent = -1
  const base = DEFAULT_EROSION_PASS_PARAMS
  const strength = opts.strength && opts.strength > 0 ? opts.strength : 1
  const params: ErosionPassParams = {
    ...base,
    streamPower: {
      ...base.streamPower,
      // Strength scales the time step — more incision per step, same op count (free).
      timeStep: base.streamPower.timeStep * strength,
    },
    networkRefreshes: opts.networkRefreshes && opts.networkRefreshes > 0 ? Math.floor(opts.networkRefreshes) : base.networkRefreshes,
  }
  const erosionResult = await runErosionPass(
    rawElevations,
    width,
    height,
    params,
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
    () => erosionStopRequested,
  )
  await renderAndPost(erosionResult.elevations)
  // Keep the pre-fill (basins-intact) terrain for the hydrology's lakes — set
  // after renderAndPost, which clears it. See lastLakeBasinElevations.
  lastLakeBasinElevations = erosionResult.preFillElevations
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
    worldGeneration += 1
    sim = createPlateSimulation(message.seed, message.plateCount, message.landFraction, message.clustering, message.cratonCount, message.width, message.height)
    pendingEvents = getInitialPlateEvents(sim)
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
      // Events are forwarded to the main thread (batched with the next
      // render), which owns their notifications + faded map markers now.
      pendingEvents.push(...tickEvents)
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
    erosionStopRequested = false
    ;(async () => {
      // Refresh to a full-resolution field first: the live preview renders
      // coarser (PREVIEW_RENDER_SCALE), so lastRawElevations may be an
      // upscaled low-res field, and erosion must run on the crisp full-res
      // elevation rather than a blurred preview. Marked intermediate so the screen
      // does NOT treat this pre-erosion refresh as "erosion done" (which would clear
      // the stop icon + progress bar the instant a pass starts — see the render handler).
      await renderAndPost(undefined, true, 1)
      if (lastRawElevations) await runErodeRequest(lastRawElevations, currentSim.width, currentSim.height, { strength: message.strength, networkRefreshes: message.networkRefreshes })
    })().finally(() => {
      renderInFlight = false
    })
  } else if (message.type === 'stopErosion') {
    // The in-flight runErosionPass polls this and returns its partial result.
    erosionStopRequested = true
  } else if (message.type === 'resetErosion') {
    if (!sim || !preErosionElevations || renderInFlight) return
    renderInFlight = true
    renderAndPost(preErosionElevations).finally(() => {
      renderInFlight = false
    })
  } else if (message.type === 'computeClimate') {
    // Runs on the current, possibly-eroded elevation (lastRawElevations). A
    // fresh Float32Array per field, so its buffer can be transferred.
    if (!sim || !lastRawElevations) return
    // Order matters: base temperature → wind → ocean currents (which adjust
    // temperature via SST + coastal nudge) → precipitation (evaporation reads
    // the current-adjusted temperature, so warm currents wet their coasts).
    const temperature = computeTemperature(lastRawElevations, sim.width, sim.height, message.temperatureOffset, message.temperatureContrast, message.equatorOffset)
    const wind = computeWind(message.equatorOffset)
    const currents = computeOceanCurrents(lastRawElevations, wind, sim.width, sim.height)
    applyOceanSST(temperature, currents, lastRawElevations, sim.width, sim.height)
    // Seasonal amplitude first — the monsoon model needs it (its land-sea contrast). Then
    // run precipitation for two opposite seasons → annual mean precip + a monsoon index.
    const seasonalAmplitude = computeSeasonalAmplitude(lastRawElevations, sim.width, sim.height, message.equatorOffset)
    const seasonal = computeSeasonalPrecipitation(lastRawElevations, temperature, seasonalAmplitude, wind, sim.width, sim.height, message.humidity, message.equatorOffset)
    const precipitation = seasonal.annual
    const biomes = computeBiomes(temperature, precipitation, seasonalAmplitude, seasonal.index, lastRawElevations, sim.width, sim.height)
    // Cache copies for hydrology (the buffers below are transferred, which would
    // neuter retained references) — rivers use precip as their source, lakes use
    // the final (SST-adjusted) temperature for evaporation, riparian biomes reuse the
    // monsoon index.
    lastClimatePrecip = precipitation.slice()
    lastClimateTemperature = temperature.slice()
    lastClimateSeasonalAmplitude = seasonalAmplitude.slice()
    lastClimateMonsoonIndex = seasonal.index.slice()
    lastClimateBiomes = biomes.slice()
    lastClimateCurrents = currents.slice()
    hydrologyDirty = true
    const climateMessage: WorkerClimateDataMessage = {
      type: 'climateData',
      resX: CLIMATE_RES_X,
      resY: CLIMATE_RES_Y,
      temperature: temperature.buffer as ArrayBuffer,
      wind: wind.buffer as ArrayBuffer,
      currents: currents.buffer as ArrayBuffer,
      precipitation: precipitation.buffer as ArrayBuffer,
      seasonalAmplitude: seasonalAmplitude.buffer as ArrayBuffer,
      monsoonIndex: seasonal.index.buffer as ArrayBuffer,
      biomes: biomes.buffer as ArrayBuffer,
    }
    self.postMessage(climateMessage, [climateMessage.temperature, climateMessage.wind, climateMessage.currents, climateMessage.precipitation, climateMessage.seasonalAmplitude, climateMessage.monsoonIndex, climateMessage.biomes])
  } else if (message.type === 'computeHydrology') {
    // Needs the current topography + a climate precip (rivers' water source).
    if (!sim || !lastRawElevations || !lastClimatePrecip) return
    const { riverDensity } = message
    const width = sim.width
    const height = sim.height
    // Run hydrology on the basins-intact (pre-fill) terrain when erosion produced
    // it, so lakes have depressions to fill and rivers flow into them; otherwise
    // the final drained terrain (few lakes). Same grid, so river/lake coords still
    // line up with the displayed map.
    const elevation = lastLakeBasinElevations ?? lastRawElevations
    const precip = lastClimatePrecip
    // Async (the priority-flood routing is a Promise); the onmessage handler is
    // sync, so run it in an IIFE like the erode branch does.
    ;(async () => {
      // Re-route only when topography/climate changed; a density-only tweak
      // reuses the cached routing + discharge + lakes (the expensive parts) and
      // just re-thresholds the rivers.
      let rerouted = false
      if (hydrologyDirty || !lastHydrologyRouting || !lastHydrologyDischarge) {
        lastHydrologyRouting = await fillDepressionsAndRouteFlow(elevation, width, height, 0)
        lastHydrologyDischarge = accumulateDischarge(lastHydrologyRouting, elevation, precip, CLIMATE_RES_X, CLIMATE_RES_Y)
        lastHydrologyMaxDischarge = maxDischargeOverLand(lastHydrologyDischarge, elevation)
        lastHydrologyMeanRunoff = meanLandRunoff(precip, elevation, width, height, CLIMATE_RES_X, CLIMATE_RES_Y)
        lastHydrologyLakeDepth = lastClimateTemperature
          ? computeLakes(lastHydrologyRouting, lastHydrologyDischarge, elevation, lastClimateTemperature, CLIMATE_RES_X, CLIMATE_RES_Y)
          : new Float32Array(width * height)
        hydrologyDirty = false
        rerouted = true
      }
      const threshold = channelThreshold(densityToCriticalArea(riverDensity), lastHydrologyMeanRunoff)
      const rivers = extractRiverPolylines(lastHydrologyRouting, lastHydrologyDischarge, elevation, threshold, lastHydrologyMaxDischarge)
      // Lakes only change on a re-route; a density-only call sends an empty buffer.
      const lakeOut = rerouted && lastHydrologyLakeDepth ? lastHydrologyLakeDepth.slice() : new Float32Array(0)
      // Riparian biome reclassification depends on the channel set (so it moves
      // with the density knob) — recompute every call when climate is available.
      // Uses the display terrain (lastRawElevations) so land/ocean matches the map.
      let biomesOut: Uint8Array = new Uint8Array(0)
      if (lastRawElevations && lastClimateTemperature && lastClimateSeasonalAmplitude && lastClimateMonsoonIndex && lastHydrologyLakeDepth) {
        biomesOut = computeRiparianBiomes(lastRawElevations, lastHydrologyDischarge, threshold, lastHydrologyMaxDischarge, lastHydrologyLakeDepth, precip, lastClimateTemperature, lastClimateSeasonalAmplitude, lastClimateMonsoonIndex, width, height, CLIMATE_RES_X, CLIMATE_RES_Y)
      }
      const hydrologyMessage: WorkerHydrologyDataMessage = {
        type: 'hydrologyData',
        riverPoints: rivers.points.buffer as ArrayBuffer,
        riverLengths: rivers.lengths.buffer as ArrayBuffer,
        lakeDepth: lakeOut.buffer as ArrayBuffer,
        biomes: biomesOut.buffer as ArrayBuffer,
      }
      self.postMessage(hydrologyMessage, [hydrologyMessage.riverPoints, hydrologyMessage.riverLengths, hydrologyMessage.lakeDepth, hydrologyMessage.biomes])
    })()
  } else if (message.type === 'computeEcology') {
    // Needs a computed climate (cached temperature/precipitation/biomes feed
    // productivity + pasture) plus the current elevation (arable slope) and the
    // sim's volcanoes (province layer). Noise seeded from warpSeed. Fresh arrays,
    // so every field buffer transfers.
    if (!sim || !lastRawElevations || !lastClimateTemperature || !lastClimatePrecip || !lastClimateBiomes || !lastClimateCurrents) return
    // Hydrology (discharge/lakes) is optional here — if it hasn't been computed
    // yet, fish falls back to its marine component; the ecology panel re-triggers
    // this once hydrology lands (see WorldGenScreen's chaining).
    const cratonAge = computeCratonOldnessField(sim.rafts, sim.epoch, CLIMATE_RES_X, CLIMATE_RES_Y, sim.width, sim.height)
    const eco = computeEcology({
      temperature: lastClimateTemperature,
      precipitation: lastClimatePrecip,
      biomes: lastClimateBiomes,
      currents: lastClimateCurrents,
      elevation: lastRawElevations,
      discharge: lastHydrologyDischarge,
      maxDischarge: lastHydrologyMaxDischarge,
      lakeDepth: lastHydrologyLakeDepth,
      volcanoes: collectVolcanoes(sim.features),
      // Collision belts for tin/lode-gold/gems: current fold mountains (on-crust)
      // + the accumulated (advected) deep-time sutures.
      orogenPoints: [...collectOrogens(sim.features), ...sim.sutures],
      cratonAge,
      warpSeed: sim.warpSeed,
      worldWidth: sim.width,
      worldHeight: sim.height,
    }, {
      carryingCapacity: message.carryingCapacity,
      concentration: message.concentration,
      provinceStrength: message.provinceStrength,
      tinRarity: message.tinRarity,
      weights: message.weights,
    })
    // Cache a copy of carrying capacity BEFORE the buffers below are transferred
    // (transfer neuters them) — the migration step reads it.
    lastEcologyCarryingCapacity = eco.fields.carryingCapacity.slice()
    const fields = Object.entries(eco.fields).map(([id, data]) => ({ id, data: data.buffer as ArrayBuffer }))
    const ecologyMessage: WorkerEcologyDataMessage = {
      type: 'ecologyData',
      resX: eco.resX,
      resY: eco.resY,
      fields,
    }
    self.postMessage(ecologyMessage, fields.map((f) => f.data))
  } else if (message.type === 'computeMigration') {
    // Needs ecology's carrying capacity (density) + the current climate/hydrology
    // for the cost field. Discharge is downsampled to the coarse grid for river corridors.
    if (!sim || !lastRawElevations || !lastClimatePrecip || !lastEcologyCarryingCapacity) return
    const coarseDischarge = lastHydrologyDischarge ? downsampleMax(lastHydrologyDischarge, sim.width, sim.height, CLIMATE_RES_X, CLIMATE_RES_Y) : null
    const mig = computeMigration(lastEcologyCarryingCapacity, lastClimatePrecip, lastRawElevations, coarseDischarge, lastHydrologyMaxDischarge, message.origins, sim.width, sim.height, {
      spreadBudget: message.spreadBudget,
      seaCrossing: message.seaCrossing,
    })
    const migrationMessage: WorkerMigrationDataMessage = {
      type: 'migrationData',
      resX: mig.resX,
      resY: mig.resY,
      race: mig.race.buffer as ArrayBuffer,
      density: mig.density.buffer as ArrayBuffer,
      flow: mig.flow.buffer as ArrayBuffer,
      predecessor: mig.predecessor.buffer as ArrayBuffer,
    }
    self.postMessage(migrationMessage, [migrationMessage.race, migrationMessage.density, migrationMessage.flow, migrationMessage.predecessor])
  } else if (message.type === 'serializeWorld') {
    if (!sim || !lastRawElevations) return
    // .slice() so transferring these buffers doesn't neuter the live sim's
    // ocean-age / the worker's retained elevation.
    const oceanAge = sim.oceanAge.slice()
    const elevation = lastRawElevations.slice()
    const worldMessage: WorkerWorldDataMessage = {
      type: 'worldData',
      snapshot: serializePlateSimulation(sim),
      oceanAge: oceanAge.buffer as ArrayBuffer,
      elevation: elevation.buffer as ArrayBuffer,
    }
    self.postMessage(worldMessage, [worldMessage.oceanAge, worldMessage.elevation])
  } else if (message.type === 'restoreWorld') {
    stopTicking()
    worldGeneration += 1
    sim = deserializePlateSimulation(message.snapshot, new Float32Array(message.oceanAge))
    pendingEvents = []
    lastRawElevations = new Float32Array(message.elevation)
    // No stored pre-erosion field — a reset-erosion after a load just reverts
    // to the loaded state.
    preErosionElevations = lastRawElevations
    // Render the injected (stored, post-erosion) elevation directly — no pool
    // query, no re-erosion.
    renderAndPost(lastRawElevations, false, 1)
  }
}
