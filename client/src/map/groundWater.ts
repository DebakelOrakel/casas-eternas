import { Color3, Constants, MaterialPluginBase, Mesh, RawTexture, StandardMaterial, Texture, VertexData } from '@babylonjs/core'
import type { Material, MaterialDefines, Scene, SubMesh, UniformBuffer } from '@babylonjs/core'

// THE WATER over the ground rings (groundRings.ts): the sea as one plane
// at its level following the view, every lake as a quad at its own
// level, all of one material. Where a plane lies over ground that is not
// that water's — a lake basin under the sea's plane, a lower basin beside
// a lake's quad — the shader reads the LEVEL FIELD (the water level per
// world cell, hydrology.waterLevelField) and discards the fragment whose
// level is not the plane's own. Ground above the level hides the plane
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
  // World Y per elevation unit (before the exaggeration).
  heightScale: number
}

export interface GroundWater {
  // The level field (elevation units, a cell per world raster cell) and
  // the lakes it holds: each a bounding box in cells and a level.
  setLevels(level: Float32Array, width: number, height: number, lakes: { x0: number; y0: number; x1: number; y1: number; level: number }[]): void
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
const RIPPLE_WAVELENGTH = 0.002
// How far (world units) a plane's level may differ from the field's and
// still be its own. The fragment's world y is a float32 of a position
// up to 10 units, so it carries ~1e-6 of noise — at 1e-6 every lake but
// the sea (at y = 0 exactly) was discarded whole (2026-10-03). 4e-5 is
// ~5 m of real height at 6×; two bodies closer than that in level and
// touching would share a plane, which is no harm.
const LEVEL_TOLERANCE_UNITS = 4e-5
// The lake quads reach this many cells past the body's cells: its rim.
const LAKE_MARGIN_CELLS = 1

// Reads the level field at the fragment's world position and keeps the
// fragment only where the field's level is the plane's own.
class WaterLevelPlugin extends MaterialPluginBase {
  private levels: RawTexture | null = null
  private worldWidth = 1
  private worldHeight = 1
  private unitsPerLevel = 1

  constructor(material: Material) {
    super(material, 'WaterLevel', 220, { WATERLEVEL: false })
    this._enable(true)
  }

  configure(levels: RawTexture | null, worldWidth: number, worldHeight: number, unitsPerLevel: number): void {
    this.levels = levels
    this.worldWidth = worldWidth
    this.worldHeight = worldHeight
    this.unitsPerLevel = unitsPerLevel
    this.markAllDefinesAsDirty()
  }

  override getClassName(): string {
    return 'WaterLevelPlugin'
  }

  override prepareDefines(defines: MaterialDefines): void {
    defines['WATERLEVEL'] = this.levels !== null
  }

  override getSamplers(samplers: string[]): void {
    samplers.push('waterLevelSampler')
  }

  override getUniforms(): { ubo: { name: string; size: number; type: string }[]; fragment: string } {
    return {
      ubo: [{ name: 'waterLevelWorld', size: 4, type: 'vec4' }],
      fragment: `#ifdef WATERLEVEL
        uniform vec4 waterLevelWorld;
        #endif`,
    }
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer, _scene: Scene, _engine: unknown, _subMesh: SubMesh): void {
    if (this.levels) uniformBuffer.setTexture('waterLevelSampler', this.levels)
    uniformBuffer.updateFloat4('waterLevelWorld', this.worldWidth, this.worldHeight, this.unitsPerLevel, LEVEL_TOLERANCE_UNITS)
  }

  override getCustomCode(shaderType: string): { [pointName: string]: string } | null {
    if (shaderType !== 'fragment') return null
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: `#ifdef WATERLEVEL
        uniform highp sampler2D waterLevelSampler;
        #endif`,
      CUSTOM_FRAGMENT_MAIN_BEGIN: `#ifdef WATERLEVEL
        {
          vec2 uv = vec2(vPositionW.x / waterLevelWorld.x + 0.5, vPositionW.z / waterLevelWorld.y + 0.5);
          float fieldLevel = texture2D(waterLevelSampler, uv).r * waterLevelWorld.z;
          if (abs(fieldLevel - vPositionW.y) > waterLevelWorld.w) discard;
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
  const { scene, worldWidth, worldHeight, heightScale } = options
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
  let levelTexture: RawTexture | null = null

  const sea = new Mesh('groundSea', scene)
  sea.material = material
  sea.isPickable = false
  sea.alphaIndex = 1
  const lakes = new Mesh('groundLakes', scene)
  lakes.material = material
  lakes.isPickable = false
  lakes.alphaIndex = 2

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
  }
  let seaCenterX = NaN
  let seaCenterZ = NaN

  const applyScale = (): void => {
    sea.scaling.y = exaggeration
    lakes.scaling.y = exaggeration
    plugin.configure(levelTexture, worldWidth, worldHeight, heightScale * exaggeration)
  }

  return {
    setLevels(level, width, height, lakeBoxes) {
      levelTexture?.dispose()
      levelTexture = RawTexture.CreateRTexture(level, width, height, scene, false, false, Texture.NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_FLOAT)
      levelTexture.wrapU = Texture.WRAP_ADDRESSMODE
      levelTexture.wrapV = Texture.WRAP_ADDRESSMODE
      // The lake quads, one mesh: a cell (cx, cy) spans world x from
      // (cx / width − ½) · worldWidth, as the map plane maps its texels.
      const positions: number[] = []
      const normals: number[] = []
      const uvs: number[] = []
      const indices: number[] = []
      for (const box of lakeBoxes) {
        const x0 = ((box.x0 - LAKE_MARGIN_CELLS) / width - 0.5) * worldWidth
        const x1 = ((box.x1 + 1 + LAKE_MARGIN_CELLS) / width - 0.5) * worldWidth
        const z0 = ((box.y0 - LAKE_MARGIN_CELLS) / height - 0.5) * worldHeight
        const z1 = ((box.y1 + 1 + LAKE_MARGIN_CELLS) / height - 0.5) * worldHeight
        const y = box.level * heightScale
        const base = positions.length / 3
        positions.push(x0, y, z0, x1, y, z0, x0, y, z1, x1, y, z1)
        for (let k = 0; k < 4; k++) normals.push(0, 1, 0)
        uvs.push(x0 / RIPPLE_WAVELENGTH, z0 / RIPPLE_WAVELENGTH, x1 / RIPPLE_WAVELENGTH, z0 / RIPPLE_WAVELENGTH, x0 / RIPPLE_WAVELENGTH, z1 / RIPPLE_WAVELENGTH, x1 / RIPPLE_WAVELENGTH, z1 / RIPPLE_WAVELENGTH)
        indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2)
      }
      const data = new VertexData()
      data.positions = positions
      data.normals = normals
      data.uvs = uvs
      data.indices = indices
      data.applyToMesh(lakes, true)
      lakes.setEnabled(indices.length > 0)
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
      lakes.position.set(cx, 0, cz)
      ripples.uOffset = seconds * 0.02
      ripples.vOffset = seconds * 0.013
    },
    setHeightScale(scale) {
      exaggeration = scale
      applyScale()
    },
    setEnabled(on) {
      sea.setEnabled(on)
      lakes.setEnabled(on && lakes.getTotalIndices() > 0)
    },
    dispose() {
      sea.dispose()
      lakes.dispose()
      material.dispose()
      ripples.dispose()
      levelTexture?.dispose()
    },
  }
}
