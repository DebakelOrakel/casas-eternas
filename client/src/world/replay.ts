import type { CoupledTerrain } from '../generator/pipeline/coupledEpoch'
import { replayRuns, type ReplayOptions, type ReplayPlan } from '../generator/pipeline/replayRuns'
import type { PlateSimulation } from '../generator/tectonics/plateSimulation'
import { mantleDiffusionFromVigour, seaLevelOffsetFromWater, weatherParamsFrom } from './runParams'
import type { WorldHistory } from './save/worldHistory'

// A WORLD MADE AGAIN FROM ITS RECIPE (docs/decisions/detail-ladder.md,
// fork 2): the seed and the `history:` block's runs, turned into run
// parameters (runParams.ts) and made again by the generator's one replay
// loop (generator/pipeline/replayRuns.ts). At the
// history's own budget (HISTORY_DEFAULTS.budget, 4) it lands on the save's
// level 0 bit for bit (measured 2026-10-01); at budget 1 it is level 1, a
// sibling of the save with its outlines and its own valleys.
//
// Only the code that made the world can make it again: every run's code
// hash must be this code's (replayRefusal), else the replay refuses rather
// than bake a third world (confirmed 2026-10-01: no fallback).

export interface ReplayRecipe {
  seed: string
  width: number
  height: number
  history: WorldHistory
}

// Why a recipe cannot be replayed by `code`, or null when it can.
export function replayRefusal(history: WorldHistory, code: string): string | null {
  if (history.genesis.length === 0 || history.tectonics.length === 0) return 'the world records no history — make it again to refine it'
  for (const run of [...history.genesis, ...history.tectonics]) {
    if (run.code === '') return 'the world was made before its code was recorded — make it again to refine it'
    if (run.code !== code) return `the world was made by other code (${run.code}, this is ${code}) — make it again to refine it`
  }
  return null
}

export { restoreSnapshot, snapshotOf, type ReplayOptions, type ReplayPosition, type ReplaySnapshot } from '../generator/pipeline/replayRuns'

// The history as the generator's run parameters, the way the screen sends
// its own runs (runParams.ts).
export function planFromRecipe(recipe: ReplayRecipe): ReplayPlan {
  return {
    seed: recipe.seed,
    width: recipe.width,
    height: recipe.height,
    genesis: recipe.history.genesis.map((run) => ({
      epochs: run.epochs,
      diffusion: mantleDiffusionFromVigour(run.values['genesis.mantleVigour']),
      seaLevelOffset: seaLevelOffsetFromWater(run.values['genesis.water']),
    })),
    tectonics: recipe.history.tectonics.map((run) => ({
      epochs: run.epochs,
      controls: { alluvium: run.values['tectonics.alluvium'], rockContrast: run.values['tectonics.rockContrast'] },
      weather: weatherParamsFrom((path) => run.values[path]),
      ...(run.restored ? { restored: true } : {}),
    })),
  }
}

export async function replayHistory(recipe: ReplayRecipe, options: ReplayOptions): Promise<{ sim: PlateSimulation; terrain: CoupledTerrain }> {
  const out = await replayRuns(planFromRecipe(recipe), options)
  if (!out) throw new Error('the replay was cancelled')
  return out
}
