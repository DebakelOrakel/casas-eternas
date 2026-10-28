// The Rust engine as TypeScript sees it (docs/decisions/rust-engine.md,
// fork 6): its classes with the generator's types. Both bindings give these
// classes — `wasm-bindgen` in the browser (engineWasm.ts), napi in Node
// (scripts/engineNative.ts) — and both give the same values; the engine's
// smoke test (engine/scripts/smoke.mjs) compares them with the TypeScript
// engine's.
//
// A world is an object in the engine (fork 6a): it holds the simulation,
// the terrain, the field meshes with their walks and the stages' results.
// What crosses are copies: the bodies of the runtime's messages with typed
// arrays where a message holds their buffers, and the save's parts as the
// world layer writes them (fork 6c).
//
// The job worker computes on the native build; the runtime changes over
// next (fork 5).
import type { ArcheanSnapshot } from '../archean/archeanSnapshotTypes'
import type { PlateSimulationSnapshot, SimEvent } from '../tectonics/plateSimulationTypes'
import type { SavedField } from '../fields/fieldMesh'
import type { WeatherParams } from '../climate/weather'
import type { ClimateCellValues } from '../climate/climatePoints'
import type { RefinedClimate, RefinedReliability, RefinedStorms } from '../climate/refinement'
import type { RefinedClimateChart } from '../climate/climateChart'
import type { PlanetForcing } from '../planet/planetForcing'
import type { WaterBody } from '../surface/hydrology'
import type { RiverGraph, SerializedRiverGraph } from '../surface/riverGraph'
import type { CoastReach } from '../surface/coastGraph'
import type { SedimentBasin } from '../surface/surfaceTypes'
import type { EcologyParams } from '../ecology/ecologyField'
import type { ReplayPlan } from './replayPlan'

// The climate's controls (the climate panel's and the planet's).
export interface ClimateParams {
  temperatureOffset: number
  temperatureContrast: number
  humidity: number
  equatorOffset: number
  planet?: PlanetForcing
}

// The history's controls for one coupled epoch (the runtime's
// `historyControls`).
export interface EpochControls {
  alluvium: number
  rockContrast: number
  weather: WeatherParams
}

// The Archean as the save holds it (the runtime's `serializeWorld` in the
// Archean).
export interface ArcheanSave {
  snapshot: ArcheanSnapshot
  mantle: SavedField
  streak: Int16Array
}

// The coupled terrain as the save's bytes (`MeshPayload` with its arrays).
export interface EngineMeshPayload {
  count: number
  nodes: Float32Array
  connectivity: Uint8Array
  z: Float32Array
  column?: Uint8Array
  sedimentFlux?: Float32Array
  preErosionZ?: Float32Array
  ice?: Float32Array
}

// The land fields per node of the terrain mesh as the save holds them
// (`LandPayload` with its arrays); the hydrology's null before it ran.
export interface EngineLandPayload {
  count: number
  biome: Uint8Array
  koppen: Uint8Array
  waterTable: Float32Array | null
  discharge: Float32Array | null
  lakeBody: Int32Array | null
}

// The detection lattice's state (the plate simulation's `lattice*`).
export interface LatticeState {
  accumulated: Float32Array
  lockedEpochs: Int16Array
  lastClassCode: Int8Array
}

// A render's rasters: the raw elevation on the world raster (or the live
// preview's coarser grid) and the mantle on its chart raster.
export interface EngineRender {
  elevations: Float32Array
  mantle: Float32Array
}

// A vector field on the climate's field mesh (`windMesh`, `currentsMesh`).
export interface MeshVectors {
  cells: number
  spacingM: number
  e: Float64Array
  s: Float64Array
}

// `WorkerClimateDataMessage` less its type, flags and resolution.
export interface ClimateBody {
  temperature: Float32Array
  wind: Float32Array
  windMesh: MeshVectors
  currents: Float32Array
  currentsMesh: MeshVectors
  currentAnomaly: Float32Array
  precipitation: Float32Array
  seasonalAmplitude: Float32Array
  monsoonIndex: Float32Array
  koppen: Uint8Array
  biomes: Uint8Array
}

// `WorkerClimateRefinedMessage` less its type and resolution.
export type ClimateRefinedBody = Omit<RefinedClimateChart, 'reliability' | 'storms'> & RefinedReliability & RefinedStorms & {
  refined: Omit<RefinedClimate, 'solves'>
  koppen: Uint8Array
}

// `WorkerHydrologyDataMessage` less its type, with the river graph as the
// world layer serializes it, and what the runtime posts with it: the v2's
// climate and the render after the route (null on a pass that reuses the
// route).
export interface HydrologyBody {
  riverPoints: Float32Array
  riverLengths: Uint32Array
  riverRegimes: Uint8Array
  lakeDepth: Float32Array
  biomes: Uint8Array
  precipitationEffective: Float32Array
  watersheds: Uint16Array
  discharge: Float32Array
  maxDischarge: number
  waterBodies: WaterBody[] | null
  waterLevel: Float32Array
  waterSurface: Uint8Array
  riverGraph: RiverGraph | null
  coastType: Uint8Array
  coast: { reaches: CoastReach[]; nodes: Int32Array } | null
  sedimentBasins: SedimentBasin[] | null
  iceThickness: Float32Array
  climate: ClimateBody | null
  render: { mantle: Float32Array; dryBasin: Uint8Array; saltFlat: Uint8Array } | null
}

// `WorkerEcologyDataMessage` less its type.
export interface EcologyBody {
  resX: number
  resY: number
  fields: { id: string; data: Float32Array }[]
  fine: { resX: number; resY: number; fields: { id: string; data: Uint8Array }[] }
}

// `WorkerEcologyMonthDataMessage` less its type.
export interface EcologyMonthBody {
  field: string
  month: number
  resX: number
  resY: number
  data: Uint8Array
}

// A world in the engine. Each method is one of the runtime's steps; the
// ones that move a field mesh's walk must come in the runtime's order (a
// render before the stages that read its raster).
export interface EngineWorld {
  // The Archean; its controls from the next step on.
  setArcheanControls(diffusion: number, landShare: number): void
  archeanStep(): void
  readonly archeanEpoch: number
  readonly raftCount: number
  archeanSave(): ArcheanSave
  // Either era.
  mantle(): Float64Array
  render(scale: number): EngineRender
  // The hand-over, then the history.
  finalize(): void
  epoch(controls: EpochControls): SimEvent[]
  snapshot(): PlateSimulationSnapshot
  // The mantle's and the ocean age's saved values, in this order.
  savedFields(): [SavedField, SavedField]
  lattice(): LatticeState
  // The erosion's coarse forcing on the climate's chart, as a reader of
  // the save derives it from the snapshot (`Engine.forcingOfSnapshot`).
  forcing(): { uplift: Float32Array; hardness: Float32Array }
  meshPayload(): EngineMeshPayload
  // The climate's cells, null before the climate ran; the land fields,
  // null while no climate is at the terrain mesh's nodes.
  climatePayload(): ClimateCellValues | null
  landPayload(): EngineLandPayload | null
  // The world stages.
  climate(params: ClimateParams): ClimateBody
  refineClimate(restored: RefinedClimate | null): { refined: ClimateRefinedBody; annual: ClimateBody }
  hydrology(planet: PlanetForcing | null): HydrologyBody
  ecology(params: EcologyParams): EcologyBody
  ecologyMonth(field: string, month: number): EcologyMonthBody
  // A stage's reset: its result dropped, and every result that reads it.
  dropStage(stage: 'climate' | 'hydrology' | 'ecology'): void
}

export type Shape = 'torus' | 'sphere'

// The constructors of a world.
export interface EngineWorlds {
  genesis(seed: string, width: number, height: number, shape: Shape, diffusion: number, landShare: number): EngineWorld
  restoreArchean(shape: Shape, snapshot: ArcheanSnapshot, mantle: SavedField, streak: Int16Array, diffusion: number, landShare: number): EngineWorld
  restorePlates(shape: Shape, snapshot: PlateSimulationSnapshot, oceanAge: SavedField, mantle: SavedField | null, lattice: LatticeState | null, mesh: EngineMeshPayload | null): EngineWorld
}

// A plan's runs made again, one epoch at a time (`replayRuns`); at level
// 0 the history's own budget, whose end is the session's world.
export interface EngineReplay {
  progress(): { done: number; total: number }
  // The next epoch; false past the last.
  step(): boolean
  // The world from the replay's end; the replay ends here.
  world(): EngineWorld
}

// The planet preview's climate on a sample world's raster
// (`elevation`, `width` × `height`): the body of a `climateData` less its
// flags and resolution. Keeps the climate mesh of each size and shape
// between the previews, with its walk.
export interface EnginePreview {
  climate(shape: Shape, width: number, height: number, elevation: Float32Array, params: ClimateParams): ClimateBody
}

// What both bindings give.
export interface Engine {
  version(): string
  // The erosion's coarse forcing of a save's snapshot (DEC-0044, fork 7b):
  // what the world layer reads out of a save, as `EngineWorld.forcing`
  // gives it of a live world.
  forcingOfSnapshot(shape: Shape, snapshot: PlateSimulationSnapshot): { uplift: Float32Array; hardness: Float32Array }
  // The formats of what the engine's results become on a disk (DEC-0044,
  // fork 7b): a level's and a tile's files, `{ name: bytes }` — the
  // artifacts as the world layer types them (world/meshArtifacts.ts,
  // meshTileArtifacts.ts), which generator/ does not import — and the
  // river graph as a level and a save keep it.
  levelFiles(artifact: object): Record<string, Uint8Array>
  tileFiles(artifact: object): Record<string, Uint8Array>
  // And read: a level's arrays and waters, a tile's arrays, from their
  // files — the artifact less what its meta says (its level or tile, its
  // node count).
  levelOfFiles(files: Record<string, Uint8Array>): object
  tileOfFiles(files: Record<string, Uint8Array>): object
  riverGraphParts(graph: RiverGraph): SerializedRiverGraph
  World: EngineWorlds
  Replay: { start(plan: ReplayPlan, level: number): EngineReplay }
  Preview: new () => EnginePreview
}

// Gives a world's memory back now. The WASM binding's objects live in its
// linear memory until freed; napi's go with the garbage collector and have
// no `free`.
export function releaseWorld(world: EngineWorld): void {
  ;(world as { free?: () => void }).free?.()
}
