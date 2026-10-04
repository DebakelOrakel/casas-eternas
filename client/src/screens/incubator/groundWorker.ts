import { METERS_PER_CELL } from '../../generator/core/mapConfig'
import { ELEVATION_METERS } from '../../generator/elevation/elevationScale'
import { createMeshSampler, type MeshSampler } from '../../generator/mesh/meshSampler'
import type { TileId } from '../../generator/mesh/meshTile'
import { tileSpec } from '../../generator/mesh/meshTile'
import { createTileSampler } from '../../generator/mesh/tileSampler'
import { addRims, seamReach, tileOffset, tileRim, type TileRim } from './groundSeams'
import { makeGroundDetail } from '../../map/groundDetail'
import { enlargeRgba, paintRing, type RingPaintRequest } from '../../map/groundPaint'
import { meshLevelMesh, type MeshLevelArtifact } from '../../world/meshArtifacts'
import type { MeshTileArtifact } from '../../world/meshTileArtifacts'
import { rasterBuffer, rasterSamples, rasteriseLevel, rasteriseTile, type Raster } from './groundRaster'
import { createGroundSource, tileFrame, type GridField, type RasterGroundSource } from './groundSource'
import { rasteriseNodeField } from '../../generator/mesh/meshRaster'
import { waterLevelsFromBodies } from './waterLevels'

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
      fields: Record<'biome' | 'elevation' | 'temperature' | 'precipitation' | 'lakeDepth' | 'waterLevel' | 'waterFloor' | 'waterDam' | 'waterSurface', GridField | null>
      // The detail textures' side, from the one worker asked; 0 for none.
      detail: number
    }
  | ({ type: 'paint'; id: number; started: number; preview: boolean } & RingPaintRequest)
  // Make a raster: a tile's from its artifact, level 1's (artifact null)
  // from the mesh. `rims`: the edges of the tile's neighbours already
  // known, whose halves its edge normals take (groundSeams.ts).
  | { type: 'rasterise'; stage: string; tile: TileId; artifact: MeshTileArtifact | null; rims: TileRim[] }
  // A neighbour's edge arrived after the tile was rastered: the tile's
  // samples along that side made again, in place.
  | { type: 'reseam'; stage: string; rim: TileRim }
  // A raster made (here or elsewhere), to read from now on.
  | { type: 'raster'; stage: string; tile: TileId; n: number; data: Float32Array }
  | { type: 'dropRaster'; stage: string }
  | { type: 'missing'; stage: string }
  // The fields replaced (the level's own raster and water, once the mesh
  // holder has made them).
  | { type: 'fields'; fields: Partial<Record<'biome' | 'elevation' | 'temperature' | 'precipitation' | 'lakeDepth' | 'waterLevel' | 'waterFloor' | 'waterDam' | 'waterSurface', GridField | null>> }

export type GroundWorkerOutbound =
  | { type: 'ready' }
  | { type: 'want'; stage: string; tile: TileId }
  | { type: 'painted'; id: number; heights: Float32Array; albedo: Uint8Array; normals: Uint8Array; materials: Uint8Array; wanted: string[]; used: string[]; counts: { held: number; loading: number; missing: number; answered: number[] } }
  // `rim`: the tile's edge nodes and their normal sums, for its neighbours.
  | { type: 'rastered'; stage: string; tile: TileId; n: number; data: Float32Array; ms: number; rim: TileRim | null }
  // A seam patched, in the shared raster. (Where the page is not cross-
  // origin isolated the raster went to the main thread as a copy, and the
  // seams stay as first rastered.)
  | { type: 'reseamed'; stage: string }
  // From the mesh holder: the level's terrain on the world raster and
  // the water levels its bodies stand at (waterLevels.ts).
  | { type: 'levels'; elevation: Float32Array; level: Float32Array; floor: Float32Array; dam: Float32Array; body: Int32Array; surface: Uint8Array; lakes: { x0: number; y0: number; x1: number; y1: number; level: number }[]; ms: number }
  // The detail textures (groundDetail.ts), once, from the worker asked.
  | { type: 'detail'; size: number; albedo: Uint8Array; normals: Uint8Array }

// `self` is the DOM's here (the lib the client compiles against), whose
// postMessage wants a target origin; the worker's takes the transfer
// list second, as the generator's worker calls it too.
const worker = self as unknown as { postMessage(message: unknown, transfer?: Transferable[]): void; onmessage: ((event: MessageEvent<GroundWorkerInbound>) => void) | null }
const post = (message: GroundWorkerOutbound, transfer: Transferable[] = []): void => worker.postMessage(message, transfer)

let source: RasterGroundSource | null = null
let base: MeshSampler | null = null
let worldWidth = 0
let worldHeight = 0

// The tiles this worker rastered, kept while their raster is held: what a
// seam patch makes the samples along one side from again.
interface Kept {
  tile: TileId
  nodes: Float32Array
  triangles: Uint32Array
  z: Float32Array
  role: Uint8Array
  rims: Map<string, TileRim>
  reach: [number, number, number, number]
  n: number
  data: Float32Array
}
const kept = new Map<string, Kept>()

// A tile's sampler with its neighbours' halves added to its edge normals.
const seamedSampler = (k: Kept): ReturnType<typeof createTileSampler> =>
  createTileSampler(k.nodes, k.triangles, k.z, tileSpec(k.tile.level).cells, (sums) => addRims(k.tile, k.nodes, k.role, sums, k.rims.values(), worldWidth, worldHeight))

const rasterFrom = (tile: TileId, n: number, data: Float32Array): Raster => {
  const frame = tileFrame(tile)
  return { level: tile.level, n, cells: frame.cells, cornerX: frame.cornerX, cornerY: frame.cornerY, data }
}

worker.onmessage = (event: MessageEvent<GroundWorkerInbound>): void => {
  const message = event.data
  if (message.type === 'world') {
    worldWidth = message.width
    worldHeight = message.height
    kept.clear()
    const mesh = message.level ? meshLevelMesh(message.level, message.width, message.height) : null
    base = mesh && message.level ? createMeshSampler(mesh, message.level.z) : null
    const fields = { ...message.fields }
    let levels: (GroundWorkerOutbound & { type: 'levels' }) | null = null
    if (mesh && message.level) {
      // The level's own terrain and water (see waterLevels.ts): what the
      // painter reads as level 0 and colours the water by.
      const started = performance.now()
      const elevation = rasteriseNodeField(mesh, message.level.z, message.width, message.height)
      const water = waterLevelsFromBodies(message.level.waterBodies, elevation, message.width, message.height)
      fields.elevation = { data: elevation, resX: message.width, resY: message.height }
      fields.waterLevel = { data: water.level, resX: message.width, resY: message.height }
      fields.waterFloor = { data: water.floor, resX: message.width, resY: message.height }
      fields.waterDam = { data: water.dam, resX: message.width, resY: message.height }
      fields.waterSurface = { data: Float32Array.from(water.surface), resX: message.width, resY: message.height }
      levels = { type: 'levels', elevation, level: water.level, floor: water.floor, dam: water.dam, body: water.body, surface: water.surface, lakes: water.lakes, ms: Math.round(performance.now() - started) }
    }
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
            post({ type: 'rastered', stage, tile, n, data, ms: Math.round(performance.now() - started), rim: null }, data.buffer instanceof ArrayBuffer ? [data.buffer] : [])
            return rasterFrom(tile, n, data)
          }
        : undefined,
      fields,
    })
    post({ type: 'ready' })
    if (levels) post(levels)
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
    let rim: TileRim | null = null
    if (message.artifact) {
      const a = message.artifact
      const cells = tileSpec(message.tile.level).cells
      const k: Kept = {
        tile: message.tile, nodes: a.nodes, triangles: a.triangles, z: a.z, role: a.role,
        rims: new Map(message.rims.map((r) => [`${r.tile.x},${r.tile.y}`, r])),
        reach: seamReach(a.nodes, a.triangles, a.role, cells), n, data,
      }
      const sampler = createTileSampler(a.nodes, a.triangles, a.z, cells, (sums) => {
        rim = tileRim(message.tile, a.nodes, a.role, sums)
        addRims(k.tile, k.nodes, k.role, sums, k.rims.values(), worldWidth, worldHeight)
      })
      rasteriseTile(sampler, message.tile.level, n, data)
      kept.set(message.stage, k)
    } else if (base) {
      rasteriseLevel(base, frame.cornerX, frame.cornerY, frame.cells, n, data)
    } else return
    source.setRaster(message.stage, rasterFrom(message.tile, n, data))
    // A shared buffer is not transferable (nor need be); a plain one is —
    // and then the copy kept for the seams goes with it.
    const transfer = data.buffer instanceof ArrayBuffer
    if (transfer) kept.delete(message.stage)
    post({ type: 'rastered', stage: message.stage, tile: message.tile, n, data, ms: Math.round(performance.now() - started), rim }, transfer ? [data.buffer as ArrayBuffer] : [])
    return
  }
  if (message.type === 'reseam') {
    const k = kept.get(message.stage)
    if (!k) return
    const id = `${message.rim.tile.x},${message.rim.tile.y}`
    if (k.rims.has(id)) return
    k.rims.set(id, message.rim)
    // The samples a change of this side's (or corner's) edge normals can
    // reach: within the side's reach, plus a sample.
    const cells = tileSpec(k.tile.level).cells
    const step = cells / (k.n - 1)
    const { dx, dy } = tileOffset(k.tile, message.rim.tile, worldWidth, worldHeight)
    const [left, right, bottom, top] = k.reach
    const only = (x: number, y: number): boolean =>
      (dx === 0 || (dx < 0 ? x <= left + step : cells - x <= right + step)) &&
      (dy === 0 || (dy < 0 ? y <= bottom + step : cells - y <= top + step))
    rasteriseTile(seamedSampler(k), k.tile.level, k.n, k.data, only)
    post({ type: 'reseamed', stage: message.stage })
    return
  }
  if (message.type === 'raster') {
    source.setRaster(message.stage, rasterFrom(message.tile, message.n, message.data))
    return
  }
  if (message.type === 'dropRaster') {
    kept.delete(message.stage)
    source.dropRaster(message.stage)
    return
  }
  if (message.type === 'missing') {
    source.markMissing(message.stage)
    return
  }
  if (message.type === 'fields') {
    source.setFields(message.fields)
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
