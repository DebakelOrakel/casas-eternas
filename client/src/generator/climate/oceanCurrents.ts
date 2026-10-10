import { CLIMATE_RES_X, CLIMATE_RES_Y, isLandAtCell, latitudeAt, shiftedYNorm } from './climateField'
import { CLIMATE_TUNING } from './climateTuneParams'
import { bilinearTaps, sampleTaps, type Domain, type DomainGrid } from '../core/domain'
import { CyclicLine, LINE_COUPLING } from './cyclicLine'
import { detCos, detExp, detHypot, detSin } from '../core/detMath'

const RX = CLIMATE_RES_X
const RY = CLIMATE_RES_Y

// Wind-driven ocean surface currents as gyres, on the climate grid. Solves a
// streamfunction ψ forced by the wind-stress curl, then derives the
// (non-divergent) velocity. Returns it interleaved [u0,v0,…], normalized to a
// max magnitude of 1, zero on land. The velocity sign is set so subtropical
// gyres carry WARM water poleward along western ocean boundaries (mild eastern
// continental coasts) and COLD water equatorward along eastern ocean
// boundaries (cool, upwelling western continental coasts) — validated against
// that pattern. See docs/decisions/climate-biomes.md.
//
// The equation is Stommel's (2026-09-28, docs/design/climate-refinement.md):
// ∇²ψ + β·∂ψ/∂x = curl, friction 1 per cell. The β term (the Coriolis
// parameter grows toward the poles) makes the gyres asymmetric: a narrow,
// fast current on the western side of a basin (Gulf Stream, Kuroshio), broad
// slow flow on the eastern side. Before, the equation was ∇²ψ = curl and the
// gyres were symmetric.
//
// Each landmass is an island with a ψ of its own (the island rule), not ψ = 0
// for all land. The largest landmass is the reference at 0; every other one
// is one unknown, whose equation is the sum of the cell equations over its
// cells: the circulation around its coast. So net flow passes between two
// landmasses, and an open zonal band gives a circumpolar current.
// `equatorOffset` places the latitude for β (see climateField.shiftedYNorm).
// `domain`: what the elevation raster covers, one cell per unit.
export function computeOceanCurrents(elevation: Float32Array, wind: Float32Array, domain: Domain, dryLand?: Uint8Array, equatorOffset = 0): Float32Array {
  const { width: worldWidth, height: worldHeight } = domain
  const grid = domain.grid(RX, RY)
  const n = RX * RY
  const land = new Uint8Array(n)
  for (let gy = 0; gy < RY; gy++) {
    for (let gx = 0; gx < RX; gx++) {
      land[gy * RX + gx] = isLandAtCell(elevation, dryLand, gx, gy, worldWidth, worldHeight) ? 1 : 0
    }
  }

  // THE METRIC (DEC-0035, fork 5, step 4d5). Every equation below is the
  // finite-volume form over the grid's cells, in equator-cell units: a row's
  // cells are rowScale wide (cos φ on the sphere), its cells cellArea, the
  // edge between two rows edgeScale long (0 at a pole, which is a point).
  // Per row: across the east and west faces wE = 1 / rowScale (face length
  // 1 over the centres' distance), across the north and south faces wN, wS
  // = edgeScale (over a distance of 1), the cell's area A and the east-west
  // gradient's 1 / rowScale. Each equation is the cell's balance times its
  // area. On the torus every weight is exactly 1 and each formula is the
  // torus's own arithmetic, operation for operation: its bits stay.
  const wE = new Float64Array(RY)
  const wN = new Float64Array(RY)
  const wS = new Float64Array(RY)
  const area = new Float64Array(RY)
  const gradE = new Float64Array(RY)
  for (let gy = 0; gy < RY; gy++) {
    const s = grid.rowScale(gy)
    wE[gy] = 1 / s
    wN[gy] = grid.edgeScale(gy)
    wS[gy] = grid.edgeScale(gy + 1)
    area[gy] = grid.cellArea(gy)
    gradE[gy] = 1 / s
  }

  // Wind-stress curl, ∂τ_v/∂x − ∂τ_u/∂y in grid axes (central differences).
  // For the history's banded wind the first term is exactly 0 (the wind is
  // the same along a row), so the epochs' result is the same bit for bit as
  // before the term (2026-09-28); the climate step's pressure wind has it.
  // On the sphere the curl of a vector on the globe: (∂τ_v/∂x − ∂(τ_u cos φ)/
  // ∂y) / cos φ, which the row scales give. τ_u cos φ is continuous across a
  // pole as it stands — the cell beyond is on the far meridian, its east the
  // opposite way and its cos φ signed so too, and the two signs cancel —
  // so the row beyond a pole is read as it is.
  const curl = new Float32Array(n)
  for (let gy = 0; gy < RY; gy++) {
    const g = gradE[gy]
    const sUp = grid.rowScale(grid.wrapRow(gy - 1))
    const sDown = grid.rowScale(grid.wrapRow(gy + 1))
    for (let gx = 0; gx < RX; gx++) {
      const uUp = wind[grid.index(gx, gy - 1) * 2]
      const uDown = wind[grid.index(gx, gy + 1) * 2]
      const vLeft = wind[grid.index(gx - 1, gy) * 2 + 1]
      const vRight = wind[grid.index(gx + 1, gy) * 2 + 1]
      curl[gy * RX + gx] = ((vRight - vLeft) / 2) * g - ((uDown * sDown - uUp * sUp) / 2) * g
    }
  }

  // Half of β per row, for the central difference: β·cos(latitude), the same
  // sign in both hemispheres. `halfBetaA`: the same times the cell's area
  // over its width — the β term of the area-weighted balance.
  const halfBeta = new Float32Array(RY)
  const halfBetaA = new Float64Array(RY)
  for (let gy = 0; gy < RY; gy++) {
    halfBeta[gy] = CLIMATE_TUNING.currentsBeta * detCos(latitudeAt(gy, equatorOffset) * Math.PI / 2) / 2
    halfBetaA[gy] = halfBeta[gy] * area[gy] * gradE[gy]
  }

  // The four wrapped neighbours of every cell are indexed once: at 700 sweeps
  // the wrapping's modulos were 0.6 s of every history epoch (profiled
  // 2026-09-26).
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

  const islands = findIslands(land, left, right, up, down, halfBetaA, curl, { wE, wN, wS, area })

  // A row whose east-west coupling is strong (the sphere from 45° on, wE ∝
  // 1 / cos² φ against the area) is relaxed as LINES: each run of sea on it
  // solved at once against its north and south neighbours and the coast
  // values at its ends, all of a row of sea as a ring. Point Gauss-Seidel
  // moves such a row's mean by wN / (2 wE) of its error a sweep — a pole
  // row's 1/3300 — and 700 sweeps leave it near its start (the mantle's
  // flow solve met the same, mantleField.computeMantleFlow). The torus
  // relaxes point by point, as it did.
  const lines: (RowLines | null)[] = []
  for (let gy = 0; gy < RY; gy++) lines.push(wE[gy] / area[gy] > LINE_SOLVE_COUPLING ? new RowLines(land, gy, wE[gy], wN[gy] + wS[gy], halfBetaA[gy]) : null)

  // Gauss-Seidel in place over the ocean cells, then one update per island.
  // An island's value is written to its coast cells only: they are the only
  // land cells an ocean cell reads.
  const psi = new Float32Array(n)
  for (let iter = 0; iter < CLIMATE_TUNING.currentsSolveIters; iter++) {
    for (let gy = 0; gy < RY; gy++) {
      const e = wE[gy]
      const nN = wN[gy]
      const nS = wS[gy]
      const a = area[gy]
      const b = halfBetaA[gy]
      const d = 2 * e + nN + nS
      const line = lines[gy]
      if (line !== null) {
        line.relax(psi, up, down, curl, nN, nS, a)
        continue
      }
      for (let i = gy * RX, end = i + RX; i < end; i++) {
        if (land[i]) continue
        psi[i] = (e * psi[left[i]] + e * psi[right[i]] + nN * psi[up[i]] + nS * psi[down[i]] + b * (psi[right[i]] - psi[left[i]]) - a * curl[i]) / d
      }
    }
    for (const island of islands) {
      let sum = -island.curl
      for (let k = 0; k < island.faces.length; k++) sum += island.faceWeight[k] * psi[island.faces[k]]
      for (let k = 0; k < island.east.length; k++) sum += island.eastBeta[k] * psi[island.east[k]]
      for (let k = 0; k < island.west.length; k++) sum -= island.westBeta[k] * psi[island.west[k]]
      const value = sum / island.weight
      for (const c of island.coast) psi[c] = value
    }
  }

  // Velocity from ψ (non-divergent): u = −∂ψ/∂y, v = ∂ψ/∂x. Sign chosen so the
  // coastal warm/cold pattern comes out right (validated). Normalize to max 1.
  // ψ is a scalar: across a pole the cell beyond is read as it is.
  const current = new Float32Array(n * 2)
  let vmax = 1e-9
  for (let gy = 0; gy < RY; gy++) {
    const g = gradE[gy]
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      if (land[i]) continue
      const u = -(psi[grid.index(gx, gy + 1)] - psi[grid.index(gx, gy - 1)]) / 2
      const v = (psi[grid.index(gx + 1, gy)] - psi[grid.index(gx - 1, gy)]) * g
      current[i * 2] = u
      current[i * 2 + 1] = v / 2
      vmax = Math.max(vmax, detHypot(u, v / 2))
    }
  }
  for (let i = 0; i < current.length; i++) current[i] /= vmax
  return current
}

// A row is relaxed as lines (RowLines) when its east-west weight over its
// area passes this — mantleField's LINE_SOLVE_COUPLING, the same reason.
// The torus's is 1 and never does.
const LINE_SOLVE_COUPLING = 2

// THE LINES OF ONE ROW: its runs of sea, each a tridiagonal system in the
// row's constant coefficients — diag 2 wE + wN + wS, west −(wE − b), east
// −(wE + b) with b the β term — closed by the coast values at its two ends,
// or cyclic (Sherman–Morrison) when the whole row is sea. Factored once per
// call: the land does not move within a solve.
class RowLines {
  private readonly base: number
  private readonly runs: { start: number; length: number }[] = []
  private readonly ring: boolean
  private readonly lower: number
  private readonly upper: number
  private readonly diag: number
  private readonly rhs: Float64Array
  private readonly x: Float64Array
  private readonly cp: Float64Array
  // The ring's correction (Sherman–Morrison, as mantleField's LineSolver):
  // B⁻¹u and the denominator, B the ring with its corners taken out.
  private readonly z: Float64Array = new Float64Array(0)
  private readonly denom: number = 1
  private readonly gamma: number = 1

  constructor(land: Uint8Array, row: number, wE: number, wNS: number, b: number) {
    this.base = row * RX
    this.lower = -(wE - b)
    this.upper = -(wE + b)
    this.diag = 2 * wE + wNS
    this.rhs = new Float64Array(RX)
    this.x = new Float64Array(RX)
    this.cp = new Float64Array(RX)
    let sea = 0
    for (let x = 0; x < RX; x++) if (!land[this.base + x]) sea++
    this.ring = sea === RX
    if (this.ring) {
      // A = B + u vᵀ with u = (γ, 0 … 0, upper), v = (1, 0 … 0, lower / γ):
      // u vᵀ supplies A's corners (row 0's west term at column n − 1, row
      // n − 1's east term at column 0) and takes γ and upper · lower / γ
      // off B's first and last diagonal.
      this.gamma = -this.diag
      const u = new Float64Array(RX)
      u[0] = this.gamma
      u[RX - 1] = this.upper
      this.z = new Float64Array(RX)
      this.solveRun(u, this.z, RX, this.diag - this.gamma, this.diag - (this.upper * this.lower) / this.gamma)
      this.denom = 1 + this.z[0] + (this.lower / this.gamma) * this.z[RX - 1]
      return
    }
    // The runs of sea, each starting after a land cell, in the row's order
    // from its first land cell.
    let first = 0
    while (!land[this.base + first]) first++
    for (let k = 1; k <= RX; k++) {
      const x = (first + k) % RX
      if (land[this.base + x]) continue
      const start = x
      let length = 0
      while (!land[this.base + ((start + length) % RX)]) length++
      this.runs.push({ start, length })
      k += length
    }
  }

  // One sweep of the row: every run solved against psi's values north and
  // south of it (the rows above already swept, as point Gauss-Seidel reads
  // them) and its coasts.
  relax(psi: Float32Array, up: Int32Array, down: Int32Array, curl: Float32Array, wN: number, wS: number, a: number): void {
    const { base, rhs, x } = this
    const at = (k: number): number => base + (k % RX)
    if (this.ring) {
      for (let k = 0; k < RX; k++) {
        const i = base + k
        rhs[k] = wN * psi[up[i]] + wS * psi[down[i]] - a * curl[i]
      }
      this.solveRun(rhs, x, RX, this.diag - this.gamma, this.diag - (this.upper * this.lower) / this.gamma)
      const factor = (x[0] + (this.lower / this.gamma) * x[RX - 1]) / this.denom
      for (let k = 0; k < RX; k++) psi[base + k] = x[k] - factor * this.z[k]
      return
    }
    for (const { start, length } of this.runs) {
      for (let k = 0; k < length; k++) {
        const i = at(start + k)
        rhs[k] = wN * psi[up[i]] + wS * psi[down[i]] - a * curl[i]
      }
      // The coasts at the two ends, moved to the right-hand side.
      rhs[0] -= this.lower * psi[at(start + RX - 1)]
      rhs[length - 1] -= this.upper * psi[at(start + length)]
      this.solveRun(rhs, x, length, this.diag, this.diag)
      for (let k = 0; k < length; k++) psi[at(start + k)] = x[k]
    }
  }

  // The tridiagonal system of `length` unknowns in the row's coefficients,
  // the first and last diagonal given (the ring's B changes them), by the
  // Thomas algorithm; b into out.
  private solveRun(b: Float64Array, out: Float64Array, length: number, firstDiag: number, lastDiag: number): void {
    const { cp, lower, upper, diag } = this
    let pivot = firstDiag
    if (length === 1) {
      out[0] = b[0] / pivot
      return
    }
    cp[0] = upper / pivot
    out[0] = b[0] / pivot
    for (let k = 1; k < length; k++) {
      const d = k === length - 1 ? lastDiag : diag
      pivot = d - lower * cp[k - 1]
      cp[k] = upper / pivot
      out[k] = (b[k] - lower * out[k - 1]) / pivot
    }
    for (let k = length - 2; k >= 0; k--) out[k] -= cp[k] * out[k + 1]
  }
}

// THE OVERTURNING'S SURFACE INFLOW (build step 9 of
// docs/design/climate-refinement.md): the surface water drawn toward where
// it sinks. The wind-driven currents above are a streamfunction, flow with
// no sources or sinks; a sinking sea is a sink, so its inflow is the other
// half of a velocity field, a potential: ∇²χ = −s, u = ∇χ, with the sinking
// as `s` and the water that sank coming up again spread over the whole sea
// (so the field balances), and no flow into a coast (the potential mirrors
// at land). Returns [u, v] per cell, 0 on land, scaled so its fastest cell
// is 1. `grid`: the climate grid.
//
// In the grid's finite-volume metric (step 4e), as computeOceanCurrents'
// solve: the faces east and west weigh wE = 1 / rowScale, north and south
// the row edges (0 across a pole), the source and the sea's mean by the
// cell's area, the flow east-west per length; the rows where the
// east-west coupling dominates (the sphere from about 45°) relaxed as
// lines. On the torus every weight is 1 and no row is a line: the
// arithmetic is the torus's, as it was.
export function computeSinkInflow(sink: Float32Array, land: Uint8Array, grid: DomainGrid): Float32Array {
  const n = RX * RY
  let total = 0
  let sea = 0
  for (let i = 0; i < n; i++) {
    if (land[i]) continue
    const a = grid.cellArea((i / RX) | 0)
    total += sink[i] * a
    sea += a
  }
  const inflow = new Float32Array(n * 2)
  if (total <= 0 || sea === 0) return inflow
  const rise = total / sea
  const source = new Float32Array(n)
  for (let i = 0; i < n; i++) if (!land[i]) source[i] = sink[i] - rise

  const neighbours = (gx: number, gy: number): [number, number, number, number] => [grid.index(gx - 1, gy), grid.index(gx + 1, gy), grid.index(gx, gy - 1), grid.index(gx, gy + 1)]
  // Per row: the four faces' weights (west, east, north, south), the area,
  // the east-west gradient, and the line solver where the row is one.
  const faceW = new Float64Array(RY * 4)
  const areaOf = new Float64Array(RY)
  const gradE = new Float64Array(RY)
  const lines: (CyclicLine | null)[] = []
  for (let gy = 0; gy < RY; gy++) {
    const s = grid.rowScale(gy)
    const a = grid.cellArea(gy)
    faceW[gy * 4] = 1 / s
    faceW[gy * 4 + 1] = 1 / s
    faceW[gy * 4 + 2] = grid.edgeScale(gy)
    faceW[gy * 4 + 3] = grid.edgeScale(gy + 1)
    areaOf[gy] = a
    gradE[gy] = 1 / s
    lines.push(1 / s / a > LINE_COUPLING ? new CyclicLine(RX) : null)
  }
  const chi = new Float32Array(n)
  // One row as a line: the sea's cells the unknowns, each coupled to its
  // sea neighbours east and west, north and south read from the iterate; a
  // land cell (and a coast face) stands out of the system. A small share of
  // the diagonal is added to both sides — the fixed point is the same, and
  // a run of sea with no sea north or south of it (a pure Neumann line) is
  // not singular.
  const relaxRow = (line: CyclicLine, gy: number): void => {
    const wE = faceW[gy * 4]
    const wN = faceW[gy * 4 + 2]
    const wS = faceW[gy * 4 + 3]
    const a = areaOf[gy]
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      line.diagIm[gx] = 0
      line.rhsIm[gx] = 0
      line.lower[gx] = 0
      line.upper[gx] = 0
      if (land[i]) {
        line.diagRe[gx] = 1
        line.rhsRe[gx] = chi[i]
        continue
      }
      const [l, r, u, d] = neighbours(gx, gy)
      let diag = 0
      let rhs = a * source[i]
      if (!land[l]) { diag += wE; line.lower[gx] = -wE }
      if (!land[r]) { diag += wE; line.upper[gx] = -wE }
      if (!land[u]) { diag += wN; rhs += wN * chi[u] }
      if (!land[d]) { diag += wS; rhs += wS * chi[d] }
      const shift = 1e-6 * diag + 1e-30
      line.diagRe[gx] = diag + shift
      line.rhsRe[gx] = rhs + shift * chi[i]
    }
    line.solve()
    for (let gx = 0; gx < RX; gx++) if (!land[gy * RX + gx]) chi[gy * RX + gx] = line.outRe[gx]
  }
  for (let iter = 0; iter < CLIMATE_TUNING.conveyorSolveIters; iter++) {
    for (let gy = 0; gy < RY; gy++) {
      const line = lines[gy]
      if (line !== null) {
        relaxRow(line, gy)
        continue
      }
      const w0 = faceW[gy * 4]
      const w1 = faceW[gy * 4 + 1]
      const w2 = faceW[gy * 4 + 2]
      const w3 = faceW[gy * 4 + 3]
      const wSum = w0 + w1 + w2 + w3
      const a = areaOf[gy]
      for (let gx = 0; gx < RX; gx++) {
        const i = gy * RX + gx
        if (land[i]) continue
        // A land neighbour stands in with this cell's own value: no flow
        // across the coast.
        const [l, r, u, d] = neighbours(gx, gy)
        let sum = 0
        sum += w0 * (land[l] ? chi[i] : chi[l])
        sum += w1 * (land[r] ? chi[i] : chi[r])
        sum += w2 * (land[u] ? chi[i] : chi[u])
        sum += w3 * (land[d] ? chi[i] : chi[d])
        chi[i] = (sum + a * source[i]) / wSum
      }
    }
  }
  let fastest = 0
  for (let gy = 0; gy < RY; gy++) {
    const g = gradE[gy]
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      if (land[i]) continue
      const [l, r, u, d] = neighbours(gx, gy)
      const at = (j: number): number => (land[j] ? chi[i] : chi[j])
      const vx = (at(r) - at(l)) / 2 * g
      const vy = (at(d) - at(u)) / 2
      inflow[i * 2] = vx
      inflow[i * 2 + 1] = vy
      fastest = Math.max(fastest, detHypot(vx, vy))
    }
  }
  if (fastest > 0) for (let k = 0; k < inflow.length; k++) inflow[k] /= fastest
  return inflow
}

// Ekman upwelling on the climate grid (build step 3 of
// docs/design/climate-refinement.md): the wind pushes the surface water at a
// right angle to itself, to the right in the northern hemisphere and to the
// left in the southern (transport = τ × k / f). Where that transport diverges
// — off a coast the wind runs along, and at the equator under the trade
// winds, where f changes sign — cold water comes up from below. Returns the
// divergence per ocean cell, positive where water comes up, 0 on land.
// `land` is 1 on land cells; the transport is 0 there, so a coast with the
// water moving away from it diverges. `grid`: the climate grid.
export function computeUpwelling(wind: Float32Array, land: Uint8Array, grid: DomainGrid, equatorOffset: number, rotationHours: number): Float32Array {
  const n = RX * RY
  // Transport in grid axes (x east, y down).
  const ex = new Float32Array(n)
  const ey = new Float32Array(n)
  for (let gy = 0; gy < RY; gy++) {
    const sLat = (latitudeSign(gy, equatorOffset))
    // f, northern (top) hemisphere positive, held off zero near the
    // equator with its sign kept, so the transport stays finite there.
    const f = sLat * Math.max(CLIMATE_TUNING.upwellingMinF, Math.abs(detSin(latitudeAt(gy, equatorOffset) * Math.PI / 2))) * (24 / rotationHours)
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      if (land[i]) continue
      const u = wind[i * 2]
      const vNorth = -wind[i * 2 + 1]
      // τ × k / f in north-up axes: (τ_n, −τ_u) / f.
      ex[i] = vNorth / f
      ey[i] = u / f // −(−τ_u / f): the y axis points south
    }
  }
  // The divergence over the cell's four faces; a face with land on either
  // side carries nothing. So a coast cell with the water leaving it takes the
  // whole transport as upwelling, not half of it as a central difference
  // would give. In the grid's metric (step 4e): the transport through a
  // face times the face's length — 1 east and west, the row edge north and
  // south (0 at a pole, which is a point, so nothing is read across it) —
  // over the cell's area. On the torus each weight is 1.
  const face = (a: number, b: number, fa: number, fb: number): number => (land[a] || land[b] ? 0 : (fa + fb) / 2)
  const out = new Float32Array(n)
  for (let gy = 0; gy < RY; gy++) {
    const wN = grid.edgeScale(gy)
    const wS = grid.edgeScale(gy + 1)
    const area = grid.cellArea(gy)
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      if (land[i]) continue
      const r = grid.index(gx + 1, gy)
      const l = grid.index(gx - 1, gy)
      const d = grid.index(gx, gy + 1)
      const u = grid.index(gx, gy - 1)
      out[i] = (face(i, r, ex[i], ex[r]) - face(l, i, ex[l], ex[i]) + face(i, d, ey[i], ey[d]) * wS - face(u, i, ey[u], ey[i]) * wN) / area
    }
  }
  // A pole row is one point: its sea one value (a no-op on the torus).
  const sea = new Uint8Array(n)
  for (let i = 0; i < n; i++) sea[i] = land[i] ? 0 : 1
  grid.averagePoleRows(out, sea)
  return out
}

// How far east a sea cell lies in its basin, along its row: 0 at the western
// shore, 1 at the eastern, 0.5 where the row has no shore. The thermocline
// tilts with the trade winds — deep under the warm pool in the west, shallow
// in the east — so upwelling brings cold water only in the east (the
// equatorial cold tongue). `grid`: the climate grid.
export function eastwardInBasin(land: Uint8Array, grid: DomainGrid): Float32Array {
  const n = RX * RY
  const out = new Float32Array(n).fill(0.5)
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

// Where a sea cell lies across its basin, along its row: −1 at the western
// shore, +1 at the eastern, scaled down in a basin narrower than
// `fullWidthCells` equator cells (a sea between two coasts close together has
// no east and west of its own); 0 where the row has no shore. `grid`: the
// climate grid.
export function basinFlank(land: Uint8Array, grid: DomainGrid, fullWidthCells: number): Float32Array {
  const n = RX * RY
  const out = new Float32Array(n)
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

// The sea's anomaly on the land, °C per land cell: the air takes the anomaly
// of the sea it last crossed and loses it over land, e^(−d / L) after d cells
// (`currentsInlandDecayCells`), looked for up to `currentsInlandReachCells`
// upwind along `wind`. So the westerlies carry the North Atlantic's warmth
// deep into Europe, and a coast the wind leaves for the sea (an east coast
// in the westerlies, a west coast in the trades) gets only the breeze off
// its own shore: `currentsCoastalLeeShare` of its strongest neighbouring
// sea cell. Until 2026-09-29 every coast took its neighbour's anomaly the
// same way, four cells in, whatever the wind, and Europe's interior got
// little of the North Atlantic's (on Earth's relief Oslo's year came out
// 4 °C too cold, now 1). `grid`: the climate grid.
export function carryInland(seaAnomaly: Float32Array, land: Uint8Array, wind: Float32Array, grid: DomainGrid): Float32Array {
  const n = RX * RY
  const out = new Float32Array(n)
  const reach = CLIMATE_TUNING.currentsInlandReachCells
  for (let gy = 0; gy < RY; gy++) {
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      if (!land[i]) continue
      let lee = 0
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const a = seaAnomaly[grid.index(gx + dx, gy + dy)]
        if (Math.abs(a) > Math.abs(lee)) lee = a
      }
      let carried = 0
      const u = wind[i * 2]
      const v = wind[i * 2 + 1]
      const speed = detHypot(u, v)
      if (speed > 0) {
        for (let k = 1; k <= reach; k++) {
          const j = grid.cellDisplaced(gx, gy, -(u / speed) * k, -(v / speed) * k)
          if (land[j]) continue
          carried = seaAnomaly[j] * detExp(-(k - 1) / CLIMATE_TUNING.currentsInlandDecayCells)
          break
        }
      }
      const breeze = lee * CLIMATE_TUNING.currentsCoastalLeeShare
      out[i] = Math.abs(carried) > Math.abs(breeze) ? carried : breeze
    }
  }
  return out
}

// +1 in the top (northern) hemisphere, −1 in the bottom one.
function latitudeSign(gy: number, equatorOffset: number): number {
  return shiftedYNorm(gy, RY, equatorOffset) < 0.5 ? 1 : -1
}

interface Island {
  // Its coast cells (land with an ocean neighbour), which carry its ψ.
  coast: Int32Array
  // One entry per face to the ocean: the ocean cell's index, and the face's
  // weight in the balance (wE, wN or wS of its row; 1 on the torus) — with
  // their sum.
  faces: Int32Array
  faceWeight: Float64Array
  weight: number
  // The ocean cells east and west of its cells, with half of β on their row:
  // what the β term leaves after the sum over the island telescopes.
  east: Int32Array
  eastBeta: Float32Array
  west: Int32Array
  westBeta: Float32Array
  // The wind-stress curl summed over its cells, each times its area.
  curl: number
}

// The balance's weights per row (computeOceanCurrents' metric).
interface CurrentWeights {
  wE: Float64Array
  wN: Float64Array
  wS: Float64Array
  area: Float64Array
}

// The landmasses (4-connected, wrapped) except the largest, which stays the
// reference at ψ = 0. A landmass with no ocean face (the whole world) has no
// equation and is left out too.
function findIslands(land: Uint8Array, left: Int32Array, right: Int32Array, up: Int32Array, down: Int32Array, halfBeta: Float64Array, curl: Float32Array, weights: CurrentWeights): Island[] {
  const n = land.length
  const label = new Int32Array(n).fill(-1)
  const members: number[][] = []
  const stack: number[] = []
  for (let seed = 0; seed < n; seed++) {
    if (!land[seed] || label[seed] >= 0) continue
    const id = members.length
    const cells: number[] = []
    label[seed] = id
    stack.push(seed)
    while (stack.length > 0) {
      const i = stack.pop()!
      cells.push(i)
      for (const j of [left[i], right[i], up[i], down[i]]) {
        if (land[j] && label[j] < 0) {
          label[j] = id
          stack.push(j)
        }
      }
    }
    members.push(cells)
  }
  let largest = -1
  for (let id = 0; id < members.length; id++) if (largest < 0 || members[id].length > members[largest].length) largest = id

  const islands: Island[] = []
  for (let id = 0; id < members.length; id++) {
    if (id === largest) continue
    const coast: number[] = []
    const faces: number[] = []
    const faceWeight: number[] = []
    const east: number[] = []
    const eastBeta: number[] = []
    const west: number[] = []
    const westBeta: number[] = []
    let curlSum = 0
    let weight = 0
    for (const i of members[id]) {
      const row = (i / RX) | 0
      curlSum += weights.area[row] * curl[i]
      const before = faces.length
      const nbrs = [left[i], right[i], up[i], down[i]]
      const w = [weights.wE[row], weights.wE[row], weights.wN[row], weights.wS[row]]
      for (let k = 0; k < 4; k++) {
        if (land[nbrs[k]]) continue
        faces.push(nbrs[k])
        faceWeight.push(w[k])
        weight += w[k]
      }
      if (faces.length > before) coast.push(i)
      const b = halfBeta[row]
      if (!land[right[i]]) { east.push(right[i]); eastBeta.push(b) }
      if (!land[left[i]]) { west.push(left[i]); westBeta.push(b) }
    }
    if (faces.length === 0) continue
    islands.push({
      coast: Int32Array.from(coast), faces: Int32Array.from(faces), faceWeight: Float64Array.from(faceWeight), weight,
      east: Int32Array.from(east), eastBeta: Float32Array.from(eastBeta),
      west: Int32Array.from(west), westBeta: Float32Array.from(westBeta),
      curl: curlSum,
    })
  }
  return islands
}

// Applies the ocean currents' heat transport to the temperature field (°C, in
// place): advects a sea-surface-temperature field (seeded from the latitudinal
// base) along the currents, writes it back over ocean cells, and carries the
// sea's anomaly onto the land with the wind (a cold current cools the coast
// downwind of it, a warm one mildens it). `current` is the normalized field
// from computeOceanCurrents, `wind` the [u, v] the air moves by (see
// carryInland).
// Returns the current's own mark on the sea: SST minus the base temperature,
// °C per ocean cell, 0 on land. Positive is a warm current, negative a cold
// one — what the map colours the currents by.
// `domain`: what the elevation raster covers, one cell per unit.
export function applyOceanSST(temperature: Float32Array, current: Float32Array, elevation: Float32Array, domain: Domain, wind: Float32Array, dryLand?: Uint8Array): Float32Array {
  const { width: worldWidth, height: worldHeight } = domain
  const grid = domain.grid(RX, RY)
  const n = RX * RY
  const land = new Uint8Array(n)
  for (let gy = 0; gy < RY; gy++) {
    for (let gx = 0; gx < RX; gx++) {
      land[gy * RX + gx] = isLandAtCell(elevation, dryLand, gx, gy, worldWidth, worldHeight) ? 1 : 0
    }
  }

  // Advect SST from the base. Land cells stay at base (never updated), so a
  // sample near the coast blends in a sane value rather than garbage. The
  // departure point is the grid's (DomainGrid.tapsAt): upstream along the
  // current, on the sphere along the great circle, found once per cell.
  // A pole row's sea is one point: made one value each iteration (a no-op
  // on the torus).
  const taps = bilinearTaps(n)
  for (let gy = 0; gy < RY; gy++) {
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      if (land[i]) continue
      grid.tapsAt(gx, gy, -current[i * 2] * CLIMATE_TUNING.currentsAdvectStep, -current[i * 2 + 1] * CLIMATE_TUNING.currentsAdvectStep, taps, i)
    }
  }
  const sea = new Uint8Array(n)
  for (let i = 0; i < n; i++) sea[i] = land[i] ? 0 : 1
  let sst = temperature.slice()
  for (let iter = 0; iter < CLIMATE_TUNING.currentsAdvectIters; iter++) {
    const next = sst.slice()
    for (let i = 0; i < n; i++) {
      if (land[i]) continue
      const advected = sampleTaps(sst, taps, i)
      next[i] = advected * (1 - CLIMATE_TUNING.currentsBaseRelax) + temperature[i] * CLIMATE_TUNING.currentsBaseRelax
    }
    grid.averagePoleRows(next, sea)
    sst = next
  }

  // The SST anomaly on ocean cells (uses the original base, still in
  // temperature[] here), then onto the land with the wind (carryInland).
  const oceanAnomaly = new Float32Array(n)
  for (let i = 0; i < n; i++) if (!land[i]) oceanAnomaly[i] = sst[i] - temperature[i]
  const inland = carryInland(oceanAnomaly, land, wind, grid)
  for (let i = 0; i < n; i++) if (land[i]) temperature[i] += CLIMATE_TUNING.currentsCoastalFactor * inland[i]

  // Ocean cells take the sea-surface temperature (so the temperature overlay
  // shows the current structure too).
  for (let i = 0; i < n; i++) {
    if (!land[i]) temperature[i] = sst[i]
  }
  return oceanAnomaly
}
