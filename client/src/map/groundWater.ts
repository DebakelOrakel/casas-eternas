import { Color3, Constants, MaterialPluginBase, Mesh, RawTexture, StandardMaterial, Texture, VertexData } from '@babylonjs/core'
import type { Material, MaterialDefines, Scene, SubMesh, UniformBuffer } from '@babylonjs/core'

// THE WATER over the ground rings (groundRings.ts): the sea as one plane
// at its level following the view. The lakes are painted into the rings
// themselves (groundPaint.ts) — a plane per lake, clipped by the
// raster's cells, drew every lake as a block (2026-10-03). Where a plane lies over ground that is not
// that water's — a lake basin under the sea's plane, a lower basin beside
// a lake's quad — the shader reads the BODY FIELD (which body's water a
// world cell holds, waterLevels.ts; −1 the sea) and discards the
// fragment whose body is not the plane's own, carried per vertex. By the
// LEVEL instead, two lakes within a few metres of each other, or a
// lagoon within a few metres of the sea, drew each other's quads as
// slabs (2026-10-03). Ground above the level hides the plane
// by depth as usual. So the planes may be sloppy rectangles, and the
// shoreline is where the painted ground crosses the level, at the
// ground's own resolution.
//
// The look: a translucent blue with a Fresnel edge (flatter view, more
// mirror), a sun highlight and a ripple normal map drifting with time —
// cheap, no reflection pass. The depth tint comes from the ground under
// it, which the painter colours by its depth below the level.

export interface GroundWaterOptions {
  scene: Scene
  worldWidth: number
  worldHeight: number
}

export interface GroundWater {
  // The body field (the body per world raster cell, −1 the sea): the
  // sea's plane is kept only over the sea's own cells.
  setLevels(body: Int32Array, width: number, height: number): void
  // Per frame: where the view is, and the seconds for the ripples.
  update(focusX: number, focusZ: number, seconds: number): void
  setHeightScale(scale: number): void
  setEnabled(on: boolean): void
  dispose(): void
}

// The sea plane's side in world periods, centred on the view's period.
const SEA_PERIODS = 3
// The ripple normal map's side in texels and its wavelength, world units
// (a period must hold a whole number of them: 20 / 0.002 = 10 000).
const RIPPLE_SIZE = 256
const RIPPLE_WAVELENGTH = 0.00025

// Reads the body field at the fragment's world position and keeps the
// fragment only where the field's body is the plane's own (a per-vertex
// attribute, the sea −1).
class WaterLevelPlugin extends MaterialPluginBase {
  private bodies: RawTexture | null = null
  private worldWidth = 1
  private worldHeight = 1

  constructor(material: Material) {
    super(material, 'WaterLevel', 220, { WATERLEVEL: false })
    this._enable(true)
  }

  configure(bodies: RawTexture | null, worldWidth: number, worldHeight: number): void {
    this.bodies = bodies
    this.worldWidth = worldWidth
    this.worldHeight = worldHeight
    this.markAllDefinesAsDirty()
  }

  override getClassName(): string {
    return 'WaterLevelPlugin'
  }

  override prepareDefines(defines: MaterialDefines): void {
    defines['WATERLEVEL'] = this.bodies !== null
  }

  override getSamplers(samplers: string[]): void {
    samplers.push('waterBodySampler')
  }

  override getAttributes(attributes: string[]): void {
    attributes.push('waterBody')
  }

  override getUniforms(): { ubo: { name: string; size: number; type: string }[]; fragment: string } {
    return {
      ubo: [{ name: 'waterLevelWorld', size: 2, type: 'vec2' }],
      fragment: `#ifdef WATERLEVEL
        uniform vec2 waterLevelWorld;
        #endif`,
    }
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer, _scene: Scene, _engine: unknown, _subMesh: SubMesh): void {
    if (this.bodies) uniformBuffer.setTexture('waterBodySampler', this.bodies)
    uniformBuffer.updateFloat2('waterLevelWorld', this.worldWidth, this.worldHeight)
  }

  override getCustomCode(shaderType: string): { [pointName: string]: string } | null {
    if (shaderType === 'vertex') {
      return {
        CUSTOM_VERTEX_DEFINITIONS: `attribute float waterBody;
          varying float vWaterBody;`,
        CUSTOM_VERTEX_MAIN_END: 'vWaterBody = waterBody;',
      }
    }
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: `varying float vWaterBody;
        #ifdef WATERLEVEL
        uniform highp sampler2D waterBodySampler;
        #endif`,
      CUSTOM_FRAGMENT_MAIN_BEGIN: `#ifdef WATERLEVEL
        {
          vec2 uv = vec2(vPositionW.x / waterLevelWorld.x + 0.5, vPositionW.z / waterLevelWorld.y + 0.5);
          float fieldBody = texture2D(waterBodySampler, uv).r;
          if (abs(fieldBody - vWaterBody) > 0.5) discard;
        }
        #endif`,
    }
  }
}

// A tiling ripple normal map: two octaves of hashed value noise, the
// normals from its slope.
function makeRipples(size: number): Uint8Array {
  const hash = (ix: number, iy: number, seed: number): number => {
    let h = ((((ix % size) + size) % size) * 374761393 + (((iy % size) + size) % size) * 668265263 + seed * 1442695041) | 0
    h = Math.imul(h ^ (h >>> 13), 1274126177)
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296
  }
  const noise = (x: number, y: number, period: number, seed: number): number => {
    const sx = (x / size) * period
    const sy = (y / size) * period
    const x0 = Math.floor(sx)
    const y0 = Math.floor(sy)
    const tx = sx - x0
    const ty = sy - y0
    const ux = tx * tx * (3 - 2 * tx)
    const uy = ty * ty * (3 - 2 * ty)
    const wrap = (v: number): number => ((v % period) + period) % period
    const a = hash(wrap(x0), wrap(y0), seed)
    const b = hash(wrap(x0 + 1), wrap(y0), seed)
    const c = hash(wrap(x0), wrap(y0 + 1), seed)
    const d = hash(wrap(x0 + 1), wrap(y0 + 1), seed)
    return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy
  }
  const height = new Float32Array(size * size)
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) height[j * size + i] = noise(i, j, 8, 3) * 0.6 + noise(i, j, 32, 4) * 0.4
  const out = new Uint8Array(size * size * 4)
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const l = height[j * size + ((i + size - 1) % size)]
      const r = height[j * size + ((i + 1) % size)]
      const u = height[((j + size - 1) % size) * size + i]
      const d = height[((j + 1) % size) * size + i]
      const dx = (r - l) * 6
      const dy = (d - u) * 6
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1)
      const p = (j * size + i) * 4
      out[p] = Math.round((-dx * inv * 0.5 + 0.5) * 255)
      out[p + 1] = Math.round((-dy * inv * 0.5 + 0.5) * 255)
      out[p + 2] = Math.round((inv * 0.5 + 0.5) * 255)
      out[p + 3] = 255
    }
  }
  return out
}

export function createGroundWater(options: GroundWaterOptions): GroundWater {
  const { scene, worldWidth, worldHeight } = options
  let exaggeration = 1

  const material = new StandardMaterial('groundWaterMaterial', scene)
  material.diffuseColor = new Color3(0.22, 0.44, 0.6)
  material.specularColor = new Color3(0.5, 0.5, 0.5)
  material.specularPower = 160
  material.alpha = 0.55
  material.backFaceCulling = false
  material.useSpecularOverAlpha = true
  const ripples = RawTexture.CreateRGBATexture(makeRipples(RIPPLE_SIZE), RIPPLE_SIZE, RIPPLE_SIZE, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE)
  ripples.wrapU = Texture.WRAP_ADDRESSMODE
  ripples.wrapV = Texture.WRAP_ADDRESSMODE
  material.bumpTexture = ripples
  material.bumpTexture.level = 0.2
  // The plane wins the depth test by a few depth units where the ground
  // lies at its level (a flat shore flickered between the two,
  // 2026-10-03). Units, not the slope factor: a factor scales with the
  // plane's depth slope, which at a grazing view put the plane in front
  // of every mountain.
  material.zOffsetUnits = -4
  const plugin = new WaterLevelPlugin(material)
  let bodyTexture: RawTexture | null = null

  const sea = new Mesh('groundSea', scene)
  sea.material = material
  sea.isPickable = false
  sea.alphaIndex = 1

  // The sea plane: SEA_PERIODS world periods a side, UVs in ripple
  // wavelengths of world units so the pattern stays put when the plane
  // jumps a period.
  function buildSea(centerX: number, centerZ: number): void {
    const w = worldWidth * SEA_PERIODS
    const h = worldHeight * SEA_PERIODS
    const x0 = centerX - w / 2
    const z0 = centerZ - h / 2
    const data = new VertexData()
    data.positions = [x0, 0, z0, x0 + w, 0, z0, x0, 0, z0 + h, x0 + w, 0, z0 + h]
    data.normals = [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]
    data.uvs = [x0 / RIPPLE_WAVELENGTH, z0 / RIPPLE_WAVELENGTH, (x0 + w) / RIPPLE_WAVELENGTH, z0 / RIPPLE_WAVELENGTH, x0 / RIPPLE_WAVELENGTH, (z0 + h) / RIPPLE_WAVELENGTH, (x0 + w) / RIPPLE_WAVELENGTH, (z0 + h) / RIPPLE_WAVELENGTH]
    data.indices = [0, 1, 2, 1, 3, 2]
    data.applyToMesh(sea, true)
    sea.setVerticesData('waterBody', new Float32Array([-1, -1, -1, -1]), false, 1)
  }
  let seaCenterX = NaN
  let seaCenterZ = NaN

  const applyScale = (): void => {
    sea.scaling.y = exaggeration
    plugin.configure(bodyTexture, worldWidth, worldHeight)
  }

  return {
    setLevels(body, width, height) {
      bodyTexture?.dispose()
      bodyTexture = RawTexture.CreateRTexture(Float32Array.from(body), width, height, scene, false, false, Texture.NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_FLOAT)
      bodyTexture.wrapU = Texture.WRAP_ADDRESSMODE
      bodyTexture.wrapV = Texture.WRAP_ADDRESSMODE
      applyScale()
    },
    update(focusX, focusZ, seconds) {
      // The sea plane and the lakes follow the view's world period; the
      // lakes are built once around the origin and shifted whole periods.
      const cx = Math.round(focusX / worldWidth) * worldWidth
      const cz = Math.round(focusZ / worldHeight) * worldHeight
      if (cx !== seaCenterX || cz !== seaCenterZ) {
        seaCenterX = cx
        seaCenterZ = cz
        buildSea(cx, cz)
      }
      ripples.uOffset = seconds * 0.02
      ripples.vOffset = seconds * 0.013
    },
    setHeightScale(scale) {
      exaggeration = scale
      applyScale()
    },
    setEnabled(on) {
      sea.setEnabled(on)
    },
    dispose() {
      sea.dispose()
      material.dispose()
      ripples.dispose()
      bodyTexture?.dispose()
    },
  }
}
