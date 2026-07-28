import { smoothstep } from '../core/interpolation'
import { wrapValue } from '../core/field'
// Every contour the elevation field produces (elevationField.ts) is a sum
// of smooth radial falloffs — baseline blend, feature uplift — so it's
// geometrically incapable of looking jagged anywhere, coastlines
// included. Domain warping perturbs the *query point* before it's used to
// sample that field, rather than perturbing the field's output: one cheap
// mechanism that ripples every contour the field produces (coastlines,
// rift valleys, uplift falloffs alike), instead of a coastline-specific
// filter that would leave everything else exactly as smooth as before.
//
// Must tile exactly at the map's own wrap period in both axes — this is a
// torus, not a bounded rectangle, and a non-periodic noise function would
// leave a visible seam at the wrap edge. Value noise over an integer
// lattice, hashed modulo the period, is the simplest way to guarantee
// that: lattice coordinate 0 and lattice coordinate `period` hash
// identically by construction, so the noise field itself has no seam to
// begin with.

// Cheap integer hash (bit-mixing, no trig/sqrt) — only needs to look
// unrelated between neighboring lattice points, not survive any
// cryptographic scrutiny. axisSalt distinguishes the x-offset and
// y-offset noise fields from each other (see domainWarpDelta) without
// needing a second, differently-tuned hash function.
function hashLatticePoint(ix: number, iy: number, warpSeed: number, axisSalt: number): number {
  let h = (ix * 374761393 + iy * 668265263 + warpSeed * 2246822519 + axisSalt * 3266489917) >>> 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h = (h ^ (h >>> 16)) >>> 0
  return h / 4294967296 // [0, 1)
}


// Bilinear-interpolated value noise over a lattice that repeats every
// (periodX, periodY) integer units — periods are in *lattice* units, not
// pixels; see domainWarpDelta for the pixel->lattice scaling per octave.
function periodicValueNoise2D(x: number, y: number, periodX: number, periodY: number, warpSeed: number, axisSalt: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  const x0m = wrapValue(x0, periodX) | 0
  const y0m = wrapValue(y0, periodY) | 0
  const x1m = (x0m + 1) % periodX
  const y1m = (y0m + 1) % periodY

  const v00 = hashLatticePoint(x0m, y0m, warpSeed, axisSalt)
  const v10 = hashLatticePoint(x1m, y0m, warpSeed, axisSalt)
  const v01 = hashLatticePoint(x0m, y1m, warpSeed, axisSalt)
  const v11 = hashLatticePoint(x1m, y1m, warpSeed, axisSalt)

  const sx = smoothstep(fx)
  const sy = smoothstep(fy)
  const top = v00 + (v10 - v00) * sx
  const bottom = v01 + (v11 - v01) * sx
  return top + (bottom - top) * sy // [0, 1)
}

// Cells-across-the-map (not pixels) per octave, so the map's 2:1 aspect
// ratio (MAP_WIDTH/MAP_HEIGHT) gets proportionally more cells in x than
// y rather than stretched square cells — both dimensions stay in lattice
// units that are exact integers at every octave (doubling from 8 is exact
// all the way up), which periodicValueNoise2D's modulo tiling requires.
// Amplitude halves each octave (standard fBm) — coarse octave sets the
// overall wobble, finer ones add ragged detail on top without dominating.
const WARP_OCTAVES: ReadonlyArray<{ cellsX: number; cellsY: number; amplitude: number }> = [
  { cellsX: 8, cellsY: 4, amplitude: 1.0 },
  { cellsX: 16, cellsY: 8, amplitude: 0.5 },
  { cellsX: 32, cellsY: 16, amplitude: 0.25 },
]

// How far, in pixels, a query point can be displaced — deliberately
// modest relative to FEATURE_FALLOFF_RADIUS (160) and
// BASELINE_BLEND_RADIUS (220) in elevationField.ts: this should read as
// "coastlines and ridgelines are a little ragged," not "the tectonic
// shapes are dissolved into noise." Tune by eye — this is a visual call,
// not something with a formula to derive it from.
const WARP_AMPLITUDE_PX = 26

// axisSalt values for the two offset axes — arbitrary distinct constants,
// just need to decorrelate the x-offset and y-offset noise fields from
// each other (using the same salt for both would displace every point
// along the line y=x instead of in an independent 2D direction).
const AXIS_SALT_X = 0
const AXIS_SALT_Y = 97

function fbmNoise(x: number, y: number, width: number, height: number, warpSeed: number, axisSalt: number): number {
  let sum = 0
  let amplitudeSum = 0
  for (const octave of WARP_OCTAVES) {
    const lx = (x / width) * octave.cellsX
    const ly = (y / height) * octave.cellsY
    const n = periodicValueNoise2D(lx, ly, octave.cellsX, octave.cellsY, warpSeed, axisSalt)
    sum += (n * 2 - 1) * octave.amplitude // remap [0,1) -> roughly [-1,1)
    amplitudeSum += octave.amplitude
  }
  return sum / amplitudeSum
}

// The x or y component (per axisSalt) of how far (x, y) should be
// displaced before sampling the elevation field. Two number-returning
// calls at a call site (one per axis) rather than a single call
// allocating a {x, y} pair — this runs once per pixel per axis inside
// the project's own hottest loop (elevationField.ts's computeElevation),
// so avoiding a per-pixel object allocation here matters the same way it
// does for erosion.ts's MinHeap pop.
export function domainWarpDelta(x: number, y: number, width: number, height: number, warpSeed: number, axis: 'x' | 'y'): number {
  const axisSalt = axis === 'x' ? AXIS_SALT_X : AXIS_SALT_Y
  return fbmNoise(x, y, width, height, warpSeed, axisSalt) * WARP_AMPLITUDE_PX
}
