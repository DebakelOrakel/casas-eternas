import { METERS_PER_CELL } from '../../generator/core/mapConfig'
import { ELEVATION_METERS } from '../../generator/elevation/elevationScale'
import { createMeshSampler, type MeshSampler } from '../../generator/mesh/meshSampler'
import type { TileId } from '../../generator/mesh/meshTile'
import { tileSpec } from '../../generator/mesh/meshTile'
import { createTileSampler } from '../../generator/mesh/tileSampler'
import { makeGroundDetail } from '../../map/groundDetail'
import { enlargeRgba, paintRing, type RingPaintRequest } from '../../map/groundPaint'
import { meshLevelMesh, type MeshLevelArtifact } from '../../world/meshArtifacts'
import type { MeshTileArtifact } from '../../world/meshTileArtifacts'
import { rasterBuffer, rasterSamples, rasteriseLevel, rasteriseTile, type Raster } from './groundRaster'
import { createGroundSource, tileFrame, type GridField, type RasterGroundSource } from './groundSource'

// THE INCUBATOR'S GROUND WORKER: paints rings on request (map/
// groundPaint.ts) from the rasters it is handed (groundRaster.ts), and
// makes rasters — a tile's from the tile's arrays, level 1's from the
// level's mesh where it holds it. Off the main thread because a ring is
// a few hundred milliseconds, and the camera must not wait for it.
//
// The main thread owns the stores and the rasters' registry: a raster the
// painter wants is asked for (`want`), made by whichever worker is given
// the work (`rasterise`), and handed to every worker as the one shared
// buffer (`raster`); a ring painted while a raster was missing says so
// (`wanted`), so the screen can paint it again.

export type GroundWorkerInbound =
  | {
      type: 'world'
      width: number
      height: number
      // Level 1's mesh: given to the workers that answer level 1 from it
      // and raster it for the others; null for the rest.
      level: MeshLevelArtifact | null
      stages: string[]
      fields: Record<'biome' | 'elevation' | 'temperature' | 'precipitation' | 'lakeDepth' | 'waterLevel' | 'waterSurface', GridField | null>
      // The detail textures' side, from the one worker asked; 0 for none.
      detail: number
    }
  | ({ type: 'paint'; id: number; started: number; preview: boolean } & RingPaintRequest)
  // Make a raster: a tile's from its artifact, level 1's (artifact null)
  // from the mesh.
  | { type: 'rasterise'; stage: string; tile: TileId; artifact: MeshTileArtifact | null }
  // A raster made (here or elsewhere), to read from now on.
  | { type: 'raster'; stage: string; tile: TileId; n: number; data: Float32Array }
  | { type: 'dropRaster'; stage: string }
  | { type: 'missing'; stage: string }

export type GroundWorkerOutbound =
  | { type: 'ready' }
  | { type: 'want'; stage: string; tile: TileId }
  | { type: 'painted'; id: number; heights: Float32Array; albedo: Uint8Array; normals: Uint8Array; materials: Uint8Array; wanted: string[]; used: string[]; counts: { held: number; loading: number; missing: number; answered: number[] } }
  | { type: 'rastered'; stage: string; tile: TileId; n: number; data: Float32Array; ms: number }
  // The detail textures (groundDetail.ts), once, from the worker asked.
  | { type: 'detail'; size: number; albedo: Uint8Array; normals: Uint8Array }

// `self` is the DOM's here (the lib the client compiles against), whose
// postMessage wants a target origin; the worker's takes the transfer
// list second, as the generator's worker calls it too.
const worker = self as unknown as { postMessage(message: unknown, transfer?: Transferable[]): void; onmessage: ((event: MessageEvent<GroundWorkerInbound>) => void) | null }
const post = (message: GroundWorkerOutbound, transfer: Transferable[] = []): void => worker.postMessage(message, transfer)

let source: RasterGroundSource | null = null
let base: MeshSampler | null = null

const rasterFrom = (tile: TileId, n: number, data: Float32Array): Raster => {
  const frame = tileFrame(tile)
  return { level: tile.level, n, cells: frame.cells, cornerX: frame.cornerX, cornerY: frame.cornerY, data }
}

worker.onmessage = (event: MessageEvent<GroundWorkerInbound>): void => {
  const message = event.data
  if (message.type === 'world') {
    base = message.level ? createMeshSampler(meshLevelMesh(message.level, message.width, message.height), message.level.z) : null
    source = createGroundSource({
      width: message.width,
      height: message.height,
      metersPerCell: METERS_PER_CELL,
      elevationMeters: ELEVATION_METERS,
      base,
      stages: new Set(message.stages),
      request: (stage, tile) => post({ type: 'want', stage, tile }),
      makeLevel1: base
        ? (stage, tile) => {
            const started = performance.now()
            const frame = tileFrame(tile)
            const n = rasterSamples(1, frame.cells, METERS_PER_CELL)
            const data = rasterBuffer(n)
            rasteriseLevel(base!, frame.cornerX, frame.cornerY, frame.cells, n, data)
            post({ type: 'rastered', stage, tile, n, data, ms: Math.round(performance.now() - started) }, data.buffer instanceof ArrayBuffer ? [data.buffer] : [])
            return rasterFrom(tile, n, data)
          }
        : undefined,
      fields: message.fields,
    })
    post({ type: 'ready' })
    if (message.detail > 0) {
      const set = makeGroundDetail(message.detail)
      post({ type: 'detail', size: set.size, albedo: set.albedo, normals: set.normals }, [set.albedo.buffer, set.normals.buffer])
    }
    return
  }
  if (!source) return
  if (message.type === 'rasterise') {
    const started = performance.now()
    const frame = tileFrame(message.tile)
    const n = rasterSamples(message.tile.level, frame.cells, METERS_PER_CELL)
    const data = rasterBuffer(n)
    if (message.artifact) {
      const a = message.artifact
      rasteriseTile(createTileSampler(a.nodes, a.triangles, a.z, tileSpec(message.tile.level).cells), message.tile.level, n, data)
    } else if (base) {
      rasteriseLevel(base, frame.cornerX, frame.cornerY, frame.cells, n, data)
    } else return
    source.setRaster(message.stage, rasterFrom(message.tile, n, data))
    // A shared buffer is not transferable (nor need be); a plain one is.
    post({ type: 'rastered', stage: message.stage, tile: message.tile, n, data, ms: Math.round(performance.now() - started) }, data.buffer instanceof ArrayBuffer ? [data.buffer] : [])
    return
  }
  if (message.type === 'raster') {
    source.setRaster(message.stage, rasterFrom(message.tile, message.n, message.data))
    return
  }
  if (message.type === 'dropRaster') {
    source.dropRaster(message.stage)
    return
  }
  if (message.type === 'missing') {
    source.markMissing(message.stage)
    return
  }
  if (message.type === 'paint') {
    source.takeWanted()
    source.takeUsed()
    const out = paintRing(source, message)
    // A preview is painted at a quarter side and enlarged here, so the
    // main thread uploads it as it is.
    const full = message.preview ? message.texels * 4 : message.texels
    const scale = full / out.texels
    const albedo = scale === 1 ? out.albedo : enlargeRgba(out.albedo, out.texels, scale)
    const normals = scale === 1 ? out.normals : enlargeRgba(out.normals, out.texels, scale)
    const materials = scale === 1 ? out.materials : enlargeRgba(out.materials, out.texels, scale)
    post({ type: 'painted', id: message.id, heights: out.heights, albedo, normals, materials, wanted: source.takeWanted(), used: source.takeUsed(), counts: source.counts() }, [out.heights.buffer, albedo.buffer, normals.buffer, materials.buffer])
  }
}
