import { computeTemperature } from './temperature'
import { DEFAULT_PLANET_FORCING, type PlanetForcing } from '../planet/planetForcing'
import { computeWind, type CellVectors } from './wind'
import { applyOceanSST, computeOceanCurrents } from './oceanCurrents'
import { computeSeasonalAmplitude, OCEAN_AMPLITUDE } from './seasonality'
import { computeSeasonalPrecipitation } from './monsoon'
import type { SeasonalPrecipitation } from './monsoon'
import { CLIMATE_INPUTS } from './climateInputParams'
import { CLIMATE_RES_X, CLIMATE_RES_Y } from './climateField'
import { OCEAN_PRECIP } from './precipitation'
import { climateLandRaster, climateRaster, climateVectorRaster, rasterLand, type ClimateTerrain } from './climateMesh'
import { fieldFromRasterAtCentres } from '../fields/fieldMesh'

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
//
// ON THE CLIMATE'S FIELD MESH (DEC-0036 phase 3, climateMesh.ts): the
// temperature, the wind, the seasonality and the rain are computed per cell
// of one mesh, both shapes; `mesh` holds them. The ocean currents and the
// sea surface they make stay on the 256 × 128 raster until phase 4, and
// everything that reads the climate outside these stages reads the
// climate raster until its own phase — the TRANSITION adapters below, each
// marked for the phase that removes it.

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
  // OCEAN_AMPLITUDE on the sea.
  seasonalAmplitude: Float64Array
  seasonal: SeasonalPrecipitation
}

export interface Weather {
  terrain: ClimateTerrain
  mesh: WeatherMesh
  // DEC-0036 transition: the climate raster (CLIMATE_RES_X × CLIMATE_RES_Y)
  // of the fields above, for the readers that keep it until their phase —
  // removed in phase 7 (biomes, ecology, hydrology, the ice, the coast, the
  // ledger, the save's layers, the screen's overlays). Land fields carry
  // their sentinel on the raster's sea (climateMesh.climateLandRaster).
  temperature: Float32Array
  wind: Float32Array
  seasonalAmplitude: Float32Array
  seasonal: { annual: Float32Array; index: Float32Array }
  // The ocean currents and the SST anomaly they make, on the raster (phase
  // 4 moves them).
  currents: Float32Array
  // SST anomaly the currents make, °C, 0 on land (see applyOceanSST).
  currentAnomaly: Float32Array
}

export function computeWeather(terrain: ClimateTerrain, params: WeatherParams): Weather {
  const planet = params.planet ?? DEFAULT_PLANET_FORCING
  const { cm } = terrain
  const RX = CLIMATE_RES_X
  const RY = CLIMATE_RES_Y
  const temperature = computeTemperature(terrain, params.temperatureOffset, params.temperatureContrast, params.equatorOffset, planet)
  const wind = computeWind(cm, params.equatorOffset, planet.rotationHours)

  // DEC-0036 transition: removed in phase 4. The currents and their sea
  // surface run on the climate raster: the wind and the temperature
  // rasterised for them, and what applyOceanSST changes of the raster's
  // temperature (the sea's surface, the anomaly the wind carries inland)
  // brought back onto the mesh at the cells' centres and added.
  const windRaster = climateVectorRaster(cm, wind.e, wind.s, RX, RY)
  const currents = computeOceanCurrents(terrain.elevation, windRaster, terrain.rasterDomain, terrain.dryLand ?? undefined, params.equatorOffset)
  const sst = climateRaster(cm, temperature, RX, RY)
  const before = sst.slice()
  const currentAnomaly = applyOceanSST(sst, currents, terrain.elevation, terrain.rasterDomain, windRaster, terrain.dryLand ?? undefined)
  for (let k = 0; k < sst.length; k++) before[k] = sst[k] - before[k]
  const change = fieldFromRasterAtCentres(cm.mesh, before, RX, RY)
  for (let i = 0; i < temperature.length; i++) temperature[i] += change[i]

  const seasonalAmplitude = computeSeasonalAmplitude(terrain, params.equatorOffset, planet)
  const seasonal = computeSeasonalPrecipitation(terrain, temperature, seasonalAmplitude, wind, params.humidity, params.equatorOffset)

  // DEC-0036 transition: removed in phase 7 — the rasters the readers
  // outside the static climate take.
  const landPixels = rasterLand(terrain, RX, RY)
  return {
    terrain,
    mesh: { temperature, wind, seasonalAmplitude, seasonal },
    temperature: climateRaster(cm, temperature, RX, RY),
    wind: windRaster,
    seasonalAmplitude: climateLandRaster(terrain, seasonalAmplitude, OCEAN_AMPLITUDE, RX, RY, landPixels),
    seasonal: {
      annual: climateLandRaster(terrain, seasonal.annual, OCEAN_PRECIP, RX, RY, landPixels),
      index: climateLandRaster(terrain, seasonal.index, OCEAN_PRECIP, RX, RY, landPixels),
    },
    currents,
    currentAnomaly,
  }
}
