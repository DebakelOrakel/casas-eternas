import type { PeriodicTriangulation } from './periodicDelaunay'
import { barycentric } from './remesh'

// RASTERISING A NODE FIELD: the mesh sampled on a regular grid, linearly
// within each triangle. The harness compares the mesh engine to the raster
// engine through it (decision 4 of docs/decisions/adaptive-mesh.md: the
// metrics run on a 2048 rasterisation), and map/ reads the mesh the same
// way from phase 4.4 on. Pixel centres at (i + 0.5) of a cell — the
// convention of core/field.sampleBilinearWorld, so a raster made here and
// one sampled there agree on where a cell is.
//
// Point location walks from the previous pixel's triangle: along a row
// the next centre is one cell over, a step or two away, so the whole
// raster costs about one triangle visit per pixel.
export function rasteriseNodeField(mesh: PeriodicTriangulation, field: ArrayLike<number>, width: number, height: number, out?: Float32Array): Float32Array {
  const result = out ?? new Float32Array(width * height)
  const sx = mesh.domain.width / width
  const sy = mesh.domain.height / height
  const bary = new Float64Array(3)
  let hint = mesh.lastTri
  let rowStart = hint
  for (let py = 0; py < height; py++) {
    const y = (py + 0.5) * sy
    hint = rowStart
    for (let px = 0; px < width; px++) {
      const x = (px + 0.5) * sx
      const t = mesh.locate(x, y, hint)
      hint = t
      if (px === 0) rowStart = t
      barycentric(mesh, t, x, y, bary)
      const a = mesh.tris[3 * t]
      const b = mesh.tris[3 * t + 1]
      const c = mesh.tris[3 * t + 2]
      result[py * width + px] = bary[0] * field[a] + bary[1] * field[b] + bary[2] * field[c]
    }
  }
  return result
}
