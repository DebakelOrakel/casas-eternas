import type { EcologyFieldId } from '../generator/ecology/ecologyField'
import { worldTuning } from './worldTuning'
import { ENGINE_CONSTANTS, engineLevelBudget } from '../generator/pipeline/engineConstants'
import { decodeMesh, type SerializedMesh } from '../generator/mesh/meshSerial'
import type { RiverGraph } from '../generator/surface/riverGraph'
import type { RiverPolylines, WaterBody } from '../generator/surface/hydrology'
import { writeArtifactFiles, type ArtifactHandle, type ArtifactKey, type ArtifactStore } from '../storage/ArtifactStore'
import { domainOfKind, type Domain } from '../generator/core/domain'
import { AMPLIFICATION_ALGO_VERSION, derivePipelineVersion } from './identity'
import { AMPLIFY_EROSION_ROUNDS } from './bakeSettings'
import type { WorldEngine } from './query'

// A MESH LEVEL as an artifact (ADAPTIVE_MESH_PLAN.md phase 4.5; decision 3:
// "global level state and tiles are artifacts, evictable"). What the mesh
// bake produces, written to and read back from an ArtifactStore beside the
// raster bake's entries — its own file set, its own pipeline version, the
// stage naming the level (`L1`). Flat file names: the fs store lists one
// level (BUG_BOUNTY 40).
//
// The pipeline version carries the engine's mesh tuning (MESH_TUNING,
// mesh_density.rs) — the density rule is part of what a level IS (decision
// 2) — and the level's budget and rounds: two levels that differ in either
// are different artifacts.

export const MESH_LEVEL_FILES = {
  nodes: 'meshNodes.f32',
  connectivity: 'meshConnectivity.bin',
  z: 'meshZ.f32',
  waterBodies: 'waterBodies.json',
  riverGraph: 'riverGraph.json',
  riverGraphCells: 'riverGraphCells.i32',
  riverGraphPositions: 'riverGraphPositions.f32',
  riverCoursePoints: 'riverCoursePoints.f32',
  riverPoints: 'rivers.f32',
  riverLengths: 'riverLengths.u32',
  riverRegimes: 'riverRegimes.u8',
  meta: 'meta.json',
} as const

export function meshLevelStage(level: number): string {
  return `L${level}`
}

// Every number a mesh bake's output depends on besides the level's own
// budget and rounds, for level 1 and the tiles alike (meshTileArtifacts).
// The amplification's and the density rule's objects whole, then what the
// structure review of 2026-10-01 found outside the key: the lithology
// lattice, two of the engine's module constants, the routing cadence, the
// river course model (its version, the course numbers being inline) and
// the bank-strength table. A change to any of them made different artifacts
// under an unchanged key, which a client then served as current.
export const MESH_BAKE_CONSTANTS: Record<string, number> = {
  // The engine's (generator/pipeline/engineConstants.ts): the amplification's table, the
  // density rule's object, then the bake's loose constants (the lithology
  // lattice, two of the erosion's module constants, the routing cadence,
  // the river course model, the bank-strength table).
  ...ENGINE_CONSTANTS.amplify,
  ...Object.fromEntries(Object.entries(ENGINE_CONSTANTS.tuning.mesh as Record<string, number>).map(([k, v]) => [`mesh_${k}`, v])),
  ...ENGINE_CONSTANTS.bake,
  // The tuning the history reads: level 1 is the history replayed, and
  // the tiles are refined from it (worldTuning.ts).
  ...worldTuning(),
}

// The constants a level's version is derived from — and what its meta
// records, so the version can be recomputed from the meta (it recorded a
// subset until 2026-10-01). Level 1 is the history replayed at its budget
// (world/replay.ts, since 2026-10-01): the history's settings are part of
// what it is, and `replay` parts it from the levels refined before.
export function meshLevelPipelineConstants(level: number, rounds: number = AMPLIFY_EROSION_ROUNDS): Record<string, number> {
  const replay = level === 1
    ? { replay: 1, ...Object.fromEntries(Object.entries(ENGINE_CONSTANTS.tuning.history as Record<string, number>).filter(([k]) => k !== 'budget' && k !== 'renderEvery').map(([k, v]) => [`history_${k}`, v])) }
    : {}
  return { ...MESH_BAKE_CONSTANTS, ...replay, meshBudget: engineLevelBudget(level), rounds }
}

export function meshPipelineVersion(level: number, rounds: number = AMPLIFY_EROSION_ROUNDS): string {
  return derivePipelineVersion(meshLevelPipelineConstants(level, rounds))
}

export interface MeshLevelArtifact {
  level: number
  count: number
  nodes: Float32Array
  connectivity: Uint8Array
  z: Float32Array
  waterBodies: WaterBody[]
  graph: RiverGraph | null
  rivers: RiverPolylines | null
  // What the ecology reads of the land, per node; absent in a level made
  // before 2026-10-25 (docs/decisions/level-waters.md).
  land?: LevelLand | null
}

// A level's land fields (the engine's `forms::LevelLand`): per node in the
// mesh's numbering, the hydrology's products on the level's mesh; then the
// world's features. The measures are as the artifact's 16-bit codes give
// them back (`land_codes` in the engine's formats).
export interface LevelLand {
  // 1 for land: above the sea, or a terminal basin's dry floor.
  land: Uint8Array
  // The map's biome (with the ice model's glaciers, as the save's), and
  // the one the ecology reads (without them).
  biome: Uint8Array
  ecologyBiome: Uint8Array
  koppen: Uint8Array
  // The discharge per node, the engine's units.
  discharge: Float32Array
  // The liquid lakes' depth, elevation units.
  lakeDepth: Float32Array
  saltFlat: Uint8Array
  // The water table's depth, metres; −1 under water. Null without one.
  waterTable: Float32Array | null
  // The temperature, °C (TEG-109; the engine's `land_codes`): the year's
  // mean, to 0.1 °C. With the climate's months, the swing (the months'
  // largest distance from the mean, rounded up to 0.5 °C) and the months,
  // month-major, each a code: mean + swing · code / 127
  // (levelTemperatureYear). Absent in a level made before 2026-10-30.
  temperature?: Float32Array | null
  temperatureSwing?: Float32Array | null
  temperatureMonths?: Int8Array | null
  // The cratons' oldness as a share, −1 at sea.
  cratonAge: Float32Array
  // [x, y, …] in world raster cells.
  oases: Float64Array
  // [x, y, thickness, kind, …]: kind 0 hotspot, 1 flood basalt, 2 arc, 3
  // extinct arc — the ecology's list, not the map's (DEC-0053).
  volcanoes: Float64Array
  orogenPoints: Float64Array
  maxDischarge: number
  // The ecology's fields under the save's sliders, a byte a node as the
  // generator's fine fields are coded (ecologyField.decodeFineValue); none
  // in a level made without an ecology run.
  ecology: Partial<Record<EcologyFieldId, Uint8Array>>
  // The same fields with the dry shelf as land (TEG-13: the sea floor to
  // the glacial maximum's depth, in today's climate), a byte a node,
  // ECOLOGY_FINE_OCEAN off the shelf; none in a level made without an
  // ecology run.
  shelfEcology: Partial<Record<EcologyFieldId, Uint8Array>>
}

// The months' code range (the engine's `land_codes::TEMPERATURE_MONTH_TOP`).
const TEMPERATURE_MONTH_TOP = 127

// A node's year of temperatures, °C, a value a month; null in a level
// without the months.
export function levelTemperatureYear(land: Pick<LevelLand, 'temperature' | 'temperatureSwing' | 'temperatureMonths'>, node: number): number[] | null {
  if (!land.temperature || !land.temperatureSwing || !land.temperatureMonths) return null
  const count = land.temperatureSwing.length
  const year: number[] = []
  for (let at = node; at < land.temperatureMonths.length; at += count) {
    year.push(land.temperature[node] + (land.temperatureSwing[node] * land.temperatureMonths[at]) / TEMPERATURE_MONTH_TOP)
  }
  return year
}

interface MeshLevelMeta {
  key: ArtifactKey
  level: number
  nodes: number
  bakeMs: number
  createdAt: number
  label: string
  pipeline: { algoVersion: number; rounds: number; budget: number; constants: Record<string, number> }
  files: Record<string, number>
}

// The files are the engine's (DEC-0044, fork 7b: `levelFiles`); the meta,
// what the store and the key say of them, is this layer's, written last.
export async function writeMeshLevelArtifact(store: ArtifactStore, key: ArtifactKey, engine: WorldEngine, artifact: MeshLevelArtifact, bakeMs: number, label = '', rounds: number = AMPLIFY_EROSION_ROUNDS): Promise<boolean> {
  const handle = await store.resolve(key, true)
  if (!handle) return false
  const files = engine.levelFiles(artifact)
  const meta: MeshLevelMeta = {
    key, level: artifact.level, nodes: artifact.count, bakeMs, createdAt: Date.now(), label,
    pipeline: { algoVersion: AMPLIFICATION_ALGO_VERSION, rounds, budget: engineLevelBudget(artifact.level), constants: meshLevelPipelineConstants(artifact.level, rounds) },
    files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, bytes.byteLength])),
  }
  return writeArtifactFiles(store, handle, [
    ...Object.entries(files).map(([name, bytes]) => ({ name, bytes })),
    { name: MESH_LEVEL_FILES.meta, bytes: new TextEncoder().encode(JSON.stringify(meta)) },
  ])
}

async function readMeta(store: ArtifactStore, handle: ArtifactHandle): Promise<MeshLevelMeta | null> {
  const bytes = await store.read(handle, MESH_LEVEL_FILES.meta)
  if (!bytes) return null
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as MeshLevelMeta
  } catch {
    return null
  }
}

// The files are read all at once (each a round trip on a bucket) and
// decoded by the engine (DEC-0044, fork 7b: levelOfFiles); the level and
// its node count are the meta's.
export async function readMeshLevelArtifact(store: ArtifactStore, key: ArtifactKey, engine: WorldEngine): Promise<{ artifact: MeshLevelArtifact; bakeMs: number } | null> {
  const handle = await store.resolve(key, false)
  if (!handle) return null
  const meta = await readMeta(store, handle)
  if (!meta?.files) return null
  const names = Object.keys(meta.files)
  const read = await Promise.all(names.map((name) => store.read(handle, name)))
  const files: Record<string, Uint8Array> = {}
  for (let i = 0; i < names.length; i++) {
    const bytes = read[i]
    if (!bytes) return null
    files[names[i]] = new Uint8Array(bytes)
  }
  if (files[MESH_LEVEL_FILES.nodes]?.byteLength !== meta.nodes * 8 || files[MESH_LEVEL_FILES.z]?.byteLength !== meta.nodes * 4) return null
  let decoded: Omit<MeshLevelArtifact, 'level' | 'count'>
  try {
    decoded = engine.levelOfFiles(files) as Omit<MeshLevelArtifact, 'level' | 'count'>
  } catch {
    return null
  }
  return { artifact: { level: meta.level, count: meta.nodes, ...decoded }, bakeMs: meta.bakeMs }
}

// The level's triangulation from its artifact, on the world's shape (the
// torus unless said).
export function meshLevelMesh(artifact: MeshLevelArtifact, width: number, height: number, shape: Domain['kind'] = 'torus'): ReturnType<typeof decodeMesh> {
  const serial: SerializedMesh = { count: artifact.count, nodes: artifact.nodes, connectivity: artifact.connectivity }
  return decodeMesh(domainOfKind(shape, width, height), serial)
}
