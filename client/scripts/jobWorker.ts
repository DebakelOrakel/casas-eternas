// The server-side baker: one level bake or one tile, run in Node.
//
// Spawned by the Go server's `bake` module as a subprocess, one per job. It
// reads a saved world, refines its mesh to a finer level
// (pipeline/meshBakeStage) and writes the level into the artifact store's
// directory layout — after which the client finds it through the tiered store
// without knowing where it came from. (It baked the raster amplification's
// 4096²/8192² tiers until 2026-09-29.)
//
// WHY THIS IS NOT A PORT. Every module it touches is the browser's own: the
// save reader, the pipeline, the artifact encoder, the key derivation. Nothing
// here reimplements anything, and that is the whole design — an artifact
// carries a key derived from its inputs, so a browser bake and a server bake
// of one world must produce identical bytes. The golden harness has been
// running this same pipeline under Node for months, which is what makes the
// server tier wiring rather than a rewrite.
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
import { Worker as NodeWorker, isMainThread } from 'node:worker_threads'
import { availableParallelism } from 'node:os'
import { readWorldInputs } from '../src/world/save/loadWorldInputs'
import { BAKE_PIPELINE_DEPTH, EngineStalledError, type PipelineOptions, type WorkerLike } from '../src/generator/surface/erosionEnginePool'
import { levelBudget, levelHydrology, type MeshLevel } from '../src/generator/pipeline/meshBakeStage'
import { planTiles } from '../src/generator/pipeline/tilePlan'
import { meshRouting } from '../src/generator/mesh/meshHydrology'
import { encodeCoupledTerrain, HISTORY_DEFAULTS } from '../src/generator/pipeline/coupledEpoch'
import { CLIMATE_RES_X, CLIMATE_RES_Y } from '../src/generator/climate/climateField'
import { replayHistory, replayRefusal, type ReplayPosition, type ReplaySnapshot } from '../src/world/replay'
import { meshLevelMesh, meshLevelStage, meshLevelToArtifact, meshPipelineVersion, readMeshLevelArtifact, writeMeshLevelArtifact, type MeshLevelArtifact } from '../src/world/meshArtifacts'
import { bakedTileToArtifact, meshTilePipelineVersion, meshTileStage, readMeshTileArtifact, writeMeshTileArtifact, type MeshTileArtifact } from '../src/world/meshTileArtifacts'
import { bakeMeshTile, type UpstreamTile } from '../src/generator/pipeline/meshTileBake'
import { parentTilesOf, TILE_SPECS, tileCorner, tileGrid, tileParentFromTiles, tileSpec, type TileParent, type TilePiece, type TileSpec } from '../src/generator/mesh/meshTile'
import { SHELF_BREAK } from '../src/generator/elevation/elevationScale'
import { connect } from '@nats-io/transport-node'
import { AckPolicy, jetstream, jetstreamManager, type JsMsg } from '@nats-io/jetstream'
import { createMeshSampler, type MeshSampler } from '../src/generator/mesh/meshSampler'
import { tileBakeInputs } from '../src/world/bakeInputs'
import { createHttpArtifactStore } from '../src/storage/HttpArtifactStore'
import { artifactKey } from '../src/storage/ArtifactStore'
import type { ArtifactHandle, ArtifactKey, ArtifactStore } from '../src/storage/ArtifactStore'

// Where the baker reads and writes. Two shapes, because the same bake runs in
// two places (docs/decisions/distributed-bake.md):
//
//   PATHS  a subprocess on the server's own machine, next to the files.
//   URLS   a Kubernetes Job on some other node, which cannot mount the
//          server's ReadWriteOnce volume and therefore must talk HTTP. Not a
//          preference — anti-affinity keeps it off that node by design.
//
// Both go through the same bytes-at-a-path interface, so only the store
// implementation differs; nothing about the bake itself knows which it is.
// How often progress may be reported while a phase runs. A bake takes minutes,
// so seconds are plenty — this is a progress bar, not telemetry.
const progressIntervalMs = 3000

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
  // Root of the artifact store as a directory…
  artifactsDir?: string
  // …or the API base (e.g. "http://server:8080/v1") to PUT them to.
  artifactsUrl?: string
  // Bearer token for that API, naming this one job.
  authToken?: string
  // API base of the BAKE module that commissioned this job — where progress
  // reports go. Named for the module, like artifactsUrl, not for the one
  // route currently used. Falls back to artifactsUrl when absent, which is
  // the co-resident shape where both are the same server.
  jobsUrl?: string
  // This job's id, for reporting progress back. Absent for a local run, whose
  // progress reaches the server over the pipe instead.
  jobId?: string
  // The coordinator's task this is, when a serving worker pulled it from the
  // relay (internal/modules/jobs/coordinator.go): what it reports on
  // jobs.done.<taskId>.
  taskId?: string
  // Where level 1's replay keeps its checkpoints (internal/modules/jobs,
  // Spec.CheckpointDir); none without it.
  checkpointDir?: string
  // Whether an artifact already in the store may stand for the result
  // (set by the coordinator for a plan's tasks): its key names the inputs and
  // the pipeline version, so it is the one this job would write.
  reuse?: boolean
  // False forces the single-threaded engine — ONE state buffer instead of the
  // pool's pipelined pair, which halves the routing memory (measured layout:
  // a 16K bake is ~17 GiB single-buffer against ~26 GiB pipelined, the
  // difference between fitting a 32 GB machine and thrashing it). The Go
  // server never sets it; it exists for a MANUAL local run:
  //   node job-worker.mjs '{"worldZip":"…","stage":1,"erosionRounds":12,
  //                    "artifactsDir":"…","pool":false}'
  // Slower by the pool's factor (~2× at 8 cores), which a one-off accepts.
  // Level 1 only: its history epochs agree with the pool bit for bit, a
  // tile's twelve rounds do not, and a tile refuses it (enginePool).
  pool?: boolean
}

// The artifact store's resolve/read/write interface, backed by the
// filesystem — the server's own directory, which the Go store re-indexes by
// mtime, so an entry this subprocess writes is visible to the server on its
// next request without any handshake.
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
  const keyOf = (key: ArtifactKey): string => `${key.worldUid}/${key.worldId}/${key.pipelineVersion}/${key.stage}`
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
        if (meta.key && !index.byKey.has(keyOf(meta.key))) index.byKey.set(keyOf(meta.key), child)
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

// `held` is the revision (the server's ETag) of a copy this worker keeps:
// the server answers 304 when it is still the current one, and the
// archive — tens of MB — is not sent again (`unchanged`).
async function readWorld(job: Job, held?: string): Promise<{ archive: Uint8Array; etag: string | null } | 'unchanged' | null> {
  if (job.worldZip) {
    const archive = await readFile(job.worldZip).catch(() => null)
    return archive ? { archive, etag: null } : null
  }
  if (!job.worldUrl) return null
  try {
    const response = await authorizedFetch(job)(job.worldUrl, held ? { headers: { 'If-None-Match': held } } : {})
    if (response.status === 304 && held) return 'unchanged'
    if (!response.ok) return null
    return { archive: new Uint8Array(await response.arrayBuffer()), etag: response.headers.get('ETag') }
  } catch {
    return null
  }
}

// This job's credentials, attached to every request it makes.
//
// A fixed token, unlike the browser's, which changes at sign-in and at expiry —
// so where the browser passes a fetch that ends its session on a 401, this one
// simply always adds the same header. Absent when the server checks nobody, in
// which case the header is omitted rather than sent empty.
function authorizedFetch(job: Job): (input: string, init?: RequestInit) => Promise<Response> {
  return (input, init = {}) => {
    if (!job.authToken) return fetch(input, init)
    const headers = { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${job.authToken}` }
    return fetch(input, { ...init, headers })
  }
}

// Reports progress to the server, for a bake that runs somewhere the server
// cannot watch.
//
// A LOCAL run needs none of this: its progress reaches the server over the pipe
// this same callback already writes to. A Kubernetes Job has no pipe — the API
// says only pending, running or gone — so it says so itself, over the connection
// it already uses for the world and the artifacts. See
// docs/decisions/server-auth.md.
//
// Throttled by TIME, not by percent. The stderr line above is one per whole
// percent, which is right for a log and would be a hundred requests per phase
// here. A phase CHANGE always goes through: that is the part a reader acts on,
// and it is worth a request of its own.
//
// Fire and forget, deliberately: a bake must not fail because a status update
// did. A lost report is a stale number for a few seconds.
//
// But not SILENT. The first version swallowed every failure, and the symptom of
// that — a progress bar that never moves — is indistinguishable from an old
// image, a wrong URL and a refused token. It says so on stderr instead, which is
// the pod's log and the first place anyone looks; only ONCE, because a report
// that fails usually fails every time and a log full of the same line is a log
// nobody reads.
function progressReporter(job: Job): (phase: string, percent: number) => void {
  const base = job.jobsUrl ?? job.artifactsUrl
  if (!base || !job.jobId) return () => {}
  const url = `${base}/jobs/${encodeURIComponent(job.jobId)}/progress`
  const send = authorizedFetch(job)
  let lastSentAt = 0
  let lastPhase = ''
  let complained = false
  const complain = (reason: string): void => {
    if (complained) return
    complained = true
    process.stderr.write(`progress reporting failed (${reason}); the bake continues without a bar\n`)
  }
  return (phase, percent) => {
    const now = Date.now()
    if (phase === lastPhase && now - lastSentAt < progressIntervalMs) return
    lastPhase = phase
    lastSentAt = now
    void send(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phase, percent }),
    })
      .then((response) => {
        if (!response.ok) complain(`${url} answered ${response.status}`)
      })
      .catch((error: unknown) => complain(`${url}: ${String(error)}`))
  }
}

// The one line that decides where a bake's output lands. Everything above it
// is identical in both deployments, which is the property worth protecting:
// the artifacts must be byte-identical wherever the bake ran.
function artifactStoreFor(job: Job): ArtifactStore | null {
  if (job.artifactsDir) return createFsArtifactStore(job.artifactsDir)
  if (job.artifactsUrl) {
    const base = job.artifactsUrl
    return createHttpArtifactStore({ resolveBase: async () => base, fetch: authorizedFetch(job) })
  }
  return null
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

// The engine's worker pool, self-spawned from THIS entry: job-worker.mjs is one
// esbuild bundle, so `import.meta.url` names a file that already contains
// the engine worker's code — a worker thread loading it takes the
// `isMainThread` branch at the bottom and becomes an engine worker. No
// second bundle, nothing for the Go side to ship or know. Sizing mirrors
// the generator's (pipeline/runtime.ts): the split and the depth are
// throughput knobs, never part of the result — the engine is byte-identical
// across any worker count, which is what lets a job land on whatever
// machine has cores to spare.
// The generator code this bundle was built from (scripts/buildWorker.mjs
// defines it): what a world's history must record for level 1's replay.
// Empty where the source runs unbundled — every replay is then refused.
declare const __GENERATOR_CODE__: string
const GENERATOR_CODE: string = typeof __GENERATOR_CODE__ === 'string' ? __GENERATOR_CODE__ : ''

// ALWAYS a pool, on a small machine one of one stencil and one refresh
// thread: the pooled engine is a scheme of its own, and a tile baked
// without it differs in the last bits under the same artifact key (the
// pooled result is the same for every worker split — measured 1+1 against
// 4+2, 2026-10-02). It used to be none below four cores.
function enginePool(): { createWorker: () => WorkerLike } & PipelineOptions {
  const cores = availableParallelism()
  return {
    createWorker: () => new NodeWorker(new URL(import.meta.url)) as unknown as WorkerLike,
    ...(cores >= 8 ? { stencilWorkers: 4, refreshWorkers: 2 } : cores >= 4 ? { stencilWorkers: 2, refreshWorkers: 1 } : { stencilWorkers: 1, refreshWorkers: 1 }),
    pipelineDepth: BAKE_PIPELINE_DEPTH,
  }
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
    process.stdout.write(`${JSON.stringify({ pipelineVersion: meshPipelineVersion(1), tilePipelineVersions: Object.fromEntries(Object.keys(TILE_SPECS).map((level) => [level, meshTilePipelineVersion(Number(level))])), code: GENERATOR_CODE })}\n`)
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
    const outcome = await runJob(job, stderrProgress(job))
    process.stdout.write(`${JSON.stringify(outcome.result)}\n`)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

// Progress on stderr, one line per whole percent: the Go side surfaces it as
// job status, and keeping stdout clean means the result stays one parseable
// line no matter how chatty the pipeline gets. A cluster Job also posts it
// to its server (progressReporter).
function stderrProgress(job: Job): (phase: string, fraction: number) => void {
  let lastPercent = -1
  const report = progressReporter(job)
  return (phase, fraction) => {
    const percent = Math.floor(fraction * 100)
    if (percent === lastPercent) return
    lastPercent = percent
    process.stderr.write(`${JSON.stringify({ phase, percent })}\n`)
    report(phase, percent)
  }
}

// What one job produced: the result line the Go side reads, and for a level
// the tile levels' plan (a refine plan grows it, coordinator.go).
interface JobOutcome {
  result: { worldId: string; pipelineVersion: string; stage: string; width: number; height: number; nodes: number; durationMs: number }
  tasks?: PlannedTask[]
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
  levels: Map<string, { artifact: NonNullable<Awaited<ReturnType<typeof readMeshLevelArtifact>>>['artifact']; mesh?: ReturnType<typeof meshLevelMesh>; sampler?: MeshSampler }>
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
  // A world read from a file is cached by its path, which names one
  // revision; one fetched by URL with its revision, and asked for again
  // only if the server holds a newer one (readWorld).
  const worldKey = job.worldZip ?? job.worldUrl
  const held = worldKey && cache ? recall(cache.worlds, worldKey) : undefined
  let inputs: WorldInputs | undefined = held && job.worldZip ? held.inputs : undefined
  if (!inputs) {
    const read = await readWorld(job, held?.etag ?? undefined)
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
  const store = artifactStoreFor(job)
  if (!store) throw new Error('neither artifactsDir nor artifactsUrl was given')
  if (job.stage !== 1 && TILE_SPECS[job.stage]) return bakeTile(job, inputs, store, onProgress, cache)
  if (job.stage !== 1) throw new Error(`stage ${job.stage}: no such level`)
  const started = Date.now()
  const pipelineVersion = meshPipelineVersion(1, job.erosionRounds)
  const key = artifactKey(inputs.worldUid, inputs.worldId, pipelineVersion, meshLevelStage(1))
  if (job.reuse) {
    const stored = await readMeshLevelArtifact(store, key)
    if (stored) {
      if (cache) remember(cache.levels, `${key.worldUid}/${key.worldId}/${key.pipelineVersion}`, { artifact: stored.artifact }, CACHED_LEVELS)
      return {
        result: { worldId: key.worldId, pipelineVersion, stage: key.stage, width: 0, height: 0, nodes: stored.artifact.count, durationMs: stored.bakeMs },
        tasks: planOf(inputs, stored.artifact),
      }
    }
  }
  const level = await replayLevel(job, inputs, onProgress)
  const durationMs = Date.now() - started
  const artifact = meshLevelToArtifact(level)
  if (!(await writeMeshLevelArtifact(store, key, artifact, durationMs, inputs.seedText, job.erosionRounds))) throw new Error('could not write the artifact')
  if (cache) remember(cache.levels, `${key.worldUid}/${key.worldId}/${key.pipelineVersion}`, { artifact }, CACHED_LEVELS)
  if (job.checkpointDir) await rm(checkpointPath(job.checkpointDir, inputs), { recursive: true, force: true })
  return {
    result: { worldId: key.worldId, pipelineVersion, stage: key.stage, width: 0, height: 0, nodes: artifact.count, durationMs },
    tasks: planOf(inputs, artifact),
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
function planOf(inputs: WorldInputs, artifact: MeshLevelArtifact): PlannedTask[] {
  const mesh = meshLevelMesh(artifact, inputs.width, inputs.height)
  const routing = meshRouting(mesh, artifact.z)
  const plan = planTiles({
    mesh, z: artifact.z, routing, width: inputs.width, height: inputs.height,
    levels: Object.keys(TILE_SPECS).map(Number).sort((a, b) => a - b),
    landTiles: (level) => landTiles(inputs, tileSpec(level)).map(([x, y]) => ({ level, x, y })),
  })
  return plan.map((p) => ({
    level: p.tile.level, x: p.tile.x, y: p.tile.y,
    after: [...p.parents, ...p.upstream].map((t) => [t.level, t.x, t.y] as [number, number, number]),
    upstream: p.upstream.map((t) => ({ x: t.x, y: t.y })),
  }))
}

// LEVEL 1 BY REPLAY (docs/decisions/detail-ladder.md, fork 2): the world's
// history made again at level 1's budget, its waters derived on the
// result. Three phases:
//   verify   — the history at its own budget must land on the save's mesh
//              bit for bit, or this code cannot make this world again;
//   history  — the replay at level 1's budget, with checkpoints;
//   hydrology — the level's waters from its last epoch's climate.
// Refused, not approximated, where the world's code is not this bundle's.
async function replayLevel(job: Job, inputs: WorldInputs, onProgress: (phase: string, fraction: number) => void): Promise<MeshLevel> {
  const refusal = replayRefusal(inputs.history, GENERATOR_CODE)
  if (refusal) throw new Error(refusal)
  if (!inputs.mesh) throw new Error('the world carries no mesh — make it again to refine it')
  const recipe = { seed: inputs.seedText, width: inputs.width, height: inputs.height, history: inputs.history }
  const pool = job.pool === false ? undefined : enginePool()
  const dir = job.checkpointDir ? checkpointPath(job.checkpointDir, inputs) : null
  const resume = dir ? await readCheckpoint(dir) : null
  // A checkpoint is past the check: the run that wrote it passed it.
  if (!resume) {
    onProgress('verify', 0)
    const check = await replayHistory(recipe, { budget: HISTORY_DEFAULTS.budget, pool, onEpoch: (done, total) => onProgress('verify', done / total) })
    const parted = meshParts(encodeCoupledTerrain(check.terrain), inputs.mesh)
    if (parted) throw new Error(`the replay does not make this world again (its ${parted} differs from the save's) — this code cannot refine it`)
  }
  onProgress('history', 0)
  let lastCheckpoint = resume?.done ?? 0
  let done = lastCheckpoint
  const { terrain } = await replayHistory(recipe, {
    budget: levelBudget(1),
    pool,
    resume: resume ? { position: resume.position, snapshot: resume.snapshot } : undefined,
    onEpoch: (epochs, total) => {
      done = epochs
      onProgress('history', epochs / total)
    },
    onCheckpoint: dir
      ? async (position, take) => {
        if (done - lastCheckpoint < CHECKPOINT_EVERY_EPOCHS) return
        await writeCheckpoint(dir, position, done, take())
        lastCheckpoint = done
      }
      : undefined,
  })
  onProgress('hydrology', 0)
  const weather = terrain.weather?.result
  if (!terrain.routing || !weather) throw new Error('the replay ended without its last epoch\'s state')
  const water = levelHydrology(terrain.mesh, terrain.z, terrain.routing, terrain.areas, terrain.sedimentFlux, {
    precipitation: weather.seasonal.annual, temperature: weather.temperature, monsoonIndex: weather.seasonal.index,
    climateResX: CLIMATE_RES_X, climateResY: CLIMATE_RES_Y,
  }, { width: inputs.width, height: inputs.height, budget: levelBudget(1), detailSeed: inputs.detailSeed })
  onProgress('hydrology', 1)
  return { level: 1, mesh: terrain.mesh, z: terrain.z, routing: terrain.routing, ...water, inserted: 0 }
}

// Which part of a replayed mesh differs from the save's, or null.
function meshParts(mine: { nodes: Float32Array; connectivity: Uint8Array; z: Float32Array; column: Uint8Array }, saved: NonNullable<WorldInputs['mesh']>): string | null {
  const same = (a: ArrayBufferView, b: ArrayBufferView): boolean =>
    a.byteLength === b.byteLength && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0
  if (!same(mine.nodes, saved.nodes)) return 'node positions'
  if (!same(mine.connectivity, saved.connectivity)) return 'triangulation'
  if (!same(mine.z, saved.z)) return 'heights'
  if (saved.column && !same(mine.column, saved.column)) return 'sediment column'
  return null
}

// CHECKPOINTS of level 1's replay: hours of one task, so a worker that dies
// leaves the state of an epoch for the one that takes the task over. Kept
// per world revision and code; written whole into a fresh directory, then
// renamed over the last, so a crash mid-write leaves the previous one.
// Every CHECKPOINT_EVERY_EPOCHS epochs (~10 min at level 1), and only where
// one restores exactly (world/replay.ts, onCheckpoint).
const CHECKPOINT_EVERY_EPOCHS = 10

function checkpointPath(root: string, inputs: WorldInputs): string {
  return join(root, `${inputs.worldUid || 'no-uid'}-${inputs.worldId}-${GENERATOR_CODE}`)
}

const CHECKPOINT_ARRAYS = ['oceanAge', 'mantle', 'latticeAccumulated', 'latticeLockedEpochs', 'latticeLastClassCode'] as const
const CHECKPOINT_MESH = ['nodes', 'connectivity', 'z', 'column'] as const

async function writeCheckpoint(dir: string, position: ReplayPosition, done: number, snapshot: ReplaySnapshot): Promise<void> {
  const fresh = `${dir}.${randomUUID()}`
  await mkdir(fresh, { recursive: true })
  const bytes = (a: ArrayBufferView): Uint8Array => new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
  await writeFile(join(fresh, 'position.json'), JSON.stringify({ position, done }))
  await writeFile(join(fresh, 'state.json'), JSON.stringify(snapshot.state))
  for (const name of CHECKPOINT_ARRAYS) await writeFile(join(fresh, `${name}.bin`), bytes(snapshot[name]))
  for (const name of CHECKPOINT_MESH) await writeFile(join(fresh, `mesh.${name}.bin`), bytes(snapshot.mesh[name]))
  await rm(dir, { recursive: true, force: true })
  await rename(fresh, dir)
}

async function readCheckpoint(dir: string): Promise<{ position: ReplayPosition; done: number; snapshot: ReplaySnapshot } | null> {
  try {
    const { position, done } = JSON.parse(await readFile(join(dir, 'position.json'), 'utf8')) as { position: ReplayPosition; done: number }
    const read = async (name: string): Promise<ArrayBuffer> => {
      const b = await readFile(join(dir, name))
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
    }
    const snapshot: ReplaySnapshot = {
      state: JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')),
      oceanAge: new Float32Array(await read('oceanAge.bin')),
      mantle: new Float32Array(await read('mantle.bin')),
      latticeAccumulated: new Float32Array(await read('latticeAccumulated.bin')),
      latticeLockedEpochs: new Int16Array(await read('latticeLockedEpochs.bin')),
      latticeLastClassCode: new Int8Array(await read('latticeLastClassCode.bin')),
      mesh: {
        nodes: new Float32Array(await read('mesh.nodes.bin')),
        connectivity: new Uint8Array(await read('mesh.connectivity.bin')),
        z: new Float32Array(await read('mesh.z.bin')),
        column: new Uint8Array(await read('mesh.column.bin')),
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

// A stage past level 1: one tile of that level, built on its parent — level
// 1 for a level-2 tile, the level-2 tiles it overlaps for a level-3 tile —
// read from the same artifact store the tile is written to. Level 1 is
// read by every tile: its river graph brings the inflow, its surface the
// synthesis' relief.
async function bakeTile(job: Job, inputs: WorldInputs, store: ArtifactStore, onProgress: (phase: string, fraction: number) => void, cache?: JobCache): Promise<JobOutcome> {
  const spec = tileSpec(job.stage)
  const { cols, rows } = tileGrid(inputs.width, inputs.height, spec)
  if (!job.tile || !Number.isInteger(job.tile.x) || !Number.isInteger(job.tile.y) || job.tile.x < 0 || job.tile.y < 0 || job.tile.x >= cols || job.tile.y >= rows) {
    throw new Error(`stage ${job.stage} needs a tile inside the ${cols} × ${rows} grid`)
  }
  // Tiles bake on the pool only: without it the engine is the other scheme,
  // and the artifact would differ under the same key (enginePool).
  if (job.pool === false) throw new Error('a tile bakes on the engine pool only — pool: false is for level 1')
  const tile = { level: spec.level, x: job.tile.x, y: job.tile.y }
  const started = Date.now()
  const pipelineVersion = meshTilePipelineVersion(spec.level, job.erosionRounds)
  const key = artifactKey(inputs.worldUid, inputs.worldId, pipelineVersion, meshTileStage(tile))
  if (job.reuse) {
    const stored = await readMeshTileArtifact(store, key)
    if (stored) return { result: { worldId: key.worldId, pipelineVersion, stage: key.stage, width: 0, height: 0, nodes: stored.artifact.count, durationMs: stored.bakeMs } }
  }
  onProgress('parent', 0)
  const parentKey = artifactKey(inputs.worldUid, inputs.worldId, meshPipelineVersion(1, job.erosionRounds), meshLevelStage(1))
  const levelKey = `${parentKey.worldUid}/${parentKey.worldId}/${parentKey.pipelineVersion}`
  let level1 = cache ? recall(cache.levels, levelKey) : undefined
  if (!level1) {
    const read = await readMeshLevelArtifact(store, parentKey)
    if (!read) throw new Error('level 1 of this world is not in the artifact store — refine the world first')
    level1 = { artifact: read.artifact }
    if (cache) remember(cache.levels, levelKey, level1, CACHED_LEVELS)
  }
  // Decoded and indexed once per worker, not once per tile.
  level1.mesh ??= meshLevelMesh(level1.artifact, inputs.width, inputs.height)
  level1.sampler ??= createMeshSampler(level1.mesh, level1.artifact.z)
  const macro = level1.sampler
  let parent: TileParent
  if (spec.level === 2) {
    parent = { mesh: level1.mesh, z: level1.artifact.z, discharge: null, sampler: macro, macro }
  } else {
    // The level above's tiles this one overlaps, joined (meshTile.ts,
    // tileParentFromTiles); every one must be there — the coordinator
    // orders them first.
    const above = tileSpec(spec.level - 1)
    const pieces: TilePiece[] = []
    for (const piece of parentTilesOf(tile, above, inputs.width, inputs.height)) {
      const read = await readTile(store, artifactKey(inputs.worldUid, inputs.worldId, meshTilePipelineVersion(above.level, job.erosionRounds), meshTileStage(piece)), cache)
      if (!read) throw new Error(`tile ${meshTileStage(piece)} of this world is not in the artifact store — the level above comes first`)
      pieces.push({ tile: piece, count: read.count, nodes: read.nodes, z: read.z })
    }
    const patch = tileParentFromTiles(pieces, inputs.width, inputs.height)
    parent = { mesh: patch.mesh, z: patch.z, discharge: null, sampler: createMeshSampler(patch.mesh, patch.z), macro }
  }
  // The upstream tiles' outflow; each was computed first (it is a dep).
  const upstream: UpstreamTile[] = []
  for (const at of job.upstream ?? []) {
    const up = { level: spec.level, x: at.x, y: at.y }
    const read = await readTile(store, artifactKey(inputs.worldUid, inputs.worldId, pipelineVersion, meshTileStage(up)), cache)
    if (!read) throw new Error(`tile ${meshTileStage(up)} upstream of this one is not in the artifact store`)
    upstream.push({ tile: up, count: read.count, nodes: read.nodes, outflow: read.outflow })
  }
  onProgress('parent', 1)
  const baked = await bakeMeshTile(tileBakeInputs(inputs, parent, level1.artifact.graph, upstream), tile, { rounds: job.erosionRounds, pool: enginePool(), onProgress })
  const durationMs = Date.now() - started
  const artifact = bakedTileToArtifact(baked)
  if (!(await writeMeshTileArtifact(store, key, artifact, durationMs, inputs.seedText, job.erosionRounds))) throw new Error('could not write the artifact')
  return { result: { worldId: key.worldId, pipelineVersion, stage: key.stage, width: 0, height: 0, nodes: artifact.count, durationMs } }
}

// A tile artifact, through the worker's cache when it has one.
async function readTile(store: ArtifactStore, key: ArtifactKey, cache?: JobCache): Promise<MeshTileArtifact | null> {
  const id = `${key.worldUid}/${key.worldId}/${key.pipelineVersion}/${key.stage}`
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
  relay: string
  pools: string[]
}

// The relay's names for the jobs module's streams (internal/modules/jobs/streams.go).
const TASK_STREAM = 'JOBS_TASKS'
const TASK_CONSUMER = 'workers'
// How long a task may go unacknowledged before the relay hands it to
// another worker; the worker says it is still working well inside it.
const TASK_ACK_WAIT_MS = 5 * 60_000
const TASK_HEARTBEAT_MS = 30_000
const TASK_MAX_DELIVER = 5

async function serve(config: ServeConfig): Promise<void> {
  // The bus token, where the bus checks identity (internal/modules/relay):
  // from the environment, never the argv, where `ps` would show it. The jobs
  // module sets it for its local workers (workerpool.go).
  const token = process.env.RELAY_TOKEN || undefined
  const nc = await connect({ servers: config.relay, name: 'casas-job-worker', maxReconnectAttempts: -1, token })
  const consumerConfig = {
    durable_name: TASK_CONSUMER,
    ack_policy: AckPolicy.Explicit,
    ack_wait: TASK_ACK_WAIT_MS * 1_000_000,
    max_deliver: TASK_MAX_DELIVER,
    filter_subjects: config.pools.map((pool) => `jobs.task.${pool}.*`),
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
  const cache: JobCache = { worlds: new Map(), levels: new Map(), tiles: new Map() }
  let current: { msg: JsMsg; jobId: string } | null = null

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
    const taskId = job.taskId ?? ''
    current = { msg, jobId: job.jobId ?? '' }
    const heartbeat = setInterval(() => msg.working(), TASK_HEARTBEAT_MS)
    let lastPercent = -1
    const onProgress = (phase: string, fraction: number): void => {
      const percent = Math.floor(fraction * 100)
      if (percent === lastPercent || !job.jobId) return
      lastPercent = percent
      nc.publish(`jobs.event.${job.jobId}`, JSON.stringify({ taskId, phase, percent }))
    }
    try {
      const outcome = await runJob(job, onProgress, cache)
      await js.publish(`jobs.done.${taskId}`, JSON.stringify({ taskId, ok: true, result: outcome.result, tasks: outcome.tasks }))
      msg.ack()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // A dead engine thread is this worker's fault, not the task's: the
      // worker ends without an answer, the pool starts a fresh one and the
      // relay hands the task on once its heartbeat stops.
      if (error instanceof EngineStalledError) {
        process.stderr.write(`task ${taskId}: ${message}; ending the worker\n`)
        process.exit(1)
      }
      process.stderr.write(`task ${taskId} failed: ${message}\n`)
      // A computation's error is the task's answer: it would fail the same
      // way on any worker, so it is reported and not delivered again.
      await js.publish(`jobs.done.${taskId}`, JSON.stringify({ taskId, ok: false, error: message }))
      msg.term()
    } finally {
      clearInterval(heartbeat)
      current = null
    }
  }
}

// A worker thread loading this bundle is an ENGINE WORKER, not a baker:
// importing the worker module registers its parentPort handshake and the
// pool drives it over SharedArrayBuffers from there. The main thread runs
// the bake.
if (isMainThread) {
  void main().catch((error: unknown) => fail(String(error)))
} else {
  void import('../src/generator/surface/erosionEngineWorker')
}
