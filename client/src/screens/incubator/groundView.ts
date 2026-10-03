import { Color3, Color4, DirectionalLight, DynamicTexture, HemisphericLight, Mesh, MeshBuilder, Scene, ShadowGenerator, StandardMaterial, Vector3 } from '@babylonjs/core'
import { METERS_PER_CELL } from '../../generator/core/mapConfig'
import { createGroundRings, type GroundRings, type RingBuildRequest, type RingBuildResult } from '../../map/groundRings'
import { MAP_EXAGGERATION, MAP_WORLD_HEIGHT, MAP_WORLD_WIDTH, RELIEF_HEIGHT_SCALE, UNITS_PER_METER } from '../../map/mapSceneSettings'
import { artifactKey, type ArtifactStore } from '../../storage/ArtifactStore'
import type { MeshLevelArtifact } from '../../world/meshArtifacts'
import { readMeshTileArtifact } from '../../world/meshTileArtifacts'
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
// The finest level a ring reads, by the size of its TEXELS (not its
// quads: the textures carry the detail, the quads only the silhouette).
// Further out than the texels can show the tiles' nodes (~150 m on
// level 3, ~500 m on level 2) on purpose: each level stands its peaks a
// few hundred metres higher than the level below (a tile sharpens what
// the coarser mesh rounded off), and where two rings read two levels
// the snow line and the relief step at the ring's edge. So a level
// reaches out to where its ring's texels are about a pixel at the zoom
// the ring is innermost at, and the step moves to where it is subpixel.
// Level 3 to ring 5 (184 km, ≤ 16 tiles of ~1 MB), level 2 to ring 7
// (737 km, ≤ 36 tiles of ~0.2 MB; to ring 8 it was 200 tiles and a
// ring painted again and again as they came, 2026-10-03).
const LEVEL3_MAX_TEXEL_M = 400
const LEVEL2_MAX_TEXEL_M = 800
const levelFor = (k: number): number => {
  const texel = (RING_MIN_SPACING_M * 2 ** k * RING_QUADS) / texelsFor(k)
  return texel <= LEVEL3_MAX_TEXEL_M ? 3 : texel <= LEVEL2_MAX_TEXEL_M ? 2 : 1
}

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
// The shader's grain under the texels (groundNormalPlugin): its longest
// wavelength and how far from the eye it reaches, in altitudes.
const DETAIL_WAVELENGTH = 60 * UNITS_PER_METER
const DETAIL_REACH_PER_ALTITUDE = 2.5
const DETAIL_REACH_MIN = 2000 * UNITS_PER_METER
// How long after the last tile a ring waits before it is painted again.
const REBUILD_SETTLE_MS = 300
// Tile reads in flight at once, and the painting workers.
const TILE_READS_AT_ONCE = 4
const WORKERS = 2

export interface GroundViewOptions {
  scene: Scene
  store: ArtifactStore
}

export interface GroundView {
  // Hand the ground its world: level 1, the tiles the store holds (stage
  // → pipeline version) and the save's fields. Resolves when the worker
  // holds it.
  setWorld(input: { worldUid: string; worldId: string; width: number; height: number; level: MeshLevelArtifact; versions: Map<string, string>; fields: Record<'biome' | 'elevation' | 'temperature' | 'precipitation' | 'lakeDepth', GridField | null> }): Promise<void>
  // Per frame: the focus, the world units a pixel spans there, whether
  // the shadows are wanted, and the air: the camera's height over the
  // ground (world units; 0 for the map's orthographic view, which has no
  // distance to fog by) and where it stands.
  update(focusX: number, focusZ: number, unitsPerPixel: number, shadows: boolean, air: { altitude: number; eye: Vector3; farPlane: number }): void
  // The DRAWN ground's world Y at a point, exaggeration included.
  drawnHeightAt(x: number, z: number): number
  // For the console and the screenshot ladder: what is being built.
  stats(): { queued: number; inflight: number; innermost: number; paints: { k: number; ms: number; counts: unknown; wanted: number }[]; ready: number; worldSent: number }
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
  const priority = (k: number): number => {
    const ratio = Math.log2(texelOf(k) / unitsPerPixelNow)
    // Finer than the pixel costs more than coarser: outward first on a tie.
    return ratio >= 0 ? ratio : -ratio + 0.5
  }
  function pump(): void {
    while (!disposed && queued.length > 0) {
      const idle = workers.findIndex((_, i) => !inflight.has(i))
      if (idle < 0) return
      let best = 0
      for (let i = 1; i < queued.length; i++) if (priority(queued[i].k) < priority(queued[best].k)) best = i
      const build = queued.splice(best, 1)[0]
      build.message.started = performance.now()
      inflight.set(idle, build)
      workers[idle].postMessage(build.message)
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
          centerX,
          centerY,
          spacing,
          quads: request.quads,
          texels: request.texels,
          level: levelFor(request.k),
          outerLevel: request.outermost ? null : levelFor(request.k + 1),
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
  let worldWidthCells = 1
  let worldHeightCells = 1

  let readyCount = 0
  let worldSent = 0
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
      build.resolve({ heights, albedo: message.albedo, normals: message.normals })
      if (again) rebuildSoon(build.k)
    } else if (message.type === 'wantTile') {
      if (!key) return
      const version = key.versions.get(message.stage)
      if (!version) {
        workers[index].postMessage({ type: 'tile', stage: message.stage, artifact: null } satisfies GroundWorkerInbound)
        tileArrived(message.stage)
        return
      }
      // Asked once, whichever worker asks: the answer goes to all.
      if (tileAsked.has(message.stage)) return
      tileAsked.add(message.stage)
      tileQueue.push({ stage: message.stage, version, tries: 0 })
      pumpTiles()
    }
  }
  const tileAsked = new Set<string>()

  // THE TILE READS, a few at a time: a wide view wants two hundred tiles
  // at once, and two hundred reads in one burst came back null and were
  // marked missing for the session (2026-10-03). A read that fails is
  // tried again once before the tile is given up.
  const tileQueue: { stage: string; version: string; tries: number }[] = []
  let tileReads = 0
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
        // A copy to each worker (the last gets the arrays themselves).
        workers.forEach((worker, i) => {
          const last = i === workers.length - 1
          const reply: GroundWorkerInbound = { type: 'tile', stage: job.stage, artifact: a }
          worker.postMessage(reply, a && last ? [a.nodes.buffer, a.triangles.buffer, a.z.buffer, a.role.buffer, a.outflow.buffer] : [])
        })
        if (a) held.add(job.stage)
        tileArrived(job.stage)
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
      const message: GroundWorkerInbound = { type: 'world', width: input.width, height: input.height, level, stages: [...input.versions.keys()], fields: input.fields }
      // Copied to each worker; the level's arrays are tens of MB, once.
      for (const worker of workers) worker.postMessage(message)
      worldSent = performance.now()
      await done
    },
    update(focusX, focusZ, unitsPerPixel, wantShadows, air) {
      unitsPerPixelNow = unitsPerPixel
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
      // The shader's grain: within a few altitudes of the eye, near only.
      if (air.altitude > 0) rings.setDetail(Math.max(DETAIL_REACH_MIN, air.altitude * DETAIL_REACH_PER_ALTITUDE), DETAIL_WAVELENGTH, detailStrength)
      else rings.setDetail(0, DETAIL_WAVELENGTH, 0)
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
    drawnHeightAt: (x, z) => rings.heightAt(x, z) * MAP_EXAGGERATION,
    stats: () => ({ queued: queued.length, inflight: inflight.size > 0 ? [...inflight.values()][0].k : -1, innermost: rings.innermost(), paints: paints.slice(-20), ready: readyCount, worldSent }),
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
      skyGradient.dispose()
      rings.dispose()
    },
  }
}
