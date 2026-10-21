import type { WeatherParams } from '../climate/weather'
import type { SavedField } from '../fields/fieldMesh'
import type { ErosionControlsV2 } from '../surface/erosionForcingFields'
import type { PlateSimulationSnapshot } from '../tectonics/plateSimulationTypes'

// A WORLD'S RUNS, AS THE ENGINE MAKES THEM AGAIN (docs/decisions/
// detail-ladder.md, fork 2; the engine's `Replay`, pipeline/engine.ts):
// the run parameters the screen sends its own runs with. The world layer
// turns a save's history into these (world/replay.ts); the runtime replays
// a world it loaded (pipeline/runtime.ts, `replayRuns`); the job worker
// replays level 1.

export interface GenesisRun {
  epochs: number
  // The Archean's mantle diffusion and land share target (runParams).
  diffusion: number
  landShare: number
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
  // The world's shape, from its save's kind. Absent: the torus.
  shape?: 'torus' | 'sphere'
  genesis: GenesisRun[]
  tectonics: TectonicsRun[]
}

// The world's state between two epochs, as bytes: what a load restores
// (the snapshot half of the save), and a replay's checkpoint.
export interface ReplaySnapshot {
  state: PlateSimulationSnapshot
  // The ocean age's and the mantle's field-mesh values, each with its
  // mesh's identity (SavedField).
  oceanAge: SavedField
  mantle: SavedField
  latticeAccumulated: Float32Array
  latticeLockedEpochs: Int16Array
  latticeLastClassCode: Int8Array
  mesh: { nodes: Float32Array; connectivity: Uint8Array; z: Float32Array; column: Uint8Array; ice: Float32Array }
}

// Where a replay stands: the tectonics run and the epochs done in it.
export interface ReplayPosition {
  run: number
  epoch: number
}
