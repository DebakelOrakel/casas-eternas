// THE PIPELINE MODULE of the job worker (workerContract.ts): what a task
// computes, for one pipeline version. Bundled by `make worker` into
// pipeline.mjs, with the native engine beside it (casas-generator.node), and
// put into the pipeline's release (.github/workflows/generator-release.yml).
// The host (jobWorker.ts) loads it in its compute thread and gives each
// task its io: the world's archive, the artifact store, the progress.
//
// WHAT COMPUTES. The Rust engine's native build (docs/decisions/rust-engine.md,
// fork 3: levels 1–3 run native): level 1's replay with its waters, the
// tile plan, the tile bakes. Everything around them is the browser's own
// modules: the save reader, the artifact encoder, the key derivation. An
// artifact carries a key derived from its inputs, so the engine must give
// the bytes TypeScript gave under the same key; engine/scripts/realWorld.mjs
// and realTiles.mjs compare it with a real world's artifacts.
//
// Nothing here talks to the relay or over HTTP itself, and nothing here may
// be imported by the host: the host of today runs the module of an older
// pipeline, so what the module holds must not be the host's too.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { availableParallelism } from 'node:os'
import { readWorldInputs } from '../src/world/save/loadWorldInputs'
import { WORLD_PIPELINE } from '../src/world/worldPipeline'
import { planFromRecipe, replayRefusal, type ReplayPosition, type ReplaySnapshot } from '../src/world/replay'
import { ecologyParamsFrom } from '../src/world/runParams'
import type { SavedField } from '../src/generator/fields/fieldMesh'
import { meshLevelStage, meshPipelineVersion, readMeshLevelArtifact, writeMeshLevelArtifact, type MeshLevelArtifact } from '../src/world/meshArtifacts'
import { meshTileArtifactInfo, meshTilePipelineVersion, meshTileStage, readMeshTileArtifact, writeMeshTileArtifact, type MeshTileArtifact } from '../src/world/meshTileArtifacts'
import { TILE_SPECS, tileSpec } from '../src/generator/mesh/meshTile'
import { domainOfKind } from '../src/generator/core/domain'
import { parentTilesOn, tileGridOn } from '../src/generator/mesh/tileLayout'
import { artifactKey } from '../src/storage/ArtifactStore'
import type { ArtifactKey, ArtifactStore } from '../src/storage/ArtifactStore'
import { loadNativeEngine, type EngineTileBaker, type NativeEngine, type TileBakeSave, type TilePiece, type UpstreamPiece } from './engineNative'
import { laps, type Laps } from './laps'
import { WORKER_CONTRACT, type PipelineIO, type PipelineTask, type PipelineVersion, type PlannedTask, type TaskOutcome } from './workerContract'

export const contract = WORKER_CONTRACT

export const version: PipelineVersion = {
  pipelineVersion: meshPipelineVersion(1),
  tilePipelineVersions: Object.fromEntries(Object.keys(TILE_SPECS).map((level) => [level, meshTilePipelineVersion(Number(level))])),
}

// THE ENGINE, the native build beside this module (`make worker` copies
// engine/dist/casas-generator.node there). Loaded once, in the compute thread,
// at the first task: --version loads the module without it.
let nativeEngine: NativeEngine | null = null
function engine(): NativeEngine {
  nativeEngine ??= loadNativeEngine(fileURLToPath(new URL('./casas-generator.node', import.meta.url)))
  return nativeEngine
}

// The pool's leaf blocks of the erosion, sized as the TypeScript pool's
// stencil threads were. ALWAYS given for a tile: the pooled engine is a
// scheme of its own, and a tile baked without it differs in the last bits
// under the same artifact key (the pooled result is the same for every
// split — measured 1+1 against 4+2, 2026-10-02).
function leafWorkers(): number {
  const cores = availableParallelism()
  return cores >= 8 ? 4 : cores >= 4 ? 2 : 1
}

// The pipeline version of every tile level, as the plan's report carries
// it: with the result's worldId, the key each planned tile is stored under,
// so the coordinator marks the tiles already stored done instead of
// handing them out (internal/modules/jobs/coordinator.go, storedTiles).
function tileVersionsOf(job: PipelineTask): Record<string, string> {
  return Object.fromEntries(Object.keys(TILE_SPECS).map((level) => [level, meshTilePipelineVersion(Number(level), job.erosionRounds)]))
}

type WorldInputs = NonNullable<Awaited<ReturnType<typeof readWorldInputs>>>

// What the module keeps between tasks (PipelineIO.cache): the worlds and
// the parent levels it has read, so tile after tile on one world reads them
// once.
// Least recently used out, a couple of each: a level of a real world is
// hundreds of megabytes.
//
// Worlds by path (a path names one revision) or by URL with the revision
// they were read at (the URL names the world, whose revision moves; asked
// again with If-None-Match, readWorld). Tiles — a level-3 tile's parents
// and a tile's upstream neighbours — by artifact key: an artifact under a
// key is the same bytes whoever wrote it, and one level-2 tile is the
// parent of about nine level-3 tiles (2026-10-02: every task read them
// again, and in a cluster read the 26 MB world again too).
interface JobCache {
  worlds: Map<string, { inputs: WorldInputs; etag: string | null }>
  levels: Map<string, { artifact: MeshLevelArtifact; baker?: EngineTileBaker }>
  tiles: Map<string, MeshTileArtifact>
}
const CACHED_WORLDS = 2
const CACHED_LEVELS = 2
// A level-3 tile reads up to four parents and two or three upstream tiles;
// a few rows of the plan's order fit. A large level-2 tile is ~3 MB.
const CACHED_TILES = 32
function remember<V>(cache: Map<string, V>, key: string, value: V, size: number): void {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > size) cache.delete(cache.keys().next().value as string)
}
function recall<V>(cache: Map<string, V>, key: string): V | undefined {
  const value = cache.get(key)
  if (value !== undefined) {
    cache.delete(key)
    cache.set(key, value)
  }
  return value
}

// One task, start to artifact (PipelineModule.runTask).
export async function runTask(task: PipelineTask, io: PipelineIO): Promise<TaskOutcome> {
  const clock = laps()
  const outcome = await runTaskTimed(task, io, clock, io.cache ? moduleCache : undefined)
  return { ...outcome, laps: clock.times }
}

const moduleCache: JobCache = { worlds: new Map(), levels: new Map(), tiles: new Map() }

async function runTaskTimed(job: PipelineTask, io: PipelineIO, clock: Laps, cache?: JobCache): Promise<TaskOutcome> {
  const onProgress = io.progress
  // A world that names one revision (a path) is cached as it is; one that
  // names the world (a URL) with its revision, and asked for again only if
  // the server holds a newer one (the host's readWorld).
  const worldKey = io.worldKey
  const held = worldKey && cache ? recall(cache.worlds, worldKey) : undefined
  let inputs: WorldInputs | undefined = held && io.revisioned ? held.inputs : undefined
  if (!inputs) {
    if (job.stage === 1) onProgress('read', 0)
    const read = await io.readWorld(held?.etag ?? undefined)
    if (read === 'unchanged') inputs = held!.inputs
    else {
      if (!read) throw new Error('cannot read the world')
      const parsed = await readWorldInputs(read.archive, engine())
      if (!parsed) throw new Error('not a readable world archive')
      inputs = parsed
      // By URL only with a revision to ask with; without one it is read again.
      if (worldKey && cache && (io.revisioned || read.etag)) remember(cache.worlds, worldKey, { inputs, etag: read.etag }, CACHED_WORLDS)
    }
  }
  clock.lap('world')
  const store = io.store(inputs.worldUid)
  if (job.stage !== 1 && TILE_SPECS[job.stage]) return bakeTile(job, inputs, store, onProgress, clock, cache)
  if (job.stage !== 1) throw new Error(`stage ${job.stage}: no such level`)
  const started = Date.now()
  const pipelineVersion = meshPipelineVersion(1, job.erosionRounds)
  const key = artifactKey(inputs.worldId, pipelineVersion, meshLevelStage(1))
  if (job.reuse) {
    onProgress('read', 0)
    const stored = await readMeshLevelArtifact(store, key, engine())
    clock.lap('check')
    if (stored) {
      if (cache) remember(cache.levels, `${key.worldId}/${key.pipelineVersion}`, { artifact: stored.artifact }, CACHED_LEVELS)
      onProgress('plan', 0)
      const tasks = planOf(inputs, stored.artifact)
      clock.lap('plan')
      return {
        result: { worldId: key.worldId, pipelineVersion, stage: key.stage, width: 0, height: 0, nodes: stored.artifact.count, durationMs: stored.bakeMs },
        tasks,
        tileVersions: tileVersionsOf(job),
      }
    }
  }
  const { artifact, earlierMs } = await replayLevel(job, inputs, onProgress, started)
  clock.lap('replay')
  // The bake's time over every run of it: a worker that took the task over
  // at a checkpoint adds the time of the runs before (2026-10-22; until
  // then a take-over's bakeMs was its own run's only).
  const durationMs = earlierMs + Date.now() - started
  onProgress('store', 0)
  if (!(await writeMeshLevelArtifact(store, key, engine(), artifact, durationMs, inputs.seedText, job.erosionRounds))) throw new Error('could not write the artifact')
  clock.lap('write')
  if (cache) remember(cache.levels, `${key.worldId}/${key.pipelineVersion}`, { artifact }, CACHED_LEVELS)
  if (job.checkpointDir) await rm(checkpointPath(job.checkpointDir, inputs), { recursive: true, force: true })
  // The plan's phase stays on show until the tile levels' rows appear: it
  // covers the coordinator's check of the stored tiles too.
  onProgress('plan', 0)
  const tasks = planOf(inputs, artifact)
  clock.lap('plan')
  return {
    result: { worldId: key.worldId, pipelineVersion, stage: key.stage, width: 0, height: 0, nodes: artifact.count, durationMs },
    tasks,
    tileVersions: tileVersionsOf(job),
  }
}

// The tile levels' plan as the coordinator reads it (coordinator.go,
// plannedTask): each tile, what it waits for as [level, x, y], and its
// upstream tiles. From the level-1 ARTIFACT, decoded and routed, so a
// level computed now and one read back plan alike.
// The world's shape as the generator's Domain names it.
const shapeOf = (inputs: WorldInputs): 'torus' | 'sphere' => (inputs.kind === 'SphereWorld' ? 'sphere' : 'torus')

function planOf(inputs: WorldInputs, artifact: MeshLevelArtifact): PlannedTask[] {
  // The engine finds the land tiles on the save's raster itself (DEC-0044,
  // fork 7b).
  const plan = engine().planTiles(artifact, tileBakeSave(inputs))
  return plan.map((p) => ({
    level: p.tile.level, x: p.tile.x, y: p.tile.y,
    after: [...p.parents, ...p.upstream].map((t) => [t.level, t.x, t.y] as [number, number, number]),
    upstream: p.upstream.map((t) => ({ x: t.x, y: t.y })),
  }))
}

// LEVEL 1 BY REPLAY (docs/decisions/detail-ladder.md, fork 2): the world's
// history made again at level 1's budget, its waters derived on the
// result. Two phases:
//   history  — the replay at level 1's budget, with checkpoints;
//   hydrology — the stages a load runs in the generator, on the world at
//               the replay's end: the render, the climate, the save's
//               refinement, the hydrology, the ecology under the save's
//               sliders; then the level's artifact with its land and
//               ecology fields (docs/decisions/level-waters.md). The
//               waters so come from the save's climate, the one its tiles'
//               waters are derived from; until 2026-10-25 from the last
//               epoch's, with no land fields.
// Refused, not approximated, where the world's pipeline is not this
// bundle's (world/worldPipeline.ts). Until 2026-10-17 a first phase
// replayed the history at its own budget and compared it with the save,
// because the world recorded a hash of the source files, which said
// nothing about the simulation; the pipeline says it.
// `started` is when this run began; the answer's `earlierMs` is what the
// runs before it took, from the checkpoint it resumed.
async function replayLevel(job: PipelineTask, inputs: WorldInputs, onProgress: (phase: string, fraction: number) => void, started: number): Promise<{ artifact: MeshLevelArtifact; earlierMs: number }> {
  const refusal = replayRefusal(inputs.history, inputs.pipeline)
  if (refusal) throw new Error(refusal)
  if (!inputs.mesh) throw new Error('the world carries no mesh — make it again to refine it')
  const recipe = { seed: inputs.seedText, width: inputs.width, height: inputs.height, shape: shapeOf(inputs), history: inputs.history }
  const dir = job.checkpointDir ? checkpointPath(job.checkpointDir, inputs) : null
  const resume = dir ? await readCheckpoint(dir) : null
  onProgress('history', 0)
  let lastCheckpoint = resume?.done ?? 0
  const earlierMs = resume?.elapsedMs ?? 0
  // The level's waters need the save's refinement and the last run's
  // weather (the hydrology below): refused before the hours of the replay.
  if (!inputs.refined) throw new Error('the world carries no refined climate — run its climate step to refine it')
  const values = inputs.values
  if (!values) throw new Error('the world\'s spec cannot be read')
  const recipePlan = planFromRecipe(recipe)
  const weather = recipePlan.tectonics[recipePlan.tectonics.length - 1]?.weather
  if (!weather) throw new Error('the world carries no tectonic run')
  const replay = engine().Replay.start(recipePlan, 1, resume ? { position: resume.position, snapshot: resume.snapshot } : null, job.pool === false ? null : leafWorkers())
  // One epoch a call. Between two, the thread takes its messages (a fresh
  // token) and the checkpoint is written where one restores exactly.
  for (;;) {
    const { done } = replay.progress()
    if (dir && done - lastCheckpoint >= CHECKPOINT_EVERY_EPOCHS) {
      const position = replay.checkpointDue()
      if (position) {
        await writeCheckpoint(dir, position, done, earlierMs + Date.now() - started, replay.snapshot())
        lastCheckpoint = done
      }
    }
    if (!replay.step()) break
    const after = replay.progress()
    onProgress('history', after.done / after.total)
    await new Promise((resolve) => setImmediate(resolve))
  }
  onProgress('hydrology', 0)
  // The climate under the last run's weather, as the history made the
  // world, then replaced by the save's refinement, as a load replaces it.
  const world = replay.world()
  world.render(1)
  world.climate(weather)
  world.refineClimate(inputs.refined)
  onProgress('hydrology', 0.5)
  world.hydrology(weather.planet ?? null)
  // The ecology under the save's sliders: its fields go into the level
  // whole, since a browser cannot hold the rule's state at level 1's size
  // (docs/decisions/level-waters.md, fork 2).
  world.ecology(ecologyParamsFrom((path) => values[path]))
  const level = world.levelArtifact(1)
  onProgress('hydrology', 1)
  return { artifact: level, earlierMs }
}

// CHECKPOINTS of level 1's replay: hours of one task, so a worker that dies
// leaves the state of an epoch for the one that takes the task over. Kept
// per world revision and code; written whole into a fresh directory, then
// renamed over the last, so a crash mid-write leaves the previous one.
// Every CHECKPOINT_EVERY_EPOCHS epochs (~10 min at level 1), and only where
// one restores exactly (world/replay.ts, onCheckpoint).
const CHECKPOINT_EVERY_EPOCHS = 10

function checkpointPath(root: string, inputs: WorldInputs): string {
  return join(root, `${inputs.worldUid || 'no-uid'}-${inputs.worldId}-${WORLD_PIPELINE}`)
}

const CHECKPOINT_ARRAYS = ['latticeAccumulated', 'latticeLockedEpochs', 'latticeLastClassCode'] as const
const CHECKPOINT_MESH = ['nodes', 'connectivity', 'z', 'column', 'ice'] as const

// `elapsedMs` is the bake's time up to it, over every run.
async function writeCheckpoint(dir: string, position: ReplayPosition, done: number, elapsedMs: number, snapshot: ReplaySnapshot): Promise<void> {
  const fresh = `${dir}.${randomUUID()}`
  await mkdir(fresh, { recursive: true })
  const bytes = (a: ArrayBufferView): Uint8Array => new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
  // The field meshes' values (the mantle's, the ocean age's) beside the
  // arrays, each mesh's identity in position.json.
  const mesh = (f: SavedField): { cells: number; spacingM: number } => ({ cells: f.cells, spacingM: f.spacingM })
  await writeFile(join(fresh, 'position.json'), JSON.stringify({ position, done, elapsedMs, mantle: mesh(snapshot.mantle), oceanAge: mesh(snapshot.oceanAge) }))
  await writeFile(join(fresh, 'mantle.bin'), bytes(snapshot.mantle.values))
  await writeFile(join(fresh, 'oceanAge.bin'), bytes(snapshot.oceanAge.values))
  await writeFile(join(fresh, 'state.json'), JSON.stringify(snapshot.state))
  for (const name of CHECKPOINT_ARRAYS) await writeFile(join(fresh, `${name}.bin`), bytes(snapshot[name]))
  for (const name of CHECKPOINT_MESH) await writeFile(join(fresh, `mesh.${name}.bin`), bytes(snapshot.mesh[name]))
  await rm(dir, { recursive: true, force: true })
  await rename(fresh, dir)
}

async function readCheckpoint(dir: string): Promise<{ position: ReplayPosition; done: number; elapsedMs: number; snapshot: ReplaySnapshot } | null> {
  try {
    type MeshId = { cells: number; spacingM: number }
    const { position, done, elapsedMs, mantle, oceanAge } = JSON.parse(await readFile(join(dir, 'position.json'), 'utf8')) as { position: ReplayPosition; done: number; elapsedMs?: number; mantle: MeshId; oceanAge: MeshId }
    const read = async (name: string): Promise<ArrayBuffer> => {
      const b = await readFile(join(dir, name))
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
    }
    const snapshot: ReplaySnapshot = {
      state: JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')),
      oceanAge: { values: new Float64Array(await read('oceanAge.bin')), cells: oceanAge.cells, spacingM: oceanAge.spacingM },
      mantle: { values: new Float64Array(await read('mantle.bin')), cells: mantle.cells, spacingM: mantle.spacingM },
      latticeAccumulated: new Float32Array(await read('latticeAccumulated.bin')),
      latticeLockedEpochs: new Int16Array(await read('latticeLockedEpochs.bin')),
      latticeLastClassCode: new Int8Array(await read('latticeLastClassCode.bin')),
      mesh: {
        nodes: new Float32Array(await read('mesh.nodes.bin')),
        connectivity: new Uint8Array(await read('mesh.connectivity.bin')),
        z: new Float32Array(await read('mesh.z.bin')),
        column: new Uint8Array(await read('mesh.column.bin')),
        // Absent in a checkpoint from before the ice was state: the read
        // throws, and the replay starts afresh.
        ice: new Float32Array(await read('mesh.ice.bin')),
      },
    }
    process.stderr.write(`resuming level 1 from epoch ${done} (${dir})\n`)
    return { position, done, elapsedMs: elapsedMs ?? 0, snapshot }
  } catch {
    return null
  }
}

// A stage past level 1: one tile of that level, built on its parent — level
// 1 for a level-2 tile, the level-2 tiles it overlaps for a level-3 tile —
// read from the same artifact store the tile is written to. Level 1 is
// read by every tile: its river graph brings the inflow, its surface the
// synthesis' relief.
async function bakeTile(job: PipelineTask, inputs: WorldInputs, store: ArtifactStore, onProgress: (phase: string, fraction: number) => void, clock: Laps, cache?: JobCache): Promise<TaskOutcome> {
  const spec = tileSpec(job.stage)
  const { cols, rows } = tileGridOn(domainOfKind(shapeOf(inputs), inputs.width, inputs.height), spec.level)
  if (!job.tile || !Number.isInteger(job.tile.x) || !Number.isInteger(job.tile.y) || job.tile.x < 0 || job.tile.y < 0 || job.tile.x >= cols || job.tile.y >= rows) {
    throw new Error(`stage ${job.stage} needs a tile inside the ${cols} × ${rows} grid`)
  }
  // Tiles bake on the pool's scheme only: without it the artifact would
  // differ under the same key (leafWorkers).
  if (job.pool === false) throw new Error('a tile bakes on the pool\'s scheme only — pool: false is for level 1')
  const tile = { level: spec.level, x: job.tile.x, y: job.tile.y }
  const started = Date.now()
  const pipelineVersion = meshTilePipelineVersion(spec.level, job.erosionRounds)
  const key = artifactKey(inputs.worldId, pipelineVersion, meshTileStage(tile))
  if (job.reuse) {
    const stored = await meshTileArtifactInfo(store, key)
    clock.lap('check')
    if (stored) return { result: { worldId: key.worldId, pipelineVersion, stage: key.stage, width: 0, height: 0, nodes: stored.nodes, durationMs: stored.bakeMs } }
  }
  onProgress('parent', 0)
  const parentKey = artifactKey(inputs.worldId, meshPipelineVersion(1, job.erosionRounds), meshLevelStage(1))
  const levelKey = `${parentKey.worldId}/${parentKey.pipelineVersion}`
  let level1 = cache ? recall(cache.levels, levelKey) : undefined
  if (!level1) {
    const read = await readMeshLevelArtifact(store, parentKey, engine())
    if (!read) throw new Error('level 1 of this world is not in the artifact store — refine the world first')
    level1 = { artifact: read.artifact }
    if (cache) remember(cache.levels, levelKey, level1, CACHED_LEVELS)
  }
  clock.lap('level1')
  // Opened once per worker, not once per tile: the engine holds level 1
  // decoded with its sampler, its river graph and the climate's field mesh.
  level1.baker ??= engine().TileBaker.open(level1.artifact, tileBakeSave(inputs), leafWorkers())
  clock.lap('open')
  let pieces: TilePiece[] | null = null
  if (spec.level !== 2) {
    // The level above's tiles this one overlaps; every one must be there —
    // the coordinator orders them first.
    // Read all at once, each a few round trips on a bucket; in order.
    const above = tileSpec(spec.level - 1)
    pieces = await Promise.all(parentTilesOn(tile, above, domainOfKind(shapeOf(inputs), inputs.width, inputs.height)).map(async (piece) => {
      const read = await readTile(store, artifactKey(inputs.worldId, meshTilePipelineVersion(above.level, job.erosionRounds), meshTileStage(piece)), cache)
      if (!read) throw new Error(`tile ${meshTileStage(piece)} of this world is not in the artifact store — the level above comes first`)
      return { tile: piece, count: read.count, nodes: read.nodes, z: read.z }
    }))
  }
  // The upstream tiles' outflow; each was computed first (it is a dep).
  const upstream: UpstreamPiece[] = await Promise.all((job.upstream ?? []).map(async (at) => {
    const up = { level: spec.level, x: at.x, y: at.y }
    const read = await readTile(store, artifactKey(inputs.worldId, pipelineVersion, meshTileStage(up)), cache)
    if (!read) throw new Error(`tile ${meshTileStage(up)} upstream of this one is not in the artifact store`)
    return { tile: up, count: read.count, nodes: read.nodes, outflow: read.outflow }
  }))
  onProgress('parent', 1)
  clock.lap('inputs')
  const artifact = level1.baker.bake(tile, pieces, upstream, job.erosionRounds)
  clock.lap('bake')
  const durationMs = Date.now() - started
  if (!(await writeMeshTileArtifact(store, key, engine(), artifact, durationMs, inputs.seedText, job.erosionRounds))) throw new Error('could not write the artifact')
  clock.lap('write')
  return { result: { worldId: key.worldId, pipelineVersion, stage: key.stage, width: 0, height: 0, nodes: artifact.count, durationMs } }
}

// The save as the bake and the plan read it (DEC-0044, fork 7b): its seed
// text and controls, and its own payloads; the engine derives the seeds,
// the forcing and the raster.
function tileBakeSave(inputs: WorldInputs): TileBakeSave {
  return {
    seed: inputs.seedText,
    width: inputs.width,
    height: inputs.height,
    shape: shapeOf(inputs),
    controls: { alluvium: inputs.erosionControls.alluvium, rockContrast: inputs.erosionControls.rockContrast },
    snapshot: inputs.snapshot ?? undefined,
    climate: inputs.climate ?? undefined,
    mesh: inputs.mesh ?? undefined,
  }
}

// A tile artifact, through the worker's cache when it has one.
async function readTile(store: ArtifactStore, key: ArtifactKey, cache?: JobCache): Promise<MeshTileArtifact | null> {
  const id = `${key.worldId}/${key.pipelineVersion}/${key.stage}`
  const held = cache ? recall(cache.tiles, id) : undefined
  if (held) return held
  const read = await readMeshTileArtifact(store, key, engine())
  if (!read) return null
  if (cache) remember(cache.tiles, id, read.artifact, CACHED_TILES)
  return read.artifact
}
