import { smoothstep } from '../core/interpolation'
import { wrapValue } from '../core/field'
import { globeFrame, type Domain } from '../core/domain'
import { globeOctaveOn } from './globeNoise'
// Periodic ridged multifractal, used by the engine's elevation_field.rs to give
// tectonically-uplifted terrain fine ridge-and-valley structure that the
// smooth distance-field uplift alone can't produce (docs/vision.md Phase 3
// explicitly asks for "ridged fractal noise to make realistic ridges and
// valleys"). Layered onto the uplift *before* erosion, so the grooves it
// carves become real drainage lines the erosion pass can then deepen.
//
// Must tile exactly at the map's own wrap period in both axes — this is a
// torus, and a non-periodic noise field would leave a seam at the wrap
// edge. A sphere world samples the same octaves on a 3D lattice instead
// (the engine's `ridged_multifractal_on`, globeNoise.ts). Same periodic-value-noise construction as the engine's domain_warp.rs, but kept
// separate and independently tuned: domainWarp perturbs query points at
// continent scale, this shapes relief at range scale, and folding both
// into one parameterized helper would read worse than a second small copy
// (the same reasoning the v1 erosion pass's ridgeNoise01 recorded, gone with it, for not
// sharing with domainWarp).

function hashLatticePoint(ix: number, iy: number, seed: number): number {
  let h = (ix * 374761393 + iy * 668265263 + seed * 2246822519) >>> 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h = (h ^ (h >>> 16)) >>> 0
  return h / 4294967296 // [0, 1)
}

// Bilinear value noise over a lattice that repeats every (cellsX, cellsY)
// integer units — coordinates are in lattice units; the caller scales
// pixels to lattice units per octave.
//
// Exported because the two fBm functions below fix their own octave tables
// (512/1024 cells across the world), which is far finer than some consumers
// need: a caller that wants ONE smooth field at a chosen wavelength — the
// biome wash's boundary warp, say — must be able to pick the lattice
// directly, and the alternative was a second, near-identical noise
// implementation. Torus-periodic by construction for any integer cell count.
export function periodicValueNoise2D(x: number, y: number, cellsX: number, cellsY: number, seed: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  const x0m = wrapValue(x0, cellsX) | 0
  const y0m = wrapValue(y0, cellsY) | 0
  const x1m = (x0m + 1) % cellsX
  const y1m = (y0m + 1) % cellsY

  const v00 = hashLatticePoint(x0m, y0m, seed)
  const v10 = hashLatticePoint(x1m, y0m, seed)
  const v01 = hashLatticePoint(x0m, y1m, seed)
  const v11 = hashLatticePoint(x1m, y1m, seed)

  const sx = smoothstep(fx)
  const sy = smoothstep(fy)
  const top = v00 + (v10 - v00) * sx
  const bottom = v01 + (v11 - v01) * sx
  return top + (bottom - top) * sy // [0, 1)
}
const frame = globeFrame()

// Finer-frequency companion to the engine's `ridged_multifractal`, for
// render/erosionDetailTexture.ts's cosmetic detail pass — see that module's
// own comment for why it exists (plains get near-zero detail from
// it today, since the engine's `compute_elevation` only applies it where
// tectonic uplift is already positive). A separate octave table, not a
// parameterization of the engine's RIDGE_OCTAVES: independently tunable
// frequency, and no shared lattice phase to accidentally correlate the two.
//
// Plain (non-ridged) value-noise fBm, deliberately NOT ridge-folded —
// `ridged_multifractal`'s fold-and-square step is what makes mountain terrain
// read as crests and valleys, which is the wrong shape for gentle plains
// texture; this wants soft undulation instead. Each octave's value noise is
// centered at 0 before summing, so the result is zero-mean by construction —
// no measured RIDGE_MEAN-style offset to correct for, since there's no
// fold/square step to bias it.
const DETAIL_OCTAVES: ReadonlyArray<{ cellsX: number; cellsY: number; amplitude: number }> = [
  { cellsX: 512, cellsY: 256, amplitude: 1.0 },
  { cellsX: 1024, cellsY: 512, amplitude: 0.5 },
]

// The one seed salt every consumer of fineDetailNoise-as-terrain shares
// (xor'd with the world's warpSeed): the render pool, the land-target
// solver, the micro tile and any headless harness must sample the SAME
// field, or the plains drainage they each derive quietly disagrees.
export const FINE_DETAIL_SEED_SALT = 0x11a7e5

// Roughly [-0.5, 0.5], zero mean. Distinct seed salt from `ridged_multifractal`
// (xor'd by the caller, see erosionDetailTexture.ts) so the two layers don't
// share a lattice phase either.
export function fineDetailNoise(x: number, y: number, width: number, height: number, seed: number): number {
  let sum = 0
  let amplitudeSum = 0
  let octaveSeed = seed
  for (const octave of DETAIL_OCTAVES) {
    const lx = (x / width) * octave.cellsX
    const ly = (y / height) * octave.cellsY
    const n = periodicValueNoise2D(lx, ly, octave.cellsX, octave.cellsY, octaveSeed)
    sum += (n - 0.5) * octave.amplitude
    amplitudeSum += octave.amplitude
    octaveSeed = (octaveSeed * 1664525 + 1013904223) >>> 0
  }
  return sum / amplitudeSum
}

// fineDetailNoise at domain point (x, y), sampled where the Domain says —
// see the engine's `ridged_multifractal_on`.
export function fineDetailNoiseOn(domain: Domain, x: number, y: number, seed: number): number {
  const space = domain.noise
  if (space.kind === 'chart') return fineDetailNoise(x, y, domain.width, domain.height, seed)
  space.frame(x, y, frame)
  let sum = 0
  let amplitudeSum = 0
  let octaveSeed = seed
  for (const octave of DETAIL_OCTAVES) {
    sum += (globeOctaveOn(frame, octave.cellsX, domain, octaveSeed) - 0.5) * octave.amplitude
    amplitudeSum += octave.amplitude
    octaveSeed = (octaveSeed * 1664525 + 1013904223) >>> 0
  }
  return sum / amplitudeSum
}
