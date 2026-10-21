// The Rust engine's native build in Node (docs/decisions/rust-engine.md,
// fork 3: levels 1–3 run here): what both bindings give
// (src/generator/pipeline/engine.ts) and the job worker's classes, which
// only this build has. Their forms are the world layer's: a level and a
// tile as their artifacts hold them.
//
// The job worker (scripts/jobWorker.ts) computes on it, and the engine's
// smoke test loads it.
import { createRequire } from 'node:module'
import type { Engine, EngineReplay as Replay, Shape } from '../src/generator/pipeline/engine'
import type { ReplayPlan, ReplayPosition, ReplaySnapshot } from '../src/generator/pipeline/replayRuns'
import type { PlannedTile } from '../src/generator/pipeline/tilePlan'
import type { TileId } from '../src/generator/mesh/meshTile'
import type { ClimateCellValues } from '../src/generator/climate/climatePoints'
import type { ErosionControlsV2 } from '../src/generator/surface/erosionForcingFields'
import type { MeshLevelArtifact } from '../src/world/meshArtifacts'
import type { MeshTileArtifact } from '../src/world/meshTileArtifacts'

// A world's runs made again at a level's budget, one epoch at a time
// (`replayRuns`), so that the caller reports, writes the checkpoints and
// stops between two.
export interface EngineReplay extends Replay {
  // Where a checkpoint taken now restores to the same bytes, or null.
  checkpointDue(): ReplayPosition | null
  // A copy: it does not change with the epochs after it.
  snapshot(): ReplaySnapshot
  // The level from the replay's end; the replay ends here.
  level(width: number, detailSeed: number): MeshLevelArtifact
}

// The save's inputs as a tile bake reads them (`tileBakeInputs`).
export interface TileBakeSave {
  width: number
  height: number
  shape: Shape
  detailSeed: number
  lithoSeed: number
  controls: ErosionControlsV2
  // The erosion forcing on its grid (`coarseForcingFields`).
  uplift?: Float32Array
  erodibility?: Float32Array
  forcingResX: number
  forcingResY: number
  climate?: ClimateCellValues
}

// A tile of the level above, as its artifact holds it.
export type TilePiece = Pick<MeshTileArtifact, 'tile' | 'count' | 'nodes' | 'z'>
// A tile upstream, as its artifact holds it.
export type UpstreamPiece = Pick<MeshTileArtifact, 'tile' | 'count' | 'nodes' | 'outflow'>

// A worker's tile bakes on one world's level 1, held decoded with its
// sampler and river graph across the tiles, as the worker's cache holds
// them.
export interface EngineTileBaker {
  // A level-2 tile on level 1 (`pieces` null), a level-3 tile on the
  // level-2 tiles it overlaps.
  bake(tile: TileId, pieces: TilePiece[] | null, upstream: UpstreamPiece[], rounds: number): MeshTileArtifact
}

export interface NativeEngine extends Engine {
  Replay: {
    start(plan: ReplayPlan, level: number, resume?: { position: ReplayPosition; snapshot: ReplaySnapshot } | null, leafWorkers?: number | null): EngineReplay
  }
  // The tile levels' plan from level 1 and each level's land tiles
  // (`{ [level]: [[x, y], …] }`).
  planTiles(artifact: MeshLevelArtifact, width: number, height: number, shape: Shape, landTiles: Record<number, [number, number][]>): PlannedTile[]
  TileBaker: {
    open(artifact: MeshLevelArtifact, save: TileBakeSave, leafWorkers: number | null): EngineTileBaker
  }
}

// The build at `path` (`make engine` writes engine/dist/casas-engine.node).
export function loadNativeEngine(path: string): NativeEngine {
  return createRequire(import.meta.url)(path) as NativeEngine
}
