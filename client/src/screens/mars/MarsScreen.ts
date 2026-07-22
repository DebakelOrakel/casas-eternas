import { Color3, Color4, HemisphericLight, Mesh, MeshBuilder, Scalar, Scene, StandardMaterial, Texture, Vector3, VertexBuffer, VertexData } from '@babylonjs/core'
import { createOrbitSwoopCamera } from '../../camera/orbitSwoopCamera'
import type { Screen, ScreenContext, ScreenFactory } from '../../app/Screen'
import { displaceSphereVertices } from '../../worldgen-sphere/meshDisplacement'
import marsHeightmapUrl from '../../mars_8k.jpg'
// `?url` forces Vite to treat this as a static asset URL regardless of
// extension — .bin isn't in Vite's default asset-type list the way .jpg
// above is, so without it Vite would try (and fail) to parse this as JS.
import marsHeightDataUrl from '../../mars_8k_height.bin?url'
import './mars.css'

const PLANET_DIAMETER = 2
const PLANET_RADIUS = PLANET_DIAMETER / 2

// Discrete LOD via Babylon's built-in Mesh.addLODLevel: three pre-built
// versions of the sphere at different segment counts, swapped
// automatically by Babylon each frame based on actual camera-to-mesh
// distance — no manual wiring to currentZoom needed, since camera
// distance already tracks zoom (see the camera position lerp below).
// This is Babylon's only native LOD tool (whole-mesh swapping, not
// chunked/adaptive per-patch refinement) — plenty for a single small
// sphere; true "zoom from orbit to the ground" planet rendering needs a
// quadtree-chunked LOD system Babylon doesn't provide out of the box.
const LOD_HIGH_SEGMENTS = 256
const LOD_MEDIUM_SEGMENTS = 128
const LOD_LOW_SEGMENTS = 64
// Distance (from camera to the planet's own origin) beyond which Babylon
// switches to the next lower tier. Tunable by eye — orbitSwoopCamera's
// default range puts camera distance somewhere between ~1.15 (fully
// zoomed in) and 4 (fully zoomed out) for this radius-1 sphere.
const LOD_MEDIUM_DISTANCE = 2.2
const LOD_LOW_DISTANCE = 3.2

// Raw elevation samples (meters, real MOLA-derived Mars data), full 8k
// source resolution — mars_8k_height.bin is a flat little-endian int16
// grid (a lossless cast of the source TIFF's integer-meter values, not a
// re-quantization), no image codec involved: browsers can't decode the
// original TIFF, and the source JPEG turned out to be 12-bit precision,
// which browser JPEG decoders don't support either.
const HEIGHTMAP_WIDTH = 8192
const HEIGHTMAP_HEIGHT = 4096
const MARS_RADIUS_METERS = 3_389_500
// Real Mars relief (~29km peak-to-trough, Olympus Mons to Hellas basin)
// is only ~0.86% of the planet's own radius — invisible at this scale
// without exaggeration. Purely a visual tuning knob, not physically
// accurate, same spirit as WorldGenScreen's EROSION_DISPLACEMENT_SCALE.
const RELIEF_EXAGGERATION = 8
const DISPLACEMENT_SCALE = (PLANET_RADIUS / MARS_RADIUS_METERS) * RELIEF_EXAGGERATION

// Water level slider range, as a percentage between the heightmap's own
// actual min/max elevation (computed from the loaded data, not
// hardcoded, since it depends on which heightmap is loaded).
const WATER_LEVEL_MIN_PERCENT = 10
const WATER_LEVEL_MAX_PERCENT = 90
const WATER_LEVEL_DEFAULT_PERCENT = 23
const WATER_COLOR = new Color3(0.16, 0.45, 0.7)
const WATER_ALPHA = 0.75

export const createMarsScreen: ScreenFactory = (ctx: ScreenContext): Screen => {
  const scene = new Scene(ctx.engine)
  scene.clearColor = new Color4(1, 1, 1, 1)

  // See orbitSwoopCamera.ts for why this camera model (a hovering camera
  // with its own explicit look direction, rather than an ArcRotateCamera
  // aimed at the sphere's center) is what actually shows a horizon on
  // zoom-in, and why drag (viewPivot) and zoom (camera) are kept on
  // entirely separate controls. All of orbitSwoopCamera's defaults were
  // tuned here first, for this exact radius-1 sphere, so no overrides are
  // needed beyond the radius itself.
  const { viewPivot, dispose: disposeCamera } = createOrbitSwoopCamera({
    scene,
    canvas: ctx.canvas,
    engine: ctx.engine,
    radius: PLANET_RADIUS,
  })
  new HemisphericLight('light', new Vector3(0, 1, 0), scene)

  const material = new StandardMaterial('marsMaterial', scene)
  // invertY defaults to true on Texture — Babylon flips the V axis when
  // sampling on the GPU to reconcile top-down image row order with
  // WebGL's bottom-up texture convention. sampleElevationBilinear (see
  // meshDisplacement.ts) has no such flip: it reads mars_8k_height.bin
  // straight against the mesh's raw UVs. Two independently-loaded
  // datasets with only one silently flipped is exactly what produced the
  // color/relief misalignment — disabling it here makes both pipelines
  // agree on the same unflipped convention.
  material.diffuseTexture = new Texture(marsHeightmapUrl, scene, undefined, false)
  material.specularColor = new Color3(0, 0, 0)

  // `planet` (the mesh addLODLevel is called on) is what Babylon shows at
  // distance 0 — i.e. it must be the HIGHEST-detail tier, with
  // progressively lower-detail meshes registered for increasing distance
  // thresholds. All three share the same material (same texture, just a
  // different vertex count) and get displaced from the same heightmap
  // data below. Babylon overrides a selected LOD mesh's world matrix with
  // the base mesh's own when rendering it, so parenting all three to
  // viewPivot is redundant for rendering but keeps the scene graph
  // consistent (and harmless) if that internal behavior ever changes.
  const planet = MeshBuilder.CreateSphere('marsPlanetHigh', { diameter: PLANET_DIAMETER, segments: LOD_HIGH_SEGMENTS, updatable: true }, scene)
  planet.parent = viewPivot
  planet.material = material

  const planetMedium = MeshBuilder.CreateSphere('marsPlanetMedium', { diameter: PLANET_DIAMETER, segments: LOD_MEDIUM_SEGMENTS, updatable: true }, scene)
  planetMedium.parent = viewPivot
  planetMedium.material = material

  const planetLow = MeshBuilder.CreateSphere('marsPlanetLow', { diameter: PLANET_DIAMETER, segments: LOD_LOW_SEGMENTS, updatable: true }, scene)
  planetLow.parent = viewPivot
  planetLow.material = material

  planet.addLODLevel(LOD_MEDIUM_DISTANCE, planetMedium)
  planet.addLODLevel(LOD_LOW_DISTANCE, planetLow)

  // A plain, low-poly sphere is enough here — it's a flat sea-level
  // shell, not something that needs per-vertex displacement. Parented to
  // viewPivot like the planet, so it spins together with the terrain
  // rather than staying fixed while the ground rotates under it. Hidden
  // until the heightmap's real min/max elevation is known (see the fetch
  // below) — before that, there's no sensible radius to show it at.
  const waterSphere = MeshBuilder.CreateSphere('waterSphere', { diameter: PLANET_DIAMETER, segments: 128 }, scene)
  waterSphere.parent = viewPivot
  waterSphere.isVisible = false
  const waterMaterial = new StandardMaterial('waterMaterial', scene)
  waterMaterial.diffuseColor = WATER_COLOR
  waterMaterial.specularColor = new Color3(0.25, 0.25, 0.3)
  waterMaterial.alpha = WATER_ALPHA
  waterSphere.material = waterMaterial

  // Set once the heightmap loads (see below) — updateWaterLevel and the
  // slider handler both need the real elevation range to turn a 10-90%
  // slider position into an actual radius.
  let minElevationMeters = 0
  let maxElevationMeters = 0
  const updateWaterLevel = (percent: number): void => {
    const waterElevationMeters = Scalar.Lerp(minElevationMeters, maxElevationMeters, percent / 100)
    const waterRadius = PLANET_RADIUS + waterElevationMeters * DISPLACEMENT_SCALE
    waterSphere.scaling.setAll(waterRadius / PLANET_RADIUS)
  }

  // Each LOD tier has its own vertex count/UV buffer, so displacement has
  // to run once per mesh — but all three read the same elevations array,
  // just at whatever resolution each mesh's own geometry can show.
  const applyDisplacement = (mesh: Mesh, elevations: Float32Array): void => {
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind) as Float32Array
    const uvs = mesh.getVerticesData(VertexBuffer.UVKind) as Float32Array
    const displaced = new Float32Array(positions.length)
    displaceSphereVertices(positions, uvs, elevations, HEIGHTMAP_WIDTH, HEIGHTMAP_HEIGHT, PLANET_RADIUS, DISPLACEMENT_SCALE, displaced)
    mesh.updateVerticesData(VertexBuffer.PositionKind, displaced)
    const normals = new Float32Array(displaced.length)
    VertexData.ComputeNormals(displaced, mesh.getIndices()!, normals)
    mesh.updateVerticesData(VertexBuffer.NormalKind, normals)
  }

  // Its default UVs already match the equirectangular heightmap's u/v
  // convention (see meshDisplacement.ts), so no extra alignment work is
  // needed between the two.
  let disposed = false
  fetch(marsHeightDataUrl)
    .then((response) => response.arrayBuffer())
    .then((buffer) => {
      if (disposed) return
      // displaceSphereVertices expects Float32Array; this copies/widens
      // the raw int16 samples rather than reinterpreting their bytes.
      const elevations = new Float32Array(new Int16Array(buffer))
      for (const mesh of [planet, planetMedium, planetLow]) applyDisplacement(mesh, elevations)

      minElevationMeters = Infinity
      maxElevationMeters = -Infinity
      for (let i = 0; i < elevations.length; i++) {
        const value = elevations[i]
        if (value < minElevationMeters) minElevationMeters = value
        if (value > maxElevationMeters) maxElevationMeters = value
      }
      updateWaterLevel(WATER_LEVEL_DEFAULT_PERCENT)
      waterSphere.isVisible = true
      waterLevelInput.disabled = false
    })
    .catch((error: unknown) => {
      console.error('Failed to load Mars heightmap', error)
    })

  const root = document.createElement('div')
  root.className = 'mars-screen'
  root.innerHTML = `
    <button type="button" data-action="back">Back to Title</button>
    <div class="water-control">
      <label for="water-level">Water level</label>
      <input type="range" id="water-level" min="${WATER_LEVEL_MIN_PERCENT}" max="${WATER_LEVEL_MAX_PERCENT}" step="1" value="${WATER_LEVEL_DEFAULT_PERCENT}" disabled />
    </div>
  `
  root.querySelector('[data-action="back"]')!.addEventListener('click', () => {
    ctx.goTo('title')
  })
  const waterLevelInput = root.querySelector<HTMLInputElement>('#water-level')!
  waterLevelInput.addEventListener('input', () => {
    updateWaterLevel(Number(waterLevelInput.value))
  })
  ctx.overlay.appendChild(root)

  return {
    scene,
    dispose() {
      disposed = true
      // scene.dispose() alone doesn't remove the camera module's own
      // 'wheel' listener on the shared canvas (that's a DOM-level
      // listener, not a scene resource) — without this it'd keep firing
      // (and preventDefault-ing) after navigating away from this screen.
      disposeCamera()
      scene.dispose()
    },
  }
}
