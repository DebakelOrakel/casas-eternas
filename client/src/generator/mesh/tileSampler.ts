import { ELEVATION_METERS } from '../elevation/elevationScale'
import { METERS_PER_CELL } from '../core/mapConfig'
import { detHypot } from '../core/detMath'

// A TILE'S SURFACE as a point lookup: the tile artifact's triangles
// (world/meshTileArtifacts.ts — the inside of the tile, a square with a
// boundary, not a torus) over a bucket grid, the height interpolated in the
// triangle under the point. Positions in cells from the tile's corner;
// outside the tile, NaN. What the incubator reads a tile level through.
//
// The NORMAL is interpolated too, from vertex normals (every triangle's
// normal, area-weighted, summed at its corners — as meshSampler does for
// the level): a hillshade of the mesh then reads its ridges smoothly
// instead of as facets, which with the map's exaggeration every triangle
// was (the incubator's mid views, 2026-10-03). Metre-true: the
// horizontal in metres per cell, the height in metres per elevation unit.

export interface TileSurfaceSampler {
  heightAt(x: number, y: number): number
  // The height and the unit normal at (x, y): out[0] the height, out[1..3]
  // the normal as (nx, ny, nz) with y up, out[4] the local node spacing
  // (cells: the side of a square of the triangle's area, which is what a
  // reader softening the facets wants to know). False outside the tile.
  surfaceAt(x: number, y: number, out: Float64Array): boolean
}

// Buckets per side: a level-3 tile of ~85 k nodes then holds a few dozen
// triangles a bucket.
const BUCKETS = 64

export function createTileSampler(nodes: Float32Array, triangles: Uint32Array, z: Float32Array, cells: number): TileSurfaceSampler {
  const size = cells / BUCKETS
  const buckets: number[][] = Array.from({ length: BUCKETS * BUCKETS }, () => [])
  const clamp = (v: number): number => Math.max(0, Math.min(BUCKETS - 1, Math.floor(v / size)))
  const count = nodes.length / 2
  const normals = new Float32Array(count * 3)
  const spacing = new Float32Array(triangles.length / 3)
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t], b = triangles[t + 1], c = triangles[t + 2]
    const x0 = clamp(Math.min(nodes[2 * a], nodes[2 * b], nodes[2 * c]))
    const x1 = clamp(Math.max(nodes[2 * a], nodes[2 * b], nodes[2 * c]))
    const y0 = clamp(Math.min(nodes[2 * a + 1], nodes[2 * b + 1], nodes[2 * c + 1]))
    const y1 = clamp(Math.max(nodes[2 * a + 1], nodes[2 * b + 1], nodes[2 * c + 1]))
    for (let by = y0; by <= y1; by++) for (let bx = x0; bx <= x1; bx++) buckets[by * BUCKETS + bx].push(t)
    // The triangle's normal in metres, its length twice the area — the
    // weight at each corner.
    const abx = (nodes[2 * b] - nodes[2 * a]) * METERS_PER_CELL
    const abz = (nodes[2 * b + 1] - nodes[2 * a + 1]) * METERS_PER_CELL
    const aby = (z[b] - z[a]) * ELEVATION_METERS
    const acx = (nodes[2 * c] - nodes[2 * a]) * METERS_PER_CELL
    const acz = (nodes[2 * c + 1] - nodes[2 * a + 1]) * METERS_PER_CELL
    const acy = (z[c] - z[a]) * ELEVATION_METERS
    let nx = aby * acz - abz * acy
    let ny = abz * acx - abx * acz
    let nz = abx * acy - aby * acx
    // Twice the triangle's area in cells² is |ab × ac| of the horizontal.
    spacing[t / 3] = Math.sqrt(Math.abs((abx * acz - abz * acx) / (METERS_PER_CELL * METERS_PER_CELL)))
    if (ny < 0) {
      nx = -nx
      ny = -ny
      nz = -nz
    }
    for (const v of [a, b, c]) {
      normals[3 * v] += nx
      normals[3 * v + 1] += ny
      normals[3 * v + 2] += nz
    }
  }
  for (let v = 0; v < count; v++) {
    const l = detHypot(normals[3 * v], normals[3 * v + 1], normals[3 * v + 2])
    if (l > 0) {
      normals[3 * v] /= l
      normals[3 * v + 1] /= l
      normals[3 * v + 2] /= l
    } else normals[3 * v + 1] = 1
  }

  // The triangle under (x, y) and the barycentric weights of its corners
  // into w[0..2]; -1 outside the tile.
  const w = new Float64Array(3)
  const locate = (x: number, y: number): number => {
    if (x < 0 || y < 0 || x > cells || y > cells) return -1
    for (const t of buckets[clamp(y) * BUCKETS + clamp(x)]) {
      const a = triangles[t], b = triangles[t + 1], c = triangles[t + 2]
      const ax = nodes[2 * a], ay = nodes[2 * a + 1]
      const bx = nodes[2 * b] - ax, by = nodes[2 * b + 1] - ay
      const cx = nodes[2 * c] - ax, cy = nodes[2 * c + 1] - ay
      const det = bx * cy - by * cx
      if (det === 0) continue
      const px = x - ax, py = y - ay
      const l1 = (px * cy - py * cx) / det
      const l2 = (bx * py - by * px) / det
      // A hair of tolerance: a point on a shared edge belongs to both.
      if (l1 < -1e-9 || l2 < -1e-9 || l1 + l2 > 1 + 1e-9) continue
      w[0] = 1 - l1 - l2
      w[1] = l1
      w[2] = l2
      return t
    }
    return -1
  }
  return {
    heightAt(x, y) {
      const t = locate(x, y)
      if (t < 0) return NaN
      return z[triangles[t]] * w[0] + z[triangles[t + 1]] * w[1] + z[triangles[t + 2]] * w[2]
    },
    surfaceAt(x, y, out) {
      const t = locate(x, y)
      if (t < 0) return false
      const a = triangles[t], b = triangles[t + 1], c = triangles[t + 2]
      out[0] = z[a] * w[0] + z[b] * w[1] + z[c] * w[2]
      const nx = normals[3 * a] * w[0] + normals[3 * b] * w[1] + normals[3 * c] * w[2]
      const ny = normals[3 * a + 1] * w[0] + normals[3 * b + 1] * w[1] + normals[3 * c + 1] * w[2]
      const nz = normals[3 * a + 2] * w[0] + normals[3 * b + 2] * w[1] + normals[3 * c + 2] * w[2]
      const l = detHypot(nx, ny, nz) || 1
      out[1] = nx / l
      out[2] = ny / l
      out[3] = nz / l
      out[4] = spacing[t / 3]
      return true
    },
  }
}
