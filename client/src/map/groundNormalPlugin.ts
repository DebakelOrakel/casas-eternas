import { MaterialPluginBase } from '@babylonjs/core'
import type { BaseTexture, Material, MaterialDefines, Scene, SubMesh, UniformBuffer } from '@babylonjs/core'

// THE GROUND'S NORMALS FROM A TEXTURE, in world space. A StandardMaterial
// lights by the vertex normal, which is as coarse as the mesh; the ground
// rings (groundRings.ts) carry a normal map finer than their quads
// (map/groundPaint.ts), and this plugin puts it in the normal's place
// right before the lights read it. World space rather than tangent space
// on purpose: the rings never rotate, the painter knows the world's axes,
// and a tangent frame derived in the shader from screen derivatives is a
// seam at every triangle. The exaggeration is in the map already.
//
// The texture is read at the diffuse texture's UV, so the two textures
// are one pair over the ring's square.
//
// DETAIL UNDER THE TEXELS: close to the camera a texel is many pixels
// wide and the ground goes soft. A hashed noise over the world position,
// at two wavelengths, bends the normal and grains the colour — rock has
// grain at every scale the eye can resolve — fading out with the
// distance to the eye (`detailReach`, world units) so it never shimmers
// far off, and with the slope, so a plain stays a plain.
export class GroundNormalPlugin extends MaterialPluginBase {
  private texture: BaseTexture | null = null
  private detailReach = 0
  private detailWavelength = 1
  private detailStrength = 0
  private relief = 1

  constructor(material: Material) {
    super(material, 'GroundNormal', 210, { GROUNDNORMAL: false, GROUNDDETAIL: false })
    this._enable(true)
  }

  setTexture(texture: BaseTexture | null): void {
    const wasOn = this.texture !== null
    this.texture = texture
    if (wasOn !== (texture !== null)) this.markAllDefinesAsDirty()
  }

  // The detail's reach from the eye and its longest wavelength, world
  // units, and its strength (0 off).
  setDetail(reach: number, wavelength: number, strength: number): void {
    const wasOn = this.detailStrength > 0
    this.detailReach = reach
    this.detailWavelength = wavelength
    this.detailStrength = strength
    if (wasOn !== strength > 0) this.markAllDefinesAsDirty()
  }

  // THE RELIEF GAIN: the normal's lean multiplied before the lights read
  // it. A map's hillshade overstates the relief far more than a relief
  // model does, or a range 3 km high reads as a stain from 3 000 km up;
  // the screen raises it as the view widens, the same for every ring.
  setRelief(gain: number): void {
    this.relief = gain
  }

  override getClassName(): string {
    return 'GroundNormalPlugin'
  }

  override prepareDefines(defines: MaterialDefines): void {
    defines['GROUNDNORMAL'] = this.texture !== null
    defines['GROUNDDETAIL'] = this.detailStrength > 0
  }

  override getSamplers(samplers: string[]): void {
    samplers.push('groundNormalSampler')
  }

  override getUniforms(): { ubo: { name: string; size: number; type: string }[]; fragment: string } {
    return {
      ubo: [{ name: 'groundDetail', size: 3, type: 'vec3' }, { name: 'groundRelief', size: 1, type: 'float' }],
      fragment: `#ifdef GROUNDDETAIL
        uniform vec3 groundDetail;
        #endif
        #ifdef GROUNDNORMAL
        uniform float groundRelief;
        #endif`,
    }
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer, _scene: Scene, _engine: unknown, _subMesh: SubMesh): void {
    if (this.texture) uniformBuffer.setTexture('groundNormalSampler', this.texture)
    uniformBuffer.updateFloat3('groundDetail', this.detailReach, this.detailWavelength, this.detailStrength)
    uniformBuffer.updateFloat('groundRelief', this.relief)
  }

  override getCustomCode(shaderType: string): { [pointName: string]: string } | null {
    if (shaderType !== 'fragment') return null
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: `#ifdef GROUNDNORMAL
        uniform sampler2D groundNormalSampler;
        #endif
        #ifdef GROUNDDETAIL
        // No sine: a world position over a 60 m wavelength is a number in
        // the thousands, and sin() of its multiples loses the fraction on
        // the GPU (the grain came out as one dark smear, 2026-10-03).
        float groundHash(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }
        float groundNoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(groundHash(i), groundHash(i + vec2(1.0, 0.0)), u.x), mix(groundHash(i + vec2(0.0, 1.0)), groundHash(i + vec2(1.0, 1.0)), u.x), u.y);
        }
        // Two octaves, the second at a quarter of the wavelength, each
        // faded out as it nears the pixel (fwidth: world units a pixel
        // spans here) — under three pixels an octave is only sand.
        float groundGrain(vec2 p, float wavelength) {
          float px = length(fwidth(p));
          float w0 = smoothstep(3.0, 8.0, wavelength / max(px, 1e-9));
          float w1 = smoothstep(3.0, 8.0, wavelength * 0.25 / max(px, 1e-9));
          return 0.5 + (groundNoise(p / wavelength) - 0.5) * 0.65 * w0 + (groundNoise(p / (wavelength * 0.25) + 7.3) - 0.5) * 0.35 * w1;
        }
        #endif`,
      CUSTOM_FRAGMENT_BEFORE_LIGHTS: `#if defined(GROUNDNORMAL) && defined(DIFFUSE)
        normalW = texture2D(groundNormalSampler, vDiffuseUV).xyz * 2.0 - 1.0;
        normalW = normalize(vec3(normalW.x * groundRelief, normalW.y, normalW.z * groundRelief));
        #endif
        #ifdef GROUNDDETAIL
        {
          float eyeDistance = length(vPositionW - vEyePosition.xyz);
          float near = 1.0 - clamp(eyeDistance / groundDetail.x, 0.0, 1.0);
          float steep = clamp((1.0 - normalW.y) * 6.0, 0.15, 1.0);
          float amount = groundDetail.z * near * near * steep;
          if (amount > 0.0) {
            float wave = groundDetail.y;
            float step = wave * 0.08;
            vec2 p = vPositionW.xz;
            float g0 = groundGrain(p, wave);
            float gx = groundGrain(p + vec2(step, 0.0), wave);
            float gz = groundGrain(p + vec2(0.0, step), wave);
            vec3 bend = vec3(-(gx - g0), 0.0, -(gz - g0)) * (amount * 0.8 / (step / wave));
            normalW = normalize(normalW + bend * 0.6);
          }
        }
        #endif`,
      CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `#ifdef GROUNDDETAIL
        {
          float eyeDistance = length(vPositionW - vEyePosition.xyz);
          float near = 1.0 - clamp(eyeDistance / groundDetail.x, 0.0, 1.0);
          float grain = groundGrain(vPositionW.xz, groundDetail.y);
          baseColor.rgb *= 1.0 + (grain - 0.5) * 0.3 * groundDetail.z * near;
        }
        #endif`,
    }
  }
}
