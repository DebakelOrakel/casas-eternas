import { METERS_PER_CELL } from '../core/mapConfig'
import { ELEVATION_METERS } from '../elevation/elevationScale'
import type { PeriodicTriangulation } from './periodicDelaunay'
import { barycentric } from './remesh'

// SAMPLING THE MESH AT A POINT (decision 7 of docs/decisions/adaptive-mesh.md:
// "map/ samples the mesh directly — point location over a spatial bucket,
// hillshade from triangle normals"). The pure field functions the map
// layer may read of the generator: no raster between the mesh and the
// picture.
//
// Point location: a grid of TRIANGLE HINTS over the domain (one triangle
// id per grid cell, the one under the cell's corner, found once by a
// scanline walk), then the triangulation's own straight walk from that
// hint — one or two steps, since a hint cell is a few triangles wide. A
// query from anywhere costs the same, which a walk from the last query
// cannot promise.
//
// Heights interpolate linearly in the triangle (barycentric), as the
// rasteriser does. Normals are VERTEX normals — every triangle's normal,
// area-weighted, summed at its corners — interpolated the same way, so a
// hillshade reads the mesh's ridges smoothly instead of as facets; they
// are metre-true (the horizontal in metres per cell, the height in metres
// per elevation unit) and the caller scales them to its own space.
export interface MeshSampler {
  readonly mesh: PeriodicTriangulation
  // The triangle under (x, y) (domain units).
  triangleAt(x: number, y: number): number
  // The height field interpolated at (x, y), elevation units.
  heightAt(x: number, y: number): number
  // Any per-vertex field interpolated at (x, y).
  sampleAt(field: ArrayLike<number>, x: number, y: number): number
  // The vertex nearest (x, y) among its triangle's corners — for a
  // categorical field (a body id, a biome).
  nearestNodeAt(x: number, y: number): number
  // The unit normal at (x, y), metre-true, into out[0..2] as (nx, ny, nz)
  // with y up: (0, 1, 0) on flat ground.
  normalAt(x: number, y: number, out: Float64Array): void
}

// Hint grid resolution: about one cell per 4 world cells — a few triangles
// wide where the mesh is dense, still one step where it is coarse.
const HINT_CELLS_PER_UNIT = 0.25

export function createMeshSampler(mesh: PeriodicTriangulation, z: Float32Array): MeshSampler {
  const { domain } = mesh
  const cols = Math.max(4, Math.round(domain.width * HINT_CELLS_PER_UNIT))
  const rows = Math.max(4, Math.round(domain.height * HINT_CELLS_PER_UNIT))
  const hints = new Int32Array(cols * rows)
  const sx = domain.width / cols
  const sy = domain.height / rows
  let hint = mesh.lastTri
  let rowStart = hint
  for (let r = 0; r < rows; r++) {
    hint = rowStart
    for (let c = 0; c < cols; c++) {
      hint = mesh.locate(c * sx, r * sy, hint)
      if (c === 0) rowStart = hint
      hints[r * cols + c] = hint
    }
  }
  const hintAt = (x: number, y: number): number => {
    const c = Math.min(cols - 1, Math.max(0, Math.floor(domain.wrapX(x) / sx)))
    const r = Math.min(rows - 1, Math.max(0, Math.floor(domain.wrapY(y) / sy)))
    return hints[r * cols + c]
  }
  // Vertex normals from the triangles, in metres.
  const normals = new Float32Array(mesh.vertexSlots * 3)
  const f = new Float64Array(6)
  for (let t = 0; t < mesh.triSlots; t++) {
    if (!mesh.tAlive[t]) continue
    mesh.frame(t, f)
    const a = mesh.tris[3 * t]
    const b = mesh.tris[3 * t + 1]
    const c = mesh.tris[3 * t + 2]
    // Edges in metres; the normal of (b − a) × (c − a) with y up: the
    // horizontal plane is x (east) and z (south, the raster's row axis).
    const abx = (f[2] - f[0]) * METERS_PER_CELL
    const abz = (f[3] - f[1]) * METERS_PER_CELL
    const aby = (z[b] - z[a]) * ELEVATION_METERS
    const acx = (f[4] - f[0]) * METERS_PER_CELL
    const acz = (f[5] - f[1]) * METERS_PER_CELL
    const acy = (z[c] - z[a]) * ELEVATION_METERS
    // Cross product (ab × ac), oriented so y is up whatever the winding.
    let nx = aby * acz - abz * acy
    let ny = abz * acx - abx * acz
    let nz = abx * acy - aby * acx
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz }
    // Its length is twice the area — the weight.
    for (const v of [a, b, c]) {
      normals[3 * v] += nx
      normals[3 * v + 1] += ny
      normals[3 * v + 2] += nz
    }
  }
  for (let v = 0; v < mesh.vertexSlots; v++) {
    const l = Math.hypot(normals[3 * v], normals[3 * v + 1], normals[3 * v + 2])
    if (l > 0) {
      normals[3 * v] /= l
      normals[3 * v + 1] /= l
      normals[3 * v + 2] /= l
    } else normals[3 * v + 1] = 1
  }
  const bary = new Float64Array(3)
  const triangleAt = (x: number, y: number): number => mesh.locate(x, y, hintAt(x, y))
  const sampleAt = (field: ArrayLike<number>, x: number, y: number): number => {
    const t = triangleAt(x, y)
    barycentric(mesh, t, x, y, bary)
    return bary[0] * field[mesh.tris[3 * t]] + bary[1] * field[mesh.tris[3 * t + 1]] + bary[2] * field[mesh.tris[3 * t + 2]]
  }
  return {
    mesh,
    triangleAt,
    heightAt: (x, y) => sampleAt(z, x, y),
    sampleAt,
    nearestNodeAt(x, y) {
      const t = triangleAt(x, y)
      barycentric(mesh, t, x, y, bary)
      let corner = 0
      if (bary[1] > bary[corner]) corner = 1
      if (bary[2] > bary[corner]) corner = 2
      return mesh.tris[3 * t + corner]
    },
    normalAt(x, y, out) {
      const t = triangleAt(x, y)
      barycentric(mesh, t, x, y, bary)
      let nx = 0
      let ny = 0
      let nz = 0
      for (let k = 0; k < 3; k++) {
        const v = mesh.tris[3 * t + k]
        nx += bary[k] * normals[3 * v]
        ny += bary[k] * normals[3 * v + 1]
        nz += bary[k] * normals[3 * v + 2]
      }
      const l = Math.hypot(nx, ny, nz) || 1
      out[0] = nx / l
      out[1] = ny / l
      out[2] = nz / l
    },
  }
}
