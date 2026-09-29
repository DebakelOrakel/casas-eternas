// The server-side baker: one level bake, run in Node.
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
// Bundled by `npm run build:baker` and invoked as:
//   node baker.mjs '<job JSON>'
// with the job on argv and a one-line JSON result on stdout, so the Go side
// needs no framing beyond "read the last line".
import { readFile, mkdir, writeFile, rename, readdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, dirname } from 'node:path'
import { Worker as NodeWorker, isMainThread } from 'node:worker_threads'
import { availableParallelism } from 'node:os'
import { readWorldInputs } from '../src/world/save/loadWorldInputs'
import type { WorkerLike } from '../src/generator/surface/erosionEnginePool'
import { bakeMeshLevel, levelBudget } from '../src/generator/pipeline/meshBakeStage'
import { meshLevelStage, meshLevelToArtifact, meshPipelineVersion, writeMeshLevelArtifact } from '../src/world/meshArtifacts'
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
  // `erosionRounds`; the artifact is the level (world/meshArtifacts.ts). The
  // only one built.
  stage: number
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
  // False forces the single-threaded engine — ONE state buffer instead of the
  // pool's pipelined pair, which halves the routing memory (measured layout:
  // a 16K bake is ~17 GiB single-buffer against ~26 GiB pipelined, the
  // difference between fitting a 32 GB machine and thrashing it). The Go
  // server never sets it; it exists for a MANUAL local run:
  //   node baker.mjs '{"worldZip":"…","stage":1,"erosionRounds":12,
  //                    "artifactsDir":"…","pool":false}'
  // Slower by the pool's factor (~2× at 8 cores), which a one-off accepts.
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
function createFsArtifactStore(root: string): ArtifactStore {
  // A name is at most a shallow relative path from our own writer — anything
  // else is refused rather than resolved.
  const safeName = (name: string): boolean => {
    const segments = name.split('/')
    return segments.length <= 4 && segments.every((s) => s.length > 0 && s !== '.' && s !== '..' && !s.includes('\\'))
  }

  // key → uid by reading each entry's meta.json — the same rule as every
  // other store: the meta is the truth, the directory name means nothing. A
  // baker runs once per job, so a full scan per resolve is noise.
  async function findByKey(key: ArtifactKey): Promise<string | null> {
    let children: string[]
    try {
      children = await readdir(root)
    } catch {
      return null
    }
    for (const child of children) {
      try {
        const raw = await readFile(join(root, child, 'meta.json'), 'utf8')
        const meta = JSON.parse(raw) as { key?: ArtifactKey }
        if (
          meta.key &&
          meta.key.worldUid === key.worldUid && meta.key.worldId === key.worldId &&
          meta.key.pipelineVersion === key.pipelineVersion && meta.key.stage === key.stage
        ) return child
      } catch {
        continue
      }
    }
    return null
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

async function readWorld(job: Job): Promise<Uint8Array | null> {
  if (job.worldZip) return readFile(job.worldZip).catch(() => null)
  if (!job.worldUrl) return null
  try {
    const response = await authorizedFetch(job)(job.worldUrl)
    if (!response.ok) return null
    return new Uint8Array(await response.arrayBuffer())
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

// The engine's worker pool, self-spawned from THIS entry: baker.mjs is one
// esbuild bundle, so `import.meta.url` names a file that already contains
// the engine worker's code — a worker thread loading it takes the
// `isMainThread` branch at the bottom and becomes an engine worker. No
// second bundle, nothing for the Go side to ship or know. Sizing mirrors
// the generator's (pipeline/runtime.ts): the split and the depth are
// throughput knobs, never part of the result — the engine is byte-identical
// across any worker count, which is what lets a job land on whatever
// machine has cores to spare.
function enginePool(): ({ createWorker: () => WorkerLike } & { stencilWorkers: number; refreshWorkers: number; pipelineDepth: number }) | undefined {
  const cores = availableParallelism()
  if (cores < 4) return undefined
  return {
    createWorker: () => new NodeWorker(new URL(import.meta.url)) as unknown as WorkerLike,
    ...(cores >= 8 ? { stencilWorkers: 4, refreshWorkers: 2 } : { stencilWorkers: 2, refreshWorkers: 1 }),
    pipelineDepth: 8,
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
    process.stdout.write(`${JSON.stringify({ pipelineVersion: meshPipelineVersion(1) })}\n`)
    return
  }
  if (!raw) fail('usage: baker.mjs \'<job JSON>\'  |  baker.mjs --version')
  let job: Job
  try {
    job = JSON.parse(raw) as Job
  } catch {
    return fail('job argument is not JSON')
  }

  const archive = await readWorld(job)
  if (!archive) fail(`cannot read the world (${job.worldZip ?? job.worldUrl ?? 'no source given'})`)

  const inputs = await readWorldInputs(archive)
  if (!inputs) fail('not a readable world archive')

  const started = Date.now()
  // Progress on stderr, one line per whole percent: the Go side surfaces it as
  // job status, and keeping stdout clean means the result stays one parseable
  // line no matter how chatty the pipeline gets.
  let lastPercent = -1
  const report = progressReporter(job)
  const onProgress = (phase: string, fraction: number): void => {
    const percent = Math.floor(fraction * 100)
    if (percent === lastPercent) return
    lastPercent = percent
    process.stderr.write(`${JSON.stringify({ phase, percent })}\n`)
    report(phase, percent)
  }
  if (job.stage !== 1) fail(`stage ${job.stage}: only level 1 is built`)
  if (!inputs.mesh) fail('the world carries no mesh (a save from before formatVersion 3, or never eroded) — nothing to refine')
  const level = await bakeMeshLevel({
    mesh: inputs.mesh, width: inputs.width, height: inputs.height,
    detailSeed: inputs.detailSeed, lithoSeed: inputs.lithoSeed,
    controls: { alluvium: inputs.erosionControls.alluvium, rockContrast: inputs.erosionControls.rockContrast },
    uplift: inputs.uplift?.data ?? null, erodibility: inputs.erodibility?.data ?? null,
    forcingResX: inputs.uplift?.resX ?? 0, forcingResY: inputs.uplift?.resY ?? 0,
    precipitation: inputs.climate?.data ?? null, temperature: inputs.temperature?.data ?? null,
    monsoonIndex: inputs.biomeInputs?.monsoonIndex.data ?? null,
    climateResX: inputs.climate?.resX ?? 0, climateResY: inputs.climate?.resY ?? 0,
  }, { level: 1, budget: levelBudget(1), rounds: job.erosionRounds, pool: job.pool === false ? undefined : enginePool(), onProgress })
  const durationMs = Date.now() - started
  const store = artifactStoreFor(job)
  if (!store) fail('neither artifactsDir nor artifactsUrl was given')
  const pipelineVersion = meshPipelineVersion(1, job.erosionRounds)
  const key = artifactKey(inputs.worldUid, inputs.worldId, pipelineVersion, meshLevelStage(1))
  const artifact = meshLevelToArtifact(level)
  if (!(await writeMeshLevelArtifact(store, key, artifact, durationMs, inputs.seedText, job.erosionRounds))) fail('could not write the artifact')
  process.stdout.write(`${JSON.stringify({ worldId: key.worldId, pipelineVersion, stage: key.stage, width: 0, height: 0, nodes: artifact.count, durationMs })}\n`)
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
