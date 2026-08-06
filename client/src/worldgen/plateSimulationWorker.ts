import { stepEpoch, serializePlateSimulation, deserializePlateSimulation } from './tectonics/plateSimulation'
import type { PlateSimulation, SimEvent, PlateSimulationSnapshot } from './tectonics/plateSimulation'
import { renderSimulationImage } from './render/elevationMapImage'
import type { RenderSimulationOptions } from './render/elevationMapImage'
import type { ContinentLabelPlacement } from './render/continentLabelRenderer'
import { ElevationRenderPool } from './render/elevationRenderPool'
import { DEFAULT_EROSION_PASS_PARAMS, runErosionPass } from './surface/erosion'
import type { ArcheanSimulation } from './archean/archeanState'
import { createArcheanSimulation } from './archean/archeanState'
import type { ArcheanSnapshot } from './archean/archeanSnapshot'
import { deserializeArchean, serializeArchean } from './archean/archeanSnapshot'
import type { ArcheanParams } from './archean/archeanStep'
import { archeanStep, DEFAULT_ARCHEAN_PARAMS } from './archean/archeanStep'
import { convectionCellSeeds, finalizeArchean } from './archean/finalizeArchean'
import { findPlumeSites } from './tectonics/plumes'
import { stabilisedFraction } from './crust/raftField'
import { worldAgeMa } from './core/worldTime'
import { accumulateFlow, fillDepressionsAndRouteFlow } from './surface/flowRouting'
import { MICRO_TILE_EXTENT_MACRO, MICRO_TILE_FACTOR, buildTileElevation, buildTileInflow, burnMacroTrunks, pickLargestRiverMouth, runTileErosion, scaleErosionParamsForTile } from './surface/tileErosion'
import { growDelta, pickDeltaEntry } from './surface/deltaGrowth'
import { renderMicroTileImage } from './render/microTileImage'
import { OCEAN_AGE_RES_X, OCEAN_AGE_RES_Y } from './tectonics/oceanAge'
import type { ErosionPhase, ErosionPassParams } from './surface/erosion'
import type { FlowRouting } from './surface/flowRouting'
import { accumulateDischarge, extractRiverPolylines, computeLakes, computeRiparianBiomes, maxDischargeOverLand, meanLandRunoff, densityToCriticalArea, channelThreshold } from './surface/hydrology'
import { MANTLE_RES_X, MANTLE_RES_Y } from './tectonics/mantleField'
import { SEA_LEVEL, metersToElevation } from './elevation/elevationScale'
import type { TerrainFeature } from './tectonics/terrainFeatures'
import { computeTemperature } from './climate/temperature'
import { computeWind } from './climate/wind'
import { computeOceanCurrents, applyOceanSST } from './climate/oceanCurrents'
import { computeSeasonalAmplitude } from './climate/seasonality'
import { computeSeasonalPrecipitation } from './climate/monsoon'
import { computeBiomes } from './climate/biomes'
import { CLIMATE_RES_X, CLIMATE_RES_Y, sampleElevationAtCell } from './climate/climateField'
import { computeEcology } from './ecology/ecologyField'
import { computeMigration } from './migration/migrationField'
import type { MigrationOrigin } from './migration/migrationField'
import { downsampleMax } from './worldSave/worldLayers'
import { collectVolcanoes } from './tectonics/volcanoes'
import { computeCratonOldnessField } from './crust/raftField'

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
// Debug inspector: re-simulate a small window around the largest river mouth
// at fine resolution (surface/tileErosion.ts — the resolution-strategy micro
// tier's prototype) and reply with a WorkerMicroTileDataMessage. Derived
// display detail only — nothing about the macro world changes.
export interface WorkerComputeMicroTileMessage {
  type: 'computeMicroTile'
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
  // Absent in saves written before the mantle was persisted — deserializePlateSimulation
  // then falls back to regenerating one, which is what every save used to do.
  mantle?: ArrayBuffer
  // Set when the saved world was still in the Archean; `snapshot` is then unused.
  archean?: { snapshot: ArcheanSnapshot; mantle: ArrayBuffer; streak: ArrayBuffer }
  // The boundary-detection lattice's accumulated history, likewise optional for older
  // saves. Measured: mantle and lattice TOGETHER are exactly what a bit-identical
  // continuation needs — with only one of them restored, a loaded world drifts off
  // the trajectory it was saved on.
  lattice?: { accumulated: ArrayBuffer; lockedEpochs: ArrayBuffer; lastClassCode: ArrayBuffer }
}
export type WorkerInboundMessage =
  | WorkerStartMessage
  | WorkerStopMessage
  | WorkerErodeMessage
  | WorkerResetErosionMessage
  | WorkerStopErosionMessage
  | WorkerComputeMicroTileMessage
  | WorkerComputeClimateMessage
  | WorkerComputeHydrologyMessage
  | WorkerComputeEcologyMessage
  | WorkerComputeMigrationMessage
  | WorkerSerializeWorldMessage
  | WorkerRestoreWorldMessage
  | WorkerArcheanInitMessage
  | WorkerArcheanStartMessage
  | WorkerResetTectonicsMessage
  | WorkerArcheanStopMessage
  | WorkerArcheanFinalizeMessage
  | WorkerArcheanResetMessage

// --- Archean phase (see docs/decisions/archean-genesis.md) ---
// Its own message family rather than reusing init/start/stop, because the Archean
// runs on a different state type (no plates exist yet) and a different clock.
export interface WorkerArcheanInitMessage {
  type: 'archeanInit'
  seed: string
  width: number
  height: number
  renderOptions: RenderSimulationOptions
  epochIntervalMs: number
  // Mantle mixing per epoch — the "mantle vigour" knob (ArcheanParams.diffusion).
  // Less stirring leaves a finer-grained field, so more and smaller cratons and
  // plates; more stirring collects crust into fewer, larger continents.
  //
  // This used to be createMantleField's INITIAL smoothing, which measurement showed
  // washes out long before the phase is stopped. See DEFAULT_INITIAL_SMOOTHING.
  mantleDiffusion?: number
  // Water offset in elevation units (see elevationScale.WATER_OFFSET_MAX_M).
  seaLevelOffset?: number
}
export interface WorkerArcheanStartMessage { type: 'archeanStart' }
// Tectonics back to the state the Archean handed it, epoch 0 — the panel's own input,
// not a new world. A reset inside a panel undoes that panel's work and nothing else;
// the erosion panel's reset already worked that way, this one did not (it re-ran
// `regenerate`, which restarts the Archean from an epoch with no crust at all, so
// every continent vanished).
export interface WorkerResetTectonicsMessage { type: 'resetTectonics' }
export interface WorkerArcheanStopMessage { type: 'archeanStop' }
// Ends the Archean and hands the world to the tectonic phase. Not reachable by
// accident: the panel only sends it when the next phase is started.
export interface WorkerArcheanFinalizeMessage { type: 'archeanFinalize' }
// Back to a fresh Archean with the same seed, discarding any tectonic state.
export interface WorkerArcheanResetMessage { type: 'archeanReset' }

// Sent with every Archean render: the readouts the Genesis panel shows.
export interface WorkerArcheanStatusMessage {
  type: 'archeanStatus'
  epoch: number
  worldAgeMa: number
  crustFraction: number
  // Share of crust past the stabilisation age — the phase's progress indicator.
  // Below ~0.2 nothing has settled; 0.4-0.7 is the window where separate cratons
  // exist and still move; above ~0.85 the world only accumulates land.
  stabilisedFraction: number
  cratonCount: number
}

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
  // Coarse crust-age field (Float32, mantleResX*mantleResY; -1 = ocean, else 0..1
  // with 1 = formed at epoch 0) for the "Craton age" overlay. See
  // computeCratonOldnessField, which the Ecology layer also reads for iron.
  //
  // Deliberately on the MANTLE grid rather than the finer climate one: this is the
  // Archean's per-epoch layer, and the crust it describes is made of blobs 70 world
  // pixels across — about 4.4 cells here — so a finer grid would resolve nothing the
  // eye can use while costing four times the work and transfer every epoch.
  cratonAge: ArrayBuffer
  // Coarse elevation (Float32, CLIMATE_RES_X*CLIMATE_RES_Y) purely so the hover
  // readout can report a height in metres for the cell under the cursor. Center-
  // sampled off the full-res field at the climate grid, which is the same
  // resolution — and the same sampler — every climate module already reads
  // elevation at, so a hovered value matches what temperature/precipitation
  // actually saw. Coarse deliberately: the full-res f32 raster is 8 MB, and
  // re-slicing that every epoch to keep a live tooltip fed is not worth it, while
  // regional heights (is this plateau really ~360 m? is that basin at -5700?) are
  // exactly what the readout is for. Per-pixel peak heights belong in a dump
  // script, not a tooltip.
  elevation: ArrayBuffer
  elevationResX: number
  elevationResY: number
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
  // boundaries, names, and event markers on top of `buffer`).
  // Full-res plate-boundary mask (1 = on a Voronoi edge), as raw bytes.
  boundaryMask: ArrayBuffer
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

// Debug aid for the erosion panel: which sea-floor cells the erosion pass raised,
// i.e. where rivers dropped their sediment. Sent after every erode so the map can
// mark them, because the deltas are ~0.24% of the grid and finding them by eye on a
// 2048×1024 map is not realistic. Uint8, full-res, 1 = raised.
export interface WorkerDeltaMaskMessage {
  type: 'deltaMask'
  mask: ArrayBuffer
}

// The finished micro tile: a baked RGBA image (n×n — hypsometric ramp,
// hillshade, river tint; see render/microTileImage.ts) plus where the window
// sits in world coordinates, so the viewer can caption it.
export interface WorkerMicroTileDataMessage {
  type: 'microTileData'
  buffer: ArrayBuffer
  n: number
  x0: number
  y0: number
  extentMacro: number
  factor: number
  mouthX: number
  mouthY: number
}
// Coarse progress for the viewer's label — macro routing, then one tick per
// tile-erosion round. fraction -1 signals an aborted request (another
// long-running render holds the worker, or the world has no river mouth) so
// the screen can release its busy state instead of waiting forever.
export interface WorkerMicroTileProgressMessage {
  type: 'microTileProgress'
  fraction: number
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
  // Present instead of `snapshot` when the world is still in the Archean — the phase is
  // a pause, so it has to be savable, and there is no PlateSimulation yet to snapshot.
  archean?: { snapshot: ArcheanSnapshot; mantle: ArrayBuffer; streak: ArrayBuffer }
  snapshot: PlateSimulationSnapshot
  // The mantle field, saved rather than regenerated: it is what the plate motions
  // were fitted to, and what finalizeArchean read to place the plates in the first
  // place. Restoring a world with a fresh random field left the plates drifting
  // against a mantle that never produced them.
  mantle: ArrayBuffer
  // See WorkerRestoreWorldMessage.lattice — the other half of a faithful continuation.
  latticeAccumulated: ArrayBuffer
  latticeLockedEpochs: ArrayBuffer
  latticeLastClassCode: ArrayBuffer
  oceanAge: ArrayBuffer
  elevation: ArrayBuffer
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
// an 'erode' request needs (see WorkerErodeMessage). Kept up to date by
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

// The cache-invalidation rules, named. They used to be loose assignments spread
// across the render path and the message branches, which meant the rules only
// existed as "whatever those lines happen to do" — the single riskiest thing
// about this file's ~24 pieces of module state. Naming them puts each rule in one
// place and makes a caller state its intent rather than its mechanism.

// New terrain: the drainage network has to be re-routed, and the last erosion's
// basin snapshot no longer describes it.
function invalidateAfterTopographyChange(): void {
  hydrologyDirty = true
  lastLakeBasinElevations = null
}

// New climate: rivers take their water from precipitation, so the discharge is
// stale even though the terrain hasn't moved.
function invalidateAfterClimateChange(): void {
  hydrologyDirty = true
}
// Carrying-capacity field cached from the last computeEcology — the initial-
// migration step reads it as the population/density driver.
let lastEcologyCarryingCapacity: Float32Array | null = null

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
  invalidateAfterTopographyChange()
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
    cratonAge: computeCratonOldnessField(sim.rafts, sim.epoch, MANTLE_RES_X, MANTLE_RES_Y, sim.width, sim.height).buffer as ArrayBuffer,
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
  self.postMessage(message, [message.buffer, message.relief, message.mantle, message.elevation, message.boundaryMask])
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
    renderPool,
    renderOptions,
  )
  if (gen !== worldGeneration || !archean) return
  lastRawElevations = result.rawElevations
  invalidateAfterTopographyChange()

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
  self.postMessage(message, [message.buffer, message.relief, message.mantle, message.elevation, message.boundaryMask])

  const status: WorkerArcheanStatusMessage = {
    type: 'archeanStatus',
    epoch: archean.epoch,
    worldAgeMa: worldAgeMa(archean.epoch, 0),
    crustFraction: result.landFraction,
    stabilisedFraction: stabilisedFraction(archean.rafts, archean.epoch, DEFAULT_ARCHEAN_PARAMS.stabilisationEpochs),
    cratonCount: archean.rafts.length,
  }
  self.postMessage(status)
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
  postDeltaMask(rawElevations, erosionResult.elevations)
}

// Was under water before this pass and is measurably higher after it. The 10 m floor
// keeps out numerical dust (it also used to filter runThermalErosion's coastal talus
// spill, but thermal is land-only since 2026-08-06 — see its own comment), so what
// remains is deposition. rawElevations is safe to read: runErosionPass copies it
// before touching anything.
const DELTA_MARK_MIN_M = 10
function postDeltaMask(raw: Float32Array, eroded: Float32Array): void {
  const threshold = metersToElevation(DELTA_MARK_MIN_M)
  const mask = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] <= SEA_LEVEL && eroded[i] - raw[i] > threshold) mask[i] = 1
  }
  const message: WorkerDeltaMaskMessage = { type: 'deltaMask', mask: mask.buffer as ArrayBuffer }
  self.postMessage(message, [message.mask])
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

function handleStart(): void {
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

function handleStop(): void {
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

function handleErode(message: Extract<WorkerInboundMessage, { type: 'erode' }>): void {
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
}

function handleStopErosion(): void {
  // The in-flight runErosionPass polls this and returns its partial result.
  erosionStopRequested = true
}

// The micro-tile debug inspector (see WorkerComputeMicroTileMessage). Runs on
// whatever terrain is currently shown (lastRawElevations — post-erosion if an
// erode ran), inherits the macro erosion's carving as a correction against
// preErosionElevations, and guards with renderInFlight like 'erode' so the two
// long-running requests can't interleave. Purely derived output: no worker
// state changes, nothing invalidated.
function handleComputeMicroTile(): void {
  const postProgress = (fraction: number): void => {
    const progress: WorkerMicroTileProgressMessage = { type: 'microTileProgress', fraction }
    self.postMessage(progress)
  }
  if (!sim || !lastRawElevations || renderInFlight) {
    postProgress(-1)
    return
  }
  const currentSim = sim
  const macroElevations = lastRawElevations
  renderInFlight = true
  ;(async () => {
    const { width, height } = currentSim
    postProgress(0)
    // Fresh macro routing on the current terrain — plain cell-count
    // accumulation (what the erosion thresholds are calibrated in), NOT the
    // hydrology cache's precipitation-weighted discharge.
    const macroRouting = await fillDepressionsAndRouteFlow(macroElevations, width, height, SEA_LEVEL)
    const macroAccumulation = accumulateFlow(macroRouting)
    postProgress(0.2)
    const mouth = pickLargestRiverMouth(macroElevations, macroAccumulation, width, height)
    if (!mouth) {
      postProgress(-1)
      return
    }
    const spec = { x0: mouth.x - MICRO_TILE_EXTENT_MACRO / 2, y0: mouth.y - MICRO_TILE_EXTENT_MACRO / 2, extentMacro: MICRO_TILE_EXTENT_MACRO, factor: MICRO_TILE_FACTOR }
    const n = spec.extentMacro * spec.factor
    // Macro erosion's carving, inherited as a low-frequency correction. Same
    // object means no erosion has run yet — the correction is simply zero.
    const macroDelta = preErosionElevations && preErosionElevations !== macroElevations
      ? (() => {
          const diff = new Float32Array(width * height)
          for (let i = 0; i < diff.length; i++) diff[i] = macroElevations[i] - preErosionElevations![i]
          return { field: diff, width, height }
        })()
      : undefined
    const world = { width, height, rafts: currentSim.rafts, features: currentSim.features, oceanAge: currentSim.oceanAge, warpSeed: currentSim.warpSeed, seaLevelOffset: currentSim.seaLevelOffset }
    const envelope = buildTileElevation(world, spec, macroDelta)
    burnMacroTrunks(envelope, spec, macroElevations, macroAccumulation, width, height)
    const inflow = buildTileInflow(spec, macroRouting.flowTarget, macroAccumulation, width, height)
    const params = scaleErosionParamsForTile(DEFAULT_EROSION_PASS_PARAMS, spec.factor)
    const tile = await runTileErosion(envelope, n, params, inflow, (round, rounds) => postProgress(0.2 + 0.7 * (round / rounds)))
    // Delta growth (deltaGrowth.ts): the fan-building pass on top of the
    // eroded tile, then a routing re-derivation so the river tint traces the
    // channels the walkers kept open between the grown bars. Seed fixed per
    // world — same tile, same fan.
    const entry = pickDeltaEntry(tile.elevations, tile.accumulation, n)
    let tileAccumulation = tile.accumulation
    if (entry) {
      growDelta(tile.elevations, envelope, n, { x: entry.x, y: entry.y }, { x: entry.headingX, y: entry.headingY }, (currentSim.warpSeed ^ 0x5eedde17) >>> 0)
      postProgress(0.95)
      const grownRouting = await fillDepressionsAndRouteFlow(tile.elevations, n, n, SEA_LEVEL, undefined, true)
      tileAccumulation = accumulateFlow(grownRouting, inflow)
    }
    // River tint threshold: the same 60-macro-cell drainage the map's own
    // river extraction regards as a stream, in fine-cell units.
    const rgba = renderMicroTileImage(tile.elevations, tileAccumulation, n, spec.factor, 60 * spec.factor * spec.factor)
    const message: WorkerMicroTileDataMessage = {
      type: 'microTileData',
      buffer: rgba.buffer as ArrayBuffer,
      n,
      x0: spec.x0,
      y0: spec.y0,
      extentMacro: spec.extentMacro,
      factor: spec.factor,
      mouthX: mouth.x,
      mouthY: mouth.y,
    }
    self.postMessage(message, [message.buffer])
  })().finally(() => {
    renderInFlight = false
  })
}

function handleResetErosion(): void {
  if (!sim || !preErosionElevations || renderInFlight) return
  renderInFlight = true
  renderAndPost(preErosionElevations).finally(() => {
    renderInFlight = false
  })
}

function handleComputeClimate(message: Extract<WorkerInboundMessage, { type: 'computeClimate' }>): void {
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
  invalidateAfterClimateChange()
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
}

function handleComputeHydrology(message: Extract<WorkerInboundMessage, { type: 'computeHydrology' }>): void {
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
}

function handleComputeEcology(message: Extract<WorkerInboundMessage, { type: 'computeEcology' }>): void {
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
}

function handleComputeMigration(message: Extract<WorkerInboundMessage, { type: 'computeMigration' }>): void {
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
    }
    self.postMessage(message, [message.archean!.mantle, message.archean!.streak, message.elevation])
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
  const worldMessage: WorkerWorldDataMessage = {
    type: 'worldData',
    snapshot: serializePlateSimulation(sim),
    mantle: mantle.buffer as ArrayBuffer,
    latticeAccumulated: accumulated.buffer as ArrayBuffer,
    latticeLockedEpochs: locked.buffer as ArrayBuffer,
    latticeLastClassCode: lastClass.buffer as ArrayBuffer,
    oceanAge: oceanAge.buffer as ArrayBuffer,
    elevation: elevation.buffer as ArrayBuffer,
  }
  self.postMessage(worldMessage, [worldMessage.mantle, worldMessage.latticeAccumulated, worldMessage.latticeLockedEpochs, worldMessage.latticeLastClassCode, worldMessage.oceanAge, worldMessage.elevation])
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

function handleArcheanInit(message: Extract<WorkerInboundMessage, { type: 'archeanInit' }>): void {
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

function handleArcheanStart(): void {
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
function handleArcheanStop(): void {
  stopTicking()
  if (archean && !renderInFlight) {
    renderInFlight = true
    renderArcheanAndPost(1).finally(() => { renderInFlight = false })
  }
}

// Plate tectonics begins. The Archean state is dropped: everything worth keeping
// (the rafts, their ages, the mantle field, the epoch count for the world clock)
// is carried into the PlateSimulation by finalizeArchean.
function handleArcheanFinalize(): void {
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

function handleResetTectonics(): void {
  // Nothing to go back to on a world that was loaded from a file rather than grown
  // here — the save carries the world as it stood, not the hand-over behind it.
  if (!handoverSnapshot || !handoverOceanAge || !handoverMantle) return
  stopTicking()
  // Fresh copies each time, so a second reset restores the same state as the first
  // rather than whatever the last run left in the buffers.
  sim = deserializePlateSimulation(handoverSnapshot, handoverOceanAge.slice(), handoverMantle.slice())
  lastRawElevations = null
  preErosionElevations = null
  lastLakeBasinElevations = null
  hydrologyDirty = true
  // No initial events under the raft model — a continent is a raft spanning
  // several plates, so there's no per-plate "continent created" moment to
  // announce at handover/reset; real continent events (collision/breakup/
  // supercontinent) only ever arrive from stepEpoch's own raft lifecycle.
  pendingEvents = []
  void renderAndPost()
}

function handleArcheanReset(): void {
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
const HANDLERS: { [K in WorkerInboundMessage['type']]: (message: WorkerInboundMessage) => void } = {
  start: () => handleStart(),
  stop: () => handleStop(),
  erode: (m) => handleErode(m as Extract<WorkerInboundMessage, { type: 'erode' }>),
  stopErosion: () => handleStopErosion(),
  resetErosion: () => handleResetErosion(),
  computeMicroTile: () => handleComputeMicroTile(),
  computeClimate: (m) => handleComputeClimate(m as Extract<WorkerInboundMessage, { type: 'computeClimate' }>),
  computeHydrology: (m) => handleComputeHydrology(m as Extract<WorkerInboundMessage, { type: 'computeHydrology' }>),
  computeEcology: (m) => handleComputeEcology(m as Extract<WorkerInboundMessage, { type: 'computeEcology' }>),
  computeMigration: (m) => handleComputeMigration(m as Extract<WorkerInboundMessage, { type: 'computeMigration' }>),
  serializeWorld: () => handleSerializeWorld(),
  restoreWorld: (m) => handleRestoreWorld(m as Extract<WorkerInboundMessage, { type: 'restoreWorld' }>),
  archeanInit: (m) => handleArcheanInit(m as Extract<WorkerInboundMessage, { type: 'archeanInit' }>),
  resetTectonics: () => handleResetTectonics(),
  archeanStart: () => handleArcheanStart(),
  archeanStop: () => handleArcheanStop(),
  archeanFinalize: () => handleArcheanFinalize(),
  archeanReset: () => handleArcheanReset(),
}

self.onmessage = (event: MessageEvent<WorkerInboundMessage>) => {
  HANDLERS[event.data.type](event.data)
}
