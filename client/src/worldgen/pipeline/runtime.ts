import { stepEpoch, serializePlateSimulation, deserializePlateSimulation } from '../tectonics/plateSimulation'
import type { PlateSimulation, SimEvent, PlateSimulationSnapshot } from '../tectonics/plateSimulation'
import { renderSimulationImage } from '../render/elevationMapImage'
import type { RenderSimulationOptions } from '../render/elevationMapImage'
import { ElevationRenderPool } from '../render/elevationRenderPool'
import type { ElevationRenderer } from '../render/elevationRenderPool'
import { downstreamOf } from './stages'
import type { StageId } from './stages'
import { runErosionPassV2 } from '../surface/erosionPassV2'
import type { WorkerLike } from '../surface/erosionEnginePool'
import { assembleErosionForcing, coarseForcingFields } from './erosionForcing'
import { fillDepressionsAndRouteFlow } from '../surface/flowRouting'
import type { ArcheanSimulation } from '../archean/archeanState'
import { createArcheanSimulation } from '../archean/archeanState'
import { deserializeArchean, serializeArchean } from '../archean/archeanSnapshot'
import type { ArcheanParams } from '../archean/archeanStep'
import { archeanStep, DEFAULT_ARCHEAN_PARAMS } from '../archean/archeanStep'
import { convectionCellSeeds, finalizeArchean } from '../archean/finalizeArchean'
import { findPlumeSites } from '../tectonics/plumes'
import { stabilisedFraction } from '../crust/raftField'
import { worldAgeMa, worldEpoch } from '../core/worldTime'
import { OCEAN_AGE_RES_X, OCEAN_AGE_RES_Y } from '../tectonics/oceanAge'
import type { FlowRouting } from '../surface/flowRouting'
import { accumulateDischarge, extractRiverPolylines, computeLakes, computeRiparianBiomes, computeWatersheds, maxDischargeOverLand, meanLandRunoff, densityToCriticalArea, channelThreshold } from '../surface/hydrology'
import { MANTLE_RES_X, MANTLE_RES_Y } from '../mantle/mantleField'
import type { TerrainFeature } from '../tectonics/terrainFeatures'
import { computeWeather, defaultWeatherParams } from '../climate/weather'
import type { WeatherParams } from '../climate/weather'
import { computeBiomes, computeBiomesFine } from '../climate/biomes'
import { downsampleMax } from '../core/field'
import { CLIMATE_RES_X, CLIMATE_RES_Y, sampleElevationAtCell } from '../climate/climateField'
import { computeEcology } from '../ecology/ecologyField'
import { computeMigration } from '../migration/migrationField'
import { collectVolcanoes } from '../tectonics/volcanoes'
import { computeCratonOldnessField } from '../crust/raftField'
import type { WorkerStageDeclinedMessage, WorkerGenesisStatusMessage, WorkerClimateDataMessage, WorkerEcologyDataMessage, WorkerElevationFieldMessage, WorkerErosionProgressMessage, WorkerHydrologyDataMessage, WorkerInboundMessage, WorkerMigrationDataMessage, WorkerRenderedMessage, WorkerWorldDataMessage } from './messages'

// The generator pipeline: it holds the live state of every stage — archean,
// tectonics, erosion, climate, hydrology, ecology, migration — and runs them on
// demand. It owns the PlateSimulation instance entirely; only the rendered RGBA
// buffer and the handful of numbers the UI displays ever leave.
//
// It is itself a coordinator, not the thing doing the expensive per-pixel work:
// it owns a pool of nested workers (see render/elevationRenderPool.ts) that the
// elevation query is farmed out to, since profiling showed that single loop is
// ~88% of render time and is trivially parallel (every pixel's elevation is
// independent of every other, given the current seeds/features state). stepEpoch
// stays here, sequential — it has real epoch-to-epoch dependencies (boundary
// detection depends on current seeds, deposits depend on boundary detection,
// rift/merge depend on deposits) that cannot be farmed out the same way.
//
// **This module does not know it is in a worker.** Results leave through an
// injected emitter rather than `self.postMessage`, and messages arrive through
// `dispatch` rather than `self.onmessage`; worldgenWorker.ts supplies both. That
// is what lets the whole pipeline be driven from Node in a test — the one part of
// the generator the golden harness cannot reach. See
// docs/design/generator-pipeline.md.
type Emit = (message: unknown, transfer?: Transferable[]) => void
let emit: Emit = () => {}

export function setEmitter(next: Emit): void {
  emit = next
}


let sim: PlateSimulation | null = null
// The Archean world, while that phase is the active one. Exactly one of `archean`
// and `sim` is meaningful at a time: finalizeArchean converts the first into the
// second, and archeanReset goes back the other way.
let archean: ArcheanSimulation | null = null
let archeanSeed = ''
// The Archean's tuning, held here because archeanStep needs it every tick and a
// reset has to rebuild the same world. Only `diffusion` is user-facing.
let archeanParams: ArcheanParams = DEFAULT_ARCHEAN_PARAMS
let archeanWater = 0
let archeanWidth = 0
let archeanHeight = 0
let renderOptions: RenderSimulationOptions = {}
let epochIntervalMs = 400
let intervalId: ReturnType<typeof setInterval> | undefined
let pendingEvents: SimEvent[] = []
// The last render's pre-redistribution elevation field — physical input
// an 'erosionStart' request needs (see WorkerErosionStartMessage). Kept up to date by
// every renderAndPost call, not just ones that happen while stopped, so
// erosion always has *something* to act on the first time it's used
// without needing a dedicated "prepare for erosion" render first.
// The hand-over state, kept so the tectonics panel can return to it. Snapshotted
// rather than re-derived: finalizeArchean consumes the Archean's RNG and names the
// continents as it goes, so calling it twice does not produce the same world.
let handoverSnapshot: PlateSimulationSnapshot | null = null
let handoverOceanAge: Float32Array | null = null
let handoverMantle: Float32Array | null = null
let lastRawElevations: Float32Array | null = null
// The DISPLAY-space elevations of the last render (redistributed values the
// map colors were computed from, with their grid size) — retained for the
// screen's 'requestElevationField' so its 3D relief displacement matches the
// 2D picture exactly: a snow-capped pixel is also the tallest point in 3D.
// The physical field (lastRawElevations) would disagree with the map wherever
// applyMountainRedistribution reshaped it. See SimulationRenderResult.
let lastDisplayElevations: { data: Float32Array; width: number; height: number } | null = null
// A second, deliberately less-eagerly-updated snapshot: the raw
// elevations from the last *non*-erosion render only (see renderAndPost
// — only updated when precomputedElevations wasn't supplied). Erosion
// overwrites lastRawElevations every time it runs, so without this
// there's no way back to "what tectonics actually produced" once you've
// clicked Erode even once — regenerating from scratch would mean
// re-running the whole live epoch-stepping loop again, not an instant
// revert. WorkerResetErosionMessage re-renders from this instead.
let preErosionElevations: Float32Array | null = null
// Set by a 'erosionStop' message; the in-flight runErosionPass polls it at each round
// boundary and returns its partial result (which then becomes lastRawElevations).
let erosionStopRequested = false

// A STAGE'S RESULT IS ONE OBJECT — it exists or it does not, never half of it.
//
// These were eighteen separate `let`s in three `last<Stage>*` families, which is
// a struct written as a naming convention. The cost was not the names: it was
// that "stale" had to be expressed by nulling the right subset, so every
// invalidation was a hand-written list of assignments to keep correct, and states
// like "dirty, but the arrays are still there" were representable and meaningless.
// One object per stage makes freshness structural — see
// docs/design/generator-pipeline.md and the declared chain in stages.ts.
//
// The terrain is deliberately NOT one of these yet: `lastRawElevations` is
// written by genesis, tectonics AND erosion, so it is the chain's shared
// substrate rather than one stage's result, and it converts with the runner.

interface ClimateResult {
  // The inputs that produced it. Kept WITH the result, so "is this stale" can
  // become a comparison instead of a flag — and so the hydrology's climate
  // refinement can re-run the chain with the same settings it was given.
  params: ClimateParams
  temperature: Float32Array
  precipitation: Float32Array
  seasonalAmplitude: Float32Array
  monsoonIndex: Float32Array
  // Water-free biomes for the ecology step (game/pasture read biome type).
  // Deliberately the COARSE classification, unlike the one displayed and saved:
  // every ecology field is a climate-grid field, and its own ecotone term reads
  // the 4-neighbourhood as regional adjacency. Handing it the fine array would
  // silently redefine "neighbouring biome" from 62 km to 8 km.
  biomes: Uint8Array
  // Ocean currents for the ecology step (fish upwelling reads them).
  currents: Float32Array
}
let climate: ClimateResult | null = null

// Rivers and lakes. Routing and discharge are the expensive parts, so a
// density-only re-request reuses this and just re-thresholds the channels; the
// object being absent IS "re-route needed", which is what `hydrologyDirty` used
// to say alongside two null checks that could disagree with it.
interface HydrologyResult {
  routing: FlowRouting
  discharge: Float32Array
  lakeDepth: Float32Array
  // Terminal basins' exposed floor (computeLakes' LakeFields.saltFlat) — the
  // SaltFlat biome override's source, carried with the lake depths it came with.
  saltFlat: Uint8Array | null
  dryBasin: Uint8Array | null
  maxDischarge: number
  meanRunoff: number
}
let hydrology: HydrologyResult | null = null

interface EcologyResult {
  // Cached from the last computeEcology — the initial-migration step reads it as
  // the population/density driver.
  carryingCapacity: Float32Array
}
let ecology: EcologyResult | null = null

// The last erosion's pre-fill elevations (basins still intact) — the terrain the
// hydrology runs on, so lakes have depressions to fill. null when the current
// terrain wasn't produced by erosion (fresh tectonics / restore), in which case
// hydrology falls back to the final elevations (few lakes — erosion drains them).
let lastLakeBasinElevations: Float32Array | null = null

// Where a stage's result is kept, and nowhere else. Exhaustive over StageId on
// purpose: adding a stage to the table makes this a compile error, which is the
// only reliable way to be told that a new result needs somewhere to be dropped.
function clearResult(id: StageId): void {
  switch (id) {
    case 'genesis':
    case 'tectonics':
      // Live simulations, not cached results — they are replaced, never dropped.
      return
    case 'erosion':
      lastLakeBasinElevations = null
      return
    case 'climate':
      climate = null
      return
    case 'hydrology':
      hydrology = null
      return
    case 'ecology':
      ecology = null
      return
    case 'migration':
      // Nothing retained: its four rasters go straight to the screen.
      return
  }
}

// INVALIDATION IS DERIVED, not written down. `id` produced something new, so
// every result that reads it — transitively — no longer describes this world.
//
// This used to be two hand-written helpers, and the same cascade was ALSO written
// out in WorldGenScreen. Two copies of one rule, and they had drifted: the screen
// dropped the climate and the ecology on every topography change while this side
// kept them, so the two disagreed about what a world currently was. Both now read
// downstreamOf() from stages.ts.
//
// Note what is NOT dropped: `id`'s own result. Whether the stage that just ran
// keeps its result is the caller's business — re-running replaces it, resetting
// drops it — and folding that in here would leave no way to say the other.
function invalidateAfter(id: StageId): void {
  for (const downstream of downstreamOf(id)) clearResult(downstream)
}

// Say no out loud. Returns true when the stage cannot run, having told the screen
// why — so a caller reads `if (decline(...)) return` and cannot forget the
// message. See WorkerStageDeclinedMessage for what silence used to cost.
function decline(stage: StageId, needs?: StageId): true {
  const message: WorkerStageDeclinedMessage = { type: 'stageDeclined', stage, needs }
  emit(message)
  return true
}

// Event markers no longer live here — they moved to the main thread as
// wall-clock-faded overlay markers driven by the forwarded sim events (see
// WorldGenScreen's event overlay). The worker just relays events; it does
// not track or bake any highlight state.



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

// Created on first use and reused for the lifetime of this pipeline — pool
// workers have their own startup cost, not worth paying every epoch.
//
// Lazy rather than eager: constructing it spawns eight nested workers and reads
// `self.navigator.hardwareConcurrency`, which was this module's last hard tie to
// a browser and made it unimportable anywhere else. Deferring it costs nothing —
// the first render pays a startup it used to pay at worker boot — and a run that
// never renders (a test) never pays it at all.
let renderer: ElevationRenderer | null = null
const renderPool = (): ElevationRenderer => (renderer ??= new ElevationRenderPool())

// The second half of the host seam, alongside setEmitter: supply an elevation
// renderer and nothing here touches a browser at all.
export function setElevationRenderer(next: ElevationRenderer): void {
  renderer = next
}
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
// the 'erosionStart' handler below) — always explicitly set (even to undefined)
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

// Terminal-basin masks for the terrain render (see RenderSimulationOptions.
// dryBasin) — set by the hydrology handler, cleared with the topography.
let renderDryBasin: Uint8Array | null = null
let renderSaltFlat: Uint8Array | null = null

async function renderAndPost(precomputedElevations?: Float32Array, intermediate = false, elevationScale = 1, skipInvalidation = false): Promise<void> {
  if (!sim) return
  const gen = worldGeneration
  renderOptions.precomputedElevations = precomputedElevations
  renderOptions.elevationScale = elevationScale
  renderOptions.dryBasin = renderDryBasin ?? undefined
  renderOptions.saltFlat = renderSaltFlat ?? undefined

  const result = await renderSimulationImage(sim, renderPool(), renderOptions)
  // A newer init/restore replaced the world while this render was in flight —
  // discard it before it clobbers lastRawElevations or posts a stale frame.
  if (gen !== worldGeneration) return
  lastRawElevations = result.rawElevations
  lastDisplayElevations = { data: result.elevations, width: sim.width, height: sim.height }
  if (!skipInvalidation) {
    invalidateAfter('tectonics')
    // New topography — whatever terminal basins the last hydrology found no
    // longer describe it.
    renderDryBasin = null
    renderSaltFlat = null
  }
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
    cratonAge: computeCratonOldnessField(sim.rafts, worldEpoch(sim.archeanEpochs, sim.epoch), MANTLE_RES_X, MANTLE_RES_Y, sim.width, sim.height).buffer as ArrayBuffer,
    elevation: coarseElevation(result.elevations, sim.width, sim.height).buffer as ArrayBuffer,
    elevationResX: CLIMATE_RES_X,
    elevationResY: CLIMATE_RES_Y,
    hotspots: sim.hotspots,
    volcanoes,
    width: sim.width,
    height: sim.height,
    landFraction: result.landFraction,
    epoch: sim.epoch,
    boundaryMask: result.boundaryMask.buffer as ArrayBuffer,
    raftLabels: result.raftLabels,
    plateCount: sim.seeds.length,
    events: eventsToSend,
    intermediate,
  }
  // Transfers the underlying ArrayBuffers instead of copying them — safe
  // because renderSimulationImage (buffer + boundaryMask) allocates fresh
  // arrays every call, so there's no reference to any now-neutered buffer
  // left to reuse.
  emit(message, [message.buffer, message.relief, message.mantle, message.elevation, message.boundaryMask])
}

// Renders the Archean world and posts its status. Reuses renderSimulationImage
// through RenderableWorld — the elevation raster, hillshade and colour ramp need no
// plates, and the plate-shaped overlays are skipped there.
async function renderArcheanAndPost(elevationScale = 1): Promise<void> {
  if (!archean) return
  const gen = worldGeneration
  renderOptions.precomputedElevations = undefined
  renderOptions.elevationScale = elevationScale
  const previewSeeds = intervalId === undefined ? convectionCellSeeds(archean.mantle, archean.width, archean.height) : []
  const result = await renderSimulationImage(
    // While PAUSED, show the plates this world would hand over — the same seeds
    // finalizeArchean would place, so the preview is the answer rather than a guess.
    // While running they are omitted: the convection reorganises every epoch, so a
    // live preview would be a flicker of boundaries that mean nothing yet.
    //
    // Seeds only drive the Voronoi mask; the elevation raster reads rafts, ocean age
    // and features, so previewing cannot disturb the terrain.
    { width: archean.width, height: archean.height, seeds: previewSeeds, rafts: archean.rafts, features: [], oceanAge: EMPTY_OCEAN_AGE, warpSeed: archean.warpSeed, seaLevelOffset: archean.seaLevelOffset },
    renderPool(),
    renderOptions,
  )
  if (gen !== worldGeneration || !archean) return
  lastRawElevations = result.rawElevations
  lastDisplayElevations = { data: result.elevations, width: archean.width, height: archean.height }
  invalidateAfter('tectonics')

  const message: WorkerRenderedMessage = {
    type: 'rendered',
    buffer: result.buffer.buffer as ArrayBuffer,
    relief: result.relief.buffer as ArrayBuffer,
    mantle: archean.mantle.slice().buffer as ArrayBuffer,
    mantleResX: MANTLE_RES_X,
    mantleResY: MANTLE_RES_Y,
    cratonAge: computeCratonOldnessField(archean.rafts, archean.epoch, MANTLE_RES_X, MANTLE_RES_Y, archean.width, archean.height).buffer as ArrayBuffer,
    elevation: coarseElevation(result.elevations, archean.width, archean.height).buffer as ArrayBuffer,
    elevationResX: CLIMATE_RES_X,
    elevationResY: CLIMATE_RES_Y,
    // The Archean has plumes too — the same persistent upwellings crustNucleation
    // reads to decide where crust appears. Showing them costs nothing new: the phase
    // already computes them, and seeing WHERE crust is about to form is the point.
    hotspots: findPlumeSites(archean.mantle, archean.width, archean.height),
    volcanoes: [],
    width: archean.width,
    height: archean.height,
    landFraction: result.landFraction,
    epoch: archean.epoch,
    boundaryMask: result.boundaryMask.buffer as ArrayBuffer,
    raftLabels: result.raftLabels,
    plateCount: 0,
    events: [],
  }
  emit(message, [message.buffer, message.relief, message.mantle, message.elevation, message.boundaryMask])

  const status: WorkerGenesisStatusMessage = {
    type: 'genesisStatus',
    epoch: archean.epoch,
    worldAgeMa: worldAgeMa(archean.epoch, 0),
    crustFraction: result.landFraction,
    stabilisedFraction: stabilisedFraction(archean.rafts, archean.epoch, DEFAULT_ARCHEAN_PARAMS.stabilisationEpochs),
    cratonCount: archean.rafts.length,
  }
  emit(status)
}

// The Archean has no ocean-age field (nothing creates or destroys seafloor yet), and
// computeRaftBaseline needs one to sample. A zero field reads as freshly-formed
// crust everywhere, which is the right answer for a world whose entire seafloor is
// being recycled continuously.
const EMPTY_OCEAN_AGE = new Float32Array(OCEAN_AGE_RES_X * OCEAN_AGE_RES_Y)

// Full-res elevation → the climate grid, for WorkerRenderedMessage.elevation.
// Center samples via the climate modules' own sampleElevationAtCell rather than
// an area mean or max, so the tooltip reports the same value the climate
// pipeline reads at that cell — not a differently-filtered one.
function coarseElevation(elevations: Float32Array, worldWidth: number, worldHeight: number): Float32Array {
  const out = new Float32Array(CLIMATE_RES_X * CLIMATE_RES_Y)
  for (let gy = 0; gy < CLIMATE_RES_Y; gy++) {
    for (let gx = 0; gx < CLIMATE_RES_X; gx++) {
      out[gy * CLIMATE_RES_X + gx] = sampleElevationAtCell(elevations, gx, gy, worldWidth, worldHeight)
    }
  }
  return out
}

// Runs one 'erosionStart' request end to end — extracted out of the onmessage
// dispatcher (which stays a plain sync function) since runErosionPass is
// itself async now (see erosion.ts's maybeYield: it periodically yields
// to a real macrotask boundary during its long loops, which is what lets
// its onProgress-driven postMessage calls below actually reach the main
// thread live instead of arriving in one burst after the whole ~10+
// second pass finishes).
async function runErodeRequest(rawElevations: Float32Array, width: number, height: number, opts: { age?: number; alluvium?: number; rockContrast?: number; weather?: WeatherParams } = {}): Promise<void> {
  if (!sim) return
  // The forcing and control mapping live in erosionForcing.ts, SHARED with
  // the golden harness — the harness must gate exactly the inputs the
  // player's erode runs on.
  const { forcing, params } = assembleErosionForcing(sim, rawElevations, width, height, opts, opts.weather ?? defaultWeatherParams())
  const age = Math.round(opts.age ?? 40)

  // Pooled + pipelined when cross-origin isolation grants SAB (the client
  // and dev server send COOP/COEP); single-threaded otherwise — same
  // physics either way, byte-identical per the engine-check's gates.
  let pool: ({ createWorker: () => WorkerLike } & { stencilWorkers: number; refreshWorkers: number; pipelineDepth: number }) | undefined
  if (typeof SharedArrayBuffer !== 'undefined' && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true) {
    const { default: EngineWorkerCtor } = await import('../surface/erosionEngineWorker?worker')
    const cores = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency ?? 8
    pool = {
      createWorker: () => new EngineWorkerCtor() as WorkerLike,
      ...(cores >= 8 ? { stencilWorkers: 4, refreshWorkers: 2 } : { stencilWorkers: 2, refreshWorkers: 1 }),
      pipelineDepth: 8,
    }
  }

  let lastReportedPercent = -1
  const erosionResult = await runErosionPassV2(rawElevations, width, height, forcing, {
    age,
    params,
    pool,
    onProgress: (fraction) => {
      const percent = Math.round(fraction * 100)
      if (percent === lastReportedPercent) return
      lastReportedPercent = percent
      const progressMessage: WorkerErosionProgressMessage = { type: 'erosionProgress', phase: 'streamPower', fraction }
      emit(progressMessage)
    },
    onChunkComplete: (chunkElevations) => renderAndPost(chunkElevations, true),
    shouldCancel: () => erosionStopRequested,
  })
  await renderAndPost(erosionResult.elevations)
  // Keep the basins-intact terrain for the hydrology's lakes — set after
  // renderAndPost, which clears it. Under v2 it equals the elevations
  // (nothing bakes the fill in any more); the hydrology contract is
  // unchanged. See lastLakeBasinElevations.
  lastLakeBasinElevations = erosionResult.preFillElevations
}

function stopTicking(): void {
  if (intervalId === undefined) return
  clearInterval(intervalId)
  intervalId = undefined
}

// One handler per inbound message type. The dispatcher below used to be a single
// ~250-line if/else chain, several of whose branches were 40-50 lines of pipeline
// wiring in their own right — the climate branch alone encodes the order
// temperature → wind → currents → precipitation → biomes, which is real domain
// knowledge that was invisible inside a chain of `else if`s.

function handleTectonicsStart(): void {
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
}

function handleTectonicsStop(): void {
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
}

function handleErosionStart(message: Extract<WorkerInboundMessage, { type: 'erosionStart' }>): void {
  if (!sim || !lastRawElevations) { decline('erosion', 'tectonics'); return }
  // Busy rather than unsatisfied — no upstream stage is missing, so `needs` stays
  // absent and the screen simply stops waiting.
  if (renderInFlight) { decline('erosion'); return }
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
    if (lastRawElevations) await runErodeRequest(lastRawElevations, currentSim.width, currentSim.height, { age: message.age, alluvium: message.alluvium, rockContrast: message.rockContrast, weather: message.weather })
  })().finally(() => {
    renderInFlight = false
  })
}

function handleErosionStop(): void {
  // The in-flight runErosionPass polls this and returns its partial result.
  erosionStopRequested = true
}

function resetErosion(): void {
  if (!sim || !preErosionElevations || renderInFlight) return
  renderInFlight = true
  renderAndPost(preErosionElevations).finally(() => {
    renderInFlight = false
  })
}

// The climate levers of the last computeClimate — kept so the hydrology
// handler's climate REFINEMENT pass (see handleHydrologyRun) can re-run
// the identical chain with the terminal-basin land override.
interface ClimateParams {
  temperatureOffset: number
  temperatureContrast: number
  humidity: number
  equatorOffset: number
}

// One climate pass, v1 or v2: the full chain in its load-bearing order — base
// temperature → wind → ocean currents (SST adjusts temperature) → seasonal
// amplitude → monsoon/precipitation → biomes. `dryLand` is the terminal-basin
// dry-floor override (LakeFields.dryBasin): those sub-sea cells count as land
// throughout, with an unclamped downward lapse (see computeTemperature).
function computeClimateChain(elevation: Float32Array, width: number, height: number, params: ClimateParams, dryLand?: Uint8Array) {
  // The meteorology is climate/weather.computeWeather — shared with the
  // erosion engine's water forcing (the stage-2 coupling), so the panel's
  // overlays and the carved valleys can never disagree about what the
  // climate IS.
  const { temperature, wind, currents, seasonalAmplitude, seasonal } = computeWeather(elevation, width, height, params, dryLand)
  // Classified twice, on purpose, from identical inputs: `biomes` on the climate
  // grid for the ecology step, `biomesFine` on the world raster for everything
  // the user sees or saves (see climate/biomes.computeBiomesFine, and
  // lastClimateBiomes for why ecology must not take the fine one). The second
  // pass is a pointwise loop over an existing field — measured well under the
  // precipitation advection it follows.
  const biomes = computeBiomes(temperature, seasonal.annual, seasonalAmplitude, seasonal.index, elevation, width, height, dryLand)
  const biomesFine = computeBiomesFine(temperature, seasonal.annual, seasonalAmplitude, seasonal.index, elevation, width, height, dryLand)
  return { temperature, wind, currents, seasonalAmplitude, seasonal, biomes, biomesFine }
}

// Cache copies for hydrology/ecology (the message buffers get transferred,
// which would neuter retained references), then hand the fields to the screen.
// Returns what it cached: the hydrology's climate refinement needs the new result
// immediately, and taking it from the return value rather than reading the module
// variable back is what removes the non-null assertions that used to follow.
function cacheAndPostClimate(chain: ReturnType<typeof computeClimateChain>, params: ClimateParams, refinement = false): ClimateResult {
  climate = {
    params,
    temperature: chain.temperature.slice(),
    precipitation: chain.seasonal.annual.slice(),
    seasonalAmplitude: chain.seasonalAmplitude.slice(),
    monsoonIndex: chain.seasonal.index.slice(),
    biomes: chain.biomes.slice(),
    currents: chain.currents.slice(),
  }
  const climateMessage: WorkerClimateDataMessage = {
    type: 'climateData',
    refinement,
    resX: CLIMATE_RES_X,
    resY: CLIMATE_RES_Y,
    temperature: chain.temperature.buffer as ArrayBuffer,
    wind: chain.wind.buffer as ArrayBuffer,
    currents: chain.currents.buffer as ArrayBuffer,
    precipitation: chain.seasonal.annual.buffer as ArrayBuffer,
    seasonalAmplitude: chain.seasonalAmplitude.buffer as ArrayBuffer,
    monsoonIndex: chain.seasonal.index.buffer as ArrayBuffer,
    biomes: chain.biomesFine.buffer as ArrayBuffer,
  }
  emit(climateMessage, [climateMessage.temperature, climateMessage.wind, climateMessage.currents, climateMessage.precipitation, climateMessage.seasonalAmplitude, climateMessage.monsoonIndex, climateMessage.biomes])
  return climate
}

function handleClimateRun(message: Extract<WorkerInboundMessage, { type: 'climateRun' }>): void {
  // Runs on the PRE-EROSION terrain (stage-2 coupling: climate sits before
  // erosion, so its result must not depend on whether erosion ran — this is
  // the same input the erosion forcing evaluates its weather chain on). This
  // is climate v1 — the optimistic mask where every sub-sea cell is water;
  // the hydrology handler refines it (v2) on the CURRENT terrain once the
  // terminal basins are known, which is where the post-erosion climate
  // truth comes from.
  const elevation = preErosionElevations ?? lastRawElevations
  if (!sim || !elevation) { decline('climate', 'tectonics'); return }
  const params: ClimateParams = {
    temperatureOffset: message.temperatureOffset,
    temperatureContrast: message.temperatureContrast,
    humidity: message.humidity,
    equatorOffset: message.equatorOffset,
  }
  cacheAndPostClimate(computeClimateChain(elevation, sim.width, sim.height, params), params)
  invalidateAfter('climate')
}

function handleHydrologyRun(message: Extract<WorkerInboundMessage, { type: 'hydrologyRun' }>): void {
  // Needs the current topography + a computed climate (rivers' water source).
  if (!sim || !lastRawElevations) { decline('hydrology', 'tectonics'); return }
  if (!climate) { decline('hydrology', 'climate'); return }
  const { riverDensity } = message
  const terrain = lastRawElevations
  const width = sim.width
  const height = sim.height
  // Run hydrology on the basins-intact (pre-fill) terrain when erosion produced
  // it, so lakes have depressions to fill and rivers flow into them; otherwise
  // the final drained terrain (few lakes). Same grid, so river/lake coords still
  // line up with the displayed map.
  const elevation = lastLakeBasinElevations ?? terrain
  // Bound now: the refinement below replaces the module's climate, and the rest
  // of this pass must keep reading the one it started from unless it rebinds.
  let weather = climate
  // Async (the priority-flood routing is a Promise); the onmessage handler is
  // sync, so run it in an IIFE like the erode branch does.
  ;(async () => {
    // Re-route only when topography/climate changed; a density-only tweak
    // reuses the cached routing + discharge + lakes (the expensive parts) and
    // just re-thresholds the rivers. An absent result IS "re-route needed".
    let rerouted = false
    let result = hydrology
    if (!result) {
      const routing = await fillDepressionsAndRouteFlow(elevation, width, height, 0)
      let discharge = accumulateDischarge(routing, elevation, weather.precipitation, CLIMATE_RES_X, CLIMATE_RES_Y)
      let maxDischarge = maxDischargeOverLand(discharge, elevation)
      let meanRunoff = meanLandRunoff(weather.precipitation, elevation, width, height, CLIMATE_RES_X, CLIMATE_RES_Y)
      {
        let lakes = computeLakes(routing, discharge, elevation, weather.temperature, weather.precipitation, CLIMATE_RES_X, CLIMATE_RES_Y)
        // CLIMATE REFINEMENT (v2, k=1): climate v1 was computed on the
        // PRE-EROSION terrain with the optimistic mask (every sub-sea cell =
        // water) — the stage sits before erosion since the stage-2 coupling.
        // This pass re-runs the chain on the CURRENT (eroded) terrain with
        // the terminal-basin dry floors counted as land, and is therefore
        // UNCONDITIONAL since 2026-08-16: it is where the post-erosion
        // climate and biome truth comes from at all — the first golden run
        // after the reorder caught v1 biomes calling erosion-grown coast
        // cells Ocean above sea level. (Before the reorder it ran only when
        // a dry basin existed; the dry-floor override is now simply one of
        // its inputs, possibly empty.) Then re-derive the
        // precipitation-dependent hydrology once: discharge and lakes — the
        // ROUTING is untouched (the terrain didn't move), so no re-flood.
        // Deliberately ONE refinement step, mirroring the riparian pattern:
        // iterate further and this becomes a fixed-point solver for a
        // second-decimal correction nobody can see.
        {
          const chain = computeClimateChain(terrain, width, height, weather.params, lakes.dryBasin)
          // Update the caches + screen WITHOUT invalidateAfter('climate'):
          // the very next lines recompute the dependent hydrology themselves,
          // and dropping the hydrology result here would force a needless full
          // re-route on the next call.
          weather = cacheAndPostClimate(chain, weather.params, true)
          discharge = accumulateDischarge(routing, elevation, weather.precipitation, CLIMATE_RES_X, CLIMATE_RES_Y)
          maxDischarge = maxDischargeOverLand(discharge, elevation)
          meanRunoff = meanLandRunoff(weather.precipitation, elevation, width, height, CLIMATE_RES_X, CLIMATE_RES_Y)
          lakes = computeLakes(routing, discharge, elevation, weather.temperature, weather.precipitation, CLIMATE_RES_X, CLIMATE_RES_Y)
        }
        // Terrain truth: repaint the map with the dry basin floors as land
        // (salt band + basin rock, real hillshade). skipInvalidation — this
        // render shows the hydrology we JUST computed; dropping the result here
        // would force a pointless full re-route on the next call.
        renderDryBasin = lakes.dryBasin
        renderSaltFlat = lakes.saltFlat
        await renderAndPost(terrain, false, 1, true)
        result = { routing, discharge, lakeDepth: lakes.depth, saltFlat: lakes.saltFlat, dryBasin: lakes.dryBasin, maxDischarge, meanRunoff }
      }
      hydrology = result
      rerouted = true
    }
    const threshold = channelThreshold(densityToCriticalArea(riverDensity), result.meanRunoff)
    const rivers = extractRiverPolylines(result.routing, result.discharge, elevation, threshold, result.maxDischarge)
    // Lakes only change on a re-route; a density-only call sends an empty buffer.
    const lakeOut = rerouted ? result.lakeDepth.slice() : new Float32Array(0)
    // Watersheds + the raw discharge field: re-route only, same contract.
    const watershedsOut = rerouted ? computeWatersheds(result.routing, elevation) : new Uint16Array(0)
    const dischargeOut = rerouted ? result.discharge.slice() : new Float32Array(0)
    // Riparian biome reclassification depends on the channel set (so it moves
    // with the density knob) — recompute every call when climate is available.
    // Uses the display terrain (lastRawElevations) so land/ocean matches the map.
    const riparian = computeRiparianBiomes(result.routing, terrain, result.discharge, threshold, result.maxDischarge, result.lakeDepth, weather.precipitation, weather.temperature, weather.seasonalAmplitude, weather.monsoonIndex, width, height, CLIMATE_RES_X, CLIMATE_RES_Y, result.saltFlat ?? undefined, result.dryBasin ?? undefined)
    // The riparian-effective precipitation rides along: it is what lets the
    // worldmap reclassify at bake resolution without re-running hydrology.
    const biomesOut = riparian.biomes
    const precipEffOut = riparian.precipEff
    const hydrologyMessage: WorkerHydrologyDataMessage = {
      type: 'hydrologyData',
      riverPoints: rivers.points.buffer as ArrayBuffer,
      riverLengths: rivers.lengths.buffer as ArrayBuffer,
      lakeDepth: lakeOut.buffer as ArrayBuffer,
      biomes: biomesOut.buffer as ArrayBuffer,
      precipitationEffective: precipEffOut.buffer as ArrayBuffer,
      watersheds: watershedsOut.buffer as ArrayBuffer,
      discharge: dischargeOut.buffer as ArrayBuffer,
      maxDischarge: result.maxDischarge,
    }
    emit(hydrologyMessage, [hydrologyMessage.riverPoints, hydrologyMessage.riverLengths, hydrologyMessage.lakeDepth, hydrologyMessage.biomes, hydrologyMessage.precipitationEffective, hydrologyMessage.watersheds, hydrologyMessage.discharge])
  })()
}

function handleEcologyRun(message: Extract<WorkerInboundMessage, { type: 'ecologyRun' }>): void {
  // Needs a computed climate (cached temperature/precipitation/biomes feed
  // productivity + pasture) plus the current elevation (arable slope) and the
  // sim's volcanoes (province layer). Noise seeded from warpSeed. Fresh arrays,
  // so every field buffer transfers.
  if (!sim || !lastRawElevations) { decline('ecology', 'tectonics'); return }
  if (!climate) { decline('ecology', 'climate'); return }
  // Hydrology (discharge/lakes) is optional here — if it hasn't been computed
  // yet, fish falls back to its marine component; the ecology panel re-triggers
  // this once hydrology lands (see WorldGenScreen's chaining).
  const cratonAge = computeCratonOldnessField(sim.rafts, worldEpoch(sim.archeanEpochs, sim.epoch), CLIMATE_RES_X, CLIMATE_RES_Y, sim.width, sim.height)
  const eco = computeEcology({
    temperature: climate.temperature,
    precipitation: climate.precipitation,
    biomes: climate.biomes,
    currents: climate.currents,
    elevation: lastRawElevations,
    discharge: hydrology?.discharge ?? null,
    maxDischarge: hydrology?.maxDischarge ?? 0,
    lakeDepth: hydrology?.lakeDepth ?? null,
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
  ecology = { carryingCapacity: eco.fields.carryingCapacity.slice() }
  const fields = Object.entries(eco.fields).map(([id, data]) => ({ id, data: data.buffer as ArrayBuffer }))
  const ecologyMessage: WorkerEcologyDataMessage = {
    type: 'ecologyData',
    resX: eco.resX,
    resY: eco.resY,
    fields,
  }
  emit(ecologyMessage, fields.map((f) => f.data))
}

function handleMigrationRun(message: Extract<WorkerInboundMessage, { type: 'migrationRun' }>): void {
  // Needs ecology's carrying capacity (density) + the current climate/hydrology
  // for the cost field. Discharge is downsampled to the coarse grid for river corridors.
  if (!sim || !lastRawElevations) { decline('migration', 'tectonics'); return }
  if (!climate) { decline('migration', 'climate'); return }
  if (!ecology) { decline('migration', 'ecology'); return }
  const coarseDischarge = hydrology ? downsampleMax(hydrology.discharge, sim.width, sim.height, CLIMATE_RES_X, CLIMATE_RES_Y) : null
  const mig = computeMigration(ecology.carryingCapacity, climate.precipitation, lastRawElevations, coarseDischarge, hydrology?.maxDischarge ?? 0, message.origins, sim.width, sim.height, {
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
  emit(migrationMessage, [migrationMessage.race, migrationMessage.density, migrationMessage.flow, migrationMessage.predecessor])
}

// Posts the retained display elevations of the last completed render (a
// copy — the retained array stays live for the next request). Silently a
// no-op before the first render; the screen only asks once terrain exists.
function handleRequestElevationField(): void {
  if (!lastDisplayElevations) return
  const elevation = lastDisplayElevations.data.slice()
  const message: WorkerElevationFieldMessage = {
    type: 'elevationField',
    elevation: elevation.buffer as ArrayBuffer,
    width: lastDisplayElevations.width,
    height: lastDisplayElevations.height,
  }
  emit(message, [message.elevation])
}

function handleSerializeWorld(): void {
  if (archean && !sim && lastRawElevations) {
    const snapshot = serializeArchean(archean)
    const mantle = archean.mantle.slice()
    const streak = archean.upwellingStreak.slice()
    const elevation = lastRawElevations.slice()
    const message: WorkerWorldDataMessage = {
      type: 'worldData',
      archean: { snapshot, mantle: mantle.buffer as ArrayBuffer, streak: streak.buffer as ArrayBuffer },
      // The tectonic fields still travel, empty: the screen writes one zip either way,
      // and a reader that only understands the tectonic form gets a coherent (if
      // pre-tectonic) world rather than a half-written file.
      snapshot: null as unknown as PlateSimulationSnapshot,
      // A copy: the same buffer cannot be transferred twice, and it also travels as
      // the Archean payload's own mantle above.
      mantle: archean.mantle.slice().buffer as ArrayBuffer,
      latticeAccumulated: new Float32Array(0).buffer as ArrayBuffer,
      latticeLockedEpochs: new Int16Array(0).buffer as ArrayBuffer,
      latticeLastClassCode: new Int8Array(0).buffer as ArrayBuffer,
      oceanAge: EMPTY_OCEAN_AGE.slice().buffer as ArrayBuffer,
      elevation: elevation.buffer as ArrayBuffer,
      uplift: new Float32Array(0).buffer as ArrayBuffer,
      erodibility: new Float32Array(0).buffer as ArrayBuffer,
      forcingResX: 0,
      forcingResY: 0,
    }
    emit(message, [message.archean!.mantle, message.archean!.streak, message.elevation])
    return
  }
  if (!sim || !lastRawElevations) return
  // .slice() so transferring these buffers doesn't neuter the live sim's
  // ocean-age / the worker's retained elevation.
  const oceanAge = sim.oceanAge.slice()
  const elevation = lastRawElevations.slice()
  const mantle = sim.mantle.slice()
  const accumulated = sim.latticeAccumulated.slice()
  const locked = sim.latticeLockedEpochs.slice()
  const lastClass = sim.latticeLastClassCode.slice()
  // The engine's coarse forcing, derived from the sim being serialized — the
  // same derivation the erode stage runs (pipeline/erosionForcing.ts), so the
  // bake erodes with the forcing this world was made with.
  const { uplift, hardness } = coarseForcingFields(sim, sim.width, sim.height)
  const worldMessage: WorkerWorldDataMessage = {
    type: 'worldData',
    snapshot: serializePlateSimulation(sim),
    mantle: mantle.buffer as ArrayBuffer,
    latticeAccumulated: accumulated.buffer as ArrayBuffer,
    latticeLockedEpochs: locked.buffer as ArrayBuffer,
    latticeLastClassCode: lastClass.buffer as ArrayBuffer,
    oceanAge: oceanAge.buffer as ArrayBuffer,
    elevation: elevation.buffer as ArrayBuffer,
    uplift: uplift.buffer as ArrayBuffer,
    erodibility: hardness.buffer as ArrayBuffer,
    forcingResX: CLIMATE_RES_X,
    forcingResY: CLIMATE_RES_Y,
  }
  emit(worldMessage, [worldMessage.mantle, worldMessage.latticeAccumulated, worldMessage.latticeLockedEpochs, worldMessage.latticeLastClassCode, worldMessage.oceanAge, worldMessage.elevation, worldMessage.uplift, worldMessage.erodibility])
}

function handleRestoreWorld(message: Extract<WorkerInboundMessage, { type: 'restoreWorld' }>): void {
  stopTicking()
  worldGeneration += 1
  if (message.archean) {
    sim = null
    archean = deserializeArchean(message.archean.snapshot, new Float32Array(message.archean.mantle), new Int16Array(message.archean.streak))
    archeanSeed = message.seed
    archeanWater = archean.seaLevelOffset
    archeanWidth = archean.width
    archeanHeight = archean.height
    lastRawElevations = new Float32Array(message.elevation)
    preErosionElevations = lastRawElevations
    void renderArcheanAndPost()
    return
  }
  // A restored TECTONIC world has no Archean any more — and leaving the previous
  // one standing was a real fault, not tidiness. The Archean branch above clears
  // `sim`; this branch did not clear `archean`, so a session that had run a
  // Genesis before loading kept it. Entering the Tectonics panel then sent
  // `archeanFinalize`, which found that leftover and replaced the world the user
  // had just opened with it. It only ever happened after a Genesis run in the
  // same session, which is why it looked intermittent.
  archean = null
  sim = deserializePlateSimulation(message.snapshot, new Float32Array(message.oceanAge), message.mantle ? new Float32Array(message.mantle) : undefined)
  // Restored after construction rather than through the constructor: the arrays are
  // sized from the lattice the deserializer just built, so a save from a different
  // lattice resolution is ignored instead of corrupting the grid.
  if (message.lattice) {
    const acc = new Float32Array(message.lattice.accumulated)
    const lock = new Int16Array(message.lattice.lockedEpochs)
    const cls = new Int8Array(message.lattice.lastClassCode)
    if (acc.length === sim.latticeAccumulated.length) {
      sim.latticeAccumulated.set(acc)
      sim.latticeLockedEpochs.set(lock)
      sim.latticeLastClassCode.set(cls)
    }
  }
  pendingEvents = []
  lastRawElevations = new Float32Array(message.elevation)
  // No stored pre-erosion field — a reset-erosion after a load just reverts
  // to the loaded state.
  preErosionElevations = lastRawElevations
  // Render the injected (stored, post-erosion) elevation directly — no pool
  // query, no re-erosion.
  renderAndPost(lastRawElevations, false, 1)
}


// --- Archean phase ---
// Mirrors the tectonic init/start/stop trio: same interval stepper, same
// renderInFlight guard, same coarse-while-running / full-res-when-paused split.
// What differs is only which state is being advanced.

function handleGenesisInit(message: Extract<WorkerInboundMessage, { type: 'genesisInit' }>): void {
  stopTicking()
  worldGeneration += 1
  sim = null
  archeanSeed = message.seed
  archeanParams = { ...DEFAULT_ARCHEAN_PARAMS, diffusion: message.mantleDiffusion ?? DEFAULT_ARCHEAN_PARAMS.diffusion }
  archeanWater = message.seaLevelOffset ?? 0
  archeanWidth = message.width
  archeanHeight = message.height
  archean = createArcheanSimulation(message.seed, message.width, message.height, archeanWater)
  lastRawElevations = null
  preErosionElevations = null
  renderOptions = message.renderOptions
  epochIntervalMs = message.epochIntervalMs
  void renderArcheanAndPost()
}

function handleGenesisStart(): void {
  if (intervalId !== undefined) return
  intervalId = setInterval(() => {
    if (!archean || renderInFlight) return
    archeanStep(archean, archeanParams)
    renderInFlight = true
    renderArcheanAndPost(PREVIEW_RENDER_SCALE).finally(() => { renderInFlight = false })
  }, epochIntervalMs)
}

// A pause, not an ending — the phase is resumable, and only becomes final when
// archeanFinalize starts the tectonic phase.
function handleGenesisStop(): void {
  stopTicking()
  if (archean && !renderInFlight) {
    renderInFlight = true
    renderArcheanAndPost(1).finally(() => { renderInFlight = false })
  }
}

// Plate tectonics begins. The Archean state is dropped: everything worth keeping
// (the rafts, their ages, the mantle field, the epoch count for the world clock)
// is carried into the PlateSimulation by finalizeArchean.
function handleGenesisFinalize(): void {
  if (!archean) return
  stopTicking()
  sim = finalizeArchean(archean)
  // Deep-copied, because serializePlateSimulation hands back the sim's OWN arrays
  // (rafts, features, seeds, motions) rather than copies — fine for its real job,
  // where the result is written to a file immediately, but useless as a stored state:
  // tectonics goes on mutating those same arrays, so an uncopied "snapshot" drifts
  // along with the world it was meant to preserve. Measured: after 60 epochs a reset
  // restored epoch 0 but 20 rafts and 386 features instead of the hand-over's 13 and 0.
  handoverSnapshot = structuredClone(serializePlateSimulation(sim))
  handoverOceanAge = sim.oceanAge.slice()
  handoverMantle = sim.mantle.slice()
  archean = null
  // No initial events under the raft model — a continent is a raft spanning
  // several plates, so there's no per-plate "continent created" moment to
  // announce at handover/reset; real continent events (collision/breakup/
  // supercontinent) only ever arrive from stepEpoch's own raft lifecycle.
  pendingEvents = []
  void renderAndPost()
}

function resetTectonics(): void {
  // Nothing to go back to on a world that was loaded from a file rather than grown
  // here — the save carries the world as it stood, not the hand-over behind it.
  if (!handoverSnapshot || !handoverOceanAge || !handoverMantle) return
  stopTicking()
  // Fresh copies each time, so a second reset restores the same state as the first
  // rather than whatever the last run left in the buffers.
  sim = deserializePlateSimulation(handoverSnapshot, handoverOceanAge.slice(), handoverMantle.slice())
  lastRawElevations = null
  preErosionElevations = null
  // Was these two rules written out by hand, which is what the named helper
  // exists to prevent. It still only reaches the hydrology: going back to the
  // hand-over leaves a computed climate and ecology standing, which the declared
  // chain says it should not. That is step 3c's to fix, not a move's.
  invalidateAfter('tectonics')
  // No initial events under the raft model — a continent is a raft spanning
  // several plates, so there's no per-plate "continent created" moment to
  // announce at handover/reset; real continent events (collision/breakup/
  // supercontinent) only ever arrive from stepEpoch's own raft lifecycle.
  pendingEvents = []
  void renderAndPost()
}

function resetGenesis(): void {
  stopTicking()
  worldGeneration += 1
  sim = null
  archean = createArcheanSimulation(archeanSeed, archeanWidth, archeanHeight, archeanWater)
  lastRawElevations = null
  preErosionElevations = null
  void renderArcheanAndPost()
}

// The dispatch table. A record rather than a chain so the set of messages this
// worker understands is a list you can read, and so a new one cannot silently
// land in the wrong branch.

// One gesture, seven stages. The stage-specific half is "what does this stage go
// back to"; the generic half — discard everything downstream — comes from the
// chain, so the four stages that never had a reset get one for free.
//
// Exhaustive over StageId: a new stage cannot be added without deciding what
// resetting it means.
function handleResetStage(message: Extract<WorkerInboundMessage, { type: 'resetStage' }>): void {
  switch (message.stage) {
    case 'genesis':
      resetGenesis()
      return
    case 'tectonics':
      resetTectonics()
      return
    case 'erosion':
      resetErosion()
      return
    case 'climate':
    case 'hydrology':
    case 'ecology':
    case 'migration':
      // Nothing to go back to: these stages have no state of their own beyond
      // their result, so dropping it IS the reset. Re-running them is the screen's
      // business — it holds the settings.
      clearResult(message.stage)
      invalidateAfter(message.stage)
      return
  }
}

const HANDLERS: { [K in WorkerInboundMessage['type']]: (message: WorkerInboundMessage) => void } = {
  tectonicsStart: () => handleTectonicsStart(),
  tectonicsStop: () => handleTectonicsStop(),
  erosionStart: (m) => handleErosionStart(m as Extract<WorkerInboundMessage, { type: 'erosionStart' }>),
  erosionStop: () => handleErosionStop(),
  resetStage: (m) => handleResetStage(m as Extract<WorkerInboundMessage, { type: 'resetStage' }>),
  requestElevationField: () => handleRequestElevationField(),
  climateRun: (m) => handleClimateRun(m as Extract<WorkerInboundMessage, { type: 'climateRun' }>),
  hydrologyRun: (m) => handleHydrologyRun(m as Extract<WorkerInboundMessage, { type: 'hydrologyRun' }>),
  ecologyRun: (m) => handleEcologyRun(m as Extract<WorkerInboundMessage, { type: 'ecologyRun' }>),
  migrationRun: (m) => handleMigrationRun(m as Extract<WorkerInboundMessage, { type: 'migrationRun' }>),
  serializeWorld: () => handleSerializeWorld(),
  restoreWorld: (m) => handleRestoreWorld(m as Extract<WorkerInboundMessage, { type: 'restoreWorld' }>),
  genesisInit: (m) => handleGenesisInit(m as Extract<WorkerInboundMessage, { type: 'genesisInit' }>),
  genesisStart: () => handleGenesisStart(),
  genesisStop: () => handleGenesisStop(),
  genesisFinalize: () => handleGenesisFinalize(),
}

// Every message type the pipeline answers to. Exported so a test can assert it
// covers all of them rather than listing them by hand and quietly falling behind.
export const HANDLED_MESSAGE_TYPES: readonly string[] = Object.keys(HANDLERS)

export function dispatch(message: WorkerInboundMessage): void {
  HANDLERS[message.type](message)
}
