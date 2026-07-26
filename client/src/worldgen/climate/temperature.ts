import { CLIMATE_RES_X, CLIMATE_RES_Y, latitudeAt, sampleElevationAtCell } from './climateField'

// Real-ish units (°C), so the later Whittaker biome thresholds are directly
// usable. Tune by eye — these set the equator-to-pole span.
const T_EQUATOR_C = 30
const T_POLE_C = -25
// °C lost per unit of elevation, applied only ABOVE the continental lowland baseline
// (LAND_LAPSE_REF) — a peak near 1.0 cools by ~this·(1−ref), so an equatorial high
// mountain ends up cold (Kilimanjaro/Andes). Tune by eye.
const LAPSE_C_PER_ELEVATION = 35
// The lapse reference: thick continental crust's isostatic baseline (≈ RAFT_
// CONTINENTAL_BASELINE 0.35 in elevationField.ts) represents LOWLAND at essentially sea-
// level temperature, not high ground. Cooling relative to SEA_LEVEL (0) instead cooled
// EVERY land cell by ~12°C (0.35·35), shifting all climate bands too cold — a ~18°C
// equator (few tropics/rainforest), frozen mid-latitudes (excess tundra), and, via the
// lower evaporation, a drier/more-desert world. Only real uplift above this cools now.
const LAND_LAPSE_REF = 0.35

// Base air temperature: latitudinal insolation (cosine of latitude angle,
// equator warm → pole cold) minus an elevation lapse on land, plus a global
// `offsetC` (a "greenhouse" thermostat, °C, applied everywhere — the user's
// temperature-band slider). `contrast` scales the equator↔pole spread around
// its MEAN (1 = default; <1 = milder, more uniform climate zones; >1 =
// exaggerated hot-equator/frozen-pole banding — the user's contrast slider);
// the offset then shifts the whole scaled gradient, so the two knobs are
// independent. Ocean stays at the latitudinal base + offset for now —
// sea-surface temperature from ocean currents is a later phase. Coarse climate
// grid; elevation sampled from the full-res field so mountain cooling isn't
// averaged away. Values in °C.
export function computeTemperature(elevation: Float32Array, worldWidth: number, worldHeight: number, offsetC = 0, contrast = 1, equatorOffset = 0): Float32Array {
  const temperature = new Float32Array(CLIMATE_RES_X * CLIMATE_RES_Y)
  const meanC = (T_EQUATOR_C + T_POLE_C) / 2
  for (let gy = 0; gy < CLIMATE_RES_Y; gy++) {
    const lat = latitudeAt(gy, equatorOffset)
    // Deviation from the mean at this latitude (+ at the equator, − at the pole);
    // contrast scales it, so contrast 0 → uniform mean, 1 → the original span.
    const deviation = (T_EQUATOR_C - T_POLE_C) * (Math.cos((lat * Math.PI) / 2) - 0.5)
    const base = meanC + contrast * deviation
    for (let gx = 0; gx < CLIMATE_RES_X; gx++) {
      const e = sampleElevationAtCell(elevation, gx, gy, worldWidth, worldHeight)
      const value = base - LAPSE_C_PER_ELEVATION * Math.max(0, e - LAND_LAPSE_REF)
      temperature[gy * CLIMATE_RES_X + gx] = value + offsetC
    }
  }
  return temperature
}
