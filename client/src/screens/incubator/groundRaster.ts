import type { MeshSampler } from '../../generator/mesh/meshSampler'
import { tileSpec } from '../../generator/mesh/meshTile'
import type { TileSurfaceSampler } from '../../generator/mesh/tileSampler'

// A TILE AS A RASTER: the ground of one tile square sampled on a regular
// grid, once, so the painter (map/groundPaint.ts) reads it bilinearly
// instead of locating a triangle per texel — which was nearly all of a
// ring's paint (2026-10-03: 0.2–3 s a ring, 3× that in the bands where
// two levels blend). Per cell the height (elevation units) and the
// slope (dh/dx, dh/dz in metres per metre, from the mesh's interpolated
// normal, so the facets stay softened as before).
//
// Rastered in a worker into a SharedArrayBuffer (the page is cross-origin
// isolated), so every painter reads the one copy; the main thread keeps
// the registry and evicts by bytes. Level 1 is rastered too, on level 2's
// tile grid, so a painter needs no copy of the level's mesh.
//
// Not a server artifact on purpose: a raster is five times its tile's
// mesh and takes about as long to download as to make, and the look that
// would make it worth storing (the painted textures) changes too often
// to store at all (decided 2026-10-03).

export interface Raster {
  level: number
  // Samples a side; sample i lies at corner + i · cells / (n − 1), so the
  // first and the last sit on the tile's edges.
  n: number
  // The tile's side, cells, and its corner on the world grid.
  cells: number
  cornerX: number
  cornerY: number
  // 3 floats a sample: height, dh/dx, dh/dz.
  data: Float32Array
}

// The raster's cell per level, metres: twice as fine as the tiles'
// densest nodes (level 3 ~150 m, level 2 ~500 m), which keeps every
// node's height and costs 8 MB a level-3 tile and 3 MB a level-2 tile. Level 1 at its own node
// spacing (~2 km): its rasters lie on level 2's tile grid, 8 192 of them
// over the world, and only the rings whose texels are coarser than 1.4
// km read it at all — 48 kB and 4 ms each, so a ring's worth is made in
// a moment (at 500 m they were 0.75 MB and 60 ms each, 2026-10-03).
export const RASTER_CELL_M: Record<number, number> = { 1: 2000, 2: 250, 3: 75 }

export const rasterSamples = (level: number, cells: number, metersPerCell: number): number => Math.round((cells * metersPerCell) / RASTER_CELL_M[level]) + 1

export const rasterBytes = (n: number): number => 3 * n * n * 4

// The level-1 rasters share level 2's tile grid.
export const LEVEL1_GRID_LEVEL = 2
export const level1Stage = (x: number, y: number): string => `L1:${x},${y}`

// A buffer the workers can share where the page allows it.
export function rasterBuffer(n: number): Float32Array {
  const bytes = rasterBytes(n)
  const shared = typeof SharedArrayBuffer !== 'undefined' && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated
  return new Float32Array(shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes))
}

// Cells inward from a tile's edge its edge samples are read at (0.8 m):
// a point exactly on the edge can fall through both tiles' tolerance.
const EDGE_NUDGE = 1e-4

// A tile's raster from its sampler (positions in cells from the corner).
// With `only`, just the samples it accepts (a seam patched, groundSeams.ts).
export function rasteriseTile(sampler: TileSurfaceSampler, level: number, n: number, out: Float32Array, only?: (x: number, y: number) => boolean): void {
  const cells = tileSpec(level).cells
  const step = cells / (n - 1)
  const s = new Float64Array(5)
  for (let j = 0; j < n; j++) {
    const y = Math.min(cells - EDGE_NUDGE, Math.max(EDGE_NUDGE, j * step))
    for (let i = 0; i < n; i++) {
      const x = Math.min(cells - EDGE_NUDGE, Math.max(EDGE_NUDGE, i * step))
      if (only && !only(x, y)) continue
      const p = (j * n + i) * 3
      if (sampler.surfaceAt(x, y, s)) {
        out[p] = s[0]
        out[p + 1] = s[2] > 1e-6 ? -s[1] / s[2] : 0
        out[p + 2] = s[2] > 1e-6 ? -s[3] / s[2] : 0
      } else {
        // A hole in the tile's triangulation (none expected): flat at
        // the previous sample's height.
        out[p] = i > 0 ? out[p - 3] : 0
        out[p + 1] = 0
        out[p + 2] = 0
      }
    }
  }
}

// A level-1 raster over a square of `cells` from (cornerX, cornerY) on
// the world grid, from the level's mesh sampler (which wraps).
export function rasteriseLevel(sampler: MeshSampler, cornerX: number, cornerY: number, cells: number, n: number, out: Float32Array): void {
  const step = cells / (n - 1)
  const normal = new Float64Array(3)
  for (let j = 0; j < n; j++) {
    const y = cornerY + j * step
    for (let i = 0; i < n; i++) {
      const x = cornerX + i * step
      const p = (j * n + i) * 3
      out[p] = sampler.heightAt(x, y)
      sampler.normalAt(x, y, normal)
      out[p + 1] = normal[1] > 1e-6 ? -normal[0] / normal[1] : 0
      out[p + 2] = normal[1] > 1e-6 ? -normal[2] / normal[1] : 0
    }
  }
}

// The raster read bilinearly at a point in cells from its corner: out[0]
// the height, out[1..2] the slope.
export function rasterAt(raster: Raster, lx: number, ly: number, out: Float64Array): void {
  const { n, cells, data } = raster
  const gx = Math.min(n - 1.000001, Math.max(0, (lx / cells) * (n - 1)))
  const gy = Math.min(n - 1.000001, Math.max(0, (ly / cells) * (n - 1)))
  const i0 = Math.floor(gx)
  const j0 = Math.floor(gy)
  const fx = gx - i0
  const fy = gy - j0
  const a = (j0 * n + i0) * 3
  const b = a + 3
  const c = a + n * 3
  const d = c + 3
  for (let k = 0; k < 3; k++) {
    const top = data[a + k] + (data[b + k] - data[a + k]) * fx
    const bottom = data[c + k] + (data[d + k] - data[c + k]) * fx
    out[k] = top + (bottom - top) * fy
  }
}
