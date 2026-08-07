// Shared "where is the terrain surface" for the worldgen relief preview: the
// displaced map plane (ToroidalMapView's relief layer) and everything draped
// onto it (the river ribbons) must read the SAME surface, or they visibly
// disagree — ribbons floating over valleys or buried inside slopes.
//
// Heights are display-space: sampled bilinearly (toroidal wrap in both axes,
// matching the world) from the redistributed elevation raster the map colors
// were computed from (see WorkerElevationFieldMessage), clamped at sea level
// so the ocean stays the flat y = 0 water surface the flat map plane already
// is — bathymetry displaced downward would just push the ocean colors below
// their own coastline.

export interface ElevationSurface {
  // Terrain surface height in world Y units at normalized map coords (u, v) —
  // the same 0..1 space as the map plane's UVs, with v running top→bottom in
  // step with the raster's row order (texel coords / texture size; see
  // MapHoverTooltip's identical convention).
  heightAtUV(u: number, v: number): number
}

// Box-filter downsample by an integer factor (both axes). The relief preview
// builds its ONE canonical surface from a decimated raster on purpose: the
// relief mesh has a vertex per decimated cell, and the ribbons sample the
// same decimated grid — so both agree everywhere by construction. Sampling
// the ribbons from the full-res raster instead would bury rivers wherever
// the coarser mesh planes across a narrow valley the full raster resolves.
export function downsampleElevation(data: Float32Array, resX: number, resY: number, factor: number): { data: Float32Array; resX: number; resY: number } {
  if (factor <= 1) return { data, resX, resY }
  const outX = Math.floor(resX / factor)
  const outY = Math.floor(resY / factor)
  const out = new Float32Array(outX * outY)
  for (let y = 0; y < outY; y++) {
    for (let x = 0; x < outX; x++) {
      let sum = 0
      for (let dy = 0; dy < factor; dy++) {
        const row = (y * factor + dy) * resX + x * factor
        for (let dx = 0; dx < factor; dx++) sum += data[row + dx]
      }
      out[y * outX + x] = sum / (factor * factor)
    }
  }
  return { data: out, resX: outX, resY: outY }
}

// heightScale converts one display-elevation unit (the -1..1 scale where 1.0
// = ELEVATION_METERS) into world Y units — the caller owns that constant
// since it knows the scene's metres-per-world-unit (see WorldGenScreen).
export function createElevationSurface(elevation: Float32Array, resX: number, resY: number, heightScale: number): ElevationSurface {
  const wrap = (i: number, n: number): number => ((i % n) + n) % n
  return {
    heightAtUV(u: number, v: number): number {
      // -0.5: raster values sit at texel centers.
      const x = u * resX - 0.5
      const y = v * resY - 0.5
      const x0 = Math.floor(x)
      const y0 = Math.floor(y)
      const fx = x - x0
      const fy = y - y0
      const x0w = wrap(x0, resX)
      const x1w = wrap(x0 + 1, resX)
      const y0w = wrap(y0, resY)
      const y1w = wrap(y0 + 1, resY)
      const top = elevation[y0w * resX + x0w] * (1 - fx) + elevation[y0w * resX + x1w] * fx
      const bottom = elevation[y1w * resX + x0w] * (1 - fx) + elevation[y1w * resX + x1w] * fx
      return Math.max(0, top * (1 - fy) + bottom * fy) * heightScale
    },
  }
}
