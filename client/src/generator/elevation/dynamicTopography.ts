import type { FieldSampler } from '../fields/fieldMesh'
import { rasteriseNodeField } from '../mesh/meshRaster'
import { ELEVATION_TUNING } from './elevationTuneParams'

// The term over a `width`×`height` grid that covers the domain (a render
// grid may be coarser than the world), at each cell's corner as the render
// samples (px · W / width). The field is rasterised on the sampler's mesh
// (linear in its triangles, a scanline walk) at the corners of a grid of at
// most DYNAMIC_RASTER_X × DYNAMIC_RASTER_Y, plus the row at y = H (the
// south pole on the sphere, row 0 again on the torus), and read bilinearly
// from it (a mantle cell, 125–156 km, spans 4–5 of its cells). Measured
// 2026-10-11 at 2048 × 1024 against the per-point term (now the engine's
// `dynamic_topography_at`) per pixel: at most
// 6 m (torus) and 9 m (sphere) off a term of ±550 m, for 13–14 ms instead of
// 340–440 (a locate per pixel). The render only; the engine's coupled
// epoch reads `dynamic_topography_at` per node.
const DYNAMIC_RASTER_X = 256
const DYNAMIC_RASTER_Y = 128

export function dynamicTopographyField(mantle: ArrayLike<number>, mantleSampler: FieldSampler, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height)
  if (ELEVATION_TUNING.dynamicTopographyPerUnit === 0) return out
  const scale = ELEVATION_TUNING.dynamicTopographyPerUnit
  const { tri, domain } = mantleSampler.mesh
  const cw = Math.min(width, DYNAMIC_RASTER_X)
  const ch = Math.min(height, DYNAMIC_RASTER_Y)
  const coarse = new Float32Array(cw * (ch + 1))
  rasteriseNodeField(tri, mantle, cw, ch, coarse.subarray(0, cw * ch))
  for (let i = 0; i < cw; i++) coarse[ch * cw + i] = mantleSampler.sample(mantle, (i * domain.width) / cw, domain.height)
  for (let py = 0; py < height; py++) {
    const fy = (py * ch) / height
    const j = Math.floor(fy)
    const ty = fy - j
    for (let px = 0; px < width; px++) {
      const fx = (px * cw) / width
      const i = Math.floor(fx)
      const tx = fx - i
      const i1 = i + 1 < cw ? i + 1 : 0
      const a = coarse[j * cw + i] + (coarse[j * cw + i1] - coarse[j * cw + i]) * tx
      const b = coarse[(j + 1) * cw + i] + (coarse[(j + 1) * cw + i1] - coarse[(j + 1) * cw + i]) * tx
      out[py * width + px] = (a + (b - a) * ty) * scale
    }
  }
  return out
}
