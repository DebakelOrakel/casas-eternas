import {
  Color3,
  Color4,
  DirectionalLight,
  DynamicTexture,
  Effect,
  FreeCamera,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  PointerEventTypes,
  PostProcess,
  Quaternion,
  RawTexture,
  RenderTargetTexture,
  Scene,
  StandardMaterial,
  Texture,
  TransformNode,
  Vector3,
  VertexData,
} from '@babylonjs/core'
import type { Screen, ScreenContext, ScreenFactory } from '../../app/Screen'
import { TEXTURE_HEIGHT, TEXTURE_WIDTH } from '../../worldgen/textureConfig'
import type { WorkerResponse } from '../../worldgen/worldgen.worker'
import './worldgen.css'

const DEFAULT_TILT_DEG = 23.5
const PLANET_RADIUS = 1
// Fixed low-orbit camera shot — see the camera setup below for how these
// combine. Chosen by simulating camera rays against the sphere in a
// headless script and checking the resulting hit/miss grid (not
// hand-derived): this combination puts the horizon near the top of frame
// with the rest of the frame showing ground, "satellite/low-orbit" style.
const HOVER_BETA_DEG = 35 // how far the camera's hover point is from the north pole
const ALTITUDE_FACTOR = 0.6 // camera altitude above the surface, as a fraction of PLANET_RADIUS
const PITCH_DEG = 75 // how far below the local horizontal the camera looks
const CAMERA_FOV = 1.0
const DRAG_SENSITIVITY = 0.01 // radians per pixel of horizontal drag
// Wheel deltaY is typically ~100 per notch on a mouse, but can run into
// the thousands for a fast trackpad swipe — much larger and less
// consistent than pointer-drag pixel deltas, hence the much smaller
// coefficient than the drag sensitivity above.
const ROLL_SENSITIVITY = 0.0008
// Very slow — one full turn every 3 minutes — so it reads as "this is a
// living planet" in the background without demanding attention.
const AUTO_ROTATION_SECONDS_PER_TURN = 180
// Pacing between epoch steps once each one's result is back from the
// worker — purely cosmetic now (the worker computing doesn't block
// anything on the main thread), kept so a run still reads as gradual
// progress rather than a flash-cut straight to the final state.
const EPOCH_STEP_DELAY_MS = 500

function randomSeed(): string {
  return Math.floor(Math.random() * 1_000_000_000).toString()
}

// A small spherical-cap patch (not a flat disc) so the north-pole marker
// actually conforms to the planet's curvature instead of floating tangent
// to it — a flat disc's edges visibly lift away from the surface at this
// scale. angularRadius is the cap's half-angle from the pole axis, in
// radians. Winding for the ring-to-ring quads was verified directly
// (not assumed) via a headless script computing per-vertex normals with
// VertexData.ComputeNormals — the fan and the quads must wind the same
// rotational sense or half the patch's normals point inward.
function createPoleCapMesh(name: string, angularRadius: number, radius: number, rings: number, tessellation: number, scene: Scene): Mesh {
  const positions = [0, radius, 0]
  const uvs = [0.5, 0.5]
  const indices: number[] = []
  const maxRingRadius = Math.sin(angularRadius) * radius
  const indexOf = (ring: number, seg: number) => 1 + (ring - 1) * tessellation + (seg % tessellation)

  for (let ring = 1; ring <= rings; ring++) {
    const theta = (angularRadius * ring) / rings
    const y = Math.cos(theta) * radius
    const ringRadius = Math.sin(theta) * radius
    for (let seg = 0; seg < tessellation; seg++) {
      const phi = (seg / tessellation) * Math.PI * 2
      const x = ringRadius * Math.cos(phi)
      const z = ringRadius * Math.sin(phi)
      positions.push(x, y, z)
      uvs.push(0.5 + 0.5 * (x / maxRingRadius), 0.5 + 0.5 * (z / maxRingRadius))
    }
  }

  for (let seg = 0; seg < tessellation; seg++) {
    indices.push(0, indexOf(1, seg), indexOf(1, seg + 1))
  }
  for (let ring = 1; ring < rings; ring++) {
    for (let seg = 0; seg < tessellation; seg++) {
      const a = indexOf(ring, seg)
      const b = indexOf(ring, seg + 1)
      const c = indexOf(ring + 1, seg)
      const d = indexOf(ring + 1, seg + 1)
      indices.push(a, c, d)
      indices.push(a, d, b)
    }
  }

  const normals: number[] = []
  VertexData.ComputeNormals(positions, indices, normals)
  const vertexData = new VertexData()
  vertexData.positions = positions
  vertexData.indices = indices
  vertexData.uvs = uvs
  vertexData.normals = normals
  const mesh = new Mesh(name, scene)
  vertexData.applyToMesh(mesh)
  return mesh
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

  // Outermost node: free mouse-drag reorientation (see the pointer
  // handler below), independent of both the planet's own simulated spin
  // and its axial tilt. This is what lets the globe be viewed from any
  // angle now, not just spun around its own pole.
  const viewPivot = new TransformNode('viewPivot', scene)

  // The pole's own orientation: tilting this leans the pole stick and the
  // planet's spin axis relative to the (fixed) camera.
  const tiltPivot = new TransformNode('tiltPivot', scene)
  tiltPivot.rotation.z = (DEFAULT_TILT_DEG * Math.PI) / 180
  tiltPivot.parent = viewPivot

  // The planet spins around the pole's local axis, independently of tilt
  // — driven only by the continuous auto-rotation below now, not by
  // dragging (which moved to viewPivot).
  const spinPivot = new TransformNode('spinPivot', scene)
  spinPivot.parent = tiltPivot

  // Camera stays fixed — dragging spins the planet, not the view. Not an
  // ArcRotateCamera aimed at the sphere's center this time: that always
  // renders the horizon as a circle centered on screen no matter the
  // angle (confirmed directly — that's what made an earlier close-up
  // attempt look like "just the pole, no sense of a globe"). A FreeCamera
  // hovering just above the surface, pitched down to look forward and
  // down (not straight at the center), is what puts the horizon high in
  // frame with the rest showing ground.
  const hoverBeta = (HOVER_BETA_DEG * Math.PI) / 180
  const hoverDirection = new Vector3(0, Math.cos(hoverBeta), -Math.sin(hoverBeta))
  const cameraPosition = hoverDirection.scale(PLANET_RADIUS * (1 + ALTITUDE_FACTOR))
  const nadir = hoverDirection.scale(-1)
  // "Forward" along the surface, toward the pole — the direction the
  // camera looks across, before pitching down toward the ground.
  const tangentForward = Vector3.Up().subtract(hoverDirection.scale(Vector3.Dot(Vector3.Up(), hoverDirection))).normalize()
  const pitch = (PITCH_DEG * Math.PI) / 180
  const lookDirection = tangentForward.scale(Math.cos(pitch)).add(nadir.scale(Math.sin(pitch))).normalize()

  const camera = new FreeCamera('camera', cameraPosition, scene)
  camera.setTarget(cameraPosition.add(lookDirection))
  camera.fov = CAMERA_FOV
  // Default minZ (1) would clip the ground itself — the camera sits only
  // ALTITUDE_FACTOR (0.4) units above the surface.
  camera.minZ = 0.05

  // The camera's own "right" axis in world space — used below as the
  // rotation axis for vertical drag, so dragging up/down tilts the globe
  // the same way it visually reads on screen. Read directly off the
  // camera's world matrix (forcing an immediate compute, since no frame
  // has actually rendered yet at this point in setup) rather than
  // hand-derived, same reasoning as the sun-direction comment above.
  camera.computeWorldMatrix()
  const cameraRightAxis = Vector3.TransformNormal(new Vector3(1, 0, 0), camera.getWorldMatrix()).normalize()

  // Sun sits behind the viewer (not behind the planet), slightly to the
  // viewer's right, confined to the "solar plane" — the plane through
  // the screen's left-right axis and the camera's forward/depth axis,
  // i.e. zero vertical (up-axis) component. Direction is a fixed literal,
  // not derived from the camera at runtime, because the camera's
  // position/orientation are themselves fixed constants above (never
  // change) — computed once via camera.getWorldMatrix()'s actual
  // right/forward/up basis vectors for this exact camera setup, not
  // hand-derived, to avoid a cross-product handedness mistake:
  // -forward + 0.3*right, normalized, negated (DirectionalLight.direction
  // is the light's *travel* direction, i.e. the opposite of where it
  // sits) — verified dot(sourceDir, up) == 0 before negating. Recomputed
  // from scratch when the camera moved from an orbit camera to this
  // hovering one — the old literal was relative to the old camera's
  // basis vectors and no longer applies.
  const sunLight = new DirectionalLight('sun', new Vector3(-0.287, -0.549, 0.785), scene)
  sunLight.intensity = 1.1
  // Not zero — the far side of the sphere (facing away from both viewer
  // and sun) would otherwise fall to pure black, since no terrain bumps
  // exist anymore for a raking light to reveal; this just keeps the
  // faint land/water texture legible on the unlit side.
  new HemisphericLight('fill', new Vector3(0.3, 1, 0.2), scene).intensity = 0.5

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

  // Atmosphere rim, take 2. A Fresnel/surface-normal glow (tried first)
  // naturally spills across most of the visible ground here, not just a
  // thin edge — because the camera sits very close to the surface
  // (altitude 0.4x radius) and looks across it at an angle, most of the
  // ground filling the frame is already fairly oblique to the camera, so
  // a view-angle-based glow lights up a lot of it, not just the true
  // silhouette. This version detects the actual silhouette in screen
  // space instead, independent of surface angle:
  //  1. A plain-white duplicate of the planet mesh, rendered into a
  //     render target — a mask of "is this pixel part of the planet"
  //     from the camera's exact viewpoint. Hidden from the main view
  //     otherwise. High enough resolution that the sphere's own edge
  //     isn't visibly blocky — a first pass at 48px wide showed a
  //     staircase where the circle should be smooth, since a texture
  //     that coarse can't represent a round edge at all, blur or not.
  //  2. The actual blur — and therefore the glow band's width — comes
  //     from an explicit multi-tap sample of that mask in the shader
  //     below, not from the mask's resolution. Decoupling the two is
  //     what fixes the staircase: the mask can be sharp/detailed, and
  //     blur amount is a dedicated, independently-tunable knob.
  //  3. A post-process blends in glowColor using 4*m*(1-m), where m is
  //     that blurred mask value — a parabola that's 0 deep inside the
  //     planet (m~1) and 0 far outside it (m~0), peaking exactly on the
  //     blurred transition band straddling the true edge, on both the
  //     sky side and the ground side, matching the reference photo.
  const atmosphereMaskMesh = MeshBuilder.CreateSphere('atmosphereMaskMesh', { diameter: PLANET_RADIUS * 2, segments: 48 }, scene)
  atmosphereMaskMesh.parent = spinPivot
  const atmosphereMaskMaterial = new StandardMaterial('atmosphereMaskMaterial', scene)
  atmosphereMaskMaterial.diffuseColor = new Color3(0, 0, 0)
  atmosphereMaskMaterial.specularColor = new Color3(0, 0, 0)
  atmosphereMaskMaterial.emissiveColor = new Color3(1, 1, 1)
  atmosphereMaskMesh.material = atmosphereMaskMaterial
  atmosphereMaskMesh.isVisible = false

  const maskWidth = 512
  const maskHeight = Math.max(1, Math.round(maskWidth / (ctx.engine.getRenderWidth() / ctx.engine.getRenderHeight())))
  const atmosphereMaskRT = new RenderTargetTexture('atmosphereMaskRT', { width: maskWidth, height: maskHeight }, scene, false, true)
  atmosphereMaskRT.clearColor = new Color4(0, 0, 0, 1)
  // Default addressing is wrap/repeat — sampling near one edge (e.g. the
  // blur below reaching just past vUV.y=0) would otherwise wrap around
  // and pick up the opposite edge's mask content, showing up as a stray
  // glow band on the wrong side of the screen. Confirmed directly: this
  // is exactly what produced an extra blue smear at the top of frame,
  // unrelated to the planet's own silhouette, before clamping.
  atmosphereMaskRT.wrapU = Texture.CLAMP_ADDRESSMODE
  atmosphereMaskRT.wrapV = Texture.CLAMP_ADDRESSMODE
  atmosphereMaskRT.renderList = [atmosphereMaskMesh]
  // Only visible during this render target's own pass — never in the
  // main view, and never adding its own (correctly-sharp) silhouette on
  // top of the glow it's used to generate.
  atmosphereMaskRT.onBeforeRenderObservable.add(() => {
    atmosphereMaskMesh.isVisible = true
  })
  atmosphereMaskRT.onAfterRenderObservable.add(() => {
    atmosphereMaskMesh.isVisible = false
  })
  scene.customRenderTargets.push(atmosphereMaskRT)

  Effect.ShadersStore.atmosphereGlowFragmentShader = `
    precision highp float;
    varying vec2 vUV;
    uniform sampler2D textureSampler;
    uniform sampler2D maskSampler;
    uniform vec3 glowColor;
    uniform float glowIntensity;
    uniform float blurRadius;

    // 5x5 box blur, independent of the mask's own resolution — this is
    // what actually controls the glow band's width (blurRadius), not
    // how detailed the underlying silhouette mask is.
    float sampleMaskBlurred(vec2 uv) {
      float total = 0.0;
      for (int x = -2; x <= 2; x++) {
        for (int y = -2; y <= 2; y++) {
          vec2 offset = vec2(float(x), float(y)) * blurRadius;
          total += texture2D(maskSampler, uv + offset).r;
        }
      }
      return total / 25.0;
    }

    void main(void) {
      vec4 sceneColor = texture2D(textureSampler, vUV);
      float m = sampleMaskBlurred(vUV);
      float edge = 4.0 * m * (1.0 - m);
      vec3 result = mix(sceneColor.rgb, glowColor, edge * glowIntensity);
      gl_FragColor = vec4(result, sceneColor.a);
    }
  `
  const atmosphereGlow = new PostProcess(
    'atmosphereGlow',
    'atmosphereGlow',
    ['glowColor', 'glowIntensity', 'blurRadius'],
    ['maskSampler'],
    1.0,
    camera,
  )
  atmosphereGlow.onApply = (effect) => {
    effect.setTexture('maskSampler', atmosphereMaskRT)
    effect.setColor3('glowColor', new Color3(0.55, 0.72, 0.95))
    effect.setFloat('glowIntensity', 0.25)
    // In mask-texture UV units (0-1 spans the whole 512px-wide mask) —
    // this, not maskWidth, is what controls the glow band's width now.
    effect.setFloat('blurRadius', 0.01)
  }

  // North-pole marker: a flat circular badge with an "N", drawn onto a
  // DynamicTexture's 2D canvas rather than a mesh outline — much simpler
  // for a ring + centered glyph than building actual geometry for it.
  // Parented to tiltPivot (not spinPivot), so it stays upright and
  // doesn't spin with the planet's own rotation — the pole point itself
  // doesn't move under spin (it's on the rotation axis), and a marker
  // that visibly spun in place would read as confusing UI, not part of
  // the terrain. Replaces the old red pole-axis stick as the north
  // indicator, which has been removed.
  const northMarkerTexture = new DynamicTexture('northMarkerTexture', 256, scene, false)
  northMarkerTexture.hasAlpha = true
  const northMarkerContext = northMarkerTexture.getContext()
  northMarkerContext.clearRect(0, 0, 256, 256)
  northMarkerContext.strokeStyle = '#1a1a1a'
  northMarkerContext.lineWidth = 10
  northMarkerContext.beginPath()
  northMarkerContext.arc(128, 128, 105, 0, Math.PI * 2)
  northMarkerContext.stroke()
  northMarkerContext.fillStyle = '#1a1a1a'
  northMarkerContext.font = 'bold 140px sans-serif'
  // ICanvasRenderingContext (Babylon's minimal cross-platform canvas
  // abstraction) doesn't type textAlign/textBaseline, so center the
  // glyph manually from its actual bounding-box metrics instead.
  const glyphMetrics = northMarkerContext.measureText('N')
  const glyphOffsetX = (glyphMetrics.actualBoundingBoxLeft - glyphMetrics.actualBoundingBoxRight) / 2
  const glyphOffsetY = (glyphMetrics.actualBoundingBoxAscent - glyphMetrics.actualBoundingBoxDescent) / 2
  northMarkerContext.fillText('N', 128 + glyphOffsetX, 128 + glyphOffsetY)
  northMarkerTexture.update()

  // Angular radius 0.15 rad matches the old flat disc's linear radius
  // 0.15 at PLANET_RADIUS=1 (arc length ~= radius * angle for a small
  // angle) — same apparent size, now actually following the curve.
  const northMarker = createPoleCapMesh('northMarker', 0.15, PLANET_RADIUS + 0.005, 8, 48, scene)
  northMarker.parent = tiltPivot
  const northMarkerMaterial = new StandardMaterial('northMarkerMaterial', scene)
  northMarkerMaterial.diffuseTexture = northMarkerTexture
  northMarkerMaterial.useAlphaFromDiffuseTexture = true
  northMarkerMaterial.specularColor = new Color3(0, 0, 0)
  northMarkerMaterial.emissiveColor = new Color3(0.5, 0.5, 0.5)
  northMarkerMaterial.backFaceCulling = false
  northMarker.material = northMarkerMaterial

  // Horizontal drag spins the planet around its own north-south axis —
  // spinPivot, the same node the continuous auto-rotation below drives,
  // so a manual drag and the ambient spin just add together naturally
  // rather than fighting over separate state.
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
      spinPivot.rotation.y += deltaX * DRAG_SENSITIVITY
    }
  })

  // Roll the planet toward/away from the viewer via the mouse wheel —
  // rotating viewPivot around the camera's own right axis (see where
  // cameraRightAxis is computed above), so scrolling tumbles the globe
  // forward/back over the horizon rather than spinning it left-right.
  let viewRoll = 0
  ctx.canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault()
      viewRoll += event.deltaY * ROLL_SENSITIVITY
      viewPivot.rotationQuaternion = Quaternion.RotationAxis(cameraRightAxis, viewRoll)
    },
    { passive: false },
  )

  // The planet's own simulated rotation — continuous and independent of
  // the free-drag view control above, since they're on separate nodes
  // (spinPivot vs. viewPivot). Toggled by the spin button wired up below.
  let isSpinning = true
  const autoRotationSpeed = (2 * Math.PI) / AUTO_ROTATION_SECONDS_PER_TURN
  scene.onBeforeRenderObservable.add(() => {
    if (!isSpinning) return
    spinPivot.rotation.y += autoRotationSpeed * (ctx.engine.getDeltaTime() / 1000)
  })

  const root = document.createElement('div')
  root.className = 'worldgen-screen'
  root.innerHTML = `
    <div class="plate-info" data-value="plate-info"></div>
    <button type="button" class="nav-arrow nav-arrow--back" data-action="back" aria-label="Back">‹</button>
    <button type="button" class="nav-arrow nav-arrow--next" data-action="next" aria-label="Next">›</button>
    <button type="button" class="spin-toggle" data-action="toggle-spin" aria-label="Pause planet spin">
      <img src="/icons/spin_on.png" alt="" />
    </button>
    <div class="panel" data-panel="0">
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

      <button data-action="run">Run</button>
    </div>
    <div class="panel" data-panel="1" hidden>
      <button type="button" data-action="erosion">Erosion</button>
    </div>
  `

  const plateInfo = root.querySelector<HTMLElement>('[data-value="plate-info"]')!
  const seedInput = root.querySelector<HTMLInputElement>('.seed-input')!
  const continentsInput = root.querySelector<HTMLInputElement>('.continents-input')!
  const continentsValue = root.querySelector<HTMLElement>('[data-value="continents"]')!
  const ratioInput = root.querySelector<HTMLInputElement>('.ratio-input')!
  const ratioValue = root.querySelector<HTMLElement>('[data-value="ratio"]')!
  const randomizeButton = root.querySelector<HTMLButtonElement>('[data-action="randomize-seed"]')!
  const toggleSpinButton = root.querySelector<HTMLButtonElement>('[data-action="toggle-spin"]')!
  const toggleSpinIcon = toggleSpinButton.querySelector<HTMLImageElement>('img')!
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
  let pendingTimeoutId: ReturnType<typeof setTimeout> | undefined

  // The run button itself is deliberately excluded — it's the toggle
  // that starts/stops the loop below, so it needs to stay clickable
  // while running.
  const setControlsDisabled = (disabled: boolean) => {
    seedInput.disabled = disabled
    continentsInput.disabled = disabled
    ratioInput.disabled = disabled
    randomizeButton.disabled = disabled
  }

  const stopEpochRun = () => {
    if (pendingTimeoutId !== undefined) {
      clearTimeout(pendingTimeoutId)
      pendingTimeoutId = undefined
    }
    if (isRunning) {
      isRunning = false
      setControlsDisabled(false)
      runButton.textContent = 'Run'
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
    pendingTimeoutId = setTimeout(() => {
      pendingTimeoutId = undefined
      worker.postMessage({ type: 'stepEpoch' })
    }, EPOCH_STEP_DELAY_MS)
  }

  const regenerateWorld = () => {
    stopEpochRun()
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

  toggleSpinButton.addEventListener('click', () => {
    isSpinning = !isSpinning
    toggleSpinIcon.src = isSpinning ? '/icons/spin_on.png' : '/icons/spin_off.png'
    toggleSpinButton.setAttribute('aria-label', isSpinning ? 'Pause planet spin' : 'Resume planet spin')
  })

  runButton.addEventListener('click', () => {
    if (isRunning) {
      stopEpochRun()
      return
    }
    isRunning = true
    setControlsDisabled(true)
    runButton.textContent = 'Stop'
    worker.postMessage({ type: 'stepEpoch' })
  })

  const panels = Array.from(root.querySelectorAll<HTMLElement>('.panel'))
  let panelIndex = 0
  const showPanel = (index: number) => {
    panelIndex = index
    panels.forEach((panel, i) => {
      panel.hidden = i !== index
    })
  }

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
      disposed = true
      stopEpochRun()
      worker.terminate()
      scene.dispose()
    },
  }
}
