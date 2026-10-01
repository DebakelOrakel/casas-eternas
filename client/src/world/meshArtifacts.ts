import { AMPLIFY_CONSTANTS } from '../generator/surface/amplify'
import { MESH_TUNING } from '../generator/mesh/meshDensity'
import type { MeshLevel } from '../generator/pipeline/meshBakeStage'
import { encodeMesh, decodeMesh, type SerializedMesh } from '../generator/mesh/meshSerial'
import { deserializeRiverGraph, serializeRiverGraph, type RiverGraph } from '../generator/surface/riverGraph'
import type { RiverPolylines, WaterBody } from '../generator/surface/hydrology'
import type { ArtifactHandle, ArtifactKey, ArtifactStore } from '../storage/ArtifactStore'
import { torusDomain } from '../generator/core/domain'
import { AMPLIFICATION_ALGO_VERSION, derivePipelineVersion } from './identity'
import { AMPLIFY_EROSION_ROUNDS } from './bakeSettings'
import { levelBudget } from '../generator/pipeline/meshBakeStage'
import { LITHO_LATTICE_X, LITHO_LATTICE_Y } from '../generator/surface/erosionForcingFields'
import { DIFFUSION_PAIR_CAP, EPSILON_FLOOD_STEP } from '../generator/surface/erosionEngine'
import { DEFAULT_ROUTING_EVERY } from '../generator/mesh/meshErosion'
import { RIVER_COURSE_MODEL_VERSION } from '../generator/surface/riverCourse'
import { COVER_BY_BIOME } from '../generator/surface/cover'

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
  ...AMPLIFY_CONSTANTS,
  ...Object.fromEntries(Object.entries(MESH_TUNING).map(([k, v]) => [`mesh_${k}`, v])),
  lithoLatticeX: LITHO_LATTICE_X,
  lithoLatticeY: LITHO_LATTICE_Y,
  engineDiffusionPairCap: DIFFUSION_PAIR_CAP,
  engineEpsilonFloodStep: EPSILON_FLOOD_STEP,
  routingEvery: DEFAULT_ROUTING_EVERY,
  riverCourseModel: RIVER_COURSE_MODEL_VERSION,
  ...Object.fromEntries(Object.entries(COVER_BY_BIOME).map(([biome, cover]) => [`cover${biome}`, cover])),
}

// The constants a level's version is derived from — and what its meta
// records, so the version can be recomputed from the meta (it recorded a
// subset until 2026-10-01).
export function meshLevelPipelineConstants(level: number, rounds: number = AMPLIFY_EROSION_ROUNDS): Record<string, number> {
  return { ...MESH_BAKE_CONSTANTS, meshBudget: levelBudget(level), rounds }
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

export function meshLevelToArtifact(level: MeshLevel): MeshLevelArtifact {
  const order = new Int32Array(level.mesh.aliveVertices)
  for (let i = 0; i < order.length; i++) order[i] = i
  const serial = encodeMesh(level.mesh, order)
  return { level: level.level, count: serial.count, nodes: serial.nodes, connectivity: serial.connectivity, z: level.z.slice(0, serial.count), waterBodies: level.waterBodies, graph: level.graph, rivers: level.rivers }
}

const bytesOf = (a: ArrayBufferView): Uint8Array => new Uint8Array(a.buffer, a.byteOffset, a.byteLength)

export async function writeMeshLevelArtifact(store: ArtifactStore, key: ArtifactKey, artifact: MeshLevelArtifact, bakeMs: number, label = '', rounds: number = AMPLIFY_EROSION_ROUNDS): Promise<boolean> {
  const handle = await store.resolve(key, true)
  if (!handle) return false
  const F = MESH_LEVEL_FILES
  const encoder = new TextEncoder()
  const bodyBytes = encoder.encode(JSON.stringify(artifact.waterBodies))
  const graph = artifact.graph ? serializeRiverGraph(artifact.graph) : null
  const graphBytes = graph ? encoder.encode(graph.json) : null
  const files: Record<string, number> = {
    [F.nodes]: artifact.nodes.byteLength,
    [F.connectivity]: artifact.connectivity.byteLength,
    [F.z]: artifact.z.byteLength,
    [F.waterBodies]: bodyBytes.byteLength,
  }
  if (graph && graphBytes) {
    files[F.riverGraph] = graphBytes.byteLength
    files[F.riverGraphCells] = graph.cells.byteLength
    files[F.riverGraphPositions] = graph.positions?.byteLength ?? 0
    files[F.riverCoursePoints] = graph.coursePoints.byteLength
  }
  if (artifact.rivers) {
    files[F.riverPoints] = artifact.rivers.points.byteLength
    files[F.riverLengths] = artifact.rivers.lengths.byteLength
    files[F.riverRegimes] = artifact.rivers.regimes.byteLength
  }
  const meta: MeshLevelMeta = {
    key, level: artifact.level, nodes: artifact.count, bakeMs, createdAt: Date.now(), label,
    pipeline: { algoVersion: AMPLIFICATION_ALGO_VERSION, rounds, budget: levelBudget(artifact.level), constants: meshLevelPipelineConstants(artifact.level, rounds) },
    files,
  }
  return (
    (await store.write(handle, F.nodes, bytesOf(artifact.nodes))) &&
    (await store.write(handle, F.connectivity, artifact.connectivity)) &&
    (await store.write(handle, F.z, bytesOf(artifact.z))) &&
    (await store.write(handle, F.waterBodies, bodyBytes)) &&
    (graph === null || graphBytes === null || (
      (await store.write(handle, F.riverGraph, graphBytes)) &&
      (await store.write(handle, F.riverGraphCells, bytesOf(graph.cells))) &&
      (await store.write(handle, F.riverGraphPositions, graph.positions ? bytesOf(graph.positions) : new Uint8Array(0))) &&
      (await store.write(handle, F.riverCoursePoints, bytesOf(graph.coursePoints))))) &&
    (artifact.rivers === null || (
      (await store.write(handle, F.riverPoints, bytesOf(artifact.rivers.points))) &&
      (await store.write(handle, F.riverLengths, bytesOf(artifact.rivers.lengths))) &&
      (await store.write(handle, F.riverRegimes, bytesOf(artifact.rivers.regimes))))) &&
    (await store.write(handle, F.meta, encoder.encode(JSON.stringify(meta))))
  )
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

export async function readMeshLevelArtifact(store: ArtifactStore, key: ArtifactKey): Promise<{ artifact: MeshLevelArtifact; bakeMs: number } | null> {
  const handle = await store.resolve(key, false)
  if (!handle) return null
  const meta = await readMeta(store, handle)
  if (!meta) return null
  const F = MESH_LEVEL_FILES
  const nodes = await store.read(handle, F.nodes)
  const connectivity = await store.read(handle, F.connectivity)
  const z = await store.read(handle, F.z)
  const bodies = await store.read(handle, F.waterBodies)
  if (!nodes || !connectivity || !z || !bodies) return null
  if (nodes.byteLength !== meta.nodes * 8 || z.byteLength !== meta.nodes * 4) return null
  let waterBodies: WaterBody[] = []
  try {
    waterBodies = JSON.parse(new TextDecoder().decode(bodies)) as WaterBody[]
  } catch {
    return null
  }
  let graph: RiverGraph | null = null
  const graphBytes = await store.read(handle, F.riverGraph)
  if (graphBytes) {
    const cells = await store.read(handle, F.riverGraphCells)
    const positions = await store.read(handle, F.riverGraphPositions)
    const course = await store.read(handle, F.riverCoursePoints)
    if (cells) graph = deserializeRiverGraph(new TextDecoder().decode(graphBytes), new Int32Array(cells.slice(0)), course ? new Float32Array(course.slice(0)) : undefined, positions && positions.byteLength > 0 ? new Float32Array(positions.slice(0)) : undefined)
  }
  let rivers: RiverPolylines | null = null
  const points = await store.read(handle, F.riverPoints)
  const lengths = await store.read(handle, F.riverLengths)
  const regimes = await store.read(handle, F.riverRegimes)
  if (points && lengths && regimes) rivers = { points: new Float32Array(points.slice(0)), lengths: new Uint32Array(lengths.slice(0)), regimes: new Uint8Array(regimes.slice(0)) }
  return {
    artifact: { level: meta.level, count: meta.nodes, nodes: new Float32Array(nodes.slice(0)), connectivity: new Uint8Array(connectivity.slice(0)), z: new Float32Array(z.slice(0)), waterBodies, graph, rivers },
    bakeMs: meta.bakeMs,
  }
}

// The level's triangulation from its artifact.
export function meshLevelMesh(artifact: MeshLevelArtifact, width: number, height: number): ReturnType<typeof decodeMesh> {
  const serial: SerializedMesh = { count: artifact.count, nodes: artifact.nodes, connectivity: artifact.connectivity }
  return decodeMesh(torusDomain(width, height), serial)
}
