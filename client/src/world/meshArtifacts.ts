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
// The pipeline version carries MESH_TUNING — the density rule is part of
// what a level IS (decision 2) — and the level's budget and rounds: two
// levels that differ in either are different artifacts.

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

export async function meshLevelArtifactExists(store: ArtifactStore, key: ArtifactKey): Promise<boolean> {
  const handle = await store.resolve(key, false)
  if (!handle) return false
  return [MESH_LEVEL_FILES.meta, MESH_LEVEL_FILES.nodes, MESH_LEVEL_FILES.z].every((name) => handle.files.includes(name))
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
