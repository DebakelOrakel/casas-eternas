import type { Domain, DomainGrid } from '../core/domain'
import { MANTLE_TUNING } from './mantleTuneParams'
import { sampleMembershipField } from '../crust/raftField'

// A coarse, evolving mantle buoyancy/temperature field under the whole torus
// surface — the CAUSE the plates ride on (Phase M2 of
// docs/decisions/evolving-euler-poles.md). Hot = upwelling, cold = downwelling.
// Its surface coupling closes the Wilson cycle: continents INSULATE the mantle
// (heat builds beneath them → an upwelling grows → the flow diverges under them →
// their plates are pushed apart → breakup), while ocean COOLS (downwelling →
// convergence → continents drift together → assembly). Bounded by diffusion +
// decay, so the whole thing stays stable — and the plate motions are FIT to the
// resulting flow (a bounded function of a bounded field), avoiding force-
// integration runaway. Reuses the ocean-current streamfunction pattern
// (Gauss-Seidel Poisson).
//
// LIVES IN ITS OWN MODULE because BOTH eras run on it: five files in `archean/`
// and five in `tectonics/` read this field, so filing it under either one made
// the other import across a boundary for its own substrate. It sat in
// `tectonics/` for historical reasons only.
//
// The fit itself — `fitMotionsToFlow` — deliberately does NOT live here. It
// takes plate seeds and returns plate motions, so keeping it would have made
// the substrate depend on the thing riding on it. It is in
// `tectonics/plateMotion.ts` with the types it speaks in.

export const MANTLE_RES_X = 128
export const MANTLE_RES_Y = 64
const RX = MANTLE_RES_X
const RY = MANTLE_RES_Y

// THE MANTLE RASTER'S STENCIL, from the domain's grid once per call: the
// loops below step one cell from a cell, and a table lookup there keeps the
// sweep plain arithmetic (the wrap was 8 % of an epoch as calls, 2026-10-02).
//
// Per cell its four neighbours — west, east, north, south — through the
// grid's own rule: on the sphere the step north of a north-pole cell is the
// cell on the opposite meridian (DEC-0035, fork 5). Per row the
// finite-volume weights of the Laplacian in equator-cell units: across the
// east and west faces aE = 1 / (rowScale · cellArea), across the north and
// south faces aN, aS = edgeScale / cellArea (0 at a pole: a pole is a point,
// no flux crosses it). On the torus every weight is exactly 1, and each
// formula below is written so that it is then the torus's own arithmetic,
// operation for operation: the torus keeps its bits.
interface MantleStencil {
  west: Int32Array
  east: Int32Array
  north: Int32Array
  south: Int32Array
  aE: Float64Array
  aN: Float64Array
  aS: Float64Array
  // The east-west gradient's metric, 1 / rowScale; the cell area per row;
  // their sum over every cell (the cell count on the torus).
  gradE: Float64Array
  area: Float64Array
  totalArea: number
  grid: DomainGrid
}

function mantleStencil(domain: Domain): MantleStencil {
  const grid = domain.grid(RX, RY)
  const n = RX * RY
  const west = new Int32Array(n)
  const east = new Int32Array(n)
  const north = new Int32Array(n)
  const south = new Int32Array(n)
  for (let y = 0; y < RY; y++) {
    for (let x = 0; x < RX; x++) {
      const i = y * RX + x
      west[i] = grid.neighbour(x, y, -1, 0)
      east[i] = grid.neighbour(x, y, 1, 0)
      north[i] = grid.neighbour(x, y, 0, -1)
      south[i] = grid.neighbour(x, y, 0, 1)
    }
  }
  const aE = new Float64Array(RY)
  const aN = new Float64Array(RY)
  const aS = new Float64Array(RY)
  const gradE = new Float64Array(RY)
  const area = new Float64Array(RY)
  let totalArea = 0
  for (let y = 0; y < RY; y++) {
    const a = grid.cellArea(y)
    aE[y] = 1 / (grid.rowScale(y) * a)
    aN[y] = grid.edgeScale(y) / a
    aS[y] = grid.edgeScale(y + 1) / a
    gradE[y] = 1 / grid.rowScale(y)
    area[y] = a
  }
  for (let i = 0; i < n; i++) totalArea += area[(i / RX) | 0]
  return { west, east, north, south, aE, aN, aS, gradE, area, totalArea, grid }
}

// A row whose east-west coupling is this many times the equator's is
// solved as a line in the flow solve (computeMantleFlow) — on the sphere
// from about 60° on. The torus never reaches it: its coupling is 1.
const LINE_SOLVE_COUPLING = 2

// Smoothed random initial field — a few upwelling/downwelling blobs so there's
// convection (and therefore plate motion) from epoch 0, before surface coupling
// has reshaped it.
// How many blur passes smooth the initial random field into convection cells.
//
// This was the mantle-vigour knob, on the reasoning that changing the field's
// initial characteristic scale steers the world while leaving the tuned epoch
// dynamics alone. Measurement killed it: the per-epoch diffusion below erases the
// initial smoothing within a few dozen epochs. Field roughness by starting value:
//
//     passes   epoch 0   epoch 10   epoch 40
//       10      0.353      0.249      0.167
//        1      0.894      0.336      0.189
//     spread    2.53x      1.35x      1.13x
//
// Nine tenths of the difference is gone by epoch 40, and the phase is not stopped
// before epoch 150. A sweep over the full slider range confirmed the consequence:
// craton count, plate count and land fraction all varied non-monotonically, by no
// more than they varied between two seeds at the same setting.
//
// The knob moved to the per-epoch diffusion, which cannot wash out because it is
// reapplied every epoch — see ArcheanParams.diffusion. This constant is now just
// the starting scale, with no claim to steer anything.
export const DEFAULT_INITIAL_SMOOTHING = 6

export function createMantleField(random: () => number, domain: Domain, smoothingPasses = DEFAULT_INITIAL_SMOOTHING): Float32Array {
  const st = mantleStencil(domain)
  let field: Float32Array = new Float32Array(RX * RY)
  for (let i = 0; i < field.length; i++) field[i] = random() * 2 - 1
  for (let pass = 0; pass < smoothingPasses; pass++) field = boxBlur(field, 0.5, st)
  // A pole row is one point (DEC-0035, fork 5); a no-op on the torus.
  st.grid.averagePoleRows(field)
  return zeroMean(clampField(field), st)
}

// One pass of diffusion: each cell moves `weight` of the way to its
// neighbours' mean. On the torus that is the plain box blur. On the sphere
// the same step in metric distance (the finite-volume weights of the
// stencil); near a pole its east-west part is far stronger than one
// explicit step can carry (aE ∝ 1 / cos² φ), so the step takes the share
// that is stable and the rest follows as east-west sub-steps on the row
// (fork 5's sub-steps). The torus's share is all of it, so it takes none.
function boxBlur(field: Float32Array, weight: number, st: MantleStencil): Float32Array {
  const { west, east, north, south, aE, aN, aS } = st
  const out = new Float32Array(RX * RY)
  let rest = false
  for (let y = 0; y < RY; y++) {
    // The east-west weight one explicit step can take beside the
    // north-south one: weight · (aN + aS + 2 · eMain) / 4 at most 1.
    const eMain = Math.min(aE[y], (4 / weight - aN[y] - aS[y]) / 2)
    if (eMain < aE[y]) rest = true
    const wd = (weight * (aN[y] + aS[y] + 2 * eMain)) / 4
    const nN = aN[y]
    const nS = aS[y]
    for (let x = 0; x < RX; x++) {
      const i = y * RX + x
      const c = field[i]
      const n = nN * field[north[i]] + nS * field[south[i]] + eMain * field[west[i]] + eMain * field[east[i]]
      out[i] = c * (1 - wd) + (n / 4) * weight
    }
  }
  if (rest) diffuseRowsEastWest(out, weight, st)
  return out
}

// The east-west share boxBlur could not take, per row, in explicit
// sub-steps of at most half a cell's value each — a pole row takes a few
// thousand, the cost of a few rows of the equator's.
function diffuseRowsEastWest(field: Float32Array, weight: number, st: MantleStencil): void {
  const { aE, aN, aS } = st
  const row = new Float64Array(RX)
  for (let y = 0; y < RY; y++) {
    const eMain = Math.min(aE[y], (4 / weight - aN[y] - aS[y]) / 2)
    const left = ((aE[y] - eMain) * weight) / 4
    if (!(left > 0)) continue
    const steps = Math.ceil(left / 0.25)
    const k = left / steps
    const base = y * RX
    for (let x = 0; x < RX; x++) row[x] = field[base + x]
    for (let s = 0; s < steps; s++) {
      let prev = row[RX - 1]
      const first = row[0]
      for (let x = 0; x < RX; x++) {
        const c = row[x]
        const next = x + 1 < RX ? row[x + 1] : first
        row[x] = c + k * (prev + next - 2 * c)
        prev = c
      }
    }
    for (let x = 0; x < RX; x++) field[base + x] = row[x]
  }
}

// The area-weighted mean taken out (the plain mean on the torus).
function zeroMean(field: Float32Array, st: MantleStencil): Float32Array {
  let mean = 0
  for (let y = 0; y < RY; y++) {
    const a = st.area[y]
    for (let x = 0; x < RX; x++) mean += field[y * RX + x] * a
  }
  mean /= st.totalArea
  for (let i = 0; i < field.length; i++) field[i] -= mean
  return field
}

function clampField(field: Float32Array): Float32Array {
  for (let i = 0; i < field.length; i++) field[i] = Math.max(-MANTLE_TUNING.clamp, Math.min(MANTLE_TUNING.clamp, field[i]))
  return field
}

// One epoch of field evolution: continents heat the mantle beneath (insulation →
// the doming driver), ocean cools it (downwelling), then diffuse + decay to a
// zero mean. Mutates + returns the field.
export function evolveMantleField(
  field: Float32Array,
  membership: Float32Array,
  membershipResX: number,
  membershipResY: number,
  domain: Domain,
  diffusionPasses: number = MANTLE_TUNING.diffusionPasses,
): Float32Array {
  const membershipGrid = domain.grid(membershipResX, membershipResY)
  for (let gy = 0; gy < RY; gy++) {
    const wy = ((gy + 0.5) / RY) * domain.height
    for (let gx = 0; gx < RX; gx++) {
      const wx = ((gx + 0.5) / RX) * domain.width
      const i = gy * RX + gx
      if (sampleMembershipField(membership, membershipGrid, wx, wy) > 0.5) field[i] += MANTLE_TUNING.insulationRate
      else field[i] -= MANTLE_TUNING.oceanCoolRate
    }
  }
  // Fractional passes: whole ones at full weight, then a partial one for the
  // remainder. Integer passes alone would give the Archean's mixing knob three
  // usable positions (0, 1, 2 — it saturates past that), which is not a slider.
  const st = mantleStencil(domain)
  const wholePasses = Math.floor(diffusionPasses)
  for (let p = 0; p < wholePasses; p++) field = boxBlur(field, MANTLE_TUNING.diffusionWeight, st)
  const remainder = diffusionPasses - wholePasses
  if (remainder > 0) field = boxBlur(field, MANTLE_TUNING.diffusionWeight * remainder, st)
  // The insulation above was sampled per cell, and a pole row's cells are
  // one point: made one value (a no-op on the torus).
  st.grid.averagePoleRows(field)
  for (let i = 0; i < field.length; i++) field[i] *= MANTLE_TUNING.decayKeep
  return zeroMean(clampField(field), st)
}

// Keeps Archean convection alive by renormalising the field to a target RMS.
//
// evolveMantleField is written for a world that HAS continents: they insulate, the
// ocean cools, and the difference between the two sustains the pattern. With no
// crust at all the ocean term is uniform, zeroMean cancels it exactly, and all that
// remains is MANTLE_TUNING.decayKeep — so the field decays exponentially to nothing. Measured
// with zero crust: peak amplitude 0.443 at epoch 0, 0.007 by epoch 60.
//
// That would make the Archean impossible by construction — crust needs upwellings,
// and upwellings would need crust. The resolution is physical rather than a fudge:
// Archean convection was driven by RADIOGENIC HEAT and secular core cooling, not by
// surface insulation. Internal heating is the driver; the insulation feedback is a
// modulation on top of it, and it is the only one evolveMantleField models because
// by the time plates exist it is the only one that varies.
//
// Renormalising rather than injecting fresh noise is deliberate: it preserves the
// pattern the field has developed (cells keep their identity, drift and reorganise)
// while holding its amplitude steady, so a fixed nucleation threshold keeps meaning
// the same thing at epoch 10 and at epoch 300.
// The RMS is area-weighted (the plain one on the torus), so that the
// sphere's narrow polar cells do not count as much as the equator's.
export function sustainMantleVigour(field: Float32Array, targetRms: number, domain: Domain): Float32Array {
  const st = mantleStencil(domain)
  let sq = 0
  for (let y = 0; y < RY; y++) {
    const a = st.area[y]
    for (let x = 0; x < RX; x++) {
      const v = field[y * RX + x]
      sq += v * v * a
    }
  }
  const rms = Math.sqrt(sq / st.totalArea)
  if (rms < 1e-6) return field
  const scale = targetRms / rms
  for (let i = 0; i < field.length; i++) field[i] = Math.max(-MANTLE_TUNING.clamp, Math.min(MANTLE_TUNING.clamp, field[i] * scale))
  return field
}

// Release the thermal doming at a continental breakup: subtract a broad bump of
// buoyancy around the rift point (linear falloff to 0 at `worldRadius`). Physically,
// the upwelling that built under the insulating supercontinent has now breached the
// surface (the flood-basalt eruption) and the widening gap is floored with new,
// cooling ocean — so the buoyancy that DROVE the divergence is spent. This is what
// lets the global CONT_RIFT_COOLDOWN band-aid be retired (Option C): without it, the
// broad hot dome under an assembled continent keeps many boundary points divergent,
// so one breakup fires every epoch (strobing); draining the dome at breakup collapses
// that forcing regionally, so the flow (recomputed next epoch) stops pushing the
// halves apart at that spot and the strobing stops on its own. Mutates the field;
// the next evolveMantleField re-clamps + re-zero-means it.
export function coolMantleAt(field: Float32Array, x: number, y: number, domain: Domain, worldRadius: number, amount: number): void {
  const r2 = worldRadius * worldRadius
  for (let gy = 0; gy < RY; gy++) {
    const wy = ((gy + 0.5) / RY) * domain.height
    for (let gx = 0; gx < RX; gx++) {
      const wx = ((gx + 0.5) / RX) * domain.width
      const d2 = domain.distanceSq(wx, wy, x, y)
      if (d2 > r2) continue
      const falloff = 1 - Math.sqrt(d2) / worldRadius
      field[gy * RX + gx] = Math.max(-MANTLE_TUNING.clamp, field[gy * RX + gx] - amount * falloff)
    }
  }
}

// Surface flow from the field: solve ∇²φ = (T − mean) (zero-mean source on the
// torus, Gauss-Seidel), then u = ∇φ. u DIVERGES from hot upwellings and CONVERGES
// to cold downwellings (φ has a minimum at a hot source, so ∇φ points outward).
// Returns interleaved [ux, uy] per cell, scaled to world pixels — on the
// sphere the components along the cell's east and south, in domain units
// (the frame Domain.advance moves a point in).
//
// On the sphere the Laplacian is the stencil's finite-volume one, and a row
// whose east-west coupling is strong (toward a pole, aE ∝ 1 / cos² φ) is
// relaxed as a LINE: the row solved at once against its north and south
// neighbours (a cyclic tridiagonal system). Point Gauss-Seidel would leave
// such a row's mean almost where it started — it moves by aS / (2 aE) a
// sweep, 1/3300 at a pole row. The torus relaxes point by point, as it did.
// The north-south gradient across a pole reads the cell on the opposite
// meridian, at one cell's distance like any other.
export function computeMantleFlow(field: Float32Array, domain: Domain): Float32Array {
  const st = mantleStencil(domain)
  const { west, east, north, south, aE, aN, aS, gradE } = st
  const n = RX * RY
  const phi = new Float32Array(n)
  // The rows relaxed as lines, each with its system factored once.
  const lines: (LineSolver | null)[] = []
  for (let y = 0; y < RY; y++) lines.push(aE[y] > LINE_SOLVE_COUPLING ? new LineSolver(RX, 2 * aE[y] + aN[y] + aS[y], -aE[y]) : null)
  for (let iter = 0; iter < MANTLE_TUNING.solveIters; iter++) {
    for (let y = 0; y < RY; y++) {
      const e = aE[y]
      const nN = aN[y]
      const nS = aS[y]
      const d = 2 * e + nN + nS
      const line = lines[y]
      if (line !== null) {
        const base = y * RX
        for (let x = 0; x < RX; x++) {
          const i = base + x
          line.rhs[x] = nN * phi[north[i]] + nS * phi[south[i]] - field[i]
        }
        line.solve()
        for (let x = 0; x < RX; x++) phi[base + x] = line.x[x]
        continue
      }
      for (let x = 0; x < RX; x++) {
        const i = y * RX + x
        const neighbors = e * phi[west[i]] + e * phi[east[i]] + nN * phi[north[i]] + nS * phi[south[i]]
        phi[i] = (neighbors - field[i]) / d
      }
    }
  }
  const flow = new Float32Array(n * 2)
  for (let y = 0; y < RY; y++) {
    const g = gradE[y]
    for (let x = 0; x < RX; x++) {
      const i = y * RX + x
      const ux = ((phi[east[i]] - phi[west[i]]) / 2) * g
      const uy = (phi[south[i]] - phi[north[i]]) / 2
      flow[i * 2] = ux * MANTLE_TUNING.flowSpeedScale
      flow[i * 2 + 1] = uy * MANTLE_TUNING.flowSpeedScale
    }
  }
  return flow
}

// A cyclic tridiagonal system with constant coefficients — `diag` on the
// diagonal, `off` beside it and in the two corners (a row that closes on
// itself in longitude) — solved by the Thomas algorithm with the
// Sherman-Morrison correction for the corners: A = B + u vᵀ with B
// tridiagonal, u = (γ, 0…0, off), v = (1, 0…0, off / γ). Everything that
// depends on the coefficients alone (B's pivots, B⁻¹u) is factored once per
// row in the constructor; a solve is then two sweeps of multiplications.
// The right-hand side goes in `rhs`, the solution comes out in `x`.
class LineSolver {
  readonly rhs: Float64Array
  readonly x: Float64Array
  private readonly n: number
  private readonly off: number
  private readonly ratio: number
  // B's elimination: cp[i] the multiplier carried to row i, inv[i] 1 / pivot.
  private readonly cp: Float64Array
  private readonly inv: Float64Array
  // B⁻¹u, and 1 + v · B⁻¹u.
  private readonly z: Float64Array
  private readonly denom: number

  constructor(n: number, diag: number, off: number) {
    this.n = n
    this.off = off
    this.rhs = new Float64Array(n)
    this.x = new Float64Array(n)
    this.cp = new Float64Array(n)
    this.inv = new Float64Array(n)
    this.z = new Float64Array(n)
    const gamma = -diag
    this.ratio = off / gamma
    let beta = diag - gamma
    this.inv[0] = 1 / beta
    for (let i = 1; i < n; i++) {
      this.cp[i] = off * this.inv[i - 1]
      beta = (i === n - 1 ? diag - off * this.ratio : diag) - off * this.cp[i]
      this.inv[i] = 1 / beta
    }
    const u = new Float64Array(n)
    u[0] = gamma
    u[n - 1] = off
    this.sweep(u, this.z)
    this.denom = 1 + this.z[0] + this.ratio * this.z[n - 1]
  }

  solve(): void {
    const { n, x, z } = this
    this.sweep(this.rhs, x)
    const factor = (x[0] + this.ratio * x[n - 1]) / this.denom
    for (let i = 0; i < n; i++) x[i] -= factor * z[i]
  }

  // B⁻¹b into `out`.
  private sweep(b: Float64Array, out: Float64Array): void {
    const { n, cp, inv, off } = this
    out[0] = b[0] * inv[0]
    for (let i = 1; i < n; i++) out[i] = (b[i] - off * out[i - 1]) * inv[i]
    for (let i = n - 2; i >= 0; i--) out[i] -= cp[i + 1] * out[i + 1]
  }
}
