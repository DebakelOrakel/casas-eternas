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
function periodicValueNoise2D(x: number, y: number, cellsX: number, cellsY: number, seed: number): number {
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
// tiling requires. Range scale: tens of cells across the map, several
// within a single range's footprint, finer than domainWarp's 8/16/32.
const RIDGE_OCTAVES: ReadonlyArray<{ cellsX: number; cellsY: number; amplitude: number }> = [
  { cellsX: 32, cellsY: 16, amplitude: 1.0 },
  { cellsX: 64, cellsY: 32, amplitude: 0.5 },
  { cellsX: 128, cellsY: 64, amplitude: 0.25 },
  { cellsX: 256, cellsY: 128, amplitude: 0.125 },
]

// Mean of the ridged field, subtracted by callers to center it at ~0 so
// ridgelines add height and valleys cut down with no net elevation bias.
// Measured, not derived: the naive analytic value (∫₀¹(1-u)²du = 1/3,
// assuming a uniform noise value) is wrong here because bilinear +
// smoothstep interpolation makes the value-noise samples cluster toward
// 0.5 rather than stay uniform, which pushes the ridged mean up. Sampled
// over the full map across several seeds at this exact octave
// configuration → 0.47 (seed-to-seed spread only ~±0.005, negligible as a
// residual bias). Re-measure if RIDGE_OCTAVES or the interpolation change.
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
