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
import type { ArcheanSnapshot } from '../archean/archeanSnapshot'
import type { PlateSimulationSnapshot, SimEvent } from '../tectonics/plateSimulationTypes'
import type { SavedField } from '../fields/fieldMesh'
import type { WeatherParams } from '../climate/weather'
import type { ClimateCellValues } from '../climate/climatePoints'
import type { RefinedClimate, RefinedReliability, RefinedStorms } from '../climate/refinement'
import type { RefinedClimateChart } from '../climate/climateChart'
import type { PlanetForcing } from '../planet/planetForcing'
import type { WaterBody } from '../surface/hydrology'
import type { RiverGraph } from '../surface/riverGraph'
import type { CoastReach } from '../surface/coastGraph'
import type { SedimentBasin } from '../surface/sedimentBasins'
import type { EcologyParams } from '../ecology/ecologyField'
import type { ClimateParams } from './worldStages'

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
  // The Archean.
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
}

export type Shape = 'torus' | 'sphere'

// The constructors of a world.
export interface EngineWorlds {
  genesis(seed: string, width: number, height: number, shape: Shape, diffusion: number, landShare: number): EngineWorld
  restoreArchean(shape: Shape, snapshot: ArcheanSnapshot, mantle: SavedField, streak: Int16Array, diffusion: number, landShare: number): EngineWorld
  restorePlates(shape: Shape, snapshot: PlateSimulationSnapshot, oceanAge: SavedField, mantle: SavedField | null, lattice: LatticeState | null, mesh: EngineMeshPayload | null): EngineWorld
}

// What both bindings give.
export interface Engine {
  version(): string
  World: EngineWorlds
}

// Gives a world's memory back now. The WASM binding's objects live in its
// linear memory until freed; napi's go with the garbage collector and have
// no `free`.
export function releaseWorld(world: EngineWorld): void {
  ;(world as { free?: () => void }).free?.()
}
