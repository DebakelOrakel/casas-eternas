import type { FieldMesh, FieldSampler } from './fieldMesh'

// THE OPERATORS ON A FIELD MESH (DEC-0036, phase 0): diffusion, gradient,
// divergence, semi-Lagrangian transport and an elliptic solver, each one
// code for both shapes — the shape is in the mesh's geometry
// (fields/fieldMesh.ts), never in a branch here, except where a vector is
// carried on the globe. Checked against analytic answers by `npm run
// harness:fields` (scripts/fields.mjs) before any stage uses them.
//
// Fields are Float64Array per cell. The fields are small (24 000 cells at
// the climate's 78 km is 190 kB), the solvers accumulate sums of many
// terms that must cancel (a Laplacian of a smooth field is a difference of
// near-equal fluxes, a conjugate gradient's residual falls to 1e-10), and
// Float32 would put its rounding into every stage that reads them. A
// field goes to Float32 where it leaves: the raster for a texture or the
// save (rasteriseField). Inputs are ArrayLike<number>, so a Float32 field
// may be read.
//
// A VECTOR field is two arrays, east and south (the Domain's frame, see
// fieldMesh.ts), each cell's pair in its OWN tangent frame. A neighbour's
// vector is read in a cell's frame through `turnC`/`turnS` (carryFrom);
// on the torus that is the identity.
//
// The finite volume: cell i exchanges with neighbour j across their wall,
// flux = κ · (φj − φi) · wall / dist, and a cell's change is the sum of its
// fluxes over its area. The coupling wall / dist is symmetric, so the
// operator times the areas is a symmetric matrix and the area-weighted sum
// of a diffused field is kept to rounding.

// ------------------------------------------------------------- frames

// Neighbour fm.nbr[e]'s vector (ve, vs), in its own frame, read in the
// frame of the cell that owns edge e. Into out.x, out.y.
export function carryFrom(fm: FieldMesh, e: number, ve: number, vs: number, out: { x: number; y: number }): void {
  const c = fm.turnC[e]
  const s = fm.turnS[e]
  out.x = c * ve - s * vs
  out.y = s * ve + c * vs
}

// ---------------------------------------------------------- diffusion

// The Laplacian ∇²φ per cell, 1 / m² times φ's unit: Σ_j k_ij (φj − φi) / A_i.
export function laplacian(fm: FieldMesh, phi: ArrayLike<number>, out: Float64Array): Float64Array {
  const { nbrStart, nbr, coupling, area } = fm
  for (let i = 0; i < fm.count; i++) {
    const p = phi[i]
    let s = 0
    for (let e = nbrStart[i]; e < nbrStart[i + 1]; e++) s += coupling[e] * (phi[nbr[e]] - p)
    out[i] = s / area[i]
  }
  return out
}

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

// One implicit (backward Euler) diffusion step, unconditionally stable:
// (1 − dt κ ∇²) φ' = φ, the Helmholtz solve with α = 1 / (κ dt), from φ as
// the first guess. Into out (which may be phi).
export function diffuseImplicit(fm: FieldMesh, phi: ArrayLike<number>, kappa: number, dt: number, out: Float64Array, options: SolveOptions = {}): SolveReport {
  const alpha = 1 / (kappa * dt)
  const rhs = new Float64Array(fm.count)
  for (let i = 0; i < fm.count; i++) rhs[i] = -alpha * phi[i]
  if (out !== phi) for (let i = 0; i < fm.count; i++) out[i] = phi[i]
  return solveHelmholtz(fm, alpha, rhs, out, options)
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
// velocity in m / s.
export function divergence(fm: FieldMesh, ve: ArrayLike<number>, vs: ArrayLike<number>, out: Float64Array): Float64Array {
  const { nbrStart, nbr, wall, dist, offE, offS, turnC, turnS, area } = fm
  for (let i = 0; i < fm.count; i++) {
    const ae = ve[i]
    const as = vs[i]
    let s = 0
    for (let e = nbrStart[i]; e < nbrStart[i + 1]; e++) {
      const j = nbr[e]
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

// Departures known exactly rather than from a wind: cell i's parcel was at
// (px[i], py[i]) a step ago — a rigid plate's, turned back by its own
// motion (tectonics/oceanAge.ts), where a velocity sampled across a plate
// boundary would mix two plates. The taps and offsets as computeDepartures
// writes them.
export function departuresFromPoints(fm: FieldMesh, sampler: FieldSampler, px: ArrayLike<number>, py: ArrayLike<number>, out: Departures): Departures {
  const tap = departureTapper(fm, sampler, out)
  for (let i = 0; i < fm.count; i++) tap(i, px[i], py[i])
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

// A vector field moved by the departures: the corners' vectors
// interpolated at the departure (in 3D on the sphere, each from its own
// frame), carried along the great circle to the arrival cell and read in
// its frame. Into outE, outS (which must not be ve, vs).
export function transportVector(fm: FieldMesh, dep: Departures, ve: ArrayLike<number>, vs: ArrayLike<number>, outE: Float64Array, outS: Float64Array): void {
  const { corners, weights, unit } = dep
  for (let i = 0; i < fm.count; i++) {
    if (!fm.globe) {
      let e = 0
      let s = 0
      for (let k = 3 * i; k < 3 * i + 3; k++) {
        e += weights[k] * ve[corners[k]]
        s += weights[k] * vs[corners[k]]
      }
      outE[i] = e
      outS[i] = s
      continue
    }
    let vx = 0
    let vy = 0
    let vz = 0
    for (let k = 3 * i; k < 3 * i + 3; k++) {
      const c = corners[k]
      const a = ve[c] * weights[k]
      const b = vs[c] * weights[k]
      vx += a * fm.east[3 * c] + b * fm.south[3 * c]
      vy += a * fm.east[3 * c + 1] + b * fm.south[3 * c + 1]
      vz += a * fm.east[3 * c + 2] + b * fm.south[3 * c + 2]
    }
    const qx = unit[3 * i]
    const qy = unit[3 * i + 1]
    const qz = unit[3 * i + 2]
    const r = vx * qx + vy * qy + vz * qz
    vx -= r * qx
    vy -= r * qy
    vz -= r * qz
    const o = 3 * i
    const ux = fm.u[o]
    const uy = fm.u[o + 1]
    const uz = fm.u[o + 2]
    const c = qx * ux + qy * uy + qz * uz
    const wx = qy * uz - qz * uy
    const wy = qz * ux - qx * uz
    const wz = qx * uy - qy * ux
    const k = (wx * vx + wy * vy + wz * vz) / (1 + c)
    const rx = c * vx + (wy * vz - wz * vy) + wx * k
    const ry = c * vy + (wz * vx - wx * vz) + wy * k
    const rz = c * vz + (wx * vy - wy * vx) + wz * k
    outE[i] = rx * fm.east[o] + ry * fm.east[o + 1] + rz * fm.east[o + 2]
    outS[i] = rx * fm.south[o] + ry * fm.south[o + 1] + rz * fm.south[o + 2]
  }
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

// (∇² − α) φ = f by conjugate gradients, α ≥ 0 (1 / m²). Multiplied by −A,
// the system is the symmetric (−K + α A) φ = −A f, K the finite-volume
// coupling (K_ij = k_ij, K_ii = −Σ k_ij), positive definite for α > 0 and
// semi-definite with the constants as null space for α = 0 — then f's mean
// is removed and the solution returned with an area-weighted mean of 0.
// Jacobi preconditioning. `phi` holds the first guess and receives the
// solution. Every sum in a fixed order: the same input gives the same
// bytes.
export function solveHelmholtz(fm: FieldMesh, alpha: number, f: ArrayLike<number>, phi: Float64Array, options: SolveOptions = {}): SolveReport {
  const tolerance = options.tolerance ?? 1e-10
  const maxIterations = options.maxIterations ?? 2000
  const n = fm.count
  const { nbrStart, nbr, coupling, area } = fm
  let totalArea = 0
  for (let i = 0; i < n; i++) totalArea += area[i]
  let removedMean = 0
  const b = new Float64Array(n)
  if (alpha === 0) {
    let m = 0
    for (let i = 0; i < n; i++) m += area[i] * f[i]
    removedMean = m / totalArea
  }
  for (let i = 0; i < n; i++) b[i] = -area[i] * (f[i] - removedMean)
  const diag = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let s = alpha * area[i]
    for (let e = nbrStart[i]; e < nbrStart[i + 1]; e++) s += coupling[e]
    diag[i] = s
  }
  const apply = (x: ArrayLike<number>, out: Float64Array): void => {
    for (let i = 0; i < n; i++) {
      const xi = x[i]
      let s = alpha * area[i] * xi
      for (let e = nbrStart[i]; e < nbrStart[i + 1]; e++) s += coupling[e] * (xi - x[nbr[e]])
      out[i] = s
    }
  }
  const r = new Float64Array(n)
  const z = new Float64Array(n)
  const p = new Float64Array(n)
  const q = new Float64Array(n)
  apply(phi, q)
  let bNorm = 0
  for (let i = 0; i < n; i++) {
    r[i] = b[i] - q[i]
    bNorm += b[i] * b[i]
  }
  bNorm = Math.sqrt(bNorm)
  const finish = (iterations: number, residual: number, converged: boolean): SolveReport => {
    if (alpha === 0) {
      let m = 0
      for (let i = 0; i < n; i++) m += area[i] * phi[i]
      m /= totalArea
      for (let i = 0; i < n; i++) phi[i] -= m
    }
    return { iterations, residual, converged, removedMean }
  }
  if (bNorm === 0) {
    phi.fill(0)
    return finish(0, 0, true)
  }
  let rz = 0
  for (let i = 0; i < n; i++) {
    z[i] = r[i] / diag[i]
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
      phi[i] += a * p[i]
      r[i] -= a * q[i]
      rr += r[i] * r[i]
    }
    residual = Math.sqrt(rr) / bNorm
    if (residual <= tolerance) return finish(it, residual, true)
    let rzNext = 0
    for (let i = 0; i < n; i++) {
      z[i] = r[i] / diag[i]
      rzNext += r[i] * z[i]
    }
    const beta = rzNext / rz
    rz = rzNext
    for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i]
  }
  return finish(maxIterations, residual, false)
}
