import { CLIMATE_RES_X, CLIMATE_RES_Y, latitudeAt, sampleDryLandAtCell, sampleElevationAtCell } from './climateField'
import { ELEVATION_METERS, SEA_LEVEL } from '../elevation/elevationScale'

// Real-ish units (°C), so the later Whittaker biome thresholds are directly
// usable. Tune by eye — these set the equator-to-pole span.
const T_EQUATOR_C = 30
const T_POLE_C = -25
// The environmental lapse rate — °C lost per unit of elevation. Now a derived
// quantity rather than a tuned one: the real atmosphere loses ~6.5 °C/km, and
// elevationScale says a full unit is ELEVATION_METERS, so this is simply the two
// multiplied. A 1681 m peak (the measured 90th percentile of land) comes out
// 10.9 °C cooler than its lowland, which is what 6.5 °C/km gives.
//
// This replaces a hand-tuned 35 paired with a LAND_LAPSE_REF = 0.35 offset, and
// getting rid of that offset is the point. It existed because the old land
// baseline of 0.35 was not physically a height at all — continental lowland was
// SUPPOSED to read as sea-level-warm, but the scale placed it at what the lapse
// rate had to treat as 3 km up, cooling every land cell on the planet by ~12 °C
// and dragging the whole climate too cold (a ~18 °C equator, tundra across the
// mid-latitudes, and a drier world via the suppressed evaporation). The offset
// was the correct local fix for a scale that meant two different things in its
// two halves. With lowland actually at 360 m, cooling can simply be measured
// from sea level like it is in reality, and the special case disappears.
const LAPSE_C_PER_KM = 6.5
// Exported because the FINE biome evaluation has to undo it: the coarse
// temperature grid already carries this correction for its cell's sampled
// elevation, and applying it again for the local one would double-count.
export const LAPSE_C_PER_ELEVATION = LAPSE_C_PER_KM * (ELEVATION_METERS / 1000)

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
// `dryLand` (optional): the terminal-basin dry-floor override — those cells are
// LAND despite sub-sea elevation, and their lapse term runs UNCLAMPED below
// sea level: a basin floor at −2800 m is ~18 °C hotter than its rim, the
// Dead-Sea/Death-Valley effect. Ocean keeps the clamp (its surface is at 0
// regardless of the bathymetry below).
export function computeTemperature(elevation: Float32Array, worldWidth: number, worldHeight: number, offsetC = 0, contrast = 1, equatorOffset = 0, dryLand?: Uint8Array): Float32Array {
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
      const dry = sampleDryLandAtCell(dryLand, gx, gy, worldWidth, worldHeight)
      const value = base - LAPSE_C_PER_ELEVATION * (dry ? e - SEA_LEVEL : Math.max(0, e - SEA_LEVEL))
      temperature[gy * CLIMATE_RES_X + gx] = value + offsetC
    }
  }
  return temperature
}
