import type { DomainGrid } from '../core/domain'
// Forward-difference hillshade for the map's "paper" relief, lit from the
// top-left. Exaggerated since normalized elevation deltas are tiny per pixel.
// Extracted unchanged from elevationMapImage.ts (2026-08-07) so the worldmap
// screen can derive the IDENTICAL relief byte from a saved world's elevation
// raster — one formula, two producers, zero drift.
const RELIEF_EXAGGERATION = 45
const LX = -0.502
const LY = -0.502
const LZ = 0.703 // normalized top-left light

// Shade (0..1) at cell `i`, from its forward-difference neighbours `right`
// and `down` (cell indices, wrapped by the caller's grid).
export function reliefShadeAt(elevations: Float32Array, i: number, right: number, down: number): number {
  const e = elevations[i]
  const dzdx = (elevations[right] - e) * RELIEF_EXAGGERATION
  const dzdy = (elevations[down] - e) * RELIEF_EXAGGERATION
  const ndotl = (-dzdx * LX - dzdy * LY + LZ) / Math.hypot(dzdx, dzdy, 1)
  return ndotl < 0 ? 0 : ndotl > 1 ? 1 : ndotl
}

// The full packed relief raster (top bit = land, low 7 bits = shade 0..127)
// from an elevation raster alone — the worldmap screen's path, which has no
// dry-basin mask. The generator's render loop packs its bytes inline instead
// (fused with coloring/boundary work, plus the dryBasin land-bit special
// case) but reads its shade from reliefShadeAt above.
export function computeReliefBytes(elevations: Float32Array, grid: DomainGrid): Uint8Array {
  const { resX: width, resY: height } = grid
  const cols = grid.colTable(1)
  const rows = grid.rowTable(1)
  const relief = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      relief[idx] = (elevations[idx] > 0 ? 128 : 0) | Math.round(reliefShadeAt(elevations, idx, y * width + cols[x + 2], rows[y + 2] + x) * 127)
    }
  }
  return relief
}
