import { CLIMATE_RES_Y, latitudeAt, latitudeOfNorm, shiftedNorm } from './climateField'
import { CLIMATE_TUNING } from './climateTuneParams'
import { ELEVATION_METERS, SEA_LEVEL } from '../elevation/elevationScale'
import type { ClimateTerrain } from './climateMesh'
import { smoothGaussian } from '../fields/fieldOperators'
import { DEFAULT_PLANET_FORCING, obliquityContrast, solarTemperatureOffsetC, type PlanetForcing } from '../planet/planetForcing'
import { detCos } from '../core/detMath'

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
// The latitudinal base at a latitude (−1 pole … 0 equator … 1 pole), °C,
// before the global offset: the mean of the equator and pole temperatures
// plus the contrast-scaled deviation (+ at the equator, − at the pole), so
// contrast 0 is a uniform mean and 1 the original span. The tilt scales the
// gradient too (planet/planetForcing.ts).
export function baseTemperatureAtLatitude(lat: number, contrast: number, planet: PlanetForcing): number {
  const meanC = (CLIMATE_TUNING.tempEquatorC + CLIMATE_TUNING.tempPoleC) / 2
  const gradient = contrast * obliquityContrast(planet.obliquityDeg)
  const deviation = (CLIMATE_TUNING.tempEquatorC - CLIMATE_TUNING.tempPoleC) * (detCos((lat * Math.PI) / 2) - 0.5)
  return meanC + gradient * deviation
}

// The sea-level temperature per climate row, °C, offset included — what the
// generator's temperature scale beside the map shows: the band a flat sea
// would have at each latitude, nothing of the terrain.
export function seaLevelTemperatureBand(offsetC: number, contrast: number, planet: PlanetForcing = DEFAULT_PLANET_FORCING): Float32Array {
  const band = new Float32Array(CLIMATE_RES_Y)
  const offset = offsetC + solarTemperatureOffsetC(planet.solarConstant)
  for (let gy = 0; gy < CLIMATE_RES_Y; gy++) band[gy] = baseTemperatureAtLatitude(latitudeAt(gy, 0), contrast, planet) + offset
  return band
}

// The air temperature per cell of the climate's field mesh (climateMesh.ts,
// DEC-0036 phase 3), °C: the latitude's base at the cell's centre, the
// lapse of the ground under it, the mass elevation effect on land.
export function computeTemperature(terrain: ClimateTerrain, offsetC = 0, contrast = 1, equatorOffset = 0, planet: PlanetForcing = DEFAULT_PLANET_FORCING): Float64Array {
  const { cm, z, dry, land } = terrain
  const n = cm.mesh.count
  const temperature = new Float64Array(n)
  const offset = offsetC + solarTemperatureOffsetC(planet.solarConstant)
  // The mass elevation effect: a broad high surface heats the air on it,
  // which is warmer than the free air at its height — Tibet, the Altiplano,
  // Mexico's and East Africa's plateaus. The land's height around a cell,
  // km, smoothed by a Gaussian of `tempPlateauSigmaM` (the sea counts as 0,
  // so a lone peak or a coastal range gains little), times
  // `tempPlateauCPerKm`, on land.
  const plateauKm = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const base = baseTemperatureAtLatitude(latitudeOfNorm(shiftedNorm(cm.yNorm[i], equatorOffset)), contrast, planet)
    const e = z[i]
    const value = base - CLIMATE_TUNING.lapseCPerElevation * (dry[i] ? e - SEA_LEVEL : Math.max(0, e - SEA_LEVEL))
    temperature[i] = value + offset
    if (land[i]) plateauKm[i] = Math.max(0, (e - SEA_LEVEL) * ELEVATION_METERS / 1000)
  }
  if (CLIMATE_TUNING.tempPlateauCPerKm > 0) {
    smoothGaussian(cm.mesh, plateauKm, CLIMATE_TUNING.tempPlateauSigmaM, plateauKm)
    for (let i = 0; i < n; i++) if (land[i]) temperature[i] += CLIMATE_TUNING.tempPlateauCPerKm * plateauKm[i]
  }
  return temperature
}
