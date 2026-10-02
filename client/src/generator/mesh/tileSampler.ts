// A TILE'S SURFACE as a point lookup: the tile artifact's triangles
// (world/meshTileArtifacts.ts — the inside of the tile, a square with a
// boundary, not a torus) over a bucket grid, the height interpolated in the
// triangle under the point. Positions in cells from the tile's corner;
// outside the tile, NaN. What the incubator reads a tile level through.

export interface TileSurfaceSampler {
  heightAt(x: number, y: number): number
}

// Buckets per side: a level-3 tile of ~85 k nodes then holds a few dozen
// triangles a bucket.
const BUCKETS = 64

export function createTileSampler(nodes: Float32Array, triangles: Uint32Array, z: Float32Array, cells: number): TileSurfaceSampler {
  const size = cells / BUCKETS
  const buckets: number[][] = Array.from({ length: BUCKETS * BUCKETS }, () => [])
  const clamp = (v: number): number => Math.max(0, Math.min(BUCKETS - 1, Math.floor(v / size)))
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t], b = triangles[t + 1], c = triangles[t + 2]
    const x0 = clamp(Math.min(nodes[2 * a], nodes[2 * b], nodes[2 * c]))
    const x1 = clamp(Math.max(nodes[2 * a], nodes[2 * b], nodes[2 * c]))
    const y0 = clamp(Math.min(nodes[2 * a + 1], nodes[2 * b + 1], nodes[2 * c + 1]))
    const y1 = clamp(Math.max(nodes[2 * a + 1], nodes[2 * b + 1], nodes[2 * c + 1]))
    for (let by = y0; by <= y1; by++) for (let bx = x0; bx <= x1; bx++) buckets[by * BUCKETS + bx].push(t)
  }
  return {
    heightAt(x, y) {
      if (x < 0 || y < 0 || x > cells || y > cells) return NaN
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
        return z[a] + (z[b] - z[a]) * l1 + (z[c] - z[a]) * l2
      }
      return NaN
    },
  }
}
