// The generator pipeline's message contract — every message that crosses the
// worker boundary, in both directions. Kept apart from the pipeline itself so a
// consumer (WorldGenScreen) can import the vocabulary without importing the
// machine, and so the contract is readable as one document.
//
// See docs/design/generator-pipeline.md.
import type { SimEvent, PlateSimulationSnapshot } from '../tectonics/plateSimulation'
import type { RenderSimulationOptions } from '../render/elevationMapImage'
import type { ContinentLabelPlacement } from '../render/continentLabelRenderer'
import type { ArcheanSnapshot } from '../archean/archeanSnapshot'
import type { MigrationOrigin } from '../migration/migrationField'
import type { StageId } from './stages'

export interface WorkerTectonicsStartMessage {
  type: 'tectonicsStart'
}
export interface WorkerTectonicsStopMessage {
  type: 'tectonicsStop'
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
export interface WorkerErosionStartMessage {
  type: 'erosionStart'
  // The v2 engine's landscape age in iterations — the central control: young
  // keeps inherited relief and sharp valleys, old approaches the denuded
  // equilibrium. Absent → the slider's declared default.
  age?: number
  // Settling-length scale 0..100 (50 neutral): more alluvium = broader
  // valley floors and bigger deltas.
  alluvium?: number
  // Lithology contrast 0..100 (50 neutral = σ 1.4).
  rockContrast?: number
  // The climate panel's parameters in MODEL units (climate/weather.ts), the
  // stage-2 coupling: the engine's water forcing evaluates the weather
  // chain with these, so the panel's sliders shape where valleys carve.
  // Absent → the declared defaults (an old caller, or a headless one).
  weather?: {
    temperatureOffset: number
    temperatureContrast: number
    humidity: number
    equatorOffset: number
  }
}
// PUT A STAGE BACK WHERE IT STARTED. One gesture for what used to be three
// unrelated messages (resetErosion, resetTectonics, archeanReset), because they
// were three spellings of one idea and the fourth, fifth and sixth stage had no
// spelling at all.
//
// What "back where it started" means is stage-specific — the Archean rebuilds from
// its seed, tectonics returns to the hand-over, erosion re-renders the terrain it
// was handed — but what follows is not: everything downstream is discarded, from
// the declared chain. See docs/design/generator-pipeline.md, "Reset: the taxonomy".
//
// This is the STATE reset. The input reset (sliders back to their declared
// defaults) is a screen-side gesture: the pipeline never held the inputs.
export interface WorkerResetStageMessage {
  type: 'resetStage'
  stage: StageId
}
// Requests the in-flight erosion pass stop at the next round boundary. The partial
// result is kept (lastRawElevations), so a later 'erosionStart' continues from there.
export interface WorkerErosionStopMessage {
  type: 'erosionStop'
}
// Requests the climate step (temperature so far) be computed on the current,
// possibly-eroded elevation — see docs/decisions/climate-biomes.md. Replies
// with a WorkerClimateDataMessage.
export interface WorkerClimateRunMessage {
  type: 'climateRun'
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
// No parameters since the density slider died (erosion-v2 P4/teardown): the
// whole stage runs at the model's CANONICAL_RIVER_DENSITY. Routing + discharge
// are cached in the worker, so a repeat call without a topography change is
// cheap. Replies with WorkerHydrologyDataMessage.
export interface WorkerHydrologyRunMessage {
  type: 'hydrologyRun'
}
// Requests an ecology (resource/suitability) compute on the current climate. Uses
// the cached climate temperature+precipitation as the productivity inputs and the
// sim's volcanoes for the province layer. PHASE 1: the carrying-capacity field
// only. Replies with WorkerEcologyDataMessage. See docs/decisions/ecology.md.
export interface WorkerEcologyRunMessage {
  type: 'ecologyRun'
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
export interface WorkerMigrationRunMessage {
  type: 'migrationRun'
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
  | WorkerTectonicsStartMessage
  | WorkerTectonicsStopMessage
  | WorkerErosionStartMessage
  | WorkerResetStageMessage
  | WorkerErosionStopMessage
  | WorkerRequestElevationFieldMessage
  | WorkerClimateRunMessage
  | WorkerHydrologyRunMessage
  | WorkerEcologyRunMessage
  | WorkerMigrationRunMessage
  | WorkerSerializeWorldMessage
  | WorkerRestoreWorldMessage
  | WorkerGenesisInitMessage
  | WorkerGenesisStartMessage
  | WorkerGenesisStopMessage
  | WorkerGenesisFinalizeMessage

// --- Archean phase (see docs/decisions/archean-genesis.md) ---
// Its own message family rather than reusing init/start/stop, because the Archean
// runs on a different state type (no plates exist yet) and a different clock.
export interface WorkerGenesisInitMessage {
  type: 'genesisInit'
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
export interface WorkerGenesisStartMessage { type: 'genesisStart' }
// The screen's 3D relief preview asking for the current full-res
// display-space elevation raster (answered with WorkerElevationFieldMessage).
// On demand rather than piggybacked on every 'rendered' message: the raster
// is 8 MB, and most renders happen while the preview has no use for it
// (pre-erosion epoch stepping, the Archean).
export interface WorkerRequestElevationFieldMessage { type: 'requestElevationField' }
// Answer to 'requestElevationField': the full-res display-space elevation
// raster (Float32, width*height, signed -1..1 with 0 = sea level) the current
// map frame was colored from. Display-space (redistributed), NOT the raw
// physical field — so a mesh displaced by it matches the 2D picture.
export interface WorkerElevationFieldMessage {
  type: 'elevationField'
  elevation: ArrayBuffer
  width: number
  height: number
}
// Tectonics back to the state the Archean handed it, epoch 0 — the panel's own input,
// not a new world. A reset inside a panel undoes that panel's work and nothing else;
// the erosion panel's reset already worked that way, this one did not (it re-ran
// `regenerate`, which restarts the Archean from an epoch with no crust at all, so
// every continent vanished).
export interface WorkerGenesisStopMessage { type: 'genesisStop' }
// Ends the Archean and hands the world to the tectonic phase. Not reachable by
// accident: the panel only sends it when the next phase is started.
export interface WorkerGenesisFinalizeMessage { type: 'genesisFinalize' }
// Back to a fresh Archean with the same seed, discarding any tectonic state.

// Sent with every Archean render: the readouts the Genesis panel shows.
export interface WorkerGenesisStatusMessage {
  type: 'genesisStatus'
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
  // True for the once-per-round redraws an 'erosionStart' request posts while
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
// per engine onProgress callback — that would be one per
// iteration) while an 'erosionStart' request is in flight; nothing is sent
// for 'resetErosion', since that's a single already-computed render with
// no meaningful sub-progress of its own.
// A stage was asked to run and DECLINED, because something it reads is not there.
//
// Every compute handler has an early return for a missing upstream result, and
// until now those returns were silent: the screen had set its in-flight flag,
// disabled the controls and started waiting for a result that would never come.
// WorldGenScreen carried a comment about exactly this ("the worker no-ops without
// it, which would leave ecologyInFlight stuck") and guarded ONE of the five cases
// by mirroring the worker's state — which is the kind of guard that only holds
// while both copies agree.
//
// Saying so instead makes the whole class go away: the screen releases whatever
// it was waiting for, and the reason is a stage id rather than a string to parse.
export interface WorkerStageDeclinedMessage {
  type: 'stageDeclined'
  stage: StageId
  // The upstream stage whose result is missing, when that is what stopped it.
  // Absent when the reason is not a missing result — the pipeline being busy, or
  // there being no world at all yet.
  needs?: StageId
}

// The v1 pass reported four named phases here; the v2 engine is one implicit
// solve, so the fraction is the whole story (the `phase` field left with the
// pass in the P5 teardown — the screen only ever drew the fraction).
export interface WorkerErosionProgressMessage {
  type: 'erosionProgress'
  fraction: number
}

// The computed climate rasters (coarse grid — see climate/climateField.ts).
// Grows per phase.
export interface WorkerClimateDataMessage {
  type: 'climateData'
  // Set when this is the hydrology's climate REFINEMENT (v2) rather than a fresh
  // compute: same world, same settings, corrected for the terminal basins that
  // turned out to be dry land. A fresh climate stales everything downstream of it;
  // this one does not, because the pass that produced it is recomputing that
  // downstream work itself, right now. Without the distinction the screen would
  // tear down its own river display in the middle of building it.
  refinement?: boolean
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
  //
  // The one field here that is NOT on resX/resY: it is FULL-RES (world raster),
  // like discharge and watersheds below. The classification is pointwise and its
  // sharpest input — elevation — exists at full res, so evaluating it there costs
  // one pass and is what gives mountains a treeline instead of an all-or-nothing
  // 62 km alpine cell. Every field around it stays regional and coarse.
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
  // (Uint8, full-res — replaces the climate step's water-free biomes, and shares
  // its resolution so the display never switches grids mid-run). Classified at
  // the CANONICAL channel density, not the draw slider's, so like lakeDepth it
  // only arrives on a re-route — a density-only pass sends it empty, meaning
  // "biomes unchanged". See computeRiparianBiomes.
  biomes: ArrayBuffer
  // The precipitation those biomes were classified FROM: the climate grid's
  // annual total plus the riparian bonus (Float32, coarse, OCEAN_PRECIP on
  // ocean). Saved so a consumer can reproduce the classification at its own
  // resolution without owning a drainage network — see computeRiparianBiomes.
  precipitationEffective: ArrayBuffer
  // Watershed labels (Uint16, full-res, 0 = unlabelled) and the raw discharge
  // field (Float32, full-res) + its land maximum — the watershed overlay and
  // the map hover's flow readout. Re-route only, like lakeDepth.
  watersheds: ArrayBuffer
  discharge: ArrayBuffer
  maxDischarge: number
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
  // The erosion engine's two coarse forcing fields (Float32, forcingResX ×
  // forcingResY — the climate grid), derived from the live sim at save time
  // and persisted as save layers: the amplification bake erodes with the
  // engine and needs U and the crust-history hardness, but must not carry
  // the simulation (docs/design/erosion-v2.md, P3). Empty in the Archean
  // branch — there is no plate sim to derive them from, and a pre-tectonic
  // save cannot be baked anyway.
  uplift: ArrayBuffer
  erodibility: ArrayBuffer
  forcingResX: number
  forcingResY: number
}

// The other direction, which had no union at all: WorldGenScreen listed the twelve
// types by hand in its `onmessage` signature, so adding a thirteenth changed
// nothing and compiled — the new message simply never reached a handler. The
// inbound side has had `WorkerInboundMessage` and its exhaustive HANDLERS table
// all along; this is the same guarantee for results.
export type WorkerOutboundMessage =
  | WorkerRenderedMessage
  | WorkerErosionProgressMessage
  | WorkerClimateDataMessage
  | WorkerHydrologyDataMessage
  | WorkerEcologyDataMessage
  | WorkerMigrationDataMessage
  | WorkerWorldDataMessage
  | WorkerGenesisStatusMessage
  | WorkerElevationFieldMessage
  | WorkerStageDeclinedMessage
