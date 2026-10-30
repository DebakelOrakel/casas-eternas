// A real world through the engine (docs/decisions/rust-engine.md, fork 5,
// the full comparison): a save's history replayed at the history's own
// budget must land on the save's state bit for bit, as the TypeScript
// replay does (world/replay.ts); then the save restored as a load does it,
// rendered, its climate, the refinement and the hydrology made again,
// must give the climate, the refinement, the land fields and the tables
// the save holds. The save is the TypeScript session's, so equal bytes
// are equal to TypeScript. Given the world's level-1 artifact as the job
// worker wrote it (a directory of the artifact store), level 1 is replayed
// too and every file of the artifact compared, with the time against the
// artifact's own `bakeMs`. Native build; prints the time of each part.
//
//   node engine/scripts/realWorld.mjs <world.zip> [<level-1 artifact dir>]
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const [zipPath, level1Dir] = process.argv.slice(2)
if (!zipPath) {
  console.error('usage: node engine/scripts/realWorld.mjs <world.zip> [<level-1 artifact dir>]')
  process.exit(2)
}
const CLIENT = fileURLToPath(new URL('../../client', import.meta.url))
const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
// The engine's WASM build, as the browser loads it: the world layer reads
// a save's forcing through it (DEC-0044, fork 7b).
const ENGINE = await import(`${CLIENT}/../engine/dist/wasm/casas-generator.js`)
await ENGINE.default({ module_or_path: await (await import('node:fs/promises')).readFile(`${CLIENT}/../engine/dist/wasm/casas-generator_bg.wasm`) })
const native = (await L('/scripts/engineNative.ts')).loadNativeEngine(fileURLToPath(new URL('../dist/casas-generator.node', import.meta.url)))
const { openWorld } = await L('/src/world/query.ts')
const { planFromRecipe, replayRefusal } = await L('/src/world/replay.ts')
const { default: JSZip } = await import(`${CLIENT}/node_modules/jszip/lib/index.js`)

const archive = await readFile(zipPath)
const zip = await JSZip.loadAsync(archive)
const world = await openWorld(archive, ENGINE)
if (!world) throw new Error(`${zipPath} is not a readable world`)
const recipe = { seed: world.recipe.seedText, width: world.width, height: world.height, shape: world.kind === 'SphereWorld' ? 'sphere' : 'torus', history: world.recipe.history }
const refusal = replayRefusal(recipe.history, world.recipe.pipeline)
if (refusal) throw new Error(refusal)
const plan = planFromRecipe(recipe)
const epochs = plan.genesis.reduce((a, r) => a + r.epochs, 0) + plan.tectonics.reduce((a, r) => a + r.epochs, 0)
console.log(`world: ${recipe.shape} ${recipe.width}×${recipe.height}, seed ${recipe.seed}, ${plan.genesis.length}+${plan.tectonics.length} runs, ${epochs} steps, pipeline ${world.recipe.pipeline}`)

let failed = false
const fail = (message) => {
  console.error(`differs: ${message}`)
  failed = true
}
const bytes = async (name) => {
  const f = zip.file(name)
  if (!f) throw new Error(`the save has no ${name}`)
  return new Uint8Array(await f.async('uint8array'))
}
const text = async (name) => zip.file(name)?.async('string') ?? null
const same = (a, b) => a.byteLength === b.byteLength && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0
const checkBytes = async (label, name, values) => {
  if (!same(values, await bytes(name))) fail(`${label} (${name})`)
}
const json = (name) => text(name).then((t) => JSON.parse(t))
const timed = async (label, f) => {
  const t0 = performance.now()
  const out = await f()
  console.log(`${label}: ${((performance.now() - t0) / 1000).toFixed(1)} s`)
  return out
}

// THE REPLAY at the history's budget (level 0), against the save's state.
const replay = native.Replay.start(plan, 0, null, null)
await timed(`engine: replay of ${epochs} steps`, () => {
  while (replay.step());
})
const s = replay.snapshot()
if (JSON.stringify(s.state) !== (await text('state.json'))) fail('the snapshot (state.json)')
await checkBytes('the ocean age', 'oceanAge.f64', s.oceanAge.values)
await checkBytes('the mantle', 'mantle.f64', s.mantle.values)
await checkBytes('the lattice', 'lattice.acc.f32', s.latticeAccumulated)
await checkBytes('the lattice', 'lattice.lock.i16', s.latticeLockedEpochs)
await checkBytes('the lattice', 'lattice.class.i8', s.latticeLastClassCode)
for (const [k, f] of [['nodes', 'nodes.f32'], ['connectivity', 'connectivity.bin'], ['z', 'z.f32'], ['column', 'column.bin'], ['ice', 'ice.f32']]) await checkBytes('the mesh', `mesh/${f}`, s.mesh[k])
console.log(`engine: the replay ${failed ? 'differs from' : 'lands on'} the save (${s.mesh.z.length} nodes)`)

// THE STAGES on the save restored as a load restores it.
const f32 = async (name) => new Float32Array((await bytes(name)).slice().buffer)
const field = async (name) => ({ ...(await json(name.replace('.f64', '.json'))), values: new Float64Array((await bytes(name)).slice().buffer) })
const state = JSON.parse(await text('state.json'))
const mesh = {
  count: (await f32('mesh/z.f32')).length, nodes: await f32('mesh/nodes.f32'), connectivity: await bytes('mesh/connectivity.bin'), z: await f32('mesh/z.f32'),
  column: await bytes('mesh/column.bin'), sedimentFlux: await f32('mesh/sedimentFlux.f32'), preErosionZ: await f32('mesh/preErosionZ.f32'), ice: await f32('mesh/ice.f32'),
}
const lattice = { accumulated: await f32('lattice.acc.f32'), lockedEpochs: new Int16Array((await bytes('lattice.lock.i16')).slice().buffer), lastClassCode: new Int8Array((await bytes('lattice.class.i8')).slice().buffer) }
const w = await timed('engine: restore', async () => native.World.restorePlates(recipe.shape, state, await field('oceanAge.f64'), await field('mantle.f64'), lattice, mesh))
await timed('engine: render', () => w.render(1))
const weather = plan.tectonics[plan.tectonics.length - 1].weather
await timed('engine: climate', () => w.climate(weather))
const { refined } = await timed('engine: refinement', () => w.refineClimate(null))
const refinedMeta = await json('refined.json')
const r = refined.refined
for (const { name, file } of refinedMeta.fields) await checkBytes('the refinement', file, r[name] ?? r.reliability?.[name] ?? r.storms?.[name])
if (refinedMeta.enso.periodYears !== r.reliability.ensoPeriodYears || refinedMeta.enso.strength !== r.reliability.ensoStrength) fail('the refinement (ENSO)')
const h = await timed('engine: hydrology', () => w.hydrology(weather.planet ?? null))
if (JSON.stringify(h.waterBodies) !== (await text('layers/waterBodies.json'))) fail('the water bodies (layers/waterBodies.json)')
if (JSON.stringify({ reaches: h.coast.reaches, nodes: Array.from(h.coast.nodes) }) !== (await text('layers/coast.json'))) fail('the coast (layers/coast.json)')
if (h.sedimentBasins.length > 0 && JSON.stringify(h.sedimentBasins) !== (await text('layers/sedimentBasins.json'))) fail('the sediment basins (layers/sedimentBasins.json)')
const climate = w.climatePayload()
for (const { name, file } of (await json('climate.json')).fields) await checkBytes('the climate', file, climate[name])
const land = w.landPayload()
for (const k of ['biome', 'koppen', 'waterTable', 'discharge', 'lakeBody']) {
  const file = (await json('manifest.json')).mesh.files[k]
  if (file) await checkBytes('the land fields', file, land[k])
}
console.log(`engine: the stages ${failed ? 'differ from' : 'give'} the save's climate, refinement, land fields and tables (${h.waterBodies.length} water bodies, ${h.riverGraph.reaches.length} reaches, ${h.coast.reaches.length} coast reaches, ${h.sedimentBasins.length} sediment basins)`)

// LEVEL 1 by replay against the job worker's artifact.
if (level1Dir) {
  const meta = JSON.parse(await readFile(`${level1Dir}/meta.json`, 'utf8'))
  const file = (name) => readFile(`${level1Dir}/${name}`)
  const before = failed
  const replay1 = native.Replay.start(plan, 1, null, null)
  const level = await timed(`engine: level 1 (TypeScript's bake: ${(meta.bakeMs / 1000).toFixed(1)} s)`, () => {
    while (replay1.step());
    return replay1.level()
  })
  // The level's files as the engine writes them (DEC-0044, fork 7b).
  for (const [name, bytes] of Object.entries(native.levelFiles(level))) if (!same(bytes, await file(name))) fail(`level 1 (${name})`)
  console.log(`engine: level 1 ${failed !== before ? 'differs from' : 'is'} the job worker's artifact (${level.count} nodes, ${level.waterBodies.length} water bodies, ${level.graph?.reaches.length ?? 0} reaches)`)
}

await server.close()
process.exit(failed ? 1 : 0)
