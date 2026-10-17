import type { CoupledTerrain } from '../generator/pipeline/coupledEpoch'
import { replayRuns, type ReplayOptions, type ReplayPlan } from '../generator/pipeline/replayRuns'
import type { PlateSimulation } from '../generator/tectonics/plateSimulation'
import { landShareFromControl, mantleDiffusionFromVigour, weatherParamsFrom } from './runParams'
import type { WorldHistory } from './save/worldHistory'
import { WORLD_PIPELINE } from './worldPipeline'

// A WORLD MADE AGAIN FROM ITS RECIPE (docs/decisions/detail-ladder.md,
// fork 2): the seed and the `history:` block's runs, turned into run
// parameters (runParams.ts) and made again by the generator's one replay
// loop (generator/pipeline/replayRuns.ts). At the
// history's own budget (HISTORY_DEFAULTS.budget, 4) it lands on the save's
// level 0 bit for bit (measured 2026-10-01); at budget 1 it is level 1, a
// sibling of the save with its outlines and its own valleys.
//
// Only the pipeline that made the world can make it again: the world's
// recorded pipeline must be this one's (replayRefusal, worldPipeline.ts),
// else the replay refuses rather than bake a third world.

export interface ReplayRecipe {
  seed: string
  width: number
  height: number
  // The world's shape, from its save's kind. Absent: the torus.
  shape?: 'torus' | 'sphere'
  history: WorldHistory
}

// Why a world cannot be replayed by this pipeline (worldPipeline.ts), or
// null when it can. `pipeline`: the one the world records.
export function replayRefusal(history: WorldHistory, pipeline: string): string | null {
  if (history.genesis.length === 0 || history.tectonics.length === 0) return 'the world records no history — make it again to refine it'
  if (pipeline === '') return 'no one pipeline made the world — make it again to refine it'
  if (pipeline !== WORLD_PIPELINE) return `the world was made by another pipeline (${pipeline}, this is ${WORLD_PIPELINE}) — make it again to refine it`
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
    ...(recipe.shape ? { shape: recipe.shape } : {}),
    genesis: recipe.history.genesis.map((run) => ({
      epochs: run.epochs,
      diffusion: mantleDiffusionFromVigour(run.values['genesis.mantleVigour']),
      landShare: landShareFromControl(run.values['genesis.landShare']),
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
