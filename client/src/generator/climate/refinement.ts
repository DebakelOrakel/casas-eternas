import { CLIMATE_RES_X, CLIMATE_RES_Y, inTopSummerHalf, isLandAtCell, latitudeAt } from './climateField'
import { CLIMATE_TUNING } from './climateTuneParams'
import { koppenFromMonths, reduceTemperatureToSeaLevel } from './biomes'
import { computePressureWind, REFINED_MONTHS } from './pressure'
import { computeWind, type CellVectors } from './wind'
import { seasonalCycle } from './energyBalance'
import { applyPhenomena } from './phenomena'
import { computeReliability, type Reliability } from './reliability'
import { computeStorms, type Storms } from './storms'
import { computeSalinity } from './salinity'
import { computePrecipitation, OCEAN_PRECIP } from './precipitation'
import { OCEAN_AMPLITUDE } from './seasonality'
import { applyOceanSST, carryInland, computeOceanCurrents, computeSinkInflow, computeUpwelling } from './oceanCurrents'
import { computeTemperature } from './temperature'
import type { WeatherParams } from './weather'
import { DEFAULT_PLANET_FORCING } from '../planet/planetForcing'
import { downsampleBox } from '../core/field'
import type { Domain, DomainGrid } from '../core/domain'
import { climateLandRaster, climateRaster, climateSeaRaster, climateSeaVectorRaster, climateTerrain, climateVectorFromRaster, climateVectorRaster, rasterLand } from './climateMesh'
import { fieldFromRasterAtCentres } from '../fields/fieldMesh'
import { smoothGaussian, type SolveReport } from '../fields/fieldOperators'
import { ELEVATION_METERS } from '../elevation/elevationScale'
import { detCos, detHypot, detSin } from '../core/detMath'

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
  // The ocean's solves on the climate's field mesh (DEC-0036 phase 4): the
  // wind's currents, the overturning's inflow, the year's two harmonics.
  // A diagnostic: a refinement read back from a save has none.
  solves?: { currents: SolveReport; inflow: SolveReport; cycle: SolveReport[] }
}

// `temperature` and `baseWind` are the climate the step shows (climate/weather.computeWeather on the same terrain), `params` the
// levers it was computed with.
// `onProgress` hears the share done, 0..1, a few times a run. `domain`: what
// the elevation raster covers, one cell per unit.
export function refineClimate(
  elevation: Float32Array, domain: Domain, params: WeatherParams,
  temperature: Float32Array, baseWind: Float32Array, onProgress?: (share: number) => void,
): RefinedClimate {
  const { width, height } = domain
  const grid = domain.grid(CLIMATE_RES_X, CLIMATE_RES_Y)
  const n = CLIMATE_RES_X * CLIMATE_RES_Y
  const planet = params.planet ?? DEFAULT_PLANET_FORCING
  const land = new Uint8Array(n)
  for (let gy = 0; gy < CLIMATE_RES_Y; gy++) {
    for (let gx = 0; gx < CLIMATE_RES_X; gx++) land[gy * CLIMATE_RES_X + gx] = isLandAtCell(elevation, undefined, gx, gy, width, height) ? 1 : 0
  }
  // DEC-0036 transition: removed in phase 5. The pressure, its wind, the
  // base temperature, the rain, the year's cycle and the ocean (phase 4:
  // the currents, the sea surface, the upwelling, the salt and the
  // overturning) run on the climate's field mesh (climateMesh.ts); the rest
  // of the refinement stays on the raster. The raster's fields go onto the
  // mesh at the cells' centres (fieldFromRasterAtCentres, a vector through
  // climateVectorFromRaster), the mesh's come back rasterised, the sea's 0
  // on the raster's land (climateSeaRaster).
  const terrain = climateTerrain(domain, elevation, width, height)
  const { cm } = terrain
  const toMesh = (raster: Float32Array): Float64Array => fieldFromRasterAtCentres(cm.mesh, raster, CLIMATE_RES_X, CLIMATE_RES_Y)
  const landPixels = rasterLand(terrain, CLIMATE_RES_X, CLIMATE_RES_Y)
  // The month's air reduced to sea level, on the mesh.
  const seaLevelAir = (air: Float32Array): Float64Array => toMesh(reduceTemperatureToSeaLevel(air, elevation, width, height))
  // Each month's wind on the mesh, for its rain.
  const meshWinds: CellVectors[] = []

  // B: the year's temperature cycle around the annual mean (the banded wind
  // carries it: the pressure wind needs these temperatures first).
  const annualMesh = toMesh(temperature)
  const { cycle: cycleMesh, solves: cycleSolves } = seasonalCycle(terrain, annualMesh, climateVectorFromRaster(cm, baseWind, CLIMATE_RES_X, CLIMATE_RES_Y), planet, params.equatorOffset, REFINED_MONTHS)
  const cycle = new Float32Array(REFINED_MONTHS * n)
  for (let month = 0; month < REFINED_MONTHS; month++) cycle.set(climateRaster(cm, cycleMesh.subarray(month * cm.mesh.count, (month + 1) * cm.mesh.count), CLIMATE_RES_X, CLIMATE_RES_Y), month * n)
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
  // On the mesh, smoothed there as the pressure's thermal part is.
  const plateauHeat = (month: number): Float64Array => {
    const hpa = new Float32Array(n)
    for (let i = 0; i < n; i++) hpa[i] = -CLIMATE_TUNING.pressurePlateauHpaPerKmC * plateauKm[i] * cycle[month * n + i]
    const onMesh = toMesh(hpa)
    return smoothGaussian(cm.mesh, onMesh, CLIMATE_TUNING.pressureSmoothSigmaM, onMesh)
  }

  // A: pressure and wind for each month, from the month's air reduced to sea
  // level.
  const pressure = new Float32Array(REFINED_MONTHS * n)
  const wind = new Float32Array(REFINED_MONTHS * n * 2)
  const belts = new Float32Array(REFINED_MONTHS)
  // The year's mean wind on the mesh, the currents' (below).
  const annualWindMesh: CellVectors = { e: new Float64Array(cm.mesh.count), s: new Float64Array(cm.mesh.count) }
  for (let month = 0; month < REFINED_MONTHS; month++) {
    const air = monthly.subarray(month * n, (month + 1) * n)
    // The season's shift of the bands, + in the top hemisphere's summer:
    // the rain belt, the wind cells and the pressure bands all move by it
    // (climateField.beltYNorm), the sun's latitude lagged by the sea.
    const belt = CLIMATE_TUNING.monsoonItczSeasonalShift * detCos(2 * Math.PI * ((month + 0.5) / REFINED_MONTHS - CLIMATE_TUNING.refineItczPeakYear))
    belts[month] = belt
    const bandWind = computeWind(cm, params.equatorOffset, planet.rotationHours, belt)
    const result = computePressureWind(terrain, seaLevelAir(air), bandWind, params.equatorOffset, planet.rotationHours, belt, plateauHeat(month))
    pressure.set(climateRaster(cm, result.pressure, CLIMATE_RES_X, CLIMATE_RES_Y), month * n)
    wind.set(climateVectorRaster(cm, result.wind.e, result.wind.s, CLIMATE_RES_X, CLIMATE_RES_Y), month * n * 2)
    for (let i = 0; i < cm.mesh.count; i++) {
      annualWindMesh.e[i] += result.wind.e[i] / REFINED_MONTHS
      annualWindMesh.s[i] += result.wind.s[i] / REFINED_MONTHS
    }
    onProgress?.(0.15 + 0.35 * (month + 1) / REFINED_MONTHS)
  }

  // The currents follow the year's mean wind (the first pass's months on
  // the mesh, annualWindMesh): the ocean answers the wind over months, not
  // within one.
  const windCurrents = computeOceanCurrents(terrain, annualWindMesh, params.equatorOffset)

  // The sea-surface anomaly, from the latitudinal base (not from `temperature`,
  // which already carries the history's currents): here on the wind's
  // currents, below on the full ones.
  const baseMesh = computeTemperature(terrain, params.temperatureOffset, params.temperatureContrast, params.equatorOffset, planet)
  const base = climateRaster(cm, baseMesh, CLIMATE_RES_X, CLIMATE_RES_Y)
  const windAnomalyMesh = applyOceanSST(terrain, baseMesh.slice(), windCurrents, annualWindMesh)
  const windAnomaly = climateSeaRaster(cm, windAnomalyMesh, CLIMATE_RES_X, CLIMATE_RES_Y, landPixels)

  // Upwelling cools the sea where it comes up. The cold eastern coasts are
  // mostly this, not the slow currents along them.
  // Near the equator only the eastern part of a basin cools (see
  // eastwardInBasin); off the equator the coast's own upwelling counts in
  // full. The blend runs over `upwellingEquatorBandDeg`.
  const upwelling = climateSeaRaster(cm, computeUpwelling(terrain, annualWindMesh, params.equatorOffset, planet.rotationHours), CLIMATE_RES_X, CLIMATE_RES_Y, landPixels)
  const east = eastwardInBasin(land, grid)
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
  const flank = basinFlank(land, grid, CLIMATE_TUNING.oceanHighBasinCells)
  for (let gy = 0; gy < CLIMATE_RES_Y; gy++) {
    const lat = latitudeAt(gy, params.equatorOffset) * 90
    const t = (lat - CLIMATE_TUNING.oceanHighFromDeg) / (CLIMATE_TUNING.oceanHighToDeg - CLIMATE_TUNING.oceanHighFromDeg)
    if (t <= 0 || t >= 1) continue
    const bump = detSin(Math.PI * t)
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
  blur(oceanHigh, CLIMATE_TUNING.oceanHighSmoothCells, grid)
  blur(seaShare, CLIMATE_TUNING.oceanHighSmoothCells, grid)
  for (let i = 0; i < n; i++) oceanHigh[i] = seaShare[i] > CLIMATE_TUNING.oceanHighMinSeaShare ? oceanHigh[i] / seaShare[i] : 0
  const oceanHighMesh = toMesh(oceanHigh)
  for (let month = 0; month < REFINED_MONTHS; month++) {
    const air = monthly.subarray(month * n, (month + 1) * n)
    const bandWind = computeWind(cm, params.equatorOffset, planet.rotationHours, belts[month])
    const extra = plateauHeat(month)
    for (let i = 0; i < extra.length; i++) extra[i] += oceanHighMesh[i]
    const result = computePressureWind(terrain, seaLevelAir(air), bandWind, params.equatorOffset, planet.rotationHours, belts[month], extra)
    pressure.set(climateRaster(cm, result.pressure, CLIMATE_RES_X, CLIMATE_RES_Y), month * n)
    wind.set(climateVectorRaster(cm, result.wind.e, result.wind.s, CLIMATE_RES_X, CLIMATE_RES_Y), month * n * 2)
    meshWinds[month] = result.wind
  }

  // B's second half: the month's rain, from that wind and that air, with the
  // equatorial rain belt following the sun. The sea evaporates at its own
  // surface: the base, the wind's currents, the upwelling and the month's
  // cycle (the overturning's warmth, which needs the rain for the salt, is
  // left out), and its anomaly goes with the air (computePrecipitation).
  // (The sea's temperature on every pixel, the land's too, which the rain
  // never reads there: the mesh's sea cells next to a coast take a mix of
  // the pixels about them, and a land pixel's 0 would cool them.)
  const precipitation = new Float32Array(REFINED_MONTHS * n)
  const seaTemperature = new Float32Array(n)
  const seaAnomalyMesh = toMesh(seaAnomaly)
  // The year's rain on the mesh's land (the salt's rivers, below).
  const landRain = new Float64Array(cm.mesh.count)
  for (let month = 0; month < REFINED_MONTHS; month++) {
    for (let i = 0; i < n; i++) seaTemperature[i] = base[i] + windAnomaly[i] - upwellingCooling[i] + cycle[month * n + i]
    const air = monthly.subarray(month * n, (month + 1) * n)
    const rain = computePrecipitation(terrain, toMesh(air), meshWinds[month], params.humidity, params.equatorOffset, belts[month], { seaTemperature: toMesh(seaTemperature), seaAnomaly: seaAnomalyMesh, highHpa: oceanHighMesh })
    precipitation.set(climateLandRaster(terrain, rain, OCEAN_PRECIP, CLIMATE_RES_X, CLIMATE_RES_Y, landPixels), month * n)
    for (let i = 0; i < landRain.length; i++) if (terrain.land[i]) landRain[i] += rain[i] / REFINED_MONTHS
    onProgress?.(0.5 + 0.4 * (month + 1) / REFINED_MONTHS)
  }

  // 9: the sea's salt and where it sinks, then the surface water that
  // sinking draws after it (computeSinkInflow) added to the wind's currents,
  // then the salt again on those — once round: the inflow moves the salty
  // water that sinks, and one more pass settles where it does.
  const first = computeSalinity(terrain, annualMesh, landRain, windCurrents, params.equatorOffset, params.humidity)
  const inflow = computeSinkInflow(terrain, first.deepWater)
  const meshCount = cm.mesh.count
  const currentsMesh: CellVectors = { e: new Float64Array(meshCount), s: new Float64Array(meshCount) }
  let fastest = 0
  for (let i = 0; i < meshCount; i++) {
    currentsMesh.e[i] = windCurrents.e[i] + CLIMATE_TUNING.conveyorFlow * inflow.e[i]
    currentsMesh.s[i] = windCurrents.s[i] + CLIMATE_TUNING.conveyorFlow * inflow.s[i]
    fastest = Math.max(fastest, detHypot(currentsMesh.e[i], currentsMesh.s[i]))
  }
  // Normalised like the wind's (the fastest is 1), which the sea's transport
  // and the currents layer read.
  if (fastest > 1) {
    for (let i = 0; i < meshCount; i++) {
      currentsMesh.e[i] /= fastest
      currentsMesh.s[i] /= fastest
    }
  }
  const salt = computeSalinity(terrain, annualMesh, landRain, currentsMesh, params.equatorOffset, params.humidity)

  // The anomaly on the full currents; its difference to the wind's alone is
  // the overturning's warmth. The months take it, on the sea and on the
  // land the wind carries it to (oceanCurrents.carryInland, as the
  // currents' own anomaly goes).
  const anomalyMesh = applyOceanSST(terrain, baseMesh.slice(), currentsMesh, annualWindMesh)
  const drift = new Float64Array(meshCount)
  for (let i = 0; i < meshCount; i++) if (!terrain.land[i]) drift[i] = anomalyMesh[i] - windAnomalyMesh[i]
  const inland = carryInland(terrain, drift, annualWindMesh)
  const warmthMesh = new Float64Array(meshCount)
  for (let i = 0; i < meshCount; i++) warmthMesh[i] = terrain.land[i] ? CLIMATE_TUNING.currentsCoastalFactor * inland[i] : drift[i]
  const warmth = climateRaster(cm, warmthMesh, CLIMATE_RES_X, CLIMATE_RES_Y)
  for (let month = 0; month < REFINED_MONTHS; month++) for (let i = 0; i < n; i++) monthly[month * n + i] += warmth[i]
  const currentAnomaly = climateSeaRaster(cm, anomalyMesh, CLIMATE_RES_X, CLIMATE_RES_Y, landPixels)
  for (let i = 0; i < n; i++) currentAnomaly[i] -= upwellingCooling[i]
  const currents = climateSeaVectorRaster(cm, currentsMesh.e, currentsMesh.s, CLIMATE_RES_X, CLIMATE_RES_Y, landPixels)
  const salinity = climateSeaRaster(cm, salt.salinity, CLIMATE_RES_X, CLIMATE_RES_Y, landPixels)
  const deepWater = climateSeaRaster(cm, salt.deepWater, CLIMATE_RES_X, CLIMATE_RES_Y, landPixels)

  // C1: fog and föhn, which change the months they happen in (so after the
  // sea, and before the classes).
  const { fog, foehn } = applyPhenomena(monthly, REFINED_MONTHS, wind, currentAnomaly, land, elevation, domain)

  const koppen = koppenFromMonths(monthly, precipitation, REFINED_MONTHS)
  const refined = { months: REFINED_MONTHS, temperature: monthly, precipitation, koppen, fog, foehn, salinity, deepWater, pressure, wind, currents, currentAnomaly, upwelling }

  // 7: the rain's reliability, from the year the months make.
  const annual = annualFromMonths(refined)
  const reliability = computeReliability(annual.precipitation, annual.monsoonIndex, currentAnomaly, land, grid, params.equatorOffset)
  // 8: the storms of those months.
  const storms = computeStorms(monthly, precipitation, REFINED_MONTHS, wind, land, elevation, domain, params.equatorOffset)
  return { ...refined, reliability, storms, solves: { currents: windCurrents.solve, inflow: inflow.solve, cycle: cycleSolves } }
}

// DEC-0036 transition: removed in phase 5 (moved here from oceanCurrents.ts
// in phase 4). How far east a sea cell lies in its basin, along its row of
// the climate raster (`grid`): 0 at the western shore, 1 at the eastern,
// 0.5 where the row has no shore. The thermocline tilts with the trade
// winds — deep under the warm pool in the west, shallow in the east — so
// upwelling brings cold water only in the east (the equatorial cold
// tongue).
export function eastwardInBasin(land: Uint8Array, grid: DomainGrid): Float32Array {
  const RX = CLIMATE_RES_X
  const RY = CLIMATE_RES_Y
  const out = new Float32Array(RX * RY).fill(0.5)
  for (let gy = 0; gy < RY; gy++) {
    for (let x0 = 0; x0 < RX; x0++) {
      // A run of sea starts after a land cell.
      if (!land[gy * RX + x0] || land[gy * RX + grid.wrapCol(x0 + 1)]) continue
      let len = 0
      while (len < RX && !land[gy * RX + grid.wrapCol(x0 + 1 + len)]) len++
      for (let k = 0; k < len; k++) out[gy * RX + grid.wrapCol(x0 + 1 + k)] = len > 1 ? k / (len - 1) : 0.5
    }
  }
  return out
}

// DEC-0036 transition: removed in phase 5 (moved here from oceanCurrents.ts
// in phase 4). Where a sea cell lies across its basin, along its row of the
// climate raster: −1 at the western shore, +1 at the eastern, scaled down in
// a basin narrower than `fullWidthCells` equator cells (a sea between two
// coasts close together has no east and west of its own); 0 where the row
// has no shore.
export function basinFlank(land: Uint8Array, grid: DomainGrid, fullWidthCells: number): Float32Array {
  const RX = CLIMATE_RES_X
  const RY = CLIMATE_RES_Y
  const out = new Float32Array(RX * RY)
  for (let gy = 0; gy < RY; gy++) {
    for (let x0 = 0; x0 < RX; x0++) {
      if (!land[gy * RX + x0] || land[gy * RX + grid.wrapCol(x0 + 1)]) continue
      let len = 0
      while (len < RX && !land[gy * RX + grid.wrapCol(x0 + 1 + len)]) len++
      if (len < 2) continue
      // The basin's width is a length: its cells times the row's width
      // (1 on the torus).
      const width = Math.min(1, (len * grid.rowScale(gy)) / fullWidthCells)
      for (let k = 0; k < len; k++) out[gy * RX + grid.wrapCol(x0 + 1 + k)] = (2 * k / (len - 1) - 1) * width
    }
  }
  return out
}

// DEC-0036 transition: removed in phase 5. A wrapped box blur on the
// climate raster (`grid`), in place through a scratch buffer; three passes
// approach a Gaussian of σ ≈ radius — the refinement's ocean highs; the
// static climate smooths on its field mesh (fields/fieldOperators.
// smoothGaussian). Moved here from pressure.ts in phase 3.
//
// `radius` is in equator cells, a length. A row whose cells are narrower
// (the sphere toward a pole, DomainGrid.rowScale = cos φ) takes as many of
// its own cells as cover that length east-west, up to its whole width but
// one: a pole row is a small circle the blur's length spans many times.
// The north-south pass steps across a pole as the grid does, and the pole
// rows come out one value each (fork 5 of DEC-0035). On the torus every
// row's radius is `radius` and the pole rows are none: the arithmetic is
// the torus's, as it was.
export function blur(field: Float32Array, radius: number, grid: DomainGrid): void {
  const RX = CLIMATE_RES_X
  const RY = CLIMATE_RES_Y
  const tmp = new Float32Array(field.length)
  const width = 2 * radius + 1
  const rowRadius = new Int32Array(RY)
  for (let gy = 0; gy < RY; gy++) rowRadius[gy] = Math.min((RX - 1) >> 1, Math.round(radius / grid.rowScale(gy)))
  for (let pass = 0; pass < 3; pass++) {
    for (let gy = 0; gy < RY; gy++) {
      const r = rowRadius[gy]
      const rowWidth = 2 * r + 1
      let sum = 0
      for (let dx = -r; dx <= r; dx++) sum += field[grid.index(dx, gy)]
      for (let gx = 0; gx < RX; gx++) {
        tmp[gy * RX + gx] = sum / rowWidth
        sum += field[grid.index(gx + r + 1, gy)] - field[grid.index(gx - r, gy)]
      }
    }
    for (let gx = 0; gx < RX; gx++) {
      let sum = 0
      for (let dy = -radius; dy <= radius; dy++) sum += tmp[grid.index(gx, dy)]
      for (let gy = 0; gy < RY; gy++) {
        field[gy * RX + gx] = sum / width
        sum += tmp[grid.index(gx, gy + radius + 1)] - tmp[grid.index(gx, gy - radius)]
      }
    }
  }
  grid.averagePoleRows(field)
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
