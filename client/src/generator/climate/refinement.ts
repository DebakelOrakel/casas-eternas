import { CLIMATE_RES_X, CLIMATE_RES_Y, isLandAtCell, latitudeAt } from './climateField'
import { CLIMATE_TUNING } from './climateTuneParams'
import { koppenFromMonths, reduceTemperatureToSeaLevel } from './biomes'
import { computePressureWind, REFINED_MONTHS } from './pressure'
import { seasonalCycle } from './energyBalance'
import { computePrecipitation, OCEAN_PRECIP } from './precipitation'
import { OCEAN_AMPLITUDE } from './seasonality'
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
  // Air temperature, °C, months × cells: the annual mean of the climate
  // the step shows plus the energy balance's cycle (energyBalance.ts).
  temperature: Float32Array
  // Precipitation, mm/yr at the month's rate, months × cells; OCEAN_PRECIP
  // on the sea. The year's total is their mean.
  precipitation: Float32Array
  // The Köppen–Geiger class per cell from these months (koppen.ts), 0 on
  // the sea.
  koppen: Uint8Array
  // Ekman upwelling per ocean cell (computeUpwelling), 0 on land, the rising
  // part weighted like the cooling: near the equator by the cell's place in
  // its basin (only the east brings cold water up).
  upwelling: Float32Array
}

// `temperature` and `baseWind` are the climate the step shows (climate/weather.computeWeather on the same terrain), `params` the
// levers it was computed with.
// `onProgress` hears the share done, 0..1, a few times a run.
export function refineClimate(
  elevation: Float32Array, width: number, height: number, params: WeatherParams,
  temperature: Float32Array, baseWind: Float32Array, onProgress?: (share: number) => void,
): RefinedClimate {
  const n = CLIMATE_RES_X * CLIMATE_RES_Y
  const planet = params.planet ?? DEFAULT_PLANET_FORCING
  const land = new Uint8Array(n)
  for (let gy = 0; gy < CLIMATE_RES_Y; gy++) {
    for (let gx = 0; gx < CLIMATE_RES_X; gx++) land[gy * CLIMATE_RES_X + gx] = isLandAtCell(elevation, undefined, gx, gy, width, height) ? 1 : 0
  }

  // B: the year's temperature cycle around the annual mean (the banded wind
  // carries it: the pressure wind needs these temperatures first).
  const cycle = seasonalCycle(land, temperature, baseWind, planet, params.equatorOffset, REFINED_MONTHS)
  const monthly = new Float32Array(REFINED_MONTHS * n)
  for (let month = 0; month < REFINED_MONTHS; month++) {
    for (let i = 0; i < n; i++) monthly[month * n + i] = temperature[i] + cycle[month * n + i]
  }
  onProgress?.(0.15)

  // A: pressure and wind for each month, from the month's air reduced to sea
  // level. Then B's second half: the month's rain, from that wind and that
  // air, with the equatorial rain belt following the sun.
  const pressure = new Float32Array(REFINED_MONTHS * n)
  const wind = new Float32Array(REFINED_MONTHS * n * 2)
  const precipitation = new Float32Array(REFINED_MONTHS * n)
  for (let month = 0; month < REFINED_MONTHS; month++) {
    const air = monthly.subarray(month * n, (month + 1) * n)
    const result = computePressureWind(reduceTemperatureToSeaLevel(air, elevation, width, height), land, elevation, width, height, baseWind, params.equatorOffset, planet.rotationHours)
    pressure.set(result.pressure, month * n)
    wind.set(result.wind, month * n * 2)
    // + in the top hemisphere's summer: the belt moves up.
    const belt = CLIMATE_TUNING.monsoonItczSeasonalShift * Math.cos(2 * Math.PI * ((month + 0.5) / REFINED_MONTHS - CLIMATE_TUNING.refineItczPeakYear))
    precipitation.set(computePrecipitation(elevation, air, result.wind, width, height, params.humidity, params.equatorOffset, undefined, belt), month * n)
    onProgress?.(0.15 + 0.75 * (month + 1) / REFINED_MONTHS)
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

  const koppen = koppenFromMonths(monthly, precipitation, REFINED_MONTHS)
  return { months: REFINED_MONTHS, temperature: monthly, precipitation, koppen, pressure, wind, currents, currentAnomaly, upwelling }
}

// The annual fields of a refinement, in the forms the history's climate
// has them (weather.computeWeather), so everything that reads a climate
// reads this one unchanged: the mean temperature; the mean rain (a mean of
// rates), OCEAN_PRECIP on the sea; the seasonal range (warmest month minus
// coldest), OCEAN_AMPLITUDE on the sea; the signed monsoon index from the
// two halves of the year, (P_top − P_bottom) / (P_top + P_bottom + floor)
// with each half as its own annual rate, + where the rain falls in the top
// hemisphere's summer (April–September), OCEAN_PRECIP on the sea.
export function annualFromMonths(r: RefinedClimate): { temperature: Float32Array; precipitation: Float32Array; seasonalAmplitude: Float32Array; monsoonIndex: Float32Array } {
  const n = CLIMATE_RES_X * CLIMATE_RES_Y
  const temperature = new Float32Array(n)
  const precipitation = new Float32Array(n)
  const seasonalAmplitude = new Float32Array(n)
  const monsoonIndex = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let mean = 0
    let lo = Infinity
    let hi = -Infinity
    for (let m = 0; m < r.months; m++) {
      const t = r.temperature[m * n + i]
      mean += t / r.months
      lo = Math.min(lo, t)
      hi = Math.max(hi, t)
    }
    temperature[i] = mean
    if (r.precipitation[i] < 0) {
      precipitation[i] = OCEAN_PRECIP
      seasonalAmplitude[i] = OCEAN_AMPLITUDE
      monsoonIndex[i] = OCEAN_PRECIP
      continue
    }
    let top = 0
    let bottom = 0
    for (let m = 0; m < r.months; m++) {
      const p = r.precipitation[m * n + i]
      const summerTop = m >= 3 && m < 9
      if (summerTop) top += (2 * p) / r.months
      else bottom += (2 * p) / r.months
    }
    precipitation[i] = (top + bottom) / 2
    seasonalAmplitude[i] = hi - lo
    monsoonIndex[i] = (top - bottom) / (top + bottom + CLIMATE_TUNING.monsoonSeasonalityFloor)
  }
  return { temperature, precipitation, seasonalAmplitude, monsoonIndex }
}
