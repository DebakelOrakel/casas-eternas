import { computeTemperature } from './temperature'
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
    equatorOffset: CLIMATE_INPUTS.equatorOffset.toModel(CLIMATE_INPUTS.equatorOffset.default),
  }
}

export interface Weather {
  temperature: Float32Array
  wind: Float32Array
  currents: Float32Array
  seasonalAmplitude: Float32Array
  seasonal: SeasonalPrecipitation
}

// `dryLand` is the terminal-basin dry-floor override (LakeFields.dryBasin):
// those sub-sea cells count as land throughout, with an unclamped downward
// lapse — see computeTemperature.
export function computeWeather(elevation: Float32Array, width: number, height: number, params: WeatherParams, dryLand?: Uint8Array): Weather {
  const temperature = computeTemperature(elevation, width, height, params.temperatureOffset, params.temperatureContrast, params.equatorOffset, dryLand)
  const wind = computeWind(params.equatorOffset)
  const currents = computeOceanCurrents(elevation, wind, width, height, dryLand)
  applyOceanSST(temperature, currents, elevation, width, height, dryLand)
  const seasonalAmplitude = computeSeasonalAmplitude(elevation, width, height, params.equatorOffset, dryLand)
  const seasonal = computeSeasonalPrecipitation(elevation, temperature, seasonalAmplitude, wind, width, height, params.humidity, params.equatorOffset, dryLand)
  return { temperature, wind, currents, seasonalAmplitude, seasonal }
}
