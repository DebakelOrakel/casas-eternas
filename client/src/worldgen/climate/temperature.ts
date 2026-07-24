import { CLIMATE_RES_X, CLIMATE_RES_Y, latitudeAt, sampleElevationAtCell } from './climateField'
import { SEA_LEVEL } from '../erosion'

// Real-ish units (°C), so the later Whittaker biome thresholds are directly
// usable. Tune by eye — these set the equator-to-pole span.
const T_EQUATOR_C = 30
const T_POLE_C = -25
// °C lost per unit of elevation above sea level. Elevation here is the model's
// normalized field (~0 sea level, land baseline ~0.35, peaks approaching ~1),
// so a peak near 1.0 cools by ~this many degrees — an equatorial high mountain
// ends up cold (Kilimanjaro/Andes), which is the point. Tune by eye.
const LAPSE_C_PER_ELEVATION = 35

// Base air temperature: latitudinal insolation (cosine of latitude angle,
// equator warm → pole cold) minus an elevation lapse on land, plus a global
// `offsetC` (a "greenhouse" thermostat, °C, applied everywhere — the user's
// temperature-band slider). Ocean stays at the latitudinal base + offset for
// now — sea-surface temperature from ocean currents is a later phase. Coarse
// climate grid; elevation sampled from the full-res field so mountain cooling
// isn't averaged away. Values in °C.
export function computeTemperature(elevation: Float32Array, worldWidth: number, worldHeight: number, offsetC = 0): Float32Array {
  const temperature = new Float32Array(CLIMATE_RES_X * CLIMATE_RES_Y)
  for (let gy = 0; gy < CLIMATE_RES_Y; gy++) {
    const lat = latitudeAt(gy)
    const base = T_POLE_C + (T_EQUATOR_C - T_POLE_C) * Math.cos((lat * Math.PI) / 2)
    for (let gx = 0; gx < CLIMATE_RES_X; gx++) {
      const e = sampleElevationAtCell(elevation, gx, gy, worldWidth, worldHeight)
      const value = e > SEA_LEVEL ? base - LAPSE_C_PER_ELEVATION * (e - SEA_LEVEL) : base
      temperature[gy * CLIMATE_RES_X + gx] = value + offsetC
    }
  }
  return temperature
}
