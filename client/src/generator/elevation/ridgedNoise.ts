import { smoothstep } from '../core/interpolation'
import { wrapValue } from '../core/field'
// Periodic ridged multifractal, used by elevationField.ts to give
// tectonically-uplifted terrain fine ridge-and-valley structure that the
// smooth distance-field uplift alone can't produce (docs/vision.md Phase 3
// explicitly asks for "ridged fractal noise to make realistic ridges and
// valleys"). Layered onto the uplift *before* erosion, so the grooves it
// carves become real drainage lines the erosion pass can then deepen.
//
// Must tile exactly at the map's own wrap period in both axes — this is a
// torus, and a non-periodic noise field would leave a seam at the wrap
// edge. Same periodic-value-noise construction as domainWarp.ts, but kept
// separate and independently tuned: domainWarp perturbs query points at
// continent scale, this shapes relief at range scale, and folding both
// into one parameterized helper would read worse than a second small copy
// (the same reasoning erosion.ts's own ridgeNoise01 records for not
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

// Octaves in cells-across-the-map (not pixels), so the 2:1 aspect ratio
// gets proportionally more cells in x than y (square-ish lattice cells,
// not stretched), and every count is an exact integer at every octave
// (doubling from 32/16 stays integer) as periodicValueNoise2D's modulo
// tiling requires.
//
// WHY THE AMPLITUDES ARE INVERTED relative to a textbook fBm (2026-08-07).
// The map is 2048 cells at 7800 m, so these counts mean wavelengths of
// 500 / 250 / 125 / 63 / 31 km. With the textbook halving falloff the
// STRONGEST octave sat at 500 km — mountain-RANGE scale. But the ranges
// themselves already come from the tectonic features; this field's only job
// is to TEXTURE them, and a texture whose dominant wavelength is wider than
// the thing it textures is not a texture at all, it is a slow regional
// modulation. That is why mountains read as smooth bulges. So the weighting
// is flipped: the crest end carries the energy, and the range-scale octaves
// stay only as a weak modulation that makes some ranges rougher than others.
//
// Measured on a real world (seed "alpha", Archean + 50 epochs, after erosion;
// crest sharpness = mean drop from a local maximum to its 8 neighbours):
//
//   halving falloff (shipped until now)   15.7 m,  1,732 peaks
//   full band, mild crest weighting       77.5 m,  3,133 peaks
//   full band, THIS weighting            117.5 m,  3,940 peaks
//   crest octaves only (no 500/250/125)  117.8 m,  3,513 peaks
//
// The last row is why the wide band is kept: dropping the range octaves buys
// no extra sharpness and costs a tenth of the ridge network. Land fraction
// moved 8.52% -> 8.52% across every candidate, as it must — the term is gated
// to uplift > 0, so it shapes mountains and never touches a coastline.
//
// 512 cells (31 km) is the floor, not a taste call: it is 4 px on this
// raster, and an octave below ~4 px is aliasing rather than detail. Finer
// crest scale is the amplification tier's job (surface/amplify.ts), which
// runs on a grid that can actually carry it.
const RIDGE_OCTAVES: ReadonlyArray<{ cellsX: number; cellsY: number; amplitude: number }> = [
  { cellsX: 32, cellsY: 16, amplitude: 0.15 },
  { cellsX: 64, cellsY: 32, amplitude: 0.2 },
  { cellsX: 128, cellsY: 64, amplitude: 0.3 },
  { cellsX: 256, cellsY: 128, amplitude: 0.7 },
  { cellsX: 512, cellsY: 256, amplitude: 1.0 },
]

// Mean of the ridged field, subtracted by callers to center it at ~0 so
// ridgelines add height and valleys cut down with no net elevation bias.
// Measured, not derived: the naive analytic value (∫₀¹(1-u)²du = 1/3,
// assuming a uniform noise value) is wrong here because bilinear +
// smoothstep interpolation makes the value-noise samples cluster toward
// 0.5 rather than stay uniform, which pushes the ridged mean up. Sampled
// over the full map across several seeds at this exact octave
// configuration → 0.47 (seed-to-seed spread only ~±0.005, negligible as a
// residual bias).
//
// Re-measured 2026-08-07 after the octave amplitudes were reweighted:
// 0.4709, spread ±0.0018 over six seeds — unchanged, and necessarily so.
// Every octave is the same fold-and-square of the same value noise, so they
// all share one mean; a weighted average of identical means is that mean, no
// matter how the weights move. What WOULD move it is a change to the octave
// COUNT with a different lattice character, or to the interpolation — so the
// re-measure rule stands for those.
export const RIDGE_MEAN = 0.47

// Ridged fBm in [0, 1) with mean exactly RIDGE_MEAN. Each octave folds the
// value noise into a ridge (1 - |2n-1|) and squares it to sharpen the
// crest; octaves are summed with halving amplitude and normalized. A true
// Musgrave multifractal would additionally weight each octave by the
// previous one's ridge value (piling detail onto ridgelines) — left out
// deliberately, because that weighting pulls the field's mean off 1/3 and
// would reintroduce a net elevation bias the clean centering here avoids.
// The per-octave squaring already gives sharp crests without it.
export function ridgedMultifractal(x: number, y: number, width: number, height: number, seed: number): number {
  let sum = 0
  let amplitudeSum = 0
  let octaveSeed = seed
  for (const octave of RIDGE_OCTAVES) {
    const lx = (x / width) * octave.cellsX
    const ly = (y / height) * octave.cellsY
    const n = periodicValueNoise2D(lx, ly, octave.cellsX, octave.cellsY, octaveSeed)
    const ridge = 1 - Math.abs(2 * n - 1)
    sum += ridge * ridge * octave.amplitude
    amplitudeSum += octave.amplitude
    // Distinct salt per octave so the octaves don't share a lattice phase.
    octaveSeed = (octaveSeed * 1664525 + 1013904223) >>> 0
  }
  return sum / amplitudeSum
}

// Finer-frequency companion to ridgedMultifractal, for
// render/erosionDetailTexture.ts's cosmetic detail pass — see that module's
// own comment for why it exists (plains get near-zero detail from
// ridgedMultifractal today, since computeElevation only applies it where
// tectonic uplift is already positive). A separate octave table, not a
// parameterization of RIDGE_OCTAVES: independently tunable frequency, and no
// shared lattice phase to accidentally correlate the two.
//
// Plain (non-ridged) value-noise fBm, deliberately NOT ridge-folded —
// ridgedMultifractal's fold-and-square step is what makes mountain terrain
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

// Roughly [-0.5, 0.5], zero mean. Distinct seed salt from ridgedMultifractal
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
