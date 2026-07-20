import {
  ArcRotateCamera,
  Color3,
  HemisphericLight,
  type Mesh,
  MeshBuilder,
  PointerEventTypes,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
  VertexBuffer,
} from '@babylonjs/core'
import type { Screen, ScreenContext, ScreenFactory } from '../../app/Screen'
import { generatePlateWorld, nearestPlateIndex, type PlateWorld } from '../../worldgen/plates'
import './worldgen.css'

const DEFAULT_TILT_DEG = 23.5
const PLANET_RADIUS = 1
const MIN_SCREEN_MARGIN = 0.1
const SPIN_SENSITIVITY = 0.01 // radians per pixel of drag

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

function applyPlateColoring(planet: Mesh, world: PlateWorld): void {
  const positions = planet.getVerticesData(VertexBuffer.PositionKind)!
  const colors = new Float32Array((positions.length / 3) * 4)
  const point = Vector3.Zero()
  for (let i = 0; i < positions.length; i += 3) {
    point.set(positions[i], positions[i + 1], positions[i + 2])
    point.normalize()
    const [r, g, b] = world.colors[nearestPlateIndex(point, world)]
    const base = (i / 3) * 4
    colors[base] = r
    colors[base + 1] = g
    colors[base + 2] = b
    colors[base + 3] = 1
  }
  planet.setVerticesData(VertexBuffer.ColorKind, colors, true)
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

  new HemisphericLight('light', new Vector3(0, 1, 0), scene)

  const planet = MeshBuilder.CreateSphere('planet', { diameter: 2, segments: 64 }, scene)
  planet.parent = spinPivot
  const material = new StandardMaterial('planetMaterial', scene)
  material.diffuseColor = new Color3(1, 1, 1)
  material.specularColor = new Color3(0, 0, 0)
  planet.material = material

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

  const regenerateWorld = () => {
    const world = generatePlateWorld(seedInput.value, Number(continentsInput.value), Number(ratioInput.value))
    applyPlateColoring(planet, world)
    plateInfo.textContent = `${world.totalCount} plates total — ${continentsInput.value} continental, ${world.oceanicCount} oceanic`
  }

  seedInput.value = randomSeed()
  seedInput.addEventListener('input', regenerateWorld)
  root.querySelector('[data-action="randomize-seed"]')!.addEventListener('click', () => {
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

  root.querySelector('[data-action="run"]')!.addEventListener('click', () => {
    // TODO: step the worldgen/ simulation module by one epoch and refresh the visualization
  })
  root.querySelector('[data-action="back"]')!.addEventListener('click', () => {
    ctx.goTo('title')
  })
  ctx.overlay.appendChild(root)

  return {
    scene,
    dispose() {
      window.removeEventListener('resize', updateMinZoom)
      scene.dispose()
    },
  }
}
