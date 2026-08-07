// Forward-difference hillshade for the map's "paper" relief, lit from the
// top-left. Exaggerated since normalized elevation deltas are tiny per pixel.
// Extracted unchanged from elevationMapImage.ts (2026-08-07) so the worldmap
// screen can derive the IDENTICAL relief byte from a saved world's elevation
// raster — one formula, two producers, zero drift.
const RELIEF_EXAGGERATION = 45
const LX = -0.502
const LY = -0.502
const LZ = 0.703 // normalized top-left light

// Shade (0..1) at (x, y); the forward-difference neighbors wrap toroidally.
export function reliefShadeAt(elevations: Float32Array, width: number, height: number, x: number, y: number): number {
  const e = elevations[y * width + x]
  const dzdx = (elevations[y * width + ((x + 1) % width)] - e) * RELIEF_EXAGGERATION
  const dzdy = (elevations[((y + 1) % height) * width + x] - e) * RELIEF_EXAGGERATION
  const ndotl = (-dzdx * LX - dzdy * LY + LZ) / Math.hypot(dzdx, dzdy, 1)
  return ndotl < 0 ? 0 : ndotl > 1 ? 1 : ndotl
}

// The full packed relief raster (top bit = land, low 7 bits = shade 0..127)
// from an elevation raster alone — the worldmap screen's path, which has no
// dry-basin mask. The generator's render loop packs its bytes inline instead
// (fused with coloring/boundary work, plus the dryBasin land-bit special
// case) but reads its shade from reliefShadeAt above.
export function computeReliefBytes(elevations: Float32Array, width: number, height: number): Uint8Array {
  const relief = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      relief[idx] = (elevations[idx] > 0 ? 128 : 0) | Math.round(reliefShadeAt(elevations, width, height, x, y) * 127)
    }
  }
  return relief
}
