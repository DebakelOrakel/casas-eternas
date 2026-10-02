import { createArcheanSimulation } from '../archean/archeanState'
import { archeanStep, DEFAULT_ARCHEAN_PARAMS } from '../archean/archeanStep'
import { finalizeArchean } from '../archean/finalizeArchean'
import type { WeatherParams } from '../climate/weather'
import { TECTONIC_MA_PER_EPOCH } from '../core/worldTime'
import { meshRouting } from '../mesh/meshHydrology'
import type { PipelineOptions, WorkerLike } from '../surface/erosionEnginePool'
import type { ErosionControlsV2 } from '../surface/erosionForcingFields'
import { deserializePlateSimulation, serializePlateSimulation, type PlateSimulation, type PlateSimulationSnapshot } from '../tectonics/plateSimulation'
import { climateDueAt, createCoupledTerrain, decodeCoupledTerrain, encodeCoupledTerrain, HISTORY_DEFAULTS, stepCoupledEpoch, type CoupledTerrain } from './coupledEpoch'

// A WORLD'S RUNS MADE AGAIN (docs/decisions/detail-ladder.md, fork 2): the
// Archean's steps, the hand-over and the coupled epochs as direct calls,
// from run parameters — what the screen sends its own runs with. The world
// layer turns a save's history into these (world/replay.ts); the runtime
// replays a world it loaded (pipeline/runtime.ts, `replayRuns`); the job
// worker replays level 1. One loop for all three, so they make the same
// world.

export interface GenesisRun {
  epochs: number
  // The Archean's mantle diffusion and sea-level offset (runParams).
  diffusion: number
  seaLevelOffset: number
}

export interface TectonicsRun {
  epochs: number
  controls: ErosionControlsV2
  weather: WeatherParams
  // The run continued a world loaded from a save (worldHistory.ts).
  restored?: boolean
}

export interface ReplayPlan {
  seed: string
  width: number
  height: number
  genesis: GenesisRun[]
  tectonics: TectonicsRun[]
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
  // Asked between two epochs; true stops the replay, which then returns null.
  cancelled?: () => boolean
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

export async function replayRuns(plan: ReplayPlan, options: ReplayOptions): Promise<{ sim: PlateSimulation; terrain: CoupledTerrain } | null> {
  let sim: PlateSimulation
  let terrain: CoupledTerrain
  let start: ReplayPosition
  if (options.resume) {
    ;({ sim, terrain } = restoreSnapshot(options.resume.snapshot))
    start = options.resume.position
  } else {
    // The Archean, run by run, then the hand-over (the screen's
    // genesisInit, genesisStart and commit, as pipeline/runtime.ts does them).
    const archean = createArcheanSimulation(plan.seed, plan.width, plan.height, plan.genesis[0].seaLevelOffset)
    let params = DEFAULT_ARCHEAN_PARAMS
    for (const run of plan.genesis) {
      params = { ...params, diffusion: run.diffusion }
      archean.seaLevelOffset = run.seaLevelOffset
      for (let i = 0; i < run.epochs; i++) {
        if (options.cancelled?.()) return null
        archeanStep(archean, params)
      }
    }
    sim = finalizeArchean(archean)
    sim.epochMa = TECTONIC_MA_PER_EPOCH
    terrain = createCoupledTerrain(sim, options.budget)
    start = { run: 0, epoch: 0 }
  }
  const total = plan.tectonics.reduce((sum, run) => sum + run.epochs, 0)
  let done = plan.tectonics.slice(0, start.run).reduce((sum, run) => sum + run.epochs, 0) + start.epoch
  for (let r = start.run; r < plan.tectonics.length; r++) {
    const run = plan.tectonics[r]
    let epoch = r === start.run ? start.epoch : 0
    // A run on a world loaded from a save: the load, where it happened.
    if (run.restored && epoch === 0) ({ sim, terrain } = restoreSnapshot(snapshotOf(sim, terrain)))
    for (; epoch < run.epochs; epoch++) {
      if (options.cancelled?.()) return null
      const weather = run.weather
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
        controls: run.controls,
        weather,
        pool: options.pool,
      })
      done++
      options.onEpoch?.(done, total)
    }
  }
  return { sim, terrain }
}
