import type { FieldMesh } from './fieldMesh'

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
