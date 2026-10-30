// The numbers the pipeline versions are derived from, as the engine gives
// them under TypeScript's names (docs/decisions/rust-engine.md, fork 7a):
// `make engine` writes engine/dist/constants.json, which this reads when it
// loads, so a key needs no engine call. One source: a constant changed in
// the engine changes the versions.
import constants from 'casas-generator-constants'

export const ENGINE_CONSTANTS = constants

// The engine's climate and surface tuning (climate_tune_params.rs,
// surface_tune_params.rs), typed for the keys the client reads: the read
// side and the screen. The numbers the engine computes with, so a reader
// and the engine cannot drift apart.
export const CLIMATE_TUNING = constants.tuning.climate as {
  windSpeedMsPerUnit: number
  monsoonSeasonalityFloor: number
  lapseCPerElevation: number
  tempEquatorC: number
  tempPoleC: number
}
export const SURFACE_TUNING = constants.tuning.surface as {
  petBaseMm: number
  petPerDegC: number
  petMinMm: number
  petMaxMm: number
  saltBandM: number
}

// A level's budget (pipeline/meshBakeStage.levelBudget).
export function engineLevelBudget(level: number): number {
  const budget = constants.levelBudget[String(level)]
  if (budget === undefined) throw new Error(`level ${level} has no budget`)
  return budget
}
