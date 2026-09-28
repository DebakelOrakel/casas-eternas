import { computeTemperature } from './temperature'
import { DEFAULT_PLANET_FORCING, type PlanetForcing } from '../planet/planetForcing'
import { computeWind } from './wind'
import { applyOceanSST, computeOceanCurrents } from './oceanCurrents'
import { computeSeasonalAmplitude } from './seasonality'
import { computeSeasonalPrecipitation } from './monsoon'
import type { SeasonalPrecipitation } from './monsoon'
import { CLIMATE_INPUTS } from './climateInputParams'

// The METEOROLOGY of one terrain — the load-bearing chain base temperature →
// wind → ocean currents (SST adjusts temperature) → seasonal amplitude →
// monsoon/precipitation, WITHOUT the biome classification on top.
//
// One function because it now has two callers that must not drift: the
// climate stage (pipeline/runtime.ts adds biomes and caches the fields) and
// the erosion engine's water forcing (pipeline/erosionForcing.ts — since the
// stage-2 coupling, the climate panel's sliders reach the erosion solve, so
// the solve must evaluate exactly the chain the panel controls). Same
// precedent as assembleFineForcing: the chain lives once, whoever needs it
// imports it.

export interface WeatherParams {
  // °C added to the latitudinal band.
  temperatureOffset: number
  // Equator-to-pole contrast factor, 1 = neutral.
  temperatureContrast: number
  // Moisture supply factor, 1 = neutral.
  humidity: number
  // Thermal-equator shift as a fraction of half-height.
  equatorOffset: number
  // The Planet stage's forcing (planet/planetForcing.ts); Earth when absent.
  planet?: PlanetForcing
}

// The declared slider defaults in MODEL units — what an untouched climate
// panel means, and therefore what the golden harness and any headless caller
// erode with. Derived from the one declaration (climateInputParams, whose
// toModel carries the percent→factor conversions) rather than restated.
export function defaultWeatherParams(): WeatherParams {
  return {
    temperatureOffset: CLIMATE_INPUTS.tempOffset.default,
    temperatureContrast: CLIMATE_INPUTS.contrast.toModel(CLIMATE_INPUTS.contrast.default),
    humidity: CLIMATE_INPUTS.humidity.toModel(CLIMATE_INPUTS.humidity.default),
    // The thermal equator stays at the map's middle (the shift slider went
    // 2026-09-26, see climateInputParams.ts).
    equatorOffset: 0,
  }
}

export interface Weather {
  temperature: Float32Array
  wind: Float32Array
  currents: Float32Array
  // SST anomaly the currents make, °C, 0 on land (see applyOceanSST).
  currentAnomaly: Float32Array
  seasonalAmplitude: Float32Array
  seasonal: SeasonalPrecipitation
}

// `dryLand` is the terminal-basin dry-floor override (LakeFields.dryBasin):
// those sub-sea cells count as land throughout, with an unclamped downward
// lapse — see computeTemperature.
export function computeWeather(elevation: Float32Array, width: number, height: number, params: WeatherParams, dryLand?: Uint8Array): Weather {
  const planet = params.planet ?? DEFAULT_PLANET_FORCING
  const temperature = computeTemperature(elevation, width, height, params.temperatureOffset, params.temperatureContrast, params.equatorOffset, dryLand, planet)
  const wind = computeWind(params.equatorOffset, planet.rotationHours)
  const currents = computeOceanCurrents(elevation, wind, width, height, dryLand)
  const currentAnomaly = applyOceanSST(temperature, currents, elevation, width, height, dryLand)
  const seasonalAmplitude = computeSeasonalAmplitude(elevation, width, height, params.equatorOffset, dryLand, planet)
  const seasonal = computeSeasonalPrecipitation(elevation, temperature, seasonalAmplitude, wind, width, height, params.humidity, params.equatorOffset, dryLand)
  return { temperature, wind, currents, currentAnomaly, seasonalAmplitude, seasonal }
}
