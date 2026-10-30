// THE CONTRACT between the job worker's host and its pipeline module
// (docs/decisions/engine-releases.md, "The host and the pipeline").
//
// The host (jobWorker.ts → job-worker.mjs) is how a worker works: the
// relay, the tokens, the presence, the artifact store and the world over
// HTTP or a directory, the compute thread. It is always the newest. The
// pipeline module (workerPipeline.ts → pipeline.mjs, with its engine
// casas-generator.node beside it; or the incubator's, incubatorPipeline.ts →
// incubator.mjs) is what a task computes: the save's
// decoding, the replay, the tile plan and bakes, the artifact formats and
// their keys. It belongs to one pipeline version and is in that pipeline's
// release, so a host of today runs the pipeline of any release.
//
// This file is the whole surface between the two: types, and the one
// number. A change to anything here that an older module or host cannot
// read is a new WORKER_CONTRACT; a host refuses a module of another one.
// ArtifactStore (src/storage/ArtifactStore.ts) is part of it: the module
// reads and writes through the host's store.
import type { ArtifactStore } from '../src/storage/ArtifactStore'

export const WORKER_CONTRACT = 1

// What a pipeline module exports.
export interface PipelineModule {
  contract: number
  // The pipeline it is: the world's (`status.pipeline`) and each tile
  // level's. What `job-worker.mjs --version` reports.
  version: PipelineVersion
  // One task, start to artifact. Throws with the reason; an error that the
  // host's io threw comes through as it was thrown, so the host tells a
  // store that did not answer from the task's failure.
  runTask(task: PipelineTask, io: PipelineIO): Promise<TaskOutcome>
}

export interface PipelineVersion {
  pipelineVersion: string
  tilePipelineVersions: Record<string, string>
}

// The task as the pipeline reads it: the coordinator's spec without where
// things are (the host's) — internal/modules/jobs/spec.go.
export interface PipelineTask {
  // 1: level 1 by replay; 2, 3: one tile of that level (`tile`); 1 with
  // `history`: the history from an origin on level 1 (incubatorPipeline.ts).
  stage: number
  tile?: { x: number; y: number }
  // For a history: its origin's cell, the pipeline of its level 1 and step
  // 1's controls, each left out at its default (km, m).
  history?: { origin: number; level: string; reach?: number; seaLow?: number }
  // For a tile: the tiles of its level upstream of it, whose outflow it
  // reads.
  upstream?: { x: number; y: number }[]
  erosionRounds: number
  // A directory for level 1's checkpoints; none without it.
  checkpointDir?: string
  // Whether an artifact already in the store may stand for the result.
  reuse?: boolean
  // False: level 1 without the pool's leaf blocks (a manual run only).
  pool?: boolean
}

// What the host gives a task.
export interface PipelineIO {
  // The world's archive. `held` is the revision of a copy the module keeps;
  // the host answers 'unchanged' when it is still the current one. Null:
  // no such world.
  readWorld(held?: string): Promise<{ archive: Uint8Array; etag: string | null } | 'unchanged' | null>
  // Names the world for the module's cache: a path names one revision
  // (`revisioned`), a URL the world, whose revision moves. Null: no cache.
  worldKey: string | null
  revisioned: boolean
  // The artifact store, for the world of `worldUid` (the uid the save
  // holds; a server in the local mode records the terrain for it).
  store(worldUid: string): ArtifactStore
  // Progress, a phase and its fraction.
  progress(phase: string, fraction: number): void
  // Whether the module may keep what it read for the next task.
  cache: boolean
}

// What one task produced: the result line, for a level the tile levels'
// plan and their versions, and where the time went.
export interface TaskOutcome {
  result: { worldId: string; pipelineVersion: string; stage: string; width: number; height: number; nodes: number; durationMs: number }
  tasks?: PlannedTask[]
  tileVersions?: Record<string, string>
  laps?: Record<string, number>
}

// One tile of the tile levels' plan as the coordinator reads it
// (coordinator.go, plannedTask).
export interface PlannedTask {
  level: number
  x: number
  y: number
  after: [number, number, number][]
  upstream: { x: number; y: number }[]
}
