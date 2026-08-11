import { Effect, Matrix, PostProcess, RawTexture, Texture } from '@babylonjs/core'
import type { Camera, Scene } from '@babylonjs/core'

// The SHEET: a full-screen pass that turns the rendered map into something on
// paper — fibre, granulation, spatter, drips. Stage B of
// docs/design/watercolor-map.md.
//
// EVERYTHING here is world-anchored, which is not what the design doc first
// argued. The doc's reasoning was that a sheet of paper is in front of you and
// should not slide when the map does — true of a real sheet, and wrong here,
// as looking at it settled within a minute. What decides it is not "sheet
// versus world" but SPATIAL FREQUENCY: fine isotropic grain pinned to the
// screen reads as a surface you look through, while anything larger or
// directional reads as an object, and an object that stays put while the world
// slides underneath is dirt on the lens. That is the shower-door effect
// (Bousseau et al. 2006), and the safe side of it is the world.
//
// The drips are gone for the same reason plus a worse one: they were the only
// element here with no meaning at all — carried over from a reference image,
// large, high-contrast, and drawn over the unexplored paper that covers most of
// the frame. The motion worth having is wet paint RUNNING IN as a place is
// revealed, which is an event rather than a permanent feature, and it waits on
// the exploration mechanic.
//
// World anchoring costs one thing and buys another. It costs periodicity: the
// noise has to wrap over the torus or a seam runs down the map. It buys the
// moiré guard for free, since the same derivative that detects sub-pixel cells
// is already needed.
//
// It reads the knowledge field rather than guessing where the paint ends. A
// post-process only sees the finished image, so the tempting shortcut is "this
// pixel is near paper-white, therefore unpainted" — which cannot tell blank
// paper from a snowfield. Instead the view ray is intersected with the ground
// plane and `k` is sampled at the world point, which for a flat torus is exact
// and costs about ten lines.

const SHADER_NAME = 'worldmapWatercolor'

Effect.ShadersStore[`${SHADER_NAME}FragmentShader`] = /* glsl */ `
precision highp float;
varying vec2 vUV;
uniform sampler2D textureSampler;
uniform sampler2D knowledgeSampler;

// Inverse view-projection, for turning a screen pixel back into a world ray.
uniform mat4 invViewProjection;
// One toroidal period in world units, so a ground hit becomes a wrapped UV.
uniform vec2 worldSize;
// 0 fully disables the pass (the near regime); 1 is full strength.
uniform float strength;
// Tunables — stage B exists to decide these.
uniform float fibreAmount;
uniform float fibreScale;
uniform float granulation;
uniform float dropletDensity;
uniform float dropletSize;
uniform vec3 dropletColor;
// k below which a place counts as unpainted, and the band above it where the
// spatter lives.
uniform float frontier;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

vec2 hash22(vec2 p) {
  return vec2(hash21(p), hash21(p + 17.13));
}

// Value noise that WRAPS on a lattice, because the world does: every cell
// index is taken modulo the period before it is hashed, so the pattern meets
// itself across the torus seam instead of drawing a line down the map.
float periodicNoise(vec2 p, vec2 period) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(mod(i, period));
  float b = hash21(mod(i + vec2(1.0, 0.0), period));
  float c = hash21(mod(i + vec2(0.0, 1.0), period));
  float d = hash21(mod(i + vec2(1.0, 1.0), period));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Octaves double the lattice AND its period together, so every one of them
// wraps on the same torus.
float periodicFbm(vec2 uv, vec2 period) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    sum += periodicNoise(uv * period, period) * amp;
    period *= 2.0;
    amp *= 0.5;
  }
  return sum;
}

// Where this pixel's view ray meets the ground plane, as a wrapped world UV.
// Returns false behind the camera or when the ray runs parallel to the ground
// — near the horizon, where the pass is fading out anyway.
bool groundUV(vec2 uv, out vec2 world, out vec2 unwrapped) {
  vec4 ndcNear = vec4(uv * 2.0 - 1.0, -1.0, 1.0);
  vec4 ndcFar = vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  vec4 pNear = invViewProjection * ndcNear;
  vec4 pFar = invViewProjection * ndcFar;
  vec3 a = pNear.xyz / pNear.w;
  vec3 b = pFar.xyz / pFar.w;
  vec3 dir = b - a;
  if (abs(dir.y) < 1e-6) return false;
  float t = -a.y / dir.y;
  if (t < 0.0 || t > 1.0) return false;
  vec3 hit = a + dir * t;
  // The ground's own UV convention, not a guessed one: Babylon's CreateGround
  // puts v = 0 at z = +height/2 and increases it as z DECREASES (which is why
  // ToroidalMapView derives dzdv as negative). Getting this backwards mirrors
  // the spatter against the frontier it is supposed to sit outside of —
  // invisible on a symmetric test world and obvious on a real one.
  //
  // The unwrapped coordinate is the same thing without the fract, and it is
  // what the noise and fwidth use: the wrapped one steps at the seam, which
  // would make fwidth explode there and paint a bright line across the map.
  // The two differ by an integer, so a periodic lattice reads the same cell
  // from either.
  unwrapped = vec2(hit.x / worldSize.x + 0.5, 0.5 - hit.z / worldSize.y);
  world = fract(unwrapped);
  return true;
}

void main(void) {
  vec4 scene = texture2D(textureSampler, vUV);
  if (strength <= 0.001) { gl_FragColor = scene; return; }

  vec3 color = scene.rgb;

  vec2 world;
  vec2 wpos;
  bool onGround = groundUV(vUV, world, wpos);
  if (!onGround) { gl_FragColor = scene; return; }
  float k = texture2D(knowledgeSampler, world).r;

  // The world is 2:1, so a lattice counted in cells across its WIDTH needs half
  // as many down its height or the grain comes out stretched.
  vec2 period = vec2(floor(fibreScale), max(1.0, floor(fibreScale * 0.5)));

  // Moiré guard, the same argument as the hex grid's: once one lattice cell
  // approaches the size of a pixel, the pattern is no longer texture but
  // aliasing. Fade it out rather than let it crawl. Derivatives are taken on
  // the UNWRAPPED coordinate, so the seam is not mistaken for infinite detail.
  float cellsPerPixel = max(fwidth(wpos.x) * period.x, fwidth(wpos.y) * period.y);
  float legible = 1.0 - smoothstep(0.18, 0.5, cellsPerPixel);

  // --- the paper's tooth ---------------------------------------------------
  // Two scales: the coarse one is the mottle of a cold-press sheet, the fine
  // one the tooth itself. It touches the whole frame, painted or not — it is
  // the paper the picture sits on, not an effect on the picture.
  float fibre = periodicFbm(wpos, period) * 0.65 + periodicFbm(wpos + 0.37, period * 4.0) * 0.35;
  color *= 1.0 - (fibre - 0.5) * fibreAmount * legible;

  // --- granulation ---------------------------------------------------------
  // Pigment settles into that same tooth, so it shows only where there IS
  // pigment and most where the wash is heaviest. It follows the paper, which is
  // now welded to the ground — so stage C's material plugin inherits a
  // granulation that already sits still, and is left with edge darkening.
  float grain = periodicFbm(wpos + 7.13, period * 2.0);
  color *= 1.0 - (grain - 0.5) * granulation * smoothstep(0.0, 0.6, k) * legible;

  // --- spatter -------------------------------------------------------------
  // Droplets live OUTSIDE the painted area, in a band beyond the frontier —
  // the doc's reading is that they are rumour: places heard of, never mapped.
  if (dropletDensity >= 1.0) {
    vec2 dropletPeriod = vec2(floor(dropletDensity), max(1.0, floor(dropletDensity * 0.5)));
    vec2 cellSpace = wpos * dropletPeriod;
    vec2 baseCell = floor(cellSpace);
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        vec2 cell = baseCell + vec2(float(dx), float(dy));
        // Hashed on the WRAPPED index, so the spatter is continuous across the
        // seam like everything else.
        vec2 wrappedCell = mod(cell, dropletPeriod);
        vec2 rnd = hash22(wrappedCell);
        // Only a minority of cells carry a droplet, and its size varies —
        // otherwise it reads as a dot screen rather than as thrown ink.
        float present = step(0.72, hash21(wrappedCell + 5.1));
        float radius = dropletSize * (0.25 + rnd.x * 0.9);
        vec2 centre = cell + vec2(0.25 + rnd.x * 0.5, 0.25 + rnd.y * 0.5);
        float d = length(cellSpace - centre);
        float disc = 1.0 - smoothstep(radius * 0.55, radius, d);
        // Ink thrown from a brush lands NEAR the stroke, so the spatter is
        // densest just outside the frontier and gone in the deep unknown. k
        // falls off with distance from what is known, so it doubles as that
        // distance. Rising edges only — smoothstep with edge0 >= edge1 is
        // undefined in GLSL, not merely reversed.
        float nearness = smoothstep(0.0, frontier, k) * step(k, frontier);
        color = mix(color, dropletColor, disc * present * nearness * 0.55 * legible);
      }
    }
  }

  gl_FragColor = vec4(mix(scene.rgb, color, strength), scene.a);
}
`

export interface WatercolorPassOptions {
  scene: Scene
  camera: Camera
  // One toroidal period in world units.
  worldWidth: number
  worldHeight: number
  // 0..1, polled every frame: how much of the effect to apply. The screen
  // fades it out on the descent — a watercolour vignette over a ground-level
  // view would be absurd.
  getStrength: () => number
}

export interface WatercolorTuning {
  fibreAmount: number
  // Lattice cells across the world's WIDTH — the grain's wavelength in world
  // terms, now that it is welded to the ground. Half as many run down the
  // height, since the world is 2:1.
  fibreScale: number
  granulation: number
  // Droplet cells across the world's width; below 1 the spatter is off.
  dropletDensity: number
  dropletSize: number
  frontier: number
}

export const DEFAULT_WATERCOLOR_TUNING: WatercolorTuning = {
  fibreAmount: 0.1,
  fibreScale: 900,
  granulation: 0.16,
  dropletDensity: 90,
  dropletSize: 0.18,
  frontier: 0.12,
}

export interface WatercolorPass {
  tuning: WatercolorTuning
  // Hand over the knowledge field as a texture. Called whenever it changes;
  // the texture is reused, only its bytes are replaced.
  setKnowledge(bytes: Uint8Array, width: number, height: number): void
  dispose(): void
}

export function createWatercolorPass(options: WatercolorPassOptions): WatercolorPass {
  const { scene, camera, worldWidth, worldHeight, getStrength } = options
  const tuning: WatercolorTuning = { ...DEFAULT_WATERCOLOR_TUNING }

  // Starts fully unknown, so the very first frame is bare paper rather than a
  // flash of finished map.
  let knowledgeTexture = RawTexture.CreateRTexture(new Uint8Array(1), 1, 1, scene, false, false, Texture.BILINEAR_SAMPLINGMODE)
  knowledgeTexture.wrapU = Texture.WRAP_ADDRESSMODE
  knowledgeTexture.wrapV = Texture.WRAP_ADDRESSMODE
  let knowledgeSize = 1

  const invViewProjection = Matrix.Identity()
  // Droplet ink: one muted pigment rather than a colour sampled from the
  // nearest paint. A real brush throws whatever it is loaded with, so a single
  // colour is closer to the truth than it looks — and it avoids two extra taps
  // plus a gradient walk for something the eye reads as "spatter" either way.
  const DROPLET_INK = [0.29, 0.35, 0.52] as const

  const pass = new PostProcess(
    SHADER_NAME,
    SHADER_NAME,
    ['invViewProjection', 'worldSize', 'strength',
      'fibreAmount', 'fibreScale', 'granulation', 'dropletDensity', 'dropletSize',
      'dropletColor', 'frontier'],
    ['knowledgeSampler'],
    1,
    camera,
  )
  // With a post-process in the chain the scene renders into this pass's input
  // texture, not the canvas — so the engine's own antialiasing no longer
  // applies, and sub-pixel geometry (thin river ribbons at mid zoom) misses
  // the pixel centres of a single-sample target and drops out entirely. Ask
  // for a multisampled input; the cap check keeps WebGL1 (max 1) valid.
  pass.samples = Math.min(4, scene.getEngine().getCaps().maxMSAASamples)

  pass.onApply = (effect) => {
    // Bound even on the frames the shader returns early: an unbound sampler is
    // a driver's business, not something to leave to chance.
    effect.setTexture('knowledgeSampler', knowledgeTexture)
    const strength = getStrength()
    effect.setFloat('strength', strength)
    if (strength <= 0.001) return
    scene.getTransformMatrix().invertToRef(invViewProjection)
    effect.setMatrix('invViewProjection', invViewProjection)
    effect.setFloat2('worldSize', worldWidth, worldHeight)
    effect.setFloat('fibreAmount', tuning.fibreAmount)
    effect.setFloat('fibreScale', tuning.fibreScale)
    effect.setFloat('granulation', tuning.granulation)
    effect.setFloat('dropletDensity', tuning.dropletDensity)
    effect.setFloat('dropletSize', tuning.dropletSize)
    effect.setFloat('frontier', tuning.frontier)
    effect.setFloat3('dropletColor', DROPLET_INK[0], DROPLET_INK[1], DROPLET_INK[2])
  }

  return {
    tuning,

    setKnowledge(bytes: Uint8Array, width: number, height: number): void {
      if (width * height !== knowledgeSize) {
        knowledgeTexture.dispose()
        knowledgeTexture = RawTexture.CreateRTexture(bytes, width, height, scene, false, false, Texture.BILINEAR_SAMPLINGMODE)
        knowledgeTexture.wrapU = Texture.WRAP_ADDRESSMODE
        knowledgeTexture.wrapV = Texture.WRAP_ADDRESSMODE
        knowledgeSize = width * height
        return
      }
      knowledgeTexture.update(bytes)
    },

    dispose(): void {
      pass.dispose(camera)
      knowledgeTexture.dispose()
    },
  }
}
