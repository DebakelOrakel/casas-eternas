// The server-side baker: one level bake or one tile, run in Node.
//
// Spawned by the Go server's `bake` module as a subprocess, one per job. It
// reads a saved world, refines its mesh to a finer level
// (pipeline/meshBakeStage) and writes the level into the artifact store's
// directory layout — after which the client finds it through the tiered store
// without knowing where it came from. (It baked the raster amplification's
// 4096²/8192² tiers until 2026-09-29.)
//
// WHAT COMPUTES. The Rust engine's native build (docs/decisions/rust-engine.md,
// fork 3: levels 1–3 run native), beside this bundle (`casas-engine.node`):
// level 1's replay with its waters, the tile plan, the tile bakes. Everything
// around them is the browser's own modules: the save reader, the artifact
// encoder, the key derivation. An artifact carries a key derived from its
// inputs, so the engine must give the bytes TypeScript gave under the same
// key; engine/scripts/realWorld.mjs and realTiles.mjs compare it with a real
// world's artifacts.
//
// WHY IT RUNS ON THE SERVER AT ALL: a level is large (level 1 of a real save
// is ~17 M nodes and 349 MB, 155 s single-threaded) — unremarkable for a
// Node process, too much for a browser tab.
//
// Bundled by `make worker` (npm run build:worker) and invoked as:
//   node job-worker.mjs '<job JSON>'
// with the job on argv and a one-line JSON result on stdout, so the Go side
// needs no framing beyond "read the last line".
import { readFile, mkdir, writeFile, rename, readdir, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker as NodeWorker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { availableParallelism, hostname } from 'node:os'
import { readWorldInputs } from '../src/world/save/loadWorldInputs'
import { WORLD_PIPELINE } from '../src/world/worldPipeline'
import { planFromRecipe, replayRefusal, type ReplayPosition, type ReplaySnapshot } from '../src/world/replay'
import type { SavedField } from '../src/generator/fields/fieldMesh'
import { meshLevelStage, meshPipelineVersion, readMeshLevelArtifact, writeMeshLevelArtifact, type MeshLevelArtifact } from '../src/world/meshArtifacts'
import { meshTileArtifactInfo, meshTilePipelineVersion, meshTileStage, readMeshTileArtifact, writeMeshTileArtifact, type MeshTileArtifact } from '../src/world/meshTileArtifacts'
import { TILE_SPECS, tileCorner, tileGrid, tileSpec, type TileSpec } from '../src/generator/mesh/meshTile'
import { domainOfKind, type Domain } from '../src/generator/core/domain'
import { cubeTileSamples } from '../src/generator/mesh/meshTileCube'
import { parentTilesOn, tileGridOn } from '../src/generator/mesh/tileLayout'
import { SHELF_BREAK } from '../src/generator/elevation/elevationScale'
import { connect, tokenAuthenticator } from '@nats-io/transport-node'
import { wsconnect } from '@nats-io/nats-core'
import { AckPolicy, jetstream, jetstreamManager, type JsMsg } from '@nats-io/jetstream'
import { loadNativeEngine, type EngineTileBaker, type NativeEngine, type TileBakeSave, type TilePiece, type UpstreamPiece } from './engineNative'
import { createHttpArtifactStore } from '../src/storage/HttpArtifactStore'
import { readWorld, WorldUnavailableError } from './readWorld'
import { artifactKey, ArtifactStoreUnavailableError, isOldKey } from '../src/storage/ArtifactStore'
import type { ArtifactHandle, ArtifactKey, ArtifactStore } from '../src/storage/ArtifactStore'

// Where the baker reads and writes. Two shapes, because the same bake runs in
// two places (docs/decisions/distributed-bake.md):
//
//   PATHS  a worker on the server's own machine, next to the files.
//   URLS   a worker in a pod of its own (the cluster's worker Deployment)
//          or outside the cluster, which cannot mount the server's
//          ReadWriteOnce volume and therefore must talk HTTP.
//
// Both go through the same bytes-at-a-path interface, so only the store
// implementation differs; nothing about the bake itself knows which it is.
interface Job {
  // Path to the saved world's .zip, when it is reachable as a file…
  worldZip?: string
  // …or its URL, when it is not. Exactly one of the two.
  worldUrl?: string
  // The level: 1 is the mesh bake's level 1 (ADAPTIVE_MESH_PLAN.md phase
  // 4.5), the save's mesh refined to twice the density and eroded for
  // `erosionRounds`; the artifact is the level (world/meshArtifacts.ts).
  // 2 is one tile of the top level (pipeline/meshTileBake, `tile` below;
  // world/meshTileArtifacts.ts).
  stage: number
  // The tile, for a stage with tiles (2, 3; docs/decisions/tile-jobs.md):
  // its column and row on the world's tile grid. Level 1 of the world must
  // be in the artifact store — the tile is built on it.
  tile?: { x: number; y: number }
  // For a tile: the tiles of its level upstream of it, whose outflow it
  // reads (the refine plan's flow edges, Spec.Upstream).
  upstream?: { x: number; y: number }[]
  erosionRounds: number
  // Root of the artifact store as a directory, for a MANUAL run without a
  // server (see `pool` below; the Go server never sends it since
  // 2026-10-16, DEC-0038)…
  artifactsDir?: string
  // …or the API base (e.g. "http://server:8080/v1"): what the server sends
  // every worker. The worker resolves there, asks for a write link per
  // file and commits; the bytes go to the link (HttpArtifactStore.ts).
  artifactsUrl?: string
  // Bearer token for that API, naming this one job.
  authToken?: string
  // This job's id, set by the coordinator: a serving worker reports its
  // progress on jobs.event.<jobId>, and a cancel names it. Absent for a
  // one-shot run, whose progress goes over its pipe.
  jobId?: string
  // The coordinator's task this is, when a serving worker pulled it from the
  // relay (internal/modules/jobs/coordinator.go): what it reports on
  // jobs.done.<taskId>.
  taskId?: string
  // Where level 1's replay keeps its checkpoints (internal/modules/jobs,
  // Spec.CheckpointDir); none without it.
  checkpointDir?: string
  // Whether an artifact already in the store may stand for the result
  // (the coordinator sets it for every task): its key names the inputs and
  // the pipeline version, so it is the one this job would write.
  reuse?: boolean
  // False replays level 1 without the pool's leaf blocks (leafWorkers). The
  // Go server never sets it; it exists for a MANUAL local run:
  //   node job-worker.mjs '{"worldZip":"…","stage":1,"erosionRounds":12,
  //                    "artifactsDir":"…","pool":false}'
  // Level 1 only: its history epochs agree with the pool bit for bit, a
  // tile's twelve rounds do not, and a tile refuses it.
  pool?: boolean
}

// The artifact store's resolve/read/write interface, backed by the
// filesystem — for a MANUAL run (`artifactsDir` in the job, see `pool`
// above). The server sends its workers an `artifactsUrl` only since
// 2026-10-16 (DEC-0038): its index is built at start and kept in memory,
// so an entry written here is seen by a server that opens this directory
// afterwards, not by one that runs on it.
//
// Implemented here rather than reusing the encoder's own writer because that
// is exactly the point of the interface: `writeMeshLevelArtifact` does the
// quantisation, the file naming and the meta-last ordering, and it does not
// care whether the bytes land in OPFS, over HTTP, or here.
// Each store directory's key index, for the life of the process.
const storeIndexes = new Map<string, { byKey: Map<string, string>; seen: Set<string> }>()

function createFsArtifactStore(root: string): ArtifactStore {
  // A name is at most a shallow relative path from our own writer — anything
  // else is refused rather than resolved.
  const safeName = (name: string): boolean => {
    const segments = name.split('/')
    return segments.length <= 4 && segments.every((s) => s.length > 0 && s !== '.' && s !== '..' && !s.includes('\\'))
  }

  // key → uid by each entry's meta.json — the same rule as every other
  // store: the meta is the truth, the directory name means nothing. Read
  // ONCE per directory and process (storeIndexes), then only the entries
  // added since: a serving worker resolves a handful of keys per task, and
  // a full read of every meta per resolve was ~0.3 s at 11 000 artifacts —
  // two and a half seconds of a level-3 tile (2026-10-02). A hit whose entry
  // has gone (evicted) is dropped and looked up again.
  const index = storeIndexes.get(root) ?? { byKey: new Map<string, string>(), seen: new Set<string>() }
  storeIndexes.set(root, index)
  const keyOf = (key: ArtifactKey): string => `${key.worldId}/${key.pipelineVersion}/${key.stage}`
  async function findByKey(key: ArtifactKey): Promise<string | null> {
    const id = keyOf(key)
    const held = index.byKey.get(id)
    if (held) {
      try {
        await stat(join(root, held, 'meta.json'))
        return held
      } catch {
        index.byKey.delete(id)
        index.seen.delete(held)
      }
    }
    let children: string[]
    try {
      children = await readdir(root)
    } catch {
      return null
    }
    for (const child of children) {
      if (index.seen.has(child)) continue
      try {
        const raw = await readFile(join(root, child, 'meta.json'), 'utf8')
        const meta = JSON.parse(raw) as { key?: ArtifactKey }
        // Not seen until its meta is there: an entry still being written
        // is read again on the next miss.
        index.seen.add(child)
        // A meta of the format before DEC-0039 (a world uid in the key) is
        // not read: its entry is junk to every store.
        if (meta.key && !isOldKey(meta.key) && !index.byKey.has(keyOf(meta.key))) index.byKey.set(keyOf(meta.key), child)
      } catch {
        continue
      }
    }
    return index.byKey.get(id) ?? null
  }

  return {
    async resolve(key: ArtifactKey, create: boolean): Promise<ArtifactHandle | null> {
      let uid = await findByKey(key)
      if (!uid) {
        if (!create) return null
        uid = randomUUID()
        try {
          await mkdir(join(root, uid), { recursive: true })
        } catch {
          return null
        }
        index.byKey.set(keyOf(key), uid)
        index.seen.add(uid)
      }
      // One nested level, as the OPFS store lists (the raster bake's family
      // members lived a directory down; the shape tiles may use).
      const files: string[] = []
      try {
        for (const entry of await readdir(join(root, uid), { withFileTypes: true })) {
          if (entry.name.startsWith('.tmp-')) continue
          if (entry.isFile()) files.push(entry.name)
          else if (entry.isDirectory()) {
            for (const inner of await readdir(join(root, uid, entry.name), { withFileTypes: true })) {
              if (inner.isFile() && !inner.name.startsWith('.tmp-')) files.push(`${entry.name}/${inner.name}`)
            }
          }
        }
        files.sort()
      } catch {
        // an empty, freshly minted entry
      }
      return { key, local: uid, files }
    },

    async read(handle: ArtifactHandle, name: string): Promise<ArrayBuffer | null> {
      if (!handle.local || !safeName(name)) return null
      try {
        const buffer = await readFile(join(root, handle.local, ...name.split('/')))
        return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
      } catch {
        return null
      }
    },

    async write(handle: ArtifactHandle, name: string, bytes: ArrayBuffer | ArrayBufferView): Promise<boolean> {
      if (!handle.local || !safeName(name)) return false
      const target = join(root, handle.local, ...name.split('/'))
      try {
        await mkdir(dirname(target), { recursive: true })
        const view = ArrayBuffer.isView(bytes)
          ? new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength)
          : new Uint8Array(bytes as ArrayBuffer)
        // Temp-then-rename, matching the Go store: a reader must see either
        // the old bytes or the new ones, never half a raster — and the server
        // may well be serving this entry while the bake writes it.
        const tmp = `${target}.tmp-${process.pid}`
        await writeFile(tmp, view)
        await rename(tmp, target)
        return true
      } catch {
        return false
      }
    },
  }
}

// This job's credentials, attached to every request it makes.
//
// Read at every request, not once: a worker serving the relay replaces the
// token while it holds a task (keepJobToken). Absent when the server checks
// nobody, in which case the header is omitted rather than sent empty.
function authorizedFetch(job: Job): (input: string, init?: RequestInit) => Promise<Response> {
  return (input, init = {}) => {
    if (!job.authToken) return fetch(input, init)
    const headers = { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${job.authToken}` }
    return fetch(input, { ...init, headers })
  }
}

// The one line that decides where a bake's output lands. Everything above it
// is identical in both deployments, which is the property worth protecting:
// the artifacts must be byte-identical wherever the bake ran.
function artifactStoreFor(job: Job, world: string): ArtifactStore | null {
  if (job.artifactsDir) return createFsArtifactStore(job.artifactsDir)
  if (job.artifactsUrl) {
    const base = job.artifactsUrl
    // By write link and commit: the bytes go to the bucket, not through
    // the server (DEC-0038, fork 7). The world goes with each resolve: a
    // server in the local mode records the terrain for it (DEC-0039).
    return createHttpArtifactStore({ resolveBase: async () => base, fetch: authorizedFetch(job), uploads: 'links', world })
  }
  return null
}

// THE JOB TOKEN, KEPT FRESH (internal/modules/jobs/coordinator.go,
// handleToken): the token a task carries holds an hour from when the task
// was handed out, and a task can wait longer than that and run for hours.
// So a worker asks for a fresh one on jobs.token.<taskId> when it starts the
// task and again at half its life, and puts it into the job, where every
// request reads it. The coordinator answers only while the task and its job
// are open. Refused or unanswered, the worker asks again in a minute while
// the token in hand still holds: a refusal can pass (a coordinator just
// restarted answers "not open" until it has reconciled its tasks, a signing
// hiccup "cannot issue"), and one that does not is a cancelled job, whose
// cancel ends the task and with it the asking. Until 2026-10-04 a refusal
// stopped the asking for good. Answers the stop.
type Relay = Awaited<ReturnType<typeof connect>>
const TOKEN_RETRY_MS = 60_000
async function keepJobToken(nc: Relay, job: Job, taskId: string, onFresh?: (token: string) => void): Promise<() => void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const again = (ms: number): void => {
    if (!stopped) timer = setTimeout(() => void ask(), ms)
  }
  const ask = async (): Promise<void> => {
    try {
      const reply = await nc.request(`jobs.token.${taskId}`, '', { timeout: 10_000 })
      const answer = JSON.parse(reply.string()) as { token?: string; expiresAt?: string; error?: string }
      if (answer.token) {
        job.authToken = answer.token
        onFresh?.(answer.token)
        again(Math.max(TOKEN_RETRY_MS, (Date.parse(answer.expiresAt ?? '') - Date.now()) / 2))
        return
      }
      process.stderr.write(`task ${taskId}: no fresh token: ${answer.error ?? 'no answer'}\n`)
      again(TOKEN_RETRY_MS)
    } catch (error) {
      process.stderr.write(`task ${taskId}: token request: ${error instanceof Error ? error.message : String(error)}\n`)
      again(TOKEN_RETRY_MS)
    }
  }
  await ask()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

// THE ENGINE, the native build beside this bundle (`make worker` copies
// engine/dist/casas-engine.node there). Loaded once, in the compute thread.
let nativeEngine: NativeEngine | null = null
function engine(): NativeEngine {
  nativeEngine ??= loadNativeEngine(fileURLToPath(new URL('./casas-engine.node', import.meta.url)))
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

async function main(): Promise<void> {
  const raw = process.argv[2]

  // `--version` reports which pipeline this bundle IS, without running one.
  //
  // Not a courtesy: the artifact key carries a pipeline version, and a baker
  // built from a different commit than the client expecting its output fails
  // SILENTLY — bakes succeed, artifacts appear, and nobody ever looks for
  // them. That happened once. This makes an image's pipeline version something
  // you can read off it in a second rather than infer from a missing cache hit.
  if (raw === '--version') {
    process.stdout.write(`${JSON.stringify({ pipelineVersion: meshPipelineVersion(1), tilePipelineVersions: Object.fromEntries(Object.keys(TILE_SPECS).map((level) => [level, meshTilePipelineVersion(Number(level))])) })}\n`)
    return
  }
  if (raw === '--serve') {
    let config: ServeConfig
    try {
      config = JSON.parse(process.argv[3] ?? '') as ServeConfig
    } catch {
      return fail('--serve needs its configuration as JSON: {"relay": "nats://…", "pools": ["level", "tile"]}')
    }
    return serve(config)
  }
  if (!raw) fail('usage: job-worker.mjs \'<job JSON>\'  |  job-worker.mjs --serve \'<config JSON>\'  |  job-worker.mjs --version')
  let job: Job
  try {
    job = JSON.parse(raw) as Job
  } catch {
    return fail('job argument is not JSON')
  }

  try {
    const outcome = await computeThread().run(job, stderrProgress(), false)
    process.stderr.write(`${JSON.stringify({ ms: outcome.laps })}\n`)
    process.stdout.write(`${JSON.stringify(outcome.result)}\n`)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

// Progress on stderr, one line per whole percent: the Go side surfaces it as
// job status, and keeping stdout clean means the result stays one parseable
// line no matter how chatty the pipeline gets.
function stderrProgress(): (phase: string, fraction: number) => void {
  let last = ''
  return (phase, fraction) => {
    const percent = Math.floor(fraction * 100)
    // A new phase is said even at the same percent.
    if (`${phase}:${percent}` === last) return
    last = `${phase}:${percent}`
    process.stderr.write(`${JSON.stringify({ phase, percent })}\n`)
  }
}

// WHERE A TASK'S TIME GOES, for the jobs' wall time (the profiling of
// 2026-10-21): the milliseconds since the last lap under each phase's name,
// summed where a name comes again. The worker writes them per task to
// stderr, which the server logs; nothing of it goes to the coordinator.
interface Laps {
  lap: (name: string) => void
  times: Record<string, number>
}
function laps(): Laps {
  let last = performance.now()
  const times: Record<string, number> = {}
  return {
    times,
    lap: (name) => {
      const now = performance.now()
      times[name] = (times[name] ?? 0) + Math.round(now - last)
      last = now
    },
  }
}

// What one job produced: the result line the Go side reads, and for a level
// the tile levels' plan (a refine plan grows it, coordinator.go).
interface JobOutcome {
  result: { worldId: string; pipelineVersion: string; stage: string; width: number; height: number; nodes: number; durationMs: number }
  tasks?: PlannedTask[]
  // With a plan: each tile level's pipeline version, by level — with the
  // result's worldId, the key each planned tile is stored under, so the
  // coordinator marks the tiles already stored done instead of handing them
  // out (internal/modules/jobs/coordinator.go, storedTiles).
  tileVersions?: Record<string, string>
  // Where its time went (Laps), for the log.
  laps?: Record<string, number>
}

// The pipeline version of every tile level, as the plan's report carries it.
function tileVersionsOf(job: Job): Record<string, string> {
  return Object.fromEntries(Object.keys(TILE_SPECS).map((level) => [level, meshTilePipelineVersion(Number(level), job.erosionRounds)]))
}

type WorldInputs = NonNullable<Awaited<ReturnType<typeof readWorldInputs>>>

// What a serving worker keeps between tasks: the worlds and the parent
// levels it has read, so tile after tile on one world reads them once.
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

// One job, start to artifact. Throws with the reason instead of exiting, so
// a serving worker can report it and go on to the next task.
async function runJob(job: Job, onProgress: (phase: string, fraction: number) => void, cache?: JobCache): Promise<JobOutcome> {
  const clock = laps()
  const outcome = await runJobTimed(job, onProgress, clock, cache)
  return { ...outcome, laps: clock.times }
}

async function runJobTimed(job: Job, onProgress: (phase: string, fraction: number) => void, clock: Laps, cache?: JobCache): Promise<JobOutcome> {
  // A world read from a file is cached by its path, which names one
  // revision; one fetched by URL with its revision, and asked for again
  // only if the server holds a newer one (readWorld).
  const worldKey = job.worldZip ?? job.worldUrl
  const held = worldKey && cache ? recall(cache.worlds, worldKey) : undefined
  let inputs: WorldInputs | undefined = held && job.worldZip ? held.inputs : undefined
  if (!inputs) {
    if (job.stage === 1) onProgress('read', 0)
    const read = await readWorld(job, authorizedFetch(job), held?.etag ?? undefined)
    if (read === 'unchanged') inputs = held!.inputs
    else {
      if (!read) throw new Error(`cannot read the world (${job.worldZip ?? job.worldUrl ?? 'no source given'})`)
      const parsed = await readWorldInputs(read.archive)
      if (!parsed) throw new Error('not a readable world archive')
      inputs = parsed
      // By URL only with a revision to ask with; without one it is read again.
      if (worldKey && cache && (job.worldZip || read.etag)) remember(cache.worlds, worldKey, { inputs, etag: read.etag }, CACHED_WORLDS)
    }
  }
  clock.lap('world')
  const store = artifactStoreFor(job, inputs.worldUid)
  if (!store) throw new Error('neither artifactsDir nor artifactsUrl was given')
  if (job.stage !== 1 && TILE_SPECS[job.stage]) return bakeTile(job, inputs, store, onProgress, clock, cache)
  if (job.stage !== 1) throw new Error(`stage ${job.stage}: no such level`)
  const started = Date.now()
  const pipelineVersion = meshPipelineVersion(1, job.erosionRounds)
  const key = artifactKey(inputs.worldId, pipelineVersion, meshLevelStage(1))
  if (job.reuse) {
    onProgress('read', 0)
    const stored = await readMeshLevelArtifact(store, key)
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
  const artifact = await replayLevel(job, inputs, onProgress)
  clock.lap('replay')
  const durationMs = Date.now() - started
  onProgress('store', 0)
  if (!(await writeMeshLevelArtifact(store, key, artifact, durationMs, inputs.seedText, job.erosionRounds))) throw new Error('could not write the artifact')
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
interface PlannedTask {
  level: number
  x: number
  y: number
  after: [number, number, number][]
  upstream: { x: number; y: number }[]
}
// The world's shape as the generator's Domain names it.
const shapeOf = (inputs: WorldInputs): 'torus' | 'sphere' => (inputs.kind === 'SphereWorld' ? 'sphere' : 'torus')

function planOf(inputs: WorldInputs, artifact: MeshLevelArtifact): PlannedTask[] {
  const shape = shapeOf(inputs)
  const domain = domainOfKind(shape, inputs.width, inputs.height)
  const land = Object.fromEntries(Object.keys(TILE_SPECS).map(Number).map((level) => [level, shape === 'sphere' ? cubeLandTiles(inputs, domain, tileSpec(level)) : landTiles(inputs, tileSpec(level))]))
  const plan = engine().planTiles(artifact, inputs.width, inputs.height, shape, land)
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
//   hydrology — the level's waters from its last epoch's climate.
// Refused, not approximated, where the world's pipeline is not this
// bundle's (world/worldPipeline.ts). Until 2026-10-17 a first phase
// replayed the history at its own budget and compared it with the save,
// because the world recorded a hash of the source files, which said
// nothing about the simulation; the pipeline says it.
async function replayLevel(job: Job, inputs: WorldInputs, onProgress: (phase: string, fraction: number) => void): Promise<MeshLevelArtifact> {
  const refusal = replayRefusal(inputs.history, inputs.pipeline)
  if (refusal) throw new Error(refusal)
  if (!inputs.mesh) throw new Error('the world carries no mesh — make it again to refine it')
  const recipe = { seed: inputs.seedText, width: inputs.width, height: inputs.height, shape: shapeOf(inputs), history: inputs.history }
  const dir = job.checkpointDir ? checkpointPath(job.checkpointDir, inputs) : null
  const resume = dir ? await readCheckpoint(dir) : null
  onProgress('history', 0)
  let lastCheckpoint = resume?.done ?? 0
  const replay = engine().Replay.start(planFromRecipe(recipe), 1, resume ? { position: resume.position, snapshot: resume.snapshot } : null, job.pool === false ? null : leafWorkers())
  // One epoch a call. Between two, the thread takes its messages (a fresh
  // token) and the checkpoint is written where one restores exactly.
  for (;;) {
    const { done } = replay.progress()
    if (dir && done - lastCheckpoint >= CHECKPOINT_EVERY_EPOCHS) {
      const position = replay.checkpointDue()
      if (position) {
        await writeCheckpoint(dir, position, done, replay.snapshot())
        lastCheckpoint = done
      }
    }
    if (!replay.step()) break
    const after = replay.progress()
    onProgress('history', after.done / after.total)
    await new Promise((resolve) => setImmediate(resolve))
  }
  onProgress('hydrology', 0)
  const level = replay.level(inputs.width, inputs.detailSeed)
  onProgress('hydrology', 1)
  return level
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

async function writeCheckpoint(dir: string, position: ReplayPosition, done: number, snapshot: ReplaySnapshot): Promise<void> {
  const fresh = `${dir}.${randomUUID()}`
  await mkdir(fresh, { recursive: true })
  const bytes = (a: ArrayBufferView): Uint8Array => new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
  // The field meshes' values (the mantle's, the ocean age's) beside the
  // arrays, each mesh's identity in position.json.
  const mesh = (f: SavedField): { cells: number; spacingM: number } => ({ cells: f.cells, spacingM: f.spacingM })
  await writeFile(join(fresh, 'position.json'), JSON.stringify({ position, done, mantle: mesh(snapshot.mantle), oceanAge: mesh(snapshot.oceanAge) }))
  await writeFile(join(fresh, 'mantle.bin'), bytes(snapshot.mantle.values))
  await writeFile(join(fresh, 'oceanAge.bin'), bytes(snapshot.oceanAge.values))
  await writeFile(join(fresh, 'state.json'), JSON.stringify(snapshot.state))
  for (const name of CHECKPOINT_ARRAYS) await writeFile(join(fresh, `${name}.bin`), bytes(snapshot[name]))
  for (const name of CHECKPOINT_MESH) await writeFile(join(fresh, `mesh.${name}.bin`), bytes(snapshot.mesh[name]))
  await rm(dir, { recursive: true, force: true })
  await rename(fresh, dir)
}

async function readCheckpoint(dir: string): Promise<{ position: ReplayPosition; done: number; snapshot: ReplaySnapshot } | null> {
  try {
    type MeshId = { cells: number; spacingM: number }
    const { position, done, mantle, oceanAge } = JSON.parse(await readFile(join(dir, 'position.json'), 'utf8')) as { position: ReplayPosition; done: number; mantle: MeshId; oceanAge: MeshId }
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
    return { position, done, snapshot }
  } catch {
    return null
  }
}

// A level's tiles that hold land or shelf — every tile with a cell of the
// save's raster above the shelf break. What a refine plan computes past
// level 1; the deep ocean has no relief to refine.
function landTiles(inputs: WorldInputs, spec: TileSpec): [number, number][] {
  const { width, height } = inputs
  const { cols, rows } = tileGrid(width, height, spec)
  const out: [number, number][] = []
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const corner = tileCorner({ level: spec.level, x: tx, y: ty }, spec)
      let found = false
      for (let dy = 0; dy < spec.cells && !found; dy++) {
        const y = (corner.y + dy) % height
        for (let dx = 0; dx < spec.cells; dx++) {
          if (inputs.elevations[y * width + (corner.x + dx) % width] > SHELF_BREAK) {
            found = true
            break
          }
        }
      }
      if (found) out.push([tx, ty])
    }
  }
  return out
}

// The sphere's land tiles (landTiles' rule on the cube atlas): every tile
// with a sample of the save's raster above the shelf break, the samples a
// grid of cells × cells over the tile.
function cubeLandTiles(inputs: WorldInputs, world: Domain, spec: TileSpec): [number, number][] {
  const { width, height } = inputs
  const out: [number, number][] = []
  cubeTileSamples(world, spec.level, spec.cells, (tile, xs, ys) => {
    for (let k = 0; k < xs.length; k++) {
      const x = Math.min(width - 1, Math.floor(xs[k]))
      const y = Math.min(height - 1, Math.max(0, Math.floor(ys[k])))
      if (inputs.elevations[y * width + x] > SHELF_BREAK) {
        out.push([tile.x, tile.y])
        return
      }
    }
  })
  return out
}

// A stage past level 1: one tile of that level, built on its parent — level
// 1 for a level-2 tile, the level-2 tiles it overlaps for a level-3 tile —
// read from the same artifact store the tile is written to. Level 1 is
// read by every tile: its river graph brings the inflow, its surface the
// synthesis' relief.
async function bakeTile(job: Job, inputs: WorldInputs, store: ArtifactStore, onProgress: (phase: string, fraction: number) => void, clock: Laps, cache?: JobCache): Promise<JobOutcome> {
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
    const read = await readMeshLevelArtifact(store, parentKey)
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
  if (!(await writeMeshTileArtifact(store, key, artifact, durationMs, inputs.seedText, job.erosionRounds))) throw new Error('could not write the artifact')
  clock.lap('write')
  return { result: { worldId: key.worldId, pipelineVersion, stage: key.stage, width: 0, height: 0, nodes: artifact.count, durationMs } }
}

// The save's inputs a tile bake reads (world/bakeInputs.ts, tileBakeInputs).
function tileBakeSave(inputs: WorldInputs): TileBakeSave {
  return {
    width: inputs.width,
    height: inputs.height,
    shape: shapeOf(inputs),
    detailSeed: inputs.detailSeed,
    lithoSeed: inputs.lithoSeed,
    controls: { alluvium: inputs.erosionControls.alluvium, rockContrast: inputs.erosionControls.rockContrast },
    uplift: inputs.uplift?.data,
    erodibility: inputs.erodibility?.data,
    forcingResX: inputs.uplift?.resX ?? 0,
    forcingResY: inputs.uplift?.resY ?? 0,
    climate: inputs.climate ?? undefined,
  }
}

// A tile artifact, through the worker's cache when it has one.
async function readTile(store: ArtifactStore, key: ArtifactKey, cache?: JobCache): Promise<MeshTileArtifact | null> {
  const id = `${key.worldId}/${key.pipelineVersion}/${key.stage}`
  const held = cache ? recall(cache.tiles, id) : undefined
  if (held) return held
  const read = await readMeshTileArtifact(store, key)
  if (!read) return null
  if (cache) remember(cache.tiles, id, read.artifact, CACHED_TILES)
  return read.artifact
}

// SERVING (docs/decisions/detail-ladder.md, "Workers"): a long-lived
// worker pulls the coordinator's tasks from the relay, one at a time, and
// keeps what it read for the next (runJob's cache). The jobs module starts
// these and keeps them (internal/modules/jobs/workerpool.go).
//
// A task is the job argument the one-shot form takes, plus its task and job
// ids. Progress goes out on jobs.event.<jobId>, the outcome on
// jobs.done.<taskId> before the task is acknowledged — a worker that dies in
// between leaves the task to another, which is harmless, a task being pure.
interface ServeConfig {
  // The relay: `nats://host:port` inside the cluster, or
  // `wss://host/relay` for a worker outside it (the relay's WebSocket
  // listener, relay.websocket, behind the ingress).
  relay: string
  pools: string[]
  // The server's base URL, where a worker with a service account trades it
  // for a bus token (`/v1/auth/token`). Needed only with RELAY_CREDENTIALS.
  auth?: string
  // The server's base URL as this worker reaches it, for a worker outside
  // the cluster: a task names the world and the artifact store by the
  // server's address inside it (its pod IP), and the scheme, host and port of
  // both are replaced by this one's. Absent for a worker inside.
  api?: string
}

// A task's URL at the server's address as this worker reaches it
// (ServeConfig.api): its scheme, host and port replaced, its path kept.
// The port is set on its own: the `host` setter keeps the old port when the
// new host has none, and a task names the pod's :8080.
function overApi(url: string, api: string): string {
  const out = new URL(url)
  const base = new URL(api)
  out.protocol = base.protocol
  out.hostname = base.hostname
  out.port = base.port
  return out.href
}

// The bus credential (internal/modules/relay checks it where the server
// checks identity), from the environment — never the argv, where `ps` would
// show it:
// - RELAY_CREDENTIALS: the path of a file holding `<name>:<secret>`, a
//   service account's credential (`casas-eternas auth service add`). Traded
//   for a bus token at `<auth>/v1/auth/token`, and again when half of its
//   life is gone. The file is read at every trade, so a rotated Secret is
//   picked up without a restart. For workers in a cluster and outside one.
// - RELAY_TOKEN: a bus token as it is; the jobs module gives one to each
//   worker it starts itself (workerpool.go).
// - neither: the bus checks nobody.
// Answers the token to present at every (re)connect.
async function busToken(config: ServeConfig): Promise<(() => string) | undefined> {
  const file = process.env.RELAY_CREDENTIALS
  if (!file) {
    const token = process.env.RELAY_TOKEN
    return token ? () => token : undefined
  }
  if (!config.auth) fail('RELAY_CREDENTIALS needs "auth" in the serving configuration: the server to trade it at')
  let current = ''
  const trade = async (): Promise<number> => {
    const credential = (await readFile(file, 'utf8')).trim()
    const response = await fetch(`${config.auth!.replace(/\/$/, '')}/v1/auth/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(credential).toString('base64')}` },
    })
    if (!response.ok) throw new Error(`the token route answered ${response.status}`)
    const body = (await response.json()) as { token: string; expiresAt: string }
    current = body.token
    return Date.parse(body.expiresAt) - Date.now()
  }
  // Again at half the token's life; a failed trade is tried again in a
  // minute, while the token in hand still holds.
  const again = (ms: number): void => {
    setTimeout(() => {
      trade()
        .then((left) => again(left / 2))
        .catch((error: unknown) => {
          process.stderr.write(`bus token: ${error instanceof Error ? error.message : String(error)}\n`)
          again(60_000)
        })
    }, ms).unref()
  }
  try {
    again((await trade()) / 2)
  } catch (error) {
    fail(`bus token: ${error instanceof Error ? error.message : String(error)}`)
  }
  return () => current
}

// The relay's names for the jobs module's streams (internal/modules/jobs/streams.go).
// A consumer per pipeline: a worker takes only the tasks of its own
// (`jobs.task.<pool>.<pipeline>.<jobId>`, docs/decisions/engine-releases.md),
// and the consumers of a work queue must not overlap.
const TASK_STREAM = 'JOBS_TASKS'
const TASK_CONSUMER = `workers-${WORLD_PIPELINE}`
// How long a task may go unacknowledged before the relay hands it to
// another worker; the worker says it is still working well inside it.
const TASK_ACK_WAIT_MS = 5 * 60_000
const TASK_HEARTBEAT_MS = 30_000
const TASK_MAX_DELIVER = 5
// How long a pipeline's consumer stays when no worker asks it for a task:
// then the relay deletes it, so the consumers of past pipelines do not pile
// up. Its tasks stay in the stream until a consumer acknowledges them; one
// made again later hands them out from the start.
const TASK_CONSUMER_IDLE_MS = 24 * 60 * 60_000
// How long a task given back for an artifact store that did not answer
// waits before the relay hands it out again: long enough for a server
// restart, short against a task's minutes.
const TASK_RETRY_DELAY_MS = 15_000
// How often a worker says it is there (internal/modules/jobs/presence.go,
// presenceEvery): who it is, and what it computes.
const PRESENCE_EVERY_MS = 15_000

// The service account a worker proves itself with, as its credential file
// names it; empty for one of the jobs module's own pool.
async function accountName(): Promise<string> {
  const file = process.env.RELAY_CREDENTIALS
  if (!file) return ''
  const credential = (await readFile(file, 'utf8').catch(() => '')).trim()
  return credential.slice(0, Math.max(0, credential.indexOf(':')))
}

// THE COMPUTE THREAD: runJob runs in a worker thread of its own, and the
// main thread keeps only the bus — the task's heartbeat, the presence, the
// progress, the tokens. A computation holds its thread for long stretches
// without a pause: measured 2026-10-18 on a 23 MB world, 31.5 s at the start
// of a level-1 replay (the Archean and the level's terrain) and 9–20 s in
// each epoch, more on a slower core. On the main thread that silenced the
// presence (gone after 45 s), the pongs (the relay closes a connection after
// two pings of 30 s) and the heartbeat (after 5 min the relay gives the task
// to a second worker). The thread changes where the computation runs, not
// what it computes: the same runJob, the same engine, started from the
// thread. One thread for the process; it keeps the cache between tasks.
const COMPUTE_THREAD = 'casas-compute'

type ComputeRequest = { type: 'job'; job: Job; cached: boolean } | { type: 'token'; token: string }
type ComputeReply =
  | { type: 'progress'; phase: string; fraction: number }
  | { type: 'done'; outcome: JobOutcome }
  | { type: 'failed'; kind: ComputeFailure['kind']; message: string }

// A task's failure as the serve loop decides on it: `unavailable`, a store
// or world server that did not answer (the task goes back); `final`, the
// task's answer.
class ComputeFailure extends Error {
  readonly kind: 'unavailable' | 'final'
  constructor(kind: ComputeFailure['kind'], message: string) {
    super(message)
    this.name = 'ComputeFailure'
    this.kind = kind
  }
}

function failureKind(error: unknown): ComputeFailure['kind'] {
  if (error instanceof ArtifactStoreUnavailableError || error instanceof WorldUnavailableError) return 'unavailable'
  return 'final'
}

// The compute thread's side: one task at a time, as the main thread sends
// them.
function serveComputation(): void {
  const port = parentPort!
  const cache: JobCache = { worlds: new Map(), levels: new Map(), tiles: new Map() }
  let job: Job | null = null
  port.on('message', (request: ComputeRequest) => {
    if (request.type === 'token') {
      if (job) job.authToken = request.token
      return
    }
    const current = request.job
    job = current
    const reply = (message: ComputeReply): void => port.postMessage(message)
    runJob(current, (phase, fraction) => reply({ type: 'progress', phase, fraction }), request.cached ? cache : undefined)
      .then((outcome) => reply({ type: 'done', outcome }))
      .catch((error: unknown) => reply({ type: 'failed', kind: failureKind(error), message: error instanceof Error ? error.message : String(error) }))
      .finally(() => {
        if (job === current) job = null
      })
  })
}

// The main thread's side. A thread that dies ends the worker, as a dead
// engine thread does: the pool or the Deployment starts a fresh one, and the
// relay hands the task on once its heartbeat stops. Unreferenced while idle,
// so that it keeps no one-shot run alive.
let computeWorker: { run: (job: Job, onProgress: (phase: string, fraction: number) => void, cached: boolean) => Promise<JobOutcome>; token: (token: string) => void } | null = null
function computeThread(): NonNullable<typeof computeWorker> {
  if (computeWorker) return computeWorker
  const thread = new NodeWorker(new URL(import.meta.url), { workerData: COMPUTE_THREAD })
  thread.unref()
  thread.on('error', (error) => fail(`the compute thread failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`))
  thread.on('exit', (code) => fail(`the compute thread ended (${code})`))
  let pending: { resolve: (outcome: JobOutcome) => void; reject: (error: Error) => void; onProgress: (phase: string, fraction: number) => void } | null = null
  thread.on('message', (reply: ComputeReply) => {
    if (!pending) return
    if (reply.type === 'progress') {
      pending.onProgress(reply.phase, reply.fraction)
      return
    }
    const { resolve, reject } = pending
    pending = null
    thread.unref()
    if (reply.type === 'done') resolve(reply.outcome)
    else reject(new ComputeFailure(reply.kind, reply.message))
  })
  computeWorker = {
    run: (job, onProgress, cached) => new Promise<JobOutcome>((resolve, reject) => {
      pending = { resolve, reject, onProgress }
      thread.ref()
      thread.postMessage({ type: 'job', job, cached } satisfies ComputeRequest)
    }),
    token: (token) => thread.postMessage({ type: 'token', token } satisfies ComputeRequest),
  }
  return computeWorker
}

async function serve(config: ServeConfig): Promise<void> {
  const token = await busToken(config)
  // Over a WebSocket where the relay is named by one (a worker outside the
  // cluster, through the ingress), else over TCP.
  const options = { servers: config.relay, name: 'casas-job-worker', maxReconnectAttempts: -1, authenticator: token ? tokenAuthenticator(token) : undefined }
  const nc = /^wss?:\/\//i.test(config.relay) ? await wsconnect(options) : await connect(options)
  const consumerConfig = {
    durable_name: TASK_CONSUMER,
    ack_policy: AckPolicy.Explicit,
    ack_wait: TASK_ACK_WAIT_MS * 1_000_000,
    max_deliver: TASK_MAX_DELIVER,
    inactive_threshold: TASK_CONSUMER_IDLE_MS * 1_000_000,
    filter_subjects: config.pools.map((pool) => `jobs.task.${pool}.${WORLD_PIPELINE}.*`),
  }
  const jsm = await jetstreamManager(nc)
  try {
    await jsm.consumers.add(TASK_STREAM, consumerConfig)
  } catch {
    // It exists, set up by another worker: bring it to this configuration.
    await jsm.consumers.update(TASK_STREAM, TASK_CONSUMER, consumerConfig)
  }
  const js = jetstream(nc)
  const consumer = await js.consumers.get(TASK_STREAM, TASK_CONSUMER)
  let current: { msg: JsMsg; jobId: string } | null = null

  // PRESENCE: that this worker is there, and the task in hand.
  const self = { id: randomUUID(), account: await accountName(), host: hostname(), cores: availableParallelism(), pools: config.pools, build: WORLD_PIPELINE, startedAt: new Date().toISOString() }
  let doing: { jobId: string; taskId: string; stage: string; phase: string; percent: number } | null = null
  const announce = (leaving = false): void => {
    if (nc.isClosed()) return
    nc.publish(`jobs.worker.${self.id}`, JSON.stringify({ ...self, task: doing ?? undefined, leaving: leaving || undefined }))
  }
  announce()
  setInterval(() => announce(), PRESENCE_EVERY_MS).unref()

  // A cancelled job's task in hand is ended, and the worker with it — the
  // pipeline cannot be stopped from outside; the pool starts a fresh one.
  nc.subscribe('jobs.cancel.*', {
    callback: (_error, message) => {
      const jobId = message.subject.slice('jobs.cancel.'.length)
      if (current && current.jobId === jobId) {
        current.msg.term()
        process.exit(0)
      }
    },
  })
  // Asked to stop: the task in hand goes back to the queue at once. A
  // drain that does not finish does not keep the worker alive (2026-10-02:
  // a hung worker ignored SIGTERM for as long as it hung).
  process.on('SIGTERM', () => {
    announce(true)
    current?.msg.nak()
    setTimeout(() => process.exit(0), 5_000).unref()
    void nc.drain().finally(() => process.exit(0))
  })
  process.stderr.write(`serving ${config.pools.join(', ')} on ${config.relay}\n`)

  for (;;) {
    const msg = await consumer.next({ expires: 30_000 })
    if (!msg) continue
    let job: Job
    try {
      job = JSON.parse(msg.string()) as Job
    } catch {
      msg.term()
      continue
    }
    if (config.api) {
      if (job.worldUrl) job.worldUrl = overApi(job.worldUrl, config.api)
      if (job.artifactsUrl) job.artifactsUrl = overApi(job.artifactsUrl, config.api)
    }
    const taskId = job.taskId ?? ''
    current = { msg, jobId: job.jobId ?? '' }
    doing = { jobId: job.jobId ?? '', taskId, stage: job.tile ? `L${job.stage}:${job.tile.x},${job.tile.y}` : `L${job.stage}`, phase: '', percent: 0 }
    announce()
    const heartbeat = setInterval(() => msg.working(), TASK_HEARTBEAT_MS)
    // A task that reaches its stores over HTTP carries a token; keep it fresh.
    const compute = computeThread()
    const took = laps()
    const stopToken = job.authToken && taskId ? await keepJobToken(nc, job, taskId, compute.token) : null
    took.lap('token')
    let last = ''
    const onProgress = (phase: string, fraction: number): void => {
      const percent = Math.floor(fraction * 100)
      if (`${phase}:${percent}` === last || !job.jobId) return
      last = `${phase}:${percent}`
      if (doing) Object.assign(doing, { phase, percent })
      nc.publish(`jobs.event.${job.jobId}`, JSON.stringify({ taskId, phase, percent }))
    }
    try {
      const outcome = await compute.run(job, onProgress, true)
      took.lap('run')
      await js.publish(`jobs.done.${taskId}`, JSON.stringify({ taskId, ok: true, result: outcome.result, tasks: outcome.tasks, tileVersions: outcome.tileVersions }))
      msg.ack()
      took.lap('publish')
      process.stderr.write(`${JSON.stringify({ task: taskId, stage: doing?.stage, ms: { ...took.times, ...outcome.laps } })}\n`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // An artifact store or a world server that did not answer is not the
      // task's fault, and not a miss (HttpArtifactStore.ts,
      // readWorld): the task goes back to
      // the relay, as for a worker that crashed, and is handed out again —
      // to this worker or another — after a pause. Its last delivery
      // reports the failure, so that a store that stays away fails the job
      // instead of leaving it waiting.
      if (error instanceof ComputeFailure && error.kind === 'unavailable' && msg.info.deliveryCount < TASK_MAX_DELIVER) {
        process.stderr.write(`task ${taskId}: ${message}; giving it back (delivery ${msg.info.deliveryCount} of ${TASK_MAX_DELIVER})\n`)
        msg.nak(TASK_RETRY_DELAY_MS)
        continue
      }
      process.stderr.write(`task ${taskId} failed: ${message}\n`)
      // A computation's error is the task's answer: it would fail the same
      // way on any worker, so it is reported and not delivered again. So is
      // a refusal of the store or the world server (a 4xx other than 404:
      // ArtifactStoreRefusedError, WorldRefusedError): asking again gets the
      // same answer.
      await js.publish(`jobs.done.${taskId}`, JSON.stringify({ taskId, ok: false, error: message }))
      msg.term()
    } finally {
      clearInterval(heartbeat)
      stopToken?.()
      current = null
      doing = null
      announce()
    }
  }
}

// A worker thread loading this bundle is the COMPUTE THREAD
// (computeThread). The main thread keeps the bus.
if (isMainThread) {
  void main().catch((error: unknown) => fail(String(error)))
} else if (workerData === COMPUTE_THREAD) {
  serveComputation()
}
