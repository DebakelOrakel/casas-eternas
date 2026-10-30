// A real world's tile levels through the engine (docs/decisions/rust-engine.md,
// fork 5, the full comparison): the tiles the job worker baked, baked again
// on the engine from the same artifacts the worker read (level 1, the level
// above's tiles, the upstream tiles' outflow), must be the same bytes in
// every file. The plan is the engine's on the stored level 1 (the smoke test
// finds it equal to TypeScript's); a sample of each level is baked, spread
// over the plan, the tiles with upstream first. Native build, on one baker
// as a worker holds it; prints the time against the stored `bakeMs`.
//
//   node engine/scripts/realTiles.mjs <world.zip> <artifact store dir> [<tiles per level>]
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [zipPath, storeDir, perLevelArg] = process.argv.slice(2)
if (!zipPath || !storeDir) {
  console.error('usage: node engine/scripts/realTiles.mjs <world.zip> <artifact store dir> [<tiles per level>]')
  process.exit(2)
}
const perLevel = Number(perLevelArg ?? 100)
const CLIENT = fileURLToPath(new URL('../../client', import.meta.url))
const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
// The engine's WASM build, as the browser loads it: the world layer reads
// a save's forcing through it (DEC-0044, fork 7b).
const ENGINE = await import(`${CLIENT}/../engine/dist/wasm/casas-generator.js`)
await ENGINE.default({ module_or_path: await (await import('node:fs/promises')).readFile(`${CLIENT}/../engine/dist/wasm/casas-generator_bg.wasm`) })
const native = (await L('/scripts/engineNative.ts')).loadNativeEngine(fileURLToPath(new URL('../dist/casas-generator.node', import.meta.url)))
const { readWorldInputs } = await L('/src/world/save/loadWorldInputs.ts')
const { artifactKey } = await L('/src/storage/ArtifactStore.ts')
const { meshPipelineVersion, meshLevelStage, readMeshLevelArtifact } = await L('/src/world/meshArtifacts.ts')
const { MESH_TILE_FILES, meshTilePipelineVersion, meshTileStage } = await L('/src/world/meshTileArtifacts.ts')

const inputs = await readWorldInputs(await readFile(zipPath), ENGINE)
if (!inputs) throw new Error(`${zipPath} is not a readable world`)
const { width, height } = inputs
const shape = inputs.kind === 'SphereWorld' ? 'sphere' : 'torus'

// The store read only: key → entry by each entry's meta.json, as the job
// worker's fs store resolves it.
const entries = new Map()
for (const child of await readdir(storeDir)) {
  try {
    const meta = JSON.parse(await readFile(join(storeDir, child, 'meta.json'), 'utf8'))
    if (meta.key) entries.set(`${meta.key.worldId}/${meta.key.pipelineVersion}/${meta.key.stage}`, { dir: child, meta })
  } catch {
    continue
  }
}
// The rounds the job ran with, from its level 1.
const rounds = [...entries.values()].find((e) => e.meta.key.worldId === inputs.worldId && e.meta.key.stage === meshLevelStage(1))?.meta.pipeline.rounds
if (!rounds) throw new Error('level 1 of this world is not in the store')
const entryOf = (key) => entries.get(`${key.worldId}/${key.pipelineVersion}/${key.stage}`) ?? null
const store = {
  async resolve(key) {
    const e = entryOf(key)
    return e ? { key, local: e.dir, files: Object.keys(e.meta.files ?? {}) } : null
  },
  async read(handle, name) {
    try {
      const b = await readFile(join(storeDir, handle.local, name))
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
    } catch {
      return null
    }
  },
}
const tileKey = (t) => artifactKey(inputs.worldId, meshTilePipelineVersion(t.level, rounds), meshTileStage(t))
const tileFile = async (t, name) => new Uint8Array(await readFile(join(storeDir, entryOf(tileKey(t)).dir, name)))
const f32 = (b) => new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4)

const level1 = await readMeshLevelArtifact(store, artifactKey(inputs.worldId, meshPipelineVersion(1, rounds), meshLevelStage(1)), ENGINE)
if (!level1) throw new Error('level 1 of this world is not in the store (or of another pipeline)')
for (const level of [2, 3]) {
  const v = meshTilePipelineVersion(level, rounds)
  if (![...entries.values()].some((e) => e.meta.key.worldId === inputs.worldId && e.meta.key.pipelineVersion === v)) throw new Error(`no level-${level} tile of pipeline ${v} in the store`)
}

// The save as the plan and the bake read it (DEC-0044, fork 7b): its seed
// text and controls, and its own payloads.
const save = {
  seed: inputs.seedText, width, height, shape,
  controls: { alluvium: inputs.erosionControls.alluvium, rockContrast: inputs.erosionControls.rockContrast },
  snapshot: inputs.snapshot ?? undefined, climate: inputs.climate ?? undefined, mesh: inputs.mesh ?? undefined,
}
const plan = native.planTiles(level1.artifact, save)
const stored = plan.filter((p) => entryOf(tileKey(p.tile)))
console.log(`world: ${shape} ${width}×${height}, ${plan.length} tiles planned, ${stored.length} in the store`)

const piece = async (t, field) => {
  const e = entryOf(tileKey(t))
  if (!e) throw new Error(`tile ${meshTileStage(t)} is not in the store`)
  return { tile: t, count: e.meta.nodes, nodes: f32(await tileFile(t, MESH_TILE_FILES.nodes)), [field]: f32(await tileFile(t, MESH_TILE_FILES[field])) }
}
// Spread over the level's stored tiles, those with upstream first.
const sampleOf = (level) => {
  const all = stored.filter((p) => p.tile.level === level)
  const ordered = [...all.filter((p) => p.upstream.length), ...all.filter((p) => !p.upstream.length)]
  const step = Math.max(1, ordered.length / perLevel)
  return Array.from({ length: Math.min(perLevel, ordered.length) }, (_, i) => ordered[Math.floor(i * step)])
}

const stencilWorkers = 4 // the job worker's enginePool on 8 cores or more
const baker = native.TileBaker.open(level1.artifact, save, stencilWorkers)

let failed = false
const bytesOf = (a) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
for (const level of [2, 3]) {
  const sample = sampleOf(level)
  let engineMs = 0
  let tsMs = 0
  let differ = 0
  for (const p of sample) {
    const pieces = level === 2 ? null : await Promise.all(p.parents.map((t) => piece(t, 'z')))
    const upstream = await Promise.all(p.upstream.map((t) => piece(t, 'outflow')))
    const t0 = performance.now()
    const a = baker.bake(p.tile, pieces, upstream, rounds)
    engineMs += performance.now() - t0
    tsMs += entryOf(tileKey(p.tile)).meta.bakeMs
    const want = [[MESH_TILE_FILES.nodes, a.nodes], [MESH_TILE_FILES.triangles, a.triangles], [MESH_TILE_FILES.z, a.z], [MESH_TILE_FILES.role, a.role], [MESH_TILE_FILES.outflow, a.outflow]]
    const wrong = []
    for (const [name, values] of want) if (Buffer.compare(Buffer.from(bytesOf(values)), Buffer.from(await tileFile(p.tile, name))) !== 0) wrong.push(name)
    if (wrong.length) {
      differ++
      failed = true
      console.error(`differs: tile ${meshTileStage(p.tile)} (${wrong.join(', ')})`)
    }
  }
  const withUp = sample.filter((p) => p.upstream.length).length
  console.log(`engine: level ${level} — ${sample.length - differ} of ${sample.length} tiles (${withUp} with upstream) are the job worker's; ${(engineMs / 1000).toFixed(1)} s, the stored bakeMs ${(tsMs / 1000).toFixed(1)} s`)
}

await server.close()
process.exit(failed ? 1 : 0)
