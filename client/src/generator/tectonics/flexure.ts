import { TECTONICS_TUNING } from './tectonicsTuneParams'
import { detExp, detLog, detPow } from '../core/detMath'

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

// A toroidal separable Gaussian blur of `field` in place, σ in cells.
function blurToroidal(field: Float32Array, resX: number, resY: number, sigmaCells: number, scratch: Float32Array): void {
  const radius = Math.max(1, Math.ceil(3 * sigmaCells))
  const kernel = new Float64Array(2 * radius + 1)
  let sum = 0
  for (let k = -radius; k <= radius; k++) { const w = detExp(-(k * k) / (2 * sigmaCells * sigmaCells)); kernel[k + radius] = w; sum += w }
  for (let k = 0; k < kernel.length; k++) kernel[k] /= sum
  for (let y = 0; y < resY; y++) {
    const row = y * resX
    for (let x = 0; x < resX; x++) {
      let acc = 0
      for (let k = -radius; k <= radius; k++) acc += kernel[k + radius] * field[row + (((x + k) % resX) + resX) % resX]
      scratch[row + x] = acc
    }
  }
  for (let x = 0; x < resX; x++) {
    for (let y = 0; y < resY; y++) {
      let acc = 0
      for (let k = -radius; k <= radius; k++) acc += kernel[k + radius] * scratch[((((y + k) % resY) + resY) % resY) * resX + x]
      field[y * resX + x] = acc
    }
  }
}

// The plate's deflection, metres (+ up), for a load change `loadM`
// (metres of rock added per cell, negative where removed) with the
// elastic thickness `teKm` per cell, both on a raster of `resX` × `resY`
// cells `cellKm` wide.
export function flexuralResponse(loadM: Float32Array, teKm: Float32Array, resX: number, resY: number, cellKm: number): Float32Array {
  const n = resX * resY
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
    blurToroidal(field, resX, resY, bandAlphaKm(b) / cellKm, scratch)
    for (let i = 0; i < n; i++) w[i] -= compensation * field[i]
  }
  return w
}

// Torus-wrapped bilinear read of the deflection raster at a world point.
export function deflectionAt(w: Float32Array, resX: number, resY: number, x: number, y: number, worldWidth: number, worldHeight: number): number {
  const u = (x / worldWidth) * resX - 0.5
  const v = (y / worldHeight) * resY - 0.5
  const x0 = Math.floor(u)
  const y0 = Math.floor(v)
  const fx = u - x0
  const fy = v - y0
  const at = (xx: number, yy: number): number => w[(((yy % resY) + resY) % resY) * resX + (((xx % resX) + resX) % resX)]
  return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy
}
