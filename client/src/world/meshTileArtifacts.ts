import { MESH_BAKE_CONSTANTS } from './meshArtifacts'
import type { TileId } from '../generator/mesh/meshTile'
import { ENGINE_CONSTANTS, engineLevelBudget } from '../generator/pipeline/engineConstants'
import type { ArtifactKey, ArtifactStore } from '../storage/ArtifactStore'
import { AMPLIFICATION_ALGO_VERSION, derivePipelineVersion } from './identity'
import { AMPLIFY_EROSION_ROUNDS } from './bakeSettings'

// A TILE OF A FINE LEVEL as an artifact (docs/decisions/tile-jobs.md,
// answer 5): one artifact per tile, stage `L<level>:x,y`. It holds the tile's
// INSIDE only — the edge row and the nodes within it, and the triangles
// between them; the halo was computed and is dropped. Not the periodic
// mesh codec (meshSerial.ts): a tile is a square with a boundary, so the
// triangles are stored as they are, three node indices each.
//
// Positions on the torus are in cells from the tile's own corner
// (0..cells), so world x = tileCorner(tile).x + x. They are float32 and
// exact: the tile put every node on its level's quantum (meshTile.ts). On
// the sphere they are the nodes' world points as float32
// (docs/decisions/sphere-tiles.md): a sphere tile's frame is its own plane,
// and a node two tiles share is the same world point in both.
//
// The pipeline version carries what the mesh levels carry (the tile is
// built on its parent and baked with the same rounds), the parent's
// budget and every constant of the level's tile.

export const MESH_TILE_FILES = {
  nodes: 'tileNodes.f32',
  triangles: 'tileTriangles.u32',
  z: 'tileZ.f32',
  role: 'tileRole.u8',
  outflow: 'tileOutflow.f32',
  meta: 'meta.json',
} as const

export function meshTileStage(tile: TileId): string {
  return `L${tile.level}:${tile.x},${tile.y}`
}

export function meshTilePipelineVersion(level: number, rounds: number = AMPLIFY_EROSION_ROUNDS): string {
  return derivePipelineVersion(tilePipelineConstants(level, rounds))
}

// One version a level for both shapes: the sphere's cube constants are in
// it on the torus too (2026-10-17, docs/decisions/sphere-tiles.md). A
// torus tile does not read them; the price is that changing one makes the
// torus's tiles again, against a version per shape every reader of a
// stage would have to ask the world's shape for.
function tileLevelConstants(level: number): Record<string, number> {
  const constants = ENGINE_CONSTANTS.tiles[String(level)]
  if (!constants) throw new Error(`level ${level} has no tiles`)
  return constants
}

function tilePipelineConstants(level: number, rounds: number): Record<string, number> {
  return {
    // The cube's and the tile's constants, the engine's (generator/pipeline/engineConstants.ts).
    ...tileLevelConstants(level),
    ...MESH_BAKE_CONSTANTS,
    parentBudget: engineLevelBudget(level - 1),
    rounds,
    // The erosion's routing cadence in a tile: fresh every routingEvery
    // rounds, waited for (meshTileBake.ts). Before 2026-10-04 the pool's
    // overlapped cadence, which kept a tile's starting routing throughout.
    tileRoutingSynchronous: 1,
  }
}

export interface MeshTileArtifact {
  tile: TileId
  count: number
  // x, y per node: cells from the tile's corner on the torus, world
  // points on the sphere.
  nodes: Float32Array
  // Three node indices per triangle.
  triangles: Uint32Array
  z: Float32Array
  // meshTile's TILE_ROLE_* per node (new, parent, edge).
  role: Uint8Array
  // The drainage leaving over each edge node, 0 elsewhere (meshTileBake's
  // outflow): what the tile below reads as its inflow.
  outflow: Float32Array
}

interface MeshTileMeta {
  key: ArtifactKey
  tile: TileId
  nodes: number
  triangles: number
  bakeMs: number
  createdAt: number
  label: string
  pipeline: { algoVersion: number; rounds: number; constants: Record<string, number> }
  files: Record<string, number>
}

const bytesOf = (a: ArrayBufferView): Uint8Array => new Uint8Array(a.buffer, a.byteOffset, a.byteLength)

export async function writeMeshTileArtifact(store: ArtifactStore, key: ArtifactKey, artifact: MeshTileArtifact, bakeMs: number, label = '', rounds: number = AMPLIFY_EROSION_ROUNDS): Promise<boolean> {
  const handle = await store.resolve(key, true)
  if (!handle) return false
  const F = MESH_TILE_FILES
  const meta: MeshTileMeta = {
    key, tile: artifact.tile, nodes: artifact.count, triangles: artifact.triangles.length / 3, bakeMs, createdAt: Date.now(), label,
    pipeline: { algoVersion: AMPLIFICATION_ALGO_VERSION, rounds, constants: tilePipelineConstants(artifact.tile.level, rounds) },
    files: {
      [F.nodes]: artifact.nodes.byteLength,
      [F.triangles]: artifact.triangles.byteLength,
      [F.z]: artifact.z.byteLength,
      [F.role]: artifact.role.byteLength,
      [F.outflow]: artifact.outflow.byteLength,
    },
  }
  return (
    (await store.write(handle, F.nodes, bytesOf(artifact.nodes))) &&
    (await store.write(handle, F.triangles, bytesOf(artifact.triangles))) &&
    (await store.write(handle, F.z, bytesOf(artifact.z))) &&
    (await store.write(handle, F.role, artifact.role)) &&
    (await store.write(handle, F.outflow, bytesOf(artifact.outflow))) &&
    (await store.write(handle, F.meta, new TextEncoder().encode(JSON.stringify(meta))))
  )
}

// A tile's artifact as far as reusing it needs: there, whole, its node count
// and how long it took — from the resolve's file list and meta.json, not
// the arrays. A plan's worker asks this of every tile before computing it,
// and reading the whole tile to answer was about as slow as computing it
// (2026-10-04). Whole means every file listed: meta.json is written last
// (writeMeshTileArtifact), and each file is one complete write: both stores
// a worker writes to write a temp file and rename it (the Go store's Write,
// jobWorker's fs store), so a listed file is never a cut one.
export async function meshTileArtifactInfo(store: ArtifactStore, key: ArtifactKey): Promise<{ nodes: number; bakeMs: number } | null> {
  const handle = await store.resolve(key, false)
  if (!handle || !Object.values(MESH_TILE_FILES).every((name) => handle.files.includes(name))) return null
  const metaBytes = await store.read(handle, MESH_TILE_FILES.meta)
  if (!metaBytes) return null
  try {
    const meta = JSON.parse(new TextDecoder().decode(metaBytes)) as MeshTileMeta
    return { nodes: meta.nodes, bakeMs: meta.bakeMs }
  } catch {
    return null
  }
}

export async function readMeshTileArtifact(store: ArtifactStore, key: ArtifactKey): Promise<{ artifact: MeshTileArtifact; bakeMs: number } | null> {
  const handle = await store.resolve(key, false)
  if (!handle) return null
  const F = MESH_TILE_FILES
  // All at once: on a bucket each read is a round trip, and a tile is six
  // files (2026-10-22: in turn, a level-3 tile's inputs took two thirds of
  // its time on S3).
  const [metaBytes, nodes, triangles, z, role, outflow] = await Promise.all(
    [F.meta, F.nodes, F.triangles, F.z, F.role, F.outflow].map((name) => store.read(handle, name)),
  )
  if (!metaBytes) return null
  let meta: MeshTileMeta
  try {
    meta = JSON.parse(new TextDecoder().decode(metaBytes)) as MeshTileMeta
  } catch {
    return null
  }
  if (!nodes || !triangles || !z || !role || !outflow) return null
  if (nodes.byteLength !== meta.nodes * 8 || z.byteLength !== meta.nodes * 4 || role.byteLength !== meta.nodes || outflow.byteLength !== meta.nodes * 4 || triangles.byteLength !== meta.triangles * 12) return null
  return {
    artifact: { tile: meta.tile, count: meta.nodes, nodes: new Float32Array(nodes.slice(0)), triangles: new Uint32Array(triangles.slice(0)), z: new Float32Array(z.slice(0)), role: new Uint8Array(role.slice(0)), outflow: new Float32Array(outflow.slice(0)) },
    bakeMs: meta.bakeMs,
  }
}
