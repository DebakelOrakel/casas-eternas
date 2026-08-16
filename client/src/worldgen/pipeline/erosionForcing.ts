import type { PlateSimulation } from '../tectonics/plateSimulation'
import { computeUpliftField } from '../elevation/upliftField'
import { computeErodibilityField } from '../elevation/erodibilityField'
import { computeTemperature } from '../climate/temperature'
import { computeWind } from '../climate/wind'
import { computeSeasonalAmplitude } from '../climate/seasonality'
import { computeSeasonalPrecipitation } from '../climate/monsoon'
import { CLIMATE_RES_X, CLIMATE_RES_Y } from '../climate/climateField'
import { worldEpoch } from '../core/worldTime'
import type { ErosionEngineParams, ErosionForcing } from '../surface/erosionEngine'
import { assembleFineForcing, erosionLithoSeed } from '../surface/erosionForcingFields'
import type { ErosionControlsV2 } from '../surface/erosionForcingFields'

// The erosion-v2 forcing, assembled from the tectonic state — ONE function,
// because the assembly is identity-relevant: the generator's erode stage
// (pipeline/runtime.ts) and the golden harness must run the engine on
// byte-identical inputs, or the harness gates a different world than the
// one the player gets. Same precedent as erosionParamsWithControls: the
// mapping lives once, whoever needs it imports it.
//
// Lives in pipeline/ (not surface/) because it reaches across the peers:
// it reads tectonic state and evaluates the climate model, which surface/
// must not import. The grid half — upsampling, lithology noise, the water
// normalization and the controls mapping — is surface/erosionForcingFields'
// assembleFineForcing, SHARED with the amplification bake so both sides of
// the artifact boundary speak one mapping. See docs/design/erosion-v2.md,
// "The tectonics interface" for what each piece is and how it was measured.

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

export type { ErosionControlsV2 }

// The two coarse forcing fields at climate resolution: U from the features'
// activity, the K story from the crust's history. Exported on their own
// because the SAVE persists exactly these (layers `uplift`/`erodibility`),
// which is how the amplification bake gets its forcing without carrying the
// simulation — one derivation, whether the fields are about to be eroded
// with or written down.
export function coarseForcingFields(
  sources: ErosionForcingSources,
  width: number,
  height: number,
): { uplift: Float32Array; hardness: Float32Array } {
  const uplift = computeUpliftField(sources.features, width, height, CLIMATE_RES_X, CLIMATE_RES_Y)
  const hardness = computeErodibilityField(
    sources.rafts, sources.sutures, sources.features,
    worldEpoch(sources.archeanEpochs, sources.epoch),
    width, height, CLIMATE_RES_X, CLIMATE_RES_Y)
  return { uplift, hardness }
}

export function assembleErosionForcing(
  sources: ErosionForcingSources,
  rawElevations: Float32Array,
  width: number,
  height: number,
  controls: ErosionControlsV2 = {},
): { forcing: ErosionForcing; params: ErosionEngineParams } {
  const { uplift, hardness } = coarseForcingFields(sources, width, height)

  // Provisional climate as the water forcing (decided 2026-08-17): the
  // climate model evaluated on the INPUT terrain with DEFAULT parameters —
  // orography reaches the solve, the climate panel's sliders deliberately
  // do not (the live coupling is its own later stage-order step).
  const provisionalTemperature = computeTemperature(rawElevations, width, height)
  const provisionalPrecip = computeSeasonalPrecipitation(rawElevations, provisionalTemperature, computeSeasonalAmplitude(rawElevations, width, height), computeWind(), width, height, 1, 0).annual

  return assembleFineForcing({
    uplift,
    hardness,
    forcingResX: CLIMATE_RES_X,
    forcingResY: CLIMATE_RES_Y,
    water: provisionalPrecip,
    waterResX: CLIMATE_RES_X,
    waterResY: CLIMATE_RES_Y,
    lithoSeed: erosionLithoSeed(sources.warpSeed),
  }, rawElevations, width, height, controls)
}
