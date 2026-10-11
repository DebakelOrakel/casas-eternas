import { CLIMATE_RES_X, CLIMATE_RES_Y, inTopSummerHalf, latitudeOfNorm, shiftedNorm } from './climateField'
import { CLIMATE_TUNING } from './climateTuneParams'
import { koppenFromMonths } from './biomes'
import { computePressureWind, REFINED_MONTHS } from './pressure'
import { computeWind, type CellVectors } from './wind'
import { seasonalCycle } from './energyBalance'
import { applyPhenomena } from './phenomena'
import { computeReliability } from './reliability'
import { computeStorms } from './storms'
import { computeSalinity } from './salinity'
import { computePrecipitation, OCEAN_PRECIP } from './precipitation'
import { OCEAN_AMPLITUDE } from './seasonality'
import { applyOceanSST, carryInland, computeOceanCurrents, computeSinkInflow, computeUpwelling } from './oceanCurrents'
import { computeTemperature } from './temperature'
import type { WeatherParams } from './weather'
import { DEFAULT_PLANET_FORCING } from '../planet/planetForcing'
import type { Domain } from '../core/domain'
import { basinRows, climateLandOnlyRaster, climateLandRaster, climateMesh, climateRaster, climateSeaRaster, climateSeaVectorRaster, climateTerrain, climateVectorRaster, rasterLand, type ClimateTerrain } from './climateMesh'
import { smoothGaussian, type SolveReport } from '../fields/fieldOperators'
import { ELEVATION_METERS, SEA_LEVEL } from '../elevation/elevationScale'
import { detCos, detHypot, detSin } from '../core/detMath'

// THE CLIMATE STEP'S REFINEMENT (docs/design/climate-refinement.md): the
// climate the history left, computed again with more physics on the final
// geography. One call, in its load-bearing order; each build step adds its
// part here. The history's epochs never call it.
//
// ON THE CLIMATE'S FIELD MESH (DEC-0036 phase 5): every part — the year's
// cycle, the pressure and its wind, the ocean, the rain, the phenomena,
// the reliability and the storms — runs per cell of the one mesh the
// static climate runs on (climateMesh.ts), both shapes, one path, the
// lengths in metres. No raster, no pole row. The screen's textures, the
// biomes and the ecology read it through refinedRasters below until their
// own phase (7).

// The storms' fields, in the order the save writes them.
export const REFINED_STORMS = ['cyclone', 'tornado', 'blizzard', 'dust', 'thunder'] as const
export type RefinedStorms = Record<(typeof REFINED_STORMS)[number], Float32Array>

export interface RefinedReliability {
  rainVariability: Float32Array
  ensoPattern: Float32Array
  ensoPeriodYears: number
  ensoStrength: number
}

// The refinement per cell of the climate's field mesh. Float32: the values
// the session keeps ARE the values the save writes (world/save/
// refinedFields.ts), so a loaded refinement is the session's to the bit and
// is adopted without computing it again. Vectors are east/south in each
// cell's own frame (the Domain's). The sea's fields are 0 on the mesh's
// land cells (ClimateTerrain.land), the land's fields 0 on its sea.
export interface RefinedClimate {
  months: number
  // The field mesh the values belong to: its cell count and its spacing,
  // metres (climateMesh: the domain's width / 256) — what a restore checks.
  cells: number
  spacingM: number
  // Air temperature, °C, months × cells (month-major), the year's mean plus
  // the energy balance's cycle (energyBalance.ts), the overturning's warmth
  // and the phenomena.
  temperature: Float32Array
  // Precipitation, mm/yr at the month's rate, months × cells; OCEAN_PRECIP
  // on the sea. The year's total is their mean.
  precipitation: Float32Array
  // Sea-level pressure, hPa, months × cells.
  pressure: Float32Array
  // Surface wind, wind.ts's units (1 = 8 m/s), months × cells, east and
  // south.
  windE: Float32Array
  windS: Float32Array
  // The ocean currents under the year's mean wind (with the overturning's
  // inflow), normalised like computeOceanCurrents', east and south.
  currentE: Float32Array
  currentS: Float32Array
  // The sea-surface anomaly those currents and the upwelling make, °C per
  // sea cell (positive warm, negative cold).
  currentAnomaly: Float32Array
  // Ekman upwelling per sea cell (computeUpwelling), the rising part
  // weighted like the cooling: near the equator by the cell's place in its
  // basin (only the east brings cold water up).
  upwelling: Float32Array
  // Sea surface salinity (psu) and where the surface water sinks (0..1),
  // salinity.ts.
  salinity: Float32Array
  deepWater: Float32Array
  // Weather phenomena, each a share of the year per land cell
  // (phenomena.ts).
  fog: Float32Array
  foehn: Float32Array
  // The rain's reliability and the ENSO see-saw (reliability.ts).
  reliability: RefinedReliability
  // Cyclones, tornadoes, blizzards, dust, thunder (storms.ts).
  storms: RefinedStorms
  // The ocean's solves (DEC-0036 phase 4): the wind's currents, the
  // overturning's inflow, the year's two harmonics. A diagnostic: a
  // refinement read back from a save has none.
  solves?: { currents: SolveReport; inflow: SolveReport; cycle: SolveReport[] }
}

// Whether a refinement's values belong to the climate's field mesh of
// this domain (a restore's check, as mantleFits and oceanAgeFits).
export function refinementFits(domain: Domain, cells: number, spacingM: number): boolean {
  const cm = climateMesh(domain)
  return cells === cm.mesh.count && spacingM === cm.cellM
}

// `temperature` and `baseWind` are the climate the step shows per cell of
// the climate's field mesh (climate/weather.computeWeather on the same
// terrain: WeatherMesh.temperature, .wind), `params` the levers it was
// computed with. `onProgress` hears the share done, 0..1, a few times a
// run. `domain`: what the elevation raster covers, one cell per unit.
export function refineClimate(
  elevation: Float32Array, domain: Domain, params: WeatherParams,
  temperature: ArrayLike<number>, baseWind: CellVectors, onProgress?: (share: number) => void,
): RefinedClimate {
  const { width, height } = domain
  const planet = params.planet ?? DEFAULT_PLANET_FORCING
  const terrain = climateTerrain(domain, elevation, width, height)
  const { cm, land } = terrain
  const n = cm.mesh.count
  const months = REFINED_MONTHS
  const latDeg = new Float64Array(n)
  for (let i = 0; i < n; i++) latDeg[i] = latitudeOfNorm(shiftedNorm(cm.yNorm[i], params.equatorOffset)) * 90
  // The month's air reduced to sea level (the pressure is sea-level
  // pressure): the lapse of the ground under each cell's centre given back
  // (biomes.reduceTemperatureToSeaLevel's rule).
  const seaLevelAir = (air: ArrayLike<number>): Float64Array => {
    const out = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const e = terrain.z[i]
      out[i] = air[i] + CLIMATE_TUNING.lapseCPerElevation * (terrain.dry[i] ? e - SEA_LEVEL : Math.max(0, e - SEA_LEVEL))
    }
    return out
  }

  // B: the year's temperature cycle around the annual mean (the banded wind
  // carries it: the pressure wind needs these temperatures first).
  const annual = Float64Array.from(temperature)
  const { cycle, solves: cycleSolves } = seasonalCycle(terrain, annual, baseWind, planet, params.equatorOffset, months)
  const monthly = new Float64Array(months * n)
  for (let m = 0; m < months; m++) {
    for (let i = 0; i < n; i++) monthly[m * n + i] = annual[i] + cycle[m * n + i]
  }
  const monthOf = (field: Float64Array, m: number): Float64Array => field.subarray(m * n, (m + 1) * n)
  onProgress?.(0.15)

  // The elevated heat source: a high plateau heated in summer warms the
  // middle of the atmosphere directly, where the air over the plain is only
  // warmed from below, and a low forms over it and its surroundings that
  // the sea-level reduction of its air cannot show (Tibet draws the Asian
  // monsoon in). Per month, hPa: −perKmC × the height over
  // `pressurePlateauFromKm` × the month's departure from the year's mean,
  // smoothed like the thermal part; in winter the sign turns and a high
  // sits there. The height is the mean ground over each cell.
  const meanZ = terrain.meanElevation()
  const plateauKm = new Float64Array(n)
  for (let i = 0; i < n; i++) plateauKm[i] = Math.max(0, meanZ[i] * ELEVATION_METERS / 1000 - CLIMATE_TUNING.pressurePlateauFromKm)
  const plateauHeat = (m: number): Float64Array => {
    const hpa = new Float64Array(n)
    for (let i = 0; i < n; i++) hpa[i] = -CLIMATE_TUNING.pressurePlateauHpaPerKmC * plateauKm[i] * cycle[m * n + i]
    return smoothGaussian(cm.mesh, hpa, CLIMATE_TUNING.pressureSmoothSigmaM, hpa)
  }

  // A: pressure and wind for each month, from the month's air reduced to sea
  // level. This first pass gives the year's mean wind the currents follow.
  const belts = new Float64Array(months)
  const annualWind: CellVectors = { e: new Float64Array(n), s: new Float64Array(n) }
  for (let m = 0; m < months; m++) {
    // The season's shift of the bands, + in the top hemisphere's summer:
    // the rain belt, the wind cells and the pressure bands all move by it
    // (climateField.beltYNorm), the sun's latitude lagged by the sea.
    const belt = CLIMATE_TUNING.monsoonItczSeasonalShift * detCos(2 * Math.PI * ((m + 0.5) / months - CLIMATE_TUNING.refineItczPeakYear))
    belts[m] = belt
    const bandWind = computeWind(cm, params.equatorOffset, planet.rotationHours, belt)
    const result = computePressureWind(terrain, seaLevelAir(monthOf(monthly, m)), bandWind, params.equatorOffset, planet.rotationHours, belt, plateauHeat(m))
    for (let i = 0; i < n; i++) {
      annualWind.e[i] += result.wind.e[i] / months
      annualWind.s[i] += result.wind.s[i] / months
    }
    onProgress?.(0.15 + 0.35 * (m + 1) / months)
  }

  // The currents follow the year's mean wind: the ocean answers the wind
  // over months, not within one.
  const windCurrents = computeOceanCurrents(terrain, annualWind, params.equatorOffset)

  // The sea-surface anomaly, from the latitudinal base (not from
  // `temperature`, which already carries the history's currents): here on
  // the wind's currents, below on the full ones. 0 on land.
  const base = computeTemperature(terrain, params.temperatureOffset, params.temperatureContrast, params.equatorOffset, planet)
  const windAnomaly = applyOceanSST(terrain, base.slice(), windCurrents, annualWind)

  // Upwelling cools the sea where it comes up. The cold eastern coasts are
  // mostly this, not the slow currents along them. Near the equator only
  // the eastern part of a basin cools (the thermocline tilts with the trade
  // winds — deep under the warm pool in the west, shallow in the east: the
  // equatorial cold tongue), by the cell's place along its parallel's sea
  // (climateMesh.basinRows); off the equator the coast's own upwelling
  // counts in full. The blend runs over `upwellingEquatorBandDeg`.
  const upwelling = computeUpwelling(terrain, annualWind, params.equatorOffset, planet.rotationHours)
  const rows = basinRows(terrain)
  const cooling = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    if (land[i] || upwelling[i] <= 0) continue
    const equatorial = Math.max(0, 1 - latDeg[i] / CLIMATE_TUNING.upwellingEquatorBandDeg)
    const reach = 1 - equatorial + equatorial * rows.eastward[i]
    // What is returned is the upwelling that brings cold water, the same
    // share that cools: in the west of an equatorial basin the water comes
    // up warm, and a layer of "upwelling" there would promise cold coasts
    // and fishing grounds that are not there.
    upwelling[i] *= reach
    cooling[i] = Math.min(CLIMATE_TUNING.upwellingMaxCoolingC, upwelling[i] * CLIMATE_TUNING.upwellingCoolingC)
  }

  // The ocean highs: the subtropical highs are not a band but cells over
  // the oceans, their centres in the east of each basin (over the cold
  // currents and the upwelling), so the air sinks off the west coasts and
  // the western flank carries moist air to the east coasts. Set by the
  // cell's place across its basin along its parallel, −1 at the western
  // shore … +1 at the eastern, scaled down in a basin narrower than
  // `oceanHighBasinM` (a sea between two coasts close together has no east
  // and west of its own), not computed. The months' pressure and wind are
  // computed again with them (the currents keep the first wind); the rain
  // reads them too (computePrecipitation).
  const seaAnomaly = new Float64Array(n)
  const oceanHigh = new Float64Array(n)
  const seaShare = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    if (land[i]) continue
    seaAnomaly[i] = windAnomaly[i] - cooling[i]
    seaShare[i] = 1
    const t = (latDeg[i] - CLIMATE_TUNING.oceanHighFromDeg) / (CLIMATE_TUNING.oceanHighToDeg - CLIMATE_TUNING.oceanHighFromDeg)
    if (t <= 0 || t >= 1 || rows.runPoints[i] < 2) continue
    const flank = (2 * rows.eastward[i] - 1) * Math.min(1, rows.runM[i] / CLIMATE_TUNING.oceanHighBasinM)
    oceanHigh[i] = CLIMATE_TUNING.oceanHighFlankHpa * flank * detSin(Math.PI * t)
  }
  // Smoothed as a mean over the sea only (the sea's share smoothed the same
  // way divides it out), so a coast takes the value of the sea before it
  // rather than one thinned by the land's zeros; beyond the smoothing's
  // reach inland there is no high.
  smoothGaussian(cm.mesh, oceanHigh, CLIMATE_TUNING.oceanHighSmoothSigmaM, oceanHigh)
  smoothGaussian(cm.mesh, seaShare, CLIMATE_TUNING.oceanHighSmoothSigmaM, seaShare)
  for (let i = 0; i < n; i++) oceanHigh[i] = seaShare[i] > CLIMATE_TUNING.oceanHighMinSeaShare ? oceanHigh[i] / seaShare[i] : 0

  const pressure = new Float64Array(months * n)
  const winds: CellVectors[] = []
  for (let m = 0; m < months; m++) {
    const bandWind = computeWind(cm, params.equatorOffset, planet.rotationHours, belts[m])
    const extra = plateauHeat(m)
    for (let i = 0; i < n; i++) extra[i] += oceanHigh[i]
    const result = computePressureWind(terrain, seaLevelAir(monthOf(monthly, m)), bandWind, params.equatorOffset, planet.rotationHours, belts[m], extra)
    pressure.set(result.pressure, m * n)
    winds[m] = result.wind
  }

  // B's second half: the month's rain, from that wind and that air, with the
  // equatorial rain belt following the sun. The sea evaporates at its own
  // surface: the base, the wind's currents, the upwelling and the month's
  // cycle (the overturning's warmth, which needs the rain for the salt, is
  // left out), and its anomaly goes with the air (computePrecipitation).
  const precipitation = new Float64Array(months * n)
  const seaTemperature = new Float64Array(n)
  // The year's rain on the land (the salt's rivers, below).
  const landRain = new Float64Array(n)
  for (let m = 0; m < months; m++) {
    for (let i = 0; i < n; i++) seaTemperature[i] = base[i] + seaAnomaly[i] + cycle[m * n + i]
    const rain = computePrecipitation(terrain, monthOf(monthly, m), winds[m], params.humidity, params.equatorOffset, belts[m], { seaTemperature, seaAnomaly, highHpa: oceanHigh })
    precipitation.set(rain, m * n)
    for (let i = 0; i < n; i++) if (land[i]) landRain[i] += rain[i] / months
    onProgress?.(0.5 + 0.4 * (m + 1) / months)
  }

  // 9: the sea's salt and where it sinks, then the surface water that
  // sinking draws after it (computeSinkInflow) added to the wind's currents,
  // then the salt again on those — once round: the inflow moves the salty
  // water that sinks, and one more pass settles where it does.
  const first = computeSalinity(terrain, annual, landRain, windCurrents, params.equatorOffset, params.humidity)
  const inflow = computeSinkInflow(terrain, first.deepWater)
  const currents: CellVectors = { e: new Float64Array(n), s: new Float64Array(n) }
  let fastest = 0
  for (let i = 0; i < n; i++) {
    currents.e[i] = windCurrents.e[i] + CLIMATE_TUNING.conveyorFlow * inflow.e[i]
    currents.s[i] = windCurrents.s[i] + CLIMATE_TUNING.conveyorFlow * inflow.s[i]
    fastest = Math.max(fastest, detHypot(currents.e[i], currents.s[i]))
  }
  // Normalised like the wind's (the fastest is 1), which the sea's transport
  // and the currents layer read.
  if (fastest > 1) {
    for (let i = 0; i < n; i++) {
      currents.e[i] /= fastest
      currents.s[i] /= fastest
    }
  }
  const salt = computeSalinity(terrain, annual, landRain, currents, params.equatorOffset, params.humidity)

  // The anomaly on the full currents; its difference to the wind's alone is
  // the overturning's warmth. The months take it, on the sea and on the
  // land the wind carries it to (oceanCurrents.carryInland, as the
  // currents' own anomaly goes).
  const anomaly = applyOceanSST(terrain, base.slice(), currents, annualWind)
  const drift = new Float64Array(n)
  for (let i = 0; i < n; i++) if (!land[i]) drift[i] = anomaly[i] - windAnomaly[i]
  const inland = carryInland(terrain, drift, annualWind)
  for (let i = 0; i < n; i++) {
    const warmth = land[i] ? CLIMATE_TUNING.currentsCoastalFactor * inland[i] : drift[i]
    for (let m = 0; m < months; m++) monthly[m * n + i] += warmth
  }
  const currentAnomaly = new Float64Array(n)
  for (let i = 0; i < n; i++) if (!land[i]) currentAnomaly[i] = anomaly[i] - cooling[i]

  // C1: fog and föhn, which change the months they happen in (so after the
  // sea, and before the classes).
  const { fog, foehn } = applyPhenomena(terrain, monthly, months, winds, currentAnomaly)

  // 7: the rain's reliability, from the year the months make.
  const year = annualFromMonths({ months, temperature: monthly, precipitation }, n)
  const reliability = computeReliability(terrain, rows, year.precipitation, year.monsoonIndex, currentAnomaly, params.equatorOffset)
  // 8: the storms of those months.
  const storms = computeStorms(terrain, monthly, precipitation, months, winds, params.equatorOffset)

  const f32 = (field: ArrayLike<number>): Float32Array => Float32Array.from(field)
  const windE = new Float32Array(months * n)
  const windS = new Float32Array(months * n)
  for (let m = 0; m < months; m++) {
    windE.set(winds[m].e, m * n)
    windS.set(winds[m].s, m * n)
  }
  return {
    months,
    cells: n,
    spacingM: cm.cellM,
    temperature: f32(monthly),
    precipitation: f32(precipitation),
    pressure: f32(pressure),
    windE,
    windS,
    currentE: f32(currents.e),
    currentS: f32(currents.s),
    currentAnomaly: f32(currentAnomaly),
    upwelling: f32(upwelling),
    salinity: f32(salt.salinity),
    deepWater: f32(salt.deepWater),
    fog: f32(fog),
    foehn: f32(foehn),
    reliability: {
      rainVariability: f32(reliability.rainVariability),
      ensoPattern: f32(reliability.ensoPattern),
      ensoPeriodYears: reliability.ensoPeriodYears,
      ensoStrength: reliability.ensoStrength,
    },
    storms: {
      cyclone: f32(storms.cyclone),
      tornado: f32(storms.tornado),
      blizzard: f32(storms.blizzard),
      dust: f32(storms.dust),
      thunder: f32(storms.thunder),
    },
    solves: { currents: windCurrents.solve, inflow: inflow.solve, cycle: cycleSolves },
  }
}

// The year's mean wind of a refinement per cell, east and south.
export function refinedAnnualWind(r: RefinedClimate): CellVectors {
  const n = r.cells
  const out: CellVectors = { e: new Float64Array(n), s: new Float64Array(n) }
  for (let m = 0; m < r.months; m++) {
    for (let i = 0; i < n; i++) {
      out.e[i] += r.windE[m * n + i] / r.months
      out.s[i] += r.windS[m * n + i] / r.months
    }
  }
  return out
}

// ------------------------------------------------ DEC-0036 transition

// DEC-0036 transition: removed in phase 7. The refinement on the climate
// raster (CLIMATE_RES_X × CLIMATE_RES_Y), in the forms its readers there
// take — the biomes, the ecology and the hydrology's climate (runtime.ts
// handleClimateRefine) and the screen's textures, readouts and month
// player: the months' fields per pixel (month-major), the vectors
// interleaved [east, south] in each pixel's own frame, the sea's fields 0
// on the raster's land (climateMesh.rasterLand), the land's on its sea,
// the rain's sea OCEAN_PRECIP; the Köppen class per pixel from the
// rasterised months. Made once per refinement, in the worker.
export interface RefinedClimateRasters {
  months: number
  temperature: Float32Array
  precipitation: Float32Array
  pressure: Float32Array
  wind: Float32Array
  currents: Float32Array
  currentAnomaly: Float32Array
  upwelling: Float32Array
  koppen: Uint8Array
  salinity: Float32Array
  deepWater: Float32Array
  fog: Float32Array
  foehn: Float32Array
  reliability: RefinedReliability
  storms: RefinedStorms
}

export function refinedRasters(r: RefinedClimate, terrain: ClimateTerrain): RefinedClimateRasters {
  const { cm } = terrain
  const RX = CLIMATE_RES_X
  const RY = CLIMATE_RES_Y
  const px = RX * RY
  const n = r.cells
  const months = r.months
  const landPixels = rasterLand(terrain, RX, RY)
  const temperature = new Float32Array(months * px)
  const precipitation = new Float32Array(months * px)
  const pressure = new Float32Array(months * px)
  const wind = new Float32Array(months * px * 2)
  for (let m = 0; m < months; m++) {
    const at = (field: Float32Array): Float32Array => field.subarray(m * n, (m + 1) * n)
    temperature.set(climateRaster(cm, at(r.temperature), RX, RY), m * px)
    precipitation.set(climateLandRaster(terrain, at(r.precipitation), OCEAN_PRECIP, RX, RY, landPixels), m * px)
    pressure.set(climateRaster(cm, at(r.pressure), RX, RY), m * px)
    wind.set(climateVectorRaster(cm, at(r.windE), at(r.windS), RX, RY), m * px * 2)
  }
  const sea = (field: Float32Array): Float32Array => climateSeaRaster(cm, field, RX, RY, landPixels)
  const landOnly = (field: Float32Array): Float32Array => climateLandOnlyRaster(terrain, field, RX, RY, landPixels)
  const both = (field: Float32Array): Float32Array => climateRaster(cm, field, RX, RY)
  return {
    months,
    temperature,
    precipitation,
    pressure,
    wind,
    currents: climateSeaVectorRaster(cm, r.currentE, r.currentS, RX, RY, landPixels),
    currentAnomaly: sea(r.currentAnomaly),
    upwelling: sea(r.upwelling),
    koppen: koppenFromMonths(temperature, precipitation, months),
    salinity: sea(r.salinity),
    deepWater: sea(r.deepWater),
    fog: landOnly(r.fog),
    foehn: landOnly(r.foehn),
    reliability: {
      rainVariability: landOnly(r.reliability.rainVariability),
      ensoPattern: landOnly(r.reliability.ensoPattern),
      ensoPeriodYears: r.reliability.ensoPeriodYears,
      ensoStrength: r.reliability.ensoStrength,
    },
    storms: {
      cyclone: both(r.storms.cyclone),
      tornado: landOnly(r.storms.tornado),
      blizzard: landOnly(r.storms.blizzard),
      dust: both(r.storms.dust),
      thunder: both(r.storms.thunder),
    },
  }
}

// The annual fields of a refinement, in the forms the history's climate
// has them (weather.computeWeather), so everything that reads a climate
// reads this one unchanged: the mean temperature; the mean rain (a mean of
// rates), OCEAN_PRECIP on the sea; the seasonal range (warmest month minus
// coldest), OCEAN_AMPLITUDE on the sea; the signed monsoon index from the
// two halves of the year, (P_top − P_bottom) / (P_top + P_bottom + floor)
// with each half as its own annual rate, + where the rain falls in the top
// hemisphere's summer half (climateField.inTopSummerHalf), OCEAN_PRECIP on
// the sea. Per cell of whatever holds the months: `n` cells (the field
// mesh's, or the climate raster's in the transition).
export function annualFromMonths(r: { months: number; temperature: ArrayLike<number>; precipitation: ArrayLike<number> }, n: number): { temperature: Float32Array; precipitation: Float32Array; seasonalAmplitude: Float32Array; monsoonIndex: Float32Array } {
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
