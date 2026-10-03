import { METERS_PER_CELL } from '../../generator/core/mapConfig'
import { ELEVATION_METERS } from '../../generator/elevation/elevationScale'
import { createMeshSampler } from '../../generator/mesh/meshSampler'
import type { TileId } from '../../generator/mesh/meshTile'
import { makeGroundDetail } from '../../map/groundDetail'
import { paintRing, type RingPaintRequest } from '../../map/groundPaint'
import { meshLevelMesh, type MeshLevelArtifact } from '../../world/meshArtifacts'
import type { MeshTileArtifact } from '../../world/meshTileArtifacts'
import { createGroundSource, type GridField, type TiledGroundSource } from './groundSource'

// THE INCUBATOR'S GROUND WORKER: holds the world's level 1, the tiles it
// is handed, and the save's material fields, and paints rings on request
// (map/groundPaint.ts). Off the main thread because a ring is a few
// hundred milliseconds of sampling, and the camera must not wait for it.
//
// The main thread owns the stores: a tile the painter wants is asked for
// (`wantTile`) and arrives as its arrays (`tile`); a ring painted while a
// tile was missing says so (`wanted`), so the screen can paint it again.

export type GroundWorkerInbound =
  | { type: 'world'; width: number; height: number; level: MeshLevelArtifact; stages: string[]; fields: Record<'biome' | 'elevation' | 'temperature' | 'precipitation' | 'lakeDepth', GridField | null>; detail: number }
  | { type: 'paint'; id: number; started: number; preview: boolean } & RingPaintRequest
  | { type: 'tile'; stage: string; artifact: MeshTileArtifact | null }

export type GroundWorkerOutbound =
  | { type: 'ready' }
  | { type: 'wantTile'; stage: string; tile: TileId }
  | { type: 'painted'; id: number; heights: Float32Array; albedo: Uint8Array; normals: Uint8Array; materials: Uint8Array; wanted: string[]; counts: { held: number; loading: number; missing: number; answered: number[] } }
  // The detail textures (groundDetail.ts), once, from the worker asked.
  | { type: 'detail'; size: number; albedo: Uint8Array; normals: Uint8Array }

// `self` is the DOM's here (the lib the client compiles against), whose
// postMessage wants a target origin; the worker's takes the transfer
// list second, as the generator's worker calls it too.
const worker = self as unknown as { postMessage(message: unknown, transfer?: Transferable[]): void; onmessage: ((event: MessageEvent<GroundWorkerInbound>) => void) | null }
const post = (message: GroundWorkerOutbound, transfer: Transferable[] = []): void => worker.postMessage(message, transfer)

let source: TiledGroundSource | null = null

worker.onmessage = (event: MessageEvent<GroundWorkerInbound>): void => {
  const message = event.data
  if (message.type === 'world') {
    const mesh = meshLevelMesh(message.level, message.width, message.height)
    const base = createMeshSampler(mesh, message.level.z)
    source = createGroundSource({
      width: message.width,
      height: message.height,
      metersPerCell: METERS_PER_CELL,
      elevationMeters: ELEVATION_METERS,
      base,
      stages: new Set(message.stages),
      requestTile: (stage, tile) => post({ type: 'wantTile', stage, tile }),
      fields: message.fields,
    })
    post({ type: 'ready' })
    if (message.detail > 0) {
      const set = makeGroundDetail(message.detail)
      post({ type: 'detail', size: set.size, albedo: set.albedo, normals: set.normals }, [set.albedo.buffer, set.normals.buffer])
    }
    return
  }
  if (message.type === 'tile') {
    if (!source) return
    if (message.artifact) source.addTile(message.stage, message.artifact)
    else source.markMissing(message.stage)
    return
  }
  if (message.type === 'paint') {
    if (!source) return
    source.takeWanted()
    const out = paintRing(source, message)
    post({ type: 'painted', id: message.id, heights: out.heights, albedo: out.albedo, normals: out.normals, materials: out.materials, wanted: source.takeWanted(), counts: source.counts() }, [out.heights.buffer, out.albedo.buffer, out.normals.buffer, out.materials.buffer])
  }
}
