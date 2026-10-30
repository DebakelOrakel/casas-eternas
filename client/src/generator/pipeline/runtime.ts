import { domainOfKind, type Domain } from '../core/domain'
import { sampleWorldElevation } from '../planet/sampleWorld'
import type { SimEvent, PlateSimulationSnapshot } from '../tectonics/plateSimulationTypes'
import { renderSimulationImage } from '../render/elevationMapImage'
import type { RenderableWorld, RenderSimulationOptions } from '../render/elevationMapImage'
import { downstreamOf } from './stages'
import type { StageId } from './stages'
import { releaseWorld, type ClimateBody, type ClimateParams, type Engine, type EnginePreview, type EngineWorld } from './engine'
import { ENGINE_CONSTANTS } from './engineConstants'
import { TECTONICS_INPUTS } from '../tectonics/tectonicsInputParams'

import type { ClimatePayload, FieldPayload, LandPayload, MeshPayload } from './messages'
import { findPlumeSites } from '../tectonics/plumes'
import { stabilisedFraction } from '../crust/raftField'
import { worldAgeMa, worldEpoch } from '../core/worldTime'
import { createOceanAgeField, savedOceanAge } from '../tectonics/oceanAge'
import type { SavedField } from '../fields/fieldMesh'
import { MANTLE_RES_X, MANTLE_RES_Y } from '../mantle/mantleField'
import { defaultWeatherParams, type WeatherParams } from '../climate/weather'
import { CLIMATE_RES_X, CLIMATE_RES_Y, sampleElevationAtCell } from '../climate/climateField'
import { collectVolcanoes } from '../tectonics/volcanoes'
import { computeCratonOldnessField } from '../crust/raftField'
import type { WorkerStageDeclinedMessage, WorkerStageFailedMessage, WorkerGenesisStatusMessage, WorkerClimateDataMessage, WorkerClimateRefinedMessage, WorkerEcologyDataMessage, WorkerEcologyMonthDataMessage, WorkerElevationFieldMessage, WorkerHydrologyDataMessage, WorkerInboundMessage, WorkerRenderedMessage, WorkerWorldDataMessage, WorkerPlanetPreviewDataMessage } from './messages'

// The generator pipeline: it holds the live state of every stage — archean,
// tectonics, erosion, climate, hydrology, ecology — and runs them on
// demand. Only the rendered RGBA buffer and the handful of numbers the UI
// displays ever leave.
//
// THE WORLD IS THE ENGINE'S (docs/decisions/rust-engine.md, fork 6a): the
// Rust engine's WASM build holds the simulation, the terrain, the field
// meshes with their walks and the stages' results, and this module holds a
// handle (`world`). A step, an epoch, a stage is one call; what comes back
// is the body of the message posted here. What stays here is what the
// screen sees and the engine does not compute: the picture's colours, its
// hillshade and its overlays (render/), from the engine's elevation and
// the world's snapshot.
//
// **This module does not know it is in a worker.** Results leave through an
// injected emitter rather than `self.postMessage`, messages arrive through
// `dispatch` rather than `self.onmessage`, and the engine is the host's
// (`setEngine`); generatorWorker.ts supplies all three. That is what lets
// the whole pipeline be driven from Node in a test — the one part of the
// generator the golden harness cannot reach. See
// docs/design/generator-pipeline.md.
type Emit = (message: unknown, transfer?: Transferable[]) => void
let emit: Emit = () => {}

export function setEmitter(next: Emit): void {
  emit = next
}

// The engine's settings this module reads (engineConstants.ts): how often
// the history draws, the Archean's controls' defaults and its stabilisation.
const HISTORY = ENGINE_CONSTANTS.tuning.history as { renderEvery: number }
const ARCHEAN = ENGINE_CONSTANTS.tuning.archean as { diffusion: number; landShare: number; stabilisationEpochs: number }

// The engine: its WASM build in the browser (generatorWorker.ts), the same
// build loaded from engine/dist in a test.
let engine: Engine | null = null
export function setEngine(next: Engine): void {
  engine = next
}
function theEngine(): Engine {
  if (!engine) throw new Error('the generator has no engine (setEngine)')
  return engine
}

// The world in the engine, and its era: the Archean, or the plates after
// the hand-over. Exactly one era at a time; the hand-over moves the world
// from the first to the second, and a genesis reset goes back.
let world: EngineWorld | null = null
let era: 'archean' | 'plates' | null = null
// The world's shape and size, and its Domain for the overlays.
let worldDomain: Domain | null = null

// Puts `next` in place of the world held, whose memory goes back now.
function replaceWorld(next: EngineWorld | null, nextEra: typeof era): void {
  if (world && world !== next) releaseWorld(world)
  world = next
  era = next ? nextEra : null
}
function domainFor(shape: Domain['kind'], width: number, height: number): Domain {
  if (!worldDomain || worldDomain.kind !== shape || worldDomain.width !== width || worldDomain.height !== height) worldDomain = domainOfKind(shape, width, height)
  return worldDomain
}

let archeanSeed = ''
// The Archean's controls, held here because a reset has to rebuild the same
// world. Both are user-facing.
let archeanControls = { diffusion: ARCHEAN.diffusion, landShare: ARCHEAN.landShare }
let archeanWidth = 0
let archeanHeight = 0
// The shape the Archean was made on (genesisInit), for a reset to make it
// on again.
let archeanShape: Domain['kind'] = 'torus'
let renderOptions: RenderSimulationOptions = {}
// The Archean's pace (genesisInit): the shortest time from one step's
// start to the next's, so its crust animates at a steady tempo.
let epochIntervalMs = 400
// Epochs run since the last intermediate picture (HISTORY.renderEvery);
// starts at the count so the first epoch of a run draws.
let epochsSinceRender: number = HISTORY.renderEvery
let pendingEvents: SimEvent[] = []
// The hand-over state, kept so the tectonics panel can return to it. Kept
// rather than re-derived: the hand-over consumes the Archean's RNG and
// names the continents as it goes, so making it twice does not produce the
// same world.
let handoverSnapshot: PlateSimulationSnapshot | null = null
let handoverOceanAge: SavedField | null = null
let handoverMantle: SavedField | null = null
// The hand-over belongs to the world that was grown here. Whatever REPLACES
// that world (a fresh Archean, a restored save) drops it, so a later reset
// cannot rewind a loaded world onto the previous session's continents. The
// screen refuses that reset on its own flag as well; this is the runtime's
// own guarantee, not a second copy of the screen's.
function dropHandover(): void {
  handoverSnapshot = null
  handoverOceanAge = null
  handoverMantle = null
}
// The last render's raw elevation on the world raster: what the stages
// need before they run, and what the screen's physical raster reads.
let lastRawElevations: Float32Array | null = null
// The DISPLAY-space elevations of the last render (the values the map
// colors were computed from, with their grid size) — retained for the
// screen's 'requestElevationField' so its 3D relief displacement matches the
// 2D picture exactly: a snow-capped pixel is also the tallest point in 3D.
// The physical field (lastRawElevations) lacks the display's fine detail
// texture. See SimulationRenderResult.
let lastDisplayElevations: { data: Float32Array; width: number; height: number } | null = null
// The terrain mesh has a routing: an epoch ran on it, it came from a save
// or a replay, or a stage routed it. Until then the screen gets no mesh with
// the elevation field (requestElevationField), as before the engine.
let routed = false

// WHAT THE STAGES HAVE COMPUTED, as far as this module needs to know: the
// results are the engine's; here, whether a climate stands (a stage that
// needs one declines without it) and the hydrology's generation.
//
// One flag per stage, cleared by one rule — "invalidation is derived"
// below — rather than by hand at every site, which is how the climate and
// the hydrology once disagreed about what a world currently was. See
// docs/design/generator-pipeline.md and the declared chain in stages.ts.
let climateDone = false
// Bumped whenever the hydrology result is dropped (an epoch, a reset, a
// climate change) and read by the hydrology pass across its awaits: the
// onmessage handler is sync, so nothing else stops a pass that started on a
// terrain the world has since moved off from publishing onto the new one.
let hydrologyGeneration = 0
let hydrologyInFlight = false

// The tectonics panel's controls for the history (tectonicsInputParams).
let historyControls: { alluvium: number; rockContrast: number; weather: WeatherParams } = { alluvium: TECTONICS_INPUTS.alluvium.default, rockContrast: TECTONICS_INPUTS.rockContrast.default, weather: defaultWeatherParams() }

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
      // Since phase 5.1 the terrain is the tectonics' (coupled); the
      // erosion stage owns no result of its own.
      return
    case 'climate':
      climateDone = false
      return
    case 'hydrology':
      hydrologyGeneration += 1
      return
    case 'ecology':
      // The fields go straight to the screen; nothing is kept here.
      return
  }
}

// INVALIDATION IS DERIVED, not written down. `id` produced something new, so
// every result that reads it — transitively — no longer describes this world.
// The engine drops its own results by the same chain where the same thing
// happens to it (a render, an epoch, a stage run); a reset says it
// (handleResetStage).
//
// This used to be two hand-written helpers, and the same cascade was ALSO written
// out in GeneratorScreen. Two copies of one rule, and they had drifted: the screen
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

// A stage's compute threw: said to the screen (WorkerStageFailedMessage),
// which releases what waits for it, and logged here with its stack.
// `restore`: it was a load's restore that failed (WorkerStageFailedMessage).
function fail(stage: StageId, error: unknown, restore = false): void {
  console.error(`[generator] the ${stage} stage ${restore ? 'could not be restored' : 'failed'}`, error)
  const message: WorkerStageFailedMessage = { type: 'stageFailed', stage, error: error instanceof Error ? error.message : String(error), ...(restore ? { restore: true as const } : {}) }
  emit(message)
}

// Event markers no longer live here — they moved to the main thread as
// wall-clock-faded overlay markers driven by the forwarded sim events (see
// GeneratorScreen's event overlay). The worker just relays events; it does
// not track or bake any highlight state.

// Renders are async (the image's render yields). A render in flight reads the
// world's snapshot across its awaits, and a step must not move the world
// under it: the step loop takes this flag for a step and its render, and a
// step that finds it taken waits (BUSY_RETRY_MS).
let renderInFlight = false

// Bumped whenever the world is REPLACED (a fresh init, or a restored save).
// A render captures it at the start; if a newer init/restore superseded the
// world while its (async) render was in flight, that stale render is discarded
// — otherwise a slow initial render can land AFTER a fast restore render and
// overwrite the just-loaded world (only visible when loading quickly, before
// the initial render finished).
let worldGeneration = 0

// Downscale factor for the live-preview elevation while the Archean is
// actively stepping — the engine's render evaluates the field on a 1024x512
// grid (a quarter of the pixels) and upscales it bilinearly, for a
// several-times-faster preview at a slightly softer elevation shading;
// plate outlines/overlays stay full-res. Any other render uses scale 1.
const PREVIEW_RENDER_SCALE = 2

// Terminal-basin masks for the terrain render (see RenderSimulationOptions.
// dryBasin) — set by the hydrology handler, cleared with the topography.
let renderDryBasin: Uint8Array | null = null
let renderSaltFlat: Uint8Array | null = null

// What the picture's overlays read of the plates (RenderableWorld) from the
// world's snapshot. The elevation is the engine's.
function renderableOf(snapshot: PlateSimulationSnapshot, domain: Domain): RenderableWorld {
  return { width: snapshot.width, height: snapshot.height, domain, seeds: snapshot.seeds, rafts: snapshot.rafts, warpSeed: snapshot.warpSeed }
}

// The terrain as the engine rasterises it, rendered and posted: what the
// stages and the screen read, and the map's texture.
async function renderTerrain(intermediate = false): Promise<void> {
  if (!world || era !== 'plates') return
  const { elevations, mantle } = world.render(1)
  await renderAndPost(elevations, mantle, world.snapshot(), intermediate, false)
}

// The plates' picture from a raster and the mantle's chart raster, posted.
// intermediate marks a redraw while the history runs — see
// WorkerRenderedMessage.intermediate for why the client needs to know.
// skipInvalidation: a render of the hydrology just computed (its dry
// floors), which must not drop it.
async function renderAndPost(elevations: Float32Array, mantle: Float32Array, snapshot: PlateSimulationSnapshot, intermediate: boolean, skipInvalidation: boolean): Promise<void> {
  const gen = worldGeneration
  const domain = domainFor(archeanShape, snapshot.width, snapshot.height)
  renderOptions.dryBasin = renderDryBasin ?? undefined
  renderOptions.saltFlat = renderSaltFlat ?? undefined

  const result = await renderSimulationImage(renderableOf(snapshot, domain), elevations, renderOptions)
  // A newer init/restore replaced the world while this render was in flight —
  // discard it before it clobbers lastRawElevations or posts a stale frame.
  if (gen !== worldGeneration) return
  lastRawElevations = result.rawElevations
  lastDisplayElevations = { data: result.elevations, width: snapshot.width, height: snapshot.height }
  if (!skipInvalidation) {
    invalidateAfter('tectonics')
    // New topography — whatever terminal basins the last hydrology found no
    // longer describe it.
    renderDryBasin = null
    renderSaltFlat = null
  }
  const eventsToSend = pendingEvents
  pendingEvents = []
  const archeanEpochs = snapshot.archeanEpochs ?? 0

  const message: WorkerRenderedMessage = {
    type: 'rendered',
    buffer: result.buffer.buffer as ArrayBuffer,
    relief: result.relief.buffer as ArrayBuffer,
    // The field on its chart raster (a fresh array, so transferable).
    mantle: mantle.buffer as ArrayBuffer,
    mantleResX: MANTLE_RES_X,
    mantleResY: MANTLE_RES_Y,
    cratonAge: computeCratonOldnessField(snapshot.rafts, worldEpoch(archeanEpochs, snapshot.epoch), archeanEpochs, MANTLE_RES_X, MANTLE_RES_Y, domain).buffer as ArrayBuffer,
    elevation: coarseElevation(result.elevations, snapshot.width, snapshot.height).buffer as ArrayBuffer,
    elevationResX: CLIMATE_RES_X,
    elevationResY: CLIMATE_RES_Y,
    hotspots: snapshot.hotspots,
    volcanoes: collectVolcanoes(snapshot.features),
    width: snapshot.width,
    height: snapshot.height,
    landFraction: result.landFraction,
    epoch: snapshot.epoch,
    boundaryMask: result.boundaryMask.buffer as ArrayBuffer,
    raftLabels: result.raftLabels,
    plateCount: snapshot.seeds.length,
    events: eventsToSend,
    intermediate,
  }
  // Transfers the underlying ArrayBuffers instead of copying them — safe
  // because the image render and the engine allocate fresh arrays every
  // call, so there's no reference to any now-neutered buffer left to reuse.
  emit(message, [message.buffer, message.relief, message.mantle, message.elevation, message.boundaryMask])
}

// Renders the Archean world and posts its status. The image render reads
// the rafts for its overlays (labels); the plate-shaped ones are skipped
// there, as the Archean has no plates.
// The last Archean status sent, for the hand-over's own (handleGenesisFinalize).
let lastGenesisStatus: WorkerGenesisStatusMessage | null = null

async function renderArcheanAndPost(elevationScale = 1): Promise<void> {
  if (!world || era !== 'archean') return
  const gen = worldGeneration
  const { snapshot, mantle: field } = world.archeanSave()
  const { elevations, mantle } = world.render(elevationScale)
  const domain = domainFor(archeanShape, snapshot.width, snapshot.height)
  const result = await renderSimulationImage(
    // No seeds, so no plate Voronoi: the Archean has no plates. The genesis
    // step offers no plate outlines (steps.ts).
    { width: snapshot.width, height: snapshot.height, domain, seeds: [], rafts: snapshot.rafts, warpSeed: snapshot.warpSeed },
    elevations,
    renderOptions,
  )
  if (gen !== worldGeneration || era !== 'archean') return
  lastRawElevations = result.rawElevations
  lastDisplayElevations = { data: result.elevations, width: snapshot.width, height: snapshot.height }
  invalidateAfter('tectonics')

  const message: WorkerRenderedMessage = {
    type: 'rendered',
    buffer: result.buffer.buffer as ArrayBuffer,
    relief: result.relief.buffer as ArrayBuffer,
    mantle: mantle.buffer as ArrayBuffer,
    mantleResX: MANTLE_RES_X,
    mantleResY: MANTLE_RES_Y,
    cratonAge: computeCratonOldnessField(snapshot.rafts, snapshot.epoch, snapshot.epoch, MANTLE_RES_X, MANTLE_RES_Y, domain).buffer as ArrayBuffer,
    elevation: coarseElevation(result.elevations, snapshot.width, snapshot.height).buffer as ArrayBuffer,
    elevationResX: CLIMATE_RES_X,
    elevationResY: CLIMATE_RES_Y,
    // The Archean has plumes too — the same persistent upwellings crustNucleation
    // reads to decide where crust appears. Showing them costs nothing new: the phase
    // already computes them, and seeing WHERE crust is about to form is the point.
    hotspots: findPlumeSites(field.values, domain),
    volcanoes: [],
    width: snapshot.width,
    height: snapshot.height,
    landFraction: result.landFraction,
    // No plate epoch has passed yet — see WorkerRenderedMessage.epoch. The
    // Archean's own count travels in the genesisStatus below.
    epoch: 0,
    boundaryMask: result.boundaryMask.buffer as ArrayBuffer,
    raftLabels: result.raftLabels,
    plateCount: 0,
    events: [],
  }
  emit(message, [message.buffer, message.relief, message.mantle, message.elevation, message.boundaryMask])

  const status: WorkerGenesisStatusMessage = lastGenesisStatus = {
    type: 'genesisStatus',
    epoch: snapshot.epoch,
    worldAgeMa: worldAgeMa(snapshot.epoch, 0),
    crustFraction: result.landFraction,
    stabilisedFraction: stabilisedFraction(snapshot.rafts, snapshot.epoch, ARCHEAN.stabilisationEpochs),
    cratonCount: snapshot.rafts.length,
  }
  emit(status)
}


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

// The terrain mesh as the save's bytes, from the engine (a fresh copy per
// call, so transferable).
function meshPayload(w: EngineWorld): MeshPayload {
  const m = w.meshPayload()
  return {
    count: m.count, nodes: m.nodes.buffer as ArrayBuffer, connectivity: m.connectivity.buffer as ArrayBuffer, z: m.z.buffer as ArrayBuffer,
    column: m.column?.buffer as ArrayBuffer | undefined, sedimentFlux: m.sedimentFlux?.buffer as ArrayBuffer | undefined,
    preErosionZ: m.preErosionZ?.buffer as ArrayBuffer | undefined, ice: m.ice?.buffer as ArrayBuffer | undefined,
  }
}

// THE STEP LOOP: one for both eras, the Archean's steps and the
// tectonics' epochs. A step runs; when it and its render are done, exactly
// one next step is scheduled, `minIntervalMs` after the last one STARTED
// (0: back to back). There is one pending timer at most, and a stop clears
// it: nothing starts after the stop is handled. A step in flight at the stop
// finishes and posts the SETTLED picture.
//
// It replaces a setInterval plus a zero-delay "seamless" tick per epoch
// that outlasted the interval (2026-09-26). An epoch does not yield, so
// every interval beat ran one, and each late epoch queued one more tick:
// the timer chains grew and never died (6 after 22 epochs), and a stop
// waited behind them (2026-10-11).
interface StepLoop {
  stage: 'genesis' | 'tectonics'
  minIntervalMs: number
  // One step. True when it posted the settled picture itself (it was
  // stopped before its render began).
  step: (loop: StepLoop) => Promise<boolean>
  // The settled picture of the world as it stands — after a stop that came
  // during a step's render, and after a step that threw.
  settle: () => Promise<void>
  timer: ReturnType<typeof setTimeout> | undefined
  inFlight: boolean
  // How the loop ended: 'stop' is the user's stop (a settled picture is
  // owed), 'drop' a handler that replaced the world (it draws its own).
  ended: 'stop' | 'drop' | undefined
}
let loop: StepLoop | null = null

// The wait before a step retries when another render (an init's, a stop's)
// is still in flight — a step must not move the world under it.
const BUSY_RETRY_MS = 16

function startLoop(stage: StepLoop['stage'], minIntervalMs: number, firstDelayMs: number, step: StepLoop['step'], settle: StepLoop['settle']): void {
  const next: StepLoop = { stage, minIntervalMs, step, settle, timer: undefined, inFlight: false, ended: undefined }
  loop = next
  // No delay: the first step runs inside the gesture's own handler, so a
  // stop queued right behind the start finds it in flight, not pending.
  if (firstDelayMs === 0) runStep(next)
  else scheduleStep(next, firstDelayMs)
}

function scheduleStep(l: StepLoop, delayMs: number): void {
  l.timer = setTimeout(() => {
    l.timer = undefined
    runStep(l)
  }, delayMs)
}

function runStep(l: StepLoop): void {
  if (loop !== l) return
  if (renderInFlight) {
    scheduleStep(l, BUSY_RETRY_MS)
    return
  }
  l.inFlight = true
  renderInFlight = true
  const startedAt = performance.now()
  void l.step(l)
    .then((posted) => ({ posted, threw: false, error: undefined as unknown }), (error: unknown) => ({ posted: false, threw: true, error }))
    .then(async ({ posted, threw, error }) => {
      l.inFlight = false
      if (threw) {
        // A step that threw ends its loop. The screen is told (it leaves its
        // running state on it) and gets the settled picture it waits for —
        // unless the world was replaced meanwhile, which is not its world.
        if (loop === l) loop = null
        if (l.ended === 'drop') console.error(`[generator] a ${l.stage} step of a replaced world failed`, error)
        else {
          l.ended = 'stop'
          fail(l.stage, error)
        }
      }
      if (loop === l) {
        renderInFlight = false
        scheduleStep(l, Math.max(0, l.minIntervalMs - (performance.now() - startedAt)))
        return
      }
      // Stopped while the step ran. The step drew the settled picture if the
      // stop came before its render; a stop during the render left an
      // intermediate one, and a failure none.
      if (l.ended === 'stop' && !posted) {
        try {
          await l.settle()
        } catch (error) {
          console.error(`[generator] the ${l.stage} stage's settled picture failed`, error)
        }
      }
      renderInFlight = false
    })
}

// Ends the running loop, if any; returns it. A step in flight finishes.
function stopLoop(ended: 'stop' | 'drop'): StepLoop | null {
  const l = loop
  if (!l) return null
  if (l.timer !== undefined) clearTimeout(l.timer)
  l.timer = undefined
  l.ended = ended
  loop = null
  return l
}

// What every handler that replaces the world calls: its own render follows.
function stopTicking(): void {
  stopLoop('drop')
}

// One handler per inbound message type. The dispatcher below used to be a single
// ~250-line if/else chain, several of whose branches were 40-50 lines of pipeline
// wiring in their own right.


function handleTectonicsStart(message: Extract<WorkerInboundMessage, { type: 'tectonicsStart' }>): void {
  if (loop) return
  // No plates yet: the Archean has not been handed over. Said out loud rather
  // than started anyway.
  if (!world || era !== 'plates') { decline('tectonics', 'genesis'); return }
  historyControls = {
    alluvium: message.alluvium ?? TECTONICS_INPUTS.alluvium.default,
    rockContrast: message.rockContrast ?? TECTONICS_INPUTS.rockContrast.default,
    weather: message.weather ?? defaultWeatherParams(),
  }
  // THE COUPLED EPOCH (phase 5.1): the plates move, the mesh follows,
  // erosion runs inside the epoch, the terrain is rasterised and drawn. An
  // epoch takes what it takes; the epochs run back to back (minimum 0). The
  // first epoch starts with the gesture: a start followed by a stop is then
  // exactly one epoch, which is what the pipeline harness's determinism
  // check builds its two worlds with.
  epochsSinceRender = HISTORY.renderEvery
  startLoop('tectonics', 0, 0, async (l) => {
    const current = world
    if (!current || era !== 'plates') return false
    const events = current.epoch(historyControls)
    // The world was replaced while the epoch ran: its result describes
    // nothing that is still here.
    if (l.ended === 'drop') return false
    // Events are forwarded to the main thread (batched with the next
    // render), which owns their notifications + faded map markers now.
    pendingEvents.push(...events)
    routed = true
    // Intermediate while the loop still runs, and only every
    // HISTORY.renderEvery-th epoch (the first always): the next
    // picture replaces this one. The epoch that finishes after the stop
    // is the settled one — drawn whatever the count, the screen then
    // pulls the elevation field and runs the chain.
    epochsSinceRender++
    const running = loop === l
    if (!running || epochsSinceRender >= HISTORY.renderEvery) {
      epochsSinceRender = 0
      await renderTerrain(running)
    }
    return !running
  }, () => renderTerrain(false))
}

function handleTectonicsStop(): void {
  // The settled render: the last epoch's, if one is still in flight (the
  // loop settles it), otherwise the terrain as it stands, once more.
  if (stopLoop('stop')?.inFlight) return
  if (world && era === 'plates' && !renderInFlight) {
    renderInFlight = true
    renderTerrain(false).finally(() => {
      renderInFlight = false
    })
  }
}



function resetErosion(): void {
  // Nothing to go back to: the terrain is the history's (phase 5.1).
}

// The screen's climate (WorkerClimateDataMessage) from the engine's body:
// the chart's fields, the marks' vectors on the mesh, and the biomes and
// the Köppen classes per pixel of the world raster. Fresh arrays,
// transferred.
function postClimate(body: ClimateBody, flags: { refinement?: boolean; refined?: boolean }): void {
  const message: WorkerClimateDataMessage = {
    type: 'climateData',
    ...flags,
    resX: CLIMATE_RES_X,
    resY: CLIMATE_RES_Y,
    temperature: body.temperature.buffer as ArrayBuffer,
    wind: body.wind.buffer as ArrayBuffer,
    windMesh: meshVectors(body.windMesh),
    currentsMesh: meshVectors(body.currentsMesh),
    currents: body.currents.buffer as ArrayBuffer,
    currentAnomaly: body.currentAnomaly.buffer as ArrayBuffer,
    precipitation: body.precipitation.buffer as ArrayBuffer,
    seasonalAmplitude: body.seasonalAmplitude.buffer as ArrayBuffer,
    monsoonIndex: body.monsoonIndex.buffer as ArrayBuffer,
    koppen: body.koppen.buffer as ArrayBuffer,
    biomes: body.biomes.buffer as ArrayBuffer,
  }
  const { windMesh, currentsMesh } = message
  emit(message, [message.temperature, message.wind, windMesh.e, windMesh.s, currentsMesh.e, currentsMesh.s, message.currents, message.currentAnomaly, message.precipitation, message.seasonalAmplitude, message.monsoonIndex, message.koppen, message.biomes])
}

// A vector field on the climate's field mesh for the screen's marks — the
// wind (DEC-0036 phase 3), the currents (phase 4), the refinement's
// (phase 5), WorkerClimateDataMessage.windMesh and .currentsMesh.
function meshVectors(v: ClimateBody['windMesh']): WorkerClimateDataMessage['windMesh'] {
  return { cells: v.cells, spacingM: v.spacingM, e: v.e.buffer as ArrayBuffer, s: v.s.buffer as ArrayBuffer }
}

function handleClimateRun(message: Extract<WorkerInboundMessage, { type: 'climateRun' }>): void {
  // On the last render's terrain. This is climate v1 — the optimistic mask
  // where every sub-sea cell is water; the hydrology handler refines it (v2)
  // once the terminal basins are known.
  if (!world || era !== 'plates' || !lastRawElevations) { decline('climate', 'tectonics'); return }
  const params: ClimateParams = {
    temperatureOffset: message.temperatureOffset,
    temperatureContrast: message.temperatureContrast,
    humidity: message.humidity,
    equatorOffset: message.equatorOffset,
    planet: message.planet,
  }
  const body = world.climate(params)
  routed = true
  climateDone = true
  postClimate(body, {})
  invalidateAfter('climate')
}

// The climate step's refinement (climate/refinement.ts), on the climate the
// step shows and the terrain it was computed on. It runs on the climate's
// field mesh (DEC-0036 phase 5); its values per cell go to the screen,
// which keeps them for the save, and its chart the screen's textures. A
// save's refinement is taken as it is — its values belong to this world's
// climate mesh, or the engine refuses it.
function handleClimateRefine(message: Extract<WorkerInboundMessage, { type: 'climateRefine' }>): void {
  if (!world || era !== 'plates' || !lastRawElevations) { decline('climate', 'tectonics'); return }
  if (!climateDone) { decline('climate', 'climate'); return }
  const { refined: r, annual } = world.refineClimate(message.restored ?? null)
  routed = true
  const values = r.refined
  const reply: WorkerClimateRefinedMessage = {
    type: 'climateRefined',
    resX: CLIMATE_RES_X,
    resY: CLIMATE_RES_Y,
    months: r.months,
    refined: values,
    temperature: r.temperature.buffer as ArrayBuffer,
    precipitation: r.precipitation.buffer as ArrayBuffer,
    koppen: r.koppen.buffer as ArrayBuffer,
    fog: r.fog.buffer as ArrayBuffer,
    foehn: r.foehn.buffer as ArrayBuffer,
    rainVariability: r.rainVariability.buffer as ArrayBuffer,
    ensoPattern: r.ensoPattern.buffer as ArrayBuffer,
    ensoPeriodYears: r.ensoPeriodYears,
    ensoStrength: r.ensoStrength,
    salinity: r.salinity.buffer as ArrayBuffer,
    deepWater: r.deepWater.buffer as ArrayBuffer,
    cyclone: r.cyclone.buffer as ArrayBuffer,
    tornado: r.tornado.buffer as ArrayBuffer,
    blizzard: r.blizzard.buffer as ArrayBuffer,
    dust: r.dust.buffer as ArrayBuffer,
    thunder: r.thunder.buffer as ArrayBuffer,
    pressure: r.pressure.buffer as ArrayBuffer,
    wind: r.wind.buffer as ArrayBuffer,
    currents: r.currents.buffer as ArrayBuffer,
    currentAnomaly: r.currentAnomaly.buffer as ArrayBuffer,
    upwelling: r.upwelling.buffer as ArrayBuffer,
  }
  emit(reply, [reply.temperature, reply.precipitation, reply.koppen, reply.fog, reply.foehn, reply.rainVariability, reply.ensoPattern, reply.salinity, reply.deepWater, reply.cyclone, reply.tornado, reply.blizzard, reply.dust, reply.thunder, reply.pressure, reply.wind, reply.currents, reply.currentAnomaly, reply.upwelling, ...refinedBuffers(values)])
  // The screen's annual fields follow, as a climate of its own kind; the
  // marks read the year's wind and the currents on the mesh.
  postClimate(annual, { refined: true })
  invalidateAfter('climate')
}

function refinedBuffers(r: WorkerClimateRefinedMessage['refined']): ArrayBuffer[] {
  return [
    r.temperature, r.precipitation, r.pressure, r.windE, r.windS, r.currentE, r.currentS, r.currentAnomaly, r.upwelling, r.salinity, r.deepWater, r.fog, r.foehn,
    r.reliability.rainVariability, r.reliability.ensoPattern, r.storms.cyclone, r.storms.tornado, r.storms.blizzard, r.storms.dust, r.storms.thunder,
  ].map((f) => f.buffer as ArrayBuffer)
}

function handleHydrologyRun(): void {
  // Needs the current topography + a computed climate (rivers' water source).
  if (!world || era !== 'plates' || !lastRawElevations) { decline('hydrology', 'tectonics'); return }
  if (!climateDone) { decline('hydrology', 'climate'); return }
  // One pass at a time: a second call while one runs would publish twice.
  // The running pass answers for both.
  if (hydrologyInFlight) return
  const current = world
  // What this pass answers for. After the await below the pass asks whether
  // that is still the world's question — a world replaced under it, or a
  // result dropped by an epoch or a reset, and it stops without publishing.
  const generationOfWorld = worldGeneration
  const generation = hydrologyGeneration
  const stale = (): boolean => generationOfWorld !== worldGeneration || generation !== hydrologyGeneration
  hydrologyInFlight = true
  // Async (the render awaits); the onmessage handler is sync, so run it in
  // an IIFE.
  ;(async () => {
    // A repeat call reuses the route (the expensive part) and sends the
    // re-routed fields empty; the engine keeps the route.
    const body = current.hydrology(historyControls.weather.planet ?? null)
    routed = true
    // The climate v2 on the current terrain: the caches + screen updated
    // WITHOUT invalidateAfter('climate') — the hydrology is recomputed under
    // it right there.
    if (body.climate) postClimate(body.climate, { refinement: true })
    if (body.render) {
      // Terrain truth: repaint the map with the dry basin floors as land
      // (salt band + basin rock, real hillshade). skipInvalidation — this
      // render shows the hydrology we JUST computed.
      renderDryBasin = body.render.dryBasin
      renderSaltFlat = body.render.saltFlat
      await renderAndPost(lastRawElevations!, body.render.mantle, current.snapshot(), false, true)
      if (stale()) return
    }
    // The save's form of the graph is the engine's (DEC-0044, fork 7b).
    const graphOut = body.riverGraph ? engine!.riverGraphParts(body.riverGraph) : null
    const hydrologyMessage: WorkerHydrologyDataMessage = {
      type: 'hydrologyData',
      riverPoints: body.riverPoints.buffer as ArrayBuffer,
      riverLengths: body.riverLengths.buffer as ArrayBuffer,
      riverRegimes: body.riverRegimes.buffer as ArrayBuffer,
      lakeDepth: body.lakeDepth.buffer as ArrayBuffer,
      biomes: body.biomes.buffer as ArrayBuffer,
      precipitationEffective: body.precipitationEffective.buffer as ArrayBuffer,
      watersheds: body.watersheds.buffer as ArrayBuffer,
      discharge: body.discharge.buffer as ArrayBuffer,
      maxDischarge: body.maxDischarge,
      waterBodies: body.waterBodies,
      waterLevel: body.waterLevel.buffer as ArrayBuffer,
      waterSurface: body.waterSurface.buffer as ArrayBuffer,
      riverGraph: graphOut ? { json: graphOut.json, cells: graphOut.cells.slice().buffer as ArrayBuffer, coursePoints: graphOut.coursePoints.buffer as ArrayBuffer } : null,
      coastType: body.coastType.buffer as ArrayBuffer,
      coast: body.coast ? { reaches: body.coast.reaches, nodes: body.coast.nodes.buffer as ArrayBuffer } : null,
      sedimentBasins: body.sedimentBasins,
      iceThickness: body.iceThickness.buffer as ArrayBuffer,
    }
    const transfer = [hydrologyMessage.riverPoints, hydrologyMessage.riverLengths, hydrologyMessage.riverRegimes, hydrologyMessage.lakeDepth, hydrologyMessage.biomes, hydrologyMessage.precipitationEffective, hydrologyMessage.watersheds, hydrologyMessage.discharge, hydrologyMessage.waterLevel, hydrologyMessage.waterSurface]
    if (hydrologyMessage.riverGraph) transfer.push(hydrologyMessage.riverGraph.cells, hydrologyMessage.riverGraph.coursePoints)
    transfer.push(hydrologyMessage.coastType, hydrologyMessage.iceThickness)
    if (hydrologyMessage.coast) transfer.push(hydrologyMessage.coast.nodes)
    emit(hydrologyMessage, transfer)
  })().catch((error: unknown) => fail('hydrology', error)).finally(() => { hydrologyInFlight = false })
}

function handleEcologyRun(message: Extract<WorkerInboundMessage, { type: 'ecologyRun' }>): void {
  // Needs a computed climate (its cells feed productivity + pasture) plus
  // the current terrain mesh (the nodes the fields sit on, their slope)
  // and the sim's volcanoes (province layer). Noise seeded from warpSeed.
  // Hydrology (discharge/lakes) is optional here — if it hasn't been
  // computed yet, fish falls back to its marine component; the ecology
  // panel re-triggers this once hydrology lands (see GeneratorScreen's
  // chaining). The engine keeps the physics while only the sliders move.
  if (!world || era !== 'plates' || !lastRawElevations) { decline('ecology', 'tectonics'); return }
  if (!climateDone) { decline('ecology', 'climate'); return }
  const body = world.ecology({
    carryingCapacity: message.carryingCapacity,
    concentration: message.concentration,
    provinceStrength: message.provinceStrength,
    tinRarity: message.tinRarity,
    weights: message.weights,
  })
  routed = true
  const fields = body.fields.map((f) => ({ id: f.id, data: f.data.buffer as ArrayBuffer }))
  const fine = body.fine.fields.map((f) => ({ id: f.id, data: f.data.buffer as ArrayBuffer }))
  const ecologyMessage: WorkerEcologyDataMessage = {
    type: 'ecologyData',
    resX: body.resX,
    resY: body.resY,
    fields,
    fine: { resX: body.fine.resX, resY: body.fine.resY, fields: fine },
  }
  emit(ecologyMessage, [...fields.map((f) => f.data), ...fine.map((f) => f.data)])
}

function handleEcologyMonth(message: Extract<WorkerInboundMessage, { type: 'ecologyMonth' }>): void {
  // Answered on the physics and sliders of the last run; without them (or
  // for a yearly field, or a climate without months) there is nothing to
  // send, and the screen keeps showing the year.
  // Always answered, with no data then, so the screen is not left waiting.
  const body = world && era === 'plates'
    ? world.ecologyMonth(message.field, message.month)
    : { field: message.field, month: message.month, resX: 0, resY: 0, data: new Uint8Array(0) }
  const reply: WorkerEcologyMonthDataMessage = {
    type: 'ecologyMonthData', field: body.field, month: body.month,
    resX: body.resX, resY: body.resY,
    data: body.data.buffer as ArrayBuffer,
  }
  emit(reply, [reply.data])
}

// Posts the retained display elevations of the last completed render (a
// copy — the retained array stays live for the next request). Silently a
// no-op before the first render; the screen only asks once terrain exists.
function handleRequestElevationField(): void {
  if (!lastDisplayElevations) return
  const elevation = lastDisplayElevations.data.slice()
  // The physical raster beside the display one: the hydrology's levels are
  // set against it, so the shores must be found on it too — the display
  // copy carries the erosion detail texture, which is presentation.
  const raw = lastRawElevations && lastRawElevations.length === elevation.length ? lastRawElevations.slice() : elevation.slice()
  const message: WorkerElevationFieldMessage = {
    type: 'elevationField',
    mesh: world && era === 'plates' && routed ? meshPayload(world) : undefined,
    elevation: elevation.buffer as ArrayBuffer,
    raw: raw.buffer as ArrayBuffer,
    width: lastDisplayElevations.width,
    height: lastDisplayElevations.height,
  }
  const transfers = [message.elevation, message.raw]
  if (message.mesh) transfers.push(message.mesh.nodes, message.mesh.connectivity, message.mesh.z)
  emit(message, transfers)
}

function handleSerializeWorld(): void {
  if (world && era === 'archean' && lastRawElevations) {
    const save = world.archeanSave()
    const mantle = fieldPayload(save.mantle)
    const domain = domainFor(archeanShape, save.snapshot.width, save.snapshot.height)
    const message: WorkerWorldDataMessage = {
      type: 'worldData',
      archean: { snapshot: save.snapshot, mantle, streak: save.streak.buffer as ArrayBuffer },
      // The tectonic fields still travel, empty: the screen writes one zip either way,
      // and a reader that only understands the tectonic form gets a coherent (if
      // pre-tectonic) world rather than a half-written file.
      snapshot: null as unknown as PlateSimulationSnapshot,
      // A copy: the same buffer cannot be transferred twice, and it also travels as
      // the Archean payload's own mantle above.
      mantle: { ...mantle, values: mantle.values.slice(0) },
      latticeAccumulated: new Float32Array(0).buffer as ArrayBuffer,
      latticeLockedEpochs: new Int16Array(0).buffer as ArrayBuffer,
      latticeLastClassCode: new Int8Array(0).buffer as ArrayBuffer,
      oceanAge: fieldPayload(savedOceanAge(createOceanAgeField(0, domain), domain)),
    }
    emit(message, [message.archean!.mantle.values, message.archean!.streak])
    return
  }
  if (!world || era !== 'plates' || !lastRawElevations) return
  // The meshes' own values (the bit-identical continuation; DEC-0036
  // phases 1 and 2). No raster (DEC-0036, the save step): the elevation is
  // the mesh's rasterisation and the erosion's coarse forcing a function
  // of the snapshot (the engine's forcingOfSnapshot), both made again
  // by whoever reads the save.
  const [mantle, oceanAge] = world.savedFields()
  const lattice = world.lattice()
  const climate = world.climatePayload()
  const land = world.landPayload()
  const worldMessage: WorkerWorldDataMessage = {
    type: 'worldData',
    snapshot: world.snapshot(),
    mantle: fieldPayload(mantle),
    latticeAccumulated: lattice.accumulated.buffer as ArrayBuffer,
    latticeLockedEpochs: lattice.lockedEpochs.buffer as ArrayBuffer,
    latticeLastClassCode: lattice.lastClassCode.buffer as ArrayBuffer,
    oceanAge: fieldPayload(oceanAge),
    mesh: meshPayload(world),
    climate: climate ? climatePayload(climate) : undefined,
    land: land ? landPayload(land) : undefined,
  }
  const transfers = [worldMessage.mantle.values, worldMessage.latticeAccumulated, worldMessage.latticeLockedEpochs, worldMessage.latticeLastClassCode, worldMessage.oceanAge.values]
  if (worldMessage.mesh) transfers.push(worldMessage.mesh.nodes, worldMessage.mesh.connectivity, worldMessage.mesh.z)
  if (worldMessage.climate) transfers.push(worldMessage.climate.seaLevelTemperature, worldMessage.climate.precipitation, worldMessage.climate.seasonalAmplitude, worldMessage.climate.monsoonIndex)
  if (worldMessage.land) transfers.push(worldMessage.land.biome, worldMessage.land.koppen, ...(worldMessage.land.waterTable ? [worldMessage.land.waterTable] : []), ...(worldMessage.land.lakeBody ? [worldMessage.land.lakeBody] : []))
  emit(worldMessage, transfers)
}

// The climate's cells as the save holds them (world/save/climateFields.ts).
function climatePayload(v: NonNullable<ReturnType<EngineWorld['climatePayload']>>): ClimatePayload {
  return {
    cells: v.cells, spacingM: v.spacingM,
    seaLevelTemperature: v.seaLevelTemperature.buffer as ArrayBuffer, precipitation: v.precipitation.buffer as ArrayBuffer,
    seasonalAmplitude: v.seasonalAmplitude.buffer as ArrayBuffer, monsoonIndex: v.monsoonIndex.buffer as ArrayBuffer,
  }
}

// The land fields per node of the mesh the save carries, in its numbering:
// the map's biome (the hydrology's when it ran, else the climate's), the
// Köppen class, the water table, the discharge in m³/s and the lakes per
// node (the hydrology's, null before it ran).
function landPayload(l: NonNullable<ReturnType<EngineWorld['landPayload']>>): LandPayload {
  return {
    count: l.count,
    biome: l.biome.buffer as ArrayBuffer,
    koppen: l.koppen.buffer as ArrayBuffer,
    waterTable: l.waterTable ? l.waterTable.buffer as ArrayBuffer : null,
    discharge: l.discharge ? l.discharge.buffer as ArrayBuffer : null,
    lakeBody: l.lakeBody ? l.lakeBody.buffer as ArrayBuffer : null,
  }
}

// A world made again from its runs (WorkerReplayRunsMessage), in place of
// the one held: the same reset of what the previous world left as a
// restore, then the replay, then the world as after a run — rendered, the
// derived stages stale. A message that replaces the world while the replay
// runs (a load, another replay) stops it between two epochs.
async function handleReplayRuns(message: Extract<WorkerInboundMessage, { type: 'replayRuns' }>): Promise<void> {
  stopTicking()
  worldGeneration += 1
  const generation = worldGeneration
  dropHandover()
  renderDryBasin = null
  renderSaltFlat = null
  replaceWorld(null, null)
  routed = false
  lastRawElevations = null
  invalidateAfter('tectonics')
  const { plan } = message
  archeanShape = plan.shape ?? 'torus'
  const replay = theEngine().Replay.start(plan, 0)
  try {
    for (;;) {
      if (generation !== worldGeneration) return
      if (!replay.step()) break
      const { done, total } = replay.progress()
      emit({ type: 'replayProgress', done, total })
      // Between two epochs the worker takes its messages: a load or
      // another replay stops this one.
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    if (generation !== worldGeneration) return
    replaceWorld(replay.world(), 'plates')
  } finally {
    ;(replay as { free?: () => void }).free?.()
  }
  routed = true
  // A run that follows goes on with the last run's controls until the
  // screen's next start sends its own.
  const last = plan.tectonics[plan.tectonics.length - 1]
  if (last) {
    historyControls = {
      alluvium: last.controls.alluvium ?? TECTONICS_INPUTS.alluvium.default,
      rockContrast: last.controls.rockContrast ?? TECTONICS_INPUTS.rockContrast.default,
      weather: last.weather,
    }
  }
  const snapshot = world!.snapshot()
  emit({ type: 'replayDone', archeanEpochs: snapshot.archeanEpochs ?? 0, epoch: snapshot.epoch })
  await renderTerrain()
}

// A field-mesh field between its form and the message's (FieldPayload):
// the mantle's and the ocean age's.
function fieldPayload(saved: SavedField): FieldPayload {
  return { values: saved.values.buffer as ArrayBuffer, cells: saved.cells, spacingM: saved.spacingM }
}
function requireOceanAge(payload: FieldPayload | undefined): FieldPayload {
  if (!payload) throw new Error('a tectonic world restored without its ocean age')
  return payload
}
function savedOf(payload: FieldPayload): SavedField
function savedOf(payload: FieldPayload | undefined): SavedField | undefined
function savedOf(payload: FieldPayload | undefined): SavedField | undefined {
  return payload ? { values: new Float64Array(payload.values), cells: payload.cells, spacingM: payload.spacingM } : undefined
}

// A load's restore, and its first render: the screen's load waits for that
// render. Whatever throws on the way — the engine refusing the save, the
// render after it — is said (fail, `restore`), or the load waits forever
// (TEG-89).
function handleRestoreWorld(message: Extract<WorkerInboundMessage, { type: 'restoreWorld' }>): void {
  const stage = restoreStage(message)
  let rendered: Promise<void>
  try {
    rendered = restoreWorld(message)
  } catch (error) {
    fail(stage, error, true)
    return
  }
  rendered.catch((error: unknown) => fail(stage, error, true))
}
// The era a save is restored in, which names its failure.
const restoreStage = (message: Extract<WorkerInboundMessage, { type: 'restoreWorld' }>): StageId => message.archean ? 'genesis' : 'tectonics'

// The world from the save, and its first render (the promise).
function restoreWorld(message: Extract<WorkerInboundMessage, { type: 'restoreWorld' }>): Promise<void> {
  stopTicking()
  worldGeneration += 1
  dropHandover()
  // What the previous world's hydrology left: its terminal basins (painted
  // on the new world's first render). They do not describe the world being
  // restored (2026-10-01).
  renderDryBasin = null
  renderSaltFlat = null
  const shape = message.shape ?? 'torus'
  // The hand-over's shape too: a genesis reset after a load starts the
  // world's own shape again.
  archeanShape = shape
  pendingEvents = []
  lastRawElevations = null
  if (message.archean) {
    archeanSeed = message.seed
    archeanControls = {
      diffusion: message.mantleDiffusion ?? ARCHEAN.diffusion,
      landShare: message.landShare ?? ARCHEAN.landShare,
    }
    const a = message.archean
    replaceWorld(theEngine().World.restoreArchean(shape, a.snapshot, savedOf(a.mantle), new Int16Array(a.streak), archeanControls.diffusion, archeanControls.landShare), 'archean')
    archeanWidth = a.snapshot.width
    archeanHeight = a.snapshot.height
    routed = false
    // The raster is the Archean's render of its state, as in the session
    // (the save carries none since DEC-0036's save step).
    return renderArcheanAndPost()
  }
  // A restored TECTONIC world replaces whatever world was held, an Archean
  // too: a session that had run a Genesis before loading once kept it, and
  // entering the Tectonics panel then sent `archeanFinalize`, which found
  // that leftover and replaced the world the user had just opened with it.
  //
  // The history's terrain from the save (phase 5.1): the mesh with its
  // heights, the routing derived; the raster is its rasterisation, as
  // after every epoch — the save carries none (DEC-0036, the save step).
  // Without a mesh (the screen refuses such a save): the mesh the
  // hand-over builds, a function of the plates, unrouted as the session's
  // is. The lattice is taken where it is the restored world's size.
  const f32 = (buffer: ArrayBuffer | undefined): Float32Array | undefined => buffer ? new Float32Array(buffer) : undefined
  const m = message.mesh
  const mesh = m
    ? {
      count: m.count, nodes: new Float32Array(m.nodes), connectivity: new Uint8Array(m.connectivity), z: new Float32Array(m.z),
      column: m.column ? new Uint8Array(m.column) : undefined, ice: f32(m.ice), sedimentFlux: f32(m.sedimentFlux), preErosionZ: f32(m.preErosionZ),
    }
    : null
  const lattice = message.lattice
    ? { accumulated: new Float32Array(message.lattice.accumulated), lockedEpochs: new Int16Array(message.lattice.lockedEpochs), lastClassCode: new Int8Array(message.lattice.lastClassCode) }
    : null
  replaceWorld(theEngine().World.restorePlates(shape, message.snapshot, savedOf(requireOceanAge(message.oceanAge)), savedOf(message.mantle) ?? null, lattice, mesh), 'plates')
  routed = mesh !== null
  // The terrain's rasterisation, rendered — no re-erosion.
  return renderTerrain()
}


// --- Archean phase ---
// Mirrors the tectonic init/start/stop trio: the same step loop, same
// renderInFlight guard, same coarse-while-running / full-res-when-paused split.
// What differs is only which era is being advanced.

function handleGenesisInit(message: Extract<WorkerInboundMessage, { type: 'genesisInit' }>): void {
  stopTicking()
  worldGeneration += 1
  dropHandover()
  archeanSeed = message.seed
  archeanControls = {
    diffusion: message.mantleDiffusion ?? ARCHEAN.diffusion,
    landShare: message.landShare ?? ARCHEAN.landShare,
  }
  archeanWidth = message.width
  archeanHeight = message.height
  archeanShape = message.shape ?? 'torus'
  replaceWorld(theEngine().World.genesis(message.seed, message.width, message.height, archeanShape, archeanControls.diffusion, archeanControls.landShare), 'archean')
  lastRawElevations = null
  routed = false
  renderOptions = message.renderOptions
  epochIntervalMs = message.epochIntervalMs
  void renderArcheanAndPost()
}

function handleGenesisStart(message: Extract<WorkerInboundMessage, { type: 'genesisStart' }>): void {
  if (loop) return
  if (message.mantleDiffusion !== undefined) archeanControls = { ...archeanControls, diffusion: message.mantleDiffusion }
  if (message.landShare !== undefined) archeanControls = { ...archeanControls, landShare: message.landShare }
  if (world && era === 'archean') world.setArcheanControls(archeanControls.diffusion, archeanControls.landShare)
  // Paced (epochIntervalMs from one step's start to the next's), the first
  // step one interval after the gesture. A step is synchronous up to its
  // render, so a stop always finds it before or inside the render.
  startLoop('genesis', epochIntervalMs, epochIntervalMs, async () => {
    if (!world || era !== 'archean') return false
    world.archeanStep()
    await renderArcheanAndPost(PREVIEW_RENDER_SCALE)
    return false
  }, () => renderArcheanAndPost(1))
}

// A pause, not an ending — the phase is resumable, and only becomes final when
// archeanFinalize starts the tectonic phase.
function handleGenesisStop(): void {
  // A step in flight: the loop draws the full-resolution picture after it.
  if (stopLoop('stop')?.inFlight) return
  if (world && era === 'archean' && !renderInFlight) {
    renderInFlight = true
    renderArcheanAndPost(1).finally(() => { renderInFlight = false })
  }
}

// Plate tectonics begins. Everything worth keeping of the Archean (the
// rafts, their ages, the mantle field, the epoch count for the world clock)
// is carried into the plates by the engine's hand-over, and the history's
// terrain starts from the synthesis there (phase 5.1).
function handleGenesisFinalize(): void {
  if (!world || era !== 'archean') return
  stopTicking()
  // The Archean's last epochs said once more, at the epoch it ends on. A step
  // whose render was still in flight when the hand-over came never reports
  // (the render finds the Archean gone), and the screen counts the history's
  // Archean epochs from these statuses: one short, and a replay of the
  // history parts from the hand-over on (measured 2026-10-01). The figures
  // are the last status's; only the epoch is new.
  const epoch = world.archeanEpoch
  if (lastGenesisStatus && lastGenesisStatus.epoch !== epoch) {
    emit({ ...lastGenesisStatus, epoch, worldAgeMa: worldAgeMa(epoch, 0) })
  }
  lastGenesisStatus = null
  world.finalize()
  era = 'plates'
  // The hand-over's state, copies: the engine gives them.
  handoverSnapshot = world.snapshot()
  ;[handoverMantle, handoverOceanAge] = world.savedFields()
  // No initial events under the raft model — a continent is a raft spanning
  // several plates, so there's no per-plate "continent created" moment to
  // announce at handover/reset; real continent events (collision/breakup/
  // supercontinent) only ever arrive from the epochs' own raft lifecycle.
  pendingEvents = []
  routed = false
  void renderTerrain()
}

function resetTectonics(): void {
  // Nothing to go back to on a world that was loaded from a file rather than grown
  // here — the save carries the world as it stood, not the hand-over behind it.
  if (!handoverSnapshot || !handoverOceanAge || !handoverMantle) return
  stopTicking()
  // A world from the hand-over's state each time, so a second reset
  // restores the same state as the first; its terrain from the synthesis
  // at the hand-over (phase 5.1).
  replaceWorld(theEngine().World.restorePlates(archeanShape, handoverSnapshot, handoverOceanAge, handoverMantle, null, null), 'plates')
  lastRawElevations = null
  // Still only reaches the hydrology: going back to the hand-over leaves a
  // computed climate and ecology standing, which the declared chain says it
  // should not. That is step 3c's to fix, not a move's.
  invalidateAfter('tectonics')
  pendingEvents = []
  routed = false
  void renderTerrain()
}

function resetGenesis(): void {
  // Nothing to go back to before the first genesisInit — and a 0×0 Archean
  // would hand a 0×0 world to the terrain's synthesis at the finalize.
  if (archeanWidth === 0) return
  stopTicking()
  worldGeneration += 1
  dropHandover()
  replaceWorld(theEngine().World.genesis(archeanSeed, archeanWidth, archeanHeight, archeanShape, archeanControls.diffusion, archeanControls.landShare), 'archean')
  lastRawElevations = null
  routed = false
  void renderArcheanAndPost()
}

// The dispatch table. A record rather than a chain so the set of messages this
// worker understands is a list you can read, and so a new one cannot silently
// land in the wrong branch.

// One gesture, six stages. The stage-specific half is "what does this stage go
// back to"; the generic half — discard everything downstream — comes from the
// chain, so the stages that never had a reset get one for free.
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
      // Nothing to go back to: these stages have no state of their own beyond
      // their result, so dropping it IS the reset — here and in the engine.
      // Re-running them is the screen's business — it holds the settings.
      clearResult(message.stage)
      invalidateAfter(message.stage)
      if (world && era === 'plates') world.dropStage(message.stage)
      return
  }
}

const HANDLERS: { [K in WorkerInboundMessage['type']]: (message: WorkerInboundMessage) => void } = {
  planetPreview: (m) => { void handlePlanetPreview(m as Extract<WorkerInboundMessage, { type: 'planetPreview' }>) },
  planetSample: (m) => handlePlanetSample(m as Extract<WorkerInboundMessage, { type: 'planetSample' }>),
  tectonicsStart: (m) => handleTectonicsStart(m as Extract<WorkerInboundMessage, { type: 'tectonicsStart' }>),
  tectonicsStop: () => handleTectonicsStop(),
  resetStage: (m) => handleResetStage(m as Extract<WorkerInboundMessage, { type: 'resetStage' }>),
  requestElevationField: () => handleRequestElevationField(),
  climateRun: (m) => handleClimateRun(m as Extract<WorkerInboundMessage, { type: 'climateRun' }>),
  climateRefine: (m) => handleClimateRefine(m as Extract<WorkerInboundMessage, { type: 'climateRefine' }>),
  hydrologyRun: () => handleHydrologyRun(),
  ecologyRun: (m) => handleEcologyRun(m as Extract<WorkerInboundMessage, { type: 'ecologyRun' }>),
  ecologyMonth: (m) => handleEcologyMonth(m as Extract<WorkerInboundMessage, { type: 'ecologyMonth' }>),
  serializeWorld: () => handleSerializeWorld(),
  restoreWorld: (m) => handleRestoreWorld(m as Extract<WorkerInboundMessage, { type: 'restoreWorld' }>),
  replayRuns: (m) => void handleReplayRuns(m as Extract<WorkerInboundMessage, { type: 'replayRuns' }>),
  genesisInit: (m) => handleGenesisInit(m as Extract<WorkerInboundMessage, { type: 'genesisInit' }>),
  genesisStart: (m) => handleGenesisStart(m as Extract<WorkerInboundMessage, { type: 'genesisStart' }>),
  genesisStop: () => handleGenesisStop(),
  genesisFinalize: () => handleGenesisFinalize(),
}

// Every message type the pipeline answers to. Exported so a test can assert it
// covers all of them rather than listing them by hand and quietly falling behind.
export const HANDLED_MESSAGE_TYPES: readonly string[] = Object.keys(HANDLERS)

// The sample world's terrain and colour render, made once per size and
// shape; the climate on it is recomputed per request (the controls change it).
let sampleWorld: { width: number; height: number; shape: Domain['kind']; elevation: Float32Array; buffer: Uint8Array; relief: Uint8Array } | null = null
// The engine's previews, which keep each size's climate mesh with its walk.
let preview: EnginePreview | null = null

// The elevation the preview runs on when the screen has supplied one (a
// real world, at its own size), else the synthetic sample. Resampled to the
// map at the preview's size, bilinear in world coordinates. One per shape:
// a flat world's sample is a torus, a sphere world's a globe (2026-10-11).
const planetSamples: Partial<Record<Domain['kind'], { width: number; height: number; elevation: Float32Array }>> = {}
function handlePlanetSample(message: Extract<WorkerInboundMessage, { type: 'planetSample' }>): void {
  const shape = message.shape ?? 'torus'
  planetSamples[shape] = { width: message.width, height: message.height, elevation: new Float32Array(message.elevation) }
  if (sampleWorld?.shape === shape) sampleWorld = null
}
// Without a supplied sample, the synthetic one is made on the preview's own
// domain: its domes are drawn through the domain's distances, so on the
// sphere they are round on the globe.
function previewElevation(domain: Domain): Float32Array {
  const sample = planetSamples[domain.kind]
  if (!sample) return sampleWorldElevation(domain)
  const { width, height } = domain
  const out = new Float32Array(width * height)
  const { elevation, width: sw, height: sh } = sample
  // The sample is its own frame, one texel per unit.
  const sampleGrid = domain.scaledTo(sw, sh).grid(sw, sh)
  for (let y = 0; y < height; y++) {
    const wy = ((y + 0.5) / height) * sh
    for (let x = 0; x < width; x++) out[y * width + x] = sampleGrid.sampleBilinearAt(elevation, ((x + 0.5) / width) * sw, wy)
  }
  return out
}

async function handlePlanetPreview(message: Extract<WorkerInboundMessage, { type: 'planetPreview' }>): Promise<void> {
  const { width, height } = message
  const shape = message.shape ?? 'torus'
  // A Domain does not cross the message boundary; the preview's size and shape do.
  if (!sampleWorld || sampleWorld.width !== width || sampleWorld.height !== height || sampleWorld.shape !== shape) {
    const domain = domainOfKind(shape, width, height)
    const elevation = previewElevation(domain)
    const rendered = await renderSimulationImage(
      { width, height, domain, seeds: [], rafts: [], warpSeed: 0 },
      elevation,
    )
    sampleWorld = { width, height, shape, elevation, buffer: rendered.buffer, relief: rendered.relief }
  }
  const params: ClimateParams = message.weather ?? defaultWeatherParams()
  // The sample world has no terrain mesh: its biomes and classes are the
  // climate mesh's own cells' (their centres' heights), each pixel the
  // heaviest land corner's.
  preview ??= new (theEngine().Preview)()
  const body = preview.climate(shape, width, height, sampleWorld.elevation, params)
  const message_: WorkerPlanetPreviewDataMessage = {
    type: 'planetPreviewData',
    width,
    height,
    shape,
    buffer: sampleWorld.buffer.slice().buffer as ArrayBuffer,
    relief: sampleWorld.relief.slice().buffer as ArrayBuffer,
    resX: CLIMATE_RES_X,
    resY: CLIMATE_RES_Y,
    temperature: body.temperature.buffer as ArrayBuffer,
    wind: body.wind.buffer as ArrayBuffer,
    windMesh: meshVectors(body.windMesh),
    currentsMesh: meshVectors(body.currentsMesh),
    currents: body.currents.buffer as ArrayBuffer,
    currentAnomaly: body.currentAnomaly.buffer as ArrayBuffer,
    precipitation: body.precipitation.buffer as ArrayBuffer,
    seasonalAmplitude: body.seasonalAmplitude.buffer as ArrayBuffer,
    monsoonIndex: body.monsoonIndex.buffer as ArrayBuffer,
    koppen: body.koppen.buffer as ArrayBuffer,
    biomes: body.biomes.buffer as ArrayBuffer,
  }
  const m = message_
  emit(m, [m.buffer, m.relief, m.temperature, m.wind, m.windMesh.e, m.windMesh.s, m.currentsMesh.e, m.currentsMesh.s, m.currents, m.currentAnomaly, m.precipitation, m.seasonalAmplitude, m.monsoonIndex, m.koppen, m.biomes])
}

// The stage whose compute a message runs, where a failure must reach the
// screen: it waits for the answer (the climate's two runs, the hydrology,
// the ecology and its month).
const COMPUTE_STAGE: Partial<Record<WorkerInboundMessage['type'], StageId>> = {
  climateRun: 'climate', climateRefine: 'climate', hydrologyRun: 'hydrology', ecologyRun: 'ecology', ecologyMonth: 'ecology',
}

// A message the pipeline could not take at all — its engine did not load
// (generatorWorker.ts) — answered as its handler's failure would be: what
// waits for the answer is released. Other messages have no one waiting.
export function dispatchFailed(message: WorkerInboundMessage, error: unknown): void {
  if (message.type === 'restoreWorld') {
    fail(restoreStage(message), error, true)
    return
  }
  const stage = COMPUTE_STAGE[message.type]
  if (stage) fail(stage, error)
  else console.error(`[generator] ${message.type} not taken`, error)
}

export function dispatch(message: WorkerInboundMessage): void {
  const stage = COMPUTE_STAGE[message.type]
  if (!stage) {
    HANDLERS[message.type](message)
    return
  }
  try {
    HANDLERS[message.type](message)
  } catch (error) {
    fail(stage, error)
  }
}
