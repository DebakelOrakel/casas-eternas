import type { Domain } from '../core/domain'
import { isLandAt } from '../elevation/elevationScale'
import { rasteriseField, rasteriseVectorField } from '../fields/fieldMesh'
import { CLIMATE_RES_X, CLIMATE_RES_Y } from './climateField'
import { zonalMean, type ClimateMesh, type ClimateTerrain } from './climateMesh'
import { lapseAt, type ClimateCells } from './climatePoints'
import { OCEAN_PRECIP } from './precipitation'
import { OCEAN_AMPLITUDE } from './seasonality'
import type { RefinedClimate, RefinedReliability, RefinedStorms } from './refinement'

// THE CLIMATE'S CHART (DEC-0036 fork 5: "the chart is the address and the
// textures"): the climate's field-mesh fields on the CLIMATE_RES_X ×
// CLIMATE_RES_Y chart raster, for the screen's textures, readouts and month
// player and for a save's readers (world/query.ts). NO STAGE READS IT — a
// stage samples the cells at its own points (climatePoints.ts); this is
// what it looked like until phase 7, kept for the eye.
//
// A land field (its sea mark OCEAN_PRECIP / OCEAN_AMPLITUDE) takes the
// mark on the chart's sea pixels (`chartLand`: the texel under a pixel's
// centre, the former climate grid's own test) and on its land pixels the
// barycentric mix of the triangle's LAND corners, renormalised — never a
// blend with the mark; a land pixel without a land corner (an island
// smaller than a cell) its latitude's land mean. A sea field is 0 on the
// chart's land. A vector is each pixel's in its own frame.

export const chartField = (cm: ClimateMesh, field: ArrayLike<number>, resX = CLIMATE_RES_X, resY = CLIMATE_RES_Y): Float32Array => rasteriseField(cm.mesh, field, resX, resY)

export const chartVectorField = (cm: ClimateMesh, fe: ArrayLike<number>, fs: ArrayLike<number>, resX = CLIMATE_RES_X, resY = CLIMATE_RES_Y): Float32Array => rasteriseVectorField(cm.sampler, fe, fs, resX, resY)

// The terrain a chart's land is read off: a raster over the domain and its
// dry floors (null: none).
export interface ChartTerrain {
  domain: Domain
  elevation: Float32Array
  resX: number
  resY: number
  dryLand: Uint8Array | null
}

// The land test of a resX × resY chart: pixel (gx, gy) is land when the
// texel under its centre is.
export function chartLand(terrain: ChartTerrain, resX = CLIMATE_RES_X, resY = CLIMATE_RES_Y): Uint8Array {
  const out = new Uint8Array(resX * resY)
  const { domain } = terrain
  const kx = terrain.resX / domain.width
  const ky = terrain.resY / domain.height
  for (let gy = 0; gy < resY; gy++) {
    const y = ((gy + 0.5) / resY) * domain.height
    const ty = Math.min(terrain.resY - 1, Math.floor(y * ky))
    for (let gx = 0; gx < resX; gx++) {
      const x = ((gx + 0.5) / resX) * domain.width
      const t = ty * terrain.resX + Math.min(terrain.resX - 1, Math.floor(x * kx))
      out[gy * resX + gx] = isLandAt(terrain.elevation[t], terrain.dryLand !== null && terrain.dryLand[t] === 1) ? 1 : 0
    }
  }
  return out
}

// A sea field, 0 on the chart's land.
export function chartSeaField(cm: ClimateMesh, field: ArrayLike<number>, landPixels: Uint8Array, resX = CLIMATE_RES_X, resY = CLIMATE_RES_Y): Float32Array {
  const out = rasteriseField(cm.mesh, field, resX, resY)
  for (let p = 0; p < out.length; p++) if (landPixels[p]) out[p] = 0
  return out
}

export function chartSeaVectorField(cm: ClimateMesh, fe: ArrayLike<number>, fs: ArrayLike<number>, landPixels: Uint8Array, resX = CLIMATE_RES_X, resY = CLIMATE_RES_Y): Float32Array {
  const out = rasteriseVectorField(cm.sampler, fe, fs, resX, resY)
  for (let p = 0; p < landPixels.length; p++) {
    if (!landPixels[p]) continue
    out[2 * p] = 0
    out[2 * p + 1] = 0
  }
  return out
}

// A land field: `isLand(i)` the cells it holds a value on, `seaValue` on the
// chart's sea (its mark, or 0 for a field that is an ordinary 0 there).
export function chartLandField(cm: ClimateMesh, field: ArrayLike<number>, isLand: (i: number) => boolean, seaValue: number, landPixels: Uint8Array, resX = CLIMATE_RES_X, resY = CLIMATE_RES_Y): Float32Array {
  const { sampler, mesh } = cm
  const { domain } = mesh
  const out = new Float32Array(resX * resY)
  const islands = zonalMean(cm, field, isLand)
  const corners = new Int32Array(3)
  const weights = new Float64Array(3)
  const sx = domain.width / resX
  const sy = domain.height / resY
  for (let gy = 0; gy < resY; gy++) {
    const y = (gy + 0.5) * sy
    for (let gx = 0; gx < resX; gx++) {
      const p = gy * resX + gx
      if (!landPixels[p]) {
        out[p] = seaValue
        continue
      }
      const x = (gx + 0.5) * sx
      sampler.taps(x, y, corners, weights)
      let s = 0
      let w = 0
      for (let k = 0; k < 3; k++) {
        if (!isLand(corners[k])) continue
        s += weights[k] * field[corners[k]]
        w += weights[k]
      }
      out[p] = w > 0 ? s / w : islands[sampler.nearestCell(x, y)]
    }
  }
  return out
}

// The static climate (weather.computeWeather) as the screen's textures.
export interface WeatherChart {
  temperature: Float32Array
  wind: Float32Array
  seasonalAmplitude: Float32Array
  precipitation: Float32Array
  monsoonIndex: Float32Array
  currents: Float32Array
  currentAnomaly: Float32Array
}

// A climate's annual cells (climatePoints.ClimateCells) as charts — a save's
// readers' (world/query.ts): the temperature at each pixel's texel height
// (the sea-level field less the lapse there), the land fields with their
// marks.
export function cellsChart(cells: ClimateCells, terrain: ChartTerrain, resX = CLIMATE_RES_X, resY = CLIMATE_RES_Y): { temperature: Float32Array; precipitation: Float32Array; seasonalAmplitude: Float32Array; monsoonIndex: Float32Array; landMask: Float32Array } {
  const { cm } = cells
  const landPixels = chartLand(terrain, resX, resY)
  const isLand = (i: number): boolean => cells.precipitation[i] !== OCEAN_PRECIP
  const temperature = chartField(cm, cells.seaLevelTemperature, resX, resY)
  const { domain } = terrain
  const kx = terrain.resX / domain.width
  const ky = terrain.resY / domain.height
  for (let gy = 0; gy < resY; gy++) {
    const ty = Math.min(terrain.resY - 1, Math.floor(((gy + 0.5) / resY) * domain.height * ky))
    for (let gx = 0; gx < resX; gx++) {
      const t = ty * terrain.resX + Math.min(terrain.resX - 1, Math.floor(((gx + 0.5) / resX) * domain.width * kx))
      temperature[gy * resX + gx] -= lapseAt(terrain.elevation[t], terrain.dryLand !== null && terrain.dryLand[t] === 1)
    }
  }
  const landMask = new Float32Array(resX * resY)
  for (let p = 0; p < landMask.length; p++) landMask[p] = landPixels[p]
  return {
    temperature,
    precipitation: chartLandField(cm, cells.precipitation, isLand, OCEAN_PRECIP, landPixels, resX, resY),
    seasonalAmplitude: chartLandField(cm, cells.seasonalAmplitude, isLand, OCEAN_AMPLITUDE, landPixels, resX, resY),
    monsoonIndex: chartLandField(cm, cells.monsoonIndex, isLand, OCEAN_PRECIP, landPixels, resX, resY),
    landMask,
  }
}

// The refinement as the screen's textures, readouts and month player: the
// months' fields per pixel (month-major), the vectors interleaved [east,
// south] in each pixel's own frame, the sea's fields 0 on the chart's
// land, the land's on its sea, the rain's sea OCEAN_PRECIP. Made once per
// refinement, in the worker.
export interface RefinedClimateChart {
  months: number
  temperature: Float32Array
  precipitation: Float32Array
  pressure: Float32Array
  wind: Float32Array
  currents: Float32Array
  currentAnomaly: Float32Array
  upwelling: Float32Array
  salinity: Float32Array
  deepWater: Float32Array
  fog: Float32Array
  foehn: Float32Array
  reliability: RefinedReliability
  storms: RefinedStorms
}

export function refinedChart(r: RefinedClimate, terrain: ClimateTerrain): RefinedClimateChart {
  const { cm } = terrain
  const px = CLIMATE_RES_X * CLIMATE_RES_Y
  const n = r.cells
  const months = r.months
  const landPixels = chartLand(terrain)
  const temperature = new Float32Array(months * px)
  const precipitation = new Float32Array(months * px)
  const pressure = new Float32Array(months * px)
  const wind = new Float32Array(months * px * 2)
  for (let m = 0; m < months; m++) {
    const at = (field: Float32Array): Float32Array => field.subarray(m * n, (m + 1) * n)
    const rain = at(r.precipitation)
    temperature.set(chartField(cm, at(r.temperature)), m * px)
    precipitation.set(chartLandField(cm, rain, (i) => terrain.land[i] === 1 && rain[i] !== OCEAN_PRECIP, OCEAN_PRECIP, landPixels), m * px)
    pressure.set(chartField(cm, at(r.pressure)), m * px)
    wind.set(chartVectorField(cm, at(r.windE), at(r.windS)), m * px * 2)
  }
  const sea = (field: Float32Array): Float32Array => chartSeaField(cm, field, landPixels)
  const landOnly = (field: Float32Array): Float32Array => chartLandField(cm, field, (i) => terrain.land[i] === 1, 0, landPixels)
  const both = (field: Float32Array): Float32Array => chartField(cm, field)
  return {
    months,
    temperature,
    precipitation,
    pressure,
    wind,
    currents: chartSeaVectorField(cm, r.currentE, r.currentS, landPixels),
    currentAnomaly: sea(r.currentAnomaly),
    upwelling: sea(r.upwelling),
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
