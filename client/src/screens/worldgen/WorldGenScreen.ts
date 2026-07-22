import { Color3, Color4, MeshBuilder, RawTexture, Scene, StandardMaterial } from '@babylonjs/core'
import type { InstancedMesh } from '@babylonjs/core'
import { createHexMapCamera } from '../../camera/hexMapCamera'
import type { Screen, ScreenContext, ScreenFactory } from '../../app/Screen'
import { MAP_HEIGHT, MAP_WIDTH } from '../../worldgen/mapConfig'
import type { WorkerInboundMessage, WorkerRenderedMessage } from '../../worldgen/plateSimulationWorker'
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

// Real Earth has ~15 major plates — 25 gives a first look with a bit more
// texture without being a different order of magnitude.
const PLATE_COUNT = 25

const CONTINENTAL_COUNT_MIN = 7
const CONTINENTAL_COUNT_MAX = 17
const CONTINENTAL_COUNT_DEFAULT = 12

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

  const { camera, dispose: disposeCamera } = createHexMapCamera({
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

  scene.onBeforeRenderObservable.add(() => {
    const centerX = Math.round(camera.position.x / WORLD_WIDTH) * WORLD_WIDTH
    const centerZ = Math.round(camera.position.z / WORLD_HEIGHT) * WORLD_HEIGHT
    mapTile.position.set(centerX, 0, centerZ)
    let i = 0
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue
        wrapInstances[i].position.set(centerX + dx * WORLD_WIDTH, 0, centerZ + dz * WORLD_HEIGHT)
        i++
      }
    }
  })

  const root = document.createElement('div')
  root.className = 'worldgen-screen'
  root.innerHTML = `
    <button type="button" class="nav-arrow nav-arrow--back" data-action="back" aria-label="Back">‹</button>
    <button type="button" class="nav-arrow nav-arrow--next" data-action="next" aria-label="Next">›</button>
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
      <label class="field field--tectonics">
        <span class="field-row">
          <input
            type="range"
            class="continental-count-input"
            min="${CONTINENTAL_COUNT_MIN}"
            max="${CONTINENTAL_COUNT_MAX}"
            step="1"
            value="${CONTINENTAL_COUNT_DEFAULT}"
          />
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
  `

  const seedInput = root.querySelector<HTMLInputElement>('.seed-input')!
  const continentalCountInput = root.querySelector<HTMLInputElement>('.continental-count-input')!
  const randomizeButton = root.querySelector<HTMLButtonElement>('[data-action="randomize-seed"]')!
  const toggleSimButton = root.querySelector<HTMLButtonElement>('[data-action="toggle-sim"]')!
  const toggleSimIcon = toggleSimButton.querySelector<HTMLImageElement>('img')!
  const statLand = root.querySelector<HTMLElement>('[data-value="stat-land"]')!
  const statEpoch = root.querySelector<HTMLElement>('[data-value="stat-epoch"]')!

  // Simulation and rendering both happen inside this worker (see
  // plateSimulationWorker.ts) — stepping an epoch and rendering the full
  // raster are heavy enough that doing them on the main thread stalled
  // camera panning/input for the duration of every tick.
  const worker = new Worker(new URL('../../worldgen/plateSimulationWorker.ts', import.meta.url), { type: 'module' })
  const postToWorker = (message: WorkerInboundMessage): void => worker.postMessage(message)

  let simRunning = false

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

  worker.onmessage = (event: MessageEvent<WorkerRenderedMessage>) => {
    const message = event.data
    const imageData = new ImageData(new Uint8ClampedArray(message.buffer), message.width, message.height)
    labelCtx.putImageData(imageData, 0, 0)
    drawContinentLabels(labelCtx, message.labelPlacements)
    mapTexture.update(new Uint8Array(labelCtx.getImageData(0, 0, message.width, message.height).data.buffer))
    lastLandFraction = message.landFraction
    lastEpoch = message.epoch
    updateStats()
  }

  const initSim = (seed: string, continentalCount: number): void => {
    postToWorker({
      type: 'init',
      seed,
      plateCount: PLATE_COUNT,
      continentalCount,
      width: MAP_WIDTH,
      height: MAP_HEIGHT,
      epochIntervalMs: EPOCH_INTERVAL_MS,
      renderOptions: { showBoundaries: SHOW_PLATE_BOUNDARIES, showArrows: SHOW_VELOCITY_ARROWS },
    })
  }
  initSim(initialSeed, CONTINENTAL_COUNT_DEFAULT)

  const stopSim = (): void => {
    if (!simRunning) return
    simRunning = false
    postToWorker({ type: 'stop' })
    toggleSimIcon.src = '/icons/tectonics_off.png'
    toggleSimButton.setAttribute('aria-label', 'Run tectonics')
    seedInput.disabled = false
    continentalCountInput.disabled = false
    randomizeButton.disabled = false
  }

  const startSim = (): void => {
    if (simRunning) return
    simRunning = true
    postToWorker({ type: 'start' })
    toggleSimIcon.src = '/icons/tectonics_on.png'
    toggleSimButton.setAttribute('aria-label', 'Stop tectonics')
    seedInput.disabled = true
    continentalCountInput.disabled = true
    randomizeButton.disabled = true
  }

  toggleSimButton.addEventListener('click', () => {
    if (simRunning) stopSim()
    else startSim()
  })

  const regenerate = (): void => {
    stopSim()
    initSim(seedInput.value, Number(continentalCountInput.value))
  }
  seedInput.addEventListener('input', regenerate)
  randomizeButton.addEventListener('click', () => {
    seedInput.value = randomSeed()
    regenerate()
  })
  continentalCountInput.addEventListener('input', () => {
    regenerate()
  })

  // Same back/next convention as the sphere screen: back steps to the
  // previous panel, or exits to the title screen from the first one;
  // next steps forward and is a no-op past the last panel. Only one
  // panel exists so far — this is the shell future hex-tile panels
  // (generation controls, etc.) slot into via the same data-panel pattern.
  const panels = Array.from(root.querySelectorAll<HTMLElement>('.panel'))
  let panelIndex = 0
  const showPanel = (index: number): void => {
    panelIndex = index
    panels.forEach((panel, i) => {
      panel.hidden = i !== index
    })
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
