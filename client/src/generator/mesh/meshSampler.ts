import { METERS_PER_CELL } from '../core/mapConfig'
import { ELEVATION_METERS } from '../elevation/elevationScale'
import type { PeriodicTriangulation } from './periodicDelaunay'
import { barycentric } from './remesh'
import { detHypot } from '../core/detMath'

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

// A region the mesh is dense in — a level-3 tile's parent, the level-2
// tiles it overlaps (meshTile.ts, tileParentFromTiles) — and how many nodes
// it holds. Over it the sampler keeps a second hint grid at the region's own
// density, about HINT_NODES_PER_CELL nodes a cell: under the world grid's
// 4 × 4 cells sit hundreds of level-2 triangles, and a walk across them was
// 37 % of a level-3 tile (2026-10-04, Calvessor's largest).
export interface DenseRegion {
  x: number
  y: number
  width: number
  height: number
  nodes: number
}
const HINT_NODES_PER_CELL = 4

// A hint grid of cols × rows cells of sx × sy from (x0, y0), each the
// triangle under its corner, found by a scanline walk.
function hintGrid(mesh: PeriodicTriangulation, x0: number, y0: number, cols: number, rows: number, sx: number, sy: number): Int32Array {
  const hints = new Int32Array(cols * rows)
  let hint = mesh.lastTri
  let rowStart = hint
  for (let r = 0; r < rows; r++) {
    hint = rowStart
    for (let c = 0; c < cols; c++) {
      hint = mesh.locate(mesh.domain.wrapX(x0 + c * sx), mesh.domain.wrapY(y0 + r * sy), hint)
      if (c === 0) rowStart = hint
      hints[r * cols + c] = hint
    }
  }
  return hints
}

export function createMeshSampler(mesh: PeriodicTriangulation, z: Float32Array, dense?: DenseRegion): MeshSampler {
  const { domain } = mesh
  const cols = Math.max(4, Math.round(domain.width * HINT_CELLS_PER_UNIT))
  const rows = Math.max(4, Math.round(domain.height * HINT_CELLS_PER_UNIT))
  const sx = domain.width / cols
  const sy = domain.height / rows
  const hints = hintGrid(mesh, 0, 0, cols, rows, sx, sy)
  // The dense region's grid: square cells of HINT_NODES_PER_CELL nodes on
  // average, never coarser than the world's.
  let fine: { hints: Int32Array; cols: number; rows: number; s: number } | null = null
  if (dense && dense.nodes > 0) {
    const s = Math.min(sx, Math.sqrt((dense.width * dense.height * HINT_NODES_PER_CELL) / dense.nodes))
    const fineCols = Math.max(1, Math.ceil(dense.width / s))
    const fineRows = Math.max(1, Math.ceil(dense.height / s))
    fine = { hints: hintGrid(mesh, dense.x, dense.y, fineCols, fineRows, s, s), cols: fineCols, rows: fineRows, s }
  }
  const hintAt = (x: number, y: number): number => {
    if (fine && dense) {
      // Offsets into the region on the torus: a region may cross the seam.
      const c = Math.floor(domain.wrapX(x - dense.x) / fine.s)
      const r = Math.floor(domain.wrapY(y - dense.y) / fine.s)
      if (c < fine.cols && r < fine.rows) return fine.hints[r * fine.cols + c]
    }
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
    const l = detHypot(normals[3 * v], normals[3 * v + 1], normals[3 * v + 2])
    if (l > 0) {
      normals[3 * v] /= l
      normals[3 * v + 1] /= l
      normals[3 * v + 2] /= l
    } else normals[3 * v + 1] = 1
  }
  const bary = new Float64Array(3)
  // The same point asked twice in a row — a tile bake asks the target
  // spacing and then the height at each candidate (meshTile.ts) — is
  // located once. locate from the same hint is a pure function of the
  // point, so the answer is the one a second walk would give (2026-10-02:
  // the walks were ~40 % of a level-3 tile).
  let lastX = NaN
  let lastY = NaN
  let lastT = -1
  const triangleAt = (x: number, y: number): number => {
    if (x === lastX && y === lastY) return lastT
    lastT = mesh.locate(x, y, hintAt(x, y))
    lastX = x
    lastY = y
    return lastT
  }
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
      const l = detHypot(nx, ny, nz) || 1
      out[0] = nx / l
      out[1] = ny / l
      out[2] = nz / l
    },
  }
}
