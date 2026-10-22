import { type PlanetForcing } from '../planet/planetForcing'
import { CLIMATE_INPUTS } from './climateInputParams'

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
