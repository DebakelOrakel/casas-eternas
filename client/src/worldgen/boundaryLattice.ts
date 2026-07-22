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
export function generateDetectionLattice(width: number, height: number, resolutionX: number, resolutionY: number): LatticePoint[] {
  const points: LatticePoint[] = []
  for (let row = 0; row < resolutionY; row++) {
    for (let col = 0; col < resolutionX; col++) {
      points.push({
        x: ((col + 0.5) / resolutionX) * width,
        y: ((row + 0.5) / resolutionY) * height,
      })
    }
  }
  return points
}
