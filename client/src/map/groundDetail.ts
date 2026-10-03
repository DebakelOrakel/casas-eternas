// THE DETAIL TEXTURES — the tiling surfaces the ground's shader lays under
// the painted albedo (groundNormalPlugin.ts): one per MATERIAL, as a
// luminance pattern (128 = unchanged) and a normal map, both periodic so
// they tile without a seam. Made here, not loaded: a few noise functions
// give a grass, a rock, a scree, a snow and a canopy that match the
// painter's palette, weigh nothing, and can be tuned in code. Photo
// textures (CC0) stay the option to compare against later (2026-10-03).
//
// Pure, no DOM: runs in the ground worker once per world.

// The last is not a material: the MACRO mottle every material shares at
// the long wavelength — a broad variation without cells or bands, since
// a tile with structure repeated at hundreds of metres draws a honeycomb
// over a range seen from 5 km (2026-10-03).
export const GROUND_MATERIALS = ['grass', 'rock', 'bare', 'snow', 'forest', 'macro'] as const
export type GroundMaterial = (typeof GROUND_MATERIALS)[number]
// Each material's tile, as a multiple of the shader's base wavelength: a
// crown is metres, a tuft centimetres — at one wavelength the canopy was
// a stipple and the grass a carpet pattern (2026-10-03).
export const GROUND_MATERIAL_SCALE: Record<GroundMaterial, number> = { grass: 0.6, rock: 1.6, bare: 0.8, snow: 2.5, forest: 4, macro: 1 }

export interface GroundDetailSet {
  size: number
  // size² × materials RGBA each, material-major: the luminance pattern and
  // the normals (x, y-up, z) as 0..255.
  albedo: Uint8Array
  normals: Uint8Array
}

// A lattice hash periodic over `period` cells.
const hash = (ix: number, iy: number, period: number, seed: number): number => {
  const x = ((ix % period) + period) % period
  const y = ((iy % period) + period) % period
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

// Periodic value noise over `period` cells, p in cells.
function noise(px: number, py: number, period: number, seed: number): number {
  const x0 = Math.floor(px)
  const y0 = Math.floor(py)
  const tx = px - x0
  const ty = py - y0
  const sx = tx * tx * (3 - 2 * tx)
  const sy = ty * ty * (3 - 2 * ty)
  const a = hash(x0, y0, period, seed)
  const b = hash(x0 + 1, y0, period, seed)
  const c = hash(x0, y0 + 1, period, seed)
  const d = hash(x0 + 1, y0 + 1, period, seed)
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy
}

// Fractal noise over the unit square (u, v in 0..1), `octaves` from
// `cells` cells up, falling by `gain`; roughly 0..1.
function fbm(u: number, v: number, cells: number, octaves: number, gain: number, seed: number): number {
  let sum = 0
  let amp = 1
  let norm = 0
  let period = cells
  for (let o = 0; o < octaves; o++) {
    sum += (noise(u * period, v * period, period, seed + o) - 0.5) * amp
    norm += amp
    amp *= gain
    period *= 2
  }
  return 0.5 + sum / norm
}

// Periodic cellular noise: the distance to the nearest of one jittered
// point per cell (0 at a point, ~0.7 between), and the nearest point's own
// hash (a per-cell value).
function cells(u: number, v: number, count: number, seed: number, out: Float64Array): void {
  const px = u * count
  const py = v * count
  const x0 = Math.floor(px)
  const y0 = Math.floor(py)
  let best = 1e9
  let id = 0
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = x0 + dx
      const cy = y0 + dy
      const jx = hash(cx, cy, count, seed)
      const jy = hash(cx, cy, count, seed + 1)
      const d = (px - (cx + jx)) ** 2 + (py - (cy + jy)) ** 2
      if (d < best) {
        best = d
        id = hash(cx, cy, count, seed + 2)
      }
    }
  }
  out[0] = Math.sqrt(best)
  out[1] = id
}

// Each material as a HEIGHT (for the normals) and a luminance, over the
// unit square.
type Surface = (u: number, v: number, out: Float64Array) => void

const cellOut = new Float64Array(2)
const SURFACES: Record<GroundMaterial, Surface> = {
  // Grass: a fine tuft stipple over a soft mottle; a little height.
  grass(u, v, out) {
    const mottle = fbm(u, v, 2, 6, 0.7, 11)
    const tufts = fbm(u, v, 48, 3, 0.55, 12)
    out[0] = (tufts - 0.5) * 0.5
    out[1] = 0.92 + (mottle - 0.5) * 0.45 + (tufts - 0.5) * 0.4
  },
  // Rock: strata — bands along one axis, warped — cut by cracks.
  rock(u, v, out) {
    // Strata: bands along one axis, warped twice over, their spacing and
    // depth varying along them; blocks between the cracks.
    const warp = (fbm(u, v, 3, 3, 0.5, 21) - 0.5) * 0.25 + (fbm(u, v, 12, 2, 0.5, 24) - 0.5) * 0.04
    const phase = (v + warp) * 9
    const bandShape = fbm(u * 0.5, phase * 0.1, 4, 2, 0.5, 25)
    const band = Math.pow(0.5 + 0.5 * Math.sin(phase * Math.PI * 2), 1 + bandShape * 2)
    const grain = fbm(u, v, 20, 4, 0.55, 22)
    cells(u, v, 5, 23, cellOut)
    const crack = Math.min(1, cellOut[0] * 14)
    const block = cellOut[1]
    const h = band * 0.5 + grain * 0.3 + block * 0.2 - (1 - crack) * 0.3
    out[0] = (h - 0.5) * 2.2
    out[1] = 0.8 + (band - 0.5) * 0.3 + (grain - 0.5) * 0.35 + (block - 0.5) * 0.15 - (1 - crack) * 0.2
  },
  // Bare ground: scree — a pebble field — over dust.
  bare(u, v, out) {
    cells(u, v, 22, 31, cellOut)
    const pebble = Math.max(0, 1 - cellOut[0] * 2.2)
    const dome = Math.sqrt(pebble)
    const dust = fbm(u, v, 3, 6, 0.7, 32)
    out[0] = dome * 0.8 + (dust - 0.5) * 0.3
    out[1] = 0.8 + (cellOut[1] - 0.5) * 0.3 * pebble + (dust - 0.5) * 0.25 + dome * 0.1
  },
  // Snow: soft drifts, a faint sparkle.
  snow(u, v, out) {
    const drift = fbm(u, v, 2, 6, 0.7, 41)
    const sparkle = fbm(u, v, 64, 2, 0.5, 42)
    out[0] = (drift - 0.5) * 0.35
    out[1] = 0.97 + (drift - 0.5) * 0.12 + (sparkle > 0.78 ? 0.08 : 0)
  },
  // The macro mottle: soft, broad, a little relief.
  macro(u, v, out) {
    // Many octaves at a high gain: with the base octave dominant a value
    // noise is a lattice of blobs, and two reads of it a honeycomb.
    const a = fbm(u, v, 2, 7, 0.72, 61)
    out[0] = (a - 0.5) * 0.8
    out[1] = 0.95 + (a - 0.5) * 0.6
  },
  // Canopy: crowns as domes with dark gaps between — read as treetops
  // from above.
  forest(u, v, out) {
    cells(u, v, 14, 51, cellOut)
    const crown = Math.max(0, 1 - cellOut[0] * 1.9)
    const dome = Math.sqrt(crown)
    const tone = fbm(u, v, 5, 2, 0.5, 52)
    out[0] = dome * 2.2
    out[1] = 0.35 + dome * 0.75 + (cellOut[1] - 0.5) * 0.3 + (tone - 0.5) * 0.2
  },
}

export function makeGroundDetail(size: number): GroundDetailSet {
  const count = GROUND_MATERIALS.length
  const albedo = new Uint8Array(size * size * 4 * count)
  const normals = new Uint8Array(size * size * 4 * count)
  const height = new Float32Array(size * size)
  const out = new Float64Array(2)
  GROUND_MATERIALS.forEach((name, layer) => {
    const surface = SURFACES[name]
    const base = layer * size * size * 4
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        surface((i + 0.5) / size, (j + 0.5) / size, out)
        height[j * size + i] = out[0]
        const l = Math.round(Math.min(2, Math.max(0, out[1])) * 128)
        const p = base + (j * size + i) * 4
        albedo[p] = Math.min(255, l)
        albedo[p + 1] = Math.min(255, l)
        albedo[p + 2] = Math.min(255, l)
        albedo[p + 3] = 255
      }
    }
    // The normals from the height, periodic, the height in texel units
    // scaled by NORMAL_RELIEF.
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const l = height[j * size + ((i + size - 1) % size)]
        const r = height[j * size + ((i + 1) % size)]
        const u = height[((j + size - 1) % size) * size + i]
        const d = height[((j + 1) % size) * size + i]
        const dx = (r - l) * NORMAL_RELIEF * size
        const dz = (d - u) * NORMAL_RELIEF * size
        const inv = 1 / Math.sqrt(dx * dx + 1 + dz * dz)
        const p = base + (j * size + i) * 4
        normals[p] = Math.round((-dx * inv * 0.5 + 0.5) * 255)
        normals[p + 1] = Math.round((inv * 0.5 + 0.5) * 255)
        normals[p + 2] = Math.round((-dz * inv * 0.5 + 0.5) * 255)
        normals[p + 3] = 255
      }
    }
  })
  return { size, albedo, normals }
}

// The surfaces' height per unit square, as a fraction of the square's
// side, for the normals: 0.02 is a two-centimetre bump on a metre.
const NORMAL_RELIEF = 0.06
