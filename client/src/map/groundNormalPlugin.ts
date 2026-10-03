import { MaterialPluginBase } from '@babylonjs/core'
import type { BaseTexture, Material, MaterialDefines, Scene, SubMesh, UniformBuffer } from '@babylonjs/core'
import { GROUND_MATERIALS, GROUND_MATERIAL_SCALE } from './groundDetail'

// THE GROUND'S SURFACE IN THE SHADER: the painted normals in the place of
// the vertex normal, and the DETAIL under the painted texels.
//
// NORMALS. A StandardMaterial lights by the vertex normal, which is as
// coarse as the mesh; the ground rings (groundRings.ts) carry a normal map
// finer than their quads (map/groundPaint.ts), and this plugin puts it in
// the normal's place right before the lights read it. World space rather
// than tangent space on purpose: the rings never rotate, the painter knows
// the world's axes, and a tangent frame derived in the shader from screen
// derivatives is a seam at every triangle. The exaggeration is in the map
// already.
//
// DETAIL. Close to the camera a painted texel is many pixels wide and the
// ground goes soft. The painter also writes the MATERIAL weights per texel
// (rock, bare, snow, canopy; grass the rest), and the shader lays the
// tiling detail textures (groundDetail.ts, a 2D array: a luminance and a
// normal map per material) under the albedo by those weights, at two
// wavelengths over the world's position — a micro tile the eye reads near
// and a macro tile that breaks the repetition further off. Each tile fades
// out as it nears the pixel (fwidth), so nothing shimmers far off.
//
// All textures are read at the diffuse texture's UV, so they are one set
// over the ring's square.
export class GroundNormalPlugin extends MaterialPluginBase {
  private texture: BaseTexture | null = null
  private materials: BaseTexture | null = null
  private detailAlbedo: BaseTexture | null = null
  private detailNormals: BaseTexture | null = null
  private microWavelength = 1
  private macroWavelength = 10
  private detailStrength = 1
  private detailReach = 1
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

  // The material weights (the ring's) and the detail set (shared): the
  // detail is drawn once all three are there.
  setMaterials(materials: BaseTexture | null): void {
    this.materials = materials
    this.markAllDefinesAsDirty()
  }

  setDetailTextures(albedo: BaseTexture | null, normals: BaseTexture | null): void {
    this.detailAlbedo = albedo
    this.detailNormals = normals
    this.markAllDefinesAsDirty()
  }

  // The detail's wavelengths (world units), its strength (0 off) and how
  // far from the eye the micro tile reaches (world units): past it only
  // the macro tile is drawn, as a game fades its ground detail — at 5 km a
  // 50 m tile is still 14 pixels and reads as a stipple over the whole
  // range (2026-10-03).
  setDetail(micro: number, macro: number, strength: number, reach: number): void {
    const wasOn = this.detailStrength > 0
    this.microWavelength = micro
    this.macroWavelength = macro
    this.detailStrength = strength
    this.detailReach = reach
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
    defines['GROUNDDETAIL'] = this.detailStrength > 0 && this.materials !== null && this.detailAlbedo !== null && this.detailNormals !== null
  }

  override getSamplers(samplers: string[]): void {
    samplers.push('groundNormalSampler', 'groundMaterialSampler', 'groundDetailAlbedo', 'groundDetailNormals')
  }

  override getUniforms(): { ubo: { name: string; size: number; type: string }[]; fragment: string } {
    return {
      ubo: [
        { name: 'groundDetail', size: 4, type: 'vec4' },
        { name: 'groundRelief', size: 1, type: 'float' },
      ],
      fragment: `#ifdef GROUNDDETAIL
        uniform vec4 groundDetail;
        #endif
        #ifdef GROUNDNORMAL
        uniform float groundRelief;
        #endif`,
    }
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer, _scene: Scene, _engine: unknown, _subMesh: SubMesh): void {
    if (this.texture) uniformBuffer.setTexture('groundNormalSampler', this.texture)
    if (this.materials) uniformBuffer.setTexture('groundMaterialSampler', this.materials)
    if (this.detailAlbedo) uniformBuffer.setTexture('groundDetailAlbedo', this.detailAlbedo)
    if (this.detailNormals) uniformBuffer.setTexture('groundDetailNormals', this.detailNormals)
    uniformBuffer.updateFloat4('groundDetail', this.microWavelength, this.macroWavelength, this.detailStrength, this.detailReach)
    uniformBuffer.updateFloat('groundRelief', this.relief)
  }

  override getCustomCode(shaderType: string): { [pointName: string]: string } | null {
    if (shaderType !== 'fragment') return null
    const layers = GROUND_MATERIALS.length
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: `#ifdef GROUNDNORMAL
        uniform sampler2D groundNormalSampler;
        #endif
        #ifdef GROUNDDETAIL
        uniform sampler2D groundMaterialSampler;
        uniform highp sampler2DArray groundDetailAlbedo;
        uniform highp sampler2DArray groundDetailNormals;
        // The weights of the ${layers} materials at this fragment: grass is
        // what the painted four leave.
        void groundWeights(vec2 uv, out float w[${layers}]) {
          vec4 m = texture2D(groundMaterialSampler, uv);
          w[0] = clamp(1.0 - (m.r + m.g + m.b + m.a), 0.0, 1.0);
          w[1] = m.r;
          w[2] = m.g;
          w[3] = m.b;
          w[4] = m.a;
          w[5] = 0.0;
        }
        // The macro layer alone, at full weight.
        void groundMacroWeights(out float w[${layers}]) {
          for (int i = 0; i < ${layers}; i++) w[i] = 0.0;
          w[${layers} - 1] = 1.0;
        }
        // One tile's weight at this pixel: 1 while the tile spans well
        // over a few pixels, 0 at the pixel.
        float groundTileFade(vec2 p, float wavelength) {
          float px = length(fwidth(p));
          return smoothstep(3.0, 10.0, wavelength / max(px, 1e-9));
        }
        // The luminance (0.5 = unchanged) and the lean of the materials
        // mixed by their weights, at a wavelength.
        const float groundScale[${layers}] = float[${layers}](${GROUND_MATERIALS.map((m) => GROUND_MATERIAL_SCALE[m].toFixed(2)).join(', ')});
        // Two reads of a tile, the second turned and scaled, averaged: the
        // grid a tiling texture repeats on stops lining up with itself.
        const mat2 groundTurn = mat2(0.6, 0.8, -0.8, 0.6) * 1.61;
        void groundDetailAt(vec2 p, float wavelength, float w[${layers}], out float lum, out vec3 n) {
          lum = 0.0;
          n = vec3(0.0);
          for (int i = 0; i < ${layers}; i++) {
            if (w[i] < 0.01) continue;
            float wl = wavelength * groundScale[i];
            vec2 uv = p / wl;
            vec2 uv2 = groundTurn * uv + 0.37;
            // A material's tile fades at the pixel on its own scale.
            float f = groundTileFade(p, wl) * w[i];
            float l = texture(groundDetailAlbedo, vec3(uv, float(i))).r + texture(groundDetailAlbedo, vec3(uv2, float(i))).r;
            vec3 a = texture(groundDetailNormals, vec3(uv, float(i))).xyz * 2.0 - 1.0;
            vec3 b = texture(groundDetailNormals, vec3(uv2, float(i))).xyz * 2.0 - 1.0;
            // The second read's lean turned back into the world's axes.
            b.xz = b.xz * mat2(0.6, -0.8, 0.8, 0.6);
            lum += (0.5 + (l - 1.0) * 0.7) * f + 0.5 * (w[i] - f);
            n += (a + b) * 0.7 * f;
          }
        }
        #endif`,
      CUSTOM_FRAGMENT_BEFORE_LIGHTS: `#if defined(GROUNDNORMAL) && defined(DIFFUSE)
        normalW = texture2D(groundNormalSampler, vDiffuseUV).xyz * 2.0 - 1.0;
        normalW = normalize(vec3(normalW.x * groundRelief, normalW.y, normalW.z * groundRelief));
        #endif
        #if defined(GROUNDDETAIL) && defined(DIFFUSE)
        {
          float w[${layers}];
          groundWeights(vDiffuseUV, w);
          vec2 p = vPositionW.xz;
          float lumA; vec3 nA;
          float lumB; vec3 nB;
          groundDetailAt(p, groundDetail.x, w, lumA, nA);
          float wm[${layers}];
          groundMacroWeights(wm);
          groundDetailAt(p + 37.1, groundDetail.y, wm, lumB, nB);
          float near = 1.0 - clamp(length(vPositionW - vEyePosition.xyz) / groundDetail.w, 0.0, 1.0);
          // The detail normal's lean (x, z) added to the ground's, in the
          // world's own axes (the tiles lie flat on it).
          vec3 lean = (vec3(nA.x, 0.0, nA.z) * near * near + vec3(nB.x, 0.0, nB.z) * 0.5) * groundDetail.z;
          normalW = normalize(normalW + lean * 0.8);
        }
        #endif`,
      CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `#if defined(GROUNDDETAIL) && defined(DIFFUSE)
        {
          float w[${layers}];
          groundWeights(vDiffuseUV, w);
          vec2 p = vPositionW.xz;
          float lumA; vec3 nA;
          float lumB; vec3 nB;
          groundDetailAt(p, groundDetail.x, w, lumA, nA);
          float wm[${layers}];
          groundMacroWeights(wm);
          groundDetailAt(p + 37.1, groundDetail.y, wm, lumB, nB);
          float near = 1.0 - clamp(length(vPositionW - vEyePosition.xyz) / groundDetail.w, 0.0, 1.0);
          baseColor.rgb *= mix(1.0, lumA * 2.0, groundDetail.z * near * near) * mix(1.0, lumB * 2.0, groundDetail.z * 0.45);
        }
        #endif`,
    }
  }
}
