import { MESH_BAKE_CONSTANTS } from './meshArtifacts'
import { tileConstants, tileSpec, TILE_ROLE_HALO, type TileId } from '../generator/mesh/meshTile'
import { levelBudget } from '../generator/pipeline/meshBakeStage'
import type { BakedTile } from '../generator/pipeline/meshTileBake'
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
// Positions are in cells from the tile's own corner (0..cells), so
// world x = tileCorner(tile).x + x. They are float32 and exact: the tile
// put every node on its level's quantum (meshTile.ts).
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

function tilePipelineConstants(level: number, rounds: number): Record<string, number> {
  return {
    ...MESH_BAKE_CONSTANTS,
    parentBudget: levelBudget(level - 1),
    ...tileConstants(tileSpec(level)),
    rounds,
  }
}

export interface MeshTileArtifact {
  tile: TileId
  count: number
  // x, y per node, cells from the tile's corner.
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

// The inside of a baked tile: every node but the halo's, in the mesh's
// (Hilbert) order, and every triangle with no corner in the halo.
export function bakedTileToArtifact(baked: BakedTile): MeshTileArtifact {
  const { mesh, role, halo } = baked.tile
  const index = new Int32Array(mesh.vertexSlots).fill(-1)
  let count = 0
  for (let v = 0; v < mesh.vertexSlots; v++) if (mesh.vAlive[v] && role[v] !== TILE_ROLE_HALO) index[v] = count++
  const nodes = new Float32Array(count * 2)
  const z = new Float32Array(count)
  const roles = new Uint8Array(count)
  const outflow = new Float32Array(count)
  for (let v = 0; v < mesh.vertexSlots; v++) {
    const i = index[v]
    if (i < 0) continue
    nodes[2 * i] = mesh.vx[v] - halo
    nodes[2 * i + 1] = mesh.vy[v] - halo
    z[i] = baked.z[v]
    roles[i] = role[v]
    outflow[i] = baked.outflow[v]
  }
  const triangles: number[] = []
  for (let t = 0; t < mesh.triSlots; t++) {
    if (!mesh.tAlive[t]) continue
    const a = index[mesh.tris[3 * t]]
    const b = index[mesh.tris[3 * t + 1]]
    const c = index[mesh.tris[3 * t + 2]]
    if (a >= 0 && b >= 0 && c >= 0) triangles.push(a, b, c)
  }
  return { tile: baked.tile.tile, count, nodes, triangles: Uint32Array.from(triangles), z, role: roles, outflow }
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
  const metaBytes = await store.read(handle, F.meta)
  if (!metaBytes) return null
  let meta: MeshTileMeta
  try {
    meta = JSON.parse(new TextDecoder().decode(metaBytes)) as MeshTileMeta
  } catch {
    return null
  }
  const nodes = await store.read(handle, F.nodes)
  const triangles = await store.read(handle, F.triangles)
  const z = await store.read(handle, F.z)
  const role = await store.read(handle, F.role)
  const outflow = await store.read(handle, F.outflow)
  if (!nodes || !triangles || !z || !role || !outflow) return null
  if (nodes.byteLength !== meta.nodes * 8 || z.byteLength !== meta.nodes * 4 || role.byteLength !== meta.nodes || outflow.byteLength !== meta.nodes * 4 || triangles.byteLength !== meta.triangles * 12) return null
  return {
    artifact: { tile: meta.tile, count: meta.nodes, nodes: new Float32Array(nodes.slice(0)), triangles: new Uint32Array(triangles.slice(0)), z: new Float32Array(z.slice(0)), role: new Uint8Array(role.slice(0)), outflow: new Float32Array(outflow.slice(0)) },
    bakeMs: meta.bakeMs,
  }
}
