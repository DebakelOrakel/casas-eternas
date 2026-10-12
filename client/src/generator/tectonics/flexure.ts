import { TECTONICS_TUNING } from './tectonicsTuneParams'
import { detPow } from '../core/detMath'
import type { Domain } from '../core/domain'
import { sharedFieldMesh, type FieldMesh, type SharedFieldMesh } from '../fields/fieldMesh'
import { conjugateGradient, type SolveOptions, type SolveReport } from '../fields/fieldOperators'

// FLEXURAL ISOSTASY (ADAPTIVE_MESH_PLAN.md phase 5.3, decision 5 of
// docs/decisions/adaptive-mesh.md; on the field mesh since DEC-0036 phase
// 6): the lithosphere answers a change of load — rock the erosion carried
// off, sediment it laid down, the ice — as an elastic plate over a fluid
// mantle. A range's weight bends the plate beside it as well as under it
// (the foreland basin, with no feature rule, and the forebulge beyond it),
// and an eroding range rises back as a whole. Airy per node was rejected
// (over-compensates narrow loads, no basins).
//
// THE PLATE EQUATION, solved on the flexure's field mesh:
//
//   ∇²(D ∇²w) + ρm g w = −ρc g h
//
// w the deflection (m, + up), h the load change (m of rock), D = E Te³ /
// (12 (1 − ν²)) the rigidity per cell from Te. The restoring force is the
// mantle's full density: the load h is the material change itself (what
// fills a basin is next epoch's deposit, which is its own load), so a load
// wider than the flexural parameter is compensated by ρc / ρm — the Airy
// limit — and ∫w dA = −(ρc / ρm) ∫h dA exactly on a closed surface (the
// biharmonic term integrates to zero). The term of a varying D that the
// full plate equation adds (the (1 − ν) twist term) is left out, as the
// landscape models do.
//
// Discretised with the finite-volume Laplacian A⁻¹K twice (fieldOperators:
// K_ij the coupling wall / dist, K_ii = −Σ k_ij, A the cells' areas) and
// multiplied by A / (ρm g):
//
//   K diag(R / A) K w + A w = −(ρc / ρm) A h,     R = D / (ρm g) = α⁴ / 4
//
// — symmetric positive definite. Solved by conjugate gradients with the
// Jacobi preconditioner, matrix-free (two passes of K), to a relative
// residual of 1e-10. Measured against the alternatives (DEC-0036, phase 6
// Status): ILU(0) diverges on this matrix (positive off-diagonals, not an
// M-matrix), the two-level preconditioner's constant aggregates misjudge a
// fourth-order operator, SSOR saves iterations but not time. No pole
// handling: the mesh has no pole.
//
// THE MESH is the climate's and the ocean age's (the domain's width / 256,
// 62.4 km on the torus, 78.1 km on the sphere; shared). The flexural
// parameter is 50 km (Te 20) to 127 km (Te 70) on land, 18–99 km at sea:
// a craton's deflection spans its half wavelength πα in 6 cells, a young
// orogen's in 2.5 — there the plate's answer is the mesh's, its volume
// still exact. The domain's width / 512 (the old raster's 31 km) took ten
// times the time (1.0 s an epoch at 152 000 cells: the iterations grow as
// (α / spacing)²).
const FLEXURE_RES_X = 256

export function flexureMesh(domain: Domain): SharedFieldMesh {
  return sharedFieldMesh(domain, (domain.width / FLEXURE_RES_X) * domain.metresPerUnit)
}

// The elastic thickness at a point: a raft between the young and the
// craton value by oldness, the ocean by its lithosphere age.
export function elasticThicknessKm(continental: boolean, oldness: number, oceanAgeMa: number): number {
  const T = TECTONICS_TUNING
  if (continental) return T.flexureTeYoungKm + (T.flexureTeCratonKm - T.flexureTeYoungKm) * Math.min(1, Math.max(0, oldness))
  return Math.min(T.flexureTeOceanMaxKm, T.flexureTeOceanFloorKm + T.flexureTeOceanAgeKm * Math.sqrt(Math.max(0, oceanAgeMa)))
}

// The rigidity over the restoring force, R = D / (ρm g), m⁴, with D = E Te³
// / (12 (1 − ν²)).
export function flexuralRigidityM4(teKm: number): number {
  const T = TECTONICS_TUNING
  const E = T.flexureYoungsModulusGPa * 1e9
  const te = teKm * 1000
  const D = (E * te * te * te) / (12 * (1 - T.flexurePoisson * T.flexurePoisson))
  return D / (T.flexureMantleDensity * 9.81)
}

// The flexural parameter α = (4D / (ρm g))^(1/4), km: the length the
// deflection decays and oscillates over (the line load's first zero at
// 3πα/4, its forebulge at πα).
export function flexuralAlphaKm(teKm: number): number {
  return detPow(4 * flexuralRigidityM4(teKm), 0.25) / 1000
}

// The plate's operator, matrix-free: out = K diag(R / A) K x + A x, and its
// diagonal A_i + Σ_j K_ij² R_j / A_j (the Jacobi preconditioner's). Every
// sum in a fixed order.
function plateOperator(fm: FieldMesh, rigidityM4: ArrayLike<number>): { apply: (x: ArrayLike<number>, out: Float64Array) => void; diag: Float64Array } {
  const n = fm.count
  const { nbrStart, nbr, coupling, area } = fm
  const scaled = new Float64Array(n)
  const kDiag = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let e = nbrStart[i]; e < nbrStart[i + 1]; e++) s += coupling[e]
    kDiag[i] = s
    scaled[i] = rigidityM4[i] / area[i]
  }
  const diag = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let s = kDiag[i] * kDiag[i] * scaled[i]
    for (let e = nbrStart[i]; e < nbrStart[i + 1]; e++) s += coupling[e] * coupling[e] * scaled[nbr[e]]
    diag[i] = area[i] + s
  }
  // (R / A) K x, then K of it; K x = Σ k_ij (x_j − x_i).
  const moment = new Float64Array(n)
  const apply = (x: ArrayLike<number>, out: Float64Array): void => {
    for (let i = 0; i < n; i++) {
      const xi = x[i]
      let s = 0
      for (let e = nbrStart[i]; e < nbrStart[i + 1]; e++) s += coupling[e] * (x[nbr[e]] - xi)
      moment[i] = scaled[i] * s
    }
    for (let i = 0; i < n; i++) {
      const mi = moment[i]
      let s = 0
      for (let e = nbrStart[i]; e < nbrStart[i + 1]; e++) s += coupling[e] * (moment[nbr[e]] - mi)
      out[i] = s + area[i] * x[i]
    }
  }
  return { apply, diag }
}

// The plate's deflection w per cell, metres (+ up), for a load change
// `loadM` per cell (metres of rock, negative where removed) and the
// rigidity R = D / (ρm g) per cell (flexuralRigidityM4), into `w` (its
// content the first guess: zero, the epoch's load is new). Scaled by
// flexureDeflectionScale.
export function flexuralResponse(fm: FieldMesh, loadM: ArrayLike<number>, rigidityM4: ArrayLike<number>, w: Float64Array, options: SolveOptions = {}): SolveReport {
  const n = fm.count
  const T = TECTONICS_TUNING
  const compensation = (T.flexureCrustDensity / T.flexureMantleDensity) * T.flexureDeflectionScale
  const b = new Float64Array(n)
  for (let i = 0; i < n; i++) b[i] = -compensation * fm.area[i] * loadM[i]
  const { apply, diag } = plateOperator(fm, rigidityM4)
  return conjugateGradient(n, apply, diag, b, w, options)
}
