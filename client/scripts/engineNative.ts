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
import type { ReplayPlan, ReplayPosition, ReplaySnapshot } from '../src/generator/pipeline/replayPlan'
import type { TileId } from '../src/generator/mesh/meshTile'
import type { ClimateCellValues } from '../src/generator/climate/climatePoints'
import type { ErosionControlsV2 } from '../src/generator/surface/erosionForcingFields'
import type { PlateSimulationSnapshot } from '../src/generator/tectonics/plateSimulationTypes'
import type { SavedMesh } from '../src/generator/mesh/meshSerial'
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
  // The level from the replay's end, on the plan's width and its seed's
  // detail seed; the replay ends here. Its waters from `saved`, the save's
  // climate, when given; else from the last epoch's.
  level(saved?: ClimateCellValues | null): MeshLevelArtifact
}

// A world's save as the bake and the plan read it (DEC-0044, fork 7b):
// the seed text and the recipe's controls, and the save's own payloads as
// it holds them. The engine derives the seeds, the forcing and the raster.
export interface TileBakeSave {
  seed: string
  width: number
  height: number
  shape: Shape
  controls: ErosionControlsV2
  snapshot?: PlateSimulationSnapshot
  climate?: ClimateCellValues
  mesh?: SavedMesh
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

// A tile of the plan with what it waits for (the engine's `plan_tiles`).
export interface PlannedTile {
  tile: TileId
  // The tiles of the level above it overlaps (none for the first tile
  // level, whose parent is level 1).
  parents: TileId[]
  // The tiles of its own level whose outflow it reads.
  upstream: TileId[]
}

export interface NativeEngine extends Engine {
  Replay: {
    start(plan: ReplayPlan, level: number, resume?: { position: ReplayPosition; snapshot: ReplaySnapshot } | null, leafWorkers?: number | null): EngineReplay
  }
  // The tile levels' plan from level 1 and the save, whose raster says
  // which tiles hold land.
  planTiles(artifact: MeshLevelArtifact, save: TileBakeSave): PlannedTile[]
  TileBaker: {
    open(artifact: MeshLevelArtifact, save: TileBakeSave, leafWorkers: number | null): EngineTileBaker
  }
}

// The build at `path` (`make engine` writes engine/dist/casas-engine.node).
export function loadNativeEngine(path: string): NativeEngine {
  return createRequire(import.meta.url)(path) as NativeEngine
}
