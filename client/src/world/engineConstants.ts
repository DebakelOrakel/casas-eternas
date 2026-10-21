// The numbers the pipeline versions are derived from, as the engine gives
// them under TypeScript's names (docs/decisions/rust-engine.md, fork 7a):
// `make engine` writes engine/dist/constants.json, which this reads when it
// loads, so a key needs no engine call. One source: a constant changed in
// the engine changes the versions.
import constants from 'casas-engine-constants'

export const ENGINE_CONSTANTS = constants

// A level's budget (pipeline/meshBakeStage.levelBudget).
export function engineLevelBudget(level: number): number {
  const budget = constants.levelBudget[String(level)]
  if (budget === undefined) throw new Error(`level ${level} has no budget`)
  return budget
}
