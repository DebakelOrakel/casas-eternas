import { createArcheanSimulation } from '../generator/archean/archeanState'
import { archeanStep, DEFAULT_ARCHEAN_PARAMS } from '../generator/archean/archeanStep'
import { finalizeArchean } from '../generator/archean/finalizeArchean'
import { TECTONIC_MA_PER_EPOCH } from '../generator/core/worldTime'
import { meshRouting } from '../generator/mesh/meshHydrology'
import { climateDueAt, createCoupledTerrain, decodeCoupledTerrain, encodeCoupledTerrain, HISTORY_DEFAULTS, stepCoupledEpoch, type CoupledTerrain } from '../generator/pipeline/coupledEpoch'
import type { PipelineOptions, WorkerLike } from '../generator/surface/erosionEnginePool'
import { deserializePlateSimulation, serializePlateSimulation, type PlateSimulation, type PlateSimulationSnapshot } from '../generator/tectonics/plateSimulation'
import { mantleDiffusionFromVigour, seaLevelOffsetFromWater, weatherParamsFrom } from './runParams'
import type { WorldHistory } from './save/worldHistory'

// A WORLD MADE AGAIN FROM ITS RECIPE (docs/decisions/detail-ladder.md,
// fork 2): the seed and the `history:` block's runs, in order, as direct
// calls — the Archean's steps, the hand-over, the coupled epochs. At the
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

// The world's state between two epochs, as bytes: what a load restores
// (the snapshot half of the save), and a replay's checkpoint.
export interface ReplaySnapshot {
  state: PlateSimulationSnapshot
  oceanAge: Float32Array
  mantle: Float32Array
  latticeAccumulated: Float32Array
  latticeLockedEpochs: Int16Array
  latticeLastClassCode: Int8Array
  mesh: { nodes: Float32Array; connectivity: Uint8Array; z: Float32Array; column: Uint8Array }
}

export function snapshotOf(sim: PlateSimulation, terrain: CoupledTerrain): ReplaySnapshot {
  return {
    state: serializePlateSimulation(sim),
    oceanAge: sim.oceanAge.slice(),
    mantle: sim.mantle.slice(),
    latticeAccumulated: sim.latticeAccumulated.slice(),
    latticeLockedEpochs: sim.latticeLockedEpochs.slice(),
    latticeLastClassCode: sim.latticeLastClassCode.slice(),
    mesh: encodeCoupledTerrain(terrain),
  }
}

// The state back, as the runtime restores a loaded world
// (pipeline/runtime.ts, the worldData handler): the weather cache and the
// ice are gone, the routing derived.
export function restoreSnapshot(snapshot: ReplaySnapshot): { sim: PlateSimulation; terrain: CoupledTerrain } {
  const sim = deserializePlateSimulation(snapshot.state, snapshot.oceanAge.slice(), snapshot.mantle.slice())
  if (snapshot.latticeAccumulated.length === sim.latticeAccumulated.length) {
    sim.latticeAccumulated.set(snapshot.latticeAccumulated)
    sim.latticeLockedEpochs.set(snapshot.latticeLockedEpochs)
    sim.latticeLastClassCode.set(snapshot.latticeLastClassCode)
  }
  const terrain = decodeCoupledTerrain(sim, snapshot.mesh)
  terrain.routing = meshRouting(terrain.mesh, terrain.z)
  return { sim, terrain }
}

// Where a replay stands: the tectonics run and the epochs done in it.
export interface ReplayPosition {
  run: number
  epoch: number
}

export interface ReplayOptions {
  // The density budget of the epochs: HISTORY_DEFAULTS.budget reproduces
  // level 0, 1 is level 1.
  budget: number
  pool?: { createWorker: () => WorkerLike } & PipelineOptions
  // Called after every epoch, with the epochs done and their total.
  onEpoch?: (done: number, total: number) => void
  // Where to continue from (a checkpoint), instead of the beginning.
  resume?: { position: ReplayPosition; snapshot: ReplaySnapshot }
  // Called between two epochs where a checkpoint taken now restores to the
  // same bytes: before an epoch that computes its climate anyway, as a
  // restore does (CoupledEpochOptions.climateEvery). The caller decides
  // whether to take one.
  onCheckpoint?: (position: ReplayPosition, take: () => ReplaySnapshot) => Promise<void> | void
}

export async function replayHistory(recipe: ReplayRecipe, options: ReplayOptions): Promise<{ sim: PlateSimulation; terrain: CoupledTerrain }> {
  const { history } = recipe
  let sim: PlateSimulation
  let terrain: CoupledTerrain
  let start: ReplayPosition
  if (options.resume) {
    ;({ sim, terrain } = restoreSnapshot(options.resume.snapshot))
    start = options.resume.position
  } else {
    // The Archean, run by run, then the hand-over (the screen's
    // genesisInit, genesisStart and commit, as pipeline/runtime.ts does them).
    const archean = createArcheanSimulation(recipe.seed, recipe.width, recipe.height, seaLevelOffsetFromWater(history.genesis[0].values['genesis.water']))
    let params = DEFAULT_ARCHEAN_PARAMS
    for (const run of history.genesis) {
      params = { ...params, diffusion: mantleDiffusionFromVigour(run.values['genesis.mantleVigour']) }
      archean.seaLevelOffset = seaLevelOffsetFromWater(run.values['genesis.water'])
      for (let i = 0; i < run.epochs; i++) archeanStep(archean, params)
    }
    sim = finalizeArchean(archean)
    sim.epochMa = TECTONIC_MA_PER_EPOCH
    terrain = createCoupledTerrain(sim, options.budget)
    start = { run: 0, epoch: 0 }
  }
  const total = history.tectonics.reduce((sum, run) => sum + run.epochs, 0)
  let done = history.tectonics.slice(0, start.run).reduce((sum, run) => sum + run.epochs, 0) + start.epoch
  for (let r = start.run; r < history.tectonics.length; r++) {
    const run = history.tectonics[r]
    const value = (path: string): number => run.values[path]
    let epoch = r === start.run ? start.epoch : 0
    // A run on a world loaded from a save: the load, where it happened.
    if (run.restored && epoch === 0) ({ sim, terrain } = restoreSnapshot(snapshotOf(sim, terrain)))
    for (; epoch < run.epochs; epoch++) {
      const weather = weatherParamsFrom(value)
      // A checkpoint restores like a load: it drops the weather, so the
      // next epoch computes its climate. Exact where that epoch computes
      // it anyway — after a load, on new parameters, or on the schedule.
      const fresh = climateDueAt(sim.epoch + 1, terrain.weather, JSON.stringify(weather), HISTORY_DEFAULTS.climateEvery)
      if (options.onCheckpoint && fresh && done > 0) {
        const s = sim
        const t = terrain
        await options.onCheckpoint({ run: r, epoch }, () => snapshotOf(s, t))
      }
      await stepCoupledEpoch(sim, terrain, {
        iterationsPerEpoch: HISTORY_DEFAULTS.iterationsPerEpoch,
        budget: options.budget,
        climateEvery: HISTORY_DEFAULTS.climateEvery,
        remeshEvery: HISTORY_DEFAULTS.remeshEvery,
        upliftScale: HISTORY_DEFAULTS.upliftScale,
        controls: { alluvium: value('tectonics.alluvium'), rockContrast: value('tectonics.rockContrast') },
        weather,
        pool: options.pool,
      })
      done++
      options.onEpoch?.(done, total)
    }
  }
  return { sim, terrain }
}
