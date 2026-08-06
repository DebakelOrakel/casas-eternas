import { elevationToColor } from '../elevation/elevationColor'
import { SEA_LEVEL } from '../elevation/elevationScale'

// RGBA raster for a micro tile (surface/tileErosion.ts) — the same
// hypsometric ramp the world map uses, an inline hillshade, and a faint
// river tint from the tile's own accumulation, baked into one image. Baked
// rather than layered because the tile viewer is a one-shot debug inspector,
// not a composited map: there is nothing to toggle, and the river tint is
// exactly what the fine-resolution question is about.
//
// Hillshade exaggeration scales with the refinement factor: at factor F a
// fine pixel's elevation step is ~1/F of a macro pixel's for the same
// physical slope, so the macro map's constant (45, elevationMapImage.ts)
// would render the tile nearly flat.
const BASE_RELIEF_EXAGGERATION = 45
const LX = -0.502, LY = -0.502, LZ = 0.703 // normalized top-left light, as the world map

export function renderMicroTileImage(elevations: Float32Array, accumulation: Float32Array, n: number, factor: number, riverThresholdFine: number): Uint8Array {
  const exaggeration = BASE_RELIEF_EXAGGERATION * factor
  const rgba = new Uint8Array(n * n * 4)
  for (let y = 0; y < n; y++) {
    const down = Math.min(n - 1, y + 1)
    for (let x = 0; x < n; x++) {
      const i = y * n + x
      const right = y * n + Math.min(n - 1, x + 1)
      const e = elevations[i]
      const color = elevationToColor(e)
      let r = color[0], g = color[1], b = color[2]
      const dzdx = (elevations[right] - e) * exaggeration
      const dzdy = (elevations[down * n + x] - e) * exaggeration
      const ndotl = (-dzdx * LX - dzdy * LY + LZ) / Math.hypot(dzdx, dzdy, 1)
      const shade = 0.6 + 0.4 * Math.max(0, Math.min(1, ndotl))
      r *= shade; g *= shade; b *= shade
      if (e > SEA_LEVEL && accumulation[i] >= riverThresholdFine) {
        const t = Math.min(1, Math.log10(accumulation[i] / riverThresholdFine + 1))
        r = r * (1 - t) + 30 * t
        g = g * (1 - t) + 90 * t
        b = b * (1 - t) + 200 * t
      }
      const o = i * 4
      rgba[o] = Math.min(255, r | 0)
      rgba[o + 1] = Math.min(255, g | 0)
      rgba[o + 2] = Math.min(255, b | 0)
      rgba[o + 3] = 255
    }
  }
  return rgba
}
