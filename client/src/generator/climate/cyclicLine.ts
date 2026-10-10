// ONE ROW OF THE CLIMATE GRID AS A LINE (DEC-0035, fork 5, step 4e): the
// cyclic tridiagonal system of a whole row, solved at once. On the sphere a
// row's cells narrow as cos φ, so toward a pole the coupling east-west of a
// diffusion or a Poisson solve is 1 / cos² φ times the coupling north-south,
// and point Gauss-Seidel moves such a row's mean by a tiny part of its error
// a sweep (oceanCurrents' RowLines and mantleField's line solver met the
// same). A solver relaxes those rows as lines; the torus's rows never are.
//
// The system, for k in 0..n−1 with the indices cyclic (x[−1] is x[n−1],
// x[n] is x[0]):
//
//   lower[k] · x[k−1] + diag[k] · x[k] + upper[k] · x[k+1] = rhs[k]
//
// The diagonal and the right-hand side are complex (the energy balance
// solves for a harmonic's amplitude; a real system passes zeros for the
// imaginary parts), the off-diagonals real. Thomas's algorithm with the
// Sherman–Morrison correction for the two corners (Numerical Recipes'
// `cyclic`). n ≥ 3.
export class CyclicLine {
  readonly n: number
  readonly lower: Float64Array
  readonly upper: Float64Array
  readonly diagRe: Float64Array
  readonly diagIm: Float64Array
  readonly rhsRe: Float64Array
  readonly rhsIm: Float64Array
  readonly outRe: Float64Array
  readonly outIm: Float64Array
  private readonly bRe: Float64Array
  private readonly bIm: Float64Array
  private readonly cpRe: Float64Array
  private readonly cpIm: Float64Array
  private readonly zRe: Float64Array
  private readonly zIm: Float64Array
  private readonly uRe: Float64Array
  private readonly uIm: Float64Array

  constructor(n: number) {
    if (n < 3) throw new Error(`a cyclic line needs at least 3 cells, got ${n}`)
    this.n = n
    const make = (): Float64Array => new Float64Array(n)
    this.lower = make()
    this.upper = make()
    this.diagRe = make()
    this.diagIm = make()
    this.rhsRe = make()
    this.rhsIm = make()
    this.outRe = make()
    this.outIm = make()
    this.bRe = make()
    this.bIm = make()
    this.cpRe = make()
    this.cpIm = make()
    this.zRe = make()
    this.zIm = make()
    this.uRe = make()
    this.uIm = make()
  }

  // Solves the system the arrays hold into outRe, outIm.
  solve(): void {
    const { n, lower, upper, diagRe, diagIm, bRe, bIm, uRe, uIm } = this
    // γ = −diag[0]; the corners are β = lower[0] (row 0, column n − 1) and
    // α = upper[n − 1] (row n − 1, column 0).
    const gRe = -diagRe[0]
    const gIm = -diagIm[0]
    const alpha = upper[n - 1]
    const beta = lower[0]
    bRe.set(diagRe)
    bIm.set(diagIm)
    bRe[0] = diagRe[0] - gRe
    bIm[0] = diagIm[0] - gIm
    // diag[n − 1] − αβ / γ.
    const g2 = gRe * gRe + gIm * gIm
    const ab = alpha * beta
    bRe[n - 1] = diagRe[n - 1] - (ab * gRe) / g2
    bIm[n - 1] = diagIm[n - 1] + (ab * gIm) / g2
    this.thomas(this.rhsRe, this.rhsIm, this.outRe, this.outIm)
    uRe.fill(0)
    uIm.fill(0)
    uRe[0] = gRe
    uIm[0] = gIm
    uRe[n - 1] = alpha
    this.thomas(uRe, uIm, this.zRe, this.zIm)
    // fact = (x0 + β x[n−1] / γ) / (1 + z0 + β z[n−1] / γ).
    const over = (re: number, im: number, out: { re: number; im: number }): void => {
      // β · (re + i im) / γ
      out.re = (beta * (re * gRe + im * gIm)) / g2
      out.im = (beta * (im * gRe - re * gIm)) / g2
    }
    const t = { re: 0, im: 0 }
    over(this.outRe[n - 1], this.outIm[n - 1], t)
    const numRe = this.outRe[0] + t.re
    const numIm = this.outIm[0] + t.im
    over(this.zRe[n - 1], this.zIm[n - 1], t)
    const denRe = 1 + this.zRe[0] + t.re
    const denIm = this.zIm[0] + t.im
    const dd = denRe * denRe + denIm * denIm
    const fRe = (numRe * denRe + numIm * denIm) / dd
    const fIm = (numIm * denRe - numRe * denIm) / dd
    for (let k = 0; k < n; k++) {
      const zr = this.zRe[k]
      const zi = this.zIm[k]
      this.outRe[k] -= fRe * zr - fIm * zi
      this.outIm[k] -= fRe * zi + fIm * zr
    }
  }

  // The tridiagonal system with diagonal (bRe, bIm), the corners left out.
  private thomas(rRe: Float64Array, rIm: Float64Array, xRe: Float64Array, xIm: Float64Array): void {
    const { n, lower, upper, bRe, bIm, cpRe, cpIm } = this
    let pRe = bRe[0]
    let pIm = bIm[0]
    let pp = pRe * pRe + pIm * pIm
    cpRe[0] = (upper[0] * pRe) / pp
    cpIm[0] = (-upper[0] * pIm) / pp
    xRe[0] = (rRe[0] * pRe + rIm[0] * pIm) / pp
    xIm[0] = (rIm[0] * pRe - rRe[0] * pIm) / pp
    for (let k = 1; k < n; k++) {
      const a = lower[k]
      pRe = bRe[k] - a * cpRe[k - 1]
      pIm = bIm[k] - a * cpIm[k - 1]
      pp = pRe * pRe + pIm * pIm
      cpRe[k] = (upper[k] * pRe) / pp
      cpIm[k] = (-upper[k] * pIm) / pp
      const nRe = rRe[k] - a * xRe[k - 1]
      const nIm = rIm[k] - a * xIm[k - 1]
      xRe[k] = (nRe * pRe + nIm * pIm) / pp
      xIm[k] = (nIm * pRe - nRe * pIm) / pp
    }
    for (let k = n - 2; k >= 0; k--) {
      const nr = xRe[k + 1]
      const ni = xIm[k + 1]
      xRe[k] -= cpRe[k] * nr - cpIm[k] * ni
      xIm[k] -= cpRe[k] * ni + cpIm[k] * nr
    }
  }
}

// The rows a solver relaxes as lines: those whose east-west weight over
// their area passes LINE_COUPLING (oceanCurrents' and mantleField's rule —
// the sphere from about 45° on; on the torus every row's is 1 and none is).
export const LINE_COUPLING = 2
