import { beltYNorm, shiftedNorm } from './climateField'
import { CLIMATE_TUNING } from './climateTuneParams'
import { hadleyEdge } from '../planet/planetForcing'
import { ELEVATION_METERS } from '../elevation/elevationScale'
import { detCos, detHypot, detSin } from '../core/detMath'
import { zonalMean, type ClimateTerrain } from './climateMesh'
import type { CellVectors } from './wind'
import { gradient, smoothGaussian } from '../fields/fieldOperators'

// Surface pressure and the wind it drives, for one month, on the climate's
// field mesh (build step 2 of docs/design/climate-refinement.md; on the
// mesh since DEC-0036 phase 3). The climate step's
// model, not the epochs': the history keeps the banded wind of wind.ts.
//
// Pressure = the zonal bands (equatorial trough, subtropical highs, subpolar
// lows, polar highs) + a thermal part: air over ground warmer than its
// latitude's mean rises (a heat low), air over colder ground sinks (a cold
// high). The thermal part is smoothed to the scale of real heat lows and cold
// highs (1000–2000 km), because the air does not follow each coast.
//
// Wind = the banded wind of wind.ts (the cells' momentum, which a pressure
// balance alone cannot give at the equator) + the wind of the thermal part
// from the balance of pressure gradient, Coriolis and surface friction. Where
// the Coriolis parameter is large the wind turns along the isobars (around a
// low, anticlockwise in the north); near the equator and over rough land it
// flows more across them, into the low. Then a high range turns the part of
// the wind that blows up its slope.

// The refinement's months: a year, January first.
export const REFINED_MONTHS = 12

export interface PressureWind {
  // hPa per cell, the full pressure (bands + thermal part), for the layer.
  pressure: Float64Array
  // Per cell in wind.ts's units (1 = 8 m/s), east and south.
  wind: CellVectors
}

// The zonal bands' pressure in hPa at a signed latitude (−1 top pole … +1
// bottom pole). Minimum at the equator, maximum at the Hadley edge, minimum
// at the Ferrel cell's poleward edge, a weaker maximum at the pole: the edges
// that wind.ts's cells use, so the bands and the banded wind agree.
function bandPressure(phi: number, e1: number, e2: number): number {
  const a = CLIMATE_TUNING.pressureBandHpa
  let t: number
  if (phi < e1) t = -detCos((Math.PI * phi) / e1) // −1 equator → +1 Hadley edge
  else if (phi < e2) t = detCos((Math.PI * (phi - e1)) / (e2 - e1)) // +1 → −1 subpolar low
  else t = -detCos((Math.PI * (phi - e2)) / (1 - e2)) * 0.5 - 0.5 // −1 → 0 polar high
  return 1013 + a * t
}

// Per cell of the climate's field mesh (DEC-0036 phase 3). `temperature`
// is the month's air temperature reduced to sea level
// (biomes.reduceTemperatureToSeaLevel: a high range is cold by its height,
// and the pressure here is sea-level pressure), the land the terrain's,
// `baseWind` wind.ts's banded wind. `rotationHours` scales the Coriolis
// parameter and moves the band edges.
export function computePressureWind(
  terrain: ClimateTerrain, temperature: ArrayLike<number>,
  baseWind: CellVectors, equatorOffset: number, rotationHours: number,
  // The season's shift of the bands (climateField.beltYNorm), the same the
  // month's rain and `baseWind` were made with.
  beltShift = 0,
  // A further pressure part, hPa per cell, already smooth: the refinement's
  // ocean highs and plateau heat. Its wind is found with the thermal part's.
  extraHpa?: ArrayLike<number>,
): PressureWind {
  const { cm, land, domain } = terrain
  const { mesh, sampler } = cm
  const n = mesh.count
  const e1 = hadleyEdge(rotationHours)
  const e2 = (1 + e1) / 2

  // The thermal part: the temperature's departure from its latitude's mean
  // (climateMesh.zonalMean, the former row's mean), smoothed, times −hPa
  // per °C.
  const rowMean = zonalMean(cm, temperature)
  const thermal = new Float64Array(n)
  for (let i = 0; i < n; i++) thermal[i] = -(temperature[i] - rowMean[i]) * CLIMATE_TUNING.pressureHpaPerC
  smoothGaussian(mesh, thermal, CLIMATE_TUNING.pressureSmoothSigmaM, thermal)
  if (extraHpa) for (let i = 0; i < n; i++) thermal[i] += extraHpa[i]

  const pressure = new Float64Array(n)
  const f = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const shifted = shiftedNorm(cm.yNorm[i], equatorOffset)
    const sLat = (shifted - 0.5) * 2 // −1 top … +1 bottom
    // The bands where the season has moved them; the Coriolis parameter
    // below stays the cell's own.
    const band = bandPressure(Math.abs((beltYNorm(shifted, beltShift, domain.kind) - 0.5) * 2), e1, e2)
    pressure[i] = band + thermal[i]
    // Signed so the top hemisphere is the northern one: f > 0 there.
    f[i] = detSin((-sLat * Math.PI) / 2) * (24 / rotationHours)
  }

  // The relief the wind meets: the mean of the terrain's raster over each
  // cell (area-weighted, the former box mean), metres, land only.
  const mean = terrain.meanElevation()
  const relief = new Float64Array(n)
  for (let i = 0; i < n; i++) relief[i] = Math.max(0, mean[i] * ELEVATION_METERS)

  // The gradients by least squares in each cell's tangent plane, per metre
  // (fields/fieldOperators.gradient), times `climateGradientLengthM`: the
  // difference over the length the former raster's central difference
  // spanned per cell. No polar filter: the mesh's cells are as wide near a
  // pole as at the equator.
  const L = CLIMATE_TUNING.climateGradientLengthM
  const pe = new Float64Array(n)
  const ps = new Float64Array(n)
  gradient(mesh, thermal, pe, ps)
  const he = new Float64Array(n)
  const hs = new Float64Array(n)
  gradient(mesh, relief, he, hs)
  const wind: CellVectors = { e: new Float64Array(n), s: new Float64Array(n) }
  const reach = L / mesh.unitM
  const point = { x: 0, y: 0 }
  for (let i = 0; i < n; i++) {
    // −∇p of the thermal part, east and south, per gradient length.
    const gx_ = -pe[i] * L * CLIMATE_TUNING.pressureWindPerHpa
    const gy_ = -ps[i] * L * CLIMATE_TUNING.pressureWindPerHpa
    // The balance G + f·(v, −u)_north − r·u = 0, solved in north-up axes
    // (the y axis flips), then back.
    const gn = -gy_
    const r = land[i] ? CLIMATE_TUNING.pressureFrictionLand : CLIMATE_TUNING.pressureFrictionSea
    const fy = f[i]
    const d = r * r + fy * fy
    const u = (r * gx_ + fy * gn) / d
    const vn = (r * gn - fy * gx_) / d
    let wu = baseWind.e[i] + u
    let wv = baseWind.s[i] - vn

    // A range turns the wind: take away a part of the component up the
    // slope, more for a higher barrier — the highest of the cell and the
    // ground one gradient length downwind east-west and north-south.
    const hx = he[i]
    const hy = hs[i]
    const slope = detHypot(hx, hy)
    if (slope > 0) {
      const up = (wu * hx + wv * hy) / slope
      domain.advance(mesh.x[i], mesh.y[i], reach * Math.sign(wu), 0, point)
      const east = sampler.sample(relief, point.x, point.y)
      domain.advance(mesh.x[i], mesh.y[i], 0, reach * Math.sign(wv), point)
      const south = sampler.sample(relief, point.x, point.y)
      const top = Math.max(relief[i], east, south)
      const block = Math.min(1, Math.max(0, (top - CLIMATE_TUNING.pressureBlockFromM) / (CLIMATE_TUNING.pressureBlockFullM - CLIMATE_TUNING.pressureBlockFromM))) * CLIMATE_TUNING.pressureBlockMax
      if (up > 0) {
        wu -= block * up * hx / slope
        wv -= block * up * hy / slope
      }
    }
    wind.e[i] = wu
    wind.s[i] = wv
  }
  return { pressure, wind }
}
