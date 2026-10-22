import type { FieldMesh, FieldSampler } from './fieldMesh'

// The largest explicit step (seconds, κ in m² / s) that keeps every
// cell's new value a convex combination of the old: dt ≤ A_i / (κ Σ k_ij)
// for all i. Stable and free of over-shoot; the strict stability bound is
// up to twice this.
export function stableDiffusionStep(fm: FieldMesh, kappa: number): number {
  let best = Infinity
  for (let i = 0; i < fm.count; i++) {
    let s = 0
    for (let e = fm.nbrStart[i]; e < fm.nbrStart[i + 1]; e++) s += fm.coupling[e]
    const dt = fm.area[i] / (kappa * s)
    if (dt < best) best = dt
  }
  return best
}

// One explicit (forward Euler) diffusion step: φ + dt · κ ∇²φ, into out
// (which must not be phi).
export function diffuseExplicit(fm: FieldMesh, phi: ArrayLike<number>, kappa: number, dt: number, out: Float64Array): Float64Array {
  const { nbrStart, nbr, coupling, area } = fm
  const k = kappa * dt
  for (let i = 0; i < fm.count; i++) {
    const p = phi[i]
    let s = 0
    for (let e = nbrStart[i]; e < nbrStart[i + 1]; e++) s += coupling[e] * (phi[nbr[e]] - p)
    out[i] = p + (k * s) / area[i]
  }
  return out
}

// A Gaussian smoothing of standard deviation `sigmaM` per axis (metres):
// diffusion to κt = σ² / 2 in equal explicit steps, none larger than the
// convex limit (stableDiffusionStep), so every step is a weighted mean and
// the whole the binomial approach to the Gaussian — as three box passes
// approached one on a raster (σ² = r(r + 1) cells² for a box of radius r).
// The area-weighted mean is kept to rounding. Into out (which may be phi).
export function smoothGaussian(fm: FieldMesh, phi: ArrayLike<number>, sigmaM: number, out: Float64Array): Float64Array {
  const kt = (sigmaM * sigmaM) / 2
  let limit = convexLimits.get(fm)
  if (limit === undefined) {
    limit = stableDiffusionStep(fm, 1)
    convexLimits.set(fm, limit)
  }
  const steps = Math.max(1, Math.ceil(kt / limit))
  let a = Float64Array.from(phi as ArrayLike<number>)
  let b = new Float64Array(fm.count)
  for (let k = 0; k < steps; k++) {
    diffuseExplicit(fm, a, 1, kt / steps, b)
    const t = a
    a = b
    b = t
  }
  out.set(a)
  return out
}

// stableDiffusionStep at κ = 1 per mesh, for the smoothing.
const convexLimits = new WeakMap<FieldMesh, number>()

// ------------------------------------------------- gradient, divergence

// The gradient by least squares over each cell's neighbours in its
// tangent plane (fieldMesh's weights): east and south components, φ's
// unit per metre, each in its cell's frame.
export function gradient(fm: FieldMesh, phi: ArrayLike<number>, outE: Float64Array, outS: Float64Array): void {
  const { nbrStart, nbr, gradE, gradS } = fm
  for (let i = 0; i < fm.count; i++) {
    const p = phi[i]
    let ge = 0
    let gs = 0
    for (let e = nbrStart[i]; e < nbrStart[i + 1]; e++) {
      const d = phi[nbr[e]] - p
      ge += gradE[e] * d
      gs += gradS[e] * d
    }
    outE[i] = ge
    outS[i] = gs
  }
}

// The divergence of a vector field by finite volumes: Σ_j wall · (v_face ·
// n_ij) / A_i, the face's vector the mean of the two cells' (the
// neighbour's carried into the cell's frame), n_ij the unit direction to
// the neighbour (the wall's normal on a Voronoi mesh). Per second for a
// velocity in m / s. With `within` (1 per cell inside), only the walls
// between two cells inside carry a flux and a cell outside gets 0 — a
// region with closed walls (the sea, whose coasts nothing crosses).
export function divergence(fm: FieldMesh, ve: ArrayLike<number>, vs: ArrayLike<number>, out: Float64Array, within?: Uint8Array): Float64Array {
  const { nbrStart, nbr, wall, dist, offE, offS, turnC, turnS, area } = fm
  for (let i = 0; i < fm.count; i++) {
    if (within && !within[i]) {
      out[i] = 0
      continue
    }
    const ae = ve[i]
    const as = vs[i]
    let s = 0
    for (let e = nbrStart[i]; e < nbrStart[i + 1]; e++) {
      const j = nbr[e]
      if (within && !within[j]) continue
      const c = turnC[e]
      const sn = turnS[e]
      const be = c * ve[j] - sn * vs[j]
      const bs = sn * ve[j] + c * vs[j]
      s += (wall[e] * (0.5 * (ae + be) * offE[e] + 0.5 * (as + bs) * offS[e])) / dist[e]
    }
    out[i] = s / area[i]
  }
  return out
}

// ------------------------------------------------- semi-Lagrangian transport

// Where each cell's parcel was a step ago: the departure point, its
// triangle's corners and weights (the taps every field moved by this wind
// in this step reuses, as DomainGrid.tapsAt), the departure's unit vector
// on the sphere, and each corner's offset to the departure in that
// corner's frame (metres) for the gradient-corrected sample.
export interface Departures {
  readonly x: Float64Array
  readonly y: Float64Array
  readonly corners: Int32Array
  readonly weights: Float64Array
  readonly unit: Float64Array
  readonly offE: Float64Array
  readonly offS: Float64Array
}

export function departures(fm: FieldMesh): Departures {
  const n = fm.count
  return {
    x: new Float64Array(n),
    y: new Float64Array(n),
    corners: new Int32Array(3 * n),
    weights: new Float64Array(3 * n),
    unit: new Float64Array(fm.globe ? 3 * n : 0),
    offE: new Float64Array(3 * n),
    offS: new Float64Array(3 * n),
  }
}

// The departures of a wind (ve, vs, m / s, per cell in its frame) over dt
// seconds: the midpoint rule along the great circle, `iterations` times
// (2 is the usual): the wind sampled half a step back, carried to the
// arrival cell, and the departure the whole step back along it
// (Domain.advance). Second order in time.
export function computeDepartures(fm: FieldMesh, sampler: FieldSampler, ve: ArrayLike<number>, vs: ArrayLike<number>, dt: number, out: Departures, iterations = 2): Departures {
  const { domain } = fm
  const scale = dt / fm.unitM
  const p = { x: 0, y: 0 }
  const v = { x: 0, y: 0 }
  const tap = departureTapper(fm, sampler, out)
  for (let i = 0; i < fm.count; i++) {
    v.x = ve[i]
    v.y = vs[i]
    for (let k = 0; k < iterations; k++) {
      domain.advance(fm.x[i], fm.y[i], -0.5 * scale * v.x, -0.5 * scale * v.y, p)
      sampler.sampleVector(ve, vs, p.x, p.y, i, v)
    }
    domain.advance(fm.x[i], fm.y[i], -scale * v.x, -scale * v.y, p)
    tap(i, p.x, p.y)
  }
  return out
}

// Cell i's departure at (px, py) into out: the point, its triangle's
// corners and weights, each corner's offset to it in metres, and on the
// sphere its unit vector.
function departureTapper(fm: FieldMesh, sampler: FieldSampler, out: Departures): (i: number, px: number, py: number) => void {
  const { domain } = fm
  const d = { x: 0, y: 0 }
  const cornersK = new Int32Array(3)
  const weightsK = new Float64Array(3)
  const gf = { px: 0, py: 0, pz: 0, ex: 0, ey: 0, ez: 0, sx: 0, sy: 0, sz: 0 }
  return (i, px, py) => {
    out.x[i] = px
    out.y[i] = py
    sampler.taps(px, py, cornersK, weightsK)
    for (let k = 0; k < 3; k++) {
      const c = cornersK[k]
      out.corners[3 * i + k] = c
      out.weights[3 * i + k] = weightsK[k]
      domain.delta(px, py, fm.x[c], fm.y[c], d)
      out.offE[3 * i + k] = d.x * fm.unitM
      out.offS[3 * i + k] = d.y * fm.unitM
    }
    if (fm.globe && domain.noise.kind === 'globe') {
      domain.noise.frame(px, py, gf)
      const r = domain.noise.radius
      out.unit[3 * i] = gf.px / r
      out.unit[3 * i + 1] = gf.py / r
      out.unit[3 * i + 2] = gf.pz / r
    }
  }
}

// A scalar moved by the departures: each cell takes the value at its
// departure.
//
// Without a gradient: linear in the departure's triangle — monotone (no
// new extremes), first order, and diffusive.
//
// With the field's gradient (gradient()): each corner's value extended
// HALF way to the departure, Σ w_k (φ_k + ½ ∇φ_k · δ_k). The linear
// interpolant of a quadratic errs by +½ Σ w_k δ_kᵀ H δ_k, the full
// extension (φ_k + ∇φ_k · δ_k) by exactly the negative of it, so their
// mean is exact for quadratics — the triangle's form of the cubic-Hermite
// (Catmull–Rom) interpolation, whose midpoint weight it has. The full
// extension was tried first: it doubles that weight, amplifies the
// shortest waves at a Courant number near 1 and blows up within a
// revolution on both shapes (2026-10-11, scripts/fields.mjs [5]). It may
// over- and under-shoot; `clip` limits each value to its triangle's
// corner range (quasi-monotone, Bermejo & Staniforth 1992) for a field
// that must keep its bounds (an age, a fraction).
//
// Not conservative either way; the harness measures the drift. Into out
// (which must not be phi).
export function transportScalar(fm: FieldMesh, dep: Departures, phi: ArrayLike<number>, out: Float64Array, gradE?: ArrayLike<number>, gradS?: ArrayLike<number>, clip = false): Float64Array {
  const { corners, weights, offE, offS } = dep
  for (let i = 0; i < fm.count; i++) {
    const k = 3 * i
    const a = phi[corners[k]]
    const b = phi[corners[k + 1]]
    const c = phi[corners[k + 2]]
    if (!gradE || !gradS) {
      out[i] = weights[k] * a + weights[k + 1] * b + weights[k + 2] * c
      continue
    }
    let s = 0
    for (let m = k; m < k + 3; m++) {
      const n = corners[m]
      s += weights[m] * (phi[n] + 0.5 * (gradE[n] * offE[m] + gradS[n] * offS[m]))
    }
    if (clip) {
      const lo = Math.min(a, b, c)
      const hi = Math.max(a, b, c)
      s = s < lo ? lo : s > hi ? hi : s
    }
    out[i] = s
  }
  return out
}

// ------------------------------------------------------- elliptic solves

export interface SolveOptions {
  // The relative residual |b − Ax| / |b| to stop at, and the iteration cap.
  tolerance?: number
  maxIterations?: number
}

export interface SolveReport {
  iterations: number
  // The relative residual reached.
  residual: number
  converged: boolean
  // For α = 0 (Poisson): the area-weighted mean of f that was removed —
  // ∇²φ = f has a solution only for a mean-free f on a closed surface.
  removedMean: number
}

// A symmetric positive (semi-)definite system A x = b by conjugate gradients
// with a Jacobi preconditioner: `apply` writes A x, `diag` is A's diagonal
// (a zero entry leaves its unknown alone — a cell outside the system), `x`
// holds the first guess and receives the solution. To a relative residual
// |b − Ax| / |b| of `tolerance` (default 1e-10). A semi-definite system
// converges when b is orthogonal to its null space (the caller's to
// ensure: a Poisson problem's mean-free right-hand side per connected
// part). Every sum in a fixed order.
export function conjugateGradient(n: number, apply: (x: ArrayLike<number>, out: Float64Array) => void, diag: ArrayLike<number>, b: ArrayLike<number>, x: Float64Array, options: SolveOptions = {}): SolveReport {
  const tolerance = options.tolerance ?? 1e-10
  const maxIterations = options.maxIterations ?? 2000
  const r = new Float64Array(n)
  const z = new Float64Array(n)
  const p = new Float64Array(n)
  const q = new Float64Array(n)
  apply(x, q)
  let bNorm = 0
  for (let i = 0; i < n; i++) {
    r[i] = b[i] - q[i]
    bNorm += b[i] * b[i]
  }
  bNorm = Math.sqrt(bNorm)
  if (bNorm === 0) {
    x.fill(0)
    return { iterations: 0, residual: 0, converged: true, removedMean: 0 }
  }
  let rz = 0
  for (let i = 0; i < n; i++) {
    z[i] = diag[i] !== 0 ? r[i] / diag[i] : 0
    p[i] = z[i]
    rz += r[i] * z[i]
  }
  let residual = 0
  for (let it = 1; it <= maxIterations; it++) {
    apply(p, q)
    let pq = 0
    for (let i = 0; i < n; i++) pq += p[i] * q[i]
    const a = rz / pq
    let rr = 0
    for (let i = 0; i < n; i++) {
      x[i] += a * p[i]
      r[i] -= a * q[i]
      rr += r[i] * r[i]
    }
    residual = Math.sqrt(rr) / bNorm
    if (residual <= tolerance) return { iterations: it, residual, converged: true, removedMean: 0 }
    let rzNext = 0
    for (let i = 0; i < n; i++) {
      z[i] = diag[i] !== 0 ? r[i] / diag[i] : 0
      rzNext += r[i] * z[i]
    }
    const beta = rzNext / rz
    rz = rzNext
    for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i]
  }
  return { iterations: maxIterations, residual, converged: false, removedMean: 0 }
}

// A general (non-symmetric) system A x = b by BiCGSTAB (van der Vorst
// 1992) with a preconditioner: `apply` writes A x, `precondition` writes
// K⁻¹ r for an approximation K of A (a Jacobi or block-Jacobi inverse),
// `x` holds the first guess and receives the solution. What the Stommel
// balance (its β term is a first derivative: the matrix is not symmetric)
// and the energy balance (an upwind transport and a complex diagonal) are
// solved by; CG does not apply to either. To a relative residual |b − Ax|
// / |b| of `tolerance` (default 1e-10), the true residual recomputed at the
// end. On a breakdown (ρ = 0, the shadow residual orthogonal to r) it
// restarts from the current x. Every sum in a fixed order.
export function solveBiCGSTAB(n: number, apply: (x: ArrayLike<number>, out: Float64Array) => void, precondition: (r: ArrayLike<number>, out: Float64Array) => void, b: ArrayLike<number>, x: Float64Array, options: SolveOptions = {}): SolveReport {
  const tolerance = options.tolerance ?? 1e-10
  const maxIterations = options.maxIterations ?? 2000
  const r = new Float64Array(n)
  const shadow = new Float64Array(n)
  const p = new Float64Array(n)
  const v = new Float64Array(n)
  const y = new Float64Array(n)
  const s = new Float64Array(n)
  const zz = new Float64Array(n)
  const t = new Float64Array(n)
  let bNorm = 0
  for (let i = 0; i < n; i++) bNorm += b[i] * b[i]
  bNorm = Math.sqrt(bNorm)
  if (bNorm === 0) {
    x.fill(0)
    return { iterations: 0, residual: 0, converged: true, removedMean: 0 }
  }
  const restart = (): void => {
    apply(x, v)
    for (let i = 0; i < n; i++) {
      r[i] = b[i] - v[i]
      shadow[i] = r[i]
      p[i] = 0
      v[i] = 0
    }
  }
  restart()
  const norm = (a: Float64Array): number => {
    let q = 0
    for (let i = 0; i < n; i++) q += a[i] * a[i]
    return Math.sqrt(q)
  }
  let rho = 1
  let alpha = 1
  let omega = 1
  let residual = norm(r) / bNorm
  let it = 0
  while (residual > tolerance && it < maxIterations) {
    it++
    let rhoNext = 0
    for (let i = 0; i < n; i++) rhoNext += shadow[i] * r[i]
    if (rhoNext === 0 || omega === 0) {
      restart()
      rho = 1
      alpha = 1
      omega = 1
      continue
    }
    const beta = (rhoNext / rho) * (alpha / omega)
    rho = rhoNext
    for (let i = 0; i < n; i++) p[i] = r[i] + beta * (p[i] - omega * v[i])
    precondition(p, y)
    apply(y, v)
    let sv = 0
    for (let i = 0; i < n; i++) sv += shadow[i] * v[i]
    alpha = rho / sv
    for (let i = 0; i < n; i++) s[i] = r[i] - alpha * v[i]
    if (norm(s) / bNorm <= tolerance) {
      for (let i = 0; i < n; i++) x[i] += alpha * y[i]
      residual = norm(s) / bNorm
      break
    }
    precondition(s, zz)
    apply(zz, t)
    let ts = 0
    let tt = 0
    for (let i = 0; i < n; i++) {
      ts += t[i] * s[i]
      tt += t[i] * t[i]
    }
    omega = tt > 0 ? ts / tt : 0
    for (let i = 0; i < n; i++) {
      x[i] += alpha * y[i] + omega * zz[i]
      r[i] = s[i] - omega * t[i]
    }
    residual = norm(r) / bNorm
  }
  // The true residual, not the recurrence's.
  apply(x, v)
  for (let i = 0; i < n; i++) r[i] = b[i] - v[i]
  residual = norm(r) / bNorm
  return { iterations: it, residual, converged: residual <= tolerance * 10, removedMean: 0 }
}

// Per directed edge, the wall's length times the east component of its
// unit normal toward the neighbour, metres: the flux of a field ψ carried
// due east at unit speed through the wall is wallEast · ψ_face. Taken as
// the mean of the two cells' views (the normal in cell i's frame and minus
// the neighbour's in its own), so it is exactly antisymmetric —
// wallEast[rev[e]] = −wallEast[e] — and a sum of such fluxes over a region
// telescopes to its boundary (the currents' island rule needs that). On
// the torus it is wall · dx / dist. Σ_e wallEast over a cell is its area
// times the divergence of the east unit vector, which is 0 on both shapes
// (to the discretisation). Cached per mesh.
export function eastWallNormals(fm: FieldMesh): Float64Array {
  let out = eastWalls.get(fm)
  if (out) return out
  out = new Float64Array(fm.nbr.length)
  for (let e = 0; e < out.length; e++) out[e] = (fm.wall[e] * (fm.offE[e] - fm.offE[fm.rev[e]])) / (2 * fm.dist[e])
  eastWalls.set(fm, out)
  return out
}

const eastWalls = new WeakMap<FieldMesh, Float64Array>()

// ------------------------------------------------------- sparse matrices

// A square sparse matrix in compressed rows: row r's entries are start[r] ..
// start[r + 1] − 1, their columns ascending, the diagonal among them. What a
// stage assembles when its operator is not one of the mesh's own (the
// currents' island rule, the energy balance's two parts a cell).
export interface SparseMatrix {
  readonly n: number
  readonly start: Int32Array
  readonly col: Int32Array
  readonly val: Float64Array
}

// A matrix from its rows, each a list of [column, value] pairs in any order
// (a column given twice is summed); every row must hold its diagonal.
export function sparseMatrix(rows: readonly (readonly [number, number])[][]): SparseMatrix {
  const n = rows.length
  const start = new Int32Array(n + 1)
  const cols: number[] = []
  const vals: number[] = []
  for (let r = 0; r < n; r++) {
    start[r] = cols.length
    const sorted = [...rows[r]].sort((a, b) => a[0] - b[0])
    let hasDiagonal = false
    for (const [c, v] of sorted) {
      if (c === r) hasDiagonal = true
      if (cols.length > start[r] && cols[cols.length - 1] === c) vals[vals.length - 1] += v
      else {
        cols.push(c)
        vals.push(v)
      }
    }
    if (!hasDiagonal) throw new Error(`sparseMatrix: row ${r} has no diagonal`)
  }
  start[n] = cols.length
  return { n, start, col: Int32Array.from(cols), val: Float64Array.from(vals) }
}

// out = A x.
export function sparseApply(m: SparseMatrix, x: ArrayLike<number>, out: Float64Array): void {
  const { n, start, col, val } = m
  for (let r = 0; r < n; r++) {
    let s = 0
    for (let k = start[r]; k < start[r + 1]; k++) s += val[k] * x[col[k]]
    out[r] = s
  }
}

// The incomplete LU factorisation with no fill (ILU(0), Saad 2003 §10.3):
// L and U on A's own pattern, and the preconditioner that applies (LU)⁻¹ —
// a forward and a back substitution, about one product with A. For the
// diagonally dominant systems here it cuts BiCGSTAB's iterations several
// times over Jacobi's. A pivot that comes out 0 is replaced by the row's
// diagonal (it does not, on a diagonally dominant matrix).
export function ilu0(m: SparseMatrix): (r: ArrayLike<number>, out: Float64Array) => void {
  const { n, start, col } = m
  const lu = Float64Array.from(m.val)
  const diagAt = new Int32Array(n)
  for (let r = 0; r < n; r++) {
    diagAt[r] = -1
    for (let k = start[r]; k < start[r + 1]; k++) if (col[k] === r) diagAt[r] = k
  }
  const where = new Int32Array(n).fill(-1)
  for (let i = 0; i < n; i++) {
    for (let k = start[i]; k < start[i + 1]; k++) where[col[k]] = k
    for (let p = start[i]; p < start[i + 1]; p++) {
      const kc = col[p]
      if (kc >= i) break
      let pivot = lu[diagAt[kc]]
      if (pivot === 0) pivot = m.val[diagAt[kc]]
      lu[p] /= pivot
      const lik = lu[p]
      for (let q = diagAt[kc] + 1; q < start[kc + 1]; q++) {
        const w = where[col[q]]
        if (w >= 0) lu[w] -= lik * lu[q]
      }
    }
    for (let k = start[i]; k < start[i + 1]; k++) where[col[k]] = -1
    if (lu[diagAt[i]] === 0) lu[diagAt[i]] = m.val[diagAt[i]]
  }
  return (r, out) => {
    for (let i = 0; i < n; i++) {
      let s = r[i]
      for (let k = start[i]; k < diagAt[i]; k++) s -= lu[k] * out[col[k]]
      out[i] = s
    }
    for (let i = n - 1; i >= 0; i--) {
      let s = out[i]
      for (let k = diagAt[i] + 1; k < start[i + 1]; k++) s -= lu[k] * out[col[k]]
      out[i] = s / lu[diagAt[i]]
    }
  }
}

// Aggregates of a matrix's unknowns for a coarse correction: each a
// connected patch of the matrix's graph grown breadth-first `hops` steps
// from the lowest unknown not yet taken (rows longer than `longRow`
// entries — an island's, coupled to its whole coast — stand alone, as
// their own aggregate, and are not walked through). Per unknown its
// aggregate, and their count.
export function aggregate(m: SparseMatrix, hops: number, longRow = 16): { of: Int32Array; count: number } {
  const { n, start, col } = m
  const of = new Int32Array(n).fill(-1)
  const long = (r: number): boolean => start[r + 1] - start[r] > longRow
  let count = 0
  let frontier: number[] = []
  for (let seed = 0; seed < n; seed++) {
    if (of[seed] >= 0) continue
    const id = count++
    of[seed] = id
    if (long(seed)) continue
    frontier = [seed]
    for (let h = 0; h < hops && frontier.length > 0; h++) {
      const next: number[] = []
      for (const r of frontier) {
        for (let k = start[r]; k < start[r + 1]; k++) {
          const c = col[k]
          if (of[c] >= 0 || long(c)) continue
          of[c] = id
          next.push(c)
        }
      }
      frontier = next
    }
  }
  return { of, count }
}

// A two-level preconditioner: ILU(0) smoothing, then a coarse correction
// on aggregates (unsmoothed aggregation: the prolongation constant on each
// aggregate, the coarse matrix PᵀAP the sum of A's entries between two
// aggregates, solved exactly by a dense LU with partial pivoting). For one
// residual r: z = (LU)⁻¹ r, then z += P A_c⁻¹ Pᵀ (r − A z). The coarse
// level carries what ILU(0) relaxes slowly — the long waves, and an
// island's one value along its whole coast — so the Krylov iterations do
// not grow with the mesh's size or the islands' count. A post-smoothing
// pass as well cost more than the iterations it saved (measured on the
// currents, 2026-10-11). A linear operator: BiCGSTAB may use it.
export function twoLevelPreconditioner(m: SparseMatrix, agg: { of: Int32Array; count: number }): (r: ArrayLike<number>, out: Float64Array) => void {
  const { n, start, col, val } = m
  const nc = agg.count
  const of = agg.of
  const coarse = new Float64Array(nc * nc)
  for (let r = 0; r < n; r++) {
    const I = of[r] * nc
    for (let k = start[r]; k < start[r + 1]; k++) coarse[I + of[col[k]]] += val[k]
  }
  const pivot = denseLU(coarse, nc)
  const smooth = ilu0(m)
  const res = new Float64Array(n)
  const rc = new Float64Array(nc)
  return (r, out) => {
    smooth(r, out)
    sparseApply(m, out, res)
    rc.fill(0)
    for (let i = 0; i < n; i++) rc[of[i]] += r[i] - res[i]
    denseSolve(coarse, pivot, nc, rc)
    for (let i = 0; i < n; i++) out[i] += rc[of[i]]
  }
}

// In place: the LU factors of a dense row-major n × n matrix with partial
// pivoting; returns the row permutation.
function denseLU(a: Float64Array, n: number): Int32Array {
  const perm = new Int32Array(n)
  for (let i = 0; i < n; i++) perm[i] = i
  for (let k = 0; k < n; k++) {
    let p = k
    let best = Math.abs(a[k * n + k])
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(a[i * n + k])
      if (v > best) { best = v; p = i }
    }
    if (p !== k) {
      for (let j = 0; j < n; j++) {
        const t = a[k * n + j]
        a[k * n + j] = a[p * n + j]
        a[p * n + j] = t
      }
      const t = perm[k]
      perm[k] = perm[p]
      perm[p] = t
    }
    const d = a[k * n + k]
    if (d === 0) continue
    for (let i = k + 1; i < n; i++) {
      const f = (a[i * n + k] /= d)
      if (f === 0) continue
      for (let j = k + 1; j < n; j++) a[i * n + j] -= f * a[k * n + j]
    }
  }
  return perm
}

// Solves (PLU) x = b in place in b, from denseLU's factors. A zero pivot
// (a singular coarse matrix: a closed Neumann problem) leaves its unknown 0.
function denseSolve(a: Float64Array, perm: Int32Array, n: number, b: Float64Array): void {
  const y = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let s = b[perm[i]]
    for (let j = 0; j < i; j++) s -= a[i * n + j] * y[j]
    y[i] = s
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i]
    for (let j = i + 1; j < n; j++) s -= a[i * n + j] * y[j]
    const d = a[i * n + i]
    y[i] = d !== 0 ? s / d : 0
  }
  b.set(y)
}
