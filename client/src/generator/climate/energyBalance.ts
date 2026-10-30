import { latitudeOfNorm, shiftedNorm } from './climateField'
import { CLIMATE_TUNING } from './climateTuneParams'
import type { ClimateTerrain } from './climateMesh'
import type { CellVectors } from './wind'
import type { PlanetForcing } from '../planet/planetForcing'
import { aggregate, solveBiCGSTAB, sparseApply, sparseMatrix, twoLevelPreconditioner, type SolveReport } from '../fields/fieldOperators'
import { detAcos, detAsin, detCos, detSin, detTan, sq } from '../core/detMath'

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
// outgoing radiation's sensitivity B, exchange with the neighbouring air D,
// and the air carried by the wind (a per unit of wind). Linear, so the
// periodic answer is found directly, one annual harmonic at a time: for
// e^{ikωt}, (ikωC + B) T̂ − D ∇²T̂ + a (u · ∇) T̂ = (1 − α) Ŝ_k. Two
// harmonics (the year and the half year) carry nearly all of the cycle. No
// spin-up, and no year to wait for the sea to settle.
//
// The annual MEAN stays the cheap model's (climate/temperature.ts): the
// step-0 levers are calibrated there. This supplies the cycle around it.
//
// ON THE CLIMATE'S FIELD MESH (DEC-0036 phase 4, climateMesh.ts), both
// shapes, one code: D ∇² the finite-volume Laplacian (D in W/K,
// `ebmDiffusionWPerK`), the carry first-order upwind over the walls — each
// wall the wind enters by brings its neighbour's value, a |u · n| · wall
// (Tᵢ − Tⱼ) / Aᵢ with the wall's wind the mean of the two cells' —, the
// complex system per harmonic in its real form (2 unknowns a cell) solved by
// BiCGSTAB with a two-level preconditioner, to a relative residual of
// 1e-10. The former raster's Gauss-Seidel sweeps,
// cyclic line solves past 45° and pole-row averaging are gone.

// The months' temperature departures, °C, month-major (month 0 January),
// per cell of the climate's mesh, and the two solves' reports.
// `annualTemperature` gives the albedo (ice below `ebmIceBelowC`), the
// terrain's land the heat capacity, `wind` the transport (the history's
// banded wind: the pressure wind needs these temperatures first).
export interface SeasonalCycle {
  cycle: Float64Array
  solves: SolveReport[]
}

// The coarse correction's patches: cells within this many links (as the
// currents', oceanCurrents.ts; each link two steps in the real form).
const EBM_AGGREGATE_HOPS = 12

export function seasonalCycle(terrain: ClimateTerrain, annualTemperature: ArrayLike<number>, wind: CellVectors, planet: PlanetForcing, equatorOffset: number, months: number): SeasonalCycle {
  const { cm, land } = terrain
  const fm = cm.mesh
  const n = fm.count
  const { nbrStart, nbr, coupling, area, wall, dist, offE, offS, turnC, turnS } = fm
  const T = CLIMATE_TUNING
  const omega = (2 * Math.PI) / YEAR_S

  // The sun's monthly departure per latitude, then its first two
  // harmonics; one evaluation per distinct latitude (a torus row's cells
  // share theirs).
  const harmonics = new Map<number, Float64Array>()
  const sunOf = (yNorm: number): Float64Array => {
    let h = harmonics.get(yNorm)
    if (h) return h
    const latNorth = (0.5 - yNorm) * Math.PI // + in the top hemisphere
    const sun = new Float64Array(months)
    let mean = 0
    for (let m = 0; m < months; m++) {
      sun[m] = monthInsolation(latNorth, (m + 0.5) / months, planet)
      mean += sun[m] / months
    }
    // [re1, im1, re2, im2]: Ŝ_k = (2/M) Σ S'_m e^{−ikωt_m}, so S'(t) ≈ Re Σ_k Ŝ_k e^{ikωt}.
    h = new Float64Array(4)
    for (let k = 1; k <= 2; k++) {
      for (let m = 0; m < months; m++) {
        const phase = (2 * Math.PI * k * (m + 0.5)) / months
        h[2 * k - 2] += (2 / months) * (sun[m] - mean) * detCos(phase)
        h[2 * k - 1] -= (2 / months) * (sun[m] - mean) * detSin(phase)
      }
    }
    harmonics.set(yNorm, h)
    return h
  }
  const sun = new Array<Float64Array>(n)
  for (let i = 0; i < n; i++) sun[i] = sunOf(shiftedNorm(cm.yNorm[i], equatorOffset))

  // Per cell: the absorbed share and the heat capacity; per edge the
  // operator's off-diagonal weight (the exchange and, where the wind comes
  // in over the wall, the carry), per cell the real diagonal — all times
  // the cell's area.
  const absorbed = new Float64Array(n)
  const capacity = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const ice = annualTemperature[i] < T.ebmIceBelowC
    const albedo = ice ? T.ebmAlbedoIce : land[i] ? T.ebmAlbedoLand : T.ebmAlbedoSea
    absorbed[i] = 1 - albedo
    // Sea that freezes over in winter is capped by its ice and swings like
    // land: without this the polar coasts had a 9 °C year (Earth's run to
    // some 30 °C). A linear model cannot let the ice come and go with the
    // season, so the annual mean decides.
    const frozen = !land[i] && annualTemperature[i] < T.ebmSeaIceBelowC
    capacity[i] = land[i] || frozen ? T.ebmCapacityLand : T.ebmCapacitySea
  }
  const weight = new Float64Array(nbr.length)
  const diag = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let d = T.ebmRadiation * area[i]
    for (let e = nbrStart[i]; e < nbrStart[i + 1]; e++) {
      const j = nbr[e]
      // The wall's wind: the mean of the two cells', the neighbour's
      // carried into this cell's frame; inflow where it points inward.
      const c = turnC[e]
      const sn = turnS[e]
      const ue = 0.5 * (wind.e[i] + c * wind.e[j] - sn * wind.s[j])
      const us = 0.5 * (wind.s[i] + sn * wind.e[j] + c * wind.s[j])
      const inflow = Math.max(0, -(ue * offE[e] + us * offS[e]) / dist[e]) * wall[e]
      const w = T.ebmDiffusionWPerK * coupling[e] + T.ebmCarryPerWindM * inflow
      weight[e] = w
      d += w
    }
    diag[i] = d
  }

  const cycle = new Float64Array(months * n)
  const solves: SolveReport[] = []
  // The real form, interleaved: unknown 2i is cell i's real part, 2i + 1
  // its imaginary part; the row pair of cell i is
  //   diag·re − Σ w·re_j − ωkCA·im = A·a·Ŝre,
  //   ωkCA·re + diag·im − Σ w·im_j = A·a·Ŝim.
  // The preconditioner: ILU(0) with a coarse correction on patches of
  // cells, the real and the imaginary parts apart
  // (fieldOperators.twoLevelPreconditioner).
  const x = new Float64Array(2 * n)
  const b = new Float64Array(2 * n)
  for (let k = 1; k <= 2; k++) {
    const rows: [number, number][][] = []
    for (let i = 0; i < n; i++) {
      const wk = k * omega * capacity[i] * area[i]
      const re: [number, number][] = [[2 * i, diag[i]], [2 * i + 1, -wk]]
      const im: [number, number][] = [[2 * i, wk], [2 * i + 1, diag[i]]]
      for (let e = nbrStart[i]; e < nbrStart[i + 1]; e++) {
        re.push([2 * nbr[e], -weight[e]])
        im.push([2 * nbr[e] + 1, -weight[e]])
      }
      rows.push(re, im)
      b[2 * i] = area[i] * absorbed[i] * sun[i][2 * k - 2]
      b[2 * i + 1] = area[i] * absorbed[i] * sun[i][2 * k - 1]
    }
    const matrix = sparseMatrix(rows)
    const patches = aggregate(matrix, EBM_AGGREGATE_HOPS)
    const of = new Int32Array(2 * n)
    for (let u = 0; u < 2 * n; u++) of[u] = 2 * patches.of[u] + (u & 1)
    x.fill(0)
    solves.push(solveBiCGSTAB(2 * n, (v, out) => sparseApply(matrix, v, out), twoLevelPreconditioner(matrix, { of, count: 2 * patches.count }), b, x, { tolerance: 1e-10, maxIterations: 2000 }))
    for (let m = 0; m < months; m++) {
      const phase = (2 * Math.PI * k * (m + 0.5)) / months
      const c = detCos(phase)
      const s = detSin(phase)
      for (let i = 0; i < n; i++) cycle[m * n + i] += x[2 * i] * c - x[2 * i + 1] * s
    }
  }
  dampTropicalLand(cycle, terrain, equatorOffset, months)
  return { cycle, solves }
}

// THE TROPICS' WEAK TEMPERATURE GRADIENT (DES-0027 entry 10, 2026-10-30).
// In the tropics the Coriolis force is weak, and the air evens out its
// temperature over thousands of kilometres within days: a tropical land's
// year follows the sea around it more closely than a linear balance with
// a local damping lets it. Without it the land's winters at 10–20° came
// out too cold (the annual range's median 10–12 °C, Earth's 5–9) and a
// highland margin fell under 18 °C in its coldest month: Cwa. So the
// land's departure is damped by `ebmTropicDamping` up to
// `ebmTropicFullDeg` from the equator, less toward `ebmTropicNoneDeg` (a
// smoothstep), and not past it. The sea keeps its cycle.
function dampTropicalLand(cycle: Float64Array, terrain: ClimateTerrain, equatorOffset: number, months: number): void {
  const { cm, land } = terrain
  const n = land.length
  const T = CLIMATE_TUNING
  const span = T.ebmTropicNoneDeg - T.ebmTropicFullDeg
  for (let i = 0; i < n; i++) {
    if (land[i] === 0) continue
    const phi = latitudeOfNorm(shiftedNorm(cm.yNorm[i], equatorOffset)) * 90
    const s = Math.min(Math.max((phi - T.ebmTropicFullDeg) / span, 0), 1)
    const keep = 1 - T.ebmTropicDamping * (1 - s * s * (3 - 2 * s))
    for (let m = 0; m < months; m++) cycle[m * n + i] *= keep
  }
}

// Daily-mean insolation, W/m², at a latitude (radians, + north) and a time
// of year (0..1 from 1 January), for the planet's orbit. The top
// hemisphere's summer solstice falls in late December (climateField.
// TOP_SUMMER_MONTH); perihelion sits
// `precessionDeg + 90°` of solar longitude past the vernal equinox, so 0
// puts it in the top hemisphere's summer (the engine's
// seasonality_factor, planet/planet_forcing.rs).
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
