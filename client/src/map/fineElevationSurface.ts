import { fineDetailNoise } from '../worldgen/elevation/ridgedNoise'
import { metersToElevation } from '../worldgen/elevation/elevationScale'
import type { ElevationSurface } from './elevationSurface'

// The FINE height sampler — the first cut of the "one shared fine-height
// seam" from docs/design/hex-world-view.md: macro raster (bilinear, toroidal)
// plus deterministic sub-cell detail, so near-ground views stop being
// silky-smooth 7.8 km lozenges.
//
// The noise source is worldgen's own fineDetailNoise (periodic across the
// torus, continuous at fractional coordinates), but sampled as a FRACTAL
// CASCADE: fineDetailNoise's own octave table bottoms out at ~15.6 km
// wavelength — two raster cells, i.e. exactly the content the raster
// already carries — so on its own it adds nothing visible at a 4 km view.
// Each cascade step re-evaluates it on a 3× smaller periodic domain
// (frequencies ×3, torus seam preserved since the world period stays an
// integer multiple), pushing detail down to ~300 m wavelengths, with
// fractal amplitude falloff per step. The cascade starts at HALF a raster
// wavelength on purpose: above that, the eroded raster is real data the
// synthesis must not fight.
//
// The overall amplitude is slope-conditioned (gentle plains get metres,
// carved hillsides get up to ~240 m of roughness) and clamped to the cell's
// own height above sea level, so no land sample can dip below water; ocean
// stays the flat y = 0 surface, same convention as elevationSurface. The
// seed should derive from the world (the worldmap screen hashes the save's
// seed string); it is NOT the generator's warpSeed, so the pattern won't
// match a future in-generator fine render — acceptable until the manifest
// carries the real seed.
const DETAIL_FLOOR = metersToElevation(12)
const DETAIL_SLOPE_GAIN = metersToElevation(3500)
const DETAIL_CAP = metersToElevation(240)

// Cascade: domain divisor per step ×3 (each fineDetailNoise call spans two
// internal octaves, so steps of 3 still cover the band densely). The
// falloff is deliberately SHALLOW (H ≈ 0.45 — rough, young-terrain
// scaling): with a classic ~0.45-per-step falloff the sub-km band ended up
// carrying only ±3–7 m and the near view still read as polished
// (data-checked 2026-08-07); most of what the eye calls "detail" lives in
// exactly that band.
const CASCADE_SCALES = [2, 6, 18, 54]
const CASCADE_AMPLITUDES = [1, 0.6, 0.42, 0.3]
const CASCADE_NORM = CASCADE_AMPLITUDES.reduce((a, b) => a + b, 0)

// `bias` shifts the zero-mean cascade upward in units of the local
// amplitude (noise spans roughly ±0.5, so bias 0.6 keeps every sample
// strictly ABOVE the plain raster surface). The detail patch needs that:
// the smooth relief mesh keeps rendering underneath it, and any sample
// dipping below it would simply be occluded — half the detail swallowed.
// Consumers that want the unbiased height truth pass 0.
export function createFineElevationSurface(elevation: Float32Array, resX: number, resY: number, heightScale: number, seed: number, bias = 0): ElevationSurface {
  const wrap = (i: number, n: number): number => ((i % n) + n) % n
  return {
    heightAtUV(u: number, v: number): number {
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
      const e00 = elevation[y0w * resX + x0w]
      const e10 = elevation[y0w * resX + x1w]
      const e01 = elevation[y1w * resX + x0w]
      const e11 = elevation[y1w * resX + x1w]
      const base = (e00 * (1 - fx) + e10 * fx) * (1 - fy) + (e01 * (1 - fx) + e11 * fx) * fy
      if (base <= 0) return 0
      const slope = Math.hypot(e10 - e00, e01 - e00)
      const amplitude = Math.min(DETAIL_CAP, DETAIL_FLOOR + DETAIL_SLOPE_GAIN * slope, base)
      const px = wrap(u * resX, resX)
      const py = wrap(v * resY, resY)
      let detail = 0
      for (let i = 0; i < CASCADE_SCALES.length; i++) {
        const s = CASCADE_SCALES[i]
        detail += fineDetailNoise(px, py, resX / s, resY / s, (seed + i * 0x9e3779b9) >>> 0) * CASCADE_AMPLITUDES[i]
      }
      return Math.max(0, base + (detail / CASCADE_NORM + bias) * amplitude) * heightScale
    },
  }
}
