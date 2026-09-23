import type { PeriodicTriangulation } from './periodicDelaunay'
import { barycentric } from './remesh'

// RASTERISING A NODE FIELD: the mesh sampled on a regular grid, linearly
// within each triangle. The harness compares the mesh engine to the raster
// engine through it (decision 4 of docs/decisions/adaptive-mesh.md: the
// metrics run on a 2048 rasterisation), and map/ reads the mesh the same
// way from phase 4.4 on. Cell (px, py) holds the field AT the world point
// (px, py) — the convention of the raster synthesis (elevationMapImage,
// the render worker: cell px is the synthesis at world x = px), so the
// raster made here compares cell for cell with the pre-erosion raster the
// hydrology, the sediment basins and the golden metrics hold it against.
// (core/field.sampleBilinearWorld reads a raster with centres at +0.5, a
// second convention that predates this and the map keeps; the two differ
// by half a cell, as they always have. Sampling at +0.5 here put every
// "before/after" metric half a cell off and read the shift as deposition —
// sediment basins ×7 on the first golden run.)
//
// Point location walks from the previous pixel's triangle: along a row
// the next point is one cell over, a step or two away, so the whole
// raster costs about one triangle visit per pixel.
export function rasteriseNodeField(mesh: PeriodicTriangulation, field: ArrayLike<number>, width: number, height: number, out?: Float32Array): Float32Array {
  const result = out ?? new Float32Array(width * height)
  const sx = mesh.domain.width / width
  const sy = mesh.domain.height / height
  const bary = new Float64Array(3)
  let hint = mesh.lastTri
  let rowStart = hint
  for (let py = 0; py < height; py++) {
    const y = py * sy
    hint = rowStart
    for (let px = 0; px < width; px++) {
      const x = px * sx
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
