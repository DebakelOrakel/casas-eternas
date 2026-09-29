import { CLIMATE_RES_X, CLIMATE_RES_Y, inTopSummerHalf, isLandAtCell, latitudeAt } from './climateField'
import { CLIMATE_TUNING } from './climateTuneParams'
import { koppenFromMonths, reduceTemperatureToSeaLevel } from './biomes'
import { blur, computePressureWind, REFINED_MONTHS } from './pressure'
import { computeWind } from './wind'
import { seasonalCycle } from './energyBalance'
import { applyPhenomena } from './phenomena'
import { computeReliability, type Reliability } from './reliability'
import { computeStorms, type Storms } from './storms'
import { computeSalinity, spreadToCoasts } from './salinity'
import { computePrecipitation, OCEAN_PRECIP } from './precipitation'
import { OCEAN_AMPLITUDE } from './seasonality'
import { applyOceanSST, basinFlank, computeOceanCurrents, computeSinkInflow, computeUpwelling, eastwardInBasin } from './oceanCurrents'
import { computeTemperature } from './temperature'
import type { WeatherParams } from './weather'
import { DEFAULT_PLANET_FORCING } from '../planet/planetForcing'
import { downsampleBox } from '../core/field'
import { ELEVATION_METERS } from '../elevation/elevationScale'

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
  // The rain's reliability and the ENSO see-saw (reliability.ts).
  reliability: Reliability
  // Cyclones, tornadoes, blizzards, dust, thunder (storms.ts).
  storms: Storms
  // Sea surface salinity (psu, 0 on land) and where the surface water
  // sinks (0..1), salinity.ts.
  salinity: Float32Array
  deepWater: Float32Array
  // Weather phenomena, each a share of the year per cell (phenomena.ts).
  fog: Float32Array
  foehn: Float32Array
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

  // The elevated heat source: a high plateau heated in summer warms the
  // middle of the atmosphere directly, where the air over the plain is only
  // warmed from below, and a low forms over it and its surroundings that
  // the sea-level reduction of its air cannot show (Tibet draws the Asian
  // monsoon in). Per month, hPa: −perKmC × the height over
  // `pressurePlateauFromKm` × the month's departure from the year's mean,
  // smoothed like the thermal part; in winter the sign turns and a high
  // sits there.
  const plateauKm = downsampleBox(elevation, width, height, CLIMATE_RES_X, CLIMATE_RES_Y)
  for (let i = 0; i < n; i++) plateauKm[i] = Math.max(0, plateauKm[i] * ELEVATION_METERS / 1000 - CLIMATE_TUNING.pressurePlateauFromKm)
  const plateauHeat = (month: number): Float32Array => {
    const hpa = new Float32Array(n)
    for (let i = 0; i < n; i++) hpa[i] = -CLIMATE_TUNING.pressurePlateauHpaPerKmC * plateauKm[i] * cycle[month * n + i]
    blur(hpa, CLIMATE_TUNING.pressureSmoothCells)
    return hpa
  }

  // A: pressure and wind for each month, from the month's air reduced to sea
  // level.
  const pressure = new Float32Array(REFINED_MONTHS * n)
  const wind = new Float32Array(REFINED_MONTHS * n * 2)
  const belts = new Float32Array(REFINED_MONTHS)
  for (let month = 0; month < REFINED_MONTHS; month++) {
    const air = monthly.subarray(month * n, (month + 1) * n)
    // The season's shift of the bands, + in the top hemisphere's summer:
    // the rain belt, the wind cells and the pressure bands all move by it
    // (climateField.beltYNorm), the sun's latitude lagged by the sea.
    const belt = CLIMATE_TUNING.monsoonItczSeasonalShift * Math.cos(2 * Math.PI * ((month + 0.5) / REFINED_MONTHS - CLIMATE_TUNING.refineItczPeakYear))
    belts[month] = belt
    const bandWind = computeWind(params.equatorOffset, planet.rotationHours, belt)
    const result = computePressureWind(reduceTemperatureToSeaLevel(air, elevation, width, height), land, elevation, width, height, bandWind, params.equatorOffset, planet.rotationHours, belt, plateauHeat(month))
    pressure.set(result.pressure, month * n)
    wind.set(result.wind, month * n * 2)
    onProgress?.(0.15 + 0.35 * (month + 1) / REFINED_MONTHS)
  }

  // The currents follow the year's mean wind: the ocean answers the wind
  // over months, not within one.
  const annualWind = new Float32Array(n * 2)
  for (let month = 0; month < REFINED_MONTHS; month++) {
    for (let i = 0; i < n * 2; i++) annualWind[i] += wind[month * n * 2 + i] / REFINED_MONTHS
  }
  const windCurrents = computeOceanCurrents(elevation, annualWind, width, height, undefined, params.equatorOffset)

  // The sea-surface anomaly, from the latitudinal base (not from `temperature`,
  // which already carries the history's currents): here on the wind's
  // currents, below on the full ones.
  const base = computeTemperature(elevation, width, height, params.temperatureOffset, params.temperatureContrast, params.equatorOffset, undefined, planet)
  const windAnomaly = applyOceanSST(base.slice(), windCurrents, elevation, width, height)

  // Upwelling cools the sea where it comes up. The cold eastern coasts are
  // mostly this, not the slow currents along them.
  // Near the equator only the eastern part of a basin cools (see
  // eastwardInBasin); off the equator the coast's own upwelling counts in
  // full. The blend runs over `upwellingEquatorBandDeg`.
  const upwelling = computeUpwelling(annualWind, land, params.equatorOffset, planet.rotationHours)
  const east = eastwardInBasin(land)
  const upwellingCooling = new Float32Array(n)
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
      upwellingCooling[i] = Math.min(CLIMATE_TUNING.upwellingMaxCoolingC, upwelling[i] * CLIMATE_TUNING.upwellingCoolingC)
    }
  }

  // The ocean highs: the subtropical highs are not a band but cells over
  // the oceans, their centres in the east of each basin (over the cold
  // currents and the upwelling), so the air sinks off the west coasts and
  // the western flank carries moist air to the east coasts. Set by the
  // cell's place across its basin (basinFlank), not computed. The months'
  // pressure and wind are computed again with them (the currents keep the
  // first wind); the rain reads them too (computePrecipitation).
  const seaAnomaly = new Float32Array(n)
  const oceanHigh = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    if (land[i]) continue
    seaAnomaly[i] = windAnomaly[i] - upwellingCooling[i]
  }
  const flank = basinFlank(land, CLIMATE_TUNING.oceanHighBasinCells)
  for (let gy = 0; gy < CLIMATE_RES_Y; gy++) {
    const lat = latitudeAt(gy, params.equatorOffset) * 90
    const t = (lat - CLIMATE_TUNING.oceanHighFromDeg) / (CLIMATE_TUNING.oceanHighToDeg - CLIMATE_TUNING.oceanHighFromDeg)
    if (t <= 0 || t >= 1) continue
    const bump = Math.sin(Math.PI * t)
    for (let gx = 0; gx < CLIMATE_RES_X; gx++) {
      const i = gy * CLIMATE_RES_X + gx
      if (!land[i]) oceanHigh[i] += CLIMATE_TUNING.oceanHighFlankHpa * flank[i] * bump
    }
  }
  // Smoothed as a mean over the sea only (the sea's share smoothed the same
  // way divides it out), so a coast takes the value of the sea before it
  // rather than one thinned by the land's zeros; beyond the smoothing's
  // reach inland there is no high.
  const seaShare = new Float32Array(n)
  for (let i = 0; i < n; i++) seaShare[i] = land[i] ? 0 : 1
  blur(oceanHigh, CLIMATE_TUNING.oceanHighSmoothCells)
  blur(seaShare, CLIMATE_TUNING.oceanHighSmoothCells)
  for (let i = 0; i < n; i++) oceanHigh[i] = seaShare[i] > CLIMATE_TUNING.oceanHighMinSeaShare ? oceanHigh[i] / seaShare[i] : 0
  for (let month = 0; month < REFINED_MONTHS; month++) {
    const air = monthly.subarray(month * n, (month + 1) * n)
    const bandWind = computeWind(params.equatorOffset, planet.rotationHours, belts[month])
    const extra = plateauHeat(month)
    for (let i = 0; i < n; i++) extra[i] += oceanHigh[i]
    const result = computePressureWind(reduceTemperatureToSeaLevel(air, elevation, width, height), land, elevation, width, height, bandWind, params.equatorOffset, planet.rotationHours, belts[month], extra)
    pressure.set(result.pressure, month * n)
    wind.set(result.wind, month * n * 2)
  }

  // B's second half: the month's rain, from that wind and that air, with the
  // equatorial rain belt following the sun. The sea evaporates at its own
  // surface: the base, the wind's currents, the upwelling and the month's
  // cycle (the overturning's warmth, which needs the rain for the salt, is
  // left out), and its anomaly goes with the air (computePrecipitation).
  const precipitation = new Float32Array(REFINED_MONTHS * n)
  const seaTemperature = new Float32Array(n)
  for (let month = 0; month < REFINED_MONTHS; month++) {
    for (let i = 0; i < n; i++) if (!land[i]) seaTemperature[i] = base[i] + windAnomaly[i] - upwellingCooling[i] + cycle[month * n + i]
    const air = monthly.subarray(month * n, (month + 1) * n)
    const monthWind = wind.subarray(month * n * 2, (month + 1) * n * 2)
    precipitation.set(computePrecipitation(elevation, air, monthWind, width, height, params.humidity, params.equatorOffset, undefined, belts[month], { seaTemperature, seaAnomaly, highHpa: oceanHigh }), month * n)
    onProgress?.(0.5 + 0.4 * (month + 1) / REFINED_MONTHS)
  }

  // 9: the sea's salt and where it sinks, then the surface water that
  // sinking draws after it (computeSinkInflow) added to the wind's currents,
  // then the salt again on those — once round: the inflow moves the salty
  // water that sinks, and one more pass settles where it does.
  const landRain = new Float32Array(n)
  for (let month = 0; month < REFINED_MONTHS; month++) for (let i = 0; i < n; i++) landRain[i] += precipitation[month * n + i] / REFINED_MONTHS
  const first = computeSalinity(temperature, landRain, windCurrents, land, params.equatorOffset, params.humidity)
  const inflow = computeSinkInflow(first.deepWater, land)
  const currents = new Float32Array(n * 2)
  let fastest = 0
  for (let k = 0; k < n * 2; k++) currents[k] = windCurrents[k] + CLIMATE_TUNING.conveyorFlow * inflow[k]
  for (let i = 0; i < n; i++) fastest = Math.max(fastest, Math.hypot(currents[i * 2], currents[i * 2 + 1]))
  // Normalised like the wind's (the fastest is 1), which the sea's transport
  // and the currents layer read.
  if (fastest > 1) for (let k = 0; k < n * 2; k++) currents[k] /= fastest
  const { salinity, deepWater } = computeSalinity(temperature, landRain, currents, land, params.equatorOffset, params.humidity)

  // The anomaly on the full currents; its difference to the wind's alone is
  // the overturning's warmth.
  const currentAnomaly = applyOceanSST(base.slice(), currents, elevation, width, height)
  const drift = new Float32Array(n)
  for (let i = 0; i < n; i++) if (!land[i]) drift[i] = currentAnomaly[i] - windAnomaly[i]
  // The months take it, on the sea and on the coasts beside it.
  const warmth = spreadToCoasts(drift, land)
  for (let month = 0; month < REFINED_MONTHS; month++) for (let i = 0; i < n; i++) monthly[month * n + i] += warmth[i]
  for (let i = 0; i < n; i++) currentAnomaly[i] -= upwellingCooling[i]

  // C1: fog and föhn, which change the months they happen in (so after the
  // sea, and before the classes).
  const { fog, foehn } = applyPhenomena(monthly, REFINED_MONTHS, wind, currentAnomaly, land, elevation, width, height)

  const koppen = koppenFromMonths(monthly, precipitation, REFINED_MONTHS)
  const refined = { months: REFINED_MONTHS, temperature: monthly, precipitation, koppen, fog, foehn, salinity, deepWater, pressure, wind, currents, currentAnomaly, upwelling }

  // 7: the rain's reliability, from the year the months make.
  const annual = annualFromMonths(refined)
  const reliability = computeReliability(annual.precipitation, annual.monsoonIndex, currentAnomaly, land, params.equatorOffset)
  // 8: the storms of those months.
  const storms = computeStorms(monthly, precipitation, REFINED_MONTHS, wind, land, elevation, width, height, params.equatorOffset)
  return { ...refined, reliability, storms }
}

// The annual fields of a refinement, in the forms the history's climate
// has them (weather.computeWeather), so everything that reads a climate
// reads this one unchanged: the mean temperature; the mean rain (a mean of
// rates), OCEAN_PRECIP on the sea; the seasonal range (warmest month minus
// coldest), OCEAN_AMPLITUDE on the sea; the signed monsoon index from the
// two halves of the year, (P_top − P_bottom) / (P_top + P_bottom + floor)
// with each half as its own annual rate, + where the rain falls in the top
// hemisphere's summer half (climateField.inTopSummerHalf), OCEAN_PRECIP on
// the sea.
export function annualFromMonths(r: Pick<RefinedClimate, 'months' | 'temperature' | 'precipitation'>): { temperature: Float32Array; precipitation: Float32Array; seasonalAmplitude: Float32Array; monsoonIndex: Float32Array } {
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
      const summerTop = inTopSummerHalf(m)
      if (summerTop) top += (2 * p) / r.months
      else bottom += (2 * p) / r.months
    }
    precipitation[i] = (top + bottom) / 2
    seasonalAmplitude[i] = hi - lo
    monsoonIndex[i] = (top - bottom) / (top + bottom + CLIMATE_TUNING.monsoonSeasonalityFloor)
  }
  return { temperature, precipitation, seasonalAmplitude, monsoonIndex }
}
