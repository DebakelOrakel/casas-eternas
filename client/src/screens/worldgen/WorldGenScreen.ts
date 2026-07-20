import {
  ArcRotateCamera,
  Color3,
  DirectionalLight,
  HemisphericLight,
  type Mesh,
  MeshBuilder,
  PointerEventTypes,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
  VertexBuffer,
  VertexData,
} from '@babylonjs/core'
import type { Screen, ScreenContext, ScreenFactory } from '../../app/Screen'
import {
  advanceCrustState,
  advanceTerrainFeatures,
  applyRiftAndMergeEvents,
  createCrustState,
  elevationAt,
  type CrustState,
} from '../../worldgen/crust'
import { generatePlateWorld, nearestPlateIndex, stepPlateEpoch, type PlateWorld } from '../../worldgen/plates'
import './worldgen.css'

const DEFAULT_TILT_DEG = 23.5
const PLANET_RADIUS = 1
const MIN_SCREEN_MARGIN = 0.1
const SPIN_SENSITIVITY = 0.01 // radians per pixel of drag
const DEFAULT_EPOCHS_PER_CLICK = 10
// Measured render cost at segments=96 (~245ms) comfortably fits this,
// with margin for the rest of renderWorld's per-frame work.
const EPOCH_STEP_DELAY_MS = 400

// Real elevation differences are a tiny fraction of a planet's radius —
// invisible at this scale — so uplift is deliberately exaggerated to read
// as actual terrain rather than a flat-colored sphere.
const ELEVATION_DISPLACEMENT_SCALE = 0.2
const MOUNTAIN_TINT: [number, number, number] = [0.85, 0.8, 0.72]
const RIFT_TINT: [number, number, number] = [0.05, 0.15, 0.35]

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

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function elevationTint(base: [number, number, number], elevation: number): [number, number, number] {
  const clamp01 = (value: number) => Math.min(1, Math.max(0, value))
  const uplift = clamp01((elevation - 0.05) / 0.3)
  const depression = clamp01((-elevation - 0.05) / 0.15)
  let [r, g, b] = base
  if (uplift > 0) {
    r = lerp(r, MOUNTAIN_TINT[0], uplift)
    g = lerp(g, MOUNTAIN_TINT[1], uplift)
    b = lerp(b, MOUNTAIN_TINT[2], uplift)
  }
  if (depression > 0) {
    r = lerp(r, RIFT_TINT[0], depression)
    g = lerp(g, RIFT_TINT[1], depression)
    b = lerp(b, RIFT_TINT[2], depression)
  }
  return [r, g, b]
}

// basePositions are the pristine unit-sphere vertex positions captured
// once at mesh creation — every render recomputes displacement from that
// fixed base rather than compounding onto the previous frame's already
// displaced geometry.
function renderWorld(planet: Mesh, basePositions: Float32Array, world: PlateWorld, crust: CrustState): void {
  const vertexCount = basePositions.length / 3
  const positions = new Float32Array(basePositions.length)
  const colors = new Float32Array(vertexCount * 4)
  const point = Vector3.Zero()

  for (let i = 0; i < vertexCount; i++) {
    const base = i * 3
    point.set(basePositions[base], basePositions[base + 1], basePositions[base + 2])
    point.normalize()

    const plateIndex = nearestPlateIndex(point, world)
    const elevation = elevationAt(point, world.types[plateIndex], world.ids[plateIndex], crust)
    const radius = 1 + elevation * ELEVATION_DISPLACEMENT_SCALE

    positions[base] = point.x * radius
    positions[base + 1] = point.y * radius
    positions[base + 2] = point.z * radius

    const [r, g, b] = elevationTint(world.colors[plateIndex], elevation)
    const colorBase = i * 4
    colors[colorBase] = r
    colors[colorBase + 1] = g
    colors[colorBase + 2] = b
    colors[colorBase + 3] = 1
  }

  planet.setVerticesData(VertexBuffer.PositionKind, positions, true)
  planet.setVerticesData(VertexBuffer.ColorKind, colors, true)

  const normals = new Float32Array(positions.length)
  VertexData.ComputeNormals(positions, planet.getIndices()!, normals)
  planet.setVerticesData(VertexBuffer.NormalKind, normals, true)
}

export const createWorldGenScreen: ScreenFactory = (ctx: ScreenContext): Screen => {
  const scene = new Scene(ctx.engine)

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

  // A straight-overhead HemisphericLight has no direction to rake across a
  // bump, and specular was fully off — so the real vertex displacement in
  // renderWorld had nothing to actually reveal it as shape. A low-angle
  // directional "sun" plus a small, tight specular gives terrain visible
  // highlight/shadow contrast; the weak hemispheric stays only as an
  // ambient fill so the unlit side isn't pure black.
  const sunLight = new DirectionalLight('sun', new Vector3(0.5, -0.5, 0.6), scene)
  sunLight.intensity = 1.1
  const fillLight = new HemisphericLight('fill', new Vector3(0, 1, 0), scene)
  fillLight.intensity = 0.35

  const planet = MeshBuilder.CreateSphere('planet', { diameter: 2, segments: 96 }, scene)
  planet.parent = spinPivot
  const material = new StandardMaterial('planetMaterial', scene)
  material.diffuseColor = new Color3(1, 1, 1)
  material.specularColor = new Color3(0.15, 0.15, 0.15)
  material.specularPower = 48
  planet.material = material
  const basePositions = Float32Array.from(planet.getVerticesData(VertexBuffer.PositionKind)!)

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

  let world: PlateWorld
  let crust: CrustState
  let epochCount = 0
  let disposed = false
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
      setControlsDisabled(false)
      runButton.textContent = 'Run Epoch'
    }
  }

  const updateInfo = () => {
    // Continental/oceanic counts are read live from world, not the slider
    // — under rift/merge, they drift from the generation-time parameter
    // (rifts add oceanic plates, merges remove continental ones).
    const continentalCount = world.totalCount - world.oceanicCount
    const oldestPlateAge = Math.max(...world.ages)
    plateInfo.textContent =
      `${world.totalCount} plates total — ${continentalCount} continental, ${world.oceanicCount} oceanic` +
      ` · epoch ${epochCount} · oldest plate ${oldestPlateAge}`
  }

  const regenerateWorld = () => {
    cancelEpochRun()
    const seedText = seedInput.value
    const continentCount = Number(continentsInput.value)
    const ratio = Number(ratioInput.value)
    world = generatePlateWorld(seedText, continentCount, ratio)
    crust = createCrustState(seedText, continentCount, ratio, world.totalCount)
    epochCount = 0
    renderWorld(planet, basePositions, world, crust)
    updateInfo()
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

  const runEpochs = (remaining: number, total: number) => {
    if (disposed || remaining <= 0) {
      pendingTimeoutId = undefined
      setControlsDisabled(false)
      runButton.textContent = 'Run Epoch'
      return
    }
    stepPlateEpoch(world)
    advanceTerrainFeatures(crust, world)
    advanceCrustState(crust, world)
    applyRiftAndMergeEvents(crust, world)
    epochCount += 1
    renderWorld(planet, basePositions, world, crust)
    updateInfo()
    runButton.textContent = `Running… (${total - remaining + 1}/${total})`
    pendingTimeoutId = setTimeout(() => runEpochs(remaining - 1, total), EPOCH_STEP_DELAY_MS)
  }

  runButton.addEventListener('click', () => {
    if (pendingTimeoutId !== undefined) return
    const epochsPerClick = Math.max(1, Math.round(Number(epochsInput.value) || DEFAULT_EPOCHS_PER_CLICK))
    setControlsDisabled(true)
    runEpochs(epochsPerClick, epochsPerClick)
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
      window.removeEventListener('resize', updateMinZoom)
      scene.dispose()
    },
  }
}
