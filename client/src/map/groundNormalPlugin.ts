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
          // No detail on painted water (the normal's alpha 0).
          float land = texture2D(groundNormalSampler, uv).a;
          m *= land;
          w[0] = clamp(1.0 - (m.r + m.g + m.b + m.a), 0.0, 1.0) * land;
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
        // HEX TILING (Mikkelsen 2022, "Practical real-time hex-tiling"):
        // a tiling texture read regularly repeats, and the eye finds the
        // grid within seconds. So the plane is cut into a triangle grid;
        // each vertex owns a random offset and turn of the texture, and a
        // pixel mixes the three vertices around it by their barycentric
        // weights (sharpened, so the mix is mostly one of them). Three
        // reads instead of one; no repetition the eye can find.
        float groundHash1(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }
        void groundHexVertices(vec2 uv, out vec2 v0, out vec2 v1, out vec2 v2, out vec3 w) {
          const mat2 toSkewed = mat2(1.0, 0.0, -0.57735027, 1.15470054);
          vec2 skewed = toSkewed * uv;
          vec2 base = floor(skewed);
          vec2 f = fract(skewed);
          if (f.x + f.y < 1.0) {
            w = vec3(1.0 - f.x - f.y, f.x, f.y);
            v0 = base; v1 = base + vec2(1.0, 0.0); v2 = base + vec2(0.0, 1.0);
          } else {
            w = vec3(f.x + f.y - 1.0, 1.0 - f.y, 1.0 - f.x);
            v0 = base + vec2(1.0, 1.0); v1 = base + vec2(0.0, 1.0); v2 = base + vec2(1.0, 0.0);
          }
          w = w * w * w;
          w /= (w.x + w.y + w.z);
        }
        // The texture's uv at a vertex's turn and offset, and the turn's
        // matrix to bring a lean back into the world's axes.
        vec2 groundHexUv(vec2 uv, vec2 v, out mat2 back) {
          float a = groundHash1(v) * 6.2831853;
          float c = cos(a);
          float sn = sin(a);
          back = mat2(c, -sn, sn, c);
          return mat2(c, sn, -sn, c) * uv + vec2(groundHash1(v + 7.1), groundHash1(v + 13.7));
        }
        void groundDetailAt(vec2 p, float wavelength, float w[${layers}], out float lum, out vec3 n) {
          lum = 0.0;
          n = vec3(0.0);
          for (int i = 0; i < ${layers}; i++) {
            if (w[i] < 0.01) continue;
            float wl = wavelength * groundScale[i];
            vec2 uv = p / wl;
            // A material's tile fades at the pixel on its own scale.
            float f = groundTileFade(p, wl) * w[i];
            // The hex grid at a little under a tile, so neighbouring
            // vertices read different parts of it.
            vec2 v0; vec2 v1; vec2 v2; vec3 hw;
            groundHexVertices(uv * 0.7, v0, v1, v2, hw);
            mat2 b0; mat2 b1; mat2 b2;
            vec2 uv0 = groundHexUv(uv, v0, b0);
            vec2 uv1 = groundHexUv(uv, v1, b1);
            vec2 uv2 = groundHexUv(uv, v2, b2);
            // The mip level from the UNTURNED uv's derivatives: a vertex's
            // uv jumps at every cell edge, and the implicit derivative
            // there picks a mip that is only the average (2026-10-03).
            vec2 ddx = dFdx(uv);
            vec2 ddy = dFdy(uv);
            float l = textureGrad(groundDetailAlbedo, vec3(uv0, float(i)), ddx, ddy).r * hw.x + textureGrad(groundDetailAlbedo, vec3(uv1, float(i)), ddx, ddy).r * hw.y + textureGrad(groundDetailAlbedo, vec3(uv2, float(i)), ddx, ddy).r * hw.z;
            vec3 n0 = textureGrad(groundDetailNormals, vec3(uv0, float(i)), ddx, ddy).xyz * 2.0 - 1.0;
            vec3 n1 = textureGrad(groundDetailNormals, vec3(uv1, float(i)), ddx, ddy).xyz * 2.0 - 1.0;
            vec3 n2 = textureGrad(groundDetailNormals, vec3(uv2, float(i)), ddx, ddy).xyz * 2.0 - 1.0;
            n0.xz = b0 * n0.xz;
            n1.xz = b1 * n1.xz;
            n2.xz = b2 * n2.xz;
            lum += l * f + 0.5 * (w[i] - f);
            n += (n0 * hw.x + n1 * hw.y + n2 * hw.z) * f;
          }
        }
        #endif`,
      CUSTOM_FRAGMENT_BEFORE_LIGHTS: `#if defined(GROUNDNORMAL) && defined(DIFFUSE)
        vec4 groundNormalTexel = texture2D(groundNormalSampler, vDiffuseUV);
        normalW = groundNormalTexel.xyz * 2.0 - 1.0;
        normalW = normalize(vec3(normalW.x * groundRelief, normalW.y, normalW.z * groundRelief));
        // Painted WATER (the normal's alpha 0, groundPaint.ts): a flat
        // surface with a fine ripple, lit as a mirror would be a little.
        float groundWater = 1.0 - groundNormalTexel.a;
        if (groundWater > 0.5) {
          vec2 rp = vPositionW.xz * 4000.0;
          float r = sin(rp.x * 1.7 + rp.y * 0.9) * 0.5 + sin(rp.x * 0.4 - rp.y * 1.3) * 0.5;
          normalW = normalize(vec3(r * 0.02, 1.0, -r * 0.02));
        }
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
      CUSTOM_FRAGMENT_BEFORE_FOG: `#if defined(GROUNDNORMAL) && defined(DIFFUSE)
        {
          // The water's sky: brighter toward a grazing view (Fresnel),
          // and a highlight along the sun's reflection.
          float groundWater2 = 1.0 - texture2D(groundNormalSampler, vDiffuseUV).a;
          if (groundWater2 > 0.5) {
            float fresnel = pow(1.0 - max(dot(normalW, viewDirectionW), 0.0), 3.0);
            color.rgb = mix(color.rgb, vec3(0.78, 0.85, 0.92), fresnel * 0.55);
            vec3 sunDir = normalize(vec3(-0.5, 0.67, 0.5));
            vec3 h = normalize(sunDir + viewDirectionW);
            color.rgb += vec3(0.35) * pow(max(dot(normalW, h), 0.0), 120.0);
          }
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
