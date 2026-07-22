import type { PlateSeed } from './plateSeeds'
import { toroidalDistanceSq } from './toroidal'

// Nearest-seed assignment per pixel, using toroidal (wrapped) distance —
// this is the actual Voronoi partition of the map into plates, kept as a
// plain ID grid rather than computed polygon boundaries: later tectonics
// work (plate adjacency, boundary stress) can scan this raster for
// pixels whose neighbor has a different ID rather than needing exact
// edge geometry. One ID (index into `seeds`) per pixel.
//
// Previously also tracked second-nearest plate/distance for a baseline
// blend that used only the nearest two plates — dropped because which
// plate counts as *second*-nearest can switch identity at a line inside
// a cell's own interior, causing a visible discontinuity there even
// though nothing about the cell's actual boundary changed. See
// elevationField.ts's computeBlendedBaselines for the replacement, which
// blends across every nearby plate instead of a hard top-2 cutoff.
export function rasterizeVoronoiPlates(seeds: PlateSeed[], width: number, height: number): Uint16Array {
  const cellIds = new Uint16Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let bestId = 0
      let bestDistSq = Infinity
      for (let i = 0; i < seeds.length; i++) {
        const distSq = toroidalDistanceSq(x, y, seeds[i].x, seeds[i].y, width, height)
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
