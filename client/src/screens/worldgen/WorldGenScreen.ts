import {
  ArcRotateCamera,
  Color3,
  HemisphericLight,
  MeshBuilder,
  PointerEventTypes,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
} from '@babylonjs/core'
import type { Screen, ScreenContext, ScreenFactory } from '../../app/Screen'
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
  material.diffuseColor = new Color3(0.2, 0.4, 0.8)
  material.wireframe = true
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
      </label>

      <label class="field">
        <span class="field-label">Axial tilt <span data-value="tilt">${DEFAULT_TILT_DEG}°</span></span>
        <input type="range" class="tilt-input" min="10" max="40" step="0.5" value="${DEFAULT_TILT_DEG}" />
      </label>

      <button data-action="run">Run Epoch</button>
      <button data-action="back">Back</button>
    </div>
  `

  const seedInput = root.querySelector<HTMLInputElement>('.seed-input')!
  seedInput.value = randomSeed()
  root.querySelector('[data-action="randomize-seed"]')!.addEventListener('click', () => {
    seedInput.value = randomSeed()
  })

  const continentsInput = root.querySelector<HTMLInputElement>('.continents-input')!
  const continentsValue = root.querySelector<HTMLElement>('[data-value="continents"]')!
  continentsInput.addEventListener('input', () => {
    continentsValue.textContent = continentsInput.value
  })

  const ratioInput = root.querySelector<HTMLInputElement>('.ratio-input')!
  const ratioValue = root.querySelector<HTMLElement>('[data-value="ratio"]')!
  ratioInput.addEventListener('input', () => {
    ratioValue.textContent = `${Math.round(Number(ratioInput.value) * 100)}%`
  })

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
