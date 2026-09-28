import { CLIMATE_RES_X, CLIMATE_RES_Y, shiftedYNorm } from './climateField'
import { CLIMATE_TUNING } from './climateTuneParams'
import { wrapIndex2 } from '../core/field'
import type { PlanetForcing } from '../planet/planetForcing'

const RX = CLIMATE_RES_X
const RY = CLIMATE_RES_Y
const RAD = Math.PI / 180
const YEAR_S = 365.25 * 86400

// THE YEAR'S TEMPERATURE CYCLE (build step 4 of
// docs/design/climate-refinement.md): a linear energy balance for the
// departure from the annual mean,
//
//   C ∂T'/∂t = (1 − α) S'(t) − B T' + D ∇²T' − a (u · ∇) T',
//
// with the sun's departure from its yearly mean S' as the forcing, a small
// heat capacity C on land and a large one on the sea (the mixed layer), the
// outgoing radiation's sensitivity B, exchange with the neighbouring cells D,
// and the air carried by the wind (a per unit of wind). Linear, so the
// periodic answer is found directly, one annual harmonic at a time: for
// e^{ikωt}, (ikωC + B + D·4 + a·|u|) T̂ − D ΣT̂_neighbour − a|u| T̂_upwind
// = (1 − α) Ŝ_k. Two harmonics (the year and the half year) carry nearly all
// of the cycle. No spin-up, and no year to wait for the sea to settle.
//
// The annual MEAN stays the cheap model's (climate/temperature.ts): the
// step-0 levers are calibrated there. This supplies the cycle around it.

// The months' temperature departures, °C, month-major (month 0 January).
// `annualTemperature` gives the albedo (ice below `ebmIceBelowC`), `land`
// the heat capacity, `wind` the transport (the history's banded wind: the
// pressure wind needs these temperatures first).
export function seasonalCycle(land: Uint8Array, annualTemperature: Float32Array, wind: Float32Array, planet: PlanetForcing, equatorOffset: number, months: number): Float32Array {
  const n = RX * RY
  const T = CLIMATE_TUNING
  const omega = (2 * Math.PI) / YEAR_S

  // The sun's monthly departure per row, then its first two harmonics.
  const monthlySun = new Float64Array(RY * months)
  for (let gy = 0; gy < RY; gy++) {
    const latNorth = (0.5 - shiftedYNorm(gy, RY, equatorOffset)) * Math.PI // + in the top hemisphere
    let mean = 0
    for (let m = 0; m < months; m++) {
      const q = monthInsolation(latNorth, (m + 0.5) / months, planet)
      monthlySun[gy * months + m] = q
      mean += q / months
    }
    for (let m = 0; m < months; m++) monthlySun[gy * months + m] -= mean
  }

  // Per cell: the absorbed share, the heat capacity, and the upwind cell with
  // the wind's weight.
  const absorbed = new Float32Array(n)
  const capacity = new Float32Array(n)
  const upwindX = new Int32Array(n)
  const upwindY = new Int32Array(n)
  const carryX = new Float32Array(n)
  const carryY = new Float32Array(n)
  for (let gy = 0; gy < RY; gy++) {
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      const ice = annualTemperature[i] < T.ebmIceBelowC
      const albedo = ice ? T.ebmAlbedoIce : land[i] ? T.ebmAlbedoLand : T.ebmAlbedoSea
      absorbed[i] = 1 - albedo
      // Sea that freezes over in winter is capped by its ice and swings like
      // land: without this the polar coasts had a 9 °C year (Earth's run to
      // some 30 °C). A linear model cannot let the ice come and go with the
      // season, so the annual mean decides.
      const frozen = !land[i] && annualTemperature[i] < T.ebmSeaIceBelowC
      capacity[i] = land[i] || frozen ? T.ebmCapacityLand : T.ebmCapacitySea
      const u = wind[i * 2]
      const v = wind[i * 2 + 1]
      upwindX[i] = wrapIndex2(gx - Math.sign(u), gy, RX, RY)
      upwindY[i] = wrapIndex2(gx, gy - Math.sign(v), RX, RY)
      carryX[i] = Math.abs(u) * T.ebmCarryPerWind
      carryY[i] = Math.abs(v) * T.ebmCarryPerWind
    }
  }
  const left = new Int32Array(n)
  const right = new Int32Array(n)
  const up = new Int32Array(n)
  const down = new Int32Array(n)
  for (let gy = 0; gy < RY; gy++) {
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      left[i] = wrapIndex2(gx - 1, gy, RX, RY)
      right[i] = wrapIndex2(gx + 1, gy, RX, RY)
      up[i] = wrapIndex2(gx, gy - 1, RX, RY)
      down[i] = wrapIndex2(gx, gy + 1, RX, RY)
    }
  }

  const out = new Float32Array(months * n)
  for (let k = 1; k <= 2; k++) {
    // Ŝ_k per row: (2/M) Σ S'_m e^{−ikωt_m}, so S'(t) ≈ Re Σ_k Ŝ_k e^{ikωt}.
    const sunRe = new Float64Array(RY)
    const sunIm = new Float64Array(RY)
    for (let gy = 0; gy < RY; gy++) {
      for (let m = 0; m < months; m++) {
        const phase = (2 * Math.PI * k * (m + 0.5)) / months
        sunRe[gy] += (2 / months) * monthlySun[gy * months + m] * Math.cos(phase)
        sunIm[gy] -= (2 / months) * monthlySun[gy * months + m] * Math.sin(phase)
      }
    }
    // Gauss-Seidel on the complex amplitude, in place.
    const re = new Float64Array(n)
    const im = new Float64Array(n)
    const D = T.ebmExchange
    for (let iter = 0; iter < T.ebmSolveIters; iter++) {
      for (let i = 0; i < n; i++) {
        const row = (i / RX) | 0
        const cx = carryX[i]
        const cy = carryY[i]
        const fRe = absorbed[i] * sunRe[row] + D * (re[left[i]] + re[right[i]] + re[up[i]] + re[down[i]]) + cx * re[upwindX[i]] + cy * re[upwindY[i]]
        const fIm = absorbed[i] * sunIm[row] + D * (im[left[i]] + im[right[i]] + im[up[i]] + im[down[i]]) + cx * im[upwindX[i]] + cy * im[upwindY[i]]
        // Divide by (B + 4D + a|u| + ikωC).
        const dRe = T.ebmRadiation + 4 * D + cx + cy
        const dIm = k * omega * capacity[i]
        const dd = dRe * dRe + dIm * dIm
        re[i] = (fRe * dRe + fIm * dIm) / dd
        im[i] = (fIm * dRe - fRe * dIm) / dd
      }
    }
    for (let m = 0; m < months; m++) {
      const phase = (2 * Math.PI * k * (m + 0.5)) / months
      const c = Math.cos(phase)
      const s = Math.sin(phase)
      for (let i = 0; i < n; i++) out[m * n + i] += re[i] * c - im[i] * s
    }
  }
  return out
}

// Daily-mean insolation, W/m², at a latitude (radians, + north) and a time
// of year (0..1 from 1 January), for the planet's orbit. The top
// hemisphere's summer solstice falls in late June; perihelion sits
// `precessionDeg + 90°` of solar longitude past the vernal equinox, so 0
// puts it in the top hemisphere's summer (planetForcing.seasonalityFactor).
export function monthInsolation(latNorth: number, yearFraction: number, planet: PlanetForcing): number {
  const lambda = 2 * Math.PI * (yearFraction - CLIMATE_TUNING.ebmVernalEquinoxYear)
  const decl = Math.asin(Math.sin(planet.obliquityDeg * RAD) * Math.sin(lambda))
  const perihelion = (planet.precessionDeg + 90) * RAD
  const e = planet.eccentricity
  const distance = ((1 + e * Math.cos(lambda - perihelion)) / (1 - e * e)) ** 2
  const x = -Math.tan(latNorth) * Math.tan(decl)
  const h0 = x >= 1 ? 0 : x <= -1 ? Math.PI : Math.acos(x)
  const q = (CLIMATE_TUNING.ebmSolarWm2 * planet.solarConstant / Math.PI) * distance
    * (h0 * Math.sin(latNorth) * Math.sin(decl) + Math.cos(latNorth) * Math.cos(decl) * Math.sin(h0))
  return Math.max(0, q)
}
