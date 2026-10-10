import type { PlateSeed } from '../tectonics/plateSeeds'
import type { Domain } from '../core/domain'

// Nearest-seed assignment per pixel, using the domain's (wrapped) distance —
// this is the actual Voronoi partition of the map into plates, kept as a
// plain ID grid rather than computed polygon boundaries: later tectonics
// work (plate adjacency, boundary stress) can scan this raster for
// pixels whose neighbor has a different ID rather than needing exact
// edge geometry. One ID (index into `seeds`) per pixel.
//
// Only the nearest-plate ID now — earlier versions also tracked second-
// nearest for a plate-distance baseline blend, but the baseline no longer
// keys off plate distance at all (it's raft membership + ocean age; see
// elevationField.ts's computeRaftBaseline), so that bookkeeping is gone.
export function rasterizeVoronoiPlates(seeds: PlateSeed[], domain: Domain): Uint16Array {
  const { width, height } = domain
  const cellIds = new Uint16Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let bestId = 0
      let bestDistSq = Infinity
      for (let i = 0; i < seeds.length; i++) {
        const distSq = domain.distanceSq(x, y, seeds[i].x, seeds[i].y)
        if (distSq < bestDistSq) {
          bestDistSq = distSq
          bestId = i
        }
      }
      cellIds[y * width + x] = bestId
    }
  }
  return cellIds
}
