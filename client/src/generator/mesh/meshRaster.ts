import type { PeriodicTriangulation } from './periodicDelaunay'

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
      mesh.barycentric(t, x, y, bary)
      const a = mesh.tris[3 * t]
      const b = mesh.tris[3 * t + 1]
      const c = mesh.tris[3 * t + 2]
      result[py * width + px] = bary[0] * field[a] + bary[1] * field[b] + bary[2] * field[c]
    }
  }
  return result
}

// Where every pixel of a raster lies on a mesh: its triangle and the
// first two barycentric weights (the third is the rest), rasteriseNodeField's
// convention (cell px at x = px). Made once for a mesh and a raster size and
// handed to rasteriseNodePart, so a stage that draws many fields from one
// mesh (the ecology's fourteen) locates each pixel once: 12 bytes a pixel.
export interface TriangleRaster {
  mesh: PeriodicTriangulation
  width: number
  height: number
  tri: Int32Array
  w0: Float32Array
  w1: Float32Array
}

export function triangleRaster(mesh: PeriodicTriangulation, width: number, height: number): TriangleRaster {
  const n = width * height
  const tri = new Int32Array(n)
  const w0 = new Float32Array(n)
  const w1 = new Float32Array(n)
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
      mesh.barycentric(t, x, y, bary)
      const p = py * width + px
      tri[p] = t
      w0[p] = bary[0]
      w1[p] = bary[1]
    }
  }
  return { mesh, width, height, tri, w0, w1 }
}

// A node field that holds values on a PART of the nodes (the land's, the
// sea's) rasterised for the screen and a save's readers (DEC-0036 phase 7:
// the biomes, the Köppen classes, the ecology's fields): a pixel `pixelIn`
// admits (null: every one) reads only the corners of its triangle `nodeIn`
// admits — linearly, their weights renormalised (`nearest` false), or the
// heaviest of them (`nearest` true: an id field) — never a blend with the
// part it does not hold; a pixel with no admitted corner takes the nearest
// admitted node of the corners' stars, and with none there either
// `outside`, as every pixel `pixelIn` refuses. The convention is
// rasteriseNodeField's (cell px at x = px). `plan`: the pixels' triangles
// (triangleRaster), made here when not given.
export function rasteriseNodePart(mesh: PeriodicTriangulation, field: ArrayLike<number>, nodeIn: Uint8Array, pixelIn: Uint8Array | null, outside: number, width: number, height: number, nearest: boolean, out?: Float32Array, plan?: TriangleRaster): Float32Array {
  const result = out ?? new Float32Array(width * height)
  const where = plan && plan.mesh === mesh && plan.width === width && plan.height === height ? plan : triangleRaster(mesh, width, height)
  const sx = mesh.domain.width / width
  const sy = mesh.domain.height / height
  const star = new Int32Array(256)
  const d = { x: 0, y: 0 }
  const w = new Float64Array(3)
  for (let p = 0; p < width * height; p++) {
    if (pixelIn && !pixelIn[p]) { result[p] = outside; continue }
    const t = where.tri[p]
    w[0] = where.w0[p]
    w[1] = where.w1[p]
    w[2] = 1 - w[0] - w[1]
    let sum = 0
    let weight = 0
    let best = -1
    let bestW = -1
    for (let k = 0; k < 3; k++) {
      const v = mesh.tris[3 * t + k]
      if (!nodeIn[v]) continue
      sum += w[k] * field[v]
      weight += w[k]
      if (w[k] > bestW) { bestW = w[k]; best = v }
    }
    if (best >= 0) {
      result[p] = nearest ? field[best] : weight > 0 ? sum / weight : field[best]
      continue
    }
    // No admitted corner: the nearest admitted node of the corners' stars.
    const x = (p % width) * sx
    const y = Math.floor(p / width) * sy
    let near = -1
    let nearSq = Infinity
    for (let k = 0; k < 3; k++) {
      const n = mesh.neighbours(mesh.tris[3 * t + k], star)
      for (let s = 0; s < n; s++) {
        const v = star[s]
        if (!nodeIn[v]) continue
        mesh.domain.delta(mesh.vx[v], mesh.vy[v], x, y, d)
        const dd = d.x * d.x + d.y * d.y
        if (dd < nearSq) { nearSq = dd; near = v }
      }
    }
    result[p] = near >= 0 ? field[near] : outside
  }
  return result
}
