import { Biome } from '../worldgen/climate/biomes'
import { hexCenter, hexCorners, hexIdKey } from './hexGrid'
import type { HexId } from './hexGrid'
import { MAP_WORLD_HEIGHT, MAP_WORLD_WIDTH, UNITS_PER_METER } from './mapSceneSettings'

// Phase 2 of the hex build plan (docs/design/hex-world-view.md): per-tile
// classification, DERIVED and cached — never serialized, recomputed per
// session like every presentation artifact. Reads the world only through
// injected samplers so the module stays worldless (the map layer's rule);
// the screen wires the truth surfaces in.
//
// The height sampler must be the shared fine-height seam with bias 0 — the
// same `fineElevationSurface` the near-field patch renders (which passes
// bias 0.6 to stay above the base mesh). Classifying against any OTHER
// height source is how anything placed on the classification's word ends up
// floating over the terrain later.

export interface HexTileSamplers {
  // Terrain surface in world-Y units at map UV — metre-true against the
  // horizontal (sea = 0), i.e. Δy/Δrun is a real tangent.
  heightAtUV(u: number, v: number): number
  // Lake depth in elevation units (0 = no lake), or absent for a save
  // without the layer.
  lakeDepthAtUV?(u: number, v: number): number
  // The biome actually painted at a UV (mapPresentation.biomeIdAtUV), or
  // null where no wash exists.
  biomeIdAtUV?(u: number, v: number): number | null
}

export type HexWaterState = 'water' | 'shore' | 'land'

export interface HexTileClass {
  id: HexId
  // Median terrain height over the sample set, metres above sea level.
  medianHeightMeters: number
  // Highest sampled point of the tile — the readout's "how much relief is in
  // here", and the honest measure of what levelling this tile would have to
  // cut away.
  maxHeightMeters: number
  // Steepest sampled tangent (rise/run, dimensionless).
  slope: number
  water: HexWaterState
  // Fraction of samples on land — the shore tile's "how much is buildable".
  landFraction: number
  biomeId: number | null
  // PROVISIONAL developability 0 (never) … 1 (trivial). The real
  // thresholds/costs are an OPEN question in the design doc; these numbers
  // exist so the classification can be eyeballed, not so anyone balances
  // gameplay on them.
  grade: number
}

// 13 samples: center, the six corners and the six edge midpoints, the outer
// twelve pulled 12% inward so boundary samples don't read the neighbour's
// ground through bilinear support.
const RIM_INSET = 0.88

// ~30° — beyond this the tile counts as undevelopable rock. Placeholder,
// see grade comment above.
const SLOPE_LIMIT = 0.58

// Biome ease-of-development factors. Placeholders in the same sense; the
// ORDER encodes the design doc's story (plains cheap, forest needs
// clearing, ice/alpine never really).
const BIOME_GRADE_FACTOR: Record<number, number> = {
  [Biome.Ocean]: 0,
  [Biome.Ice]: 0,
  [Biome.Tundra]: 0.55,
  [Biome.Boreal]: 0.7,
  [Biome.Grassland]: 1,
  [Biome.Woodland]: 0.9,
  [Biome.TemperateForest]: 0.75,
  [Biome.TemperateRainforest]: 0.6,
  [Biome.Desert]: 0.8,
  [Biome.Savanna]: 0.95,
  [Biome.TropicalRainforest]: 0.5,
  [Biome.Alpine]: 0.2,
  [Biome.SaltFlat]: 0.35,
  [Biome.Glacier]: 0,
}

// World XZ → the map plane's UV — the frame every sampler here is keyed to,
// because the relief meshes sample the surfaces at exactly these vertex UVs.
// Authority is CreateGround's own vertex data (dumped headless 2026-08-13):
// u = 0 at x = −width/2, v = 0 at z = −height/2, both INCREASING — so
// v = z/H + 0.5, NOT the flipped form. (watercolorPass' groundUV computes
// the flipped coordinate for its own knowledge texture, which is uploaded in
// the opposite row order — do not copy it for mesh-UV consumers. The
// mirrored version classified the world upside down, invisible on a
// symmetric test island and obvious on a real world.) Exported so debug
// probes cannot drift from the classifier's own mapping.
export function hexUvFromWorld(x: number, z: number): { u: number; v: number } {
  const u = x / MAP_WORLD_WIDTH + 0.5
  const v = z / MAP_WORLD_HEIGHT + 0.5
  return { u: u - Math.floor(u), v: v - Math.floor(v) }
}
const uvFromWorld = hexUvFromWorld

export interface HexClassifier {
  classify(id: HexId): HexTileClass
}

export function createHexClassifier(samplers: HexTileSamplers): HexClassifier {
  // Derived data, so the cache lives and dies with the classifier — the
  // screen builds a fresh one whenever the height raster in force changes
  // (load, amplified tier landing).
  const cache = new Map<string, HexTileClass>()
  const CACHE_CAP = 32768

  function classify(id: HexId): HexTileClass {
    const key = hexIdKey(id)
    const hit = cache.get(key)
    if (hit) return hit

    const center = hexCenter(id)
    const corners = hexCorners(id)
    const points: { x: number; z: number }[] = [center]
    for (let k = 0; k < 6; k++) {
      const a = corners[k]
      const b = corners[(k + 1) % 6]
      points.push({ x: center.x + (a.x - center.x) * RIM_INSET, z: center.z + (a.z - center.z) * RIM_INSET })
      const mx = (a.x + b.x) / 2
      const mz = (a.z + b.z) / 2
      points.push({ x: center.x + (mx - center.x) * RIM_INSET, z: center.z + (mz - center.z) * RIM_INSET })
    }

    const heights = new Array<number>(points.length)
    let waterCount = 0
    let maxSlope = 0
    for (let i = 0; i < points.length; i++) {
      const { u, v } = uvFromWorld(points[i].x, points[i].z)
      const y = samplers.heightAtUV(u, v)
      heights[i] = y
      const inLake = (samplers.lakeDepthAtUV?.(u, v) ?? 0) > 1e-9
      if (y <= 1e-12 || inLake) waterCount++
      if (i > 0) {
        const run = Math.hypot(points[i].x - center.x, points[i].z - center.z)
        if (run > 0) maxSlope = Math.max(maxSlope, Math.abs(y - heights[0]) / run)
      }
    }

    const sorted = [...heights].sort((a, b) => a - b)
    const medianHeightMeters = sorted[(sorted.length - 1) >> 1] / UNITS_PER_METER
    const maxHeightMeters = sorted[sorted.length - 1] / UNITS_PER_METER
    const landFraction = 1 - waterCount / points.length
    const water: HexWaterState = waterCount === points.length ? 'water' : waterCount === 0 ? 'land' : 'shore'

    const { u, v } = uvFromWorld(center.x, center.z)
    const biomeId = samplers.biomeIdAtUV?.(u, v) ?? null

    let grade = 0
    if (water !== 'water') {
      const slopeBase = Math.max(0, 1 - maxSlope / SLOPE_LIMIT)
      const biomeFactor = biomeId !== null ? (BIOME_GRADE_FACTOR[biomeId] ?? 1) : 1
      grade = slopeBase * biomeFactor * (water === 'shore' ? landFraction : 1)
    }

    const result: HexTileClass = { id, medianHeightMeters, maxHeightMeters, slope: maxSlope, water, landFraction, biomeId, grade }
    if (cache.size >= CACHE_CAP) cache.clear()
    cache.set(key, result)
    return result
  }

  return { classify }
}
