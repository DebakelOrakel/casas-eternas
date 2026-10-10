import type { Domain } from '../core/domain'

export interface LatticePoint {
  x: number
  y: number
}

// A fixed grid of sample points across the map, independent of both the
// display raster's resolution and the plates' own (moving) seed
// positions — boundary detection runs against this every epoch. This is
// what makes it possible to hold persistent per-point state (accumulated
// convergence, locked-epoch counters — see plateSimulation.ts) keyed to
// a stable identity: the lattice points themselves never move, only
// which plate is nearest to each one changes as plates rotate underneath.
//
// On the sphere the rows narrow toward the poles, so a row keeps the
// columns its length can hold — round(resolutionX · sin θ) at its
// colatitude θ, at least one — and the points stand as far apart at 70° as
// at the equator. A chart-uniform lattice would put most of its points and
// so most of its boundary samples near the poles; the per-feature deposit
// is averaged over its points, but the rift and merge triggers count them.
export function generateDetectionLattice(domain: Domain, resolutionX: number, resolutionY: number): LatticePoint[] {
  const { width, height } = domain
  // rowScale is 1 on the torus: every row holds resolutionX points.
  const grid = domain.grid(resolutionX, resolutionY)
  const points: LatticePoint[] = []
  for (let row = 0; row < resolutionY; row++) {
    const cols = Math.max(1, Math.round(resolutionX * grid.rowScale(row)))
    for (let col = 0; col < cols; col++) {
      points.push({
        x: ((col + 0.5) / cols) * width,
        y: ((row + 0.5) / resolutionY) * height,
      })
    }
  }
  return points
}
