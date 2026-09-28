import { serializePlateSimulation, deserializePlateSimulation } from '../tectonics/plateSimulation'
import { sampleWorldElevation } from '../planet/sampleWorld'
import type { PlanetForcing } from '../planet/planetForcing'
import type { PlateSimulation, SimEvent, PlateSimulationSnapshot } from '../tectonics/plateSimulation'
import { renderSimulationImage } from '../render/elevationMapImage'
import type { RenderSimulationOptions } from '../render/elevationMapImage'
import { ElevationRenderPool } from '../render/elevationRenderPool'
import type { ElevationRenderer } from '../render/elevationRenderPool'
import { downstreamOf } from './stages'
import type { StageId } from './stages'
import type { MeshTerrain } from './meshErosionStage'
import { createCoupledTerrain, decodeCoupledTerrain, HISTORY_DEFAULTS, stepCoupledEpoch, type CoupledTerrain } from './coupledEpoch'
import { encodeColumn } from '../mesh/meshColumn'
import { rasteriseNodeField } from '../mesh/meshRaster'
import { Biome } from '../climate/biomes'
import { SURFACE_TUNING } from '../surface/surfaceTuneParams'
import { computeHydrogeology } from '../surface/hydrogeology'
import { coverField } from '../surface/cover'
import { DEFAULT_PLANET_FORCING } from '../planet/planetForcing'
import { rasterSubstrate } from '../surface/flowSubstrate'
import { TECTONICS_INPUTS } from '../tectonics/tectonicsInputParams'
import { encodeMesh } from '../mesh/meshSerial'
import { meshRouting, meshSubstrate, waterFieldsFromMesh } from '../mesh/meshHydrology'
import { rasterCellAt } from '../surface/riverGraph'
import type { MeshPayload } from './messages'
import { coarseForcingFields } from './erosionForcing'
import { fillDepressionsAndRouteFlow } from '../surface/flowRouting'
import type { ArcheanSimulation } from '../archean/archeanState'
import { createArcheanSimulation } from '../archean/archeanState'
import { deserializeArchean, serializeArchean } from '../archean/archeanSnapshot'
import type { ArcheanParams } from '../archean/archeanStep'
import { archeanStep, DEFAULT_ARCHEAN_PARAMS } from '../archean/archeanStep'
import { convectionCellSeeds, finalizeArchean } from '../archean/finalizeArchean'
import { findPlumeSites } from '../tectonics/plumes'
import { stabilisedFraction } from '../crust/raftField'
import { TECTONIC_MA_PER_EPOCH, worldAgeMa, worldEpoch } from '../core/worldTime'
import { OCEAN_AGE_RES_X, OCEAN_AGE_RES_Y } from '../tectonics/oceanAge'
import type { FlowRouting } from '../surface/flowRouting'
import { accumulateDischarge, accumulateDischargeOn, extractRiverPolylines, computeLakes, computeLakesOn, computeRiparianBiomes, computeWatersheds, maxDischargeOverLand, meanLandRunoff, densityToCriticalArea, channelThreshold, waterLevelField, CANONICAL_RIVER_DENSITY, accumulateRegimeInputs, accumulateRegimeInputsOn, SURFACE_ICE } from '../surface/hydrology'
import type { LakeFields } from '../surface/hydrology'
import { MANTLE_RES_X, MANTLE_RES_Y } from '../mantle/mantleField'
import type { TerrainFeature } from '../tectonics/terrainFeatures'
import { computeWeather, defaultWeatherParams, type WeatherParams } from '../climate/weather'
import { computeBiomes, computeBiomesFine, computeBiomesFromMonths, computeBiomesFineFromMonths, computeKoppenField } from '../climate/biomes'
import { annualFromMonths, refineClimate } from '../climate/refinement'
import { downsampleMax, sampleBilinearWorld } from '../core/field'
import { SEA_LEVEL, metersToElevation } from '../elevation/elevationScale'
import type { WaterBody } from '../surface/hydrology'
import { buildRiverGraph, riverPolylinesFromGraph, serializeRiverGraph } from '../surface/riverGraph'
import { computeRiverCourses } from '../surface/riverCourse'
import { buildCoastGraph, type CoastGraph } from '../surface/coastGraph'
import { findSedimentBasins, type SedimentBasin } from '../surface/sedimentBasins'
import { computeIceThickness } from '../surface/iceFlow'
import { WORLD_WIDTH_METERS } from '../surface/erosionEngine'
import type { RiverGraph } from '../surface/riverGraph'
import { CLIMATE_RES_X, CLIMATE_RES_Y, sampleElevationAtCell } from '../climate/climateField'
import { computeEcology } from '../ecology/ecologyField'
import { computeMigration } from '../migration/migrationField'
import { collectVolcanoes } from '../tectonics/volcanoes'
import { computeCratonOldnessField } from '../crust/raftField'
import type { WorkerStageDeclinedMessage, WorkerGenesisStatusMessage, WorkerClimateDataMessage, WorkerClimateRefinedMessage, WorkerClimateRefineProgressMessage, WorkerEcologyDataMessage, WorkerElevationFieldMessage, WorkerHydrologyDataMessage, WorkerInboundMessage, WorkerMigrationDataMessage, WorkerRenderedMessage, WorkerWorldDataMessage, WorkerPlanetPreviewDataMessage } from './messages'

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
// `dispatch` rather than `self.onmessage`; generatorWorker.ts supplies both. That
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
// Epochs run since the last intermediate picture (HISTORY_DEFAULTS.renderEvery);
// starts at the count so the first epoch of a run draws.
let epochsSinceRender: number = HISTORY_DEFAULTS.renderEvery
let pendingEvents: SimEvent[] = []
// The last render's pre-redistribution elevation field, kept up to date by
// every renderAndPost call: what the climate and the hydrology read when no
// coupled terrain exists yet (a restored save without a mesh).
// The hand-over state, kept so the tectonics panel can return to it. Snapshotted
// rather than re-derived: finalizeArchean consumes the Archean's RNG and names the
// continents as it goes, so calling it twice does not produce the same world.
let handoverSnapshot: PlateSimulationSnapshot | null = null
let handoverOceanAge: Float32Array | null = null
let handoverMantle: Float32Array | null = null
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
let lastRawElevations: Float32Array | null = null
// The last erosion pass's per-cell sediment flux (ErosionPassV2Result), the
// river graph's sediment load. Null before any pass; stale after a restore
// (the pass that made it is gone), which the graph tolerates as zero.
let lastSedimentFlux: Float32Array | null = null
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
  // The wind (climate/wind.ts, interleaved) — the coast's exposure reads it.
  wind: Float32Array
  // Set when this is the climate step's refinement (handleClimateRefine):
  // the real months the annual fields above were derived from. The riparian
  // biomes classify from them, and the hydrology's own climate pass (the
  // dry-basin v2) leaves such a climate alone.
  months?: { temperature: Float32Array; precipitation: Float32Array; count: number }
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
  // Permanently frozen basins (LakeFields.frozen) — the Biome.Ice override's
  // source, and what excludes a glacier from the freshwater fishery below.
  frozen: Uint8Array | null
  // The standing-water list and the per-cell level/frozen fields derived
  // from it (LakeFields.bodies/level) — what the save carries and the
  // screen draws shores against.
  bodies: WaterBody[]
  level: Float32Array
  surface: Uint8Array
  body: Int32Array
  maxDischarge: number
  meanRunoff: number
  // The feature graph, built once per routing (after the riparian biomes,
  // which it records as bank material); the ribbons derive from it.
  graph: RiverGraph | null
  // The coast reaches (surface/coastGraph.ts), built with the graph.
  coast: CoastGraph | null
  // The erosion pass's deposits as features (surface/sedimentBasins.ts),
  // with provenance from the graph's catchments; empty for a world whose
  // pre-erosion terrain is not known (a loaded save).
  sedimentBasins: SedimentBasin[]
  // Ice thickness in metres (surface/iceFlow.ts, F4) on this raster —
  // the sheets and the largest valley glaciers at 7.8 km.
  ice: Float32Array | null
  // The water table's depth below the surface on the world raster, metres
  // (phase 5a, surface/hydrogeology.ts); −1 under water.
  waterTable: Float32Array | null
  // The mesh's own hydrology when the world has a mesh (phase 4.3); the
  // raster fields above are then its recovery.
  onMesh: MeshHydrology | null
}
let hydrology: HydrologyResult | null = null
// Bumped whenever the hydrology result is dropped (an epoch, a reset, a
// climate change) and read by the hydrology pass across its awaits: the
// onmessage handler is sync, so nothing else stops a pass that started on a
// terrain the world has since moved off from publishing onto the new one.
let hydrologyGeneration = 0
let hydrologyInFlight = false

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

// The world's terrain since phase 4.3: the adaptive mesh the last erosion
// ran on, with its eroded heights, in canonical numbering. What the save
// carries (`mesh/…`), and what a restore brings back. The raster fields
// above are its rasterisation while the consumers still walk cells.
let meshTerrain: MeshTerrain | null = null
// THE COUPLED TERRAIN (phase 5.1): the mesh the tectonics carry through
// their epochs — erosion runs inside each one (pipeline/coupledEpoch.ts).
// `meshTerrain` above is this same object once an epoch has run (it then
// has a routing); before the first epoch, and for a world restored
// without a mesh, it is null and the hydrology walks the raster.
let coupled: CoupledTerrain | null = null
// The tectonics panel's controls for the history (tectonicsInputParams).
let historyControls: { alluvium: number; rockContrast: number; weather: WeatherParams } = { alluvium: TECTONICS_INPUTS.alluvium.default, rockContrast: TECTONICS_INPUTS.rockContrast.default, weather: defaultWeatherParams() }
let epochInFlight = false

// The coupled terrain as what the hydrology reads (a routing is required
// there): the same arrays, once an epoch or a restore has routed it.
function asMeshTerrain(c: CoupledTerrain): MeshTerrain | null {
  return c.routing ? { mesh: c.mesh, z: c.z, routing: c.routing, areas: c.areas, sedimentFlux: c.sedimentFlux } : null
}

// The terrain's rasterisation, rendered and posted: what every consumer
// that still walks cells reads, and the map's texture. The climate runs on
// the current terrain (there is no pre-erosion terrain any more); the
// sediment basins read the last epoch's start (meshBefore, rasterised on
// demand in the hydrology handler).
async function renderTerrain(intermediate = false): Promise<void> {
  if (!sim || !coupled) return
  const elevations = rasteriseNodeField(coupled.mesh, coupled.z, sim.width, sim.height)
  await renderAndPost(elevations, intermediate, 1)
  preErosionElevations = null
  lastLakeBasinElevations = elevations.slice()
  lastSedimentFlux = coupled.sedimentFlux.length > 0 ? rasteriseNodeField(coupled.mesh, coupled.sedimentFlux, sim.width, sim.height) : null
  meshBefore = null
  meshPayloadCache = null
}
// The mesh's initial heights rasterised — the "before" of the last erosion
// for the cell-walking consumers (the sediment basins), see
// the coupled terrain's preErosionZ, rasterised on demand. Null when no epoch ran.
let meshBefore: Float32Array | null = null
// The mesh terrain's bytes for the screen and the save, encoded once per
// terrain (a second's work on a million nodes) and reused.
let meshPayloadCache: MeshPayload | null = null

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
      climate = null
      return
    case 'hydrology':
      hydrology = null
      hydrologyGeneration += 1
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

// Event markers no longer live here — they moved to the main thread as
// wall-clock-faded overlay markers driven by the forwarded sim events (see
// GeneratorScreen's event overlay). The worker just relays events; it does
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

// precomputedElevations, when passed, is the coupled terrain's rasterisation
// (renderTerrain) or a restored raster — always explicitly set (even to undefined)
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
    { width: archean.width, height: archean.height, seeds: previewSeeds, rafts: archean.rafts, features: [], oceanAge: EMPTY_OCEAN_AGE, warpSeed: archean.warpSeed, seaLevelOffset: archean.seaLevelOffset, mantle: archean.mantle },
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
    // No plate epoch has passed yet — see WorkerRenderedMessage.epoch. The
    // Archean's own count travels in the genesisStatus below.
    epoch: 0,
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

// The mesh payload, encoded once per terrain. A COPY per request: the
// buffers are transferred to the screen, and a transferred buffer is gone.
function meshPayload(): MeshPayload | undefined {
  if (!meshTerrain) return undefined
  if (!meshPayloadCache) meshPayloadCache = serializeMeshTerrain(meshTerrain)
  const c = meshPayloadCache
  return { count: c.count, nodes: c.nodes.slice(0), connectivity: c.connectivity.slice(0), z: c.z.slice(0), column: c.column?.slice(0) }
}

// The mesh terrain as the save's bytes (mesh/meshSerial.ts). The mesh is
// canonical already, so the identity numbering is the Hilbert one.
function serializeMeshTerrain(terrain: MeshTerrain): MeshPayload {
  const order = new Int32Array(terrain.mesh.aliveVertices)
  for (let i = 0; i < order.length; i++) order[i] = i
  const serial = encodeMesh(terrain.mesh, order)
  const z = terrain.z.slice(0, serial.count)
  // The column rides along when the terrain is the coupled one (it always
  // is once an epoch has run — the hydrology's view of it is `terrain`).
  const column = coupled && coupled.mesh === terrain.mesh ? encodeColumn(coupled.column, serial.count) : undefined
  return { count: serial.count, nodes: serial.nodes.buffer as ArrayBuffer, connectivity: serial.connectivity.buffer as ArrayBuffer, z: z.buffer as ArrayBuffer, column: column ? column.buffer as ArrayBuffer : undefined }
}


// THE HYDROLOGY ON THE MESH (phase 4.3): the lakes and the discharge over
// the mesh's own routing, and the raster fields the cell-walking consumers
// (the climate refinement, the riparian biomes, the map) still read,
// rasterised from the nodes' bodies (meshHydrology.waterFieldsFromMesh) —
// one truth, the bodies, two representations.
interface MeshHydrology {
  discharge: Float32Array
  lakes: LakeFields
  // The raster recovery of the bodies.
  raster: { depth: Float32Array; saltFlat: Uint8Array; dryBasin: Uint8Array; frozen: Uint8Array; level: Float32Array; body: Int32Array; surface: Uint8Array }
}

function hydrologyOnMesh(terrain: MeshTerrain, elevationRaster: Float32Array, width: number, height: number, weather: ClimateResult): MeshHydrology {
  const sub = meshSubstrate(terrain.mesh, terrain.routing, terrain.areas)
  const discharge = accumulateDischargeOn(sub, terrain.z, weather.precipitation, CLIMATE_RES_X, CLIMATE_RES_Y)
  const lakes = computeLakesOn(sub, discharge, terrain.z, weather.temperature, weather.precipitation, CLIMATE_RES_X, CLIMATE_RES_Y)
  return { discharge, lakes, raster: waterFieldsFromMesh(terrain.mesh, lakes.body, lakes.bodies, elevationRaster, width, height) }
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


function handleTectonicsStart(message: Extract<WorkerInboundMessage, { type: 'tectonicsStart' }>): void {
  if (intervalId !== undefined) return
  // No plates yet: the Archean has not been handed over. Said out loud rather
  // than armed anyway — the interval is one variable for both phases, so a
  // loop of idle ticks here kept the next genesisStart from starting at all.
  if (!sim) { decline('tectonics', 'genesis'); return }
  historyControls = {
    alluvium: message.alluvium ?? TECTONICS_INPUTS.alluvium.default,
    rockContrast: message.rockContrast ?? TECTONICS_INPUTS.rockContrast.default,
    weather: message.weather ?? defaultWeatherParams(),
  }
  if (sim) sim.epochMa = TECTONIC_MA_PER_EPOCH
  // THE COUPLED EPOCH (phase 5.1): the plates move, the mesh follows,
  // erosion runs inside the epoch, the terrain is rasterised and drawn. An
  // epoch is asynchronous (the engine) and takes what it takes; the interval
  // only says how often to try, and a tick while one is in flight is
  // skipped — the loop runs as fast as an epoch runs, never faster. The
  // first epoch starts with the gesture rather than one interval later:
  // a start followed by a stop is then exactly one epoch, which is what
  // the pipeline harness's determinism check builds its two worlds with.
  const tick = (): void => {
    // A tick after the stop is no tick: the seamless tick below queues one
    // with a zero delay, and a stop message queued during the epoch is
    // handled before it — without this line that tick ran an epoch behind
    // the settled picture (pipeline harness, "a stop between two epochs").
    if (intervalId === undefined) return
    if (!sim || renderInFlight || epochInFlight) return
    const currentSim = sim
    epochInFlight = true
    renderInFlight = true
    const startedAt = performance.now()
    ;(async () => {
      // A world restored without a mesh (a save from before the history)
      // gets one from its own synthesis on the first epoch.
      if (!coupled) coupled = createCoupledTerrain(currentSim, HISTORY_DEFAULTS.budget)
      const stats = await stepCoupledEpoch(currentSim, coupled, {
        iterationsPerEpoch: HISTORY_DEFAULTS.iterationsPerEpoch,
        budget: HISTORY_DEFAULTS.budget,
        climateEvery: HISTORY_DEFAULTS.climateEvery,
        remeshEvery: HISTORY_DEFAULTS.remeshEvery,
        upliftScale: HISTORY_DEFAULTS.upliftScale,
        controls: { alluvium: historyControls.alluvium, rockContrast: historyControls.rockContrast },
        weather: historyControls.weather,
      })
      // Events are forwarded to the main thread (batched with the next
      // render), which owns their notifications + faded map markers now.
      pendingEvents.push(...stats.events)
      meshTerrain = asMeshTerrain(coupled)
      // Intermediate while the loop still ticks, and only every
      // HISTORY_DEFAULTS.renderEvery-th epoch (the first always): the next
      // picture replaces this one. The epoch that finishes after the stop
      // is the settled one — drawn whatever the count, the screen then
      // pulls the elevation field and runs the chain.
      epochsSinceRender++
      if (intervalId === undefined || epochsSinceRender >= HISTORY_DEFAULTS.renderEvery) {
        epochsSinceRender = 0
        await renderTerrain(intervalId !== undefined)
      }
    })().finally(() => {
      epochInFlight = false
      renderInFlight = false
      // The interval is the pacing's minimum, not a wait: an epoch that
      // outlasted it starts the next one now rather than at the interval's
      // next beat (up to a beat idle per epoch, measured 2026-09-26).
      if (intervalId !== undefined && performance.now() - startedAt >= epochIntervalMs) setTimeout(tick, 0)
    })
  }
  epochsSinceRender = HISTORY_DEFAULTS.renderEvery
  intervalId = setInterval(tick, epochIntervalMs)
  tick()
}

function handleTectonicsStop(): void {
  stopTicking()
  // The settled render: the last epoch's, if one is still in flight (it
  // sees the interval gone and renders as settled), otherwise the terrain
  // as it stands, once more. NOT a render from the synthesis — that would
  // replace the history's terrain with the fields'.
  if (sim && coupled && !epochInFlight && !renderInFlight) {
    renderInFlight = true
    renderTerrain(false).finally(() => {
      renderInFlight = false
    })
  }
}



function resetErosion(): void {
  // Nothing to go back to: the terrain is the history's (phase 5.1).
}

// The climate levers of the last computeClimate — kept so the hydrology
// handler's climate REFINEMENT pass (see handleHydrologyRun) can re-run
// the identical chain with the terminal-basin land override.
interface ClimateParams {
  temperatureOffset: number
  temperatureContrast: number
  humidity: number
  equatorOffset: number
  planet?: PlanetForcing
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
  const { temperature, wind, currents, currentAnomaly, seasonalAmplitude, seasonal } = computeWeather(elevation, width, height, params, dryLand)
  // Classified twice, on purpose, from identical inputs: `biomes` on the climate
  // grid for the ecology step, `biomesFine` on the world raster for everything
  // the user sees or saves (see climate/biomes.computeBiomesFine, and
  // lastClimateBiomes for why ecology must not take the fine one). The second
  // pass is a pointwise loop over an existing field — measured well under the
  // precipitation advection it follows.
  const biomes = computeBiomes(temperature, seasonal.annual, seasonalAmplitude, seasonal.index, elevation, width, height, dryLand)
  const biomesFine = computeBiomesFine(temperature, seasonal.annual, seasonalAmplitude, seasonal.index, elevation, width, height, dryLand)
  const koppen = computeKoppenField(temperature, seasonal.annual, seasonalAmplitude, seasonal.index, elevation, width, height, dryLand)
  return { temperature, wind, currents, currentAnomaly, seasonalAmplitude, seasonal, biomes, biomesFine, koppen }
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
    wind: chain.wind.slice(),
  }
  const climateMessage: WorkerClimateDataMessage = {
    type: 'climateData',
    refinement,
    resX: CLIMATE_RES_X,
    resY: CLIMATE_RES_Y,
    temperature: chain.temperature.buffer as ArrayBuffer,
    wind: chain.wind.buffer as ArrayBuffer,
    currents: chain.currents.buffer as ArrayBuffer,
    currentAnomaly: chain.currentAnomaly.buffer as ArrayBuffer,
    precipitation: chain.seasonal.annual.buffer as ArrayBuffer,
    seasonalAmplitude: chain.seasonalAmplitude.buffer as ArrayBuffer,
    monsoonIndex: chain.seasonal.index.buffer as ArrayBuffer,
    koppen: chain.koppen.buffer as ArrayBuffer,
    biomes: chain.biomesFine.buffer as ArrayBuffer,
  }
  emit(climateMessage, [climateMessage.temperature, climateMessage.wind, climateMessage.currents, climateMessage.currentAnomaly, climateMessage.precipitation, climateMessage.seasonalAmplitude, climateMessage.monsoonIndex, climateMessage.koppen, climateMessage.biomes])
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
    planet: message.planet,
  }
  cacheAndPostClimate(computeClimateChain(elevation, sim.width, sim.height, params), params)
  invalidateAfter('climate')
}

// The climate step's refinement (climate/refinement.ts), on the climate the
// step shows and the terrain it was computed on. The worker keeps nothing of
// it yet: nothing downstream reads it until the
// energy balance feeds the biomes, so the screen holds the only copy.
function handleClimateRefine(): void {
  const elevation = preErosionElevations ?? lastRawElevations
  if (!sim || !elevation) { decline('climate', 'tectonics'); return }
  if (!climate) { decline('climate', 'climate'); return }
  const { width, height } = sim
  const r = refineClimate(elevation, width, height, climate.params, climate.temperature, climate.wind, (share) => {
    const progress: WorkerClimateRefineProgressMessage = { type: 'climateRefineProgress', share: share * 0.85 }
    emit(progress)
  })

  // The refined climate takes the history's place (build step 5b): its
  // annual fields derived from the months, its biomes classified from them.
  // Everything downstream is then stale — the rivers run on the new rain.
  const n = CLIMATE_RES_X * CLIMATE_RES_Y
  const annual = annualFromMonths(r)
  const biomes = computeBiomesFromMonths(r.temperature, r.precipitation, r.months, annual.precipitation, elevation, width, height)
  const biomesFine = computeBiomesFineFromMonths(r.temperature, r.precipitation, r.months, annual.temperature, annual.precipitation, elevation, width, height)
  const annualWind = new Float32Array(n * 2)
  for (let m = 0; m < r.months; m++) for (let i = 0; i < n * 2; i++) annualWind[i] += r.wind[m * n * 2 + i] / r.months
  climate = {
    params: climate.params,
    temperature: annual.temperature,
    precipitation: annual.precipitation,
    seasonalAmplitude: annual.seasonalAmplitude,
    monsoonIndex: annual.monsoonIndex,
    biomes,
    currents: r.currents,
    wind: annualWind,
    months: { temperature: r.temperature, precipitation: r.precipitation, count: r.months },
  }

  const reply: WorkerClimateRefinedMessage = {
    type: 'climateRefined',
    resX: CLIMATE_RES_X,
    resY: CLIMATE_RES_Y,
    months: r.months,
    temperature: r.temperature.slice().buffer as ArrayBuffer,
    precipitation: r.precipitation.slice().buffer as ArrayBuffer,
    koppen: r.koppen.slice().buffer as ArrayBuffer,
    fog: r.fog.buffer as ArrayBuffer,
    foehn: r.foehn.buffer as ArrayBuffer,
    pressure: r.pressure.buffer as ArrayBuffer,
    wind: r.wind.buffer as ArrayBuffer,
    currents: r.currents.slice().buffer as ArrayBuffer,
    currentAnomaly: r.currentAnomaly.slice().buffer as ArrayBuffer,
    upwelling: r.upwelling.buffer as ArrayBuffer,
  }
  emit(reply, [reply.temperature, reply.precipitation, reply.koppen, reply.fog, reply.foehn, reply.pressure, reply.wind, reply.currents, reply.currentAnomaly, reply.upwelling])
  // The screen's annual fields follow, as a climate of its own kind.
  const climateMessage: WorkerClimateDataMessage = {
    type: 'climateData',
    refined: true,
    resX: CLIMATE_RES_X,
    resY: CLIMATE_RES_Y,
    temperature: annual.temperature.slice().buffer as ArrayBuffer,
    wind: annualWind.slice().buffer as ArrayBuffer,
    currents: r.currents.slice().buffer as ArrayBuffer,
    currentAnomaly: r.currentAnomaly.buffer as ArrayBuffer,
    precipitation: annual.precipitation.slice().buffer as ArrayBuffer,
    seasonalAmplitude: annual.seasonalAmplitude.slice().buffer as ArrayBuffer,
    monsoonIndex: annual.monsoonIndex.slice().buffer as ArrayBuffer,
    koppen: r.koppen.buffer as ArrayBuffer,
    biomes: biomesFine.buffer as ArrayBuffer,
  }
  emit(climateMessage, [climateMessage.temperature, climateMessage.wind, climateMessage.currents, climateMessage.currentAnomaly, climateMessage.precipitation, climateMessage.seasonalAmplitude, climateMessage.monsoonIndex, climateMessage.koppen, climateMessage.biomes])
  invalidateAfter('climate')
}

// The lake depths with frozen basins zeroed — what the ecology (fish) and the
// migration cost field should see as WATER. Computed on demand rather than
// stored: the full depth layer stays the display/save truth (ice is water).
function liquidLakeDepth(h: HydrologyResult): Float32Array {
  if (!h.frozen) return h.lakeDepth
  const out = h.lakeDepth.slice()
  for (let i = 0; i < out.length; i++) if (h.frozen[i]) out[i] = 0
  return out
}

function handleHydrologyRun(): void {
  // Needs the current topography + a computed climate (rivers' water source).
  if (!sim || !lastRawElevations) { decline('hydrology', 'tectonics'); return }
  if (!climate) { decline('hydrology', 'climate'); return }
  // One pass at a time: a second call while one runs would route the same
  // terrain twice and publish twice. The running pass answers for both.
  if (hydrologyInFlight) return
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
  // What this pass answers for. After each await below the pass asks whether
  // that is still the world's question — a world replaced under it, or a
  // result dropped by an epoch or a reset, and it stops without publishing.
  const world = worldGeneration
  const generation = hydrologyGeneration
  const stale = (): boolean => world !== worldGeneration || generation !== hydrologyGeneration
  hydrologyInFlight = true
  // Async (the priority-flood routing is a Promise); the onmessage handler is
  // sync, so run it in an IIFE like the erode branch does.
  ;(async () => {
    // Re-route only when topography/climate changed; a repeat call reuses the
    // cached routing + discharge + lakes (the expensive parts) and just
    // re-extracts the polylines. An absent result IS "re-route needed".
    let rerouted = false
    let result = hydrology
    if (!result) {
      const routing = await fillDepressionsAndRouteFlow(elevation, width, height, SEA_LEVEL)
      if (stale()) return
      let discharge = accumulateDischarge(routing, elevation, weather.precipitation, CLIMATE_RES_X, CLIMATE_RES_Y)
      let maxDischarge = maxDischargeOverLand(discharge, elevation)
      let meanRunoff = meanLandRunoff(weather.precipitation, elevation, width, height, CLIMATE_RES_X, CLIMATE_RES_Y)
      {
        // With the mesh, the lakes are the mesh's (hydrologyOnMesh); the
        // raster routing above still serves the cell-walking consumers.
        let onMesh = meshTerrain ? hydrologyOnMesh(meshTerrain, elevation, width, height, weather) : null
        let lakes = onMesh ? { ...onMesh.raster, bodies: onMesh.lakes.bodies } : computeLakes(routing, discharge, elevation, weather.temperature, weather.precipitation, CLIMATE_RES_X, CLIMATE_RES_Y)
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
        // Not over the step's refinement: it is computed on the step's own
        // land mask, without the dry-basin override, and recomputing the
        // cheap chain here would put the history's climate back in its place.
        if (!weather.months) {
          const chain = computeClimateChain(terrain, width, height, weather.params, lakes.dryBasin)
          // Update the caches + screen WITHOUT invalidateAfter('climate'):
          // the very next lines recompute the dependent hydrology themselves,
          // and dropping the hydrology result here would force a needless full
          // re-route on the next call.
          weather = cacheAndPostClimate(chain, weather.params, true)
          discharge = accumulateDischarge(routing, elevation, weather.precipitation, CLIMATE_RES_X, CLIMATE_RES_Y)
          maxDischarge = maxDischargeOverLand(discharge, elevation)
          meanRunoff = meanLandRunoff(weather.precipitation, elevation, width, height, CLIMATE_RES_X, CLIMATE_RES_Y)
          onMesh = meshTerrain ? hydrologyOnMesh(meshTerrain, elevation, width, height, weather) : null
          lakes = onMesh ? { ...onMesh.raster, bodies: onMesh.lakes.bodies } : computeLakes(routing, discharge, elevation, weather.temperature, weather.precipitation, CLIMATE_RES_X, CLIMATE_RES_Y)
        }
        // The graph's discharge scale: the substrate it is built on.
        if (onMesh && meshTerrain) maxDischarge = maxDischargeOverLand(onMesh.discharge, meshTerrain.z)
        // Terrain truth: repaint the map with the dry basin floors as land
        // (salt band + basin rock, real hillshade). skipInvalidation — this
        // render shows the hydrology we JUST computed; dropping the result here
        // would force a pointless full re-route on the next call.
        renderDryBasin = lakes.dryBasin
        renderSaltFlat = lakes.saltFlat
        await renderAndPost(terrain, false, 1, true)
        if (stale()) return
        result = {
          routing, discharge, lakeDepth: lakes.depth, saltFlat: lakes.saltFlat, dryBasin: lakes.dryBasin, frozen: lakes.frozen,
          bodies: lakes.bodies, level: lakes.level, surface: onMesh ? onMesh.raster.surface : waterLevelField(lakes.bodies, elevation, width, height).surface, body: lakes.body,
          maxDischarge, meanRunoff, graph: null, coast: null, sedimentBasins: [], ice: null, waterTable: null,
          onMesh,
        }
      }
      hydrology = result
      rerouted = true
    }
    // ONE threshold, the model's own: the generator draws exactly the
    // canonical channel set the riparian biomes, the bake and the worldmap
    // read. The density slider that used to threshold the drawing separately
    // died with its panel (erosion-v2 P4/teardown).
    const threshold = channelThreshold(densityToCriticalArea(CANONICAL_RIVER_DENSITY), result.meanRunoff)
    // Lakes only change on a re-route; a repeat call sends an empty buffer.
    const lakeOut = rerouted ? result.lakeDepth.slice() : new Float32Array(0)
    const levelOut = rerouted ? result.level.slice() : new Float32Array(0)
    const surfaceOut = rerouted ? result.surface.slice() : new Uint8Array(0)
    // Watersheds + the raw discharge field: re-route only, same contract.
    const watershedsOut = rerouted ? computeWatersheds(result.routing, elevation) : new Uint16Array(0)
    const dischargeOut = rerouted ? result.discharge.slice() : new Float32Array(0)
    // Riparian biomes are pinned to the routing like the lakes, so they too
    // change on a re-route only — a repeat call sends them empty (the screen
    // keeps its last copy). Uses the display terrain (lastRawElevations) so
    // land/ocean matches the map.
    let biomesOut: Uint8Array = new Uint8Array(0)
    let precipEffOut: Float32Array = new Float32Array(0)
    if (rerouted) {
      const riparian = computeRiparianBiomes(result.routing, terrain, result.discharge, threshold, result.maxDischarge, result.lakeDepth, weather.precipitation, weather.temperature, weather.seasonalAmplitude, weather.monsoonIndex, width, height, CLIMATE_RES_X, CLIMATE_RES_Y, result.saltFlat ?? undefined, result.dryBasin ?? undefined, result.frozen ?? undefined, weather.months)
      // The riparian-effective precipitation rides along: it is what lets the
      // worldmap reclassify at bake resolution without re-running hydrology.
      biomesOut = riparian.biomes
      precipEffOut = riparian.precipEff
      // THE FEATURE GRAPH (phase 2): the network as data, with the riparian
      // biomes as bank material and the last erosion pass's sediment flux as
      // load. The ribbons below derive from it.
      // The forcing's hardness: the coast's and the hydrogeology's input.
      const forcingFields = coarseForcingFields(sim, width, height)
      // The cover (phase 5.5) from the coarse biomes, for the infiltration.
      const plantsFromMa = (historyControls.weather.planet ?? DEFAULT_PLANET_FORCING).landPlantsFromMa
      const cover = coverField(weather.biomes, worldAgeMa(sim.archeanEpochs, sim.epoch) >= plantsFromMa)
      if (result.onMesh && meshTerrain) {
        // On the mesh (phase 4.3): the graph from the mesh's own routing,
        // discharge and lakes; the bank material sampled from the raster
        // riparian biomes at each node.
        const sub = meshSubstrate(meshTerrain.mesh, meshTerrain.routing, meshTerrain.areas)
        const bankAtNode = new Uint8Array(meshTerrain.mesh.vertexSlots)
        for (let v = 0; v < bankAtNode.length; v++) if (meshTerrain.mesh.vAlive[v]) bankAtNode[v] = riparian.biomes[rasterCellAt(meshTerrain.mesh.vx[v], meshTerrain.mesh.vy[v], width, height)]
        const regime = accumulateRegimeInputsOn(sub, meshTerrain.z, weather.temperature, weather.precipitation, weather.monsoonIndex, CLIMATE_RES_X, CLIMATE_RES_Y)
        result.graph = buildRiverGraph({
          substrate: sub, discharge: result.onMesh.discharge, elevation: meshTerrain.z, threshold, maxDischarge: result.maxDischarge,
          bodies: result.onMesh.lakes.bodies, body: result.onMesh.lakes.body, lakeDepth: result.onMesh.lakes.depth,
          sedimentFlux: meshTerrain.sedimentFlux.length === meshTerrain.mesh.vertexSlots ? meshTerrain.sedimentFlux : undefined,
          biomes: bankAtNode,
          regime,
          criticalArea: densityToCriticalArea(CANONICAL_RIVER_DENSITY),
        })
        // THE HYDROGEOLOGY (phase 5a): the column's materials, the springs
        // on the graph, the regime re-judged with the baseflow, the water
        // table — on the mesh, then the table rasterised for the layer.
        const ground = computeHydrogeology({
          sub, elevation: meshTerrain.z, graph: result.graph,
          column: coupled && coupled.mesh === meshTerrain.mesh ? coupled.column : null,
          hardness: forcingFields.hardness, climateResX: CLIMATE_RES_X, climateResY: CLIMATE_RES_Y,
          precipitation: weather.precipitation, temperature: weather.temperature, monsoonIndex: weather.monsoonIndex,
          cover, regime, discharge: result.onMesh.discharge, cellM: WORLD_WIDTH_METERS / width,
        })
        const table = rasteriseNodeField(meshTerrain.mesh, ground.waterTableDepthM, width, height)
        for (let c = 0; c < table.length; c++) if (elevation[c] <= 0 || table[c] < 0) table[c] = -1
        result.waterTable = table
      } else {
        const regime = accumulateRegimeInputs(result.routing, elevation, weather.temperature, weather.precipitation, weather.monsoonIndex, CLIMATE_RES_X, CLIMATE_RES_Y)
        result.graph = buildRiverGraph({
          routing: result.routing, discharge: result.discharge, elevation, threshold, maxDischarge: result.maxDischarge,
          bodies: result.bodies, body: result.body, lakeDepth: result.lakeDepth,
          sedimentFlux: lastSedimentFlux && lastSedimentFlux.length === elevation.length ? lastSedimentFlux : undefined,
          biomes: riparian.biomes,
          // The flow regime (F6) from the climate the lakes were flooded with.
          regime,
          criticalArea: densityToCriticalArea(CANONICAL_RIVER_DENSITY),
        })
        // The hydrogeology on the raster: bedrock everywhere (no column).
        const ground = computeHydrogeology({
          sub: rasterSubstrate(result.routing), elevation, graph: result.graph, column: null,
          hardness: forcingFields.hardness, climateResX: CLIMATE_RES_X, climateResY: CLIMATE_RES_Y,
          precipitation: weather.precipitation, temperature: weather.temperature, monsoonIndex: weather.monsoonIndex,
          cover, regime, discharge: result.discharge, cellM: WORLD_WIDTH_METERS / width,
        })
        result.waterTable = ground.waterTableDepthM
      }
      // THE RIVER COURSE (phase 3): pattern, meanders, braids and deltas per
      // reach, seeded from the world so a world always gets the same bends.
      result.graph.courses = computeRiverCourses(result.graph, { cellM: WORLD_WIDTH_METERS / width, seed: sim.warpSeed })
      // THE COAST (F5): exposure from the wind, hardness from the erosion
      // forcing's field, sediment from the graph's mouths — a type per reach.
      result.coast = buildCoastGraph({
        elevation, width, height, wind: weather.wind, climateResX: CLIMATE_RES_X, climateResY: CLIMATE_RES_Y,
        hardness: forcingFields.hardness, graph: result.graph, cellM: WORLD_WIDTH_METERS / width,
      })
      // SEDIMENT BASINS (F1): what the last erosion pass deposited, with the
      // provenance of the catchments feeding each basin. Needs the terrain
      // the pass started from; a loaded save has none, and gets no basins.
      // The "before" of the last epoch's deposition: the heights that
      // epoch's erosion started from, rasterised on demand (phase 5.1).
      if (!meshBefore && coupled && coupled.preErosionZ.length > 0) meshBefore = rasteriseNodeField(coupled.mesh, coupled.preErosionZ, width, height)
      const before = meshBefore ?? preErosionElevations
      result.sedimentBasins = before && before !== terrain && before.length === terrain.length
        ? findSedimentBasins({
          before, after: terrain, width, height, routing: result.routing, graph: result.graph, cellM: WORLD_WIDTH_METERS / width,
          cratonAge: computeCratonOldnessField(sim.rafts, worldEpoch(sim.archeanEpochs, sim.epoch), CLIMATE_RES_X, CLIMATE_RES_Y, width, height),
          hardness: forcingFields.hardness, coarseResX: CLIMATE_RES_X, coarseResY: CLIMATE_RES_Y,
        }).basins
        : []
      // THE ICE: the history's own (phase 6, the last epoch's steady state
      // on the mesh) when the terrain has been through an epoch, rasterised;
      // otherwise F4's shallow-ice flow once, with the refined climate (a
      // restored world before its next epoch, a world without a mesh).
      if (coupled && meshTerrain && coupled.mesh === meshTerrain.mesh && coupled.ice.length === coupled.mesh.vertexSlots) {
        const ice = rasteriseNodeField(coupled.mesh, coupled.ice, width, height)
        for (let c = 0; c < ice.length; c++) if (elevation[c] <= 0 || ice[c] < SURFACE_TUNING.iceMinThicknessM) ice[c] = 0
        result.ice = ice
      } else {
        result.ice = computeIceThickness({
          elevation, width, height, temperature: weather.temperature, precipitation: weather.precipitation,
          climateResX: CLIMATE_RES_X, climateResY: CLIMATE_RES_Y, cellM: WORLD_WIDTH_METERS / width,
        }).thickness
      }
      // THE ICE BODY IS A BIOME (phase 6, decided 2026-09-23: the climate
      // class Ice stays, Glacier is the ice with a thickness): under ice the
      // cell's biome is Glacier, whatever the climate said.
      for (let c = 0; c < biomesOut.length; c++) if (result.ice[c] > 0 && elevation[c] > 0) biomesOut[c] = Biome.Glacier
    }
    const rivers = result.graph
      ? riverPolylinesFromGraph(result.graph, result.maxDischarge)
      : extractRiverPolylines(result.routing, result.discharge, elevation, threshold, result.maxDischarge)
    // The glaciers (computed above with the graph) ride in the level field the shore drawing reads: an ice
    // cell's level is its ice surface, its surface kind ice — the map
    // paints them as ice bodies, thickness as depth.
    if (rerouted && result.ice) {
      for (let c = 0; c < levelOut.length; c++) {
        if (result.ice[c] <= 0) continue
        levelOut[c] = Math.max(levelOut[c], elevation[c] + metersToElevation(result.ice[c]))
        surfaceOut[c] = SURFACE_ICE
      }
    }
    const iceOut = rerouted && result.ice ? result.ice.slice() : new Float32Array(0)
    const waterTableOut = rerouted && result.waterTable ? result.waterTable.slice() : new Float32Array(0)
    const graphOut = rerouted && result.graph ? serializeRiverGraph(result.graph) : null
    const coastOut = rerouted && result.coast ? result.coast : null
    const hydrologyMessage: WorkerHydrologyDataMessage = {
      type: 'hydrologyData',
      riverPoints: rivers.points.buffer as ArrayBuffer,
      riverLengths: rivers.lengths.buffer as ArrayBuffer,
      riverRegimes: rivers.regimes.buffer as ArrayBuffer,
      lakeDepth: lakeOut.buffer as ArrayBuffer,
      biomes: biomesOut.buffer as ArrayBuffer,
      precipitationEffective: precipEffOut.buffer as ArrayBuffer,
      watersheds: watershedsOut.buffer as ArrayBuffer,
      discharge: dischargeOut.buffer as ArrayBuffer,
      maxDischarge: result.maxDischarge,
      waterBodies: rerouted ? result.bodies : null,
      waterLevel: levelOut.buffer as ArrayBuffer,
      waterSurface: surfaceOut.buffer as ArrayBuffer,
      riverGraph: graphOut ? { json: graphOut.json, cells: graphOut.cells.slice().buffer as ArrayBuffer, coursePoints: graphOut.coursePoints.buffer as ArrayBuffer } : null,
      coastType: coastOut ? coastOut.type.slice().buffer as ArrayBuffer : new Uint8Array(0).buffer as ArrayBuffer,
      coast: coastOut ? { reaches: coastOut.reaches, cells: coastOut.cells.slice().buffer as ArrayBuffer } : null,
      sedimentBasins: rerouted ? result.sedimentBasins : null,
      iceThickness: iceOut.buffer as ArrayBuffer,
      waterTable: waterTableOut.buffer as ArrayBuffer,
    }
    const transfer = [hydrologyMessage.riverPoints, hydrologyMessage.riverLengths, hydrologyMessage.riverRegimes, hydrologyMessage.lakeDepth, hydrologyMessage.biomes, hydrologyMessage.precipitationEffective, hydrologyMessage.watersheds, hydrologyMessage.discharge, hydrologyMessage.waterLevel, hydrologyMessage.waterSurface]
    if (hydrologyMessage.riverGraph) transfer.push(hydrologyMessage.riverGraph.cells, hydrologyMessage.riverGraph.coursePoints)
    transfer.push(hydrologyMessage.coastType, hydrologyMessage.iceThickness, hydrologyMessage.waterTable)
    if (hydrologyMessage.coast) transfer.push(hydrologyMessage.coast.cells)
    emit(hydrologyMessage, transfer)
  })().finally(() => { hydrologyInFlight = false })
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
  // this once hydrology lands (see GeneratorScreen's chaining).
  const cratonAge = computeCratonOldnessField(sim.rafts, worldEpoch(sim.archeanEpochs, sim.epoch), CLIMATE_RES_X, CLIMATE_RES_Y, sim.width, sim.height)
  const eco = computeEcology({
    temperature: climate.temperature,
    precipitation: climate.precipitation,
    biomes: climate.biomes,
    currents: climate.currents,
    elevation: lastRawElevations,
    discharge: hydrology?.discharge ?? null,
    maxDischarge: hydrology?.maxDischarge ?? 0,
    // Liquid water only: a frozen basin is a glacier and feeds no fishery.
    lakeDepth: hydrology ? liquidLakeDepth(hydrology) : null,
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
  // The physical raster beside the display one: the hydrology's levels are
  // set against it, so the shores must be found on it too — the display
  // copy carries the erosion detail texture, which is presentation.
  const raw = lastRawElevations && lastRawElevations.length === elevation.length ? lastRawElevations.slice() : elevation.slice()
  const message: WorkerElevationFieldMessage = {
    type: 'elevationField',
    mesh: meshPayload(),
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
    mesh: meshPayload(),
  }
  const transfers = [worldMessage.mantle, worldMessage.latticeAccumulated, worldMessage.latticeLockedEpochs, worldMessage.latticeLastClassCode, worldMessage.oceanAge, worldMessage.elevation, worldMessage.uplift, worldMessage.erodibility]
  if (worldMessage.mesh) transfers.push(worldMessage.mesh.nodes, worldMessage.mesh.connectivity, worldMessage.mesh.z)
  emit(worldMessage, transfers)
}

function handleRestoreWorld(message: Extract<WorkerInboundMessage, { type: 'restoreWorld' }>): void {
  stopTicking()
  worldGeneration += 1
  dropHandover()
  if (message.archean) {
    sim = null
    archean = deserializeArchean(message.archean.snapshot, new Float32Array(message.archean.mantle), new Int16Array(message.archean.streak))
    archeanSeed = message.seed
    archeanWater = archean.seaLevelOffset
    if (message.mantleDiffusion !== undefined) archeanParams = { ...DEFAULT_ARCHEAN_PARAMS, diffusion: message.mantleDiffusion }
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
  // The mesh the save carries, if it does: the terrain proper, so a save
  // after a load carries it on. The raster above is its rasterisation.
  // The history's terrain from the save (phase 5.1): the mesh with its
  // heights, the baseline from the restored sim, the routing derived. A
  // save without a mesh restores the raster alone; the first epoch then
  // builds the mesh from the synthesis.
  if (message.mesh) {
    coupled = decodeCoupledTerrain(sim, { nodes: new Float32Array(message.mesh.nodes), connectivity: new Uint8Array(message.mesh.connectivity), z: new Float32Array(message.mesh.z), column: message.mesh.column ? new Uint8Array(message.mesh.column) : undefined })
    coupled.routing = meshRouting(coupled.mesh, coupled.z)
    meshTerrain = asMeshTerrain(coupled)
  } else {
    coupled = null
    meshTerrain = null
  }
  meshPayloadCache = null
  lastLakeBasinElevations = null
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
  dropHandover()
  sim = null
  archeanSeed = message.seed
  archeanParams = { ...DEFAULT_ARCHEAN_PARAMS, diffusion: message.mantleDiffusion ?? DEFAULT_ARCHEAN_PARAMS.diffusion }
  archeanWater = message.seaLevelOffset ?? 0
  archeanWidth = message.width
  archeanHeight = message.height
  archean = createArcheanSimulation(message.seed, message.width, message.height, archeanWater)
  lastRawElevations = null
  preErosionElevations = null
  coupled = null
  meshTerrain = null
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
  sim.epochMa = TECTONIC_MA_PER_EPOCH
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
  // The history's terrain starts here: the mesh from the synthesis at the
  // hand-over (phase 5.1), drawn from its rasterisation.
  coupled = createCoupledTerrain(sim, HISTORY_DEFAULTS.budget)
  meshTerrain = null
  void renderTerrain()
}

function resetTectonics(): void {
  // Nothing to go back to on a world that was loaded from a file rather than grown
  // here — the save carries the world as it stood, not the hand-over behind it.
  if (!handoverSnapshot || !handoverOceanAge || !handoverMantle) return
  stopTicking()
  // Fresh copies each time, so a second reset restores the same state as the first
  // rather than whatever the last run left in the buffers.
  sim = deserializePlateSimulation(handoverSnapshot, handoverOceanAge.slice(), handoverMantle.slice())
  sim.epochMa = TECTONIC_MA_PER_EPOCH
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
  // The history's terrain starts here: the mesh from the synthesis at the
  // hand-over (phase 5.1), drawn from its rasterisation.
  coupled = createCoupledTerrain(sim, HISTORY_DEFAULTS.budget)
  meshTerrain = null
  void renderTerrain()
}

function resetGenesis(): void {
  // Nothing to go back to before the first genesisInit — and a 0×0 Archean
  // would hand a 0×0 world to the terrain's synthesis at the finalize.
  if (archeanWidth === 0) return
  stopTicking()
  worldGeneration += 1
  dropHandover()
  sim = null
  archean = createArcheanSimulation(archeanSeed, archeanWidth, archeanHeight, archeanWater)
  lastRawElevations = null
  preErosionElevations = null
  coupled = null
  meshTerrain = null
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
  planetPreview: (m) => { void handlePlanetPreview(m as Extract<WorkerInboundMessage, { type: 'planetPreview' }>) },
  planetSample: (m) => handlePlanetSample(m as Extract<WorkerInboundMessage, { type: 'planetSample' }>),
  tectonicsStart: (m) => handleTectonicsStart(m as Extract<WorkerInboundMessage, { type: 'tectonicsStart' }>),
  tectonicsStop: () => handleTectonicsStop(),
  resetStage: (m) => handleResetStage(m as Extract<WorkerInboundMessage, { type: 'resetStage' }>),
  requestElevationField: () => handleRequestElevationField(),
  climateRun: (m) => handleClimateRun(m as Extract<WorkerInboundMessage, { type: 'climateRun' }>),
  climateRefine: () => handleClimateRefine(),
  hydrologyRun: () => handleHydrologyRun(),
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

// The sample world's terrain and colour render, made once per size; the
// climate on it is recomputed per request (the controls change it).
let sampleWorld: { width: number; height: number; elevation: Float32Array; buffer: Uint8Array; relief: Uint8Array } | null = null

// The elevation the preview runs on when the screen has supplied one (a
// real world, at its own size), else the synthetic sample. Resampled to the
// map at the preview's size, bilinear in world coordinates.
let planetSample: { width: number; height: number; elevation: Float32Array } | null = null
function handlePlanetSample(message: Extract<WorkerInboundMessage, { type: 'planetSample' }>): void {
  planetSample = { width: message.width, height: message.height, elevation: new Float32Array(message.elevation) }
  sampleWorld = null
}
function previewElevation(width: number, height: number): Float32Array {
  if (!planetSample) return sampleWorldElevation(width, height)
  const out = new Float32Array(width * height)
  const { elevation, width: sw, height: sh } = planetSample
  for (let y = 0; y < height; y++) {
    const wy = ((y + 0.5) / height) * sh
    for (let x = 0; x < width; x++) out[y * width + x] = sampleBilinearWorld(elevation, sw, sh, ((x + 0.5) / width) * sw, wy, sw, sh)
  }
  return out
}

async function handlePlanetPreview(message: Extract<WorkerInboundMessage, { type: 'planetPreview' }>): Promise<void> {
  const { width, height } = message
  if (!sampleWorld || sampleWorld.width !== width || sampleWorld.height !== height) {
    const elevation = previewElevation(width, height)
    const rendered = await renderSimulationImage(
      { width, height, seeds: [], rafts: [], features: [], oceanAge: EMPTY_OCEAN_AGE, warpSeed: 0, seaLevelOffset: 0, mantle: new Float32Array(MANTLE_RES_X * MANTLE_RES_Y) },
      renderPool(),
      { precomputedElevations: elevation },
    )
    sampleWorld = { width, height, elevation, buffer: rendered.buffer, relief: rendered.relief }
  }
  const params: ClimateParams = message.weather ?? defaultWeatherParams()
  const chain = computeClimateChain(sampleWorld.elevation, width, height, params)
  const preview: WorkerPlanetPreviewDataMessage = {
    type: 'planetPreviewData',
    width,
    height,
    buffer: sampleWorld.buffer.slice().buffer as ArrayBuffer,
    relief: sampleWorld.relief.slice().buffer as ArrayBuffer,
    resX: CLIMATE_RES_X,
    resY: CLIMATE_RES_Y,
    temperature: chain.temperature.buffer as ArrayBuffer,
    wind: chain.wind.buffer as ArrayBuffer,
    currents: chain.currents.buffer as ArrayBuffer,
    currentAnomaly: chain.currentAnomaly.buffer as ArrayBuffer,
    precipitation: chain.seasonal.annual.buffer as ArrayBuffer,
    seasonalAmplitude: chain.seasonalAmplitude.buffer as ArrayBuffer,
    monsoonIndex: chain.seasonal.index.buffer as ArrayBuffer,
    koppen: chain.koppen.buffer as ArrayBuffer,
    biomes: chain.biomesFine.buffer as ArrayBuffer,
  }
  emit(preview, [preview.buffer, preview.relief, preview.temperature, preview.wind, preview.currents, preview.currentAnomaly, preview.precipitation, preview.seasonalAmplitude, preview.monsoonIndex, preview.koppen, preview.biomes])
}

export function dispatch(message: WorkerInboundMessage): void {
  HANDLERS[message.type](message)
}
