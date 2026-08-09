// The server-side baker: one amplification bake, run in Node.
//
// Spawned by the Go server's `bake` module as a subprocess, one per job. It
// reads a saved world, runs the amplification pipeline and writes the result
// into the artifact store's directory layout — after which the client finds it
// through the tiered store without knowing where it came from.
//
// WHY THIS IS NOT A PORT. Every module it touches is the browser's own: the
// save reader, the pipeline, the artifact encoder, the key derivation. Nothing
// here reimplements anything, and that is the whole design — an artifact
// carries a key derived from its inputs, so a browser bake and a server bake
// of one world must produce identical bytes. The golden harness has been
// running this same pipeline under Node for months, which is what makes the
// server tier wiring rather than a rewrite.
//
// WHY IT RUNS ON THE SERVER AT ALL: an 8192² bake peaks near 2.6 GB. That is
// unremarkable for a Node process and fatal for a browser tab (measured: it
// kills Safari). 8k is therefore a capability of having a server — even a
// local one.
//
// Bundled by `npm run build:baker` and invoked as:
//   node baker.mjs '<job JSON>'
// with the job on argv and a one-line JSON result on stdout, so the Go side
// needs no framing beyond "read the last line".
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { readWorldInputs } from '../src/world/save/loadWorldInputs'
import { runAmplification } from '../src/worldgen/surface/runAmplification'
import { amplificationPipelineVersion, writeAmplificationArtifact } from '../src/world/artifacts'
import { createHttpArtifactStore, toRemotePath } from '../src/storage/HttpArtifactStore'
import type { ArtifactStore, StorageUsage } from '../src/storage/ArtifactStore'

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
interface Job {
  // Path to the saved world's .zip, when it is reachable as a file…
  worldZip?: string
  // …or its URL, when it is not. Exactly one of the two.
  worldUrl?: string
  // Amplification factor: 2 → 4096, 4 → 8192.
  stage: number
  erosionRounds: number
  // Root of the artifact store as a directory…
  artifactsDir?: string
  // …or the API base (e.g. "http://server:8080/v1") to PUT them to.
  artifactsUrl?: string
  // Bearer token for that API, scoped to this job's artifact key.
  authToken?: string
}

// The artifact store's byte-level interface, backed by the filesystem.
//
// Implemented here rather than reusing the encoder's own writer because that
// is exactly the point of the interface: `writeAmplificationArtifact` does the
// quantisation, the file naming and the meta-last ordering, and it does not
// care whether the bytes land in OPFS, over HTTP, or here. Reimplementing the
// ENCODING would be the mistake; reimplementing "put bytes at a path" is four
// lines and keeps the encoder single-sourced.
function createFsArtifactStore(root: string): ArtifactStore {
  // The local grammar (`worlds/{id}/amp/{version}/{stage}/…`) maps onto the
  // server's (`{id}/{version}/{stage}/…`) through the same translation the
  // HTTP store uses — shared so the two layouts cannot drift apart.
  const resolve = (path: string): string | null => {
    const remote = toRemotePath(path)
    if (!remote) return null
    return join(root, remote.worldId, remote.pipelineVersion, remote.stage, ...remote.name.split('/'))
  }

  return {
    async read(path: string): Promise<ArrayBuffer | null> {
      const target = resolve(path)
      if (!target) return null
      try {
        const buffer = await readFile(target)
        return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
      } catch {
        return null
      }
    },
    async write(path: string, bytes: ArrayBuffer | ArrayBufferView): Promise<boolean> {
      const target = resolve(path)
      if (!target) return false
      try {
        await mkdir(dirname(target), { recursive: true })
        const view = ArrayBuffer.isView(bytes)
          ? new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength)
          : new Uint8Array(bytes as ArrayBuffer)
        // Temp-then-rename, matching the Go store: a reader must see either
        // the old bytes or the new ones, never half a raster — and the server
        // may well be serving this path while the bake writes it.
        const tmp = `${target}.tmp-${process.pid}`
        await writeFile(tmp, view)
        await rename(tmp, target)
        return true
      } catch {
        return false
      }
    },
    async exists(path: string): Promise<boolean> {
      return (await this.read(path)) !== null
    },
    async size(path: string): Promise<number | null> {
      const bytes = await this.read(path)
      return bytes ? bytes.byteLength : null
    },
    async remove(): Promise<void> {},
    async listDirectory(): Promise<string[]> {
      return []
    },
    async usage(): Promise<StorageUsage | null> {
      return null
    },
  }
}

async function readWorld(job: Job): Promise<Uint8Array | null> {
  if (job.worldZip) return readFile(job.worldZip).catch(() => null)
  if (!job.worldUrl) return null
  try {
    const response = await fetch(job.worldUrl, {
      headers: job.authToken ? { Authorization: `Bearer ${job.authToken}` } : {},
    })
    if (!response.ok) return null
    return new Uint8Array(await response.arrayBuffer())
  } catch {
    return null
  }
}

// The one line that decides where a bake's output lands. Everything above it
// is identical in both deployments, which is the property worth protecting:
// the artifacts must be byte-identical wherever the bake ran.
function artifactStoreFor(job: Job): ArtifactStore | null {
  if (job.artifactsDir) return createFsArtifactStore(job.artifactsDir)
  if (job.artifactsUrl) {
    const base = job.artifactsUrl
    return createHttpArtifactStore({ resolveBase: async () => base, authToken: job.authToken })
  }
  return null
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
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
    process.stdout.write(`${JSON.stringify({ pipelineVersion: amplificationPipelineVersion() })}\n`)
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
  const result = await runAmplification({
    elevation: inputs.elevations,
    macroWidth: inputs.width,
    macroHeight: inputs.height,
    factor: job.stage,
    seed: inputs.detailSeed,
    erosionRounds: job.erosionRounds,
    erosionStrength: inputs.erosionControls.strength,
    drainageRefresh: inputs.erosionControls.refresh,
    precipitation: inputs.climate?.data,
    climateResX: inputs.climate?.resX,
    climateResY: inputs.climate?.resY,
    riverDensity: inputs.erosionControls.riverDensity,
  }, (phase, fraction) => {
    const percent = Math.floor(fraction * 100)
    if (percent === lastPercent) return
    lastPercent = percent
    process.stderr.write(`${JSON.stringify({ phase, percent })}\n`)
  })

  const durationMs = Date.now() - started
  const store = artifactStoreFor(job)
  if (!store) fail('neither artifactsDir nor artifactsUrl was given')
  // ROUNDS BELONGS IN THE VERSION. The client hashes
  // `{...AMPLIFY_CONSTANTS, rounds}` (see WorldMapScreen), and it must: the
  // round budget changes the terrain, so two bakes that differ only in it are
  // different artifacts. Leaving it out here produced a version the client
  // would never look for — bakes succeeded, artifacts appeared, and not one
  // was ever used.
  const pipelineVersion = amplificationPipelineVersion(job.erosionRounds)
  const key = { worldId: inputs.worldId, pipelineVersion, stage: String(job.stage) }
  const stored = await writeAmplificationArtifact(store, key, {
    elevation: result.elevation,
    width: result.width,
    height: result.height,
    riverPoints: result.rivers.points,
    riverLengths: result.rivers.lengths,
    // Rivers are keyed by the world's own density inside the artifact, so a
    // server bake lands where the browser will look for it.
  }, durationMs, inputs.erosionControls.riverDensity)
  if (!stored) fail('could not write the artifact')

  process.stdout.write(`${JSON.stringify({
    worldId: key.worldId,
    pipelineVersion,
    stage: key.stage,
    width: result.width,
    height: result.height,
    durationMs,
  })}\n`)
}

void main().catch((error: unknown) => fail(String(error)))
