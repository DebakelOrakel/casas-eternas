import { CLIMATE_RES_X, CLIMATE_RES_Y, isLandAtCell, latitudeAt } from './climateField'
import { CLIMATE_TUNING } from './climateTuneParams'
import { reduceTemperatureToSeaLevel } from './biomes'
import { computePressureWind, monthTemperature, REFINED_MONTHS } from './pressure'
import { applyOceanSST, computeOceanCurrents, computeUpwelling, eastwardInBasin } from './oceanCurrents'
import { computeTemperature } from './temperature'
import type { WeatherParams } from './weather'
import { DEFAULT_PLANET_FORCING } from '../planet/planetForcing'

// THE CLIMATE STEP'S REFINEMENT (docs/design/climate-refinement.md): the
// climate the history left, computed again with more physics on the final
// geography. One call, in its load-bearing order; each build step adds its
// part here. The history's epochs never call it.

export interface RefinedClimate {
  months: number
  // Sea-level pressure, hPa, months × cells (month-major).
  pressure: Float32Array
  // Surface wind [u, v] per cell, months × cells × 2 (month-major).
  wind: Float32Array
  // The ocean currents under the year's mean wind, [u, v] per cell,
  // normalised like computeOceanCurrents'.
  currents: Float32Array
  // The sea-surface anomaly those currents and the upwelling make, °C per
  // ocean cell, 0 on land (positive warm, negative cold).
  currentAnomaly: Float32Array
  // Ekman upwelling per ocean cell (computeUpwelling), 0 on land, the rising
  // part weighted like the cooling: near the equator by the cell's place in
  // its basin (only the east brings cold water up).
  upwelling: Float32Array
}

// `temperature`, `seasonalAmplitude` and `baseWind` are the climate the step
// shows (climate/weather.computeWeather on the same terrain), `params` the
// levers it was computed with.
export function refineClimate(
  elevation: Float32Array, width: number, height: number, params: WeatherParams,
  temperature: Float32Array, seasonalAmplitude: Float32Array, baseWind: Float32Array,
): RefinedClimate {
  const n = CLIMATE_RES_X * CLIMATE_RES_Y
  const planet = params.planet ?? DEFAULT_PLANET_FORCING
  const land = new Uint8Array(n)
  for (let gy = 0; gy < CLIMATE_RES_Y; gy++) {
    for (let gx = 0; gx < CLIMATE_RES_X; gx++) land[gy * CLIMATE_RES_X + gx] = isLandAtCell(elevation, undefined, gx, gy, width, height) ? 1 : 0
  }

  // A: pressure and wind for each month.
  const pressure = new Float32Array(REFINED_MONTHS * n)
  const wind = new Float32Array(REFINED_MONTHS * n * 2)
  for (let month = 0; month < REFINED_MONTHS; month++) {
    const air = reduceTemperatureToSeaLevel(monthTemperature(temperature, seasonalAmplitude, month, params.equatorOffset), elevation, width, height)
    const result = computePressureWind(air, land, elevation, width, height, baseWind, params.equatorOffset, planet.rotationHours)
    pressure.set(result.pressure, month * n)
    wind.set(result.wind, month * n * 2)
  }

  // The currents follow the year's mean wind: the ocean answers the wind
  // over months, not within one.
  const annualWind = new Float32Array(n * 2)
  for (let month = 0; month < REFINED_MONTHS; month++) {
    for (let i = 0; i < n * 2; i++) annualWind[i] += wind[month * n * 2 + i] / REFINED_MONTHS
  }
  const currents = computeOceanCurrents(elevation, annualWind, width, height, undefined, params.equatorOffset)

  // The sea-surface anomaly, from the latitudinal base (not from `temperature`,
  // which already carries the history's currents).
  const base = computeTemperature(elevation, width, height, params.temperatureOffset, params.temperatureContrast, params.equatorOffset, undefined, planet)
  const currentAnomaly = applyOceanSST(base, currents, elevation, width, height)

  // Upwelling cools the sea where it comes up. The cold eastern coasts are
  // mostly this, not the slow currents along them.
  // Near the equator only the eastern part of a basin cools (see
  // eastwardInBasin); off the equator the coast's own upwelling counts in
  // full. The blend runs over `upwellingEquatorBandDeg`.
  const upwelling = computeUpwelling(annualWind, land, params.equatorOffset, planet.rotationHours)
  const east = eastwardInBasin(land)
  for (let gy = 0; gy < CLIMATE_RES_Y; gy++) {
    const lat = latitudeAt(gy, params.equatorOffset) * 90
    const equatorial = Math.max(0, 1 - lat / CLIMATE_TUNING.upwellingEquatorBandDeg)
    for (let gx = 0; gx < CLIMATE_RES_X; gx++) {
      const i = gy * CLIMATE_RES_X + gx
      if (land[i] || upwelling[i] <= 0) continue
      const reach = 1 - equatorial + equatorial * east[i]
      // What is returned is the upwelling that brings cold water, the same
      // share that cools: in the west of an equatorial basin the water comes
      // up warm, and a layer of "upwelling" there would promise cold coasts
      // and fishing grounds that are not there.
      upwelling[i] *= reach
      currentAnomaly[i] -= Math.min(CLIMATE_TUNING.upwellingMaxCoolingC, upwelling[i] * CLIMATE_TUNING.upwellingCoolingC)
    }
  }

  return { months: REFINED_MONTHS, pressure, wind, currents, currentAnomaly, upwelling }
}
