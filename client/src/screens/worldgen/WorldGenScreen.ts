import { Color3, Color4, DirectionalLight, HemisphericLight, Mesh, MeshBuilder, RawTexture, Scene, StandardMaterial, Vector3, VertexData } from '@babylonjs/core'
import type { InstancedMesh } from '@babylonjs/core'
import { createHexMapCamera } from '../../camera/hexMapCamera'
import type { Screen, ScreenContext, ScreenFactory } from '../../app/Screen'
import { MAP_HEIGHT, MAP_WIDTH } from '../../worldgen/mapConfig'
import type { WorkerErosionProgressMessage, WorkerExportDataMessage, WorkerInboundMessage, WorkerRenderedMessage } from '../../worldgen/plateSimulationWorker'
import { drawContinentLabels } from '../../worldgen/continentLabelRenderer'
import './worldgen.css'

// Fresh start for the hex-tile world generation approach — the sphere-
// based version this replaces lives on under 'worldgen-sphere' (see
// screens/worldgen-sphere/WorldGenScreen.ts), still reachable from the
// title screen. Hex-tile generation code itself belongs in src/worldgen.

// World-space size of one toroidal period, independent of the plate
// map's own pixel resolution — matches the map's 2:1 aspect for a simple
// first pass.
const WORLD_WIDTH = 20
const WORLD_HEIGHT = 10

// Real Earth has ~15 major plates — the slider's own default (21) sits a
// bit above that for more texture without being a different order of
// magnitude.
const TOTAL_PLATE_COUNT_MIN = 13
const TOTAL_PLATE_COUNT_MAX = 31
const TOTAL_PLATE_COUNT_DEFAULT = 21

const CONTINENTAL_COUNT_MIN = 3
const CONTINENTAL_COUNT_MAX = 13
const CONTINENTAL_COUNT_DEFAULT = 5

// How often, while running, the sim advances one epoch and re-renders —
// paced deliberately (not "as fast as possible") so a run reads as
// gradual mountain-building over time rather than flashing straight to
// some final state.
const EPOCH_INTERVAL_MS = 400

// Debug/visualization toggles — no UI for these yet, flip in code.
const SHOW_PLATE_BOUNDARIES = true
const SHOW_VELOCITY_ARROWS = false

function randomSeed(): string {
  return Math.floor(Math.random() * 1_000_000_000).toString()
}

export const createWorldGenScreen: ScreenFactory = (ctx: ScreenContext): Screen => {
  const scene = new Scene(ctx.engine)
  scene.clearColor = new Color4(1, 1, 1, 1)

  const { dispose: disposeCamera, setTilt: setCameraTilt, getFocus: getCameraFocus } = createHexMapCamera({
    scene,
    canvas: ctx.canvas,
    engine: ctx.engine,
    worldWidth: WORLD_WIDTH,
    worldHeight: WORLD_HEIGHT,
  })

  const initialSeed = randomSeed()
  let lastLandFraction = 0
  let lastEpoch = 0

  // The worker computes the first frame asynchronously, so the texture
  // starts out as a flat placeholder (matching the scene's own clear
  // color, so there's no visible flash) until the first 'rendered'
  // message arrives.
  const placeholderBuffer = new Uint8Array(MAP_WIDTH * MAP_HEIGHT * 4).fill(255)
  const mapTexture = RawTexture.CreateRGBATexture(placeholderBuffer, MAP_WIDTH, MAP_HEIGHT, scene, false, false)
  const mapMaterial = new StandardMaterial('mapMaterial', scene)
  mapMaterial.diffuseTexture = mapTexture
  mapMaterial.specularColor = new Color3(0, 0, 0)
  // Flat lighting (no directional shading) — this is a top-down data map,
  // not a lit 3D surface; emissive keeps the texture's own values as the
  // only thing determining what's on screen.
  mapMaterial.emissiveColor = new Color3(1, 1, 1)
  mapMaterial.disableLighting = true

  // Toroidal wraparound, made visible: a static 3x3 block of ground-plane
  // copies (one real mesh + 8 instances, cheap — instances share geometry
  // and material) recentered each frame on whichever tile the camera is
  // currently over. Because the camera's own position is never wrapped
  // or clamped — it can grow arbitrarily large as you keep panning in one
  // direction — this reads as a truly infinite, seamlessly wrapping map
  // rather than a finite one that stops or snaps at an edge. 3x3 is
  // enough to always fill the frame at the current min/max zoom range;
  // if a future LOD pass allows zooming out far enough to see more than
  // one tile's width of margin, this needs a bigger block (5x5, etc.) or
  // an actual chunked-LOD swap instead of more static copies.
  const mapTile = MeshBuilder.CreateGround('mapTile', { width: WORLD_WIDTH, height: WORLD_HEIGHT, subdivisions: 1 }, scene)
  mapTile.material = mapMaterial
  const wrapInstances: InstancedMesh[] = []
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dz === 0) continue
      const instance = mapTile.createInstance(`mapTile_${dx}_${dz}`)
      wrapInstances.push(instance)
    }
  }

  // DEBUG 3D preview state — see the "DEBUG: temporary 3D relief
  // preview" block further down for what builds/tears these down.
  // Declared up here (rather than only where they're built) so the
  // single recenter observer below can tile whichever mesh — flat 2D or
  // debug 3D — is currently active without a second, near-duplicate
  // observer.
  let debugMeshTile: Mesh | null = null
  let debugMeshWrapInstances: InstancedMesh[] = []

  scene.onBeforeRenderObservable.add(() => {
    // getCameraFocus(), not camera.position — once tilted, the camera's
    // own position is deliberately offset backward from the pan focus
    // (see hexMapCamera.ts's setTilt), so recentering off raw position
    // would drift by a large, tilt-dependent margin instead of tracking
    // where the view is actually centered.
    const focus = getCameraFocus()
    const centerX = Math.round(focus.x / WORLD_WIDTH) * WORLD_WIDTH
    const centerZ = Math.round(focus.z / WORLD_HEIGHT) * WORLD_HEIGHT
    mapTile.position.set(centerX, 0, centerZ)
    if (debugMeshTile) debugMeshTile.position.set(centerX, 0, centerZ)
    let i = 0
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue
        wrapInstances[i].position.set(centerX + dx * WORLD_WIDTH, 0, centerZ + dz * WORLD_HEIGHT)
        if (debugMeshWrapInstances[i]) debugMeshWrapInstances[i].position.set(centerX + dx * WORLD_WIDTH, 0, centerZ + dz * WORLD_HEIGHT)
        i++
      }
    }
  })

  // -----------------------------------------------------------------
  // DEBUG: temporary 3D relief preview ("enter 3D" button on the
  // Erosion panel) — a coarse displaced grid mesh, NOT the real
  // hex-tile terrain this screen's own top-of-file comment says is the
  // actual target. Exists purely so the height map can be eyeballed in
  // 3D without waiting on that system. Delete this whole block (plus
  // the worker-side debugHeightmapGrid plumbing it depends on, in
  // plateSimulationWorker.ts and elevationMapImage.ts) once real
  // hex-tile terrain exists.
  // -----------------------------------------------------------------

  // World units of Y displacement per unit of (already redistributed,
  // roughly [-1,1]) elevation. Real planetary relief is subtle relative
  // to horizontal scale (Everest is ~0.14% of Earth's radius) — mapped
  // 1:1 this would read as almost perfectly flat. Purely a stylized
  // exaggeration so the preview actually looks like terrain; tune by eye.
  const DEBUG_VERTICAL_EXAGGERATION = 1.0
  // Camera angle (radians off vertical) the preview snaps to on entry —
  // see hexMapCamera.ts's setTilt. Tune by eye.
  const DEBUG_TILT_RADIANS = Math.PI / 3

  // Only affects the debug mesh's own material (see rebuildDebugMesh) —
  // mapMaterial keeps lighting disabled, so this has zero visible effect
  // in ordinary 2D mode. Raking (low-angle), not overhead — per this
  // project's own prior finding from the abandoned sphere-mesh attempt
  // (docs/design/world-gen.md): lighting angle mattered more than mesh
  // resolution for whether displaced terrain actually read as 3D.
  const debugSunLight = new DirectionalLight('debugSunLight', new Vector3(-0.6, -1, -0.35), scene)
  debugSunLight.intensity = 0.9
  // Without this, anything facing away from debugSunLight (a single
  // directional source, no bounce) goes pure black rather than merely
  // dim — a heightfield mesh with real relief has plenty of steep,
  // shadowed-from-the-sun faces, so this matters a lot more here than it
  // did for the old sphere attempt's smoothly curved surface, where
  // grazing light could still reach almost everywhere.
  const debugAmbientLight = new HemisphericLight('debugAmbientLight', new Vector3(0, 1, 0), scene)
  debugAmbientLight.intensity = 0.35

  let debugHeightmapGrid: Float32Array | null = null
  let debugHeightmapGridWidth = 0
  let debugHeightmapGridHeight = 0
  let debug3DActive = false

  function disposeDebugMesh(): void {
    for (const instance of debugMeshWrapInstances) instance.dispose()
    debugMeshWrapInstances = []
    if (debugMeshTile) {
      debugMeshTile.material?.dispose()
      debugMeshTile.dispose()
      debugMeshTile = null
    }
  }

  // Rebuilds from scratch every call rather than updating an existing
  // mesh's vertex buffer in place — simpler code, and cheap enough at
  // this grid's resolution (debugHeightmapGridWidth x
  // debugHeightmapGridHeight, not the full 2048x1024 elevation raster)
  // not to bother with an in-place-update path for a debug view.
  function rebuildDebugMesh(): void {
    disposeDebugMesh()
    if (!debugHeightmapGrid) return
    const grid = debugHeightmapGrid
    const gridWidth = debugHeightmapGridWidth
    const gridHeight = debugHeightmapGridHeight

    const positions: number[] = []
    const uvs: number[] = []
    const indices: number[] = []
    for (let gy = 0; gy < gridHeight; gy++) {
      const v = gy / (gridHeight - 1)
      const z = (v - 0.5) * WORLD_HEIGHT
      for (let gx = 0; gx < gridWidth; gx++) {
        const u = gx / (gridWidth - 1)
        const x = (u - 0.5) * WORLD_WIDTH
        positions.push(x, grid[gy * gridWidth + gx] * DEBUG_VERTICAL_EXAGGERATION, z)
        uvs.push(u, v)
      }
    }
    for (let gy = 0; gy < gridHeight - 1; gy++) {
      for (let gx = 0; gx < gridWidth - 1; gx++) {
        const topLeft = gy * gridWidth + gx
        const topRight = topLeft + 1
        const bottomLeft = topLeft + gridWidth
        const bottomRight = bottomLeft + 1
        indices.push(topLeft, bottomLeft, topRight, topRight, bottomLeft, bottomRight)
      }
    }
    const normals: number[] = []
    VertexData.ComputeNormals(positions, indices, normals)
    // A heightfield never has overhangs, so every normal should
    // legitimately have a positive Y (upward) component — if it
    // doesn't, this hand-built index buffer's winding order came out
    // backward for whatever handedness/culling convention
    // ComputeNormals assumes, and every triangle lights as if seen from
    // underneath (reads as almost entirely black under a directional
    // light, which is exactly what a first look at this showed).
    // Checking one normal and flipping all of them if it's
    // downward-facing fixes that without needing to correctly guess the
    // convention from memory — backFaceCulling is already off so this
    // doesn't need to also reverse the index winding for visibility.
    if (normals[1] < 0) {
      for (let i = 0; i < normals.length; i++) normals[i] = -normals[i]
    }

    const vertexData = new VertexData()
    vertexData.positions = positions
    vertexData.indices = indices
    vertexData.uvs = uvs
    vertexData.normals = normals

    debugMeshTile = new Mesh('debugHeightmapMesh', scene)
    vertexData.applyToMesh(debugMeshTile)

    const material = new StandardMaterial('debugHeightmapMaterial', scene)
    material.diffuseTexture = mapTexture
    material.specularColor = new Color3(0, 0, 0)
    // Winding order for a hand-built grid mesh is easy to get backward
    // (which would make it invisible from directly above — exactly the
    // angle this preview is meant to be viewed from). Disabling culling
    // entirely sidesteps needing to get that exactly right for a
    // throwaway debug view, at the cost of rendering both faces.
    material.backFaceCulling = false
    debugMeshTile.material = material

    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue
        debugMeshWrapInstances.push(debugMeshTile.createInstance(`debugHeightmapMesh_${dx}_${dz}`))
      }
    }
  }

  // No-ops if there's no heightmap data yet (e.g. clicked before the
  // very first render arrives) rather than tilting into a blank view
  // with nothing built to show.
  function setDebug3DActive(active: boolean): void {
    if (active && !debugHeightmapGrid) return
    debug3DActive = active
    if (active) {
      rebuildDebugMesh()
      mapTile.setEnabled(false)
      for (const inst of wrapInstances) inst.setEnabled(false)
      setCameraTilt(DEBUG_TILT_RADIANS)
    } else {
      disposeDebugMesh()
      mapTile.setEnabled(true)
      for (const inst of wrapInstances) inst.setEnabled(true)
      setCameraTilt(0)
    }
    // Queried later in the file (root.innerHTML hasn't run yet at this
    // function's own definition point) — safe since this function is
    // only ever called after setup finishes, never during it.
    toggleDebug3DButton.setAttribute('aria-label', debug3DActive ? 'Debug: exit 3D preview' : 'Debug: enter 3D preview')
  }

  const root = document.createElement('div')
  root.className = 'worldgen-screen'
  root.innerHTML = `
    <button type="button" class="nav-arrow nav-arrow--back" data-action="back" aria-label="Back">‹</button>
    <button type="button" class="nav-arrow nav-arrow--next" data-action="next" aria-label="Next">›</button>
    <span class="panel-title" data-value="panel-title"></span>
    <div class="panel" data-panel="0">
      <label class="field">
        <span class="field-label">Seed</span>
        <span class="field-row">
          <input type="text" class="seed-input" value="${initialSeed}" />
          <button type="button" class="icon-button" data-action="randomize-seed" aria-label="Randomize seed">
            <img src="/icons/dice.png" alt="" />
          </button>
        </span>
      </label>
      <label class="field">
        <span class="field-label">Total plates: <span data-value="plate-count-label">${TOTAL_PLATE_COUNT_DEFAULT}</span></span>
        <input
          type="range"
          class="plate-count-input"
          min="${TOTAL_PLATE_COUNT_MIN}"
          max="${TOTAL_PLATE_COUNT_MAX}"
          step="1"
          value="${TOTAL_PLATE_COUNT_DEFAULT}"
        />
      </label>
      <label class="field">
        <span class="field-label">Continental plates: <span data-value="continental-count-label">${CONTINENTAL_COUNT_DEFAULT}</span></span>
        <input
          type="range"
          class="continental-count-input"
          min="${CONTINENTAL_COUNT_MIN}"
          max="${CONTINENTAL_COUNT_MAX}"
          step="1"
          value="${CONTINENTAL_COUNT_DEFAULT}"
        />
      </label>
    </div>
    <div class="panel" data-panel="1">
      <label class="field field--icon-row">
        <span class="field-row">
          <button type="button" class="icon-button" data-action="reset-sim" aria-label="Reset simulation">
            <img src="/icons/reset.png" alt="" />
          </button>
          <button type="button" class="icon-button" data-action="toggle-sim" aria-label="Run tectonics">
            <img src="/icons/tectonics_off.png" alt="" />
          </button>
          <span class="tectonics-stats">
            <span>Land: <span data-value="stat-land"></span>%</span>
            <span>Epoch: <span data-value="stat-epoch"></span></span>
          </span>
        </span>
      </label>
    </div>
    <div class="panel" data-panel="2">
      <label class="field field--icon-row">
        <span class="field-row">
          <button type="button" class="icon-button" data-action="reset-erosion" aria-label="Revert to tectonics result">
            <img src="/icons/reset.png" alt="" />
          </button>
          <button type="button" class="icon-button" data-action="erode" aria-label="Run erosion">
            <img src="/icons/erosion.png" alt="" />
          </button>
          <span class="erosion-status" data-value="erosion-status"></span>
          <button type="button" class="icon-button" data-action="toggle-debug-3d" aria-label="Debug: enter 3D preview">
            <img src="/icons/tilt_on.png" alt="" />
          </button>
          <button type="button" class="text-button" data-action="export" aria-label="Export world data for hex-tile conversion">Export</button>
        </span>
      </label>
    </div>
  `

  const seedInput = root.querySelector<HTMLInputElement>('.seed-input')!
  const plateCountInput = root.querySelector<HTMLInputElement>('.plate-count-input')!
  const plateCountLabel = root.querySelector<HTMLElement>('[data-value="plate-count-label"]')!
  const continentalCountInput = root.querySelector<HTMLInputElement>('.continental-count-input')!
  const continentalCountLabel = root.querySelector<HTMLElement>('[data-value="continental-count-label"]')!
  const randomizeButton = root.querySelector<HTMLButtonElement>('[data-action="randomize-seed"]')!
  const resetButton = root.querySelector<HTMLButtonElement>('[data-action="reset-sim"]')!
  const toggleSimButton = root.querySelector<HTMLButtonElement>('[data-action="toggle-sim"]')!
  const toggleSimIcon = toggleSimButton.querySelector<HTMLImageElement>('img')!
  const erodeButton = root.querySelector<HTMLButtonElement>('[data-action="erode"]')!
  const resetErosionButton = root.querySelector<HTMLButtonElement>('[data-action="reset-erosion"]')!
  const erosionStatus = root.querySelector<HTMLElement>('[data-value="erosion-status"]')!
  const toggleDebug3DButton = root.querySelector<HTMLButtonElement>('[data-action="toggle-debug-3d"]')!
  const exportButton = root.querySelector<HTMLButtonElement>('[data-action="export"]')!
  const statLand = root.querySelector<HTMLElement>('[data-value="stat-land"]')!
  const statEpoch = root.querySelector<HTMLElement>('[data-value="stat-epoch"]')!

  // Simulation and rendering both happen inside this worker (see
  // plateSimulationWorker.ts) — stepping an epoch and rendering the full
  // raster are heavy enough that doing them on the main thread stalled
  // camera panning/input for the duration of every tick.
  const worker = new Worker(new URL('../../worldgen/plateSimulationWorker.ts', import.meta.url), { type: 'module' })
  const postToWorker = (message: WorkerInboundMessage): void => worker.postMessage(message)

  let simRunning = false
  // Erosion (erosion.ts, run once on demand rather than every epoch —
  // see WorkerErodeMessage's own comment) only makes sense against a
  // settled field, so both erosion buttons stay disabled while tectonics
  // is actively ticking, and again for the stretch between clicking
  // either one and its render coming back — the worker only ever
  // processes one render at a time regardless of which of the two
  // triggered it, so a single in-flight flag covers both.
  let erosionOpInFlight = false
  const updateErosionButtonsState = (): void => {
    erodeButton.disabled = simRunning || erosionOpInFlight
    resetErosionButton.disabled = simRunning || erosionOpInFlight
  }

  const updateStats = (): void => {
    statLand.textContent = String(Math.round(lastLandFraction * 100))
    statEpoch.textContent = String(lastEpoch)
  }
  updateStats()

  // Continent-name labels need real font rendering (Canvas2D), which
  // isn't available inside the worker — it only ever produces a raw
  // pixel buffer (see elevationMapImage.ts). This reusable canvas
  // composites that buffer with the labels on the main thread each time
  // a render arrives: paint the buffer in as an image, draw text on top,
  // then read the combined result back out for the texture. This only
  // runs once per epoch tick (not per animation frame), so it doesn't
  // reintroduce the per-frame stall the worker migration was for.
  const labelCanvas = document.createElement('canvas')
  labelCanvas.width = MAP_WIDTH
  labelCanvas.height = MAP_HEIGHT
  const labelCtx = labelCanvas.getContext('2d')!

  function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.click()
    URL.revokeObjectURL(url)
  }

  // A browser can't write to an arbitrary filesystem path (the repo's
  // own /saves/ included) — this is the platform's actual ceiling, not a
  // choice. Triggers two ordinary downloads into wherever the browser's
  // normal downloads location is; move them into /saves/ by hand — see
  // saves/README.md for what the two files contain and why there are
  // two of them.
  function handleExportData(message: WorkerExportDataMessage): void {
    const safeSeed = message.seed.replace(/[^a-zA-Z0-9_-]/g, '_')
    const baseName = `world_${safeSeed}_epoch${message.epoch}`
    const metadata = {
      formatVersion: 1,
      seed: message.seed,
      epoch: message.epoch,
      width: message.width,
      height: message.height,
      landFraction: message.landFraction,
      elevationsFile: `${baseName}.f32`,
      plates: message.plates,
      terrainFeatures: message.terrainFeatures,
    }
    downloadBlob(new Blob([JSON.stringify(metadata, null, 2)], { type: 'application/json' }), `${baseName}.json`)
    downloadBlob(new Blob([message.elevations], { type: 'application/octet-stream' }), `${baseName}.f32`)
  }

  worker.onmessage = (event: MessageEvent<WorkerRenderedMessage | WorkerErosionProgressMessage | WorkerExportDataMessage>) => {
    const message = event.data

    if (message.type === 'erosionProgress') {
      erosionStatus.textContent = `${Math.round(message.fraction * 100)}%`
      return
    }

    if (message.type === 'exportData') {
      handleExportData(message)
      return
    }

    const imageData = new ImageData(new Uint8ClampedArray(message.buffer), message.width, message.height)
    labelCtx.putImageData(imageData, 0, 0)
    drawContinentLabels(labelCtx, message.labelPlacements)

    if (message.events) {
      for (const ev of message.events) {
        if (ev.type === 'continental_created' && ev.name) {
          ctx.notifications.show({
            message: `New continental plate just dropped: ${ev.name}`,
            icon: '/icons/continent.png',
            durationMs: 15000,
          })
        } else if (ev.type === 'oceanic_created') {
          ctx.notifications.show({
            message: 'New oceanic plate just dropped',
            icon: '/icons/ocean.png',
            durationMs: 15000,
          })
        } else if (ev.type === 'oceanic_subducted') {
          ctx.notifications.show({
            message: 'Oceanic plate subducted',
            icon: '/icons/ocean.png',
            durationMs: 15000,
          })
        } else if (ev.type === 'continental_merged') {
          const text = ev.nameA && ev.nameB ? `Continental plates merged: ${ev.nameA} & ${ev.nameB}` : 'Continental plates merged'
          ctx.notifications.show({
            message: text,
            icon: '/icons/continent.png',
            durationMs: 15000,
          })
        } else if (ev.type === 'continental_split') {
          const text = ev.name ? `Continental plate split: ${ev.name}` : 'Continental plate split'
          ctx.notifications.show({
            message: text,
            icon: '/icons/continent.png',
            durationMs: 15000,
          })
        }
      }
    }

    mapTexture.update(new Uint8Array(labelCtx.getImageData(0, 0, message.width, message.height).data.buffer))
    lastLandFraction = message.landFraction
    lastEpoch = message.epoch
    updateStats()

    // DEBUG 3D preview data — kept fresh on every render (see
    // WorkerRenderedMessage.debugHeightmapGrid), not just while the
    // preview is open, so toggling it on always shows the latest state
    // with no extra round trip. If the preview is already open when a
    // new render lands (e.g. Erode clicked again without leaving it),
    // rebuild immediately rather than leaving it showing a stale grid.
    debugHeightmapGrid = new Float32Array(message.debugHeightmapGrid)
    debugHeightmapGridWidth = message.debugHeightmapGridWidth
    debugHeightmapGridHeight = message.debugHeightmapGridHeight
    if (debug3DActive) rebuildDebugMesh()

    // Intermediate renders (see WorkerRenderedMessage.intermediate) are
    // one of 5 in-progress redraws an 'erode' request posts mid-flight —
    // the map/stats above should still reflect them live, but they're
    // not the operation finishing, so the buttons/status readout stay as
    // they are until the actual final render arrives.
    if (!message.intermediate) {
      erosionOpInFlight = false
      erosionStatus.textContent = ''
      updateErosionButtonsState()
    }
  }

  const initSim = (seed: string, plateCount: number, continentalCount: number): void => {
    postToWorker({
      type: 'init',
      seed,
      plateCount,
      continentalCount,
      width: MAP_WIDTH,
      height: MAP_HEIGHT,
      epochIntervalMs: EPOCH_INTERVAL_MS,
      renderOptions: { showBoundaries: SHOW_PLATE_BOUNDARIES, showArrows: SHOW_VELOCITY_ARROWS },
    })
  }
  initSim(initialSeed, TOTAL_PLATE_COUNT_DEFAULT, CONTINENTAL_COUNT_DEFAULT)

  const stopSim = (): void => {
    if (!simRunning) return
    simRunning = false
    postToWorker({ type: 'stop' })
    toggleSimIcon.src = '/icons/tectonics_off.png'
    toggleSimButton.setAttribute('aria-label', 'Run tectonics')
    seedInput.disabled = false
    plateCountInput.disabled = false
    continentalCountInput.disabled = false
    randomizeButton.disabled = false
    updateErosionButtonsState()
  }

  const startSim = (): void => {
    if (simRunning) return
    simRunning = true
    postToWorker({ type: 'start' })
    toggleSimIcon.src = '/icons/tectonics_on.png'
    toggleSimButton.setAttribute('aria-label', 'Stop tectonics')
    seedInput.disabled = true
    plateCountInput.disabled = true
    continentalCountInput.disabled = true
    randomizeButton.disabled = true
    updateErosionButtonsState()
  }

  toggleSimButton.addEventListener('click', () => {
    if (simRunning) stopSim()
    else startSim()
  })

  erodeButton.addEventListener('click', () => {
    if (simRunning || erosionOpInFlight) return
    erosionOpInFlight = true
    updateErosionButtonsState()
    postToWorker({ type: 'erode' })
  })

  resetErosionButton.addEventListener('click', () => {
    if (simRunning || erosionOpInFlight) return
    erosionOpInFlight = true
    updateErosionButtonsState()
    postToWorker({ type: 'resetErosion' })
  })

  toggleDebug3DButton.addEventListener('click', () => setDebug3DActive(!debug3DActive))

  exportButton.addEventListener('click', () => postToWorker({ type: 'export' }))

  const regenerate = (): void => {
    stopSim()
    // Otherwise a fresh sim would start ticking underneath a debug 3D
    // preview left showing the previous world's now-stale mesh.
    setDebug3DActive(false)
    ctx.notifications.clearAll()
    initSim(seedInput.value, Number(plateCountInput.value), Number(continentalCountInput.value))
  }
  resetButton.addEventListener('click', regenerate)
  seedInput.addEventListener('input', regenerate)
  randomizeButton.addEventListener('click', () => {
    seedInput.value = randomSeed()
    regenerate()
  })
  plateCountInput.addEventListener('input', () => {
    plateCountLabel.textContent = plateCountInput.value
    regenerate()
  })
  continentalCountInput.addEventListener('input', () => {
    continentalCountLabel.textContent = continentalCountInput.value
    regenerate()
  })

  // Same back/next convention as the sphere screen: back steps to the
  // previous panel, or exits to the title screen from the first one;
  // next steps forward and is a no-op past the last panel. Generation
  // parameters (seed, plate counts) live on panel 0, tectonics on panel
  // 1, erosion on panel 2 — future panels slot in the same way via the
  // data-panel pattern, with one more entry in PANEL_TITLES to match.
  const PANEL_TITLES = ['Genesis', 'Tectonics', 'Erosion']
  const panelTitle = root.querySelector<HTMLElement>('[data-value="panel-title"]')!
  const panels = Array.from(root.querySelectorAll<HTMLElement>('.panel'))
  let panelIndex = 0
  const showPanel = (index: number): void => {
    panelIndex = index
    panels.forEach((panel, i) => {
      panel.hidden = i !== index
    })
    panelTitle.textContent = PANEL_TITLES[index]
  }
  showPanel(0)

  root.querySelector('[data-action="back"]')!.addEventListener('click', () => {
    if (panelIndex > 0) {
      showPanel(panelIndex - 1)
      return
    }
    ctx.goTo('title')
  })
  root.querySelector('[data-action="next"]')!.addEventListener('click', () => {
    if (panelIndex < panels.length - 1) showPanel(panelIndex + 1)
  })

  ctx.overlay.appendChild(root)

  return {
    scene,
    dispose() {
      stopSim()
      worker.terminate()
      // scene.dispose() doesn't remove the camera module's own 'wheel'
      // listener on the shared canvas — same reasoning as MarsScreen's
      // dispose (see orbitSwoopCamera's equivalent comment).
      disposeCamera()
      scene.dispose()
    },
  }
}
