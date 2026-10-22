import { computeTemperature } from './temperature'
import { DEFAULT_PLANET_FORCING, hadleyEdge, type PlanetForcing } from '../planet/planetForcing'
import { computeWind, type CellVectors } from './wind'
import { applyOceanSST, computeOceanCurrents, type OceanCurrents } from './oceanCurrents'
import { computeSeasonalAmplitude } from './seasonality'
import { computeSeasonalPrecipitation } from './monsoon'
import type { SeasonalPrecipitation } from './monsoon'
import { CLIMATE_INPUTS } from './climateInputParams'
import type { ClimateTerrain } from './climateMesh'

// The METEOROLOGY of one terrain — the load-bearing chain base temperature →
// wind → ocean currents (SST adjusts temperature) → seasonal amplitude →
// monsoon/precipitation, WITHOUT the biome classification on top.
//
// One function because it now has two callers that must not drift: the
// climate stage (pipeline/runtime.ts adds biomes and caches the fields) and
// the erosion engine's water forcing (the engine's erosion_forcing.rs — since the
// stage-2 coupling, the climate panel's sliders reach the erosion solve, so
// the solve must evaluate exactly the chain the panel controls). Same
// precedent as the fine forcing: the chain lives once, whoever needs it
// imports it.
//
// ON THE CLIMATE'S FIELD MESH (DEC-0036 phases 3 and 4, climateMesh.ts):
// the temperature, the wind, the ocean currents and the sea surface they
// make, the seasonality and the rain are computed per cell of one mesh,
// both shapes; `mesh` holds them. Everything that reads the climate outside
// these stages samples its cells at its own points (climatePoints.ts,
// DEC-0036 phase 7); the screen's textures are its chart (climateChart.ts).

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

// The static climate per cell of the climate's field mesh.
export interface WeatherMesh {
  // °C, the sea's with the currents' surface anomaly.
  temperature: Float64Array
  wind: CellVectors
  // The currents (normalised, 0 on land) and the sea-surface anomaly they
  // make, °C, 0 on land (oceanCurrents.applyOceanSST).
  currents: OceanCurrents
  currentAnomaly: Float64Array
  // OCEAN_AMPLITUDE on the sea.
  seasonalAmplitude: Float64Array
  seasonal: SeasonalPrecipitation
}

export interface Weather {
  terrain: ClimateTerrain
  mesh: WeatherMesh
}

export function computeWeather(terrain: ClimateTerrain, params: WeatherParams): Weather {
  const planet = params.planet ?? DEFAULT_PLANET_FORCING
  const { cm } = terrain
  const temperature = computeTemperature(terrain, params.temperatureOffset, params.temperatureContrast, params.equatorOffset, planet)
  const wind = computeWind(cm, params.equatorOffset, planet.rotationHours)

  // The currents under the wind, and the sea surface they make (in
  // place: the sea takes its SST, the land the anomaly the wind carries).
  const currents = computeOceanCurrents(terrain, wind, params.equatorOffset)
  const currentAnomaly = applyOceanSST(terrain, temperature, currents, wind)

  const seasonalAmplitude = computeSeasonalAmplitude(terrain, params.equatorOffset, planet)
  const seasonal = computeSeasonalPrecipitation(terrain, temperature, seasonalAmplitude, wind, params.humidity, params.equatorOffset, hadleyEdge(planet.rotationHours))

  return { terrain, mesh: { temperature, wind, currents, currentAnomaly, seasonalAmplitude, seasonal } }
}
