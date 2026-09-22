import { CLIMATE_RES_X, CLIMATE_RES_Y, latitudeAt, sampleDryLandAtCell, sampleElevationAtCell } from './climateField'
import { CLIMATE_TUNING } from './climateTuneParams'
import { SEA_LEVEL } from '../elevation/elevationScale'
import { DEFAULT_PLANET_FORCING, obliquityContrast, solarTemperatureOffsetC, type PlanetForcing } from '../planet/planetForcing'

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
// `planet` (planet/planetForcing.ts): the sun's strength shifts the mean, the
// tilt sets the annual gradient the contrast knob then scales.
export function computeTemperature(elevation: Float32Array, worldWidth: number, worldHeight: number, offsetC = 0, contrast = 1, equatorOffset = 0, dryLand?: Uint8Array, planet: PlanetForcing = DEFAULT_PLANET_FORCING): Float32Array {
  const temperature = new Float32Array(CLIMATE_RES_X * CLIMATE_RES_Y)
  const meanC = (CLIMATE_TUNING.tempEquatorC + CLIMATE_TUNING.tempPoleC) / 2
  const gradient = contrast * obliquityContrast(planet.obliquityDeg)
  const offset = offsetC + solarTemperatureOffsetC(planet.solarConstant)
  for (let gy = 0; gy < CLIMATE_RES_Y; gy++) {
    const lat = latitudeAt(gy, equatorOffset)
    // Deviation from the mean at this latitude (+ at the equator, − at the pole);
    // contrast scales it, so contrast 0 → uniform mean, 1 → the original span.
    const deviation = (CLIMATE_TUNING.tempEquatorC - CLIMATE_TUNING.tempPoleC) * (Math.cos((lat * Math.PI) / 2) - 0.5)
    const base = meanC + gradient * deviation
    for (let gx = 0; gx < CLIMATE_RES_X; gx++) {
      const e = sampleElevationAtCell(elevation, gx, gy, worldWidth, worldHeight)
      const dry = sampleDryLandAtCell(dryLand, gx, gy, worldWidth, worldHeight)
      const value = base - CLIMATE_TUNING.lapseCPerElevation * (dry ? e - SEA_LEVEL : Math.max(0, e - SEA_LEVEL))
      temperature[gy * CLIMATE_RES_X + gx] = value + offset
    }
  }
  return temperature
}
