import { Constants, MaterialPluginBase, RawTexture, Texture } from '@babylonjs/core'
import type { Material, MaterialDefines, Scene, SubMesh, UniformBuffer } from '@babylonjs/core'
import { ELEVATION_METERS } from '../generator/elevation/elevationScale'
import { SURFACE_LAKE, SURFACE_SEA } from '../generator/surface/hydrology'

// Standing water drawn AT DRAW TIME as the iso-line of its level on the
// terrain (ADAPTIVE_MESH_PLAN.md phase 1, decision 9 of adaptive-mesh.md):
// for every fragment the terrain height is interpolated between the four
// nearest cell centres and compared with the level the cell's water stands
// at — the sea's, or a basin's from hydrology.waterLevelField — so the shore
// falls where the terrain crosses the level, not on the cell edge. The
// staircase the texture's per-cell colour used to show at zoom is gone; what
// remains per cell is the LEVEL, which is piecewise constant by nature.
//
// One texture feeds it (WaterField), nearest-sampled and read with
// texelFetch so no float-filtering extension is needed: per cell the
// terrain height, the level and the surface kind. Without levels (no
// hydrology yet, or lakes hidden) every cell is drawn against the sea's
// level, which is exactly the map's pre-hydrology look.
//
// Colours are the PAPER's (map/paperBase.ts): the sea is the paper's light
// blue, modulated by the same forward-difference hillshade the paper bakes
// per cell (computed here from the elevation texture, so the two agree at
// every cell centre by construction), or flat on the unshaded paper the
// relief meshes wear; a lake takes the depth ramp the screen's raster paint
// layer used (saturating at LAKE_SHADE_SATURATION_M), ice the pale crevasse
// ramp. The sea is painted ONLY on shore cells — land cells the level cuts
// into, and the sea cells next to land, which the renderer paints as shore
// for exactly this reason (elevationMapImage.ts) — so that everything the
// compositor draws over the open sea (names, wind, currents) stays visible:
// there the texture's own paper sea is left alone. Lakes are painted
// wherever they are, since no layer paints them any more.

// The lake tint's saturation depth, metres — set just above the measured
// 99th percentile (859 m) so the ramp spends its range on the depths lakes
// actually have (moved here from the screen's raster paint layer).
const LAKE_SHADE_SATURATION_M = 900

// The paper's hillshade (generator/render/reliefShade.ts), restated for the
// shader: exaggeration and the normalized top-left light.
const RELIEF_EXAGGERATION = 45
const LIGHT = [-0.502, -0.502, 0.703] as const

export type WaterStyle = 'paper' | 'paperUnshaded'

const glslFloat = (v: number): string => (Number.isInteger(v) ? `${v}.0` : `${v}`)

// The one texture the water reads, shared by every material that draws the
// same ground: RGBA32F per cell — R the terrain height, G the level the
// cell's water stands at, B the surface kind (SURFACE_*), A whether the cell
// is a SHORE cell of the sea (a sea cell with a land neighbour — the ones the
// renderer paints as shore instead of water, elevationMapImage.ts). One
// four-channel float texture rather than an R and an RG one: RGBA32F is the
// float format every WebGL2 implementation samples, the narrow ones are not.
export class WaterField {
  private texture: RawTexture | null = null
  private elevation: Float32Array | null = null
  private level: Float32Array | null = null
  private surface: Uint8Array | null = null
  // The coast type per cell (coastGraph.COAST_TYPE_CODE), or null.
  private coast: Uint8Array | null = null
  private packed: Float32Array | null = null
  private readonly scene: Scene
  width = 1
  height = 1

  constructor(scene: Scene) {
    this.scene = scene
  }

  get current(): RawTexture | null {
    return this.texture
  }

  get hasLevels(): boolean {
    return this.level !== null
  }

  // The terrain the shore is found on: the world raster, cell centres at
  // (i + 0.5) texels, the same row order as the map's colour texture.
  setElevation(data: Float32Array, width: number, height: number): void {
    if (width !== this.width || height !== this.height) {
      this.level = null
      this.surface = null
      this.packed = null
      this.texture?.dispose()
      this.texture = null
      this.width = width
      this.height = height
    }
    this.elevation = data
    this.upload()
  }

  // The per-cell level and surface kind (hydrology.waterLevelField), or null
  // for "the sea everywhere". Must match the elevation raster's shape.
  //
  // `coast` is the coast type per cell (surface/coastGraph.ts): the shore
  // drawing hatches a cliff, sands a beach and greys a marsh on the land
  // side of the shore line. Optional; absent, the shore is a plain line.
  setLevels(level: Float32Array | null, surface: Uint8Array | null, coast: Uint8Array | null = null): void {
    const fits = level !== null && surface !== null && level.length === this.width * this.height
    this.level = fits ? level : null
    this.surface = fits ? surface : null
    this.coast = coast !== null && coast.length === this.width * this.height ? coast : null
    if (this.elevation) this.upload()
  }

  private upload(): void {
    if (!this.elevation) return
    const n = this.width * this.height
    if (!this.packed || this.packed.length !== 4 * n) this.packed = new Float32Array(4 * n)
    const out = this.packed
    const { elevation, level, surface, coast, width, height } = this
    // A: the shore flag (1 on a sea cell next to land) plus ten times the
    // coast type — on the land coast cells their own, on the sea shore
    // cells the commonest type among their land neighbours, so the band
    // can be drawn on either side of the line.
    for (let i = 0; i < n; i++) {
      out[i * 4] = elevation[i]
      out[i * 4 + 1] = level ? level[i] : 0
      out[i * 4 + 2] = surface ? surface[i] : 0
      out[i * 4 + 3] = coast ? coast[i] * 10 : 0
    }
    // Shore cells of the sea: the same neighbourhood rule the renderer
    // paints shore by, so the two agree on which cells the shader owns.
    const votes = new Int32Array(8)
    for (let y = 0; y < height; y++) {
      const up = ((y - 1 + height) % height) * width
      const down = ((y + 1) % height) * width
      const row = y * width
      for (let x = 0; x < width; x++) {
        if (elevation[row + x] > 0) continue
        const left = (x - 1 + width) % width
        const right = (x + 1) % width
        const around = [row + left, row + right, up + x, up + left, up + right, down + x, down + left, down + right]
        let shore = false
        votes.fill(0)
        for (const nb of around) {
          if (elevation[nb] <= 0) continue
          shore = true
          if (coast) votes[coast[nb] & 7]++
        }
        if (!shore) continue
        let best = 0
        for (let t = 1; t < 8; t++) if (votes[t] > votes[best]) best = t
        out[(row + x) * 4 + 3] = 1 + best * 10
      }
    }
    if (this.texture) this.texture.update(out)
    else this.texture = new RawTexture(out, this.width, this.height, Constants.TEXTUREFORMAT_RGBA, this.scene, false, false, Texture.NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_FLOAT)
  }

  dispose(): void {
    this.texture?.dispose()
    this.texture = null
    this.elevation = null
    this.level = null
    this.surface = null
    this.packed = null
  }
}

export class WaterMaterialPlugin extends MaterialPluginBase {
  private readonly style: WaterStyle
  private readonly field: WaterField
  private lakesOn = true
  // What the defines were last prepared for; a change in either means a
  // recompile (a texture UPDATE does not — the shader is the same).
  private preparedFor = { texture: false, levels: false }

  constructor(material: Material, style: WaterStyle, field: WaterField) {
    super(material, 'Water', 190, { WATER: false, WATERLEVELS: false })
    this.style = style
    this.field = field
    this._enable(true)
  }

  // Lakes follow the hydrology toggle; off, every cell is drawn against the
  // sea's level again (the levels stay loaded for the next on).
  setLakesVisible(on: boolean): void {
    if (on === this.lakesOn) return
    this.lakesOn = on
    this.markAllDefinesAsDirty()
  }

  override getClassName(): string {
    return 'WaterMaterialPlugin'
  }

  private wanted(): { texture: boolean; levels: boolean } {
    const texture = this.field.current !== null
    return { texture, levels: texture && this.field.hasLevels && this.lakesOn }
  }

  override prepareDefines(defines: MaterialDefines): void {
    this.preparedFor = this.wanted()
    defines['WATER'] = this.preparedFor.texture
    defines['WATERLEVELS'] = this.preparedFor.levels
  }

  override getSamplers(samplers: string[]): void {
    samplers.push('waterFieldSampler')
  }

  override getUniforms(): { ubo: { name: string; size: number; type: string }[]; fragment: string } {
    return {
      ubo: [
        { name: 'waterTexSize', size: 2, type: 'vec2' },
        { name: 'waterParams', size: 4, type: 'vec4' },
      ],
      fragment: `#ifdef WATER
        uniform vec2 waterTexSize;
        uniform vec4 waterParams;
      #endif`,
    }
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer, _scene: Scene, _engine: unknown, _subMesh: SubMesh): void {
    // A texture (or the levels) that appeared or vanished since the defines
    // were prepared needs a recompile — the field changes on the screen's
    // schedule, not the material's.
    const want = this.wanted()
    if (want.texture !== this.preparedFor.texture || want.levels !== this.preparedFor.levels) this.markAllDefinesAsDirty()
    const texture = this.field.current
    if (!texture) return
    uniformBuffer.updateFloat2('waterTexSize', this.field.width, this.field.height)
    // x: 1 = shaded paper, 0 = unshaded; y: metres per elevation unit; z:
    // the lake tint's saturation depth in metres; w: the sea's level.
    uniformBuffer.updateFloat4('waterParams', this.style === 'paper' ? 1 : 0, ELEVATION_METERS, LAKE_SHADE_SATURATION_M, 0)
    uniformBuffer.setTexture('waterFieldSampler', texture)
  }

  override getCustomCode(shaderType: string): { [pointName: string]: string } | null {
    if (shaderType === 'vertex') {
      return {
        CUSTOM_VERTEX_DEFINITIONS: 'varying vec2 vWaterUV;',
        // The ground's own texture coordinate, carried as an own varying so
        // the water never depends on which of the material's UV varyings
        // happen to be compiled in.
        CUSTOM_VERTEX_MAIN_END: 'vWaterUV = uv;',
      }
    }
    if (shaderType === 'fragment') {
      return {
        CUSTOM_FRAGMENT_DEFINITIONS: `varying vec2 vWaterUV;
          // Samplers declared HERE, not in getUniforms().fragment — that block
          // is only injected on engines without uniform buffers (see
          // hexGridMaterialPlugin.ts for the failure it caused).
          #ifdef WATER
          uniform sampler2D waterFieldSampler;
          ivec2 waterWrap(ivec2 i) {
            ivec2 s = ivec2(waterTexSize);
            return ivec2((i.x % s.x + s.x) % s.x, (i.y % s.y + s.y) % s.y);
          }
          float waterElevationAt(ivec2 i) {
            return texelFetch(waterFieldSampler, waterWrap(i), 0).r;
          }
          // The paper's per-cell hillshade (reliefShade.ts), at a cell.
          float waterShadeAt(ivec2 i) {
            float e = waterElevationAt(i);
            float dzdx = (waterElevationAt(i + ivec2(1, 0)) - e) * ${glslFloat(RELIEF_EXAGGERATION)};
            float dzdy = (waterElevationAt(i + ivec2(0, 1)) - e) * ${glslFloat(RELIEF_EXAGGERATION)};
            float ndotl = (-dzdx * ${glslFloat(LIGHT[0])} - dzdy * ${glslFloat(LIGHT[1])} + ${glslFloat(LIGHT[2])}) / length(vec3(dzdx, dzdy, 1.0));
            return clamp(ndotl, 0.0, 1.0);
          }
          #endif`,
        CUSTOM_FRAGMENT_MAIN_END: `#ifdef WATER
          {
            // Terrain height between the four nearest cell centres (centres
            // sit at half-texels), wrapping across both seams.
            vec2 p = vWaterUV * waterTexSize - 0.5;
            vec2 f = fract(p);
            ivec2 i0 = ivec2(floor(p));
            float e00 = waterElevationAt(i0);
            float e10 = waterElevationAt(i0 + ivec2(1, 0));
            float e01 = waterElevationAt(i0 + ivec2(0, 1));
            float e11 = waterElevationAt(i0 + ivec2(1, 1));
            float e = mix(mix(e00, e10, f.x), mix(e01, e11, f.x), f.y);
            ivec2 cell = ivec2(floor(vWaterUV * waterTexSize));
            vec4 cellData = texelFetch(waterFieldSampler, waterWrap(cell), 0);
            float level = waterParams.w;
            float surface = ${glslFloat(SURFACE_SEA)};
            #ifdef WATERLEVELS
            level = cellData.g;
            surface = cellData.b;
            #endif
            // The sea is the shader's only on shore cells (see the header);
            // the open sea keeps the texture and whatever is drawn on it.
            float coastType = floor(cellData.a / 10.0 + 0.05);
            float shoreFlag = cellData.a - coastType * 10.0;
            bool shoreCell = cellData.r >= level || shoreFlag > 0.5 || coastType > 0.5;
            bool paintable = surface >= ${glslFloat(SURFACE_SEA)} + 0.5 || shoreCell;
            float depth = level - e;
            // One-pixel antialiasing on the shore, from the height's own
            // screen-space gradient.
            float aa = max(fwidth(e), 1e-7);
            float coverage = smoothstep(-aa, aa, depth);
            // The coast type (coastGraph.ts) on the LAND side of the line,
            // sea cells only (the surface kind says sea): a cliff is a dark
            // line two pixels wide, a beach a sand band and a marsh a
            // grey-green one, each a few metres of height up the shore.
            if (coastType > 1.5 && surface < ${glslFloat(SURFACE_SEA)} + 0.5 && depth < 0.0) {
              float upM = -depth * waterParams.y;
              if (coastType < 2.5) {
                float line = 1.0 - smoothstep(aa, 3.0 * aa, -depth);
                gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(72.0, 60.0, 50.0) / 255.0, 0.85 * line);
              } else if (coastType < 3.5) {
                float band = 1.0 - smoothstep(4.0, 8.0, upM);
                gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(238.0, 224.0, 178.0) / 255.0, 0.9 * band);
              } else if (coastType < 4.5) {
                float band = 1.0 - smoothstep(2.0, 5.0, upM);
                gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(150.0, 168.0, 130.0) / 255.0, 0.7 * band);
              }
            }
            if (paintable && coverage > 0.0) {
              float depthM = max(0.0, depth) * waterParams.y;
              float shade = min(1.0, depthM / waterParams.z);
              vec3 water;
              float alpha = 1.0;
              if (surface < ${glslFloat(SURFACE_SEA)} + 0.5) {
                // The paper's ocean: light blue under the cell's hillshade,
                // or flat on the unshaded paper.
                float s = waterParams.x > 0.5 ? waterShadeAt(cell) : -1.0;
                water = s >= 0.0
                  ? vec3(178.0 + 30.0 * s, 206.0 + 22.0 * s, 230.0 + 18.0 * s) / 255.0
                  : vec3(208.0, 228.0, 248.0) / 255.0;
              } else if (surface < ${glslFloat(SURFACE_LAKE)} + 0.5) {
                water = vec3(60.0 - 25.0 * shade, 110.0 - 30.0 * shade, 170.0 - 20.0 * shade) / 255.0;
                alpha = 0.75;
              } else {
                water = vec3(216.0 - 12.0 * shade, 230.0 - 10.0 * shade, 242.0 - 6.0 * shade) / 255.0;
                alpha = 0.75;
              }
              gl_FragColor.rgb = mix(gl_FragColor.rgb, water, coverage * alpha);
            }
          }
          #endif`,
      }
    }
    return null
  }
}
