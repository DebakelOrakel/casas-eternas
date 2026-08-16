import type { PlateSimulation } from '../tectonics/plateSimulation'
import { computeUpliftField } from '../elevation/upliftField'
import { computeErodibilityField } from '../elevation/erodibilityField'
import { fineDetailNoise } from '../elevation/ridgedNoise'
import { computeTemperature } from '../climate/temperature'
import { computeWind } from '../climate/wind'
import { computeSeasonalAmplitude } from '../climate/seasonality'
import { computeSeasonalPrecipitation } from '../climate/monsoon'
import { CLIMATE_RES_X, CLIMATE_RES_Y } from '../climate/climateField'
import { worldEpoch } from '../core/worldTime'
import { DEFAULT_ENGINE_PARAMS, type ErosionEngineParams, type ErosionForcing } from '../surface/erosionEngine'

// The erosion-v2 forcing, assembled from the tectonic state — ONE function,
// because the assembly is identity-relevant: the generator's erode stage
// (pipeline/runtime.ts) and the golden harness must run the engine on
// byte-identical inputs, or the harness gates a different world than the
// one the player gets. Same precedent as erosionParamsWithControls: the
// mapping lives once, whoever needs it imports it.
//
// Lives in pipeline/ (not surface/) because it reaches across the peers:
// it reads tectonic state and evaluates the climate model, which surface/
// must not import. See docs/design/erosion-v2.md, "The tectonics
// interface" for what each piece is and how it was measured.

// The subset of the simulation the assembly actually reads — a type, so
// the golden harness can hand in a deserialized snapshot as easily as the
// runtime hands in its live sim.
export interface ErosionForcingSources {
  features: PlateSimulation['features']
  rafts: PlateSimulation['rafts']
  sutures: PlateSimulation['sutures']
  epoch: number
  archeanEpochs: number
  warpSeed: number
}

export interface ErosionControlsV2 {
  alluvium?: number
  rockContrast?: number
}

// Decorrelates the erosion lithology lattice from the render's
// fine-detail noise, which shares warpSeed.
const EROSION_LITHO_SEED_SALT = 0x51702e77

export function assembleErosionForcing(
  sources: ErosionForcingSources,
  rawElevations: Float32Array,
  width: number,
  height: number,
  controls: ErosionControlsV2 = {},
): { forcing: ErosionForcing; params: ErosionEngineParams } {
  const n = width * height
  // U from the features' activity, the K story from the crust's history,
  // both at climate resolution and bilinearly upsampled; the fine rock
  // contrast is the world-seeded lithology noise on its fixed lattice.
  const upliftCoarse = computeUpliftField(sources.features, width, height, CLIMATE_RES_X, CLIMATE_RES_Y)
  const hardnessCoarse = computeErodibilityField(
    sources.rafts, sources.sutures, sources.features,
    worldEpoch(sources.archeanEpochs, sources.epoch),
    width, height, CLIMATE_RES_X, CLIMATE_RES_Y)
  const upsample = (coarse: Float32Array, x: number, y: number): number => {
    const u = (x / width) * CLIMATE_RES_X
    const v = (y / height) * CLIMATE_RES_Y
    const x0 = Math.floor(u)
    const y0 = Math.floor(v)
    const fx = u - x0
    const fy = v - y0
    const at = (xx: number, yy: number): number => coarse[(((yy % CLIMATE_RES_Y) + CLIMATE_RES_Y) % CLIMATE_RES_Y) * CLIMATE_RES_X + (((xx % CLIMATE_RES_X) + CLIMATE_RES_X) % CLIMATE_RES_X)]
    return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy
  }
  const lithoSeed = (sources.warpSeed ^ EROSION_LITHO_SEED_SALT) >>> 0
  const sigma = 2.8 * ((controls.rockContrast ?? 50) / 100)
  const uplift = new Float32Array(n)
  const erodibility = new Float32Array(n)
  const coastMask = new Uint8Array(n)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      uplift[i] = upsample(upliftCoarse, x, y)
      erodibility[i] = Math.exp(sigma * fineDetailNoise((x * 512) / width, (y * 256) / height, 512, 256, lithoSeed)) * upsample(hardnessCoarse, x, y)
      if (rawElevations[i] > 0) coastMask[i] = 1
    }
  }

  // Provisional climate as the water forcing (decided 2026-08-17): the
  // climate model evaluated on the INPUT terrain with DEFAULT parameters —
  // orography reaches the solve, the climate panel's sliders deliberately
  // do not (the live coupling is its own later stage-order step).
  // Normalized to mean 1 over land so the engine's discharge calibration
  // (kappaDt against area-Q) keeps its meaning; only the CONTRAST changes.
  const provisionalTemperature = computeTemperature(rawElevations, width, height)
  const provisionalPrecip = computeSeasonalPrecipitation(rawElevations, provisionalTemperature, computeSeasonalAmplitude(rawElevations, width, height), computeWind(), width, height, 1, 0).annual
  const accumulationWeights = new Float32Array(n)
  let landSum = 0
  let landCount = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      const weight = Math.max(0, upsample(provisionalPrecip, x, y))
      accumulationWeights[i] = weight
      if (rawElevations[i] > 0) { landSum += weight; landCount++ }
    }
  }
  const meanLand = landCount > 0 && landSum > 0 ? landSum / landCount : 1
  for (let i = 0; i < n; i++) accumulationWeights[i] = accumulationWeights[i] / meanLand || 1

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
