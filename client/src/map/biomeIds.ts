import { Biome } from '../generator/climate/biomes'
import { periodicValueNoise2D } from '../generator/elevation/ridgedNoise'

// Getting biome ids onto the paper's grid — the step before anything is
// coloured. What colour a place then takes is map/terrainPalette's business;
// this file only answers WHICH biome each paper texel belongs to.
//
// Two problems have to be solved before a palette can be used at all, both
// caused by the biome field being coarser than the texture it is drawn onto:
//
//  1. Nearest-neighbour upsampling would render visible squares — a
//     checkerboard, not a landscape. Sampling the id through a noise-warped
//     coordinate instead keeps the palette colours pure (no muddy bilinear
//     in-betweens between sand and rainforest) while making every boundary
//     an irregular, organic line.
//  2. The coastline disagrees between grids: the relief is resolved at the
//     full texture width and the biome field is not, so coastal land pixels
//     sample "Ocean" and would come out as untinted white fringe around every
//     shore. Dilating the land biomes outward over the ocean cells FIRST
//     (a few passes on the source grid, so it costs little) means a land
//     pixel always finds a land biome, whichever grid drew the coast.
//
// Both are stated in SOURCE CELLS so they scale with whatever field arrives.
// That matters now that current saves carry biomes at the world raster (2x
// under the texture) while older ones carry the climate grid (16x under it) —
// see worldSave/worldLayers. The one quantity that does not scale that way is
// the warp's own wavelength; see WARP_LATTICE_MIN_PIXELS.

// How far the sample coordinate may wander, in COARSE cells (peak
// displacement, so 1.5 lets a boundary bulge by about a cell and a half
// without letting a biome leak across a whole neighbouring region).
const WARP_CELLS = 1.5
// Lattice density of the warp field, as a multiple of the coarse biome grid.
// This is the part that has to be chosen rather than inherited: the
// pipeline's fBm helpers fix their octaves at 512/1024 cells across the
// world, which on a 4096-wide texture is a 4-8 pixel wavelength — below the
// 16-pixel biome blocks it is supposed to disguise, so it produced a
// 1-pixel ragged edge instead of a meander (measured: a boundary wandered 4
// px). At 2x the biome grid the warp has a wavelength of several blocks,
// which is what reads as a coastline-ish, organic line.
const WARP_LATTICE_SCALE = 2
// …but only down to a floor, because that multiple is the one thing here that
// must NOT follow the source grid. At the climate grid it lands on an 8-pixel
// wavelength, which is the value the note above was measured at. Applied to a
// world-raster biome field it would ask for one lattice cell per texture pixel:
// not a meander but white noise, which is the exact 1-pixel ragged edge the
// note describes as the failure. The floor pins the wavelength instead, so the
// coarse case is unchanged and the fine case keeps a shape.
const WARP_LATTICE_MIN_PIXELS = 8

// How far the land biomes must be spread out to sea. Derived from the warp
// rather than picked, because the two are the same quantity seen twice: the
// warp can push a coastal sample up to WARP_CELLS cells offshore, and the
// two grids' coastlines disagree by up to about another cell. Setting this
// by hand is how the white fringe comes back — raising WARP_CELLS alone
// reintroduced it (measured: 302 land pixels sampling Ocean).
const DILATION_PASSES = Math.ceil(WARP_CELLS) + 3

// Land biomes spread outward over ocean cells, so sampling near a coast can
// never come back as Ocean. Returns a new field; the input is untouched.
export function dilateLandBiomes(biome: Float32Array, resX: number, resY: number, passes = DILATION_PASSES): Uint8Array {
  let current = Uint8Array.from(biome, (v) => Math.round(v))
  for (let pass = 0; pass < passes; pass++) {
    const next = current.slice()
    for (let y = 0; y < resY; y++) {
      for (let x = 0; x < resX; x++) {
        const i = y * resX + x
        if (current[i] !== Biome.Ocean) continue
        // Torus-wrapped 4-neighbourhood; first land neighbour wins.
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = ((x + dx) % resX + resX) % resX
          const ny = ((y + dy) % resY + resY) % resY
          const n = current[ny * resX + nx]
          if (n !== Biome.Ocean) {
            next[i] = n
            break
          }
        }
      }
    }
    current = next
  }
  return current
}

// Expand a coarse biome field to the texture grid, sampling through a
// noise-warped coordinate (see the module comment). Returns one id per
// texture pixel.
export function expandBiomeIds(biome: Uint8Array, resX: number, resY: number, width: number, height: number, seed: number): Uint8Array {
  const out = new Uint8Array(width * height)
  const warpX = (WARP_CELLS * width) / resX
  const warpY = (WARP_CELLS * height) / resY
  // Lattice cell counts across the whole world, and the pixel→lattice scale.
  const latticeX = Math.max(2, Math.min(Math.round(width / WARP_LATTICE_MIN_PIXELS), Math.round(resX * WARP_LATTICE_SCALE)))
  const latticeY = Math.max(2, Math.min(Math.round(height / WARP_LATTICE_MIN_PIXELS), Math.round(resY * WARP_LATTICE_SCALE)))
  const toLatticeX = latticeX / width
  const toLatticeY = latticeY / height
  const seedY = (seed ^ 0x5bf03635) >>> 0
  for (let y = 0; y < height; y++) {
    const ly = y * toLatticeY
    for (let x = 0; x < width; x++) {
      const lx = x * toLatticeX
      // Two independent fields so the warp is a real 2D displacement rather
      // than a diagonal smear. Value noise is 0..1, so it is centred here.
      const ox = (periodicValueNoise2D(lx, ly, latticeX, latticeY, seed) - 0.5) * 2 * warpX
      const oy = (periodicValueNoise2D(lx, ly, latticeX, latticeY, seedY) - 0.5) * 2 * warpY
      const sx = Math.min(resX - 1, Math.max(0, Math.floor((((x + ox) % width + width) % width / width) * resX)))
      const sy = Math.min(resY - 1, Math.max(0, Math.floor((((y + oy) % height + height) % height / height) * resY)))
      out[y * width + x] = biome[sy * resX + sx]
    }
  }
  return out
}

// The wash itself moved to map/terrainPalette.ts (2026-08-11), together with a
// palette of its own: what colour a place IS turned out to be a different
// question from which class it belongs to, and the two want to be tuned
// separately. What stays here is getting biome ids onto the paper's grid at
// all, which is the part that has nothing to do with colour.
