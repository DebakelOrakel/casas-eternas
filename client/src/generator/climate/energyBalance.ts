import { CLIMATE_RES_X, CLIMATE_RES_Y, shiftedYNorm } from './climateField'
import { CLIMATE_TUNING } from './climateTuneParams'
import type { DomainGrid } from '../core/domain'
import type { PlanetForcing } from '../planet/planetForcing'
import { detAcos, detAsin, detCos, detSin, detTan, sq } from '../core/detMath'
import { CyclicLine, LINE_COUPLING } from './cyclicLine'

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
//
// THE METRIC (DEC-0035, fork 5, step 4e), as the ocean currents' solve has
// it: the exchange is the grid's finite-volume Laplacian, per cell area —
// east and west wE / A (wE = 1 / rowScale), north and south the row edges'
// edgeScale / A (0 across a pole, which is a point) — and the wind's
// carry east-west is per length (÷ rowScale). The rows where the
// east-west coupling dominates (the sphere from about 45°) are relaxed as
// LINES (cyclicLine.ts), each row at once against its neighbours north and
// south; point Gauss-Seidel would leave them near their start. On the
// torus every weight is 1, no row is a line, and the arithmetic is the
// torus's, operation for operation.

// The months' temperature departures, °C, month-major (month 0 January).
// `annualTemperature` gives the albedo (ice below `ebmIceBelowC`), `land`
// the heat capacity, `wind` the transport (the history's banded wind: the
// pressure wind needs these temperatures first), `grid` the climate grid.
export function seasonalCycle(land: Uint8Array, annualTemperature: Float32Array, wind: Float32Array, grid: DomainGrid, planet: PlanetForcing, equatorOffset: number, months: number): Float32Array {
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
      upwindX[i] = grid.index(gx - Math.sign(u), gy)
      upwindY[i] = grid.index(gx, gy - Math.sign(v))
      carryX[i] = Math.abs(u) * T.ebmCarryPerWind * (1 / grid.rowScale(gy))
      carryY[i] = Math.abs(v) * T.ebmCarryPerWind
    }
  }
  // Per row: the exchange's weights over the cell's area, and their sum.
  const eW = new Float64Array(RY)
  const nW = new Float64Array(RY)
  const sW = new Float64Array(RY)
  const ring = new Float64Array(RY)
  const lines: (CyclicLine | null)[] = []
  for (let gy = 0; gy < RY; gy++) {
    const a = grid.cellArea(gy)
    eW[gy] = 1 / grid.rowScale(gy) / a
    nW[gy] = grid.edgeScale(gy) / a
    sW[gy] = grid.edgeScale(gy + 1) / a
    ring[gy] = 2 * eW[gy] + nW[gy] + sW[gy]
    lines.push(eW[gy] > LINE_COUPLING ? new CyclicLine(RX) : null)
  }
  const left = new Int32Array(n)
  const right = new Int32Array(n)
  const up = new Int32Array(n)
  const down = new Int32Array(n)
  for (let gy = 0; gy < RY; gy++) {
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      left[i] = grid.index(gx - 1, gy)
      right[i] = grid.index(gx + 1, gy)
      up[i] = grid.index(gx, gy - 1)
      down[i] = grid.index(gx, gy + 1)
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
        sunRe[gy] += (2 / months) * monthlySun[gy * months + m] * detCos(phase)
        sunIm[gy] -= (2 / months) * monthlySun[gy * months + m] * detSin(phase)
      }
    }
    // Gauss-Seidel on the complex amplitude, in place.
    const re = new Float64Array(n)
    const im = new Float64Array(n)
    // One row as a line: east and west (and the carry from there) on the
    // unknowns, north and south (and their carry) from the iterate.
    const relaxRow = (line: CyclicLine, row: number, harmonic: number): void => {
      const D = T.ebmExchange
      const base = row * RX
      for (let x = 0; x < RX; x++) {
        const i = base + x
        const cx = carryX[i]
        const cy = carryY[i]
        let west = -D * eW[row]
        let east = -D * eW[row]
        if (upwindX[i] === left[i]) west -= cx
        else if (upwindX[i] === right[i]) east -= cx
        line.lower[x] = west
        line.upper[x] = east
        line.diagRe[x] = T.ebmRadiation + D * ring[row] + cx + cy
        line.diagIm[x] = harmonic * omega * capacity[i]
        line.rhsRe[x] = absorbed[i] * sunRe[row] + D * (nW[row] * re[up[i]] + sW[row] * re[down[i]]) + cy * re[upwindY[i]]
        line.rhsIm[x] = absorbed[i] * sunIm[row] + D * (nW[row] * im[up[i]] + sW[row] * im[down[i]]) + cy * im[upwindY[i]]
      }
      line.solve()
      for (let x = 0; x < RX; x++) {
        re[base + x] = line.outRe[x]
        im[base + x] = line.outIm[x]
      }
    }
    const D = T.ebmExchange
    for (let iter = 0; iter < T.ebmSolveIters; iter++) {
      for (let i = 0; i < n; i++) {
        const row = (i / RX) | 0
        const line = lines[row]
        if (line !== null) {
          // The whole row at once (its first cell starts it), then on.
          relaxRow(line, row, k)
          i += RX - 1
          continue
        }
        const cx = carryX[i]
        const cy = carryY[i]
        const fRe = absorbed[i] * sunRe[row] + D * (eW[row] * (re[left[i]] + re[right[i]]) + nW[row] * re[up[i]] + sW[row] * re[down[i]]) + cx * re[upwindX[i]] + cy * re[upwindY[i]]
        const fIm = absorbed[i] * sunIm[row] + D * (eW[row] * (im[left[i]] + im[right[i]]) + nW[row] * im[up[i]] + sW[row] * im[down[i]]) + cx * im[upwindX[i]] + cy * im[upwindY[i]]
        // Divide by (B + 4D + a|u| + ikωC) — 4D the ring of weights times D.
        const dRe = T.ebmRadiation + D * ring[row] + cx + cy
        const dIm = k * omega * capacity[i]
        const dd = dRe * dRe + dIm * dIm
        re[i] = (fRe * dRe + fIm * dIm) / dd
        im[i] = (fIm * dRe - fRe * dIm) / dd
      }
    }
    for (let m = 0; m < months; m++) {
      const phase = (2 * Math.PI * k * (m + 0.5)) / months
      const c = detCos(phase)
      const s = detSin(phase)
      for (let i = 0; i < n; i++) out[m * n + i] += re[i] * c - im[i] * s
    }
  }
  // A pole row is one point: its cycle one value per month (the land and
  // the sea of the row apart; a no-op on the torus).
  const landMask = land
  const seaMask = new Uint8Array(n)
  for (let i = 0; i < n; i++) seaMask[i] = land[i] ? 0 : 1
  for (let m = 0; m < months; m++) {
    const month = out.subarray(m * n, (m + 1) * n)
    grid.averagePoleRows(month, landMask)
    grid.averagePoleRows(month, seaMask)
  }
  return out
}

// Daily-mean insolation, W/m², at a latitude (radians, + north) and a time
// of year (0..1 from 1 January), for the planet's orbit. The top
// hemisphere's summer solstice falls in late December (climateField.
// TOP_SUMMER_MONTH); perihelion sits
// `precessionDeg + 90°` of solar longitude past the vernal equinox, so 0
// puts it in the top hemisphere's summer (planetForcing.seasonalityFactor).
export function monthInsolation(latNorth: number, yearFraction: number, planet: PlanetForcing): number {
  const lambda = 2 * Math.PI * (yearFraction - CLIMATE_TUNING.ebmVernalEquinoxYear)
  const decl = detAsin(detSin(planet.obliquityDeg * RAD) * detSin(lambda))
  const perihelion = (planet.precessionDeg + 90) * RAD
  const e = planet.eccentricity
  const distance = sq((1 + e * detCos(lambda - perihelion)) / (1 - e * e))
  const x = -detTan(latNorth) * detTan(decl)
  const h0 = x >= 1 ? 0 : x <= -1 ? Math.PI : detAcos(x)
  const q = (CLIMATE_TUNING.ebmSolarWm2 * planet.solarConstant / Math.PI) * distance
    * (h0 * detSin(latNorth) * detSin(decl) + detCos(latNorth) * detCos(decl) * detSin(h0))
  return Math.max(0, q)
}
