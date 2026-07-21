import {
  ArcRotateCamera,
  Color3,
  Color4,
  HemisphericLight,
  MeshBuilder,
  PointerEventTypes,
  RawTexture,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
} from '@babylonjs/core'
import type { Screen, ScreenContext, ScreenFactory } from '../../app/Screen'
import { TEXTURE_HEIGHT, TEXTURE_WIDTH } from '../../worldgen/textureConfig'
import type { WorkerResponse } from '../../worldgen/worldgen.worker'
import './worldgen.css'

const DEFAULT_TILT_DEG = 23.5
const PLANET_RADIUS = 1
const MIN_SCREEN_MARGIN = 0.1
const SPIN_SENSITIVITY = 0.01 // radians per pixel of drag
const DEFAULT_EPOCHS_PER_CLICK = 10
// Pacing between epoch steps once each one's result is back from the
// worker — purely cosmetic now (the worker computing doesn't block
// anything on the main thread), kept so a run still reads as gradual
// progress rather than a flash-cut straight to the final state.
const EPOCH_STEP_DELAY_MS = 500

function randomSeed(): string {
  return Math.floor(Math.random() * 1_000_000_000).toString()
}

function computeMinCameraRadius(camera: ArcRotateCamera, aspectRatio: number): number {
  const coverage = 1 - 2 * MIN_SCREEN_MARGIN
  const halfVFov = camera.fov / 2
  const halfHFov = Math.atan(Math.tan(halfVFov) * aspectRatio)

  const distanceForHeight = PLANET_RADIUS / (coverage * Math.tan(halfVFov))
  const distanceForWidth = PLANET_RADIUS / (coverage * Math.tan(halfHFov))

  return Math.max(distanceForHeight, distanceForWidth)
}

export const createWorldGenScreen: ScreenFactory = (ctx: ScreenContext): Screen => {
  const scene = new Scene(ctx.engine)
  scene.clearColor = new Color4(1, 1, 1, 1)
  // Procedural starfield (./starfield.ts) is built but deliberately not
  // wired in here — the shape/orientation/band math all checked out
  // numerically, but the actual rendered look wasn't good. Left in place
  // rather than deleted, for a future pass; re-enable with
  // `createStarfield(scene)` (not parented to anything, so it stays fixed
  // while the planet spins).

  // The pole's own orientation: tilting this leans the pole stick and the
  // planet's spin axis relative to the (fixed) camera.
  const tiltPivot = new TransformNode('tiltPivot', scene)
  tiltPivot.rotation.z = (DEFAULT_TILT_DEG * Math.PI) / 180

  // The planet spins around the pole's local axis, independently of tilt.
  const spinPivot = new TransformNode('spinPivot', scene)
  spinPivot.parent = tiltPivot

  // Camera stays fixed — dragging spins the planet, not the view.
  const camera = new ArcRotateCamera('camera', -Math.PI / 2, Math.PI / 2.5, 6, Vector3.Zero(), scene)
  camera.attachControl(ctx.canvas, true)
  camera.lowerAlphaLimit = camera.alpha
  camera.upperAlphaLimit = camera.alpha
  camera.lowerBetaLimit = camera.beta
  camera.upperBetaLimit = camera.beta
  camera.panningSensibility = 0

  const updateMinZoom = () => {
    const aspectRatio = ctx.engine.getRenderWidth() / ctx.engine.getRenderHeight()
    camera.lowerRadiusLimit = computeMinCameraRadius(camera, aspectRatio)
    if (camera.radius < camera.lowerRadiusLimit) {
      camera.radius = camera.lowerRadiusLimit
    }
  }
  updateMinZoom()
  camera.radius = camera.lowerRadiusLimit!
  window.addEventListener('resize', updateMinZoom)

  // Soft, mostly-ambient light — no terrain bumps to reveal anymore, so
  // no need for a raking directional light or specular; both would just
  // add unwanted glare/highlight on what's meant to read as a flat,
  // matte informational map.
  new HemisphericLight('fill', new Vector3(0.3, 1, 0.2), scene).intensity = 0.95

  // Plain sphere — no need for the icosphere/welding/adjacency machinery
  // the previous vertex-displacement approach needed, since nothing is
  // computed per-vertex anymore. Its default UVs already match the
  // equirectangular texture's u/v convention.
  const planet = MeshBuilder.CreateSphere('planet', { diameter: PLANET_RADIUS * 2, segments: 48 }, scene)
  planet.parent = spinPivot
  const material = new StandardMaterial('planetMaterial', scene)
  material.diffuseColor = new Color3(1, 1, 1)
  material.specularColor = new Color3(0, 0, 0)
  planet.material = material

  const worldTexture = RawTexture.CreateRGBATexture(
    new Uint8Array(TEXTURE_WIDTH * TEXTURE_HEIGHT * 4),
    TEXTURE_WIDTH,
    TEXTURE_HEIGHT,
    scene,
    false,
    true,
  )
  material.diffuseTexture = worldTexture

  const poleAxis = MeshBuilder.CreateCylinder('poleAxis', { diameter: 0.04, height: 2.6, tessellation: 12 }, scene)
  poleAxis.parent = tiltPivot
  const poleMaterial = new StandardMaterial('poleMaterial', scene)
  poleMaterial.diffuseColor = new Color3(0.85, 0.2, 0.2)
  poleMaterial.emissiveColor = new Color3(0.4, 0.05, 0.05)
  poleAxis.material = poleMaterial

  let isDragging = false
  let lastPointerX = 0
  scene.onPointerObservable.add((pointerInfo) => {
    if (pointerInfo.type === PointerEventTypes.POINTERDOWN) {
      isDragging = true
      lastPointerX = pointerInfo.event.clientX
    } else if (pointerInfo.type === PointerEventTypes.POINTERUP) {
      isDragging = false
    } else if (pointerInfo.type === PointerEventTypes.POINTERMOVE && isDragging) {
      const deltaX = pointerInfo.event.clientX - lastPointerX
      lastPointerX = pointerInfo.event.clientX
      spinPivot.rotation.y += deltaX * SPIN_SENSITIVITY
    }
  })

  const root = document.createElement('div')
  root.className = 'worldgen-screen'
  root.innerHTML = `
    <div class="panel">
      <label class="field">
        <span class="field-label">Seed</span>
        <span class="field-row">
          <input type="text" class="seed-input" />
          <button type="button" data-action="randomize-seed" title="Randomize seed">⟳</button>
        </span>
      </label>

      <label class="field">
        <span class="field-label">Continents <span data-value="continents">7</span></span>
        <input type="range" class="continents-input" min="3" max="13" step="1" value="7" />
      </label>

      <label class="field">
        <span class="field-label">Land / ocean ratio <span data-value="ratio">35%</span></span>
        <input type="range" class="ratio-input" min="0" max="1" step="0.01" value="0.35" />
        <span class="plate-info" data-value="plate-info"></span>
      </label>

      <label class="field">
        <span class="field-label">Axial tilt <span data-value="tilt">${DEFAULT_TILT_DEG}°</span></span>
        <input type="range" class="tilt-input" min="10" max="40" step="0.5" value="${DEFAULT_TILT_DEG}" />
      </label>

      <label class="field">
        <span class="field-label">Epochs per click</span>
        <input type="number" class="epochs-input" min="1" max="100" step="1" value="${DEFAULT_EPOCHS_PER_CLICK}" />
      </label>

      <button data-action="run">Run Epoch</button>
      <button data-action="back">Back</button>
    </div>
  `

  const plateInfo = root.querySelector<HTMLElement>('[data-value="plate-info"]')!
  const seedInput = root.querySelector<HTMLInputElement>('.seed-input')!
  const continentsInput = root.querySelector<HTMLInputElement>('.continents-input')!
  const continentsValue = root.querySelector<HTMLElement>('[data-value="continents"]')!
  const ratioInput = root.querySelector<HTMLInputElement>('.ratio-input')!
  const ratioValue = root.querySelector<HTMLElement>('[data-value="ratio"]')!
  const epochsInput = root.querySelector<HTMLInputElement>('.epochs-input')!
  const randomizeButton = root.querySelector<HTMLButtonElement>('[data-action="randomize-seed"]')!
  const runButton = root.querySelector<HTMLButtonElement>('[data-action="run"]')!

  // All simulation state (PlateWorld/CrustState) and the expensive
  // per-epoch texture generation now live entirely in this worker — see
  // worldgen.worker.ts for why. The main thread only ever sends a
  // command and applies whatever pixel buffer comes back; nothing here
  // can block a render frame or a pointer-drag handler on simulation
  // cost anymore.
  const worker = new Worker(new URL('../../worldgen/worldgen.worker.ts', import.meta.url), { type: 'module' })

  let latestState: WorkerResponse | undefined
  let disposed = false
  let isRunning = false
  let epochsRemaining = 0
  let epochsTotal = 0
  let pendingTimeoutId: ReturnType<typeof setTimeout> | undefined

  const setControlsDisabled = (disabled: boolean) => {
    seedInput.disabled = disabled
    continentsInput.disabled = disabled
    ratioInput.disabled = disabled
    epochsInput.disabled = disabled
    randomizeButton.disabled = disabled
    runButton.disabled = disabled
  }

  const cancelEpochRun = () => {
    if (pendingTimeoutId !== undefined) {
      clearTimeout(pendingTimeoutId)
      pendingTimeoutId = undefined
    }
    if (isRunning) {
      isRunning = false
      epochsRemaining = 0
      setControlsDisabled(false)
      runButton.textContent = 'Run Epoch'
    }
  }

  const updateInfo = () => {
    if (!latestState) return
    plateInfo.textContent =
      `${latestState.totalCount} plates total — ${latestState.continentalCount} continental, ${latestState.oceanicCount} oceanic` +
      ` · epoch ${latestState.epochCount} · oldest plate ${latestState.oldestPlateAge}`
  }

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    if (disposed) return
    latestState = event.data
    worldTexture.update(latestState.pixels)
    updateInfo()

    if (!isRunning) return
    epochsRemaining -= 1
    if (epochsRemaining <= 0) {
      isRunning = false
      setControlsDisabled(false)
      runButton.textContent = 'Run Epoch'
      return
    }
    runButton.textContent = `Running… (${epochsTotal - epochsRemaining}/${epochsTotal})`
    pendingTimeoutId = setTimeout(() => {
      pendingTimeoutId = undefined
      worker.postMessage({ type: 'stepEpoch' })
    }, EPOCH_STEP_DELAY_MS)
  }

  const regenerateWorld = () => {
    cancelEpochRun()
    worker.postMessage({
      type: 'init',
      seedText: seedInput.value,
      continentCount: Number(continentsInput.value),
      ratio: Number(ratioInput.value),
    })
  }

  seedInput.value = randomSeed()
  seedInput.addEventListener('input', regenerateWorld)
  randomizeButton.addEventListener('click', () => {
    seedInput.value = randomSeed()
    regenerateWorld()
  })

  continentsInput.addEventListener('input', () => {
    continentsValue.textContent = continentsInput.value
    regenerateWorld()
  })

  ratioInput.addEventListener('input', () => {
    ratioValue.textContent = `${Math.round(Number(ratioInput.value) * 100)}%`
    regenerateWorld()
  })

  regenerateWorld()

  const tiltInput = root.querySelector<HTMLInputElement>('.tilt-input')!
  const tiltValue = root.querySelector<HTMLElement>('[data-value="tilt"]')!
  tiltInput.addEventListener('input', () => {
    const deg = Number(tiltInput.value)
    tiltValue.textContent = `${deg}°`
    tiltPivot.rotation.z = (deg * Math.PI) / 180
  })

  runButton.addEventListener('click', () => {
    if (isRunning) return
    epochsTotal = Math.max(1, Math.round(Number(epochsInput.value) || DEFAULT_EPOCHS_PER_CLICK))
    epochsRemaining = epochsTotal
    isRunning = true
    setControlsDisabled(true)
    runButton.textContent = `Running… (1/${epochsTotal})`
    worker.postMessage({ type: 'stepEpoch' })
  })

  root.querySelector('[data-action="back"]')!.addEventListener('click', () => {
    ctx.goTo('title')
  })
  ctx.overlay.appendChild(root)

  return {
    scene,
    dispose() {
      disposed = true
      cancelEpochRun()
      worker.terminate()
      window.removeEventListener('resize', updateMinZoom)
      scene.dispose()
    },
  }
}
