import { CLIMATE_RES_X, CLIMATE_RES_Y, sampleElevationAtCell } from './climateField'
import { SEA_LEVEL } from '../erosion'

const RX = CLIMATE_RES_X
const RY = CLIMATE_RES_Y

// A Whittaker-style biome set (~11), keyed by mean annual temperature and
// precipitation, with the seasonal amplitude splitting continental grassland
// from milder woodland. Ocean is its own id so the biome layer can skip it.
// See docs/decisions/climate-biomes.md.
export const Biome = {
  Ocean: 0,
  Ice: 1,
  Tundra: 2,
  Boreal: 3,
  Grassland: 4,
  Woodland: 5,
  TemperateForest: 6,
  TemperateRainforest: 7,
  Desert: 8,
  Savanna: 9,
  TropicalRainforest: 10,
} as const

type BiomeId = (typeof Biome)[keyof typeof Biome]

const BIOME_COLORS: Record<number, [number, number, number]> = {
  [Biome.Ocean]: [40, 90, 140],
  [Biome.Ice]: [235, 240, 245],
  [Biome.Tundra]: [165, 172, 158],
  [Biome.Boreal]: [70, 110, 88],
  [Biome.Grassland]: [200, 190, 120],
  [Biome.Woodland]: [150, 160, 92],
  [Biome.TemperateForest]: [92, 150, 82],
  [Biome.TemperateRainforest]: [48, 112, 72],
  [Biome.Desert]: [222, 202, 150],
  [Biome.Savanna]: [192, 178, 92],
  [Biome.TropicalRainforest]: [30, 118, 60],
}

export function biomeColor(id: number): [number, number, number] {
  return BIOME_COLORS[id] ?? [128, 128, 128]
}

// Classify one cell. T = mean annual °C, P = annual precip mm/yr, amp = seasonal
// temperature amplitude °C (aridity is implicit: at a given P, hotter needs more
// water to escape desert; the T bands below encode that). Thresholds are the
// tunable part of the Whittaker mapping.
function classify(tempC: number, precipMm: number, amplitude: number): BiomeId {
  if (tempC < -10) return Biome.Ice
  if (tempC < 0) return Biome.Tundra
  if (tempC < 7) {
    return precipMm < 200 ? Biome.Tundra : Biome.Boreal
  }
  if (tempC < 20) {
    if (precipMm < 250) return Biome.Desert
    if (precipMm < 600) return amplitude > 20 ? Biome.Grassland : Biome.Woodland
    if (precipMm < 1500) return Biome.TemperateForest
    return Biome.TemperateRainforest
  }
  // Hot (T ≥ 20)
  if (precipMm < 250) return Biome.Desert
  if (precipMm < 1000) return Biome.Savanna
  return Biome.TropicalRainforest
}

// Biome id per climate cell (Uint8). Land only is classified; ocean → Biome.Ocean.
// Consumes the current-adjusted temperature, annual precipitation, and seasonal
// amplitude (all already on the climate grid).
export function computeBiomes(temperature: Float32Array, precipitation: Float32Array, seasonalAmplitude: Float32Array, elevation: Float32Array, worldWidth: number, worldHeight: number): Uint8Array {
  const biomes = new Uint8Array(RX * RY)
  for (let gy = 0; gy < RY; gy++) {
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      if (sampleElevationAtCell(elevation, gx, gy, worldWidth, worldHeight) <= SEA_LEVEL) {
        biomes[i] = Biome.Ocean
        continue
      }
      biomes[i] = classify(temperature[i], precipitation[i], seasonalAmplitude[i])
    }
  }
  return biomes
}
