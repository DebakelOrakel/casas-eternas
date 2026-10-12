import { serializePlateSimulation, deserializePlateSimulation } from '../tectonics/plateSimulation'
import { domainOfKind, type Domain, type DomainGrid } from '../core/domain'
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
import { landBilinearAtNodes, nearestCellAtNodes, rasteriseNodeField, rasteriseNodePart, triangleRaster, type TriangleRaster } from '../mesh/meshRaster'
import { Biome, classifyPoints } from '../climate/biomes'
import { SURFACE_TUNING } from '../surface/surfaceTuneParams'
import { computeHydrogeology } from '../surface/hydrogeology'
import { coverField } from '../surface/cover'
import { DEFAULT_PLANET_FORCING } from '../planet/planetForcing'
import { climateAtPoints, climateCellsFromRefined, climateCellsFromWeather, climateCellValues, meanLandRunoff, meshPoints, type ClimateCells, type ClimatePoints, type PointClimate } from '../climate/climatePoints'
import { chartLand, chartLandField, refinedChart, weatherChart } from '../climate/climateChart'
import { OCEAN_PRECIP } from '../climate/precipitation'
import { computeIceOnMesh } from '../surface/glacial'
import type { PeriodicTriangulation } from '../mesh/periodicDelaunay'
import { TECTONICS_INPUTS } from '../tectonics/tectonicsInputParams'
import { encodeMesh } from '../mesh/meshSerial'
import { meshRouting, meshSubstrate, waterFieldsFromMesh } from '../mesh/meshHydrology'
import { replayRuns } from './replayRuns'

import type { ClimatePayload, FieldPayload, LandPayload, MeshPayload } from './messages'
import { coarseForcingFields } from './erosionForcing'
import type { ArcheanSimulation } from '../archean/archeanState'
import { createArcheanSimulation } from '../archean/archeanState'
import { deserializeArchean, serializeArchean } from '../archean/archeanSnapshot'
import type { ArcheanParams } from '../archean/archeanStep'
import { archeanStep, DEFAULT_ARCHEAN_PARAMS } from '../archean/archeanStep'
import { finalizeArchean } from '../archean/finalizeArchean'
import { findPlumeSites } from '../tectonics/plumes'
import { stabilisedFraction } from '../crust/raftField'
import { TECTONIC_MA_PER_EPOCH, worldAgeMa, worldEpoch } from '../core/worldTime'
import { createOceanAgeField, savedOceanAge } from '../tectonics/oceanAge'
import type { SavedField } from '../fields/fieldMesh'
import { accumulateDischargeOn, computeLakesOn, watershedsOn, maxDischargeOverLand, densityToCriticalArea, channelThreshold, CANONICAL_RIVER_DENSITY, accumulateRegimeInputsOn, riparianPrecipitationOn, dischargeToM3s, SURFACE_ICE, type RiverPolylines } from '../surface/hydrology'
import type { LakeFields } from '../surface/hydrology'
import { MANTLE_RES_X, MANTLE_RES_Y, mantleMesh, rasteriseMantle, savedMantle } from '../mantle/mantleField'
import type { TerrainFeature } from '../tectonics/terrainFeatures'
import { computeWeather, defaultWeatherParams, type WeatherParams } from '../climate/weather'
import { climateTerrain, type ClimateTerrain } from '../climate/climateMesh'

import { annualFromMonths, refineClimate, refinedAnnualWind, refinementFits, type RefinedClimate } from '../climate/refinement'
import type { CellVectors } from '../climate/wind'
import { SEA_LEVEL, metersToElevation } from '../elevation/elevationScale'
import type { WaterBody } from '../surface/hydrology'
import { buildRiverGraph, riverPolylinesFromGraph, serializeRiverGraph } from '../surface/riverGraph'
import { computeRiverCourses } from '../surface/riverCourse'
import { buildCoastGraph, type CoastGraph } from '../surface/coastGraph'
import { findSedimentBasins, type SedimentBasin } from '../surface/sedimentBasins'

import type { RiverGraph } from '../surface/riverGraph'
import { CLIMATE_RES_X, CLIMATE_RES_Y, sampleElevationAtCell } from '../climate/climateField'
import { applyEcology, ecologyFine, ecologyMonth, ecologyRasters, encodeFineField, isSeasonalEcologyField, prepareEcology, type EcologyBase, type EcologyFieldId, type EcologyParams } from '../ecology/ecologyField'
import { computeMigration } from '../migration/migrationField'
import { collectVolcanoes } from '../tectonics/volcanoes'
import { computeCratonOldnessField } from '../crust/raftField'
import type { WorkerStageDeclinedMessage, WorkerStageFailedMessage, WorkerGenesisStatusMessage, WorkerClimateDataMessage, WorkerClimateRefinedMessage, WorkerClimateRefineProgressMessage, WorkerEcologyDataMessage, WorkerEcologyMonthDataMessage, WorkerElevationFieldMessage, WorkerHydrologyDataMessage, WorkerInboundMessage, WorkerMigrationDataMessage, WorkerRenderedMessage, WorkerWorldDataMessage, WorkerPlanetPreviewDataMessage } from './messages'

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
// The Archean's tuning, held here because archeanStep needs it every step and a
// reset has to rebuild the same world. Only `diffusion` is user-facing.
let archeanParams: ArcheanParams = DEFAULT_ARCHEAN_PARAMS
let archeanWater = 0
let archeanWidth = 0
let archeanHeight = 0
// The shape the Archean was made on (genesisInit), for a reset to make it
// on again.
let archeanShape: Domain['kind'] = 'torus'
let renderOptions: RenderSimulationOptions = {}
// The Archean's pace (genesisInit): the shortest time from one step's
// start to the next's, so its crust animates at a steady tempo.
let epochIntervalMs = 400
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
  // The climate per cell of its field mesh as every reader samples it
  // (climate/climatePoints.ClimateCells, DEC-0036 phase 7): the static
  // climate's, or the climate step's refinement's (with its months, its
  // upwelling and its rain's reliability).
  cells: ClimateCells
  // The terrain it was computed on (its cells' land; the chart's).
  terrain: ClimateTerrain
  // The same climate per cell of its field mesh as the step's refinement
  // starts from (refinement.refineClimate): the annual temperature and wind.
  mesh: { temperature: Float64Array; wind: CellVectors }
  // Set when this is the climate step's refinement (handleClimateRefine).
  // The hydrology's own climate pass (the dry-basin v2) leaves such a
  // climate alone.
  refined: boolean
  // The climate at the terrain mesh's nodes and the biomes and Köppen
  // classes it gives there before the hydrology (DEC-0036 phase 7, fork 2:
  // the land fields on the adaptive terrain mesh) — what the hydrology,
  // the ecology and the save read.
  land: LandClimate
}
let climate: ClimateResult | null = null

// A climate at the nodes of one terrain mesh (the coupled terrain's, the
// arrays it had then).
interface LandClimate {
  mesh: PeriodicTriangulation
  z: Float32Array
  points: ClimatePoints
  climate: PointClimate
  biome: Uint8Array
  koppen: Uint8Array
}

// Rivers and lakes. Routing and discharge are the expensive parts, so a
// density-only re-request reuses this and just re-thresholds the channels; the
// object being absent IS "re-route needed", which is what `hydrologyDirty` used
// to say alongside two null checks that could disagree with it.
interface HydrologyResult {
  // The lakes' raster recovery (meshHydrology.waterFieldsFromMesh): what
  // the map's water shader and the save's lakeDepth layer read.
  lakeDepth: Float32Array
  // Terminal basins' exposed floor (computeLakes' LakeFields.saltFlat) on the
  // world raster — the terrain render's salt band.
  saltFlat: Uint8Array | null
  dryBasin: Uint8Array | null
  // Permanently frozen basins on the world raster.
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
  // The coast reaches (surface/coastGraph.ts) on the terrain mesh's shore
  // nodes, built with the graph.
  coast: CoastGraph | null
  // The erosion pass's deposits as features (surface/sedimentBasins.ts) on
  // the terrain mesh's nodes, with provenance from the graph's catchments;
  // empty for a world whose last epoch's start is not known (a loaded save).
  sedimentBasins: SedimentBasin[]
  // Ice thickness in metres on the world raster — the history's last
  // epoch's ice, or the steady state the climate gives (phase 6).
  ice: Float32Array | null
  // The springs in an arid climate (phase 5a's oases), world coordinates —
  // the ecology waters their fields.
  oases: { x: number; y: number }[]
  // The mesh's own hydrology: the discharge and the lakes per node, the
  // climate at the nodes it ran under, the land fields per node. Since
  // DEC-0036 phase 7b the only hydrology: no routing on the world raster.
  onMesh: MeshHydrology
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
// The ecology's physics (prepareEcology) and what it was computed from.
let ecologyBase: { key: { climate: unknown; hydrology: unknown; elevation: unknown; sim: unknown; epoch: number }; base: EcologyBase; pixelLand: Uint8Array } | null = null
// The sliders of the last ecology run, which a month's field is scaled by.
let ecologyParams: EcologyParams | null = null

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

// The coupled terrain as what the hydrology reads (a routing is required
// there): the same arrays, once an epoch or a restore has routed it.
function asMeshTerrain(c: CoupledTerrain): MeshTerrain | null {
  return c.routing ? { mesh: c.mesh, z: c.z, routing: c.routing, areas: c.areas, sedimentFlux: c.sedimentFlux } : null
}

// The terrain's rasterisation, rendered and posted: what every consumer
// that still walks cells reads, and the map's texture. The climate runs on
// the current terrain (there is no pre-erosion terrain any more); the
// sediment basins read the last epoch's start on the mesh
// (CoupledTerrain.preErosionZ).
async function renderTerrain(intermediate = false): Promise<void> {
  if (!sim || !coupled) return
  const elevations = rasteriseNodeField(coupled.mesh, coupled.z, sim.width, sim.height)
  await renderAndPost(elevations, intermediate, 1)
  preErosionElevations = null
  lastLakeBasinElevations = elevations.slice()
  meshPayloadCache = null
}
// The mesh terrain's bytes for the screen and the save, encoded once per
// terrain (a second's work on a million nodes) and reused — for the heights
// they were encoded from (`z`): every epoch makes a new array, so a save
// between two pictures (the history draws every renderEvery-th epoch)
// encodes the epoch it is at, not the last one drawn (2026-10-12).
let meshPayloadCache: (MeshPayload & { z0: Float32Array }) | null = null

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
      ecologyBase = null
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

// A stage's compute threw: said to the screen (WorkerStageFailedMessage),
// which releases what waits for it, and logged here with its stack.
function fail(stage: StageId, error: unknown): void {
  console.error(`[generator] the ${stage} stage failed`, error)
  const message: WorkerStageFailedMessage = { type: 'stageFailed', stage, error: error instanceof Error ? error.message : String(error) }
  emit(message)
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
// Renders are async (they await the pool). A render in flight reads the
// world (sim.seeds/features) across its awaits, so nothing may step the
// world under it: the step loop takes this flag for a step and its render,
// and a step that finds it taken waits (BUSY_RETRY_MS). The simulation
// paces itself to what the render pool can keep up with, rather than
// risking a torn read.
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
    // The field on its chart raster (a fresh array, so transferable).
    mantle: rasteriseMantle(sim.mantle, sim.domain).buffer as ArrayBuffer,
    mantleResX: MANTLE_RES_X,
    mantleResY: MANTLE_RES_Y,
    cratonAge: computeCratonOldnessField(sim.rafts, worldEpoch(sim.archeanEpochs, sim.epoch), MANTLE_RES_X, MANTLE_RES_Y, sim.domain).buffer as ArrayBuffer,
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
// The last Archean status sent, for the hand-over's own (handleGenesisFinalize).
let lastGenesisStatus: WorkerGenesisStatusMessage | null = null

async function renderArcheanAndPost(elevationScale = 1): Promise<void> {
  if (!archean) return
  const gen = worldGeneration
  renderOptions.precomputedElevations = undefined
  renderOptions.elevationScale = elevationScale
  const result = await renderSimulationImage(
    // No seeds, so no plate Voronoi: the Archean has no plates. No ocean age
    // either (nothing creates or destroys seafloor yet): null reads as
    // freshly formed crust everywhere, the right answer for a world whose
    // entire seafloor is being recycled continuously. A paused
    // render used to place the seeds finalizeArchean would, as a preview of
    // the plates to come — but the genesis step offers no plate outlines
    // (steps.ts), so nothing showed it, and the Voronoi over the whole map
    // cost ~1.4 s a pause on the sphere (removed 2026-10-10). Seeds only
    // drive the Voronoi mask; the elevation reads rafts, ocean age and
    // features, so this changes no terrain.
    { width: archean.width, height: archean.height, domain: archean.domain, seeds: [], rafts: archean.rafts, features: [], oceanAge: null, warpSeed: archean.warpSeed, seaLevelOffset: archean.seaLevelOffset, mantle: archean.mantle },
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
    mantle: rasteriseMantle(archean.mantle, archean.domain).buffer as ArrayBuffer,
    mantleResX: MANTLE_RES_X,
    mantleResY: MANTLE_RES_Y,
    cratonAge: computeCratonOldnessField(archean.rafts, archean.epoch, MANTLE_RES_X, MANTLE_RES_Y, archean.domain).buffer as ArrayBuffer,
    elevation: coarseElevation(result.elevations, archean.width, archean.height).buffer as ArrayBuffer,
    elevationResX: CLIMATE_RES_X,
    elevationResY: CLIMATE_RES_Y,
    // The Archean has plumes too — the same persistent upwellings crustNucleation
    // reads to decide where crust appears. Showing them costs nothing new: the phase
    // already computes them, and seeing WHERE crust is about to form is the point.
    hotspots: findPlumeSites(archean.mantle, archean.domain),
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

  const status: WorkerGenesisStatusMessage = lastGenesisStatus = {
    type: 'genesisStatus',
    epoch: archean.epoch,
    worldAgeMa: worldAgeMa(archean.epoch, 0),
    crustFraction: result.landFraction,
    stabilisedFraction: stabilisedFraction(archean.rafts, archean.epoch, DEFAULT_ARCHEAN_PARAMS.stabilisationEpochs),
    cratonCount: archean.rafts.length,
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

// The mesh payload, encoded once per terrain. A COPY per request: the
// buffers are transferred to the screen, and a transferred buffer is gone.
function meshPayload(): MeshPayload | undefined {
  if (!meshTerrain) return undefined
  if (!meshPayloadCache || meshPayloadCache.z0 !== meshTerrain.z) meshPayloadCache = { ...serializeMeshTerrain(meshTerrain), z0: meshTerrain.z }
  const c = meshPayloadCache
  return { count: c.count, nodes: c.nodes.slice(0), connectivity: c.connectivity.slice(0), z: c.z.slice(0), column: c.column?.slice(0), sedimentFlux: c.sedimentFlux?.slice(0), preErosionZ: c.preErosionZ?.slice(0), ice: c.ice?.slice(0) }
}

// The terrain mesh for the save: the routed terrain's (meshPayload), or —
// before anything routed it (the hand-over, a reset) — the coupled
// terrain the next epoch starts from, so every tectonic save carries the
// terrain its elevation is the rasterisation of (DEC-0036, the save step).
// Not cached: a save before the first epoch is rare and the encoding a
// second's work.
function savedMeshPayload(): MeshPayload | undefined {
  const routed = meshPayload()
  if (routed || !coupled) return routed
  return serializeMeshTerrain(coupled)
}

// The mesh terrain as the save's bytes (mesh/meshSerial.ts). The mesh is
// canonical already, so the identity numbering is the Hilbert one.
function serializeMeshTerrain(terrain: Pick<MeshTerrain, 'mesh' | 'z' | 'sedimentFlux'>): MeshPayload {
  const order = new Int32Array(terrain.mesh.aliveVertices)
  for (let i = 0; i < order.length; i++) order[i] = i
  const serial = encodeMesh(terrain.mesh, order)
  const z = terrain.z.slice(0, serial.count)
  // The column rides along when the terrain is the coupled one (it always
  // is once an epoch has run — the hydrology's view of it is `terrain`).
  const own = coupled && coupled.mesh === terrain.mesh ? coupled : null
  const column = own ? encodeColumn(own.column, serial.count) : undefined
  // What the last epoch left, which the hydrology reads and a load cannot
  // derive (decodeCoupledTerrain): the flux (zeros before the first epoch,
  // which the river graph reads as it reads none), the heights its erosion
  // started from, and the ice the plate carries (none before the first).
  const perNode = (values: Float32Array | undefined, fallback: () => Float32Array): ArrayBuffer =>
    (values && values.length >= serial.count ? values.slice(0, serial.count) : fallback()).buffer as ArrayBuffer
  const sedimentFlux = perNode(terrain.sedimentFlux, () => new Float32Array(serial.count))
  const preErosionZ = perNode(own?.preErosionZ, () => z.slice())
  const ice = own && own.ice.length >= serial.count ? own.ice.slice(0, serial.count).buffer as ArrayBuffer : undefined
  return { count: serial.count, nodes: serial.nodes.buffer as ArrayBuffer, connectivity: serial.connectivity.buffer as ArrayBuffer, z: z.buffer as ArrayBuffer, column: column ? column.buffer as ArrayBuffer : undefined, sedimentFlux, preErosionZ, ice }
}


// THE HYDROLOGY ON THE MESH (phase 4.3): the lakes and the discharge over
// the mesh's own routing under the climate at its nodes (DEC-0036 phase
// 7), and the raster fields the map and the save's rasters read,
// rasterised from the nodes' bodies (meshHydrology.waterFieldsFromMesh) —
// one truth, the bodies, two representations.
interface MeshHydrology {
  discharge: Float32Array
  lakes: LakeFields
  // The climate at the nodes it ran under (a terminal basin's dry floor is
  // land there).
  land: LandClimate
  // Per node, once the pass has run: the map's biome (the riparian
  // corridors, the salt flats, the frozen lakes and the glaciers), the
  // ecology's (the same without the glaciers' ice: a glacier is the ice
  // with a thickness, the ground under it keeps its class) and the water
  // table's depth (metres, −1 under water).
  biome: Uint8Array | null
  ecologyBiome: Uint8Array | null
  waterTable: Float32Array | null
  // The raster recovery of the bodies.
  raster: { depth: Float32Array; saltFlat: Uint8Array; dryBasin: Uint8Array; frozen: Uint8Array; level: Float32Array; body: Int32Array; surface: Uint8Array }
}

function hydrologyOnMesh(terrain: MeshTerrain, elevationRaster: Float32Array, width: number, height: number, land: LandClimate): MeshHydrology {
  const sub = meshSubstrate(terrain.mesh, terrain.routing, terrain.areas)
  const discharge = accumulateDischargeOn(sub, terrain.z, land.climate.precipitation, land.climate.temperature)
  const lakes = computeLakesOn(sub, discharge, terrain.z, land.climate.temperature)
  return { discharge, lakes, land, biome: null, ecologyBiome: null, waterTable: null, raster: waterFieldsFromMesh(terrain.mesh, lakes.body, lakes.bodies, elevationRaster, width, height) }
}

// The terrain mesh the land fields sit on (DEC-0036 fork 2): the coupled
// terrain, routed. A world without one yet — restored from a save made
// before its first epoch — gets the one that epoch would build from the
// synthesis (createCoupledTerrain is a function of the plates alone, so
// the epoch then starts from the same mesh); its routing is derived, which
// no epoch reads.
function landTerrain(): MeshTerrain | null {
  if (!sim) return null
  if (!coupled) coupled = createCoupledTerrain(sim, HISTORY_DEFAULTS.budget)
  if (!coupled.routing) {
    coupled.routing = meshRouting(coupled.mesh, coupled.z)
    meshPayloadCache = null
  }
  meshTerrain = asMeshTerrain(coupled)
  return meshTerrain
}

// The climate at a terrain's nodes and its biomes there. `dry`: the
// terminal basins' dry floors per node (land below the sea), or null.
function landClimateOf(cells: ClimateCells, terrain: { mesh: PeriodicTriangulation; z: Float32Array }, dry: Uint8Array | null = null): LandClimate {
  const points = meshPoints(terrain.mesh, terrain.z, dry)
  const atNodes = climateAtPoints(cells, points)
  const { biome, koppen } = classifyPoints(atNodes, points, terrain.mesh.domain)
  return { mesh: terrain.mesh, z: terrain.z, points, climate: atNodes, biome, koppen }
}

// The world raster's land for the land fields' rasters: above the sea, or
// a terminal basin's dry floor (null: none).
function pixelLandOf(elevation: Float32Array, dryBasin: Uint8Array | null): Uint8Array {
  const out = new Uint8Array(elevation.length)
  for (let i = 0; i < out.length; i++) if (elevation[i] > SEA_LEVEL || (dryBasin !== null && dryBasin[i] === 1)) out[i] = 1
  return out
}

// Where each pixel of the world raster lies on the terrain mesh
// (meshRaster.triangleRaster), found once per mesh and kept: every land
// field drawn from the nodes (the biomes, the classes, the riparian rain,
// the ecology's fourteen) reads it — a locate per pixel is ~0.4 s at 2048.
let pixelTriangles: TriangleRaster | null = null
function trianglesOf(mesh: PeriodicTriangulation, width: number, height: number): TriangleRaster {
  if (!pixelTriangles || pixelTriangles.mesh !== mesh || pixelTriangles.width !== width || pixelTriangles.height !== height) pixelTriangles = triangleRaster(mesh, width, height)
  return pixelTriangles
}

// A node field of the land on the world raster (rasteriseNodePart over
// the land's nodes and pixels).
function landRaster(land: LandClimate, field: ArrayLike<number>, pixelLand: Uint8Array, width: number, height: number, outside: number, nearest: boolean): Float32Array {
  return rasteriseNodePart(land.mesh, field, land.points.land, pixelLand, outside, width, height, nearest, undefined, trianglesOf(land.mesh, width, height))
}

// A biome or a Köppen class per node on the world raster: a land pixel
// the heaviest land corner's id, the sea Ocean / 0.
function idRaster(land: LandClimate, ids: Uint8Array, pixelLand: Uint8Array, width: number, height: number, sea: number): Uint8Array {
  return Uint8Array.from(landRaster(land, ids, pixelLand, width, height, sea, true))
}

// The coast type per shore node (coastGraph.CoastGraph.type) on the world
// raster for the water shader: the raster's own shore pixels (a land pixel
// with a sea pixel among its eight neighbours — the drawn coastline) take
// the heaviest shore corner of their triangle, every other pixel 0.
function coastTypeRaster(mesh: PeriodicTriangulation, nodeType: Uint8Array, elevation: Float32Array, grid: DomainGrid): Uint8Array {
  const { resX: width, resY: height } = grid
  const shorePixel = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x
      if (elevation[p] <= SEA_LEVEL) continue
      for (let dy = -1; dy <= 1 && !shorePixel[p]; dy++) for (let dx = -1; dx <= 1; dx++) if (elevation[grid.neighbour(x, y, dx, dy)] <= SEA_LEVEL) { shorePixel[p] = 1; break }
    }
  }
  const typed = new Uint8Array(mesh.vertexSlots)
  for (let v = 0; v < typed.length; v++) if (nodeType[v] > 0) typed[v] = 1
  return Uint8Array.from(rasteriseNodePart(mesh, nodeType, typed, shorePixel, 0, width, height, true, undefined, trianglesOf(mesh, width, height)))
}

// The largest of a node field over the land nodes in each cell of the
// climate's chart (256 × 128) — the migration's river corridors, which run
// on the chart (0 where no land node lies).
function chartMaxOfNodes(mesh: PeriodicTriangulation, field: Float32Array, z: Float32Array): Float32Array {
  const grid = mesh.domain.grid(CLIMATE_RES_X, CLIMATE_RES_Y)
  const out = new Float32Array(CLIMATE_RES_X * CLIMATE_RES_Y)
  for (let v = 0; v < mesh.vertexSlots; v++) {
    if (!mesh.vAlive[v] || z[v] <= SEA_LEVEL) continue
    const c = grid.cellAt(mesh.vx[v], mesh.vy[v])
    if (field[v] > out[c]) out[c] = field[v]
  }
  return out
}

// THE STEP LOOP: one for both eras, the Archean's steps and the
// tectonics' epochs. A step runs; when it and its render are done, exactly
// one next step is scheduled, `minIntervalMs` after the last one STARTED
// (0: back to back). There is one pending timer at most, and a stop clears
// it: nothing starts after the stop is handled. A step in flight at the stop
// finishes and posts the SETTLED picture.
//
// It replaces a setInterval plus a zero-delay "seamless" tick per epoch
// that outlasted the interval (2026-09-26). An epoch does not yield in a
// process without a render pool, so every interval beat ran one, and each
// late epoch queued one more tick: the timer chains grew and never died
// (6 after 22 epochs), and a stop waited behind them (2026-10-11).
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
      // stop came before its render; a stop during the render (an awaiting
      // pool) left an intermediate one, and a failure none.
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
// wiring in their own right — the climate branch alone encodes the order
// temperature → wind → currents → precipitation → biomes, which is real domain
// knowledge that was invisible inside a chain of `else if`s.


function handleTectonicsStart(message: Extract<WorkerInboundMessage, { type: 'tectonicsStart' }>): void {
  if (loop) return
  // No plates yet: the Archean has not been handed over. Said out loud rather
  // than started anyway.
  if (!sim) { decline('tectonics', 'genesis'); return }
  historyControls = {
    alluvium: message.alluvium ?? TECTONICS_INPUTS.alluvium.default,
    rockContrast: message.rockContrast ?? TECTONICS_INPUTS.rockContrast.default,
    weather: message.weather ?? defaultWeatherParams(),
  }
  sim.epochMa = TECTONIC_MA_PER_EPOCH
  // THE COUPLED EPOCH (phase 5.1): the plates move, the mesh follows,
  // erosion runs inside the epoch, the terrain is rasterised and drawn. An
  // epoch takes what it takes; the epochs run back to back (minimum 0). The
  // first epoch starts with the gesture: a start followed by a stop is then
  // exactly one epoch, which is what the pipeline harness's determinism
  // check builds its two worlds with.
  epochsSinceRender = HISTORY_DEFAULTS.renderEvery
  startLoop('tectonics', 0, 0, async (l) => {
    const currentSim = sim
    if (!currentSim) return false
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
    // The world was replaced while the epoch ran: its result describes
    // nothing that is still here.
    if (l.ended === 'drop') return false
    // Events are forwarded to the main thread (batched with the next
    // render), which owns their notifications + faded map markers now.
    pendingEvents.push(...stats.events)
    meshTerrain = asMeshTerrain(coupled)
    // Intermediate while the loop still runs, and only every
    // HISTORY_DEFAULTS.renderEvery-th epoch (the first always): the next
    // picture replaces this one. The epoch that finishes after the stop
    // is the settled one — drawn whatever the count, the screen then
    // pulls the elevation field and runs the chain.
    epochsSinceRender++
    const running = loop === l
    if (!running || epochsSinceRender >= HISTORY_DEFAULTS.renderEvery) {
      epochsSinceRender = 0
      await renderTerrain(running)
    }
    return !running
  }, () => renderTerrain(false))
}

function handleTectonicsStop(): void {
  // The settled render: the last epoch's, if one is still in flight (the
  // loop settles it), otherwise the terrain as it stands, once more. NOT a
  // render from the synthesis — that would replace the history's terrain
  // with the fields'.
  if (stopLoop('stop')?.inFlight) return
  if (sim && coupled && !renderInFlight) {
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
// amplitude → monsoon/precipitation — on the climate's field mesh
// (climate/weather.computeWeather, shared with the history's epochs, so the
// panel's overlays and the carved valleys can never disagree about what
// the climate IS). `dryLand` is the terminal-basin dry-floor override
// (LakeFields.dryBasin): those sub-sea cells count as land throughout,
// with an unclamped downward lapse (see computeTemperature). `domain`:
// what the elevation raster covers, one cell per unit. The cells every
// reader samples (climatePoints.climateCellsFromWeather) and the chart the
// screen paints (climateChart.weatherChart) come with it.
function computeClimateChain(elevation: Float32Array, domain: Domain, params: ClimateParams, dryLand?: Uint8Array) {
  const { width, height } = domain
  const weather = computeWeather(climateTerrain(domain, elevation, width, height, dryLand), params)
  const { cm } = weather.terrain
  return {
    weather,
    cells: climateCellsFromWeather(weather),
    chart: weatherChart(weather),
    windMesh: meshVectorPayload(cm.cellM, weather.mesh.wind),
    currentsMesh: meshVectorPayload(cm.cellM, weather.mesh.currents),
  }
}

// A vector field on the climate's field mesh for the screen's marks — the
// wind (DEC-0036 phase 3), the currents (phase 4), the refinement's
// (phase 5), WorkerClimateDataMessage.windMesh and .currentsMesh: copies
// in Float64, transferred.
function meshVectorPayload(spacingM: number, field: { e: ArrayLike<number>; s: ArrayLike<number> }): { cells: number; spacingM: number; e: ArrayBuffer; s: ArrayBuffer } {
  return { cells: field.e.length, spacingM, e: Float64Array.from(field.e).buffer as ArrayBuffer, s: Float64Array.from(field.s).buffer as ArrayBuffer }
}

// The climate the chain made, at the nodes of `land`'s terrain.
function climateResultOf(chain: ReturnType<typeof computeClimateChain>, params: ClimateParams, land: LandClimate): ClimateResult {
  return { params, cells: chain.cells, terrain: chain.weather.terrain, mesh: { temperature: chain.weather.mesh.temperature, wind: chain.weather.mesh.wind }, refined: false, land }
}

// The screen's climate (WorkerClimateDataMessage): the chart's fields, the
// marks' vectors on the mesh, and the biomes and the Köppen classes per
// pixel of the world raster from the nodes (`pixelLand`, the raster's
// land). Fresh arrays, transferred.
function postClimate(
  fields: { temperature: Float32Array; wind: Float32Array; currents: Float32Array; currentAnomaly: Float32Array; precipitation: Float32Array; seasonalAmplitude: Float32Array; monsoonIndex: Float32Array },
  windMesh: WorkerClimateDataMessage['windMesh'], currentsMesh: WorkerClimateDataMessage['currentsMesh'],
  land: LandClimate, pixelLand: Uint8Array, width: number, height: number, flags: { refinement?: boolean; refined?: boolean },
): void {
  const message: WorkerClimateDataMessage = {
    type: 'climateData',
    ...flags,
    resX: CLIMATE_RES_X,
    resY: CLIMATE_RES_Y,
    temperature: fields.temperature.slice().buffer as ArrayBuffer,
    wind: fields.wind.slice().buffer as ArrayBuffer,
    windMesh,
    currentsMesh,
    currents: fields.currents.slice().buffer as ArrayBuffer,
    currentAnomaly: fields.currentAnomaly.slice().buffer as ArrayBuffer,
    precipitation: fields.precipitation.slice().buffer as ArrayBuffer,
    seasonalAmplitude: fields.seasonalAmplitude.slice().buffer as ArrayBuffer,
    monsoonIndex: fields.monsoonIndex.slice().buffer as ArrayBuffer,
    koppen: idRaster(land, land.koppen, pixelLand, width, height, 0).buffer as ArrayBuffer,
    biomes: idRaster(land, land.biome, pixelLand, width, height, Biome.Ocean).buffer as ArrayBuffer,
  }
  emit(message, [message.temperature, message.wind, windMesh.e, windMesh.s, currentsMesh.e, currentsMesh.s, message.currents, message.currentAnomaly, message.precipitation, message.seasonalAmplitude, message.monsoonIndex, message.koppen, message.biomes])
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
  const terrain = landTerrain()
  if (!sim || !elevation || !terrain) { decline('climate', 'tectonics'); return }
  const params: ClimateParams = {
    temperatureOffset: message.temperatureOffset,
    temperatureContrast: message.temperatureContrast,
    humidity: message.humidity,
    equatorOffset: message.equatorOffset,
    planet: message.planet,
  }
  const chain = computeClimateChain(elevation, sim.domain, params)
  climate = climateResultOf(chain, params, landClimateOf(chain.cells, terrain))
  postClimate(chain.chart, chain.windMesh, chain.currentsMesh, climate.land, pixelLandOf(elevation, null), sim.width, sim.height, {})
  invalidateAfter('climate')
}

// The climate step's refinement (climate/refinement.ts), on the climate the
// step shows and the terrain it was computed on. It runs on the climate's
// field mesh (DEC-0036 phase 5); its values per cell go to the screen,
// which keeps them for the save, its cells (climatePoints.
// climateCellsFromRefined) feed the biomes and everything downstream here,
// and its chart (climateChart.refinedChart) the screen's textures.
function handleClimateRefine(message: Extract<WorkerInboundMessage, { type: 'climateRefine' }>): void {
  const elevation = preErosionElevations ?? lastRawElevations
  const terrain = landTerrain()
  if (!sim || !elevation || !terrain) { decline('climate', 'tectonics'); return }
  if (!climate) { decline('climate', 'climate'); return }
  const { width, height, domain } = sim
  // A save's refinement is taken as it is — its values belong to this
  // world's climate mesh, or it is no refinement of it; otherwise it is
  // computed.
  const restored = message.restored
  if (restored && !refinementFits(domain, restored.cells, restored.spacingM)) throw new Error('the saved refinement belongs to another climate mesh')
  const r: RefinedClimate = restored ?? refineClimate(elevation, domain, climate.params, climate.mesh.temperature, climate.mesh.wind, (share) => {
    const progress: WorkerClimateRefineProgressMessage = { type: 'climateRefineProgress', share: share * 0.85 }
    emit(progress)
  })
  const refinedTerrain = climateTerrain(domain, elevation, width, height)
  const chart = refinedChart(r, refinedTerrain)
  const cells = climateCellsFromRefined(r, refinedTerrain)

  // The refined climate takes the history's place (build step 5b): its
  // annual fields derived from the months, its biomes classified from them.
  // Everything downstream is then stale — the rivers run on the new rain.
  const n = CLIMATE_RES_X * CLIMATE_RES_Y
  const annual = annualFromMonths(chart, n)
  const annualWind = new Float32Array(n * 2)
  for (let m = 0; m < chart.months; m++) for (let i = 0; i < n * 2; i++) annualWind[i] += chart.wind[m * n * 2 + i] / chart.months
  const meshWind = refinedAnnualWind(r)
  const meshAnnual = annualFromMonths(r, r.cells)
  const land = landClimateOf(cells, terrain)
  climate = {
    params: climate.params,
    cells,
    terrain: refinedTerrain,
    mesh: { temperature: Float64Array.from(meshAnnual.temperature), wind: meshWind },
    refined: true,
    land,
  }
  const pixelLand = pixelLandOf(elevation, null)

  // The values per cell, copied: the screen keeps them (the save's), the
  // worker its own.
  const values: RefinedClimate = structuredCopy(r)
  const reply: WorkerClimateRefinedMessage = {
    type: 'climateRefined',
    resX: CLIMATE_RES_X,
    resY: CLIMATE_RES_Y,
    months: chart.months,
    refined: values,
    temperature: chart.temperature.slice().buffer as ArrayBuffer,
    precipitation: chart.precipitation.slice().buffer as ArrayBuffer,
    koppen: idRaster(land, land.koppen, pixelLand, width, height, 0).buffer as ArrayBuffer,
    fog: chart.fog.buffer as ArrayBuffer,
    foehn: chart.foehn.buffer as ArrayBuffer,
    rainVariability: chart.reliability.rainVariability.buffer as ArrayBuffer,
    ensoPattern: chart.reliability.ensoPattern.buffer as ArrayBuffer,
    ensoPeriodYears: chart.reliability.ensoPeriodYears,
    ensoStrength: chart.reliability.ensoStrength,
    salinity: chart.salinity.buffer as ArrayBuffer,
    deepWater: chart.deepWater.buffer as ArrayBuffer,
    cyclone: chart.storms.cyclone.buffer as ArrayBuffer,
    tornado: chart.storms.tornado.buffer as ArrayBuffer,
    blizzard: chart.storms.blizzard.buffer as ArrayBuffer,
    dust: chart.storms.dust.buffer as ArrayBuffer,
    thunder: chart.storms.thunder.buffer as ArrayBuffer,
    pressure: chart.pressure.buffer as ArrayBuffer,
    wind: chart.wind.buffer as ArrayBuffer,
    currents: chart.currents.slice().buffer as ArrayBuffer,
    currentAnomaly: chart.currentAnomaly.slice().buffer as ArrayBuffer,
    upwelling: chart.upwelling.buffer as ArrayBuffer,
  }
  emit(reply, [reply.temperature, reply.precipitation, reply.koppen, reply.fog, reply.foehn, reply.rainVariability, reply.ensoPattern, reply.salinity, reply.deepWater, reply.cyclone, reply.tornado, reply.blizzard, reply.dust, reply.thunder, reply.pressure, reply.wind, reply.currents, reply.currentAnomaly, reply.upwelling, ...refinedBuffers(values)])
  // The screen's annual fields follow, as a climate of its own kind; the
  // marks read the year's wind and the currents on the mesh.
  postClimate(
    { temperature: annual.temperature, wind: annualWind, currents: chart.currents, currentAnomaly: chart.currentAnomaly, precipitation: annual.precipitation, seasonalAmplitude: annual.seasonalAmplitude, monsoonIndex: annual.monsoonIndex },
    meshVectorPayload(r.spacingM, meshWind), meshVectorPayload(r.spacingM, { e: r.currentE, s: r.currentS }),
    land, pixelLand, width, height, { refined: true },
  )
  invalidateAfter('climate')
}

// A refinement's arrays copied, its solves left out (a diagnostic of the
// run, not part of the climate).
function structuredCopy(r: RefinedClimate): RefinedClimate {
  return {
    months: r.months, cells: r.cells, spacingM: r.spacingM,
    temperature: r.temperature.slice(), precipitation: r.precipitation.slice(), pressure: r.pressure.slice(),
    windE: r.windE.slice(), windS: r.windS.slice(), currentE: r.currentE.slice(), currentS: r.currentS.slice(),
    currentAnomaly: r.currentAnomaly.slice(), upwelling: r.upwelling.slice(), salinity: r.salinity.slice(), deepWater: r.deepWater.slice(),
    fog: r.fog.slice(), foehn: r.foehn.slice(),
    reliability: { ...r.reliability, rainVariability: r.reliability.rainVariability.slice(), ensoPattern: r.reliability.ensoPattern.slice() },
    storms: { cyclone: r.storms.cyclone.slice(), tornado: r.storms.tornado.slice(), blizzard: r.storms.blizzard.slice(), dust: r.storms.dust.slice(), thunder: r.storms.thunder.slice() },
  }
}

function refinedBuffers(r: RefinedClimate): ArrayBuffer[] {
  return [
    r.temperature, r.precipitation, r.pressure, r.windE, r.windS, r.currentE, r.currentS, r.currentAnomaly, r.upwelling, r.salinity, r.deepWater, r.fog, r.foehn,
    r.reliability.rainVariability, r.reliability.ensoPattern, r.storms.cyclone, r.storms.tornado, r.storms.blizzard, r.storms.dust, r.storms.thunder,
  ].map((f) => f.buffer as ArrayBuffer)
}

// The lake depths per node with frozen basins zeroed — what the ecology
// (fish) should see as WATER. Computed on demand rather than stored: the
// full depth stays the display/save truth (ice is water).
function liquidLakeDepth(lakes: LakeFields): Float32Array {
  const out = lakes.depth.slice()
  for (let i = 0; i < out.length; i++) if (lakes.frozen[i]) out[i] = 0
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
  const domain = sim.domain
  const mt = landTerrain()
  if (!mt) { decline('hydrology', 'tectonics'); return }
  // The raster the lakes' recovery, the dry floors and the shores are drawn
  // against: the terrain's rasterisation (renderTerrain). The hydrology
  // itself runs on the mesh's nodes.
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
  // Async (the render awaits); the onmessage handler is sync, so run it in
  // an IIFE like the erode branch does.
  ;(async () => {
    // Re-route only when topography/climate changed; a repeat call reuses the
    // cached discharge + lakes (the expensive parts) and just re-derives the
    // polylines. An absent result IS "re-route needed".
    let rerouted = false
    let result = hydrology
    if (!result) {
      // The lakes and the discharge on the mesh, under the climate at its
      // nodes (the mesh's own routing, derived with the terrain).
      let land = weather.land.mesh === mt.mesh && weather.land.z === mt.z ? weather.land : landClimateOf(weather.cells, mt)
      let onMesh = hydrologyOnMesh(mt, elevation, width, height, land)
      // CLIMATE REFINEMENT (v2, k=1): climate v1 was computed on the
      // PRE-EROSION terrain with the optimistic mask (every sub-sea cell =
      // water) — the stage sits before erosion since the stage-2 coupling.
      // This pass re-runs the chain on the CURRENT (eroded) terrain with
      // the terminal-basin dry floors counted as land, and is therefore
      // UNCONDITIONAL since 2026-08-16: it is where the post-erosion
      // climate and biome truth comes from at all — the first golden run
      // after the reorder caught v1 biomes calling erosion-grown coast
      // cells Ocean above sea level. Then re-derive the
      // precipitation-dependent hydrology once: discharge and lakes — the
      // ROUTING is untouched (the terrain didn't move), so no re-flood.
      // Deliberately ONE refinement step, mirroring the riparian pattern:
      // iterate further and this becomes a fixed-point solver for a
      // second-decimal correction nobody can see.
      // Not over the step's refinement: it is computed on the step's own
      // land mask, without the dry-basin override, and recomputing the
      // cheap chain here would put the history's climate back in its place.
      if (!weather.refined) {
        const chain = computeClimateChain(terrain, domain, weather.params, onMesh.raster.dryBasin)
        land = landClimateOf(chain.cells, mt, onMesh.lakes.dryBasin)
        // Update the caches + screen WITHOUT invalidateAfter('climate'):
        // the very next lines recompute the dependent hydrology themselves,
        // and dropping the hydrology result here would force a needless full
        // re-route on the next call.
        weather = climate = climateResultOf(chain, weather.params, land)
        postClimate(chain.chart, chain.windMesh, chain.currentsMesh, land, pixelLandOf(terrain, onMesh.raster.dryBasin), width, height, { refinement: true })
        onMesh = hydrologyOnMesh(mt, elevation, width, height, land)
      }
      const lakes = onMesh.raster
      // Terrain truth: repaint the map with the dry basin floors as land
      // (salt band + basin rock, real hillshade). skipInvalidation — this
      // render shows the hydrology we JUST computed; dropping the result here
      // would force a pointless full re-route on the next call.
      renderDryBasin = lakes.dryBasin
      renderSaltFlat = lakes.saltFlat
      await renderAndPost(terrain, false, 1, true)
      if (stale()) return
      result = {
        lakeDepth: lakes.depth, saltFlat: lakes.saltFlat, dryBasin: lakes.dryBasin, frozen: lakes.frozen,
        bodies: onMesh.lakes.bodies, level: lakes.level, surface: lakes.surface, body: lakes.body,
        // The graph's discharge scale: the substrate it is built on.
        maxDischarge: maxDischargeOverLand(onMesh.discharge, mt.z), meanRunoff: meanLandRunoff(weather.cells),
        graph: null, coast: null, sedimentBasins: [], ice: null, oases: [],
        onMesh,
      }
      hydrology = result
      rerouted = true
    }
    // ONE threshold, the model's own: the generator draws exactly the
    // canonical channel set the riparian biomes, the bake and the worldmap
    // read. The density slider that used to threshold the drawing separately
    // died with its panel (erosion-v2 P4/teardown).
    const threshold = channelThreshold(densityToCriticalArea(CANONICAL_RIVER_DENSITY, domain), result.meanRunoff)
    // Lakes only change on a re-route; a repeat call sends an empty buffer.
    const lakeOut = rerouted ? result.lakeDepth.slice() : new Float32Array(0)
    const levelOut = rerouted ? result.level.slice() : new Float32Array(0)
    const surfaceOut = rerouted ? result.surface.slice() : new Uint8Array(0)
    // Watersheds + the discharge on the map: re-route only, same contract.
    let watershedsOut: Uint16Array = new Uint16Array(0)
    let dischargeOut: Float32Array = new Float32Array(0)
    let coastTypeOut: Uint8Array = new Uint8Array(0)
    // The biomes are pinned to the routing like the lakes, so they too
    // change on a re-route only — a repeat call sends them empty (the screen
    // keeps its last copy).
    let biomesOut: Uint8Array = new Uint8Array(0)
    let precipEffOut: Float32Array = new Float32Array(0)
    if (rerouted) {
      const om = result.onMesh
      const land = om.land
      const sub = meshSubstrate(mt.mesh, mt.routing, mt.areas)
      const pixelLand = pixelLandOf(terrain, result.dryBasin)
      // THE RIPARIAN BIOMES on the mesh (DEC-0036 phase 7): the rivers and
      // lakes moisten the land around them (hydrology.
      // riparianPrecipitationOn), and the biomes are classified again from
      // that effective rain; a terminal basin's salt flat and a frozen
      // basin are hydrology states, not climates — they win.
      const precipEff = riparianPrecipitationOn(sub, mt.z, om.discharge, threshold, result.maxDischarge, om.lakes.depth, om.lakes.frozen, land.climate.precipitation)
      const nodeBiome = classifyPoints(land.climate, land.points, domain, precipEff).biome
      precipEffOut = landRaster(land, precipEff, pixelLand, width, height, OCEAN_PRECIP, false)
      for (let v = 0; v < nodeBiome.length; v++) {
        if (!land.points.land[v]) continue
        if (om.lakes.saltFlat[v]) nodeBiome[v] = Biome.SaltFlat
        if (om.lakes.frozen[v]) nodeBiome[v] = Biome.Glacier
      }
      om.ecologyBiome = nodeBiome.slice()
      // The forcing's hardness at the nodes (the nearest cell of its raster):
      // the hydrogeology's, the coast's and the sediment basins' input.
      const forcingFields = coarseForcingFields(sim, sim.domain)
      const nodeHardness = nearestCellAtNodes(forcingFields.hardness, CLIMATE_RES_X, CLIMATE_RES_Y, mt.mesh)
      // The cover (phase 5.5) from the climate's own biomes at the nodes,
      // for the infiltration.
      const plantsFromMa = (historyControls.weather.planet ?? DEFAULT_PLANET_FORCING).landPlantsFromMa
      const cover = coverField(land.biome, worldAgeMa(sim.archeanEpochs, sim.epoch) >= plantsFromMa)
      // THE FEATURE GRAPH (phase 2) on the mesh (phase 4.3): the network
      // as data, with the biomes as bank material and the last erosion's
      // sediment flux as load. The ribbons below derive from it.
      const regime = accumulateRegimeInputsOn(sub, mt.z, land.climate.temperature, land.climate.precipitation, land.climate.monsoonIndex, land.climate.months ?? undefined)
      result.graph = buildRiverGraph({
        substrate: sub, discharge: om.discharge, elevation: mt.z, threshold, maxDischarge: result.maxDischarge,
        bodies: om.lakes.bodies, body: om.lakes.body, lakeDepth: om.lakes.depth,
        sedimentFlux: mt.sedimentFlux.length === mt.mesh.vertexSlots ? mt.sedimentFlux : undefined,
        biomes: nodeBiome,
        regime,
        criticalArea: densityToCriticalArea(CANONICAL_RIVER_DENSITY, domain),
      })
      // THE HYDROGEOLOGY (phase 5a): the column's materials, the springs
      // on the graph, the regime re-judged with the baseflow, the water
      // table — on the mesh, under the climate at its nodes.
      const ground = computeHydrogeology({
        sub, elevation: mt.z, graph: result.graph,
        column: coupled && coupled.mesh === mt.mesh ? coupled.column : null,
        hardness: nodeHardness,
        precipitation: land.climate.precipitation, temperature: land.climate.temperature, monsoonIndex: land.climate.monsoonIndex,
        cover, regime, discharge: om.discharge, cellM: domain.metresAround / width,
      })
      om.waterTable = ground.waterTableDepthM
      result.oases = ground.springs.filter((s) => s.oasis)
      // THE RIVER COURSE (phase 3): pattern, meanders, braids and deltas per
      // reach, seeded from the world so a world always gets the same bends.
      result.graph.courses = computeRiverCourses(result.graph, { cellM: domain.metresAround / width, seed: sim.warpSeed, domain })
      // THE COAST (F5) on the mesh's shore nodes: exposure from the wind
      // (the climate's cells read at the nodes), hardness from the erosion
      // forcing's field, sediment from the graph's mouths — a type per reach.
      const windy = climateAtPoints(weather.cells, land.points, { wind: true })
      result.coast = buildCoastGraph({ mesh: mt.mesh, z: mt.z, windE: windy.windE!, windS: windy.windS!, hardness: nodeHardness, graph: result.graph })
      // SEDIMENT BASINS (F1): what the last epoch's erosion deposited, per
      // node against the heights it started from, with the provenance of
      // the catchments feeding each basin. A loaded save brings the start
      // with it (`mesh/preErosionZ.f32`); a world before its first epoch
      // has none (its preErosionZ is its z) and gets no basins.
      result.sedimentBasins = coupled && coupled.mesh === mt.mesh && coupled.preErosionZ.length === mt.z.length && coupled.preErosionZ !== mt.z
        ? findSedimentBasins({
          mesh: mt.mesh, before: coupled.preErosionZ, after: mt.z, substrate: sub, graph: result.graph,
          cratonAge: nearestCellAtNodes(computeCratonOldnessField(sim.rafts, worldEpoch(sim.archeanEpochs, sim.epoch), CLIMATE_RES_X, CLIMATE_RES_Y, sim.domain), CLIMATE_RES_X, CLIMATE_RES_Y, mt.mesh),
          hardness: nodeHardness,
        }).basins
        : []
      // The map's rasters of the mesh's results (fork 5: the chart is the
      // address and the textures): the watersheds and the discharge a land
      // pixel's heaviest land corner's, the coast type on the raster's own
      // shore pixels from the shore nodes.
      watershedsOut = Uint16Array.from(landRaster(land, watershedsOn(sub, mt.z), pixelLand, width, height, 0, true))
      dischargeOut = landRaster(land, om.discharge, pixelLand, width, height, 0, true)
      coastTypeOut = coastTypeRaster(mt.mesh, result.coast.type, elevation, sim.domain.grid(width, height))
      // THE ICE: the history's own (phase 6, the last epoch's steady state
      // on the mesh) when the terrain has been through an epoch, or a save
      // of one was loaded (`mesh/ice.f32`); otherwise the steady state of
      // this climate on the mesh (a world before its first epoch).
      const nodeIce = coupled && coupled.mesh === mt.mesh && coupled.ice.length === mt.mesh.vertexSlots
        ? coupled.ice
        : computeIceOnMesh({ mesh: mt.mesh, z: mt.z, seaLevelTemperature: land.climate.seaLevelTemperature, precipitation: land.climate.precipitation, cellM: domain.metresPerUnit }).thickness
      const ice = rasteriseNodeField(mt.mesh, nodeIce, width, height)
      for (let c = 0; c < ice.length; c++) if (elevation[c] <= 0 || ice[c] < SURFACE_TUNING.iceMinThicknessM) ice[c] = 0
      result.ice = ice
      // THE ICE BODY IS A BIOME (phase 6, decided 2026-09-23: the climate
      // class Ice stays, Glacier is the ice with a thickness): under ice the
      // node's biome is Glacier, whatever the climate said.
      for (let v = 0; v < nodeBiome.length; v++) if (land.points.land[v] && mt.z[v] > SEA_LEVEL && nodeIce[v] >= SURFACE_TUNING.iceMinThicknessM) nodeBiome[v] = Biome.Glacier
      om.biome = nodeBiome
      biomesOut = idRaster(land, nodeBiome, pixelLand, width, height, Biome.Ocean)
    }
    // The graph exists once a re-route ran; the ribbons derive from it.
    const rivers: RiverPolylines = result.graph
      ? riverPolylinesFromGraph(result.graph, result.maxDischarge, domain)
      : { points: new Float32Array(0), lengths: new Uint32Array(0), regimes: new Uint8Array(0) }
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
      coastType: coastTypeOut.buffer as ArrayBuffer,
      coast: coastOut ? { reaches: coastOut.reaches, nodes: coastOut.nodes.slice().buffer as ArrayBuffer } : null,
      sedimentBasins: rerouted ? result.sedimentBasins : null,
      iceThickness: iceOut.buffer as ArrayBuffer,
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
  // Fresh arrays, so every field buffer transfers.
  if (!sim || !lastRawElevations) { decline('ecology', 'tectonics'); return }
  if (!climate) { decline('ecology', 'climate'); return }
  const mt = landTerrain()
  if (!mt) { decline('ecology', 'tectonics'); return }
  // Hydrology (discharge/lakes) is optional here — if it hasn't been computed
  // yet, fish falls back to its marine component; the ecology panel re-triggers
  // this once hydrology lands (see GeneratorScreen's chaining).
  // The physics depends on the world alone; while only the sliders move,
  // the last one stands (prepareEcology is the expensive part, the sliders
  // a fraction of it).
  const key = { climate, hydrology, elevation: lastRawElevations, sim, epoch: sim.epoch }
  const last = ecologyBase?.key
  if (!ecologyBase || !last || last.climate !== key.climate || last.hydrology !== key.hydrology || last.elevation !== key.elevation || last.sim !== key.sim || last.epoch !== key.epoch) {
    const om = hydrology && hydrology.onMesh.land.mesh === mt.mesh ? hydrology.onMesh : null
    const land = om ? om.land : climate.land.mesh === mt.mesh && climate.land.z === mt.z ? climate.land : landClimateOf(climate.cells, mt)
    const cratonField = computeCratonOldnessField(sim.rafts, worldEpoch(sim.archeanEpochs, sim.epoch), CLIMATE_RES_X, CLIMATE_RES_Y, sim.domain)
    const base = prepareEcology({
      mesh: mt.mesh,
      z: mt.z,
      land: land.points.land,
      climate: land.climate,
      biomes: om?.ecologyBiome ?? land.biome,
      discharge: om?.discharge ?? null,
      maxDischarge: hydrology?.maxDischarge ?? 0,
      // Liquid water only: a frozen basin is a glacier and feeds no fishery.
      lakeDepth: om ? liquidLakeDepth(om.lakes) : null,
      saltFlat: om?.lakes.saltFlat ?? null,
      waterTable: om?.waterTable ?? null,
      oases: hydrology?.oases ?? [],
      volcanoes: collectVolcanoes(sim.features),
      // Collision belts for tin/lode-gold/gems: current fold mountains (on-crust)
      // + the accumulated (advected) deep-time sutures.
      orogenPoints: [...collectOrogens(sim.features), ...sim.sutures],
      cratonAge: landBilinearAtNodes(cratonField, sim.domain.grid(CLIMATE_RES_X, CLIMATE_RES_Y), mt.mesh),
      warpSeed: sim.warpSeed,
      domain: sim.domain,
    })
    base.raster = trianglesOf(mt.mesh, sim.width, sim.height)
    ecologyBase = { key, base, pixelLand: pixelLandOf(lastRawElevations, hydrology?.dryBasin ?? null) }
  }
  ecologyParams = {
    carryingCapacity: message.carryingCapacity,
    concentration: message.concentration,
    provinceStrength: message.provinceStrength,
    tinRarity: message.tinRarity,
    weights: message.weights,
  }
  const eco = ecologyRasters(ecologyBase.base, applyEcology(ecologyBase.base, ecologyParams).fields, ecologyBase.pixelLand, sim.domain.grid(sim.width, sim.height))
  // Cache a copy of carrying capacity BEFORE the buffers below are transferred
  // (transfer neuters them) — the migration step reads it.
  ecology = { carryingCapacity: eco.fields.carryingCapacity.slice() }
  const fields = Object.entries(eco.fields).map(([id, data]) => ({ id, data: data.buffer as ArrayBuffer }))
  const fine = Object.entries(eco.fine.fields).map(([id, data]) => ({ id, data: encodeFineField(data).buffer as ArrayBuffer }))
  const ecologyMessage: WorkerEcologyDataMessage = {
    type: 'ecologyData',
    resX: eco.resX,
    resY: eco.resY,
    fields,
    fine: { resX: eco.fine.resX, resY: eco.fine.resY, fields: fine },
  }
  emit(ecologyMessage, [...fields.map((f) => f.data), ...fine.map((f) => f.data)])
}

function handleEcologyMonth(message: Extract<WorkerInboundMessage, { type: 'ecologyMonth' }>): void {
  // Answered on the physics and sliders of the last run; without them (or
  // for a yearly field, or a climate without months) there is nothing to
  // send, and the screen keeps showing the year.
  // Always answered, with no data then, so the screen is not left waiting.
  const field = message.field as EcologyFieldId
  const nodes = ecologyBase && ecologyParams && isSeasonalEcologyField(field)
    ? ecologyMonth(ecologyBase.base, field, message.month, ecologyParams.weights?.[field] ?? 1)
    : null
  const width = sim?.width ?? 0
  const height = sim?.height ?? 0
  const data = nodes && ecologyBase ? ecologyFine(ecologyBase.base, nodes, ecologyBase.pixelLand, width, height, field === 'fish') : null
  const reply: WorkerEcologyMonthDataMessage = {
    type: 'ecologyMonthData', field, month: message.month,
    resX: data ? width : 0, resY: data ? height : 0,
    data: data ? encodeFineField(data).buffer as ArrayBuffer : new ArrayBuffer(0),
  }
  emit(reply, [reply.data])
}

function handleMigrationRun(message: Extract<WorkerInboundMessage, { type: 'migrationRun' }>): void {
  // Needs ecology's carrying capacity (density) + the current climate/hydrology
  // for the cost field. Discharge is downsampled to the coarse grid for river corridors.
  if (!sim || !lastRawElevations) { decline('migration', 'tectonics'); return }
  if (!climate) { decline('migration', 'climate'); return }
  if (!ecology) { decline('migration', 'ecology'); return }
  const coarseDischarge = hydrology ? chartMaxOfNodes(hydrology.onMesh.land.mesh, hydrology.onMesh.discharge, hydrology.onMesh.land.z) : null
  // The migration runs on the climate's chart (its own screen, later; not
  // one of DEC-0036 phase 7's stages): the climate's land and rain there.
  const { cells, terrain } = climate
  const precipitation = chartLandField(cells.cm, cells.precipitation, (i) => cells.precipitation[i] !== OCEAN_PRECIP, OCEAN_PRECIP, chartLand(terrain))
  const mig = computeMigration(ecology.carryingCapacity, precipitation, lastRawElevations, coarseDischarge, hydrology?.maxDischarge ?? 0, message.origins, sim.domain, {
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
    const mantle = fieldPayload(savedMantle(archean.mantle, archean.domain))
    const streak = archean.upwellingStreak.slice()
    const message: WorkerWorldDataMessage = {
      type: 'worldData',
      archean: { snapshot, mantle, streak: streak.buffer as ArrayBuffer },
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
      oceanAge: fieldPayload(savedOceanAge(createOceanAgeField(0, archean.domain), archean.domain)),
    }
    emit(message, [message.archean!.mantle.values, message.archean!.streak])
    return
  }
  if (!sim || !lastRawElevations) return
  // The meshes' own values, copies (the bit-identical continuation; DEC-0036
  // phases 1 and 2).
  const mantle = fieldPayload(savedMantle(sim.mantle, sim.domain))
  const oceanAge = fieldPayload(savedOceanAge(sim.oceanAge, sim.domain))
  const accumulated = sim.latticeAccumulated.slice()
  const locked = sim.latticeLockedEpochs.slice()
  const lastClass = sim.latticeLastClassCode.slice()
  // No raster (DEC-0036, the save step): the elevation is the mesh's
  // rasterisation and the erosion's coarse forcing a function of the
  // snapshot (erosionForcing.coarseForcingFields), both made again by
  // whoever reads the save.
  const worldMessage: WorkerWorldDataMessage = {
    type: 'worldData',
    snapshot: serializePlateSimulation(sim),
    mantle,
    latticeAccumulated: accumulated.buffer as ArrayBuffer,
    latticeLockedEpochs: locked.buffer as ArrayBuffer,
    latticeLastClassCode: lastClass.buffer as ArrayBuffer,
    oceanAge,
    mesh: savedMeshPayload(),
    climate: climate ? climatePayload(climate.cells) : undefined,
    land: landPayload(),
  }
  const transfers = [worldMessage.mantle.values, worldMessage.latticeAccumulated, worldMessage.latticeLockedEpochs, worldMessage.latticeLastClassCode, worldMessage.oceanAge.values]
  if (worldMessage.mesh) transfers.push(worldMessage.mesh.nodes, worldMessage.mesh.connectivity, worldMessage.mesh.z)
  if (worldMessage.climate) transfers.push(worldMessage.climate.seaLevelTemperature, worldMessage.climate.precipitation, worldMessage.climate.seasonalAmplitude, worldMessage.climate.monsoonIndex)
  if (worldMessage.land) transfers.push(worldMessage.land.biome, worldMessage.land.koppen, ...(worldMessage.land.waterTable ? [worldMessage.land.waterTable] : []), ...(worldMessage.land.lakeBody ? [worldMessage.land.lakeBody] : []))
  emit(worldMessage, transfers)
}

// The climate's cells as the save holds them (world/save/climateFields.ts),
// copies.
function climatePayload(cells: ClimateCells): ClimatePayload {
  const v = climateCellValues(cells)
  return {
    cells: v.cells, spacingM: v.spacingM,
    seaLevelTemperature: v.seaLevelTemperature.slice().buffer as ArrayBuffer, precipitation: v.precipitation.slice().buffer as ArrayBuffer,
    seasonalAmplitude: v.seasonalAmplitude.slice().buffer as ArrayBuffer, monsoonIndex: v.monsoonIndex.slice().buffer as ArrayBuffer,
  }
}

// The land fields per node of the mesh the save carries, in its numbering
// (the canonical mesh's slots): the map's biome (the hydrology's when it
// ran, else the climate's), the Köppen class, the water table and the
// discharge (the hydrology's, null before it ran). Undefined
// when no climate describes this mesh.
function landPayload(): LandPayload | undefined {
  if (!climate || !meshTerrain) return undefined
  const om = hydrology && hydrology.onMesh.land.mesh === meshTerrain.mesh ? hydrology.onMesh : null
  const land = om ? om.land : climate.land
  if (land.mesh !== meshTerrain.mesh) return undefined
  const count = meshTerrain.mesh.aliveVertices
  // The discharge in m³/s per node (hydrology.dischargeToM3s: the unit is
  // mm/yr over world cells, a cell the Domain's metres per unit).
  let discharge: ArrayBuffer | null = null
  if (om) {
    const m3s = new Float32Array(count)
    const unit = dischargeToM3s(1, meshTerrain.mesh.domain.metresPerUnit)
    for (let v = 0; v < count; v++) m3s[v] = om.discharge[v] * unit
    discharge = m3s.buffer as ArrayBuffer
  }
  return {
    count,
    biome: (om?.biome ?? land.biome).slice(0, count).buffer as ArrayBuffer,
    koppen: land.koppen.slice(0, count).buffer as ArrayBuffer,
    waterTable: om?.waterTable ? om.waterTable.slice(0, count).buffer as ArrayBuffer : null,
    discharge,
    // The lakes per node (the hydrology's bodies, which the screen saves as
    // waterBodies.json): what a reader draws the lakes' raster from.
    lakeBody: om ? om.lakes.body.slice(0, count).buffer as ArrayBuffer : null,
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
  archean = null
  sim = null
  coupled = null
  meshTerrain = null
  meshPayloadCache = null
  invalidateAfter('tectonics')
  const result = await replayRuns(message.plan, {
    budget: HISTORY_DEFAULTS.budget,
    cancelled: () => generation !== worldGeneration,
    onEpoch: (done, total) => emit({ type: 'replayProgress', done, total }),
  })
  if (!result || generation !== worldGeneration) return
  sim = result.sim
  coupled = result.terrain
  coupled.routing ??= meshRouting(coupled.mesh, coupled.z)
  meshTerrain = asMeshTerrain(coupled)
  // A run that follows goes on with the last run's controls until the
  // screen's next start sends its own.
  const last = message.plan.tectonics[message.plan.tectonics.length - 1]
  if (last) {
    historyControls = {
      alluvium: last.controls.alluvium ?? TECTONICS_INPUTS.alluvium.default,
      rockContrast: last.controls.rockContrast ?? TECTONICS_INPUTS.rockContrast.default,
      weather: last.weather,
    }
  }
  emit({ type: 'replayDone', archeanEpochs: sim.archeanEpochs, epoch: sim.epoch })
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

function handleRestoreWorld(message: Extract<WorkerInboundMessage, { type: 'restoreWorld' }>): void {
  stopTicking()
  worldGeneration += 1
  dropHandover()
  // What the previous world's last epoch and hydrology left: its
  // pre-erosion heights (the sediment basins diffed the new world against
  // them), its sediment flux (the river graph read it where the sizes
  // matched) and its terminal basins (painted on the new world's first
  // render). None of them describes the world being restored (2026-10-01).
  renderDryBasin = null
  renderSaltFlat = null
  if (message.archean) {
    sim = null
    archean = deserializeArchean(message.archean.snapshot, savedOf(message.archean.mantle), new Int16Array(message.archean.streak), message.shape ?? 'torus')
    archeanSeed = message.seed
    archeanWater = archean.seaLevelOffset
    if (message.mantleDiffusion !== undefined) archeanParams = { ...DEFAULT_ARCHEAN_PARAMS, diffusion: message.mantleDiffusion }
    archeanWidth = archean.width
    archeanHeight = archean.height
    archeanShape = archean.domain.kind
    // The raster is the Archean's render of its state, as in the session
    // (the save carries none since DEC-0036's save step).
    lastRawElevations = null
    preErosionElevations = null
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
  sim = deserializePlateSimulation(message.snapshot, savedOf(requireOceanAge(message.oceanAge)), savedOf(message.mantle), message.shape ?? 'torus')
  // The hand-over's shape too: a genesis reset after a load starts the
  // world's own shape again.
  archeanShape = sim.domain.kind
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
  lastRawElevations = null
  preErosionElevations = null
  // The history's terrain from the save (phase 5.1): the mesh with its
  // heights, the baseline from the restored sim, the routing derived. The
  // raster is its rasterisation (renderTerrain), as after every epoch —
  // the save carries none (DEC-0036, the save step). Without a mesh (the
  // screen refuses such a save): the mesh the hand-over builds, a
  // function of the plates, unrouted as the session's is.
  if (message.mesh) {
    const f32 = (buffer: ArrayBuffer | undefined): Float32Array | undefined => buffer ? new Float32Array(buffer) : undefined
    coupled = decodeCoupledTerrain(sim, {
      nodes: new Float32Array(message.mesh.nodes), connectivity: new Uint8Array(message.mesh.connectivity), z: new Float32Array(message.mesh.z),
      column: message.mesh.column ? new Uint8Array(message.mesh.column) : undefined,
      ice: f32(message.mesh.ice), sedimentFlux: f32(message.mesh.sedimentFlux), preErosionZ: f32(message.mesh.preErosionZ),
    })
    coupled.routing = meshRouting(coupled.mesh, coupled.z)
    meshTerrain = asMeshTerrain(coupled)
  } else {
    coupled = createCoupledTerrain(sim, HISTORY_DEFAULTS.budget)
    meshTerrain = null
  }
  meshPayloadCache = null
  lastLakeBasinElevations = null
  // The terrain's rasterisation, rendered — no re-erosion.
  void renderTerrain()
}


// --- Archean phase ---
// Mirrors the tectonic init/start/stop trio: the same step loop, same
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
  archeanShape = message.shape ?? 'torus'
  archean = createArcheanSimulation(message.seed, message.width, message.height, archeanWater, archeanShape)
  lastRawElevations = null
  preErosionElevations = null
  coupled = null
  meshTerrain = null
  renderOptions = message.renderOptions
  epochIntervalMs = message.epochIntervalMs
  void renderArcheanAndPost()
}

function handleGenesisStart(message: Extract<WorkerInboundMessage, { type: 'genesisStart' }>): void {
  if (loop) return
  if (message.mantleDiffusion !== undefined) archeanParams = { ...archeanParams, diffusion: message.mantleDiffusion }
  if (message.seaLevelOffset !== undefined) {
    archeanWater = message.seaLevelOffset
    if (archean) archean.seaLevelOffset = message.seaLevelOffset
  }
  // Paced (epochIntervalMs from one step's start to the next's), the first
  // step one interval after the gesture. A step is synchronous up to its
  // render, so a stop always finds it before or inside the render.
  startLoop('genesis', epochIntervalMs, epochIntervalMs, async () => {
    if (!archean) return false
    archeanStep(archean, archeanParams)
    await renderArcheanAndPost(PREVIEW_RENDER_SCALE)
    return false
  }, () => renderArcheanAndPost(1))
}

// A pause, not an ending — the phase is resumable, and only becomes final when
// archeanFinalize starts the tectonic phase.
function handleGenesisStop(): void {
  // A step in flight: the loop draws the full-resolution picture after it.
  if (stopLoop('stop')?.inFlight) return
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
  // The Archean's last epochs said once more, at the epoch it ends on. A step
  // whose render was still in flight when the hand-over came never reports
  // (the render finds the Archean gone), and the screen counts the history's
  // Archean epochs from these statuses: one short, and a replay of the
  // history parts from the hand-over on (measured 2026-10-01). The figures
  // are the last status's; only the epoch is new.
  if (lastGenesisStatus && lastGenesisStatus.epoch !== archean.epoch) {
    emit({ ...lastGenesisStatus, epoch: archean.epoch, worldAgeMa: worldAgeMa(archean.epoch, 0) })
  }
  lastGenesisStatus = null
  sim = finalizeArchean(archean)
  sim.epochMa = TECTONIC_MA_PER_EPOCH
  // Deep-copied, because serializePlateSimulation hands back the sim's OWN arrays
  // (rafts, features, seeds, motions) rather than copies — fine for its real job,
  // where the result is written to a file immediately, but useless as a stored state:
  // tectonics goes on mutating those same arrays, so an uncopied "snapshot" drifts
  // along with the world it was meant to preserve. Measured: after 60 epochs a reset
  // restored epoch 0 but 20 rafts and 386 features instead of the hand-over's 13 and 0.
  handoverSnapshot = structuredClone(serializePlateSimulation(sim))
  handoverOceanAge = savedOceanAge(sim.oceanAge, sim.domain)
  handoverMantle = savedMantle(sim.mantle, sim.domain)
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
  sim = deserializePlateSimulation(handoverSnapshot, { ...handoverOceanAge, values: handoverOceanAge.values.slice() }, { ...handoverMantle, values: handoverMantle.values.slice() }, archeanShape)
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
  archean = createArcheanSimulation(archeanSeed, archeanWidth, archeanHeight, archeanWater, archeanShape)
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
  climateRefine: (m) => handleClimateRefine(m as Extract<WorkerInboundMessage, { type: 'climateRefine' }>),
  hydrologyRun: () => handleHydrologyRun(),
  ecologyRun: (m) => handleEcologyRun(m as Extract<WorkerInboundMessage, { type: 'ecologyRun' }>),
  ecologyMonth: (m) => handleEcologyMonth(m as Extract<WorkerInboundMessage, { type: 'ecologyMonth' }>),
  migrationRun: (m) => handleMigrationRun(m as Extract<WorkerInboundMessage, { type: 'migrationRun' }>),
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
  const domain = domainOfKind(shape, width, height)
  if (!sampleWorld || sampleWorld.width !== width || sampleWorld.height !== height || sampleWorld.shape !== shape) {
    const elevation = previewElevation(domain)
    const rendered = await renderSimulationImage(
      { width, height, domain, seeds: [], rafts: [], features: [], oceanAge: null, warpSeed: 0, seaLevelOffset: 0, mantle: new Float64Array(mantleMesh(domain).mesh.count) },
      renderPool(),
      { precomputedElevations: elevation },
    )
    sampleWorld = { width, height, shape, elevation, buffer: rendered.buffer, relief: rendered.relief }
  }
  const params: ClimateParams = message.weather ?? defaultWeatherParams()
  const chain = computeClimateChain(sampleWorld.elevation, domain, params)
  // The sample world has no terrain mesh: its biomes and classes are the
  // climate mesh's own cells' (their centres' heights), each pixel the
  // heaviest land corner's.
  const { cm, z: cellZ, land: cellLand, dry: cellDry } = chain.weather.terrain
  const cellPoints: ClimatePoints = { count: cm.mesh.count, x: cm.mesh.x, y: cm.mesh.y, height: cellZ, land: cellLand, dry: cellDry, alive: null }
  const cellClasses = classifyPoints(climateAtPoints(chain.cells, cellPoints), cellPoints, domain)
  const pixelLand = pixelLandOf(sampleWorld.elevation, null)
  const cellTriangles = trianglesOf(cm.mesh.tri, width, height)
  const cellRaster = (ids: Uint8Array, sea: number): Uint8Array => Uint8Array.from(rasteriseNodePart(cm.mesh.tri, ids, cellLand, pixelLand, sea, width, height, true, undefined, cellTriangles))
  const preview: WorkerPlanetPreviewDataMessage = {
    type: 'planetPreviewData',
    width,
    height,
    shape,
    buffer: sampleWorld.buffer.slice().buffer as ArrayBuffer,
    relief: sampleWorld.relief.slice().buffer as ArrayBuffer,
    resX: CLIMATE_RES_X,
    resY: CLIMATE_RES_Y,
    temperature: chain.chart.temperature.buffer as ArrayBuffer,
    wind: chain.chart.wind.buffer as ArrayBuffer,
    windMesh: chain.windMesh,
    currentsMesh: chain.currentsMesh,
    currents: chain.chart.currents.buffer as ArrayBuffer,
    currentAnomaly: chain.chart.currentAnomaly.buffer as ArrayBuffer,
    precipitation: chain.chart.precipitation.buffer as ArrayBuffer,
    seasonalAmplitude: chain.chart.seasonalAmplitude.buffer as ArrayBuffer,
    monsoonIndex: chain.chart.monsoonIndex.buffer as ArrayBuffer,
    koppen: cellRaster(cellClasses.koppen, 0).buffer as ArrayBuffer,
    biomes: cellRaster(cellClasses.biome, Biome.Ocean).buffer as ArrayBuffer,
  }
  emit(preview, [preview.buffer, preview.relief, preview.temperature, preview.wind, chain.windMesh.e, chain.windMesh.s, chain.currentsMesh.e, chain.currentsMesh.s, preview.currents, preview.currentAnomaly, preview.precipitation, preview.seasonalAmplitude, preview.monsoonIndex, preview.koppen, preview.biomes])
}

// The stage whose compute a message runs, where a failure must reach the
// screen: it waits for the answer (the climate's two runs, the hydrology,
// the ecology and its month, the migration).
const COMPUTE_STAGE: Partial<Record<WorkerInboundMessage['type'], StageId>> = {
  climateRun: 'climate', climateRefine: 'climate', hydrologyRun: 'hydrology', ecologyRun: 'ecology', ecologyMonth: 'ecology', migrationRun: 'migration',
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
