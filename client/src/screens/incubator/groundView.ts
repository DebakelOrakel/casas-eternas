import { Color3, Color4, DirectionalLight, DynamicTexture, HemisphericLight, Mesh, MeshBuilder, RawTexture2DArray, Scene, ShadowGenerator, StandardMaterial, Texture, Vector3 } from '@babylonjs/core'
import { GROUND_MATERIALS } from '../../map/groundDetail'
import { METERS_PER_CELL } from '../../generator/core/mapConfig'
import { createGroundRings, type GroundRings, type RingBuildRequest, type RingBuildResult } from '../../map/groundRings'
import { createGroundWater } from '../../map/groundWater'
import { MAP_EXAGGERATION, MAP_WORLD_HEIGHT, MAP_WORLD_WIDTH, RELIEF_HEIGHT_SCALE, UNITS_PER_METER } from '../../map/mapSceneSettings'
import { artifactKey, type ArtifactStore } from '../../storage/ArtifactStore'
import type { MeshLevelArtifact } from '../../world/meshArtifacts'
import { readMeshTileArtifact } from '../../world/meshTileArtifacts'
import { tileAt } from '../../generator/pipeline/tilePlan'
import type { TileId } from '../../generator/mesh/meshTile'
import { LEVEL1_GRID_LEVEL, level1Stage, rasterBytes } from './groundRaster'
import type { GridField } from './groundSource'
import type { GroundWorkerInbound, GroundWorkerOutbound } from './groundWorker'

// THE INCUBATOR'S GROUND: the rings (map/groundRings.ts) over a worker
// that paints them (groundWorker.ts), the light that shows them and the
// shadows the nearest rings cast. One ground at every zoom, from the
// whole world to a kilometre over it; what changes with the zoom is which
// rings are drawn and which level they read.

// The innermost ring's spacing, metres: half the closest node spacing of
// level 3 (measured on Calvessor 2026-10-02: 62 m at the 1st percentile
// in mountains), so a ring carries every node a tile has.
const RING_MIN_SPACING_M = 30
const RING_QUADS = 192
// Texels a side: the inner rings are built often (every two spacings of
// panning) and stay cheap; the outer ones rarely and span the view far
// out, where their texels must still hold a pixel.
const texelsFor = (k: number): number => (k < 6 ? 512 : 1024)
// Which levels a ring reads follows from its texel size, in the painter
// (groundPaint.ts LEVEL_FADE_M): level 3 under ~450 m texels (to ring 6,
// 368 km, ≤ 36 tiles of ~1 MB), level 2 under 1 500 m (to ring 8).

// The sun: from the screen's upper left with the map north-up, as the
// hillshade of every map reads, at a height that shades the plains and
// still lets a mountain's lee cast a shadow. The fill is the sky: blue
// from above, the ground's own warmth from below.
const SUN_ELEVATION_DEG = 42
const SUN_INTENSITY = 1.3
const FILL_INTENSITY = 0.38
// The innermost drawn rings that cast and take shadows; further out a
// shadow map's texels would be kilometres.
const SHADOWED_RINGS = 2
const SHADOW_MAP_SIZE = 2048
const NORMAL_BIAS_SPACINGS = 2.5
// THE AIR. The fog is the aerial perspective — what makes a far range
// pale and blue and tells the eye how far it is — and keeps the far
// plane from being a hard edge. Its reach grows with the camera's height:
// a view from a kilometre up loses the ridges thirty kilometres off, a
// view from the handover sees the whole range. The sky is a dome around
// the camera, zenith to horizon, the horizon the fog's own colour so the
// ground fades into it.
const FOG_REACH_PER_ALTITUDE = 30
const FOG_REACH_MIN = 20_000 * UNITS_PER_METER
const FOG_REACH_MAX = 1_500_000 * UNITS_PER_METER
const SKY_ZENITH = new Color3(0.36, 0.56, 0.88)
const SKY_HORIZON = new Color3(0.78, 0.85, 0.92)
const SKY_BELOW = new Color3(0.62, 0.66, 0.7)
// The hillshade's gain by the view's scale (km a pixel spans at the
// focus): 1 up to the first, RELIEF_GAIN_MAX from the second on, in
// between by the logarithm.
const RELIEF_GAIN_FROM_KM_PER_PX = 0.05
const RELIEF_GAIN_TO_KM_PER_PX = 2
const RELIEF_GAIN_MAX = 3
// The shader's detail tiles under the texels (groundNormalPlugin,
// groundDetail.ts): the micro tile's and the macro tile's wavelength,
// metres, and the tiles' side in texels.
const DETAIL_MICRO_M = 50
const DETAIL_MACRO_M = 350
const DETAIL_TEXTURE_SIZE = 512
// How far the micro tile reaches from the eye, in altitudes, at least.
const DETAIL_REACH_PER_ALTITUDE = 6
const DETAIL_REACH_MIN = 4000 * UNITS_PER_METER
// How long after the last tile a ring waits before it is painted again.
const REBUILD_SETTLE_MS = 300
// Tile reads in flight at once; the painting workers (one per core
// beyond a few for the page and the GPU), of which the first MESH_HOLDERS
// hold level 1's mesh (~150 MB each) and answer it before its rasters
// exist. The rasters themselves are one shared buffer for all.
const TILE_READS_AT_ONCE = 4
// Three workers, one of them the mesh holder: the level's triangulation
// is ~800 MB decoded, and two holders with a 700 MB raster budget had
// Safari reload the page for memory (6 GB, 2026-10-03).
const WORKERS = 3
const MESH_HOLDERS = 1
// The rasters kept, bytes: ~36 level-3 tiles or ~100 of level 2 (level
// 1's are small), least recently painted from out.
const RASTER_BUDGET_BYTES = 300 * 1024 * 1024

export interface GroundViewOptions {
  scene: Scene
  store: ArtifactStore
}

export interface GroundView {
  // Hand the ground its world: level 1, the tiles the store holds (stage
  // → pipeline version) and the save's fields. Resolves when the worker
  // holds it.
  setWorld(input: { worldUid: string; worldId: string; width: number; height: number; level: MeshLevelArtifact; versions: Map<string, string>; fields: Record<'biome' | 'elevation' | 'temperature' | 'precipitation' | 'lakeDepth' | 'waterLevel' | 'waterSurface', GridField | null> }): Promise<void>
  // Per frame: the focus, the world units a pixel spans there, whether
  // the shadows are wanted, and the air: the camera's height over the
  // ground (world units; 0 for the map's orthographic view, which has no
  // distance to fog by) and where it stands.
  update(focusX: number, focusZ: number, unitsPerPixel: number, shadows: boolean, air: { altitude: number; eye: Vector3; farPlane: number }): void
  // The water's levels (elevation units per world cell) and the lakes'
  // boxes (cells), for the water planes (map/groundWater.ts).
  setWater(level: Float32Array, width: number, height: number, lakes: { x0: number; y0: number; x1: number; y1: number; level: number }[]): void
  // The DRAWN ground's world Y at a point, exaggeration included.
  drawnHeightAt(x: number, z: number): number
  // For the console and the screenshot ladder: what is being built.
  stats(): { queued: number; inflight: number; innermost: number; paints: { k: number; ms: number; counts: unknown; wanted: number }[]; ready: number; worldSent: number; rasters: { count: number; mb: number; made: number; madeMs: number }; arrivals: number; waiting: number }
  // DEBUG: tint each ring by its index, to see where the rings meet; the
  // shader grain's strength (1 the design's).
  setTinted(on: boolean): void
  setDetailStrength(v: number): void
  dispose(): void
}

export function createGroundView(options: GroundViewOptions): GroundView {
  const { scene, store } = options
  // THE WORKERS, each with its own copy of the level and the tiles: a
  // ring is a few hundred milliseconds to paint, and one painter left the
  // view soft for fifteen seconds after a pan (2026-10-03). Each worker
  // takes one build at a time; a tile that arrives goes to all of them.
  const workers = Array.from({ length: WORKERS }, () => new Worker(new URL('./groundWorker.ts', import.meta.url), { type: 'module' }))
  // The rasters (groundRaster.ts) by stage, as the workers hold them:
  // the registry the eviction works on. `tile` is what a worker needs to
  // place it again; `data` the shared buffer.
  interface Held {
    tile: TileId
    n: number
    data: Float32Array
    bytes: number
    lastUsed: number
  }
  const rasters = new Map<string, Held>()
  let rasterBytesHeld = 0
  let rastersMade = 0
  let rastersMadeMs = 0
  // Rasters being made, by stage, and level-1 rasters wanted but not yet
  // given to a mesh holder.
  const level1Queue: TileId[] = []
  const level1Busy = new Set<number>()
  // The builds: queued here and sent to the worker one at a time, the
  // one that matters most first — the ring whose texels are nearest the
  // pixel, then outward (the coarse ground under everything), then
  // inward. A queue in the worker would paint in the order of asking,
  // which after a zoom is the wrong ring first for seconds.
  interface Build {
    id: number
    k: number
    message: GroundWorkerInbound & { type: 'paint' }
    resolve: (result: RingBuildResult | null) => void
  }
  const queued: Build[] = []
  const inflight = new Map<number, Build>()
  let nextId = 1
  let unitsPerPixelNow = 1
  const paints: { k: number; ms: number; counts: unknown; wanted: number }[] = []

  const texelOf = (k: number): number => (RING_MIN_SPACING_M * UNITS_PER_METER * 2 ** k * RING_QUADS) / texelsFor(k)
  const priority = (build: Build): number => {
    const ratio = Math.log2(texelOf(build.k) / unitsPerPixelNow)
    // Finer than the pixel costs more than coarser: outward first on a
    // tie; a preview before any full build.
    return (ratio >= 0 ? ratio : -ratio + 0.5) - (build.message.preview ? 100 : 0)
  }
  // The level-1 raster stages a ring's square covers (level 2's tile
  // grid): a ring whose rasters are not all held goes to a mesh holder.
  function level1StagesOf(message: GroundWorkerInbound & { type: 'paint' }): string[] {
    const half = (message.quads / 2) * message.spacing
    const out = new Set<string>()
    const step = 16 // level 2's tile side, cells
    for (let y = message.centerY - half; y <= message.centerY + half + step; y += step) {
      for (let x = message.centerX - half; x <= message.centerX + half + step; x += step) {
        const t = tileAt(LEVEL1_GRID_LEVEL, x, y, worldWidthCells, worldHeightCells)
        out.add(level1Stage(t.x, t.y))
      }
    }
    return [...out]
  }
  const needsMesh = (build: Build): boolean => level1StagesOf(build.message).some((stage) => !rasters.has(stage))
  function pump(): void {
    while (!disposed && queued.length > 0) {
      // The most urgent build that some idle worker can take.
      let best = -1
      let bestWorker = -1
      for (let i = 0; i < queued.length; i++) {
        if (best >= 0 && priority(queued[i]) >= priority(queued[best])) continue
        const holdersOnly = needsMesh(queued[i])
        const w = workers.findIndex((_, j) => !inflight.has(j) && !level1Busy.has(j) && (!holdersOnly || j < MESH_HOLDERS))
        if (w < 0) continue
        best = i
        bestWorker = w
      }
      if (best < 0) return
      const build = queued.splice(best, 1)[0]
      build.message.started = performance.now()
      inflight.set(bestWorker, build)
      workers[bestWorker].postMessage(build.message)
    }
    pumpLevel1()
  }
  // Level-1 rasters are made by an idle mesh holder, one at a time, so
  // the paints keep the holders; a worker making one is busy for it.
  function pumpLevel1(): void {
    while (level1Queue.length > 0) {
      const w = [...Array(MESH_HOLDERS).keys()].find((j) => !inflight.has(j) && !level1Busy.has(j))
      if (w === undefined) return
      const tile = level1Queue.shift()!
      level1Busy.add(w)
      workers[w].postMessage({ type: 'rasterise', stage: level1Stage(tile.x, tile.y), tile, artifact: null } satisfies GroundWorkerInbound)
    }
  }
  // A raster arrived: into the registry, to every worker, the waiting
  // rings told; and the ones least recently painted from out when over
  // the budget.
  function adopt(stage: string, tile: TileId, n: number, data: Float32Array, from: number): void {
    const bytes = rasterBytes(n)
    rasters.set(stage, { tile, n, data, bytes, lastUsed: performance.now() })
    rasterBytesHeld += bytes
    workers.forEach((worker, i) => {
      if (i === from) return
      worker.postMessage({ type: 'raster', stage, tile, n, data } satisfies GroundWorkerInbound)
    })
    tileArrived(stage)
    while (rasterBytesHeld > RASTER_BUDGET_BYTES) {
      let oldest: string | null = null
      let oldestAt = Infinity
      for (const [s, h] of rasters) {
        if (s === stage) continue
        if (h.lastUsed < oldestAt) {
          oldestAt = h.lastUsed
          oldest = s
        }
      }
      if (!oldest) break
      const h = rasters.get(oldest)!
      rasters.delete(oldest)
      rasterBytesHeld -= h.bytes
      tileAsked.delete(oldest)
      held.delete(oldest)
      for (const worker of workers) worker.postMessage({ type: 'dropRaster', stage: oldest } satisfies GroundWorkerInbound)
    }
  }

  let ready: (() => void) | null = null
  // Rings painted while a tile was missing, by stage, and per ring the
  // stages it still waits for: a ring is painted again once ALL the tiles
  // its last paint wanted are in (or given up), not per tile — per tile
  // a wide ring repainted forty times (2026-10-03).
  const waiting = new Map<string, Set<number>>()
  const ringWaits = new Map<number, Set<string>>()
  const tileArrived = (stage: string): void => {
    const set = waiting.get(stage)
    waiting.delete(stage)
    if (!set) return
    for (const k of set) {
      const waits = ringWaits.get(k)
      waits?.delete(stage)
      if (!waits || waits.size === 0) {
        ringWaits.delete(k)
        rebuildSoon(k)
      }
    }
  }
  // The tiles the worker holds already: a paint that wanted one of them
  // ran before it arrived (the read is faster than the paint), and its
  // ring is painted again at once rather than never (2026-10-03).
  const held = new Set<string>()
  // Rings to build again, after the tiles stop arriving for a moment.
  const stale = new Set<number>()
  let staleTimer: ReturnType<typeof setTimeout> | null = null
  const rebuildSoon = (k: number): void => {
    stale.add(k)
    if (staleTimer) clearTimeout(staleTimer)
    staleTimer = setTimeout(() => {
      staleTimer = null
      const list = [...stale].sort((a, b) => b - a)
      stale.clear()
      for (const ring of list) rings.rebuild(ring)
    }, REBUILD_SETTLE_MS)
  }
  let key: { worldUid: string; worldId: string; versions: Map<string, string> } | null = null
  let disposed = false

  const rings: GroundRings = createGroundRings({
    scene,
    quads: RING_QUADS,
    spacing0: RING_MIN_SPACING_M * UNITS_PER_METER,
    // Past the world's longer side, so the outermost ring covers the view
    // at the farthest zoom with the wrap showing at both edges.
    worldSpan: Math.max(MAP_WORLD_WIDTH, MAP_WORLD_HEIGHT) * 1.3,
    texelsFor,
    build: (request: RingBuildRequest) =>
      new Promise<RingBuildResult | null>((resolve) => {
        if (disposed || !key) {
          resolve(null)
          return
        }
        const id = nextId++
        // World units → cells: texel px of the map shows world x = px, so
        // the plane's centre u = ½ is cell (width/2 − ½).
        const centerX = (request.centerX / MAP_WORLD_WIDTH + 0.5) * worldWidthCells - 0.5
        const centerY = (request.centerZ / MAP_WORLD_HEIGHT + 0.5) * worldHeightCells - 0.5
        const spacing = request.spacing / UNITS_PER_METER / METERS_PER_CELL
        const message: GroundWorkerInbound = {
          type: 'paint',
          id,
          preview: request.preview,
          centerX,
          centerY,
          spacing,
          quads: request.quads,
          texels: request.texels,
          outerTexelM: request.outermost ? null : texelOf(request.k + 1) / UNITS_PER_METER,
          verticalScale: MAP_EXAGGERATION,
          started: 0,
        }
        // A newer build of the same ring replaces the one still queued.
        const stale = queued.findIndex((b) => b.k === request.k)
        if (stale >= 0) queued.splice(stale, 1)[0].resolve(null)
        queued.push({ id, k: request.k, message, resolve })
        pump()
      }),
  })
  rings.setHeightScale(MAP_EXAGGERATION)
  const water = createGroundWater({ scene, worldWidth: MAP_WORLD_WIDTH, worldHeight: MAP_WORLD_HEIGHT, heightScale: RELIEF_HEIGHT_SCALE })
  water.setHeightScale(MAP_EXAGGERATION)
  water.setEnabled(false)
  const started = performance.now()
  let worldWidthCells = 1
  let worldHeightCells = 1

  let readyCount = 0
  let worldSent = 0
  let detailTextures: { albedo: RawTexture2DArray; normals: RawTexture2DArray } | null = null
  workers.forEach((worker, index) => {
    worker.onerror = (event: ErrorEvent): void => {
      console.error('[incubator] ground worker', event.message)
      window.dispatchEvent(new ErrorEvent('error', { message: `ground worker: ${event.message}` }))
    }
    worker.onmessage = (event: MessageEvent<GroundWorkerOutbound>): void => onMessage(index, event.data)
  })
  function onMessage(index: number, message: GroundWorkerOutbound): void {
    if (message.type === 'ready') {
      readyCount++
      if (readyCount === workers.length) {
        ready?.()
        ready = null
      }
    } else if (message.type === 'painted') {
      const running = inflight.get(index)
      const build = running && running.id === message.id ? running : null
      inflight.delete(index)
      pump()
      if (!build) return
      paints.push({ k: build.k, ms: Math.round(performance.now() - build.message.started), counts: message.counts, wanted: message.wanted.length })
      if (paints.length > 200) paints.shift()
      const now = performance.now()
      for (const stage of message.used) {
        const h = rasters.get(stage)
        if (h) h.lastUsed = now
      }
      let again = false
      const waits = new Set<string>()
      for (const stage of message.wanted) {
        if (held.has(stage)) {
          again = true
          continue
        }
        const set = waiting.get(stage) ?? new Set<number>()
        set.add(build.k)
        waiting.set(stage, set)
        waits.add(stage)
      }
      if (waits.size > 0) {
        ringWaits.set(build.k, waits)
        again = false
      } else ringWaits.delete(build.k)
      // Elevation units → world Y (before the exaggeration).
      const heights = message.heights
      for (let i = 0; i < heights.length; i++) heights[i] *= RELIEF_HEIGHT_SCALE
      build.resolve({ heights, albedo: message.albedo, normals: message.normals, materials: message.materials, preview: build.message.preview, complete: waits.size === 0 && !again })
      if (again) rebuildSoon(build.k)
    } else if (message.type === 'detail') {
      const layers = GROUND_MATERIALS.length
      const albedo = RawTexture2DArray.CreateRGBATexture(message.albedo, message.size, message.size, layers, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE)
      const normals = RawTexture2DArray.CreateRGBATexture(message.normals, message.size, message.size, layers, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE)
      for (const t of [albedo, normals]) {
        t.wrapU = Texture.WRAP_ADDRESSMODE
        t.wrapV = Texture.WRAP_ADDRESSMODE
        t.anisotropicFilteringLevel = 8
      }
      detailTextures?.albedo.dispose()
      detailTextures?.normals.dispose()
      detailTextures = { albedo, normals }
      rings.setDetailTextures(albedo, normals)
    } else if (message.type === 'rastered') {
      rastersMade++
      rastersMadeMs += message.ms
      if (message.tile.level === 1) {
        level1Busy.delete(index)
        // Made by a holder inside a paint, perhaps twice over: the first
        // one stands.
        if (!rasters.has(message.stage)) adopt(message.stage, message.tile, message.n, message.data, index)
        tileAsked.add(message.stage)
        pump()
      } else adopt(message.stage, message.tile, message.n, message.data, index)
    } else if (message.type === 'want') {
      if (!key) return
      // Asked once, whichever worker asks: the answer goes to all.
      if (tileAsked.has(message.stage) || rasters.has(message.stage)) return
      tileAsked.add(message.stage)
      if (message.tile.level === 1) {
        level1Queue.push(message.tile)
        pumpLevel1()
        return
      }
      const version = key.versions.get(message.stage)
      if (!version) {
        for (const worker of workers) worker.postMessage({ type: 'missing', stage: message.stage } satisfies GroundWorkerInbound)
        tileArrived(message.stage)
        return
      }
      tileQueue.push({ stage: message.stage, tile: message.tile, version, tries: 0 })
      pumpTiles()
    }
  }
  const tileAsked = new Set<string>()

  // THE TILE READS, a few at a time: a wide view wants two hundred tiles
  // at once, and two hundred reads in one burst came back null and were
  // marked missing for the session (2026-10-03). A read that fails is
  // tried again once before the tile is given up.
  const tileQueue: { stage: string; tile: TileId; version: string; tries: number }[] = []
  let tileReads = 0
  let nextRasteriser = 0
  function pumpTiles(): void {
    while (tileReads < TILE_READS_AT_ONCE && tileQueue.length > 0 && !disposed && key) {
      const job = tileQueue.shift()!
      tileReads++
      void readMeshTileArtifact(store, artifactKey(key.worldUid, key.worldId, job.version, job.stage)).then((read) => {
        tileReads--
        if (disposed) return
        const a = read?.artifact ?? null
        if (!a && job.tries === 0) {
          tileQueue.push({ ...job, tries: 1 })
          pumpTiles()
          return
        }
        if (!a) {
          for (const worker of workers) worker.postMessage({ type: 'missing', stage: job.stage } satisfies GroundWorkerInbound)
          tileArrived(job.stage)
        } else {
          // Rastered by the workers in turn (the holders last: they have
          // the level-1 rasters to make); the raster comes back shared.
          const i = MESH_HOLDERS + (nextRasteriser++ % Math.max(1, workers.length - MESH_HOLDERS))
          const w = Math.min(i, workers.length - 1)
          held.add(job.stage)
          workers[w].postMessage({ type: 'rasterise', stage: job.stage, tile: job.tile, artifact: a } satisfies GroundWorkerInbound, [a.nodes.buffer, a.triangles.buffer, a.z.buffer, a.role.buffer, a.outflow.buffer])
        }
        pumpTiles()
      })
    }
  }

  // The lights touch only the rings.
  const sun = new DirectionalLight('groundSun', new Vector3(0, -1, 0), scene)
  const elevation = (SUN_ELEVATION_DEG * Math.PI) / 180
  sun.direction.set(Math.SQRT1_2 * Math.cos(elevation), -Math.sin(elevation), -Math.SQRT1_2 * Math.cos(elevation))
  sun.intensity = SUN_INTENSITY
  sun.diffuse = new Color3(1, 0.96, 0.88)
  sun.autoUpdateExtends = false
  sun.autoCalcShadowZBounds = true
  const fill = new HemisphericLight('groundSky', new Vector3(0, 1, 0), scene)
  fill.intensity = FILL_INTENSITY
  fill.diffuse = new Color3(0.78, 0.85, 0.98)
  fill.groundColor = new Color3(0.36, 0.3, 0.24)
  sun.includedOnlyMeshes = [...rings.meshes]
  fill.includedOnlyMeshes = [...rings.meshes]

  // The sky dome: a sphere seen from inside, coloured per vertex by its
  // height, unlit. It follows the camera and is scaled to the far plane
  // each frame.
  const sky = MeshBuilder.CreateSphere('groundSky', { diameter: 2, segments: 24, sideOrientation: Mesh.BACKSIDE }, scene)
  sky.isPickable = false
  sky.infiniteDistance = true
  const skyMaterial = new StandardMaterial('groundSkyMaterial', scene)
  skyMaterial.disableLighting = true
  skyMaterial.diffuseColor = new Color3(0, 0, 0)
  skyMaterial.fogEnabled = false
  skyMaterial.backFaceCulling = false
  // The gradient as a one-column texture over the sphere's v (pole to
  // pole): the emissive colour, which nothing shades.
  const skyGradient = new DynamicTexture('groundSkyGradient', { width: 1, height: 256 }, scene, false)
  {
    const ctx = skyGradient.getContext()
    for (let row = 0; row < 256; row++) {
      // v = 0 at the top pole in Babylon's sphere: row 0 is the zenith.
      const y = 1 - (row / 255) * 2
      const c = y >= 0 ? Color3.Lerp(SKY_HORIZON, SKY_ZENITH, Math.pow(y, 0.6)) : Color3.Lerp(SKY_HORIZON, SKY_BELOW, Math.min(1, -y * 4))
      ctx.fillStyle = `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`
      ctx.fillRect(0, row, 1, 1)
    }
    skyGradient.update(false)
  }
  skyMaterial.emissiveTexture = skyGradient
  sky.material = skyMaterial
  scene.fogMode = Scene.FOGMODE_EXP2
  scene.fogColor = SKY_HORIZON
  scene.fogDensity = 0
  scene.clearColor = new Color4(SKY_HORIZON.r, SKY_HORIZON.g, SKY_HORIZON.b, 1)

  const shadows = new ShadowGenerator(SHADOW_MAP_SIZE, sun)
  shadows.usePercentageCloserFiltering = true
  shadows.filteringQuality = ShadowGenerator.QUALITY_HIGH
  // Four times Babylon's default twice over: at ×6 every node's jitter is
  // a bump that shadowed itself as a dot (2026-10-03).
  shadows.bias = 0.006
  shadows.setDarkness(0.5)
  let shadowedFrom = -1
  let detailStrength = 1

  return {
    async setWorld(input) {
      key = { worldUid: input.worldUid, worldId: input.worldId, versions: input.versions }
      worldWidthCells = input.width
      worldHeightCells = input.height
      const done = new Promise<void>((resolve) => {
        ready = resolve
      })
      const level = input.level
      readyCount = 0
      // The level's arrays go to the mesh holders (a copy each); the
      // first worker also makes the detail textures.
      rasters.clear()
      rasterBytesHeld = 0
      tileAsked.clear()
      held.clear()
      workers.forEach((worker, i) => {
        const message: GroundWorkerInbound = { type: 'world', width: input.width, height: input.height, level: i < MESH_HOLDERS ? level : null, stages: [...input.versions.keys()], fields: input.fields, detail: i === 0 ? DETAIL_TEXTURE_SIZE : 0 }
        worker.postMessage(message)
      })
      worldSent = performance.now()
      await done
    },
    update(focusX, focusZ, unitsPerPixel, wantShadows, air) {
      unitsPerPixelNow = unitsPerPixel
      water.update(focusX, focusZ, (performance.now() - started) / 1000)
      // The air: no fog on the map (no distance there), else by the height.
      if (air.altitude > 0) {
        const reach = Math.min(FOG_REACH_MAX, Math.max(FOG_REACH_MIN, air.altitude * FOG_REACH_PER_ALTITUDE))
        scene.fogDensity = 1.1 / reach
      } else scene.fogDensity = 0
      sky.position.copyFrom(air.eye)
      sky.scaling.setAll(air.farPlane * 0.9)
      // The hillshade's gain: 1 at and under RELIEF_GAIN_FROM_PX per world
      // metre... in pixels per kilometre: the view's scale.
      {
        const kmPerPixel = unitsPerPixel / UNITS_PER_METER / 1000
        const t = Math.min(1, Math.max(0, Math.log2(kmPerPixel / RELIEF_GAIN_FROM_KM_PER_PX) / Math.log2(RELIEF_GAIN_TO_KM_PER_PX / RELIEF_GAIN_FROM_KM_PER_PX)))
        rings.setRelief(1 + (RELIEF_GAIN_MAX - 1) * t)
      }
      // The shader's detail tiles: the micro tile within a few altitudes
      // of the eye, the macro tile fading by its own size on screen.
      const reach = air.altitude > 0 ? Math.max(DETAIL_REACH_MIN, air.altitude * DETAIL_REACH_PER_ALTITUDE) : DETAIL_REACH_MIN
      rings.setDetail(DETAIL_MICRO_M * UNITS_PER_METER, DETAIL_MACRO_M * UNITS_PER_METER, detailStrength, reach)
      rings.update(focusX, focusZ, unitsPerPixel)
      // The shadows on the innermost drawn rings: the casters follow the
      // zoom, the map's frustum is a fixed square over them whose centre is
      // snapped to whole texels along the light's axes, so the shadows do
      // not jump when a ring snaps to its next grid position (2026-10-02).
      const from = wantShadows ? rings.innermost() : -1
      if (from !== shadowedFrom) {
        for (const mesh of rings.meshes) {
          shadows.removeShadowCaster(mesh)
          mesh.receiveShadows = false
        }
        if (from >= 0) {
          rings.meshes.slice(from, from + SHADOWED_RINGS).forEach((mesh) => {
            shadows.addShadowCaster(mesh)
            mesh.receiveShadows = true
          })
        }
        shadowedFrom = from
      }
      const map = shadows.getShadowMap()
      if (map) map.refreshRate = from >= 0 ? 1 : 0
      if (from >= 0) {
        const spacing = RING_MIN_SPACING_M * UNITS_PER_METER * 2 ** from
        const size = 1.5 * RING_QUADS * spacing * 2 ** (SHADOWED_RINGS - 1)
        const texel = size / SHADOW_MAP_SIZE
        const f = sun.direction.normalizeToNew()
        const right = Vector3.Cross(Vector3.Up(), f).normalize()
        const up = Vector3.Cross(f, right)
        const target = new Vector3(focusX, 0, focusZ)
        const r = Vector3.Dot(target, right)
        const u = Vector3.Dot(target, up)
        target.addInPlace(right.scale(Math.round(r / texel) * texel - r)).addInPlace(up.scale(Math.round(u / texel) * texel - u))
        sun.shadowFrustumSize = size
        sun.position.copyFrom(target.subtract(f.scale(size * 2)))
        // The bias along the normal (against the stripes a low sun lays
        // on gentle slopes) in WORLD units: a fraction of the shadowed
        // ring's spacing. A fixed 0.02 was 160 km here — every shadow
        // pushed off its ground (2026-10-03).
        shadows.normalBias = spacing * NORMAL_BIAS_SPACINGS
      }
    },
    setWater(level, width, height, lakes) {
      water.setLevels(level, width, height, lakes)
      water.setEnabled(true)
    },
    drawnHeightAt: (x, z) => rings.heightAt(x, z) * MAP_EXAGGERATION,
    stats: () => ({ queued: queued.length, inflight: inflight.size > 0 ? [...inflight.values()][0].k : -1, innermost: rings.innermost(), paints: paints.slice(-20), ready: readyCount, worldSent, rasters: { count: rasters.size, mb: Math.round(rasterBytesHeld / 1048576), made: rastersMade, madeMs: rastersMadeMs }, arrivals: rings.pendingArrivals(), waiting: ringWaits.size + tileQueue.length + tileReads + level1Queue.length + stale.size }),
    setTinted: (on) => rings.setTinted(on),
    setDetailStrength: (v) => {
      detailStrength = v
    },
    dispose() {
      disposed = true
      if (staleTimer) clearTimeout(staleTimer)
      for (const worker of workers) worker.terminate()
      for (const build of queued) build.resolve(null)
      queued.length = 0
      for (const build of inflight.values()) build.resolve(null)
      inflight.clear()
      shadows.dispose()
      sun.dispose()
      fill.dispose()
      sky.dispose()
      skyMaterial.dispose()
      detailTextures?.albedo.dispose()
      detailTextures?.normals.dispose()
      skyGradient.dispose()
      water.dispose()
      rings.dispose()
    },
  }
}
