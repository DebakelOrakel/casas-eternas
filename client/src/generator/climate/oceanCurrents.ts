import { latitudeOfNorm, shiftedNorm } from './climateField'
import { CLIMATE_TUNING } from './climateTuneParams'
import { meshComponents, type ClimateTerrain } from './climateMesh'
import type { CellVectors } from './wind'
import type { FieldMesh } from '../fields/fieldMesh'
import { aggregate, computeDepartures, conjugateGradient, departures, divergence, eastWallNormals, gradient, solveBiCGSTAB, sparseApply, sparseMatrix, transportScalar, twoLevelPreconditioner, type Departures, type SolveReport } from '../fields/fieldOperators'
import { detCos, detExp, detHypot, detSin } from '../core/detMath'

// THE OCEAN ON THE CLIMATE'S FIELD MESH (DEC-0036 phase 4, docs/decisions/
// fields-on-meshes.md): the wind-driven currents, the sea surface they
// make, the Ekman upwelling and the overturning's inflow, per cell of the
// climate's mesh (climateMesh.ts), both shapes, one code. Lengths are the
// mesh's metres; a vector is an east/south pair in each cell's own frame.
// The land is the terrain's (ClimateTerrain.land, the texel under each
// cell's centre, dry floors included); the landmasses and the seas are the
// connected parts of the mesh's graph (climateMesh.meshComponents). No pole
// rows, no line solves: the solves are sparse ones over the cells
// (fields/fieldOperators.ts), run to a residual, not a sweep count.

// The currents per sea cell, normalised to a fastest cell of 1, 0 on land;
// the stream function they come from; the solve's report.
export interface OceanCurrents extends CellVectors {
  psi: Float64Array
  solve: SolveReport
  // The landmasses that carry a stream function of their own (the island
  // rule), and all of them.
  islands: number
  landmasses: number
}

// Wind-driven ocean surface currents as gyres. Solves a streamfunction ψ
// forced by the wind-stress curl, then derives the (non-divergent)
// velocity, normalised to a fastest cell of 1, zero on land. The velocity
// sign is set so subtropical gyres carry WARM water poleward along western
// ocean boundaries (mild eastern continental coasts) and COLD water
// equatorward along eastern ocean boundaries (cool, upwelling western
// continental coasts) — validated against that pattern. See
// docs/decisions/climate-biomes.md.
//
// The equation is Stommel's (2026-09-28, docs/design/climate-refinement.md):
// ∇²ψ + β ∂ψ/∂x = curl τ, with friction 1 and β = cos φ /
// `currentsBoundaryWidthM` (the Coriolis parameter grows toward the poles;
// the same sign in both hemispheres). The β term makes the gyres
// asymmetric: a narrow, fast current on the western side of a basin (Gulf
// Stream, Kuroshio), broad slow flow on the eastern side.
//
// The curl is the wind's, as a field on the globe: the divergence of the
// wind turned by 90° in each cell's frame, (s, −e), whose divergence is
// ∂s/∂x − ∂e/∂y with y south (the former raster's quantity, the curl about
// the downward axis). The velocity is ψ's gradient turned back, (−∂ψ/∂y,
// ∂ψ/∂x) in east/south.
//
// Each landmass is an island with a ψ of its own (the island rule), not ψ =
// 0 for all land: the largest by area is the reference at 0, every other
// one is one unknown, whose equation is the sum of its cells' equations —
// the circulation around its coast. So net flow passes between two
// landmasses, and an open zonal band gives a circumpolar current.
// `equatorOffset` places the latitude for β (climateField.shiftedNorm).
export function computeOceanCurrents(terrain: ClimateTerrain, wind: CellVectors, equatorOffset = 0): OceanCurrents {
  const { cm, land } = terrain
  const fm = cm.mesh
  const n = fm.count
  const beta = new Float64Array(n)
  for (let i = 0; i < n; i++) beta[i] = detCos((latitudeOfNorm(shiftedNorm(cm.yNorm[i], equatorOffset)) * Math.PI) / 2) / CLIMATE_TUNING.currentsBoundaryWidthM
  const turnedE = wind.s
  const turnedS = new Float64Array(n)
  for (let i = 0; i < n; i++) turnedS[i] = -wind.e[i]
  const curl = divergence(fm, turnedE, turnedS, new Float64Array(n))
  const solution = solveStommel(fm, land, beta, curl)
  const { psi } = solution
  const gE = new Float64Array(n)
  const gS = new Float64Array(n)
  gradient(fm, psi, gE, gS)
  const e = new Float64Array(n)
  const s = new Float64Array(n)
  let vmax = 1e-9
  for (let i = 0; i < n; i++) {
    if (land[i]) continue
    e[i] = -gS[i]
    s[i] = gE[i]
    vmax = Math.max(vmax, detHypot(e[i], s[i]))
  }
  for (let i = 0; i < n; i++) {
    e[i] /= vmax
    s[i] /= vmax
  }
  return { e, s, psi, solve: solution.solve, islands: solution.islands, landmasses: solution.landmasses }
}

// THE STOMMEL SOLVE on a field mesh: ∇²ψ + β ∂ψ/∂x = curl over the sea
// cells (land 1 in `land`), ψ = 0 on the largest landmass, one unknown ψ
// per other landmass that touches the sea (the island rule above). `beta`
// per cell, 1 / m; `curl` per cell. Finite volumes: the Laplacian's flux
// k (ψj − ψi) across each wall, the β term as the flux of β ψ carried due
// east, wallEast · β_face · (ψi + ψj) / 2 (fieldOperators.eastWallNormals:
// the east unit field is divergence-free on both shapes and β varies only
// with latitude, so div(β ψ ê) = β ∂ψ/∂x). Both fluxes are antisymmetric,
// so an island's equation — its cells' equations summed — telescopes to
// the walls of its coast, exactly. The β term's central difference keeps
// the system diagonally dominant while β times a wall's spacing stays under
// 2. Not symmetric: BiCGSTAB with a two-level preconditioner (below), to
// a relative residual of 1e-10. A world without land has no reference:
// its first sea cell holds ψ = 0 (the constants are the operator's null
// space but for the β term's rounding).
export interface StommelSolution {
  psi: Float64Array
  solve: SolveReport
  islands: number
  landmasses: number
}

// The coarse correction's patches: cells within this many links.
const STOMMEL_AGGREGATE_HOPS = 6

export function solveStommel(fm: FieldMesh, land: Uint8Array, beta: ArrayLike<number>, curl: ArrayLike<number>): StommelSolution {
  const n = fm.count
  const { nbrStart, nbr, coupling, area } = fm
  const wallEast = eastWallNormals(fm)
  const lands = meshComponents(fm, land)
  let reference = -1
  for (let id = 0; id < lands.cells.length; id++) if (reference < 0 || lands.area[id] > lands.area[reference]) reference = id
  // The unknowns: each island that touches the sea, then each sea cell.
  const islandColumn = new Int32Array(lands.cells.length).fill(-1)
  let unknowns = 0
  for (let id = 0; id < lands.cells.length; id++) {
    if (id === reference) continue
    let coast = false
    for (const c of lands.cells[id]) {
      for (let e = nbrStart[c]; e < nbrStart[c + 1] && !coast; e++) if (!land[nbr[e]]) coast = true
      if (coast) break
    }
    if (coast) islandColumn[id] = unknowns++
  }
  const column = new Int32Array(n).fill(-1)
  let pinned = -1
  for (let i = 0; i < n; i++) {
    if (land[i]) continue
    if (reference < 0 && pinned < 0) {
      pinned = i
      continue
    }
    column[i] = unknowns++
  }
  const colOf = (j: number): number => (land[j] ? islandColumn[lands.label[j]] : column[j])

  // The rows, each multiplied by −1 so the Laplacian's diagonal is
  // positive: the flux terms of edge e (cell i to j), ψi's share on the
  // diagonal, ψj's in its column (none where ψj = 0).
  const rows = new Array<[number, number][]>(unknowns)
  const rhs = new Float64Array(unknowns)
  const edge = (row: [number, number][], self: number, i: number, e: number): void => {
    const j = nbr[e]
    const b = 0.5 * (beta[i] + beta[j]) * wallEast[e] * 0.5
    row.push([self, coupling[e] - b])
    const c = colOf(j)
    if (c >= 0) row.push([c, -(coupling[e] + b)])
  }
  for (let i = 0; i < n; i++) {
    const self = column[i]
    if (self < 0) continue
    const row: [number, number][] = []
    for (let e = nbrStart[i]; e < nbrStart[i + 1]; e++) edge(row, self, i, e)
    rows[self] = row
    rhs[self] = -area[i] * curl[i]
  }
  for (let id = 0; id < lands.cells.length; id++) {
    const self = islandColumn[id]
    if (self < 0) continue
    const row: [number, number][] = []
    let sum = 0
    for (const c of lands.cells[id]) {
      sum += area[c] * curl[c]
      for (let e = nbrStart[c]; e < nbrStart[c + 1]; e++) if (!land[nbr[e]]) edge(row, self, c, e)
    }
    rows[self] = row
    rhs[self] = -sum
  }
  // The preconditioner: ILU(0) with a coarse correction on patches of the
  // sea and on each island (fieldOperators.twoLevelPreconditioner). On the
  // bench worlds (2048 × 1024, 10 and 25 islands) ILU(0) alone took
  // 200–280 iterations to 1e-8 (the islands, whose rows are long, doubled
  // them; Jacobi took 1100 on a test world of five), the two levels 34–38
  // at a patch of 6 links' radius, 45–47 to 1e-10 (a radius of 10: 53–56
  // to 1e-8; of 3: 19, but its thousands of patches make the coarse matrix
  // dear to factor).
  const x = new Float64Array(unknowns)
  let solve: SolveReport = { iterations: 0, residual: 0, converged: true, removedMean: 0 }
  if (unknowns > 0) {
    const matrix = sparseMatrix(rows)
    const pre = twoLevelPreconditioner(matrix, aggregate(matrix, STOMMEL_AGGREGATE_HOPS))
    solve = solveBiCGSTAB(unknowns, (v, out) => sparseApply(matrix, v, out), pre, rhs, x, { tolerance: 1e-10, maxIterations: 2000 })
  }
  const psi = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const c = colOf(i)
    if (c >= 0) psi[i] = x[c]
  }
  let islands = 0
  for (let id = 0; id < islandColumn.length; id++) if (islandColumn[id] >= 0) islands++
  return { psi, solve, islands, landmasses: lands.cells.length }
}

// The flow of the overturning: [east, south] per sea cell, 0 on land,
// scaled so its fastest cell is 1, and its solve.
export interface OceanFlow extends CellVectors {
  solve: SolveReport
}

// THE OVERTURNING'S SURFACE INFLOW (build step 9 of
// docs/design/climate-refinement.md): the surface water drawn toward where
// it sinks. The wind-driven currents above are a streamfunction, flow with
// no sources or sinks; a sinking sea is a sink, so its inflow is the other
// half of a velocity field, a potential: ∇²χ = −s, u = ∇χ, with the sinking
// as `s` and the water that sank coming up again spread over the SEA IT
// SANK IN (each connected sea its own balance), and no flow into a coast
// (no flux across a wall to land). The system per sea is the Neumann
// Laplacian, symmetric and singular with the constants as null space; with
// the sea's own balance the right-hand side is orthogonal to it and
// conjugate gradients converge (to 1e-10; the potential's mean per sea set
// to 0). Until DEC-0036 phase 4 the water rose over the whole ocean, so an
// enclosed sea that sank (or one that did not) had no balance of its own,
// and the 700 Gauss-Seidel sweeps converged on neither shape.
// The gradient at a coast reads a land neighbour as the cell's own value.
export function computeSinkInflow(terrain: ClimateTerrain, sink: ArrayLike<number>): OceanFlow {
  const { cm, land } = terrain
  const fm = cm.mesh
  const n = fm.count
  const { nbrStart, nbr, coupling, area, gradE, gradS } = fm
  const sea = new Uint8Array(n)
  for (let i = 0; i < n; i++) sea[i] = land[i] ? 0 : 1
  const seas = meshComponents(fm, sea)
  const sank = new Float64Array(seas.cells.length)
  let total = 0
  for (let id = 0; id < seas.cells.length; id++) {
    for (const c of seas.cells[id]) sank[id] += area[c] * sink[c]
    total += sank[id]
  }
  const e = new Float64Array(n)
  const s = new Float64Array(n)
  if (!(total > 0)) return { e, s, solve: { iterations: 0, residual: 0, converged: true, removedMean: 0 } }
  const b = new Float64Array(n)
  const diag = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    if (!sea[i]) continue
    const id = seas.label[i]
    b[i] = area[i] * (sink[i] - sank[id] / seas.area[id])
    for (let k = nbrStart[i]; k < nbrStart[i + 1]; k++) if (sea[nbr[k]]) diag[i] += coupling[k]
    // A sea cell without a sea neighbour is a sea of its own: balanced.
    if (diag[i] === 0) b[i] = 0
  }
  const apply = (x: ArrayLike<number>, out: Float64Array): void => {
    for (let i = 0; i < n; i++) {
      if (!sea[i]) {
        out[i] = 0
        continue
      }
      const xi = x[i]
      let v = 0
      for (let k = nbrStart[i]; k < nbrStart[i + 1]; k++) {
        const j = nbr[k]
        if (sea[j]) v += coupling[k] * (xi - x[j])
      }
      out[i] = v
    }
  }
  const chi = new Float64Array(n)
  const solve = conjugateGradient(n, apply, diag, b, chi, { tolerance: 1e-10, maxIterations: 5000 })
  for (let id = 0; id < seas.cells.length; id++) {
    let m = 0
    for (const c of seas.cells[id]) m += area[c] * chi[c]
    m /= seas.area[id]
    for (const c of seas.cells[id]) chi[c] -= m
  }
  let fastest = 0
  for (let i = 0; i < n; i++) {
    if (!sea[i]) continue
    let ge = 0
    let gs = 0
    for (let k = nbrStart[i]; k < nbrStart[i + 1]; k++) {
      const j = nbr[k]
      if (!sea[j]) continue
      const d = chi[j] - chi[i]
      ge += gradE[k] * d
      gs += gradS[k] * d
    }
    e[i] = ge
    s[i] = gs
    fastest = Math.max(fastest, detHypot(ge, gs))
  }
  if (fastest > 0) {
    for (let i = 0; i < n; i++) {
      e[i] /= fastest
      s[i] /= fastest
    }
  }
  return { e, s, solve }
}

// Ekman upwelling (build step 3 of docs/design/climate-refinement.md): the
// wind pushes the surface water at a right angle to itself, to the right in
// the northern hemisphere and to the left in the southern (transport = τ ×
// k / f). Where that transport diverges — off a coast the wind runs along,
// and at the equator under the trade winds, where f changes sign — cold
// water comes up from below. Returns the divergence per sea cell, positive
// where water comes up, 0 on land, in the transport's units per 62.4 km
// (`climateGradientLengthM`, the former climate cell). The divergence over
// the cell's walls, a wall with land on either side carrying nothing
// (fieldOperators.divergence within the sea): a coast cell with the water
// leaving it takes the whole transport as upwelling.
export function computeUpwelling(terrain: ClimateTerrain, wind: CellVectors, equatorOffset: number, rotationHours: number): Float64Array {
  const { cm, land } = terrain
  const fm = cm.mesh
  const n = fm.count
  const te = new Float64Array(n)
  const ts = new Float64Array(n)
  const sea = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    if (land[i]) continue
    sea[i] = 1
    const yNorm = shiftedNorm(cm.yNorm[i], equatorOffset)
    const sign = yNorm < 0.5 ? 1 : -1
    // f, northern (top) hemisphere positive, held off zero near the
    // equator with its sign kept, so the transport stays finite there.
    const f = sign * Math.max(CLIMATE_TUNING.upwellingMinF, Math.abs(detSin((latitudeOfNorm(yNorm) * Math.PI) / 2))) * (24 / rotationHours)
    // τ × k / f in north-up axes is (τ_north, −τ_east) / f; in east/south:
    // east −s / f, south e / f.
    te[i] = -wind.s[i] / f
    ts[i] = wind.e[i] / f
  }
  const out = divergence(fm, te, ts, new Float64Array(n), sea)
  for (let i = 0; i < n; i++) out[i] *= CLIMATE_TUNING.climateGradientLengthM
  return out
}

// The sea's anomaly on the land, °C per land cell: the air takes the anomaly
// of the sea it last crossed and loses it over land, e^(−d / L) after d
// metres (`currentsInlandDecayM`), looked for up to `currentsInlandReachM`
// upwind along `wind` in steps of the mesh's spacing (the first step
// undecayed). So the westerlies carry the North Atlantic's warmth deep into
// Europe, and a coast the wind leaves for the sea (an east coast in the
// westerlies, a west coast in the trades) gets only the breeze off its own
// shore: `currentsCoastalLeeShare` of its strongest neighbouring sea cell.
// Until 2026-09-29 every coast took its neighbour's anomaly the same way,
// four cells in, whatever the wind, and Europe's interior got little of the
// North Atlantic's (on Earth's relief Oslo's year came out 4 °C too cold,
// now 1). The march goes along the great circle (Domain.advance), the cell
// under each point its nearest centre.
export function carryInland(terrain: ClimateTerrain, seaAnomaly: ArrayLike<number>, wind: CellVectors): Float64Array {
  const { cm, land, domain } = terrain
  const { mesh: fm, sampler } = cm
  const n = fm.count
  const out = new Float64Array(n)
  const step = cm.cellM
  const steps = Math.max(1, Math.round(CLIMATE_TUNING.currentsInlandReachM / step))
  const p = { x: 0, y: 0 }
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue
    let lee = 0
    for (let e = fm.nbrStart[i]; e < fm.nbrStart[i + 1]; e++) {
      const j = fm.nbr[e]
      const a = land[j] ? 0 : seaAnomaly[j]
      if (Math.abs(a) > Math.abs(lee)) lee = a
    }
    let carried = 0
    const u = wind.e[i]
    const v = wind.s[i]
    const speed = detHypot(u, v)
    if (speed > 0) {
      for (let k = 1; k <= steps; k++) {
        const d = (k * step) / fm.unitM
        domain.advance(fm.x[i], fm.y[i], -(u / speed) * d, -(v / speed) * d, p)
        const j = sampler.nearestCell(domain.wrapX(p.x), domain.wrapY(p.y))
        if (land[j]) continue
        carried = seaAnomaly[j] * detExp(-((k - 1) * step) / CLIMATE_TUNING.currentsInlandDecayM)
        break
      }
    }
    const breeze = lee * CLIMATE_TUNING.currentsCoastalLeeShare
    out[i] = Math.abs(carried) > Math.abs(breeze) ? carried : breeze
  }
  return out
}

// The departures of the sea's surface along normalised currents for one
// pass of the transport: `currentsAdvectStepM` along the current
// (fields/fieldOperators.computeDepartures, the midpoint rule along the
// great circle). The sea-surface temperature's and the salt's.
export function currentDepartures(terrain: ClimateTerrain, currents: CellVectors): Departures {
  const { mesh, sampler } = terrain.cm
  return computeDepartures(mesh, sampler, currents.e, currents.s, CLIMATE_TUNING.currentsAdvectStepM, departures(mesh))
}

// Applies the ocean currents' heat transport to the temperature (°C per
// cell, in place): advects a sea-surface temperature (seeded from the
// temperature as it comes, the latitude's base on the sea) along the
// currents, `currentsAdvectIters` passes each relaxed toward the base by
// `currentsBaseRelax`, writes it back over the sea, and carries the sea's
// anomaly onto the land with the wind (carryInland: a cold current cools
// the coast downwind of it, a warm one mildens it). The transport is
// semi-Lagrangian, linear in the departure's triangle (monotone, as the
// former bilinear raster sample was); a land cell holds its base, so a
// departure by the coast blends in a sane value.
// Returns the current's own mark on the sea: SST minus the base, °C per sea
// cell, 0 on land. Positive is a warm current, negative a cold one — what
// the map colours the currents by.
export function applyOceanSST(terrain: ClimateTerrain, temperature: Float64Array, currents: CellVectors, wind: CellVectors): Float64Array {
  const { cm, land } = terrain
  const fm = cm.mesh
  const n = fm.count
  const dep = currentDepartures(terrain, currents)
  const base = Float64Array.from(temperature)
  let sst = Float64Array.from(temperature)
  let next = new Float64Array(n)
  const relax = CLIMATE_TUNING.currentsBaseRelax
  for (let iter = 0; iter < CLIMATE_TUNING.currentsAdvectIters; iter++) {
    transportScalar(fm, dep, sst, next)
    for (let i = 0; i < n; i++) next[i] = land[i] ? base[i] : next[i] * (1 - relax) + base[i] * relax
    const t = sst
    sst = next
    next = t
  }
  const anomaly = new Float64Array(n)
  for (let i = 0; i < n; i++) if (!land[i]) anomaly[i] = sst[i] - base[i]
  const inland = carryInland(terrain, anomaly, wind)
  for (let i = 0; i < n; i++) temperature[i] = land[i] ? base[i] + CLIMATE_TUNING.currentsCoastalFactor * inland[i] : sst[i]
  return anomaly
}
