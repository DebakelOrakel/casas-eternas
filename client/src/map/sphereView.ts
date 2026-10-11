import {
  Color3,
  Color4,
  DirectionalLight,
  Effect,
  type Engine,
  HemisphericLight,
  Matrix,
  Mesh,
  MeshBuilder,
  PostProcess,
  RawTexture,
  RenderTargetTexture,
  Scene,
  StandardMaterial,
  Texture,
  TransformNode,
  Vector3,
  VertexBuffer,
  VertexData,
} from '@babylonjs/core'
import { createOrbitSwoopCamera } from '../camera/orbitSwoopCamera'
import { buildGlobeRibbons } from './globeRibbons'
import { RibbonWidthMaterialPlugin } from './ribbonWidthMaterialPlugin'
import { presenceThreshold, RIVER_RGB } from './riverWidth'
import { createSymbolLayerSet } from './symbolLayer'
import { GLOBE_SYMBOL_LIFT, globeChartOfFrame, globeSymbolFrame, globeSymbolSegments, globeSymbolVertex } from './symbolPlacement'
import { WaterField, WaterMaterialPlugin } from './waterMaterialPlugin'
import type { ChartPoint, WorldView } from './worldView'

// THE SPHERE'S FIRST VIEW (docs/design/two-topologies.md): an ocean globe on
// the white page, its axis tilted by the planet's obliquity, a band of
// atmosphere at its rim. What step 0 shows for a world of the sphere shape,
// before the sphere has crust, plates or climate.
//
// Taken from the sphere screen removed on 2026-09-20 (git 403c2d7^,
// screens/worldgen-sphere/WorldGenScreen.ts): the white clear colour, the
// sun and fill lights, the pivots, the mid-depth ocean blue and the
// atmosphere as a screen-space band around the silhouette. Its own camera
// went; the orbit-swoop rig (camera/orbitSwoopCamera.ts) holds this one —
// drag turns the globe, the wheel swoops from the whole globe to its
// horizon.
//
// Its own Scene, not the flat map's: the two share nothing but the canvas,
// and the screen renders whichever is shown.
//
// THE GLOBE AS A WORLD VIEW (worldView.ts, DEC-0035 fork 3). The chart is
// longitude and latitude in the globe's own frame (below the tilt), laid as
// Babylon's sphere lays its UVs (measured 2026-10-10): u runs once round the
// axis from the frame's +x toward −z, v from the north pole (+y, v = 0) to
// the south. So a layer's texel (u · width, v · height) shows where chartAt
// answers (u, v). The globe shows the sea until told to show its layers
// (setLayersShown): the screen lays a sphere world's own on it (its first
// step, since 2026-10-10), never the flat sample world's. What it cannot
// show yet (the relief: setRelief and setHeightScale) it takes and ignores
// — relief on the globe is a later decision.
//
// The symbols and names (WorldView.symbols) lie on the globe as objects,
// in the surface at every point — round at the poles as at the equator,
// where a circle painted into the chart is an ellipse 1 / cos φ tall — a
// little above it (GLOBE_SYMBOL_LIFT, symbolPlacement.ts), hidden by the
// globe on its far side, and under the atmosphere like the rest of the scene.
//
// THE RIVERS AND THE LAKES (2026-10-10), from the data the flat map takes:
// - the rivers are ribbons on the sphere (globeRibbons.ts), under the
//   symbols (RIVER_LIFT), as wide as on the flat map by the same width rule,
//   the same presence rule and dashes; lit like the globe, one mesh.
// - the standing water is the flat map's water plugin (waterMaterialPlugin.ts,
//   style 'globe') on the material that wears the layers: the shore where the
//   terrain crosses the level, the lakes' depth ramp, the coast types — read
//   from the chart texels the sphere's UVs give, with the cells across a pole
//   row half a turn round. Painted before the light, so the water darkens
//   on the night side with the land.

export interface GlobeWorldView extends WorldView {
  readonly shape: 'sphere'
  // The planet's obliquity, degrees: the axis leans by it.
  setObliquity(degrees: number): void
  // Lay the layers (reliefTexture: the composite without the baked
  // hillshade, the globe being lit) on the globe, or show the bare sea.
  setLayersShown(shown: boolean): void
}

export interface GlobeWorldViewOptions {
  engine: Engine
  canvas: HTMLCanvasElement
  // The chart's size in texels: the layers' textures.
  textureWidth: number
  textureHeight: number
  // The equator's length on the world, metres: the chart's width.
  metresRound: number
}

const RADIUS = 1
// The ocean's blue: the old screen's mid-depth stop (texture.ts,
// OCEAN_COLOR_STOPS), the sphere having no depths yet.
const OCEAN = new Color3(0.08, 0.35, 0.75)
// The atmosphere: its colour at the rim, how strongly it covers there, and
// how far it reaches out, in mask units (0..1 across the screen). OUTSIDE
// the globe only, from the camera's view: a haze around it, fading from the
// rim into the white page, never laid over the sea (2026-10-09 — the old
// screen's band straddled the edge and reached into the globe).
const GLOW_COLOR = new Color3(0.42, 0.62, 0.92)
const GLOW_INTENSITY = 0.55
const GLOW_BLUR = 0.012
// The radius the rivers lie at: over the globe's faces (a face of the
// 96-segment sphere lies up to 2.6e-4 radii inside the unit sphere,
// scripts/globeWater.mjs), under the symbols. About 3 km on an Earth-sized
// world.
const RIVER_LIFT = 1.0005

const SHADER = 'sphereAtmosphere'
Effect.ShadersStore[`${SHADER}FragmentShader`] = `
  precision highp float;
  varying vec2 vUV;
  uniform sampler2D textureSampler;
  uniform sampler2D maskSampler;
  uniform vec3 glowColor;
  uniform float glowIntensity;
  uniform float blurRadius;

  // A 5 x 5 box blur of the mask: its radius, not the mask's resolution,
  // sets the band's width.
  float maskAt(vec2 uv) {
    float total = 0.0;
    for (int x = -2; x <= 2; x++) {
      for (int y = -2; y <= 2; y++) {
        total += texture2D(maskSampler, uv + vec2(float(x), float(y)) * blurRadius).r;
      }
    }
    return total / 25.0;
  }

  void main(void) {
    vec4 sceneColor = texture2D(textureSampler, vUV);
    // Inside the globe: the sea as it is. The mask is drawn at the canvas's
    // own resolution, so its edge is the globe's edge to the pixel.
    if (texture2D(maskSampler, vUV).r > 0.5) {
      gl_FragColor = sceneColor;
      return;
    }
    // Outside: the blurred mask is ~0.5 at the rim and falls to 0 outward;
    // the haze follows it, strongest at the rim.
    float haze = smoothstep(0.0, 0.5, maskAt(vUV));
    gl_FragColor = vec4(mix(sceneColor.rgb, glowColor, haze * glowIntensity), sceneColor.a);
  }
`

export function createGlobeWorldView(options: GlobeWorldViewOptions): GlobeWorldView {
  const { engine, canvas, textureWidth, textureHeight, metresRound } = options
  const scene = new Scene(engine)
  scene.clearColor = new Color4(1, 1, 1, 1)

  const rig = createOrbitSwoopCamera({ scene, canvas, engine, radius: RADIUS })
  rig.camera.fov = 1.0

  // The sun rakes from the upper left; the fill keeps the night side from
  // going black on the white page.
  const sun = new DirectionalLight('sphereSun', new Vector3(-0.287, -0.549, 0.785), scene)
  sun.intensity = 1.1
  new HemisphericLight('sphereFill', new Vector3(0.3, 1, 0.2), scene).intensity = 0.3

  // The axis leans here; the globe and its axis line hang below.
  const tilt = new TransformNode('sphereTilt', scene)
  tilt.parent = rig.viewPivot

  const globe = MeshBuilder.CreateSphere('sphereGlobe', { diameter: RADIUS * 2, segments: 96 }, scene)
  globe.parent = tilt
  const sea = new StandardMaterial('sphereSea', scene)
  sea.diffuseColor = OCEAN
  sea.specularColor = new Color3(0.25, 0.25, 0.25)
  sea.specularPower = 64
  globe.material = sea

  // The axis, poking out at both poles: what makes the tilt readable on a
  // globe that is all sea.
  const axis = MeshBuilder.CreateCylinder('sphereAxis', { height: RADIUS * 2.5, diameter: RADIUS * 0.008, tessellation: 12 }, scene)
  axis.parent = tilt
  const axisMaterial = new StandardMaterial('sphereAxisMaterial', scene)
  axisMaterial.diffuseColor = new Color3(0, 0, 0)
  axisMaterial.specularColor = new Color3(0, 0, 0)
  axisMaterial.emissiveColor = new Color3(0.35, 0.35, 0.35)
  axis.material = axisMaterial

  // The atmosphere: a white copy of the globe rendered alone into a mask,
  // then a post-process that lays the haze over the pixels just outside it.
  // A Fresnel glow lit most of the sea in the close view, where the whole
  // surface is oblique to the camera (the old screen's first try); the
  // silhouette in screen space does not.
  const maskGlobe = MeshBuilder.CreateSphere('sphereMask', { diameter: RADIUS * 2, segments: 48 }, scene)
  maskGlobe.parent = tilt
  const maskMaterial = new StandardMaterial('sphereMaskMaterial', scene)
  maskMaterial.diffuseColor = new Color3(0, 0, 0)
  maskMaterial.specularColor = new Color3(0, 0, 0)
  maskMaterial.emissiveColor = new Color3(1, 1, 1)
  maskMaterial.disableLighting = true
  maskGlobe.material = maskMaterial
  maskGlobe.isVisible = false
  // At the canvas's resolution: the post-process asks the mask whether a
  // pixel is inside the globe, and a coarser mask would put a seam of haze
  // over the sea's edge.
  const maskSize = (): { width: number; height: number } => ({
    width: Math.max(1, engine.getRenderWidth()),
    height: Math.max(1, engine.getRenderHeight()),
  })
  const mask = new RenderTargetTexture('sphereMaskTarget', maskSize(), scene, false, true)
  mask.clearColor = new Color4(0, 0, 0, 1)
  // Clamped: a blur tap past the edge would otherwise wrap to the opposite
  // side of the screen and draw a band there.
  mask.wrapU = Texture.CLAMP_ADDRESSMODE
  mask.wrapV = Texture.CLAMP_ADDRESSMODE
  mask.renderList = [maskGlobe]
  mask.activeCamera = rig.camera
  mask.onBeforeRenderObservable.add(() => { maskGlobe.isVisible = true })
  mask.onAfterRenderObservable.add(() => { maskGlobe.isVisible = false })
  scene.customRenderTargets.push(mask)
  const resized = engine.onResizeObservable.add(() => mask.resize(maskSize()))

  const glow = new PostProcess('sphereAtmosphere', SHADER, ['glowColor', 'glowIntensity', 'blurRadius'], ['maskSampler'], 1.0, rig.camera)
  glow.onApply = (effect) => {
    effect.setTexture('maskSampler', mask)
    effect.setColor3('glowColor', GLOW_COLOR)
    effect.setFloat('glowIntensity', GLOW_INTENSITY)
    effect.setFloat('blurRadius', GLOW_BLUR)
  }

  // The layers' textures: kept for the screen to paint, laid on the globe
  // once a sphere world has layers of its own.
  const emptyLayer = (): RawTexture => RawTexture.CreateRGBATexture(new Uint8Array(textureWidth * textureHeight * 4), textureWidth, textureHeight, scene, false, false)
  const baseTexture = emptyLayer()
  const reliefTexture = emptyLayer()
  // The globe in its layers: the sea's light, the unshaded composite, and
  // the standing water over it. A material of its own, not the bare sea's
  // with a texture swapped in: the water reads the sphere's UVs, which a
  // material without a texture does not carry.
  const layered = new StandardMaterial('sphereLayers', scene)
  layered.diffuseTexture = reliefTexture
  layered.specularColor = sea.specularColor.clone()
  layered.specularPower = sea.specularPower
  const waterField = new WaterField(scene, 'sphere')
  const waterPlugin = new WaterMaterialPlugin(layered, 'globe', waterField)

  // The chart point of a world direction: into the globe's own frame
  // (below the tilt and the turn), then longitude and latitude.
  const toFrame = new Matrix()
  const chartOfWorld = (point: Vector3): ChartPoint => {
    tilt.computeWorldMatrix(true).invertToRef(toFrame)
    const p = Vector3.TransformCoordinates(point, toFrame)
    return globeChartOfFrame([p.x, p.y, p.z])
  }
  // The pixel's ray against the sphere, analytically: the nearer crossing.
  const chartAt = (screenX: number, screenY: number): ChartPoint | null => {
    const ray = scene.createPickingRay(screenX, screenY, Matrix.Identity(), rig.camera)
    const b = Vector3.Dot(ray.origin, ray.direction)
    const c = ray.origin.lengthSquared() - RADIUS * RADIUS
    const disc = b * b - c
    if (disc < 0) return null
    const t = -b - Math.sqrt(disc)
    if (t <= 0) return null
    return chartOfWorld(ray.origin.add(ray.direction.scale(t)))
  }
  const radiusMetres = metresRound / (2 * Math.PI)

  // The rivers: one mesh in the globe's frame, built again on each
  // setPolylines. The width rule's pixel: the angle a pixel spans (the
  // camera's fov is vertical), times the vertex's distance to the eye in
  // the shader. The presence rule's view: how much of the equator the view
  // spans at the surface nearest the camera, as the flat map's visible
  // fraction of its width.
  const riverMaterial = new StandardMaterial('sphereRivers', scene)
  riverMaterial.diffuseColor = new Color3(RIVER_RGB[0] / 255, RIVER_RGB[1] / 255, RIVER_RGB[2] / 255)
  riverMaterial.specularColor = new Color3(0, 0, 0)
  riverMaterial.backFaceCulling = false
  let riverMesh: Mesh | null = null
  let riverInk: Float64Array | null = null
  let riversOn = false
  const toRiverFrame = new Matrix()
  const riverEye = new Vector3()
  const viewFraction = (): number => {
    const height = Math.max(1e-6, rig.camera.globalPosition.length() - RADIUS)
    const across = 2 * height * Math.tan(rig.camera.fov / 2) * engine.getAspectRatio(rig.camera)
    return across / (2 * Math.PI * RADIUS)
  }
  new RibbonWidthMaterialPlugin(
    riverMaterial,
    () => (2 * Math.tan(rig.camera.fov / 2)) / Math.max(1, engine.getRenderHeight()),
    () => (riverInk ? presenceThreshold(riverInk, viewFraction()) : 0),
    {
      getEye: () => {
        tilt.computeWorldMatrix(true).invertToRef(toRiverFrame)
        Vector3.TransformCoordinatesToRef(rig.camera.globalPosition, toRiverFrame, riverEye)
        return riverEye
      },
    },
  )
  const setRiverPolylines = (points: Float32Array, lengths: Uint32Array, regimes?: Uint8Array): void => {
    riverMesh?.dispose()
    riverMesh = null
    riverInk = null
    const geometry = buildGlobeRibbons(points, lengths, regimes, textureWidth, textureHeight, radiusMetres, RIVER_LIFT)
    if (!geometry) return
    riverInk = geometry.ink
    const mesh = new Mesh('sphereRivers', scene)
    const data = new VertexData()
    data.positions = geometry.positions
    data.normals = geometry.normals
    data.indices = geometry.indices
    data.applyToMesh(mesh)
    mesh.setVerticesBuffer(new VertexBuffer(engine, geometry.dirs, 'ribbonDir', { size: 3 }))
    mesh.setVerticesBuffer(new VertexBuffer(engine, geometry.widths, 'ribbonWidths', { size: 3 }))
    mesh.setVerticesBuffer(new VertexBuffer(engine, geometry.styles, 'ribbonStyle', { size: 2 }))
    mesh.material = riverMaterial
    mesh.isPickable = false
    // The shader moves the vertices off their centreline: the bounds from
    // the centreline alone would cull a ribbon at the screen's edge.
    mesh.alwaysSelectAsActiveMesh = true
    mesh.parent = tilt
    mesh.setEnabled(riversOn)
    riverMesh = mesh
  }

  // The symbol layers, in the globe's own frame: they turn and lean with it.
  const symbolSet = createSymbolLayerSet(scene, 'globeSymbols', {
    frame: (symbol) => globeSymbolFrame(symbol.at, symbol.angle, symbol.readable ?? false),
    vertex: (frame, x, y, out, offset) => globeSymbolVertex(frame, x, y, radiusMetres, GLOBE_SYMBOL_LIFT, out, offset),
    segments: (length) => globeSymbolSegments(length, radiusMetres),
  }, (mesh) => {
    mesh.parent = tilt
    return []
  })

  return {
    shape: 'sphere',
    scene,
    baseTexture,
    reliefTexture,
    setLakesVisible: (visible) => waterPlugin.setLakesVisible(visible),
    setWaterLevels: (level, surface, coast = null) => waterField.setLevels(level, surface, coast),
    setWaterElevation: (data, width, height) => waterField.setElevation(data, width, height),
    // Relief on the globe is a later decision (DEC-0035): taken and ignored.
    setRelief: () => {},
    setHeightScale: () => {},
    rivers: {
      setPolylines: setRiverPolylines,
      setEnabled(enabled) {
        riversOn = enabled
        riverMesh?.setEnabled(enabled)
      },
    },
    symbols: (id) => symbolSet.symbols(id),
    chartAt,
    // The globe is its reference surface: what is drawn is the sphere.
    groundAt: chartAt,
    metresBetween(a, b) {
      // The great circle (haversine).
      const lat1 = (0.5 - a.v) * Math.PI
      const lat2 = (0.5 - b.v) * Math.PI
      const dLat = lat2 - lat1
      const dLon = (b.u - a.u) * 2 * Math.PI
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
      return 2 * radiusMetres * Math.asin(Math.min(1, Math.sqrt(h)))
    },
    viewKey() {
      const q = rig.viewPivot.rotationQuaternion!
      const at = rig.camera.position
      return `${q.x.toFixed(4)},${q.y.toFixed(4)},${q.z.toFixed(4)},${q.w.toFixed(4)},${at.x.toFixed(3)},${at.y.toFixed(3)},${at.z.toFixed(3)},${tilt.rotation.z.toFixed(4)}`
    },
    // The orbit rig has no pan to hold and no deep zoom to earn.
    setPanEnabled: () => {},
    setDeepZoom: () => {},
    setObliquity(degrees) {
      tilt.rotation.z = (degrees * Math.PI) / 180
    },
    setLayersShown(shown) {
      globe.material = shown ? layered : sea
    },
    resetCamera: () => rig.reset(),
    dispose() {
      engine.onResizeObservable.remove(resized)
      symbolSet.dispose()
      riverMesh?.dispose()
      riverMaterial.dispose()
      waterField.dispose()
      layered.dispose()
      baseTexture.dispose()
      reliefTexture.dispose()
      glow.dispose(rig.camera)
      rig.dispose()
      scene.dispose()
    },
  }
}
