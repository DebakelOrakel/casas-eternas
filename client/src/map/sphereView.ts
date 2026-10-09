import {
  Color3,
  Color4,
  DirectionalLight,
  Effect,
  type Engine,
  HemisphericLight,
  MeshBuilder,
  PostProcess,
  RenderTargetTexture,
  Scene,
  StandardMaterial,
  Texture,
  TransformNode,
  Vector3,
} from '@babylonjs/core'
import { createOrbitSwoopCamera } from '../camera/orbitSwoopCamera'

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

export interface SphereView {
  scene: Scene
  // The planet's obliquity, degrees: the axis leans by it.
  setObliquity(degrees: number): void
  // Back to the view it opened with, eased: the whole globe, unturned.
  resetCamera(): void
  dispose(): void
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

export function createSphereView(engine: Engine, canvas: HTMLCanvasElement): SphereView {
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

  return {
    scene,
    setObliquity(degrees) {
      tilt.rotation.z = (degrees * Math.PI) / 180
    },
    resetCamera: () => rig.reset(),
    dispose() {
      engine.onResizeObservable.remove(resized)
      glow.dispose(rig.camera)
      rig.dispose()
      scene.dispose()
    },
  }
}
