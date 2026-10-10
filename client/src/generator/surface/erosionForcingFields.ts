import type { Domain, DomainGrid } from '../core/domain'
import { fineDetailNoise } from '../elevation/ridgedNoise'
import { DEFAULT_ENGINE_PARAMS, type ErosionEngineParams, type ErosionForcing } from './erosionEngine'
import { detExp, detPow } from '../core/detMath'

// The GRID half of the erosion-v2 forcing assembly: coarse fields in, the
// engine's fine-grid forcing out. Pure — no simulation state, no climate
// model, no save format — which is what lets it sit in surface/ and serve
// BOTH producers of coarse fields:
//
//   - the generator (pipeline/erosionForcing.ts), whose coarse U/K come from
//     the live tectonic sim and whose water forcing is the provisional
//     default-parameter climate;
//   - the amplification bake (runAmplification.ts), whose coarse U/K come
//     from the save's forcing layers and whose water forcing is the save's
//     REAL precipitation.
//
// One function, because the mapping from coarse fields + controls to what the
// engine actually reads is identity-relevant on both sides: the golden
// harness gates the generator's copy, and browser/server bakes must agree
// byte for byte on theirs. Two copies would agree only until one is edited.

// Decorrelates the erosion lithology lattice from the render's fine-detail
// noise, which shares warpSeed.
export const EROSION_LITHO_SEED_SALT = 0x51702e77

export function erosionLithoSeed(warpSeed: number): number {
  return (warpSeed ^ EROSION_LITHO_SEED_SALT) >>> 0
}

// Full lithology contrast at rockContrast 100 — the σ of the log-normal
// erodibility factor. 2.8 spans roughly ×16 between the softest and hardest
// bands at full contrast; the slider maps linearly onto it.
export const ROCK_CONTRAST_SIGMA_MAX = 2.8

// The lithology lattice is a FIXED world-space grid (512×256, ~78 km), not a
// per-raster one: a finer grid samples the same rock bands more finely
// instead of inventing narrower ones, so the generator's macro erosion and an
// 8K bake carve the same geology.
export const LITHO_LATTICE_X = 512
export const LITHO_LATTICE_Y = 256

export interface CoarseForcingInputs {
  // U and the crust-history hardness story, both on the forcing grid. Null
  // means neutral (no uplift / uniform rock) — an old save without the
  // forcing layers, deliberately accepted as a hard break.
  uplift: Float32Array | null
  hardness: Float32Array | null
  forcingResX: number
  forcingResY: number
  // The water forcing (a precipitation field) on its own grid; normalized to
  // mean 1 over land here so the engine's discharge calibration (kappaDt
  // against area-Q) keeps its meaning — only the CONTRAST changes. Null
  // means uniform water (weight 1 everywhere).
  water: Float32Array | null
  waterResX: number
  waterResY: number
  // erosionLithoSeed(warpSeed) — the world's own rock, not the caller's.
  lithoSeed: number
}

export interface ErosionControlsV2 {
  alluvium?: number
  rockContrast?: number
}

// Bilinear sample of a coarse field at a point of its grid's domain, cell
// corners at integers (neither core/field.ts convention), wrapped by the grid.
export function upsampleAt(coarse: Float32Array, grid: DomainGrid, x: number, y: number): number {
  const { resX, resY } = grid
  const u = (x / grid.domain.width) * resX
  const v = (y / grid.domain.height) * resY
  const x0 = Math.floor(u)
  const y0 = Math.floor(v)
  const fx = u - x0
  const fy = v - y0
  const c0 = grid.wrapCol(x0)
  const c1 = grid.wrapCol(x0 + 1)
  const r0 = grid.wrapRow(y0) * resX
  const r1 = grid.wrapRow(y0 + 1) * resX
  return (coarse[r0 + c0] * (1 - fx) + coarse[r0 + c1] * fx) * (1 - fy) + (coarse[r1 + c0] * (1 - fx) + coarse[r1 + c1] * fx) * fy
}

// The coarse inputs' two grids over the frame the forcing is evaluated in.
export interface ForcingGrids {
  forcing: DomainGrid
  water: DomainGrid
}

export function forcingGrids(coarse: CoarseForcingInputs, domain: Domain): ForcingGrids {
  return { forcing: domain.grid(coarse.forcingResX, coarse.forcingResY), water: domain.grid(coarse.waterResX, coarse.waterResY) }
}

// The forcing at ONE point: U upsampled, erodibility as the lithology
// lattice's log-normal contrast times the crust hardness, both evaluated
// at (x, y) of the grids' domain. A raster passes its cell indices and a
// domain one cell per unit; the mesh passes world coordinates and the
// world (mesh/meshErosion.ts) — the lattice and the coarse fields are
// world-space either way, so the same rock band runs under a cell and
// under the node that sits on it. Writes [uplift, erodibility] into `out`.
export function forcingAt(coarse: CoarseForcingInputs, grids: ForcingGrids, sigma: number, x: number, y: number, out: Float64Array): void {
  const { width, height } = grids.forcing.domain
  out[0] = coarse.uplift ? upsampleAt(coarse.uplift, grids.forcing, x, y) : 0
  out[1] = detExp(sigma * fineDetailNoise((x * LITHO_LATTICE_X) / width, (y * LITHO_LATTICE_Y) / height, LITHO_LATTICE_X, LITHO_LATTICE_Y, coarse.lithoSeed))
    * (coarse.hardness ? upsampleAt(coarse.hardness, grids.forcing, x, y) : 1)
}

// The water forcing at one point, before normalisation (0 where the
// caller has no water field — the caller then fills 1).
export function waterAt(coarse: CoarseForcingInputs, grids: ForcingGrids, x: number, y: number): number {
  return coarse.water ? Math.max(0, upsampleAt(coarse.water, grids.water, x, y)) : 1
}

export function rockContrastSigma(controls: ErosionControlsV2): number {
  return ROCK_CONTRAST_SIGMA_MAX * ((controls.rockContrast ?? 50) / 100)
}

// The engine parameters for a run under the controls: the alluvium
// control scales the settling lengths (50 = the calibrated neutral), and
// with them the shelf band the engine stays active in — the band is sized
// to the marine settling length, so the two move together. Rock contrast
// is the σ applied in forcingAt.
export function engineParamsFor(controls: ErosionControlsV2): ErosionEngineParams {
  const alluvium = controls.alluvium ?? 50
  const settleScale = detPow(2, (50 - alluvium) / 50)
  return {
    ...DEFAULT_ENGINE_PARAMS,
    settleXiKm: DEFAULT_ENGINE_PARAMS.settleXiKm * settleScale,
    settleFloorKm: DEFAULT_ENGINE_PARAMS.settleFloorKm * settleScale,
    settleMarineKm: DEFAULT_ENGINE_PARAMS.settleMarineKm * settleScale,
    settleCoarseKm: DEFAULT_ENGINE_PARAMS.settleCoarseKm * settleScale,
    shelfBandKm: DEFAULT_ENGINE_PARAMS.shelfBandKm * settleScale,
  }
}

// `domain`: what the raster covers, one cell per unit.
export function assembleFineForcing(
  coarse: CoarseForcingInputs,
  rawElevations: Float32Array,
  domain: Domain,
  controls: ErosionControlsV2 = {},
): { forcing: ErosionForcing; params: ErosionEngineParams } {
  const { width, height } = domain
  const grids = forcingGrids(coarse, domain)
  const n = width * height
  const sigma = rockContrastSigma(controls)
  const uplift = new Float32Array(n)
  const erodibility = new Float32Array(n)
  const coastMask = new Uint8Array(n)
  const pair = new Float64Array(2)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      forcingAt(coarse, grids, sigma, x, y, pair)
      uplift[i] = pair[0]
      erodibility[i] = pair[1]
      if (rawElevations[i] > 0) coastMask[i] = 1
    }
  }

  // The water weights normalised to mean 1 over land (the mean taken in
  // double before the weights are stored). A zero-precipitation cell
  // contributes zero — that IS the coupling (the `|| 1` that used to sit
  // here turned the driest cells into the uniform default, exactly where
  // the climate should have bitten).
  const accumulationWeights = new Float32Array(n)
  if (coarse.water) {
    let landSum = 0
    let landCount = 0
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x
        const weight = waterAt(coarse, grids, x, y)
        accumulationWeights[i] = weight
        if (rawElevations[i] > 0) { landSum += weight; landCount++ }
      }
    }
    const meanLand = landCount > 0 && landSum > 0 ? landSum / landCount : 1
    for (let i = 0; i < n; i++) accumulationWeights[i] = accumulationWeights[i] / meanLand
  } else {
    accumulationWeights.fill(1)
  }

  return { forcing: { uplift, erodibility, coastMask, accumulationWeights }, params: engineParamsFor(controls) }
}

// The same forcing on a POINT SET — the mesh's nodes (mesh/meshErosion.ts):
// `xs`/`ys` in coordinates of `domain` (the world), `alive` marking the slots that hold a node, `areas` the
// nodes' areas for the water normalisation. Arrays come back in the
// point set's slot layout. `meanLandWater` replaces the water mean the
// weights are normalised by: a tile of the top level is a piece of a world
// and must weigh its water against the WORLD's land, not its own (a dry
// tile would otherwise drain like an average one).
export function assembleNodeForcing(
  coarse: CoarseForcingInputs,
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  alive: Uint8Array,
  count: number,
  z: Float32Array,
  areas: ArrayLike<number>,
  domain: Domain,
  controls: ErosionControlsV2 = {},
  meanLandWater?: number,
): { forcing: ErosionForcing; params: ErosionEngineParams } {
  const grids = forcingGrids(coarse, domain)
  const sigma = rockContrastSigma(controls)
  const uplift = new Float32Array(count)
  const erodibility = new Float32Array(count)
  const coastMask = new Uint8Array(count)
  const accumulationWeights = new Float32Array(count)
  const pair = new Float64Array(2)
  // The water mean over land is AREA-weighted here — a node stands for
  // its Voronoi cell, where a raster cell stood for one cell.
  let landSum = 0
  let landArea = 0
  for (let i = 0; i < count; i++) {
    if (!alive[i]) continue
    forcingAt(coarse, grids, sigma, xs[i], ys[i], pair)
    uplift[i] = pair[0]
    erodibility[i] = pair[1]
    if (z[i] > 0) coastMask[i] = 1
    const weight = waterAt(coarse, grids, xs[i], ys[i])
    accumulationWeights[i] = weight
    if (z[i] > 0) { landSum += weight * areas[i]; landArea += areas[i] }
  }
  if (coarse.water) {
    const meanLand = meanLandWater ?? (landArea > 0 && landSum > 0 ? landSum / landArea : 1)
    for (let i = 0; i < count; i++) accumulationWeights[i] = accumulationWeights[i] / meanLand
  }
  return { forcing: { uplift, erodibility, coastMask, accumulationWeights }, params: engineParamsFor(controls) }
}

// The engine's rates for an iteration LONGER than the calibrated one
// (erosionEngine.ITERATION_YEARS): every per-iteration rate scales with
// the step, the caps with it — the coupled history (phase 5) runs a few
// long iterations per epoch where the pass ran forty short ones. The
// implicit stream power is stable at any step; the explicit hillslope and
// marine exchange are capped per pair (erosionEngine.DIFFUSION_PAIR_CAP),
// so at a large step they saturate rather than blow up — a bias the
// calibration measures, not a fault. `dtScale` is the step over the
// calibrated one.
export function scaleEngineParamsForDt(params: ErosionEngineParams, dtScale: number): ErosionEngineParams {
  return {
    ...params,
    kappaDt: params.kappaDt * dtScale,
    upliftDt: params.upliftDt * dtScale,
    hillDiffKm2: params.hillDiffKm2 * dtScale,
    marineDiffDt: params.marineDiffDt * dtScale,
    depositCapLandM: params.depositCapLandM * dtScale,
    depositCapMarineM: params.depositCapMarineM * dtScale,
  }
}
