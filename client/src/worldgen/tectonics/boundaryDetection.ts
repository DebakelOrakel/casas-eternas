import type { LatticePoint } from './boundaryLattice'
import type { PlateSeed } from './plateSeeds'
import { toroidalDistanceSq } from '../core/toroidal'

export interface BoundaryPoint {
  latticeIndex: number
  x: number
  y: number
  plateA: number
  plateB: number
}

// How close the nearest and second-nearest plate's distances need to be
// (relative to the nearest distance itself) for a lattice point to count
// as sitting on a boundary rather than deep inside one plate's own
// territory.
const BOUNDARY_GAP_THRESHOLD = 0.15

// Finds, for every fixed lattice point, which two plates are nearest to
// it (by wrapped distance to their CURRENT seed position) and keeps only
// the points where those two are close enough to count as a shared
// boundary. No explicit boundary-curve object is built — this implicit,
// recomputed-every-epoch approach is what the sphere version already
// uses, adapted to wrapped 2D distance instead of geodesic distance.
export function detectBoundaries(lattice: LatticePoint[], seeds: PlateSeed[], width: number, height: number): BoundaryPoint[] {
  const boundaries: BoundaryPoint[] = []
  for (let i = 0; i < lattice.length; i++) {
    const point = lattice[i]
    let nearestIndex = -1
    let nearestDistSq = Infinity
    let secondIndex = -1
    let secondDistSq = Infinity
    for (let p = 0; p < seeds.length; p++) {
      const distSq = toroidalDistanceSq(point.x, point.y, seeds[p].x, seeds[p].y, width, height)
      if (distSq < nearestDistSq) {
        secondDistSq = nearestDistSq
        secondIndex = nearestIndex
        nearestDistSq = distSq
        nearestIndex = p
      } else if (distSq < secondDistSq) {
        secondDistSq = distSq
        secondIndex = p
      }
    }
    const nearestDist = Math.sqrt(nearestDistSq)
    const secondDist = Math.sqrt(secondDistSq)
    const gap = (secondDist - nearestDist) / Math.max(nearestDist, 1e-6)
    if (gap < BOUNDARY_GAP_THRESHOLD) {
      boundaries.push({ latticeIndex: i, x: point.x, y: point.y, plateA: nearestIndex, plateB: secondIndex })
    }
  }
  return boundaries
}
