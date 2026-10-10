import { TECTONICS_TUNING } from './tectonicsTuneParams'
import { detExp, detLog, detPow } from '../core/detMath'
import type { DomainGrid } from '../core/domain'

// FLEXURAL ISOSTASY (ADAPTIVE_MESH_PLAN.md phase 5.3, decision 5 of
// docs/decisions/adaptive-mesh.md): the lithosphere answers a change of
// load — rock the erosion carried off, sediment it laid down, later the
// ice — as an elastic plate over a fluid mantle. The load is spread over
// the flexural parameter α before it is compensated, so a range's weight
// bends the plate beside it as well as under it (the foreland basin,
// with no feature rule) and an eroding range rises back as a whole. Airy
// per node was rejected (over-compensates narrow loads, no basins).
//
// THE SOLVER is the decision's fallback, a convolution with the kernel's
// radius taken from Te at the load: the true biharmonic has no cheap
// form on a triangulation, so the response is computed on a coarse
// raster (the load binned from the nodes by area, the deflection read
// back at the nodes) and the kernel is a Gaussian of width α — the main
// lobe of the flexural profile without the forebulge, which at these
// wavelengths is a few metres. Te varies, so the loads are BANDED by α
// (geometric steps of 1.5) and each band is blurred with its own width;
// a variable-D iterative solve remains the upgrade if a measured world
// wants the forebulge.
//
// Units: loads and deflections in METRES of rock, the raster's cell in
// km; the deflection is positive up, so unloading (erosion) lifts and
// loading (deposition) sinks, by ρ_crust/ρ_mantle of the load once fully
// spread.

const BAND_BASE_KM = 20
const BAND_STEP = 1.5
const BAND_COUNT = 8

// The elastic thickness at a point: a raft between the young and the
// craton value by oldness, the ocean by its lithosphere age.
export function elasticThicknessKm(continental: boolean, oldness: number, oceanAgeMa: number): number {
  const T = TECTONICS_TUNING
  if (continental) return T.flexureTeYoungKm + (T.flexureTeCratonKm - T.flexureTeYoungKm) * Math.min(1, Math.max(0, oldness))
  return Math.min(T.flexureTeOceanMaxKm, T.flexureTeOceanFloorKm + T.flexureTeOceanAgeKm * Math.sqrt(Math.max(0, oceanAgeMa)))
}

// The flexural parameter α = (4D / (Δρ g))^(1/4), km, with the rigidity
// D = E Te³ / (12 (1 − ν²)).
export function flexuralAlphaKm(teKm: number): number {
  const T = TECTONICS_TUNING
  const E = T.flexureYoungsModulusGPa * 1e9
  const te = teKm * 1000
  const D = (E * te * te * te) / (12 * (1 - T.flexurePoisson * T.flexurePoisson))
  const dRho = T.flexureMantleDensity - T.flexureCrustDensity
  return detPow((4 * D) / (dRho * 9.81), 0.25) / 1000
}

function bandOf(alphaKm: number): number {
  const b = Math.round(detLog(Math.max(alphaKm, BAND_BASE_KM) / BAND_BASE_KM) / detLog(BAND_STEP))
  return Math.min(BAND_COUNT - 1, Math.max(0, b))
}

function bandAlphaKm(band: number): number {
  return BAND_BASE_KM * detPow(BAND_STEP, band)
}

// A separable Gaussian blur of `field` in place over its grid, σ in cells.
// The wrapped taps come from the grid's tables, so the kernel loops stay
// plain arithmetic.
//
// On the sphere (step 4d5, fork 5 of DEC-0035) σ is a length, in equator
// cells: a row whose cells are narrower (DomainGrid.rowScale, cos φ) takes
// σ / rowScale of its own east-west — around a pole row many times, so the
// kernel is wrapped onto the row's cells (folded) once it is wider than the
// row. North-south the taps step across a pole as the grid does, and each
// source row spreads its load over the rows in reach by their area
// (cellArea), normalised at the source: ∫ G dA = 1 for every load, so the
// deflection's volume is the compensated load's wherever the load lies —
// a load near a pole spreads its weight onto the larger rows equatorward,
// not its value. Then the pole rows are made one value each. On the torus
// every row is the equator's, every tap reads a row of one area, and the
// loops below are the torus's own: its bits stay.
function blurOnGrid(field: Float32Array, grid: DomainGrid, sigmaCells: number, scratch: Float32Array): void {
  const { resX, resY } = grid
  const radius = Math.max(1, Math.ceil(3 * sigmaCells))
  const cols = grid.colTable(radius)
  const kernel = gaussianKernel(sigmaCells, radius)
  // East-west, row by row: the torus's kernel and table where the row is
  // the equator's, the row's own (folded when wider than it) where it is
  // narrower.
  for (let y = 0; y < resY; y++) {
    const row = y * resX
    const scale = grid.rowScale(y)
    if (scale < 1) {
      blurRowNarrow(field, scratch, row, resX, sigmaCells / scale)
      continue
    }
    for (let x = 0; x < resX; x++) {
      let acc = 0
      for (let k = -radius; k <= radius; k++) acc += kernel[k + radius] * field[row + cols[x + k + radius]]
      scratch[row + x] = acc
    }
  }
  // North-south: per row the cells its taps read — the row index and
  // whether it lies beyond a pole (then the far meridian, column +
  // resX / 2) — and the taps' weights. A source row q hands its load to the
  // rows within reach in proportion to kernel × their area, normalised by
  // its own sum of those (`spread[q]`), so its volume arrives whole; a row
  // reads each tap as kernel × the source's area over its spread. Where
  // the rows a row's taps reach all have its area the weights are the
  // kernel itself (the torus, every row).
  const tapRow = new Int32Array(2 * radius + 1)
  const tapShift = new Int32Array(2 * radius + 1)
  const weight = new Float64Array(2 * radius + 1)
  const rowOf = (y: number, k: number): number => Math.floor(grid.neighbour(0, y, 0, k) / resX)
  const spread = new Float64Array(resY)
  for (let q = 0; q < resY; q++) {
    let sum = 0
    for (let k = -radius; k <= radius; k++) sum += kernel[k + radius] * grid.cellArea(rowOf(q, k))
    spread[q] = sum
  }
  for (let y = 0; y < resY; y++) {
    let uniform = true
    const area0 = grid.cellArea(y)
    for (let k = -radius; k <= radius; k++) {
      const at = grid.neighbour(0, y, 0, k)
      const base = at - (at % resX)
      tapRow[k + radius] = base
      tapShift[k + radius] = at - base
      if (grid.cellArea(base / resX) !== area0) uniform = false
    }
    if (uniform) {
      for (let k = 0; k < weight.length; k++) weight[k] = kernel[k]
    } else {
      for (let k = 0; k < weight.length; k++) {
        const q = tapRow[k] / resX
        weight[k] = (kernel[k] * grid.cellArea(q)) / spread[q]
      }
    }
    for (let x = 0; x < resX; x++) {
      let acc = 0
      for (let k = 0; k < weight.length; k++) {
        const shift = tapShift[k]
        acc += weight[k] * scratch[tapRow[k] + (shift === 0 ? x : (x + shift) % resX)]
      }
      field[y * resX + x] = acc
    }
  }
  grid.averagePoleRows(field)
}

function gaussianKernel(sigmaCells: number, radius: number): Float64Array {
  const kernel = new Float64Array(2 * radius + 1)
  let sum = 0
  for (let k = -radius; k <= radius; k++) { const w = detExp(-(k * k) / (2 * sigmaCells * sigmaCells)); kernel[k + radius] = w; sum += w }
  for (let k = 0; k < kernel.length; k++) kernel[k] /= sum
  return kernel
}

// One row narrower than the equator's, blurred east-west with σ in its own
// cells into `out`: the kernel folded onto the row's resX cells (a tap k
// lands on k mod resX), at most resX taps a cell however wide the kernel.
function blurRowNarrow(field: Float32Array, out: Float32Array, row: number, resX: number, sigmaCells: number): void {
  const radius = Math.max(1, Math.ceil(3 * sigmaCells))
  const folded = new Float64Array(resX)
  let sum = 0
  for (let k = -radius; k <= radius; k++) {
    const w = detExp(-(k * k) / (2 * sigmaCells * sigmaCells))
    folded[((k % resX) + resX) % resX] += w
    sum += w
  }
  for (let k = 0; k < resX; k++) folded[k] /= sum
  const taps: number[] = []
  for (let k = 0; k < resX; k++) if (folded[k] > 0) taps.push(k)
  const tapAt = Int32Array.from(taps)
  const tapWeight = Float64Array.from(taps, (k) => folded[k])
  // The row twice over, so a tap reads (x + k) without a modulo.
  const twice = new Float64Array(2 * resX)
  for (let x = 0; x < resX; x++) { twice[x] = field[row + x]; twice[x + resX] = field[row + x] }
  for (let x = 0; x < resX; x++) {
    let acc = 0
    for (let j = 0; j < tapAt.length; j++) acc += tapWeight[j] * twice[x + tapAt[j]]
    out[row + x] = acc
  }
}

// The plate's deflection, metres (+ up), for a load change `loadM`
// (metres of rock added per cell, negative where removed) with the
// elastic thickness `teKm` per cell, both on the raster `grid` of cells
// `cellKm` wide.
export function flexuralResponse(loadM: Float32Array, teKm: Float32Array, grid: DomainGrid, cellKm: number): Float32Array {
  const n = grid.resX * grid.resY
  const T = TECTONICS_TUNING
  const compensation = (T.flexureCrustDensity / T.flexureMantleDensity) * T.flexureDeflectionScale
  const bands: (Float32Array | null)[] = new Array(BAND_COUNT).fill(null)
  for (let i = 0; i < n; i++) {
    const q = loadM[i]
    if (q === 0) continue
    const b = bandOf(flexuralAlphaKm(teKm[i]))
    let field = bands[b]
    if (!field) { field = new Float32Array(n); bands[b] = field }
    field[i] += q
  }
  const w = new Float32Array(n)
  const scratch = new Float32Array(n)
  for (let b = 0; b < BAND_COUNT; b++) {
    const field = bands[b]
    if (!field) continue
    blurOnGrid(field, grid, bandAlphaKm(b) / cellKm, scratch)
    for (let i = 0; i < n; i++) w[i] -= compensation * field[i]
  }
  return w
}

// Bilinear read of the deflection raster at a point of its grid's domain,
// wrapped by the grid (DomainGrid.interpolate: across a pole to the far
// meridian on the sphere).
export function deflectionAt(w: Float32Array, grid: DomainGrid, x: number, y: number): number {
  return grid.interpolate(w, (x / grid.domain.width) * grid.resX - 0.5, (y / grid.domain.height) * grid.resY - 0.5)
}
