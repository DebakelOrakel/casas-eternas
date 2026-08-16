import { fineDetailNoise } from '../elevation/ridgedNoise'
import { DEFAULT_ENGINE_PARAMS, type ErosionEngineParams, type ErosionForcing } from './erosionEngine'

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
const LITHO_LATTICE_X = 512
const LITHO_LATTICE_Y = 256

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

// Torus-wrapped bilinear sample of a coarse field at a fine-grid cell.
function upsampleAt(coarse: Float32Array, resX: number, resY: number, x: number, y: number, width: number, height: number): number {
  const u = (x / width) * resX
  const v = (y / height) * resY
  const x0 = Math.floor(u)
  const y0 = Math.floor(v)
  const fx = u - x0
  const fy = v - y0
  const at = (xx: number, yy: number): number => coarse[(((yy % resY) + resY) % resY) * resX + (((xx % resX) + resX) % resX)]
  return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy
}

export function assembleFineForcing(
  coarse: CoarseForcingInputs,
  rawElevations: Float32Array,
  width: number,
  height: number,
  controls: ErosionControlsV2 = {},
): { forcing: ErosionForcing; params: ErosionEngineParams } {
  const n = width * height
  const sigma = ROCK_CONTRAST_SIGMA_MAX * ((controls.rockContrast ?? 50) / 100)
  const uplift = new Float32Array(n)
  const erodibility = new Float32Array(n)
  const coastMask = new Uint8Array(n)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (coarse.uplift) uplift[i] = upsampleAt(coarse.uplift, coarse.forcingResX, coarse.forcingResY, x, y, width, height)
      erodibility[i] = Math.exp(sigma * fineDetailNoise((x * LITHO_LATTICE_X) / width, (y * LITHO_LATTICE_Y) / height, LITHO_LATTICE_X, LITHO_LATTICE_Y, coarse.lithoSeed))
        * (coarse.hardness ? upsampleAt(coarse.hardness, coarse.forcingResX, coarse.forcingResY, x, y, width, height) : 1)
      if (rawElevations[i] > 0) coastMask[i] = 1
    }
  }

  const accumulationWeights = new Float32Array(n)
  if (coarse.water) {
    let landSum = 0
    let landCount = 0
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x
        const weight = Math.max(0, upsampleAt(coarse.water, coarse.waterResX, coarse.waterResY, x, y, width, height))
        accumulationWeights[i] = weight
        if (rawElevations[i] > 0) { landSum += weight; landCount++ }
      }
    }
    const meanLand = landCount > 0 && landSum > 0 ? landSum / landCount : 1
    for (let i = 0; i < n; i++) accumulationWeights[i] = accumulationWeights[i] / meanLand || 1
  } else {
    accumulationWeights.fill(1)
  }

  // The alluvium control scales the settling lengths (50 = the calibrated
  // neutral); rock contrast is the σ applied above.
  const alluvium = controls.alluvium ?? 50
  const settleScale = Math.pow(2, (50 - alluvium) / 50)
  const params: ErosionEngineParams = {
    ...DEFAULT_ENGINE_PARAMS,
    settleXiKm: DEFAULT_ENGINE_PARAMS.settleXiKm * settleScale,
    settleFloorKm: DEFAULT_ENGINE_PARAMS.settleFloorKm * settleScale,
    settleMarineKm: DEFAULT_ENGINE_PARAMS.settleMarineKm * settleScale,
  }

  return { forcing: { uplift, erodibility, coastMask, accumulationWeights }, params }
}
