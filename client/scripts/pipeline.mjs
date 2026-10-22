// Behaviour checks for the GENERATOR PIPELINE — message ordering, hand-over and
// cache invalidation. The part of the generator neither other harness reaches.
//
//   npm run harness:pipeline
//   node scripts/pipeline.mjs <text>     only the tests whose name holds <text>
//   SPHERE_SEED=c2 node scripts/pipeline.mjs sphere   the runtime's sphere world of another seed
//
// The run ends with each test's wall time, slowest first: the harness's
// cost is where it is spent, and a slow test is otherwise invisible.
//
// golden.mjs asks "given these params, are the fields the same bytes" and calls
// the stage modules directly; roundtrip.mjs asks the same of the save format.
// Neither ever sends a message. Everything between them — which handler clears
// what, what a reset goes back to, whether a stage recomputes after the terrain
// under it moved — was covered by clicking through the editor and remembering to
// try the right sequence. Both worker bugs found on 2026-08-09 lived exactly
// there: an Archean left standing through a load, and a flag carrying two
// meanings. See docs/design/generator-pipeline.md.
//
// This became possible when the pipeline stopped being a worker: pipeline/runtime.ts
// takes its emitter and its engine from the host and touches no browser API, so
// it can be driven straight from node. The engine is the one the browser runs,
// the WASM build in engine/dist (`make engine`), loaded here once for every
// instance (docs/decisions/rust-engine.md).
//
// DELIBERATE DEPARTURES from the browser, stated rather than implied:
//
//   1. The world is 256x128, an eighth of the real one, so a check costs seconds
//      instead of minutes. Crust nucleates differently at that scale (a world this
//      small ends up far more continental) — irrelevant here, where the subject is
//      which handler clears what, but it is why no number in this file should be
//      read as a statement about worlds.
//   2. The engine's world can be made to throw (failSteps): a world wrapped so
//      that its Archean step throws on demand, which is how a test makes a step
//      fail without a hook in the pipeline.
//   3. Everything else is the real code path, including detaching transferred
//      buffers — see the emitter below.
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const CLIENT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })

const W = 256
const H = 128
// Crust does not nucleate before roughly the tenth epoch at any world size, and a
// world with no crust has no rafts to move — every "and now it changed" check
// silently passes on a world that cannot change. Measured at this size: 0% crust
// at epoch 5, 68% by epoch 41, ~5 ms per epoch.
const ARCHEAN_EPOCHS = 20
// The engine's WASM build, as the browser's worker loads it.
const WASM = await import(`${CLIENT}/../engine/dist/wasm/casas-engine.js`)
await WASM.default({ module_or_path: await readFile(`${CLIENT}/../engine/dist/wasm/casas-engine_bg.wasm`) })

let failures = 0
const check = (name, ok, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

// Each test gets its OWN instance: the pipeline's state is module-level by
// design, so sharing one would make every test depend on the order of the tests
// before it — which is the class of bug this harness exists to find, not to
// reproduce. A query suffix gives Vite a distinct module id while the (stateless)
// dependency graph underneath stays cached; reloading everything costs seconds.
let instanceCount = 0
// Every message type this file exercises, checked against the pipeline's own list
// at the end — so a message added to the contract cannot go untested unnoticed.
const dispatchedTypes = new Set()
async function freshPipeline() {
  const rt = await server.ssrLoadModule(`/src/generator/pipeline/runtime.ts?instance=${instanceCount++}`)
  const messages = []
  rt.setEmitter((message, transfer) => {
    // structuredClone with a transfer list DETACHES the originals, exactly as
    // postMessage does across a real worker boundary. Keeping the originals
    // usable would be the friendlier harness and the wrong one: the pipeline
    // compensates for neutering in places (computeEcology copies the carrying
    // capacity out before handing the buffer over, and says so), and a harness
    // that never neuters cannot tell whether that copy is still there.
    messages.push(structuredClone(message, transfer ? { transfer } : undefined))
  })
  // The world can be made to throw (failSteps, departure 2): the host seam is
  // how a test makes an Archean step fail without a hook in the pipeline.
  let stepFault = false
  const wrap = (world) => new Proxy(world, {
    get(target, key) {
      if (key === 'archeanStep') {
        return () => {
          if (stepFault) throw new Error('the harness world refuses')
          return target.archeanStep()
        }
      }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  rt.setEngine({
    version: WASM.version,
    forcingOfSnapshot: WASM.forcingOfSnapshot,
    levelFiles: WASM.levelFiles,
    tileFiles: WASM.tileFiles,
    riverGraphParts: WASM.riverGraphParts,
    World: {
      genesis: (...args) => wrap(WASM.World.genesis(...args)),
      restoreArchean: (...args) => wrap(WASM.World.restoreArchean(...args)),
      restorePlates: (...args) => wrap(WASM.World.restorePlates(...args)),
    },
    Replay: {
      start: (...args) => {
        const replay = WASM.Replay.start(...args)
        return { progress: () => replay.progress(), step: () => replay.step(), world: () => wrap(replay.world()), free: () => replay.free() }
      },
    },
    Preview: WASM.Preview,
  })
  return {
    dispatch: (message) => {
      dispatchedTypes.add(message.type)
      rt.dispatch(message)
    },
    failSteps: (on) => { stepFault = on },
    messages,
    count: (type) => messages.filter((m) => m.type === type).length,
    // The tectonics redraw once per epoch while they tick (those carry
    // `intermediate`) and once after the stop (that one does not) — so a
    // settled render is how a run says it is done.
    settledRenders: () => messages.filter((m) => m.type === 'rendered' && !m.intermediate).length,
    last: (type) => messages.filter((m) => m.type === type).at(-1),
    types: () => messages.map((m) => m.type),
  }
}

const hash = (buffer) => createHash('sha256').update(new Uint8Array(buffer)).digest('hex').slice(0, 16)

// Waits for a condition rather than a fixed delay: renders are async, and a
// sleep long enough to be reliable on a loaded machine is long enough to make
// the whole harness useless.
async function until(predicate, { timeout = 20000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms))

// "Stopped" is not "quiet". A render already in flight when `stop` arrives still
// lands after it, so reading the last message too early compares against a world
// one epoch older than the one on screen — which made two checks here pass by
// luck before this existed. Every observation taken AFTER stopping something
// waits for the stream to go still first.
async function quiet(p, ms = 250) {
  let seen = -1
  while (seen !== p.messages.length) {
    seen = p.messages.length
    await new Promise((r) => setTimeout(r, ms))
  }
}

// The land share the Archean aims at, for every world this file grows: the
// screen's 34 % (archean/archeanLand.ts) climbs to its aim by epoch 160, and
// a harness world runs tens of epochs; its checks were written against the
// mostly-land world the unthrottled nucleation made of it (rivers long
// enough to have courses, coasts with every type). An aim of 85 % gives the
// hydrology's world its land in twenty epochs.
const ARCHEAN_INIT = { type: 'genesisInit', seed: 'harness', width: W, height: H, renderOptions: {}, epochIntervalMs: 10, mantleDiffusion: 2, landShare: 0.85 }

// A world the way the program makes one: an Archean run, then the hand-over.
async function growWorld(p, { epochs = ARCHEAN_EPOCHS } = {}) {
  p.dispatch({ ...ARCHEAN_INIT })
  await until(() => p.count('rendered') >= 1, { label: 'the first Archean render' })
  p.dispatch({ type: 'genesisStart' })
  await until(() => p.count('genesisStatus') >= epochs, { label: `${epochs} Archean epochs` })
  p.dispatch({ type: 'genesisStop' })
  await quiet(p)
  const before = p.count('rendered')
  p.dispatch({ type: 'genesisFinalize' })
  await until(() => p.count('rendered') > before, { label: 'the hand-over render' })
  await quiet(p)
}

// The world's epoch now, read in this macrotask: the serialized world's,
// whose message is taken off the list again (a test counts worldData).
// An epoch does not yield here (no render pool), so between two macrotasks
// no epoch is half done and this is the epoch a stop dispatched right
// after it settles on.
function worldEpoch(p) {
  return worldDataOf(p).snapshot.epoch
}

// The tectonics for n epochs, then the stop and its settled render. Since
// the coupled history (phase 5.1) every epoch erodes: this is how a harness
// world gets its eroded terrain. Counted in EPOCHS, read off the world
// between two epochs (worldEpoch), not in pictures — those come every
// HISTORY_DEFAULTS.renderEvery-th epoch, which made "n pictures" about 3n − 2
// epochs, a different number from run to run. Exactly n here, since the
// epochs do not yield; with a render pool it would be n plus the epoch in
// flight at the stop. Returns the epoch the world settled on.
async function runEpochs(p, n) {
  const settledBefore = p.settledRenders()
  const target = worldEpoch(p) + n
  p.dispatch({ type: 'tectonicsStart' })
  await until(() => worldEpoch(p) >= target, { label: `${n} eroding epoch${n === 1 ? '' : 's'}`, timeout: 180000 * n })
  p.dispatch({ type: 'tectonicsStop' })
  await until(() => p.settledRenders() > settledBefore, { label: 'the settled render', timeout: 180000 })
  await quiet(p)
  return p.last('rendered').epoch
}

// EXACTLY one epoch: the start runs its first epoch with the gesture, the
// stop right behind it clears the interval before a second could start,
// and that one epoch renders as the settled one. For the determinism test,
// where two worlds must have run the same number of epochs.
async function runOneEpoch(p) {
  const settledBefore = p.settledRenders()
  p.dispatch({ type: 'tectonicsStart' })
  p.dispatch({ type: 'tectonicsStop' })
  await until(() => p.settledRenders() > settledBefore, { label: 'the settled render', timeout: 180000 })
  await quiet(p)
}

// worldData (what serializeWorld emits) -> restoreWorld (what load sends back).
// Deep-copied per use: the harness detaches transferred buffers, so a fixture
// handed out twice would arrive empty the second time. The mesh rides along
// as the screen sends it: a tectonic save always carries it, and it is the
// only terrain a save holds (DEC-0036, the save step).
const asRestore = (worldData, seed = 'harness') => {
  const w = structuredClone(worldData)
  return {
    type: 'restoreWorld',
    seed,
    snapshot: w.snapshot,
    oceanAge: w.oceanAge,
    mantle: w.mantle,
    archean: w.archean,
    mesh: w.mesh,
    lattice: { accumulated: w.latticeAccumulated, lockedEpochs: w.latticeLockedEpochs, lastClassCode: w.latticeLastClassCode },
  }
}

// The archive the screen writes from a worldData (and the hydrology's
// water bodies, which the screen keeps from hydrologyData), through the
// real writer — GeneratorScreen.serializeWorld's assembly.
async function archiveOf(worldData, hydrology = null) {
  const A = await server.ssrLoadModule('/src/world/save/worldArchive.ts')
  const w = structuredClone(worldData)
  const f32 = (b) => (b ? new Float32Array(b) : null)
  return A.writeWorldArchive({
    kind: 'tectonic', width: W, height: H, yaml: 'apiVersion: casas-eternas/v1alpha1\nkind: FlatWorld\nmetadata:\n  name: harness\n  uid: 0192abcd-0000-8000-8000-0000000000aa\nspec:\n  seed: harness\n', generatorVersion: 'harness', preview: null,
    snapshot: w.snapshot, mantle: w.mantle, latticeAccumulated: w.latticeAccumulated, latticeLockedEpochs: w.latticeLockedEpochs, latticeLastClassCode: w.latticeLastClassCode,
    oceanAge: w.oceanAge, mesh: w.mesh,
    fields: {
      climate: w.climate ? { cells: w.climate.cells, spacingM: w.climate.spacingM, seaLevelTemperature: f32(w.climate.seaLevelTemperature), precipitation: f32(w.climate.precipitation), seasonalAmplitude: f32(w.climate.seasonalAmplitude), monsoonIndex: f32(w.climate.monsoonIndex) } : null,
      land: w.land ? { count: w.land.count, biome: new Uint8Array(w.land.biome), koppen: new Uint8Array(w.land.koppen), waterTable: f32(w.land.waterTable), discharge: f32(w.land.discharge), lakeBody: w.land.lakeBody ? new Int32Array(w.land.lakeBody) : null } : null,
      refined: null, waterBodies: hydrology ? structuredClone(hydrology.waterBodies) : null, coast: null, sedimentBasins: null,
    },
  })
}

// The physical raster the session holds (requestElevationField's `raw`).
async function rawElevation(p) {
  const before = p.count('elevationField')
  p.dispatch({ type: 'requestElevationField' })
  await until(() => p.count('elevationField') > before, { label: 'the elevation field' })
  return p.last('elevationField').raw
}

// The world as serializeWorld answers it, taken off the message list.
function worldDataOf(p) {
  p.dispatch({ type: 'serializeWorld' })
  const data = p.messages.pop()
  if (data?.type !== 'worldData') throw new Error(`serializeWorld answered ${data?.type}`)
  return data
}

const TESTS = []
const test = (name, run) => TESTS.push({ name, run })
// The runtime's sphere world's seed (see the sphere tests) and the tests to
// run (all, or those whose name holds the first argument).
const SPHERE_SEED = process.env.SPHERE_SEED ?? 'c4'
const ONLY = process.argv[2] ?? ''

// ------------------------------------------------------------- the stage table

test('the stage table agrees with the code around it', async () => {
  // The table (pipeline/stages.ts) is declared before anything reads it, so these
  // are what keep it honest in the meantime: every edge, every field name and
  // every control checked against the modules that already exist. A declaration
  // nobody reads and nobody checks is a comment with syntax highlighting.
  const [stages, fields, spec] = await Promise.all([
    server.ssrLoadModule('/src/generator/pipeline/stages.ts'),
    server.ssrLoadModule('/src/world/save/fieldSpec.ts'),
    server.ssrLoadModule('/src/world/save/worldSpec.ts'),
  ])
  const ids = stages.STAGES.map((s) => s.id)

  const unknownEdges = stages.STAGES.flatMap((s) => s.dependsOn.filter((d) => !ids.includes(d)).map((d) => `${s.id} -> ${d}`))
  check('every dependency names a stage', unknownEdges.length === 0, unknownEdges.join(', '))

  const cyclic = ids.filter((id) => stages.downstreamOf(id).includes(id))
  check('the chain is acyclic', cyclic.length === 0, cyclic.join(', '))

  // Declaration order must be a topological order, so that "downstream of" and
  // "further down the table" are the same thing — the panel order assumes it.
  const outOfOrder = stages.STAGES.flatMap((s, i) => s.dependsOn.filter((d) => ids.indexOf(d) >= i).map((d) => `${s.id} before ${d}`))
  check('the table is in dependency order', outOfOrder.length === 0, outOfOrder.join(', '))

  const badOutputs = []
  for (const s of stages.STAGES) {
    for (const name of s.outputs) {
      try {
        fields.fieldSpec(name)
      } catch {
        badOutputs.push(`${s.id}: ${name}`)
      }
    }
  }
  check('every declared output is a registered world field', badOutputs.length === 0, badOutputs.join(', '))

  // Identity, not equality: the table must reference the SAME InputParam object
  // the save's spec does. A copy would satisfy a value comparison and then drift.
  const byPath = new Map(spec.WORLD_SPEC_FIELDS.map((f) => [f.path, f.input]))
  const adrift = []
  for (const s of stages.STAGES) {
    for (const [key, input] of Object.entries(s.inputs)) {
      if (!input.inSpec) continue
      if (byPath.get(`${s.id}.${key}`) !== input) adrift.push(`${s.id}.${key}`)
    }
  }
  check('every saved control sits in the spec under its own stage', adrift.length === 0, adrift.join(', '))

  const orphanGroups = [...new Set(spec.WORLD_SPEC_FIELDS.map((f) => f.path.split('.')[0]))].filter((g) => !ids.includes(g))
  check('every spec group names a stage', orphanGroups.length === 0, orphanGroups.join(', '))

  // The reset taxonomy, asserted on the real table rather than in prose.
  check('resetting ecology reaches only finishing and migration', String(stages.downstreamOf('ecology')) === 'finishing,migration', String(stages.downstreamOf('ecology')))
  // Climate before erosion since the stage-2 coupling: the order below IS
  // the pipeline order, so the string asserts it too.
  check('resetting tectonics reaches every later stage', String(stages.downstreamOf('tectonics')) === 'climate,erosion,hydrology,ecology,finishing,migration', String(stages.downstreamOf('tectonics')))
  check('a climate change invalidates the carved terrain', stages.downstreamOf('climate').includes('erosion'), String(stages.downstreamOf('climate')))
  check('nothing is downstream of migration', stages.downstreamOf('migration').length === 0)
})

// ---------------------------------------------------------------- the Archean

test('the Archean runs, reports and stops', async () => {
  const p = await freshPipeline()
  p.dispatch({ ...ARCHEAN_INIT })
  await until(() => p.count('rendered') >= 1, { label: 'the first render' })
  check('archeanInit renders and reports status', p.count('rendered') >= 1 && p.count('genesisStatus') >= 1)

  p.dispatch({ type: 'genesisStart' })
  await until(() => p.count('genesisStatus') >= 5, { label: 'five epochs' })
  p.dispatch({ type: 'genesisStop' })
  await settle(150)
  const settled = p.count('genesisStatus')
  await settle(300)
  check('archeanStop actually stops the clock', p.count('genesisStatus') === settled, `${settled} -> ${p.count('genesisStatus')}`)
})

test('archeanReset rebuilds the same world from the same seed', async () => {
  const a = await freshPipeline()
  a.dispatch({ ...ARCHEAN_INIT })
  await until(() => a.count('rendered') >= 1, { label: 'the first render' })
  const first = hash(a.last('rendered').elevation)

  a.dispatch({ type: 'genesisStart' })
  await until(() => a.count('genesisStatus') >= ARCHEAN_EPOCHS, { label: `${ARCHEAN_EPOCHS} epochs` })
  a.dispatch({ type: 'genesisStop' })
  await quiet(a)

  const drifted = hash(a.last('rendered').elevation)
  check('stepping the Archean changes the world', drifted !== first)

  const before = a.count('rendered')
  a.dispatch({ type: 'resetStage', stage: 'genesis' })
  await until(() => a.count('rendered') > before, { label: 'the reset render' })
  await quiet(a)
  check('archeanReset returns to epoch 0 exactly', hash(a.last('rendered').elevation) === first)
})

// ------------------------------------------------------------------ the sphere

// A SPHERE world's first step (DEC-0035, step 4d2): the Archean on a
// sphereDomain — mantle, plumes, nucleation, rafts. Two halves. Through the
// runtime at this harness's size: the shape reaches the worker, the
// Archean steps, pauses and resets on the sphere. Then the stage modules
// directly at the world's real size, sphere against torus for one seed:
// the numbers that say whether the sphere makes a plausible world.
const allFinite = (field) => field.every((v) => Number.isFinite(v))
// A SCALAR raster at the poles of a sphere's chart: the median step across
// the pole (cell x to x + resX / 2 in the first row, about one row apart)
// against the median step to the next row. About 1 for a field continuous
// at the pole; far more for one that is not.
const acrossPoleRatio = (field, resX, resY) => {
  const median = (a) => a.sort((p, q) => p - q)[a.length >> 1]
  let worst = 0
  for (const [row, next] of [[0, 1], [resY - 1, resY - 2]]) {
    const across = []
    const down = []
    for (let x = 0; x < resX; x++) {
      across.push(Math.abs(field[row * resX + x] - field[row * resX + ((x + resX / 2) % resX)]))
      down.push(Math.abs(field[row * resX + x] - field[next * resX + x]))
    }
    worst = Math.max(worst, median(across) / Math.max(median(down), 1e-9))
  }
  return worst
}

// A field made on a field mesh at the poles of a sphere's climate grid
// (DEC-0036 phase 3): the mesh has no pole row, and the raster's pole row
// is a ring of points 0.35° round the pole, sampled from one smooth field —
// not one value along it, but no star either: neighbouring pixels of the
// ring differ by a small part of what the ring spans. The largest step
// between neighbours of the same `kind` (land with land, sea with sea)
// over the ring's range of that kind, the worse pole; a star (each pixel
// its own value) gives about 1. A range under a hundredth of the field's
// counts as that hundredth (a flat field gives 0).
const ringRoughness = (field, resX, resY, kind) => {
  let lo = Infinity, hi = -Infinity
  for (let i = 0; i < resX * resY; i++) { lo = Math.min(lo, field[i]); hi = Math.max(hi, field[i]) }
  const floor = Math.max(1e-9, 0.01 * (hi - lo))
  let worst = 0
  for (const row of [0, resY - 1]) {
    for (const k of [0, 1]) {
      let rlo = Infinity, rhi = -Infinity, step = 0
      for (let x = 0; x < resX; x++) {
        const i = row * resX + x
        if (kind[i] !== k) continue
        rlo = Math.min(rlo, field[i]); rhi = Math.max(rhi, field[i])
        const j = row * resX + ((x + 1) % resX)
        if (kind[j] === k) step = Math.max(step, Math.abs(field[i] - field[j]))
      }
      if (rhi >= rlo) worst = Math.max(worst, step / Math.max(rhi - rlo, floor))
    }
  }
  return worst
}

// A VECTOR FIELD AT THE POLES of a sphere's climate grid (DEC-0035, fork
// 5). `field` is [u, v] per cell in the cell's own frame (u east, v south,
// the climate's convention). Each cell's vector is turned into 3D; then, at
// each pole row, the step ACROSS the pole (cell x to cell x + resX / 2, one
// row apart) is compared with the step to the next row (also one row
// apart). A field that is continuous at the pole has the two of one size;
// a ring of vectors that is the same in each cell's frame (radial, or
// swirling) has a step across the pole of twice its size and almost no
// step to the next row. Returns the worse pole's ratio of the medians.
// `use` (optional) leaves out cells (land, for the currents).
function poleVectorJump(field, resX, resY, use = () => true) {
  const at = (x, y) => {
    const i = y * resX + x
    const lam = (2 * Math.PI * (x + 0.5)) / resX
    const th = (Math.PI * (y + 0.5)) / resY
    const u = field[i * 2]
    const v = field[i * 2 + 1]
    return [-Math.sin(lam) * u + Math.cos(th) * Math.cos(lam) * v, Math.cos(lam) * u + Math.cos(th) * Math.sin(lam) * v, -Math.sin(th) * v]
  }
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
  const median = (a) => { const s = [...a].sort((p, q) => p - q); return s[s.length >> 1] }
  let worst = 0
  for (const [row, next] of [[0, 1], [resY - 1, resY - 2]]) {
    const across = []
    const down = []
    for (let x = 0; x < resX; x++) {
      if (!use(row * resX + x)) continue
      const far = (x + resX / 2) % resX
      if (use(row * resX + far)) across.push(dist(at(x, row), at(far, row)))
      if (use(next * resX + x)) down.push(dist(at(x, row), at(x, next)))
    }
    if (across.length === 0 || down.length === 0) continue
    worst = Math.max(worst, median(across) / Math.max(median(down), 1e-9))
  }
  return worst
}

test('a sphere world runs its Archean through the runtime', async () => {
  const p = await freshPipeline()
  p.dispatch({ ...ARCHEAN_INIT, shape: 'sphere' })
  await until(() => p.count('rendered') >= 1, { label: 'the first sphere render' })
  const first = p.last('rendered')
  const firstMantle = hash(first.mantle)
  const t = await freshPipeline()
  t.dispatch({ ...ARCHEAN_INIT })
  await until(() => t.count('rendered') >= 1, { label: 'the first torus render' })
  check('the shape reaches the worker (a sphere mantle is not the torus\'s)', hash(t.last('rendered').mantle) !== firstMantle)

  p.dispatch({ type: 'genesisStart' })
  await until(() => p.count('genesisStatus') >= ARCHEAN_EPOCHS, { label: `${ARCHEAN_EPOCHS} sphere epochs` })
  p.dispatch({ type: 'genesisStop' })
  await quiet(p)
  const r = p.last('rendered')
  const mantle = new Float32Array(r.mantle)
  const status = p.last('genesisStatus')
  check('the sphere Archean steps', status.epoch >= ARCHEAN_EPOCHS - 1 && hash(r.mantle) !== firstMantle, `epoch ${status.epoch}`)
  check('its mantle, craton age and elevation are finite', allFinite(mantle) && allFinite(new Float32Array(r.cratonAge)) && allFinite(new Float32Array(r.elevation)))
  check('its mantle overlay is continuous across each pole (the field is on its mesh, no pole rows)', acrossPoleRatio(mantle, r.mantleResX, r.mantleResY) < 2, `ratio ${acrossPoleRatio(mantle, r.mantleResX, r.mantleResY).toFixed(2)}`)
  check('its land fraction and gauges are in range', r.landFraction >= 0 && r.landFraction <= 1 && status.stabilisedFraction >= 0 && status.stabilisedFraction <= 1 && Number.isFinite(status.crustFraction), `land ${r.landFraction.toFixed(3)}, stabilised ${status.stabilisedFraction.toFixed(3)}, ${status.cratonCount} cratons`)
  check('the plumes lie on the sphere', r.hotspots.every((h) => h.x >= 0 && h.x < W && h.y >= 0 && h.y <= H), `${r.hotspots.length} plumes`)

  const before = p.count('rendered')
  p.dispatch({ type: 'resetStage', stage: 'genesis' })
  await until(() => p.count('rendered') > before, { label: 'the sphere reset render' })
  await quiet(p)
  check('a reset makes the sphere again, not a torus', hash(p.last('rendered').mantle) === firstMantle)
})

// THE HISTORY ON THE SPHERE (DEC-0035, step 4d5): the coupled epoch —
// plates, node motion, rebuild and remesh, the erosion engine, the column,
// the climate per epoch, the ice, the coast, the flexure — on a sphere
// world. Through the runtime first: the hand-over and the tectonics step's
// eroding epochs, then the save's mesh read back and checked on the globe.
test('a sphere world runs its history through the runtime', async () => {
  const p = await freshPipeline()
  // The seed: one whose world has a polar sea and plain rivers (re-chosen
  // 2026-10-11 with the mantle on its field mesh; 'harness' then failed the
  // climate's pole-row checks, see DEC-0036's phase 1 status).
  p.dispatch({ ...ARCHEAN_INIT, shape: 'sphere', seed: SPHERE_SEED })
  await until(() => p.count('rendered') >= 1, { label: 'the first sphere render' })
  p.dispatch({ type: 'genesisStart' })
  await until(() => p.count('genesisStatus') >= ARCHEAN_EPOCHS, { label: `${ARCHEAN_EPOCHS} sphere epochs` })
  p.dispatch({ type: 'genesisStop' })
  await quiet(p)
  const handed = p.count('rendered')
  p.dispatch({ type: 'genesisFinalize' })
  await until(() => p.count('rendered') > handed, { label: 'the sphere hand-over render' })
  await quiet(p)
  const epoch0 = p.last('rendered').epoch
  const EPOCHS = 7
  await runEpochs(p, EPOCHS)
  const r = p.last('rendered')
  const elevation = new Float32Array(r.elevation)
  check('the sphere\'s eroding epochs run and render', r.epoch >= epoch0 + EPOCHS && !p.messages.some((m) => m.type === 'error'), `epoch ${epoch0} → ${r.epoch}`)
  check('its rendered terrain is finite, with land and sea', allFinite(elevation) && elevation.some((v) => v > 0) && elevation.some((v) => v <= 0) && Number.isFinite(r.landFraction), `land ${r.landFraction.toFixed(3)}`)
  // The seam: the step across x = 0 / W is a step like any other in its
  // row — on average over the rows, against the average step between any
  // two neighbouring columns. A seam is in every row; the largest single
  // step is the terrain's steepest slope, which may cross x = 0 (2026-10-12,
  // the history's climate at the nodes: a continental slope there, 0.14
  // across the seam against 0.12 inside, the mesh's nodes as steep).
  let seam = 0
  let inner = 0
  let seamMax = 0
  let innerMax = 0
  const RXe = r.elevationResX
  for (let y = 0; y < r.elevationResY; y++) {
    const row = elevation.subarray(y * RXe, (y + 1) * RXe)
    const d = Math.abs(row[0] - row[RXe - 1])
    seam += d
    seamMax = Math.max(seamMax, d)
    for (let x = 1; x < RXe; x++) {
      const e = Math.abs(row[x] - row[x - 1])
      inner += e
      innerMax = Math.max(innerMax, e)
    }
  }
  seam /= r.elevationResY
  inner /= r.elevationResY * (RXe - 1)
  check('the rendered terrain has no seam at x = 0 / W', seam <= 2 * inner, `mean step across the seam ${seam.toFixed(4)}, inside ${inner.toFixed(4)}; the largest ${seamMax.toFixed(3)} / ${innerMax.toFixed(3)}`)
  const before = p.count('worldData')
  p.dispatch({ type: 'serializeWorld' })
  await until(() => p.count('worldData') > before, { label: 'the serialized sphere world' })
  const saved = p.last('worldData')
  const [D, MS] = await Promise.all([server.ssrLoadModule('/src/generator/core/domain.ts'), server.ssrLoadModule('/src/generator/mesh/meshSerial.ts')])
  const z = new Float32Array(saved.mesh.z)
  const mesh = MS.decodeMesh(D.sphereDomain(W, H), { count: z.length, nodes: new Float32Array(saved.mesh.nodes), connectivity: new Uint8Array(saved.mesh.connectivity) })
  const errors = mesh.validate()
  check('the saved mesh is a valid triangulation of the globe (Euler, winding, Delaunay, cells to 4πR²)', errors.length === 0 && allFinite(z), `${mesh.aliveVertices} nodes; ${errors.slice(0, 2).join('; ')}`)

  // The load: the saved sphere world restored in a fresh pipeline, its
  // shape from the save's kind (the snapshots do not carry it), renders the
  // world that was saved and goes on as the saved one does — one epoch on
  // each gives the same bytes. Restored as a torus (the shape left out) it
  // must not: the check would not see a lost shape otherwise.
  const savedRender = hash(r.elevation)
  const restore = (shape) => {
    const w = structuredClone(saved)
    return { ...asRestore(saved), ...(shape ? { shape } : {}), mesh: { nodes: w.mesh.nodes, connectivity: w.mesh.connectivity, z: w.mesh.z, column: w.mesh.column } }
  }
  const q = await freshPipeline()
  q.dispatch(restore('sphere'))
  await until(() => q.count('rendered') >= 1, { label: 'the sphere load render' })
  await quiet(q)
  check('a loaded sphere world renders the world that was saved', hash(q.last('rendered').elevation) === savedRender && !q.messages.some((m) => m.type === 'error'))
  // And it goes on: an epoch on the loaded world runs on the sphere and
  // renders a sane globe. Not the saved one's bytes: a restore runs its
  // climate on its first epoch, an unbroken run only every climateEvery-th
  // (coupledEpoch.ts, TerrainState.weather) — the two agree only when the
  // next epoch is a climate epoch anyway.
  const loadedEpoch = q.last('rendered').epoch
  await runOneEpoch(q)
  const next = q.last('rendered')
  const nextElevation = new Float32Array(next.elevation)
  check('a loaded sphere world goes on (an epoch, finite, land and sea, no failure)', next.epoch > loadedEpoch && allFinite(nextElevation) && nextElevation.some((v) => v > 0) && nextElevation.some((v) => v <= 0) && !q.messages.some((m) => m.type === 'error' || m.type === 'stageFailed'), `epoch ${loadedEpoch} → ${next.epoch}`)
  // Loaded without its shape the save is not the world that was saved: the
  // restore throws (a torus cannot rebuild the globe's mesh) or renders
  // something else. No epoch is run on it — a torus stepping the globe's
  // plates throws inside the tick, out of reach of any check.
  let differs = false
  try {
    const t2 = await freshPipeline()
    t2.dispatch(restore(undefined))
    await until(() => t2.count('rendered') >= 1 || t2.messages.some((m) => m.type === 'error' || m.type === 'stageFailed'), { label: 'the shapeless load' })
    await quiet(t2)
    differs = t2.messages.some((m) => m.type === 'error' || m.type === 'stageFailed') || hash(t2.last('rendered').elevation) !== savedRender
  } catch {
    differs = true
  }
  check('mutation: the same save loaded without its shape does not go on the same way', differs)
})

// THE CLIMATE STEP ON THE SPHERE (DEC-0035, step 4e): what the step runs —
// the climate, its refinement, the rivers, lakes, coast, ice, basins and
// the ground water — through the runtime on a sphere world after its
// history.
// A sphere world through the runtime up to the climate step's end: its
// Archean, the hand-over, eleven eroding epochs, climateRun, the refinement
// and hydrologyRun — what the climate step's test and the ecology's stand on.
// Built once and shared by the two tests that read it (the climate step's
// and the ecology step's): neither changes the world — the climate test
// reads the answers and serializes, the ecology test adds its own stage's
// answers — so the second does not pay the eleven epochs, the climate, the
// refinement and the hydrology again (~85 s). Run alone, either builds it.
let sphereFixture = null
function sphereThroughHydrology() {
  sphereFixture ??= buildSphereThroughHydrology()
  return sphereFixture
}
async function buildSphereThroughHydrology() {
  const p = await freshPipeline()
  // The seed: one whose world has a polar sea and plain rivers (re-chosen
  // 2026-10-11 with the mantle on its field mesh; 'harness' then failed the
  // climate's pole-row checks, see DEC-0036's phase 1 status).
  p.dispatch({ ...ARCHEAN_INIT, shape: 'sphere', seed: SPHERE_SEED })
  await until(() => p.count('rendered') >= 1, { label: 'the first sphere render' })
  p.dispatch({ type: 'genesisStart' })
  await until(() => p.count('genesisStatus') >= ARCHEAN_EPOCHS, { label: `${ARCHEAN_EPOCHS} sphere epochs` })
  p.dispatch({ type: 'genesisStop' })
  await quiet(p)
  const handed = p.count('rendered')
  p.dispatch({ type: 'genesisFinalize' })
  await until(() => p.count('rendered') > handed, { label: 'the sphere hand-over render' })
  await quiet(p)
  // Eleven epochs: what this seed was chosen on, when runEpochs counted
  // four pictures (epochs 1, 4, 7, 10) and the stop then came after the
  // eleventh had begun. At ten, two climate checks once failed on this seed
  // (the polar currents, the monsoon's seam; 2026-10-11): both asked a
  // property of the world's land and sea, not of the climate. Since
  // 2026-10-12 they ask it where it applies (the polar seas' rings, the
  // seam against the steps beside it) and pass at 9 to 12 epochs and on
  // the seeds c2, c5 and c6.
  await runEpochs(p, 11)
  p.dispatch({ type: 'climateRun', temperatureOffset: 0, temperatureContrast: 1, humidity: 1, equatorOffset: 0 })
  await until(() => p.count('climateData') >= 1, { label: 'the sphere climate' })
  p.dispatch({ type: 'climateRefine' })
  await until(() => p.count('climateRefined') >= 1 && p.messages.some((m) => m.type === 'climateData' && m.refined), { label: 'the sphere refinement', timeout: 120000 })
  p.dispatch({ type: 'hydrologyRun' })
  await until(() => p.count('hydrologyData') >= 1, { label: 'the sphere hydrology', timeout: 120000 })
  await quiet(p)
  return p
}

test('a sphere world runs the climate step through the runtime: finite, pole-handled, seamless, rivers that flow', async () => {
  const p = await sphereThroughHydrology()
  const errors = p.messages.filter((m) => m.type === 'error')
  check('climateRun, the refinement and hydrologyRun answer on a sphere world, no error', errors.length === 0, errors.map((e) => e.message).join('; '))

  const c0 = p.messages.find((m) => m.type === 'climateData' && !m.refined)
  const cr = p.messages.filter((m) => m.type === 'climateData' && m.refined).at(-1)
  const r = p.last('climateRefined')
  const h = p.last('hydrologyData')
  const RX = r.resX
  const RY = r.resY
  const n = RX * RY
  const f32 = (b) => new Float32Array(b)

  // Finite, every field the three answers carry.
  const fields = {
    ...Object.fromEntries(['temperature', 'wind', 'currents', 'currentAnomaly', 'precipitation', 'seasonalAmplitude', 'monsoonIndex'].flatMap((k) => [[`climate.${k}`, f32(c0[k])], [`refined.${k}`, f32(cr[k])]])),
    ...Object.fromEntries(['temperature', 'precipitation', 'fog', 'foehn', 'rainVariability', 'ensoPattern', 'salinity', 'deepWater', 'cyclone', 'tornado', 'blizzard', 'dust', 'thunder', 'pressure', 'wind', 'currents', 'currentAnomaly', 'upwelling'].map((k) => [`months.${k}`, f32(r[k])])),
    ...Object.fromEntries(['lakeDepth', 'discharge', 'waterLevel', 'iceThickness', 'precipitationEffective', 'riverPoints'].map((k) => [`hydrology.${k}`, f32(h[k])])),
  }
  const notFinite = Object.entries(fields).filter(([, f]) => f.length === 0 || !allFinite(f)).map(([k]) => k)
  check(`every field of the climate, the refinement and the hydrology is whole and finite (${Object.keys(fields).length} fields)`, notFinite.length === 0 && Number.isFinite(r.ensoPeriodYears) && Number.isFinite(h.maxDischarge), notFinite.join(', '))

  // The pole rows, its land and its sea each (a row may hold both).
  const landC = new Uint8Array(n)
  const precipA = f32(cr.precipitation)
  for (let i = 0; i < n; i++) landC[i] = precipA[i] >= 0 ? 1 : 0
  // The months' temperature is the year's mean plus the cycle and the
  // overturning's warmth: the parts the refinement adds are what is held
  // smooth. (The mean carries each cell's own lapse over its ground.)
  const cycle = f32(r.temperature).map((v, k) => v - f32(cr.temperature)[k % n])
  const scalars = {
    pressure: [f32(r.pressure), r.months], cycle: [cycle, r.months], precipitation: [f32(r.precipitation), r.months],
    salinity: [f32(r.salinity), 1], deepWater: [f32(r.deepWater), 1], upwelling: [f32(r.upwelling), 1], currentAnomaly: [f32(r.currentAnomaly), 1],
    fog: [f32(r.fog), 1], foehn: [f32(r.foehn), 1], rainVariability: [f32(r.rainVariability), 1], ensoPattern: [f32(r.ensoPattern), 1],
    cyclone: [f32(r.cyclone), 1], tornado: [f32(r.tornado), 1], blizzard: [f32(r.blizzard), 1], dust: [f32(r.dust), 1], thunder: [f32(r.thunder), 1],
    'climate.seasonalAmplitude': [f32(c0.seasonalAmplitude), 1], 'refined.seasonalAmplitude': [f32(cr.seasonalAmplitude), 1], 'refined.monsoonIndex': [f32(cr.monsoonIndex), 1],
  }
  // Since DEC-0036 phase 3 the static climate, and since phase 5 the whole
  // refinement, are made on the climate's field mesh, which has no pole
  // row: rasterised, a pole row is a ring of points 0.35° round the pole,
  // and a field made from them is not one value along it. Every field is
  // held to be smooth round the pole instead (ringRoughness).
  const across = Object.entries(scalars).map(([k, [f, layers]]) => {
    let worst = 0
    for (let m = 0; m < layers; m++) worst = Math.max(worst, ringRoughness(f.slice(m * n, (m + 1) * n), RX, RY, landC))
    return [k, worst]
  })
  check(`the fields made from the mesh's are smooth round each pole, no star, land and sea apart (the largest step between neighbouring pixels of a pole row: ${across.map(([k, r]) => `${k} ${r.toFixed(3)}`).join(', ')} of the ring's range)`, across.every(([, r]) => r < 0.25))
  // The temperature. The climate's own (the mesh's, rasterised): smooth
  // round each pole — its spread is the ground of the cells round it, a
  // few hundred metres of lapse at a polar range — the largest step
  // between neighbouring pixels under a quarter of the spread or 0.1 °C.
  // The refined year adds the refinement's parts (the cycle and the
  // overturning's warmth carried inland with the wind, on the mesh since
  // phase 4, rasterised), which vary from pixel to pixel: held to under
  // 1 °C a step, the bound the old pole-row check gave the cells' ground.
  const ringSteps = (tf) => {
    let worst = 0, stepAt = 0, spreadAt = 0, maxStep = 0
    for (const row of [0, RY - 1]) {
      for (const k of [0, 1]) {
        let lo = Infinity, hi = -Infinity, step = 0
        for (let x = 0; x < RX; x++) {
          const i = row * RX + x, j = row * RX + ((x + 1) % RX)
          if (landC[i] !== k) continue
          lo = Math.min(lo, tf[i]); hi = Math.max(hi, tf[i])
          if (landC[j] === k) step = Math.max(step, Math.abs(tf[i] - tf[j]))
        }
        if (hi < lo) continue
        maxStep = Math.max(maxStep, step)
        const ratio = step / Math.max(0.25 * (hi - lo), 0.1)
        if (ratio > worst) { worst = ratio; stepAt = step; spreadAt = hi - lo }
      }
    }
    return { worst, stepAt, spreadAt, maxStep }
  }
  const own = ringSteps(f32(c0.temperature))
  const year = ringSteps(f32(cr.temperature))
  check('the temperature round each pole is smooth, no star, land and sea apart (the climate\'s own; the refined year\'s steps under 1 °C)', own.worst < 1 && year.maxStep < 1, `the climate's worst pole: spread ${own.spreadAt.toFixed(3)} °C, step ${own.stepAt.toFixed(3)} °C; the refined year's largest step ${year.maxStep.toFixed(3)} °C`)

  // The vector fields at the poles: one vector field on the globe, not a
  // ring in the cells' frames (poleVectorJump). Each wind and each current
  // the step makes, every month of the refinement's; the currents on the
  // sea only. Measured 2026-10-11: 0.9–1.0 at the harness's poles; the
  // season's belts slid past the pole gave 8–9.
  const sea = (field) => (i) => field[i * 2] !== 0 || field[i * 2 + 1] !== 0
  const vectors = { 'climate.wind': f32(c0.wind), 'climate.currents': f32(c0.currents), 'refined.wind': f32(cr.wind), 'refined.currents': f32(cr.currents) }
  for (let m = 0; m < r.months; m++) {
    vectors[`months.wind[${m}]`] = f32(r.wind).subarray(m * n * 2, (m + 1) * n * 2)
  }
  const jumps = Object.entries(vectors).map(([k, f]) => [k, poleVectorJump(f, RX, RY, k.includes('currents') ? sea(f) : undefined)])
  const worstJump = jumps.reduce((a, b) => (b[1] > a[1] ? b : a))
  check(`the winds and currents are continuous across the poles as vectors on the globe (${jumps.length} fields, the worst ${worstJump[0]} at ${worstJump[1].toFixed(2)})`, worstJump[1] < 2)
  // Plausible bands: polar easterlies at both poles, westerlies in the
  // middle latitudes, trade winds blowing toward the equator; the polar
  // seas' currents with no net flow into or out of a pole.
  const band = (field, from, to, use = () => true) => {
    let u = 0
    let vPole = 0
    let speed = 0
    let k = 0
    for (let y = 0; y < RY; y++) {
      const lat = 90 - (180 * (y + 0.5)) / RY
      if (Math.abs(lat) < from || Math.abs(lat) >= to) continue
      for (let x = 0; x < RX; x++) {
        const i = y * RX + x
        if (!use(i)) continue
        u += field[i * 2]
        vPole += lat > 0 ? -field[i * 2 + 1] : field[i * 2 + 1]
        speed += Math.hypot(field[i * 2], field[i * 2 + 1])
        k++
      }
    }
    return { u: u / k, vPole: vPole / k, speed: speed / k }
  }
  const ww = f32(cr.wind)
  const polar = band(ww, 65, 90)
  const westerly = band(ww, 35, 55)
  const trades = band(ww, 5, 25)
  check(`the wind's bands: polar easterlies (u ${polar.u.toFixed(2)}), westerlies (${westerly.u.toFixed(2)}), trades toward the equator (u ${trades.u.toFixed(2)}, poleward ${trades.vPole.toFixed(2)})`,
    polar.u < 0 && westerly.u > 0 && trades.u < 0 && trades.vPole < 0)
  // The polar seas' currents, each pole apart: they flow round the pole,
  // not into it — asked of the rows poleward of 75° that are a RING of sea,
  // sea all the way round. "Round the pole" means nothing for a basin a
  // coast closes: there the current turns along the coast, and its mean
  // over the basin may point poleward on any world. That was the seed
  // fragility (2026-10-12, SPHERE_SEED=c4): at ten epochs the north had 56
  // to 107 of 256 pixels sea per row from 75° to 85° and land beyond — a
  // basin, poleward 0.056 of 0.171, failing; at eleven a ring of sea to the
  // pole, -0.006 of 0.364. A pole with no ring (under land, or a basin
  // only: the seeds c2, c5, c6) is skipped and says so.
  const cc = f32(cr.currents)
  const polarSeas = [true, false].map((north) => {
    let vPole = 0, speed = 0, k = 0, rows = 0, basinRows = 0
    for (let y = 0; y < RY; y++) {
      const lat = 90 - (180 * (y + 0.5)) / RY
      if ((north ? lat : -lat) < 75) continue
      let seaInRow = 0
      for (let x = 0; x < RX; x++) if (sea(cc)(y * RX + x)) seaInRow++
      if (seaInRow < RX) {
        if (seaInRow > 0) basinRows++
        continue
      }
      rows++
      for (let x = 0; x < RX; x++) {
        const i = y * RX + x
        vPole += north ? -cc[i * 2 + 1] : cc[i * 2 + 1]
        speed += Math.hypot(cc[i * 2], cc[i * 2 + 1])
        k++
      }
    }
    return { pole: north ? 'north' : 'south', cells: k, rows, basinRows, vPole: k ? vPole / k : 0, speed: k ? speed / k : 0 }
  })
  const asked = polarSeas.filter((q) => q.cells > 0)
  check(`the polar seas' currents flow round the pole, not into it (${polarSeas.map((q) => q.cells === 0 ? `${q.pole}: skipped, no ring of sea poleward of 75° (${q.basinRows} rows a basin)` : `${q.pole}: poleward ${q.vPole.toFixed(3)} of ${q.speed.toFixed(3)} over ${q.rows} rings of sea${q.basinRows ? `, ${q.basinRows} basin rows skipped` : ''}`).join('; ')})`,
    asked.every((q) => Number.isFinite(q.vPole) && Math.abs(q.vPole) < 0.2 * q.speed))

  // The seam: the step across x = 0 / W is a step like the steps beside
  // it. Per column boundary, the mean step over the rows (and the months),
  // land beside land and sea beside sea only (the fields jump at a coast);
  // the seam's against the mean of the three boundaries on either side of
  // it. A seam is a spike there; a coast or a front that runs near x = 0
  // raises the boundaries beside it as well. Asked globally — the largest
  // step across against the largest inside, or the mean across against the
  // mean inside — it was seed-luck (2026-10-12, SPHERE_SEED=c4): at ten
  // epochs the largest step of the monsoon index fell on the seam
  // (2026-10-11), and a coast along x = 0 put the seam's mean salinity
  // step at 3.5 × the world's mean, while it was 0.8 × the steps beside it.
  const SEAM_NEIGHBOURS = 3
  const seamOf = (field, rx, ry, layers = 1) => {
    const sum = new Float64Array(rx)
    const count = new Float64Array(rx)
    for (let m = 0; m < layers; m++) {
      for (let y = 0; y < ry; y++) {
        const off = m * rx * ry + y * rx
        for (let x = 0; x < rx; x++) {
          const a = y * rx + x
          const b = y * rx + ((x + 1) % rx)
          if (landC[a] !== landC[b]) continue
          sum[x] += Math.abs(field[off + x] - field[off + ((x + 1) % rx)])
          count[x]++
        }
      }
    }
    const mean = (x) => sum[x] / Math.max(1, count[x])
    let beside = 0
    for (let k = 1; k <= SEAM_NEIGHBOURS; k++) beside += mean(rx - 1 - k) + mean(k - 1)
    return { seam: mean(rx - 1), inner: beside / (2 * SEAM_NEIGHBOURS) }
  }
  // The fields that vary smoothly; the derived ones (fog, föhn, the storms)
  // jump from cell to cell anywhere, and a seam check reads nothing there.
  // Nor does the months' cycle: it carries the fog and the föhn, which
  // switch on and off per cell and month (SPHERE_SEED=c5, 2026-10-12: a
  // fogbound coast across x = 0 stepped 2.4 °C in one month, a fog step;
  // the coast's fog share 0.36–0.39 on both sides, the föhn 0).
  const smooth = ['pressure', 'precipitation', 'salinity', 'currentAnomaly', 'climate.seasonalAmplitude', 'refined.seasonalAmplitude', 'refined.monsoonIndex']
  const seamed = Object.entries({ ...Object.fromEntries(smooth.map((k) => [k, scalars[k]])), temperature: [f32(r.temperature), r.months] })
    .map(([k, [f, layers]]) => [k, seamOf(f, RX, RY, layers)])
  const seamRatio = ([, s]) => s.seam / Math.max(1e-12, s.inner)
  const worstSeam = seamed.reduce((a, b) => (seamRatio(b) > seamRatio(a) ? b : a))
  check(`no smooth field of the climate step has a seam at x = 0 / W (${smooth.length + 1} fields; the mean step across over the mean step beside it, the worst ${worstSeam[0]} ${seamRatio(worstSeam).toFixed(2)})`, seamed.every((e) => seamRatio(e) <= 2), seamed.filter((e) => seamRatio(e) > 2).map(([k, s]) => `${k} ${s.seam.toFixed(3)} > 2 × ${s.inner.toFixed(3)}`).join(', '))
  // Mutation: a seam put in on purpose — the precipitation plus a ramp
  // across the chart of a tenth of its range — must show.
  {
    const [f, layers] = scalars.precipitation
    let lo = Infinity, hi = -Infinity
    for (const v of f) { lo = Math.min(lo, v); hi = Math.max(hi, v) }
    const ramped = f.map((v, i) => v + (0.1 * (hi - lo) * (i % RX)) / RX)
    const q = seamOf(ramped, RX, RY, layers)
    check(`mutation: a ramp of a tenth of the rain's range across the chart is a seam (${(q.seam / q.inner).toFixed(2)} × the mean step beside it)`, q.seam > 2 * q.inner)
  }

  // The rivers: every polyline step short in the chart where the chart
  // stretches it, none across a pole or the seam, one regime per line.
  const rendered = p.last('rendered')
  const W2 = rendered.elevationResX
  const H2 = rendered.elevationResY
  const elevation = f32(rendered.elevation)
  const D = await server.ssrLoadModule('/src/generator/core/domain.ts')
  const world = D.sphereDomain(W2, H2)
  const points = f32(h.riverPoints)
  const lengths = new Uint32Array(h.riverLengths)
  let offset = 0
  let segments = 0
  let stretched = 0
  let crossings = 0
  let longest = 0
  for (const len of lengths) {
    for (let k = 1; k < len; k++) {
      const a = (offset + k - 1) * 3
      const b = (offset + k) * 3
      const dx = Math.abs(points[b] - points[a])
      const dy = Math.abs(points[b + 1] - points[a + 1])
      const chart = Math.hypot(dx, dy)
      const truth = Math.sqrt(world.distanceSq(points[a], points[a + 1], points[b], points[b + 1]))
      if (dx > W2 / 4) crossings++
      if (chart > Math.max(RIVER_CHART_STEP_HARNESS + 0.5, 1.02 * truth)) stretched++
      longest = Math.max(longest, chart)
      segments++
    }
    offset += len
  }
  check(`the rivers' polylines step short in the chart: none stretched by the chart past a few texels, none across a pole or the seam (${lengths.length} lines, ${segments} steps, the longest ${longest.toFixed(1)} texels)`,
    lengths.length > 0 && stretched === 0 && crossings === 0 && new Uint8Array(h.riverRegimes).length === lengths.length, `${stretched} stretched, ${crossings} across`)

  // The graph's own invariants, as golden checks them on the torus, on the
  // mesh's heights (the saved mesh: the graph's cells are its vertices).
  const before = p.count('worldData')
  p.dispatch({ type: 'serializeWorld' })
  await until(() => p.count('worldData') > before, { label: 'the serialized sphere world' })
  const z = f32(p.last('worldData').mesh.z)
  const RG = await server.ssrLoadModule('/src/generator/surface/riverGraph.ts')
  const parsed = JSON.parse(h.riverGraph.json)
  const graph = { ...parsed, cells: new Int32Array(h.riverGraph.cells) }
  const broken = Object.entries(RG.riverGraphInvariants(graph, z)).filter(([, c]) => c > 0)
  const mouths = graph.nodes.filter((node) => node.kind === 'mouth').length
  const uphill = graph.reaches.filter((rc) => rc.kind === 'river' && rc.dropM < -1).length
  check(`the river graph holds its invariants on the sphere: acyclic, discharge monotone, every mouth in water (${graph.reaches.length} reaches, ${mouths} mouths)`,
    broken.length === 0 && graph.reaches.length > 0 && mouths > 0, broken.map(([k, c]) => `${k}:${c}`).join(' '))
  check('every river reach runs downhill', uphill === 0, `${uphill} reaches rise over a metre`)
  const courses = parsed.courses ?? []
  const coursePoints = f32(h.riverGraph.coursePoints)
  check(`the courses are finite with a sane sinuosity (${courses.length} courses)`, allFinite(coursePoints) && courses.every((c) => c.sinuosity >= 0.99 && c.sinuosity < 4))

  // The lakes and the water bodies: levels above their floors, depths only
  // under a body, the lakes a small share of the land.
  const lakeDepth = f32(h.lakeDepth)
  const bodies = h.waterBodies ?? []
  let wet = 0
  let land = 0
  for (let i = 0; i < elevation.length; i++) {
    if (elevation[i] > 0) land++
    if (lakeDepth[i] > 0) wet++
  }
  const badBodies = bodies.filter((b) => !(Number.isFinite(b.level) && b.level >= b.floor - 1e-6 && b.cells > 0))
  check(`the lakes are plausible on the sphere (${bodies.length} bodies, ${wet} wet cells, ${(100 * wet / Math.max(1, land)).toFixed(1)} % of the land)`,
    badBodies.length === 0 && lakeDepth.every((d) => d >= 0) && wet < 0.15 * land)

  // The coast's invariants on the sphere's terrain mesh (DEC-0036 phase
  // 7b: its nodes are the saved mesh's vertex ids; the type per node from
  // the reaches' walk), the ice on land only.
  const CG = await server.ssrLoadModule('/src/generator/surface/coastGraph.ts')
  const MSerial = await server.ssrLoadModule('/src/generator/mesh/meshSerial.ts')
  const saved = p.last('worldData').mesh
  const sphereMesh = MSerial.decodeMesh(world, { count: saved.count, nodes: new Float32Array(saved.nodes), connectivity: new Uint8Array(saved.connectivity) })
  const coastNodes = new Int32Array(h.coast.nodes)
  const coastType = new Uint8Array(sphereMesh.vertexSlots)
  for (const r of h.coast.reaches) for (let k = 0; k < r.nodeCount; k++) coastType[coastNodes[r.nodeStart + k]] = CG.COAST_TYPE_CODE[r.type]
  const coast = { reaches: h.coast.reaches, nodes: coastNodes, type: coastType }
  const coastBroken = Object.entries(CG.coastGraphInvariants(coast, sphereMesh, z)).filter(([, c]) => c > 0)
  const shorePixels = new Uint8Array(h.coastType).reduce((n, t) => n + (t > 0 ? 1 : 0), 0)
  check(`the coast holds its invariants on the sphere's mesh (${coast.reaches.length} reaches, ${coastNodes.length} nodes, ${shorePixels} typed shore pixels)`, coastBroken.length === 0 && coast.reaches.length > 0 && shorePixels > 0, coastBroken.map(([k, c]) => `${k}:${c}`).join(' '))
  const ice = f32(h.iceThickness)
  check('the ice lies on land only', ice.every((t, i) => t <= 0 || elevation[i] > 0))

  // The basins: finite, their areas the world's (at least the minimum, and
  // no more than the nodes' share of the globe can hold), the centroid on
  // the globe.
  const basins = h.sedimentBasins ?? []
  const globeKm2 = 4 * Math.PI * (world.metresPerUnit * W2 / (2 * Math.PI) / 1000) ** 2
  const badBasins = basins.filter((b) => !(Number.isFinite(b.x) && Number.isFinite(b.y) && b.x >= 0 && b.x < W2 && b.y >= 0 && b.y <= H2 && Number.isFinite(b.cratonAge) && b.areaKm2 >= 243.36 - 1e-6 && b.areaKm2 < globeKm2 && b.volumeKm3 > 0))
  check(`the sediment basins are finite and on the globe (${basins.length} basins)`, badBasins.length === 0, JSON.stringify(badBasins[0] ?? ''))
})

// The picture's step: RIVER_CHART_STEP in surface/riverGraph.ts.
const RIVER_CHART_STEP_HARNESS = 2

// THE ECOLOGY ON THE SPHERE (DEC-0035, step 4f): the step's run and a
// month through the runtime on a sphere world after its climate step, then
// a deposit's halo on the module at high latitude against its mutation.
test('a sphere world runs the ecology step through the runtime: finite, pole-handled, seamless, plausible by latitude', async () => {
  const p = await sphereThroughHydrology()
  const EI = await server.ssrLoadModule('/src/generator/ecology/ecologyInputParams.ts')
  const EF = await server.ssrLoadModule('/src/generator/ecology/ecologyField.ts')
  const strength = EI.ECOLOGY_INPUTS.provinceStrength.toModel(EI.ECOLOGY_INPUTS.provinceStrength.default)
  p.dispatch({ type: 'ecologyRun', carryingCapacity: 100, concentration: 0, provinceStrength: strength, tinRarity: 0, weights: {} })
  await until(() => p.count('ecologyData') >= 1 || p.count('stageFailed') > 0, { label: 'the sphere ecology', timeout: 120000 })
  p.dispatch({ type: 'ecologyMonth', field: 'fish', month: 1 })
  p.dispatch({ type: 'ecologyMonth', field: 'arable', month: 7 })
  await until(() => p.count('ecologyMonthData') >= 2 || p.count('stageFailed') > 0, { label: 'two sphere months', timeout: 60000 })
  const failed = p.messages.filter((m) => m.type === 'stageFailed' || m.type === 'stageDeclined')
  check('ecologyRun and ecologyMonth answer on a sphere world, nothing failed or declined', failed.length === 0 && p.count('ecologyData') === 1, failed.map((m) => `${m.stage}: ${m.error ?? m.needs}`).join('; '))

  const e = p.last('ecologyData')
  const RX = e.resX
  const RY = e.resY
  const FX = e.fine.resX
  const FY = e.fine.resY
  const coarse = Object.fromEntries(e.fields.map((f) => [f.id, new Float32Array(f.data)]))
  const fine = Object.fromEntries(e.fine.fields.map((f) => [f.id, new Uint8Array(f.data)]))
  const ids = EF.ECOLOGY_FIELD_IDS
  // Finite: the coarse fields are the fine ones' means over each cell's
  // land, so a NaN pixel of land shows there; the fine codes in range.
  const bad = ids.filter((id) => !coarse[id] || coarse[id].length !== RX * RY || !allFinite(coarse[id]) || !fine[id] || fine[id].length !== FX * FY)
  check(`every ecology field is whole and finite on the sphere (${ids.length} fields, ${RX}×${RY} and ${FX}×${FY})`, bad.length === 0, bad.join(', '))

  // The north pole: the fine raster's first row is the pole itself (the
  // rasterisation's corner convention, y = 0), and the fields on the
  // terrain mesh's nodes (DEC-0036 phase 7) have one value there, the
  // land's (and the fish's sea) apart — the months too. No pole row is
  // averaged any more: there is none on the mesh.
  const fineSea = fine.carryingCapacity.map((c) => (c === EF.ECOLOGY_FINE_OCEAN ? 1 : 0))
  const spreadOf = (field, rx, ry, isSea, value = (v) => v) => {
    let worst = 0
    for (const row of [0]) {
      for (const kind of [0, 1]) {
        let lo = Infinity
        let hi = -Infinity
        for (let x = 0; x < rx; x++) {
          const i = row * rx + x
          if (isSea(i) !== kind) continue
          const v = value(field[i])
          lo = Math.min(lo, v)
          hi = Math.max(hi, v)
        }
        if (hi > lo) worst = Math.max(worst, hi - lo)
      }
    }
    return worst
  }
  const poles = ids.map((id) => [`fine.${id}`, spreadOf(fine[id], FX, FY, (i) => fineSea[i])])
  const months = p.messages.filter((m) => m.type === 'ecologyMonthData')
  for (const m of months) poles.push([`month ${m.field} ${m.month}`, m.data.byteLength === FX * FY ? spreadOf(new Uint8Array(m.data), FX, FY, (i) => fineSea[i]) : Infinity])
  const spread = poles.filter(([, v]) => v > 1e-6)
  let polarLand = 0
  for (let x = 0; x < FX; x++) if (!fineSea[x]) polarLand++
  check(`the ecology's fields are one value at the pole, land and sea apart (${poles.length} fields, ${polarLand} of the pole's ${FX} pixels land)`, spread.length === 0 && months.length === 2 && months.every((m) => m.data.byteLength === FX * FY), spread.map(([k, v]) => `${k} ${v}`).join(', '))

  // The seam: the step across x = 0 / W no larger than the steps in a row,
  // on average over the land (the fields jump where the land does).
  const seamOf = (field) => {
    let seam = 0
    let seamN = 0
    let inner = 0
    let innerN = 0
    for (let y = 0; y < FY; y++) {
      for (let x = 0; x < FX; x++) {
        const a = y * FX + x
        const b = y * FX + ((x + 1) % FX)
        if (fineSea[a] || fineSea[b]) continue
        const d = Math.abs(field[a] - field[b])
        if (x === FX - 1) { seam += d; seamN++ } else { inner += d; innerN++ }
      }
    }
    return { seam: seam / Math.max(1, seamN), inner: inner / Math.max(1, innerN), seamN }
  }
  // A world with no land on both sides of the seam has nothing to ask
  // (the harness's sphere at this size: 0 pairs on every seed tried,
  // 2026-10-12): skipped, and said so — the constructed sphere below asks
  // the seam, the pole's land and the latitude where they apply.
  const seams = ['carryingCapacity', 'arable', 'game', 'pasture', 'fish', 'iron'].map((id) => [id, seamOf(fine[id])])
  const seamed = seams.filter(([, s]) => s.seam > 2 * s.inner + 1)
  const seamPairs = seams[0][1].seamN
  check(seamPairs === 0
    ? 'no ecology field has a seam at x = 0 / W — skipped: no land on both sides of the seam on this world (the constructed sphere test asks it)'
    : `no ecology field has a seam at x = 0 / W (${seams.map(([id, s]) => `${id} ${s.seam.toFixed(1)}/${s.inner.toFixed(1)}`).join(', ')} codes, ${seamPairs} seam pairs)`, seamed.length === 0)

  // By latitude: the carrying capacity and the game fall toward the poles
  // (land area-weighted, per band of |latitude|); every value in its range.
  const band = (field, from, to) => {
    let sum = 0
    let area = 0
    for (let y = 0; y < RY; y++) {
      const lat = 90 - (180 * (y + 0.5)) / RY
      if (Math.abs(lat) < from || Math.abs(lat) >= to) continue
      const a = Math.cos((lat * Math.PI) / 180)
      for (let x = 0; x < RX; x++) {
        const v = field[y * RX + x]
        if (v === EF.ECOLOGY_OCEAN) continue
        sum += v * a
        area += a
      }
    }
    return area > 0 ? sum / area : NaN
  }
  const bands = [[0, 30], [30, 55], [55, 70], [70, 90]]
  const cc = bands.map(([a, b]) => band(coarse.carryingCapacity, a, b))
  const game = bands.map(([a, b]) => band(coarse.game, a, b))
  const arable = bands.map(([a, b]) => band(coarse.arable, a, b))
  const known = (v) => Number.isFinite(v)
  const low = [cc, game, arable].every((f) => !known(f[3]) || f[3] < Math.max(...f.slice(0, 2).filter(known)))
  const inRange = ids.every((id) => coarse[id].every((v) => v === EF.ECOLOGY_OCEAN || (v >= 0 && v <= 3)))
  const fishSea = [...fine.fish].filter((c, i) => fineSea[i]).map((c) => c * EF.ECOLOGY_FINE_STEP)
  const fishMean = fishSea.reduce((a, b) => a + b, 0) / Math.max(1, fishSea.length)
  const fmt = (f) => f.map((v) => (known(v) ? v.toFixed(3) : '—')).join(' / ')
  // The polar band's comparison is skipped where the world has no land
  // poleward of 70° ('—'); the constructed sphere test asks it.
  check(`plausible by latitude (bands 0–30–55–70–90°): carrying capacity ${fmt(cc)}, game ${fmt(game)}, arable ${fmt(arable)} — the polar band the lowest${known(cc[3]) ? '' : ' (skipped: no land poleward of 70°)'}; every field in range, the sea's fish ${fishMean.toFixed(3)}`,
    known(cc[0]) && low && inRange && fishSea.length > 0 && fishMean > 0 && fishMean < 1)
})

// A compute that throws in the worker releases what waits for it: the
// runtime answers stageFailed for the stage (the screen releases it as a
// decline, GeneratorScreen.handleStageFailed) and goes on answering. A
// save's refinement that is not one (restored: {}) makes the climate
// refinement throw.
test('a compute that throws says so instead of leaving the screen waiting', async () => {
  const p = await freshPipeline()
  await growWorld(p)
  p.dispatch({ type: 'climateRun', temperatureOffset: 0, temperatureContrast: 1, humidity: 1, equatorOffset: 0 })
  await until(() => p.count('climateData') >= 1, { label: 'the climate' })
  const quietConsole = console.error
  console.error = () => {}
  try {
    p.dispatch({ type: 'climateRefine', restored: {} })
  } finally {
    console.error = quietConsole
  }
  const failed = p.messages.filter((m) => m.type === 'stageFailed')
  check(`a throwing refinement answers stageFailed for the climate (${failed.map((m) => m.error).join('; ')})`, failed.length === 1 && failed[0].stage === 'climate' && failed[0].error.length > 0)
  p.dispatch({ type: 'hydrologyRun' })
  await until(() => p.count('hydrologyData') >= 1 || p.count('stageFailed') > 1, { label: 'the hydrology after the failure', timeout: 60000 })
  check('the pipeline goes on: the hydrology runs on the climate that stood', p.count('hydrologyData') === 1 && p.count('stageFailed') === 1)
})

test('the hand-over is what resetTectonics goes back to', async () => {
  const p = await freshPipeline()
  await growWorld(p)
  const handover = hash(p.last('rendered').elevation)

  // One epoch is enough to move the world, and to move a snapshot that is
  // not its own copy (a few seconds each on this world, where the uplift
  // field's cost does not shrink with the size; it ran four pictures —
  // ten epochs — each time until 2026-10-12).
  await runEpochs(p, 1)
  check('tectonics moves the world off the hand-over', hash(p.last('rendered').elevation) !== handover)

  let base = p.count('rendered')
  p.dispatch({ type: 'resetStage', stage: 'tectonics' })
  await until(() => p.count('rendered') > base, { label: 'the reset render' })
  await quiet(p)
  check('resetTectonics restores the hand-over exactly', hash(p.last('rendered').elevation) === handover)

  // The snapshot is deep-copied at hand-over precisely so a SECOND reset lands in
  // the same place — an uncopied one drifts along with the world it preserves.
  await runEpochs(p, 1)
  const second = p.count('rendered')
  p.dispatch({ type: 'resetStage', stage: 'tectonics' })
  await until(() => p.count('rendered') > second, { label: 'the second reset render' })
  await quiet(p)
  check('a second resetTectonics lands in the same place', hash(p.last('rendered').elevation) === handover)
})

// ------------------------------------------------------------ save and reload

test('a world survives serialize -> restore unchanged', async () => {
  const p = await freshPipeline()
  await growWorld(p)
  // Two eroding epochs: a column with layers, a mesh remeshed since the
  // hand-over (four pictures, ten epochs, until 2026-10-12).
  await runEpochs(p, 2)
  const saved = hash(p.last('rendered').elevation)

  p.dispatch({ type: 'serializeWorld' })
  await until(() => p.count('worldData') >= 1, { label: 'the serialized world' })
  const worldData = p.last('worldData')

  const q = await freshPipeline()
  q.dispatch(asRestore(worldData))
  await until(() => q.count('rendered') >= 1, { label: 'the restore render' })
  check('the restored world renders the world that was saved', hash(q.last('rendered').elevation) === saved)
})

// THE SAVE STEP (DEC-0036): the save holds no chart raster. A loaded world
// draws its raster from the mesh, and it must be the session's, byte for
// byte; the save's readers (world/query.ts) draw the same raster, the
// lakes' depth the session drew and the forcing the session derives; the
// world's id is stable across save → load → save, and two pipelines that
// made the same world give it one id.
test('a save holds no raster, and every reader draws the session\'s', async () => {
  const Q = await server.ssrLoadModule('/src/world/query.ts')
  const A = await server.ssrLoadModule('/src/world/save/worldArchive.ts')
  const JSZip = (await import(`${CLIENT}/node_modules/jszip/dist/jszip.min.js`)).default
  const climate = { type: 'climateRun', temperatureOffset: 0, temperatureContrast: 1, humidity: 1, equatorOffset: 0 }
  const make = async () => {
    const p = await freshPipeline()
    await growWorld(p)
    await runOneEpoch(p)
    p.dispatch(climate)
    await until(() => p.count('climateData') >= 1, { label: 'climate' })
    p.dispatch({ type: 'hydrologyRun' })
    await until(() => p.count('hydrologyData') >= 1, { label: 'hydrology' })
    await quiet(p)
    return p
  }
  const p = await make()
  const raw = await rawElevation(p)
  const hyd = p.last('hydrologyData')
  const world = worldDataOf(p)
  const bytes = await archiveOf(world, hyd)
  const zip = await JSZip.loadAsync(bytes)
  const rasters = Object.keys(zip.files).filter((f) => /\.(f32|u8|u16|i16|i8)$/.test(f) && !f.startsWith('mesh/') && !f.startsWith('climate/') && !f.startsWith('lattice.'))
  check(`the save holds no chart raster (${Object.keys(zip.files).length} entries)`, rasters.length === 0 && A.FORMER_RASTERS.every((f) => zip.file(f) === null), rasters.join(', '))
  const opened = await Q.openWorld(bytes, WASM)
  if (!opened) { check('the save opens', false); return }
  const elevation = await opened.acquire('elevation')
  check('the reader\'s elevation is the session\'s raster, byte for byte', elevation !== null && hash(elevation.data.buffer) === hash(raw))
  const lakes = await opened.acquire('lakeDepth')
  const session = new Float32Array(hyd.lakeDepth)
  const wet = session.reduce((n, d) => n + (d > 0 ? 1 : 0), 0)
  check(`the reader's lakes are the session's, byte for byte (${wet} wet pixels)`, lakes !== null && hash(lakes.data.buffer) === hash(hyd.lakeDepth) && wet > 0)
  const forcing = WASM.forcingOfSnapshot('torus', structuredClone(world.snapshot))
  const uplift = await opened.acquire('uplift')
  const erodibility = await opened.acquire('erodibility')
  check('the reader\'s forcing is the one the session derives', uplift !== null && erodibility !== null && hash(uplift.data.buffer) === hash(forcing.uplift.buffer) && hash(erodibility.data.buffer) === hash(forcing.hardness.buffer))
  const id = await opened.worldId()

  const q = await freshPipeline()
  q.dispatch(asRestore(world))
  await until(() => q.count('rendered') >= 1, { label: 'the restore render' })
  await quiet(q)
  check('the loaded world\'s raster is the session\'s, byte for byte', hash(await rawElevation(q)) === hash(raw))
  // What the screen's save does on a loaded world: the climate and the
  // hydrology first (they are not in the restore), then the world.
  q.dispatch(climate)
  await until(() => q.count('climateData') >= 1, { label: 'the loaded climate' })
  q.dispatch({ type: 'hydrologyRun' })
  await until(() => q.count('hydrologyData') >= 1, { label: 'the loaded hydrology' })
  await quiet(q)
  const again = await Q.openWorld(await archiveOf(worldDataOf(q), q.last('hydrologyData')), WASM)
  const idAgain = again ? await again.worldId() : null
  check(`the world's id is stable across save → load → save (${id})`, idAgain === id, `${id} vs ${idAgain}`)

  const r = await make()
  const twin = await Q.openWorld(await archiveOf(worldDataOf(r), r.last('hydrologyData')), WASM)
  const idTwin = twin ? await twin.worldId() : null
  check('two pipelines that made the same world give it one id', idTwin === id, `${id} vs ${idTwin}`)
  check('a world one epoch on has another id', await (async () => {
    await runOneEpoch(r)
    const on = await Q.openWorld(await archiveOf(worldDataOf(r)), WASM)
    return on !== null && (await on.worldId()) !== id
  })())
})

// A save at the hand-over, before any epoch: the session has not routed
// its mesh, and the save carries it all the same (runtime.savedMeshPayload)
// — a load continues where the session does, bit for bit.
test('a save at the hand-over carries its mesh, and the load continues as the session', async () => {
  const p = await freshPipeline()
  await growWorld(p)
  const world = worldDataOf(p)
  check('the hand-over\'s save carries the mesh', world.mesh !== undefined && world.mesh.count > 0)
  const q = await freshPipeline()
  q.dispatch(asRestore(world))
  await until(() => q.count('rendered') >= 1, { label: 'the restore render' })
  await quiet(q)
  check('the loaded raster is the session\'s', hash(await rawElevation(q)) === hash(await rawElevation(p)))
  await runOneEpoch(p)
  await runOneEpoch(q)
  const parts = (w) => ['nodes', 'connectivity', 'z', 'column', 'sedimentFlux', 'ice'].map((k) => (w.mesh[k] ? hash(w.mesh[k]) : '-')).join(' ')
  const a = worldDataOf(p), b = worldDataOf(q)
  check('one epoch on, the loaded world\'s mesh is the session\'s, bit for bit', a.snapshot.epoch === b.snapshot.epoch && parts(a) === parts(b), `epoch ${a.snapshot.epoch} vs ${b.snapshot.epoch}`)
})

test('REGRESSION: a loaded world is not replaced by a leftover Archean', async () => {
  // 2026-08-09. Loading a world after a Genesis had been run in the same session
  // lost it: restoreWorld's tectonic branch cleared `sim` but not `archean`, and
  // entering the Tectonics panel sends archeanFinalize, which found the leftover
  // and handed IT over instead. Intermittent-looking, because it needed a Genesis
  // in the same session first.
  const source = await freshPipeline()
  await growWorld(source)
  source.dispatch({ type: 'serializeWorld' })
  await until(() => source.count('worldData') >= 1, { label: 'a world to load' })
  const worldData = source.last('worldData')

  const p = await freshPipeline()
  p.dispatch({ ...ARCHEAN_INIT, seed: 'eine-andere-welt' })
  await until(() => p.count('rendered') >= 1, { label: 'the Genesis run' })
  p.dispatch({ type: 'genesisStart' })
  await until(() => p.count('genesisStatus') >= ARCHEAN_EPOCHS, { label: 'a Genesis run' })
  p.dispatch({ type: 'genesisStop' })
  await quiet(p)

  const before = p.count('rendered')
  p.dispatch(asRestore(worldData))
  await until(() => p.count('rendered') > before, { label: 'the load render' })
  await quiet(p)
  const loaded = hash(p.last('rendered').elevation)

  // What entering the Tectonics panel does.
  const afterLoad = p.count('rendered')
  p.dispatch({ type: 'genesisFinalize' })
  await settle(300)
  check('archeanFinalize after a load does nothing at all', p.count('rendered') === afterLoad, `${afterLoad} -> ${p.count('rendered')}`)
  check('the loaded world is still the one on the map', hash(p.last('rendered').elevation) === loaded)
})

test('REGRESSION: resetTectonics on a loaded world is a no-op', async () => {
  // A save carries the world as it stood, not the hand-over behind it — so there
  // is nothing to go back to, and the reset must decline rather than invent one.
  const source = await freshPipeline()
  await growWorld(source)
  source.dispatch({ type: 'serializeWorld' })
  await until(() => source.count('worldData') >= 1, { label: 'a world to load' })
  const worldData = source.last('worldData')

  const p = await freshPipeline()
  p.dispatch(asRestore(worldData))
  await until(() => p.count('rendered') >= 1, { label: 'the load render' })
  await quiet(p)
  const loaded = hash(p.last('rendered').elevation)

  const before = p.count('rendered')
  p.dispatch({ type: 'resetStage', stage: 'tectonics' })
  await settle(300)
  check('resetTectonics declines when there is no hand-over', p.count('rendered') === before)
  check('the loaded world is untouched', hash(p.last('rendered').elevation) === loaded)

  // The same load into the pipeline that GREW the world: that one holds a
  // hand-over, and it must go with the world it belonged to — a reset after
  // the load rewound the loaded world onto the previous session's continents
  // (bounty 5), which only the screen's own flag was hiding.
  const grown = source.count('rendered')
  source.dispatch(asRestore(worldData))
  await until(() => source.count('rendered') > grown, { label: 'the load render on the grower' })
  await quiet(source)
  const reloaded = source.count('rendered')
  source.dispatch({ type: 'resetStage', stage: 'tectonics' })
  await settle(300)
  check('a load drops the hand-over of the world it replaced', source.count('rendered') === reloaded)
  check('the world loaded over a grown one is untouched', hash(source.last('rendered').elevation) === loaded)
})

// ------------------------------------------------------------- the stage chain

test('the stages compute, in order, on one world', async () => {
  const p = await freshPipeline()
  await growWorld(p)
  await runEpochs(p, 2)

  p.dispatch({ type: 'climateRun', temperatureOffset: 0, temperatureContrast: 1, humidity: 1, equatorOffset: 0 })
  await until(() => p.count('climateData') >= 1, { label: 'climate' })
  p.dispatch({ type: 'hydrologyRun' })
  await until(() => p.count('hydrologyData') >= 1, { label: 'hydrology' })
  // The sliders as the screen sends them, at their defaults.
  p.dispatch({ type: 'ecologyRun', carryingCapacity: 100, concentration: 0, provinceStrength: 0.45, tinRarity: 0, weights: {} })
  await until(() => p.count('ecologyData') >= 1, { label: 'ecology' })
  p.dispatch({ type: 'migrationRun', origins: [] })
  await until(() => p.count('migrationData') >= 1, { label: 'migration' })

  check('every stage produced its result', true)
  const eco = p.last('ecologyData')
  check('ecology returns fields, not an empty envelope', eco.fields.length > 0, `${eco.fields.length} fields`)
  // The carrying capacity is copied out before the buffer is transferred; with a
  // detaching emitter, a missing copy shows up here as migration failing.
  check('migration ran off the ecology it was handed', p.count('migrationData') >= 1)
})

test('the climate refinement answers with twelve months, and declines without a climate', async () => {
  const p = await freshPipeline()
  await growWorld(p)
  await runEpochs(p, 1)
  p.dispatch({ type: 'climateRefine' })
  await until(() => p.count('stageDeclined') >= 1, { label: 'the refusal' })
  check('the refinement names the climate it needs', p.last('stageDeclined').needs === 'climate', JSON.stringify(p.last('stageDeclined')))
  p.dispatch({ type: 'climateRun', temperatureOffset: 0, temperatureContrast: 1, humidity: 1, equatorOffset: 0 })
  await until(() => p.count('climateData') >= 1, { label: 'climate' })
  p.dispatch({ type: 'climateRefine' })
  await until(() => p.count('climateRefined') >= 1, { label: 'the refinement' })
  const r = p.last('climateRefined')
  const n = r.resX * r.resY
  const pressure = new Float32Array(r.pressure)
  const wind = new Float32Array(r.wind)
  check('twelve months of pressure and wind', r.months === 12 && pressure.length === 12 * n && wind.length === 24 * n, `${r.months} months`)
  let finite = true
  let lo = Infinity
  let hi = -Infinity
  for (const v of pressure) { if (!Number.isFinite(v)) finite = false; lo = Math.min(lo, v); hi = Math.max(hi, v) }
  for (const v of wind) if (!Number.isFinite(v)) finite = false
  check('the pressure is finite and in a weather range', finite && lo > 950 && hi < 1070, `${lo.toFixed(1)}..${hi.toFixed(1)} hPa`)
  const currents = new Float32Array(r.currents)
  const anomaly = new Float32Array(r.currentAnomaly)
  const upwelling = new Float32Array(r.upwelling)
  let ok = currents.length === 2 * n && anomaly.length === n && upwelling.length === n
  for (const a of [currents, anomaly, upwelling]) for (const v of a) if (!Number.isFinite(v)) ok = false
  check('the refined currents, their anomaly and the upwelling are whole and finite', ok)
  // 5b: the refined climate takes the history's place, and the rivers run
  // on it without the hydrology's own climate pass putting the old back.
  await until(() => p.messages.some((m) => m.type === 'climateData' && m.refined), { label: 'the refined climate' })
  const refinedClimate = p.messages.filter((m) => m.type === 'climateData' && m.refined).at(-1)
  const koppen = new Uint8Array(refinedClimate.koppen)
  check('the refined climate carries the refinement\'s classes', koppen.length === n && koppen.some((v) => v > 0))
  const before = p.messages.length
  p.dispatch({ type: 'hydrologyRun' })
  await until(() => p.messages.slice(before).some((m) => m.type === 'hydrologyData'), { label: 'rivers on the refined climate' })
  check('the rivers do not replace the refined climate', !p.messages.slice(before).some((m) => m.type === 'climateData'))

  // DEC-0036 phase 5: the refinement's values per cell of the climate's
  // field mesh come with it. The same climate refined again gives the same
  // bytes; those values read back through the save's form (world/save/
  // refinedFields.ts) and handed back as `restored` are adopted — the same
  // rasters, the same refined climate, the same rivers after it — to the bit.
  const RF = await server.ssrLoadModule('/src/world/save/refinedFields.ts')
  const valuesHash = (v) => [v.temperature, v.precipitation, v.pressure, v.windE, v.windS, v.currentE, v.currentS, v.currentAnomaly, v.upwelling, v.salinity, v.deepWater, v.fog, v.foehn,
    v.reliability.rainVariability, v.reliability.ensoPattern, ...Object.values(v.storms)].map((f) => hash(f.buffer)).join('') + `${v.cells}/${v.spacingM}/${v.reliability.ensoPeriodYears}/${v.reliability.ensoStrength}`
  const rasterHash = (m) => ['temperature', 'precipitation', 'pressure', 'wind', 'currents', 'currentAnomaly', 'upwelling', 'koppen', 'salinity', 'deepWater', 'fog', 'foehn', 'rainVariability', 'ensoPattern', 'cyclone', 'tornado', 'blizzard', 'dust', 'thunder'].map((k) => hash(m[k])).join('')
  const climateHash = (m) => ['temperature', 'wind', 'currents', 'currentAnomaly', 'precipitation', 'seasonalAmplitude', 'monsoonIndex', 'koppen', 'biomes'].map((k) => hash(m[k])).join('') + hash(m.windMesh.e) + hash(m.currentsMesh.e)
  const first = { values: valuesHash(r.refined), rasters: rasterHash(r), climate: climateHash(refinedClimate), rivers: hash(p.last('hydrologyData').discharge) }
  const { meta, files } = RF.refinedEntries(r.refined, 2.5)
  const saved = await RF.refinedFromEntries(meta, async (file) => files.find(([f]) => f === file)?.[1] ?? null)
  check('the refinement\'s values are one mesh\'s, and read back through the save\'s form unchanged', r.refined.cells > 0 && r.refined.temperature.length === 12 * r.refined.cells && valuesHash(saved) === first.values)
  const again = async (restored) => {
    const climates = p.count('climateData')
    p.dispatch({ type: 'climateRun', temperatureOffset: 0, temperatureContrast: 1, humidity: 1, equatorOffset: 0 })
    await until(() => p.count('climateData') > climates, { label: 'climate again' })
    const refinements = p.count('climateRefined')
    p.dispatch(restored ? { type: 'climateRefine', restored } : { type: 'climateRefine' })
    // The refined climate follows the refinement in the same handler.
    await until(() => p.count('climateRefined') > refinements && p.messages.filter((m) => m.type === 'climateData').at(-1).refined, { label: 'the refinement again' })
    const rivers = p.count('hydrologyData')
    p.dispatch({ type: 'hydrologyRun' })
    await until(() => p.count('hydrologyData') > rivers, { label: 'rivers again' })
    const answer = p.last('climateRefined')
    return { values: valuesHash(answer.refined), rasters: rasterHash(answer), climate: climateHash(p.messages.filter((m) => m.type === 'climateData' && m.refined).at(-1)), rivers: hash(p.last('hydrologyData').discharge) }
  }
  const computed = await again()
  check('the same climate refined twice gives the same bytes (values, rasters, refined climate, rivers)', JSON.stringify(computed) === JSON.stringify(first))
  const adopted = await again(saved)
  check('a saved refinement handed back is adopted to the bit: the same values, rasters, refined climate and rivers after it', JSON.stringify(adopted) === JSON.stringify(first),
    Object.keys(first).filter((k) => adopted[k] !== first[k]).join(', '))
})

test('INVALIDATION: the epochs stale everything downstream, per the declared chain', async () => {
  // stages.ts says climate, hydrology, ecology and migration all sit downstream of
  // erosion. Before 3c this side dropped only the hydrology while WorldGenScreen
  // dropped the climate too, so the two halves of one pipeline disagreed about
  // what the world currently was.
  const p = await freshPipeline()
  await growWorld(p)
  const climateMessage = { type: 'climateRun', temperatureOffset: 0, temperatureContrast: 1, humidity: 1, equatorOffset: 0 }
  p.dispatch(climateMessage)
  await until(() => p.count('climateData') >= 1, { label: 'climate' })
  p.dispatch({ type: 'hydrologyRun' })
  await until(() => p.count('hydrologyData') >= 1, { label: 'hydrology' })
  const beforeDischarge = hash(p.last('hydrologyData').discharge)

  const climateRuns = p.count('climateData')
  await runEpochs(p, 1)
  check('an epoch does not silently recompute the climate', p.count('climateData') === climateRuns)

  // The eroded terrain is not the one that climate was computed on, so asking for
  // rivers now must refuse rather than route over a climate that describes a world
  // one erosion pass ago.
  p.dispatch({ type: 'hydrologyRun' })
  await until(() => p.count('stageDeclined') >= 1, { label: 'the refusal' })
  const declined = p.last('stageDeclined')
  check('hydrology refuses on eroded terrain, naming what it needs', declined.stage === 'hydrology' && declined.needs === 'climate', JSON.stringify(declined))
  check('and it produced no river data', p.count('hydrologyData') === 1)

  p.dispatch(climateMessage)
  await until(() => p.count('climateData') >= climateRuns + 1, { label: 'the recomputed climate' })
  p.dispatch({ type: 'hydrologyRun' })
  await until(() => p.count('hydrologyData') >= 2, { label: 'hydrology again' })
  check('with the climate back, the rivers follow the new terrain', hash(p.last('hydrologyData').discharge) !== beforeDischarge)
})

test('a stage that cannot run says so instead of going quiet', async () => {
  // The failure this removes: the screen sets its in-flight flag, disables the
  // controls and waits for a result the worker already decided not to produce.
  const p = await freshPipeline()
  p.dispatch({ type: 'climateRun', temperatureOffset: 0, temperatureContrast: 1, humidity: 1, equatorOffset: 0 })
  p.dispatch({ type: 'hydrologyRun' })
  p.dispatch({ type: 'ecologyRun' })
  p.dispatch({ type: 'migrationRun', origins: [] })
  await settle(200)
  const declined = p.messages.filter((m) => m.type === 'stageDeclined')
  check('all four refuse on a world that does not exist yet', declined.length === 4, declined.map((d) => d.stage).join(', '))
  check('each names the world itself as what is missing', declined.every((d) => d.needs === 'tectonics'), JSON.stringify(declined.map((d) => d.needs)))
  // A month of a resource is answered even with nothing to show, so the
  // screen is not left waiting on it.
  p.dispatch({ type: 'ecologyMonth', field: 'arable', month: 7 })
  await until(() => p.count('ecologyMonthData') >= 1, { label: 'the empty month' })
  check('a month of a resource without an ecology comes back empty', p.last('ecologyMonthData').data.byteLength === 0)

  // And once there IS a world, the refusal is specific: the climate is what
  // hydrology is short of, not the terrain.
  const q = await freshPipeline()
  await growWorld(q)
  q.dispatch({ type: 'ecologyRun' })
  await until(() => q.count('stageDeclined') >= 1, { label: 'the ecology refusal' })
  check('ecology names the climate once a world exists', q.last('stageDeclined').needs === 'climate', JSON.stringify(q.last('stageDeclined')))
})

test('a hydrology pass overtaken by a reset publishes nothing', async () => {
  // The pass awaits its routing; the onmessage handler does not. A reset
  // that lands in that gap drops the climate and moves the terrain back to
  // the hand-over — the pass that started before it must not come back and
  // publish rivers for a terrain that is gone (bounty 9).
  const p = await freshPipeline()
  await growWorld(p)
  p.dispatch({ type: 'climateRun', temperatureOffset: 0, temperatureContrast: 1, humidity: 1, equatorOffset: 0 })
  await until(() => p.count('climateData') >= 1, { label: 'climate' })
  p.dispatch({ type: 'hydrologyRun' })
  p.dispatch({ type: 'resetStage', stage: 'tectonics' })
  await settle(3000)
  check('the overtaken pass stays silent', p.count('hydrologyData') === 0, `${p.count('hydrologyData')} published`)
  // ... and does not leave the stage jammed: the next pass runs.
  p.dispatch({ type: 'climateRun', temperatureOffset: 0, temperatureContrast: 1, humidity: 1, equatorOffset: 0 })
  await until(() => p.count('climateData') >= 2, { label: 'the climate again' })
  p.dispatch({ type: 'hydrologyRun' })
  await until(() => p.count('hydrologyData') >= 1, { label: 'the pass after the reset' })
  check('the pass after the reset publishes', p.count('hydrologyData') === 1)
})

test('tectonics on an Archean world is refused, and the Archean still starts', async () => {
  // The two phases share one interval handle. A tectonicsStart before the
  // hand-over used to arm it with ticks that found no plates — and the
  // genesisStart after it saw the handle taken and did nothing (bounty 61).
  const p = await freshPipeline()
  p.dispatch({ ...ARCHEAN_INIT })
  await until(() => p.count('rendered') >= 1, { label: 'the first Archean render' })
  p.dispatch({ type: 'tectonicsStart' })
  await until(() => p.count('stageDeclined') >= 1, { label: 'the refusal' })
  check('the start is declined, naming the genesis', p.last('stageDeclined').stage === 'tectonics' && p.last('stageDeclined').needs === 'genesis', JSON.stringify(p.last('stageDeclined')))
  p.dispatch({ type: 'genesisStart' })
  await until(() => p.count('genesisStatus') >= 2, { label: 'Archean epochs after the refused start', timeout: 20000 })
  p.dispatch({ type: 'genesisStop' })
  await quiet(p)
  check('the Archean runs on', p.count('genesisStatus') >= 2)
})

test('a repeat hydrology call reuses the routing instead of re-flooding', async () => {
  // The expensive half (priority-flood routing, discharge, lakes) is cached.
  // The contract is visible from outside: a re-route sends lakes, watersheds,
  // discharge and the riparian biomes; a repeat call over unchanged topography
  // sends all four empty ("unchanged, keep yours") and re-extracts only the
  // polylines — which must come out identical, since the density slider that
  // once varied the threshold between calls is gone (erosion-v2 P4/teardown).
  const p = await freshPipeline()
  await growWorld(p)
  p.dispatch({ type: 'climateRun', temperatureOffset: 0, temperatureContrast: 1, humidity: 1, equatorOffset: 0 })
  await until(() => p.count('climateData') >= 1, { label: 'climate' })
  p.dispatch({ type: 'hydrologyRun' })
  await until(() => p.count('hydrologyData') >= 1, { label: 'the first routing' })
  const routed = p.last('hydrologyData')
  check('a re-route sends lakes, watersheds and discharge', routed.lakeDepth.byteLength > 0 && routed.watersheds.byteLength > 0 && routed.discharge.byteLength > 0)
  check('and classifies the riparian biomes', routed.biomes.byteLength > 0)

  p.dispatch({ type: 'hydrologyRun' })
  await until(() => p.count('hydrologyData') >= 2, { label: 'the repeat pass' })
  const repeated = p.last('hydrologyData')
  check('a repeat call does not re-flood', repeated.lakeDepth.byteLength === 0 && repeated.watersheds.byteLength === 0 && repeated.discharge.byteLength === 0)
  check('and does not re-derive the biomes', repeated.biomes.byteLength === 0)
  check('the river network is the same one', hash(repeated.riverPoints) === hash(routed.riverPoints))
  check('the river regimes are the same ones', hash(new Uint8Array(repeated.riverRegimes)) === hash(new Uint8Array(routed.riverRegimes)) && new Uint8Array(routed.riverRegimes).length === new Uint32Array(routed.riverLengths).length)
  // The feature graph rides with a re-route only, like the lakes.
  check('a re-route carries the river graph, a repeat does not', routed.riverGraph !== null && routed.riverGraph.cells.byteLength > 0 && repeated.riverGraph === null)
})

test('the epochs erode, the stop settles, the resets go where they say', async () => {
  // The coupled history (phase 5.1): the terrain is the mesh the tectonics
  // carry, eroded inside every epoch. The hand-over draws it un-eroded; the
  // epochs change it; a stop ends with one settled render; the erosion reset
  // has nothing to revert (it renders nothing); the tectonics reset is back
  // at the hand-over's terrain, byte for byte.
  const p = await freshPipeline()
  await growWorld(p)
  const handover = hash(p.last('rendered').elevation)
  const intermediateBefore = p.count('rendered') - p.settledRenders()
  await runEpochs(p, 2)
  check('the epochs erode the terrain', hash(p.last('rendered').elevation) !== handover)
  check('the renders while the plates ran were intermediate', p.count('rendered') - p.settledRenders() > intermediateBefore)
  check('the last render is the settled one', !p.last('rendered').intermediate)
  check('a settled render carries the mesh terrain', p.last('rendered').epoch >= 1)

  const renders = p.count('rendered')
  p.dispatch({ type: 'resetStage', stage: 'erosion' })
  await settle(300)
  check('the erosion reset has nothing to render', p.count('rendered') === renders)

  p.dispatch({ type: 'resetStage', stage: 'tectonics' })
  await until(() => p.count('rendered') > renders, { label: 'the hand-over render' })
  check('the tectonics reset is back at the hand-over terrain', hash(p.last('rendered').elevation) === handover)
})

// -------------------------------------------------------------- the whole table

test('the Planet preview answers on the sample world and touches nothing', async () => {
  const p = await freshPipeline()
  p.dispatch({ type: 'planetPreview', width: ARCHEAN_INIT.width, height: ARCHEAN_INIT.height })
  await until(() => p.count('planetPreviewData') >= 1, { label: 'the planet preview', timeout: 60000 })
  const d = p.last('planetPreviewData')
  check('the preview carries the sample world\'s render at its size', d.buffer.byteLength === ARCHEAN_INIT.width * ARCHEAN_INIT.height * 4)
  check('the preview carries a climate at the climate grid', d.temperature.byteLength === d.resX * d.resY * 4 && d.precipitation.byteLength === d.resX * d.resY * 4)
  // A cold pipeline has no climate; the preview must not have given it one.
  p.dispatch({ type: 'hydrologyRun' })
  await until(() => p.count('stageDeclined') >= 1, { label: 'hydrology declined' })
  check('the preview cached no climate for the stages', p.count('climateData') === 0)
  // A supplied sample (2026-09-27) replaces the synthetic one: a flat ocean
  // at a quarter of the size, resampled to the map — a different picture.
  const before = d.buffer
  const flat = new Float32Array((ARCHEAN_INIT.width / 2) * (ARCHEAN_INIT.height / 2)).fill(-0.5)
  p.dispatch({ type: 'planetSample', width: ARCHEAN_INIT.width / 2, height: ARCHEAN_INIT.height / 2, elevation: flat.buffer })
  p.dispatch({ type: 'planetPreview', width: ARCHEAN_INIT.width, height: ARCHEAN_INIT.height })
  await until(() => p.count('planetPreviewData') >= 2, { label: 'the preview on the supplied sample', timeout: 60000 })
  const after = p.last('planetPreviewData').buffer
  check('the preview runs on the supplied sample', after.byteLength === before.byteLength && hash(after) !== hash(before))
})

// A sphere world's planet step (2026-10-11): the preview on the sphere's
// own sample, the climate on the sphere. The synthetic sample first (the
// fallback while no file is supplied), then a supplied one; the torus's
// sample and preview stay as they were beside it.
test('the Planet preview answers on a sphere sample: finite, pole rows one value, no seam', async () => {
  const p = await freshPipeline()
  const size = { width: ARCHEAN_INIT.width, height: ARCHEAN_INIT.height }
  p.dispatch({ type: 'planetPreview', ...size })
  await until(() => p.count('planetPreviewData') >= 1, { label: 'the torus preview', timeout: 60000 })
  const torus = p.last('planetPreviewData')
  const torusHash = hash(torus.buffer) + hash(torus.temperature)
  p.dispatch({ type: 'planetPreview', ...size, shape: 'sphere' })
  await until(() => p.count('planetPreviewData') >= 2, { label: 'the sphere preview', timeout: 60000 })
  const s = p.last('planetPreviewData')
  check('the preview says which shape it ran on', torus.shape === 'torus' && s.shape === 'sphere')
  check('the sphere preview carries a render at the map\'s size', s.buffer.byteLength === size.width * size.height * 4)
  check('the sphere\'s synthetic sample is not the torus\'s', hash(s.buffer) !== hash(torus.buffer))
  const RX = s.resX
  const RY = s.resY
  const n = RX * RY
  const f32 = (b) => new Float32Array(b)
  const scalars = { temperature: f32(s.temperature), precipitation: f32(s.precipitation), seasonalAmplitude: f32(s.seasonalAmplitude), monsoonIndex: f32(s.monsoonIndex), currentAnomaly: f32(s.currentAnomaly) }
  const fields = { ...scalars, wind: f32(s.wind), currents: f32(s.currents) }
  const notFinite = Object.entries(fields).filter(([, f]) => f.length === 0 || !allFinite(f)).map(([k]) => k)
  check(`every climate field of the sphere preview is whole and finite (${Object.keys(fields).length} fields)`, notFinite.length === 0, notFinite.join(', '))
  // The land, by the rain's sentinel.
  const land = new Uint8Array(n)
  for (let i = 0; i < n; i++) land[i] = scalars.precipitation[i] >= 0 ? 1 : 0
  // On the climate's field mesh since DEC-0036 phase 3: smooth round each
  // pole (ringRoughness), not one value along a pole row.
  const across = Object.entries(scalars).map(([k, f]) => [k, ringRoughness(f, RX, RY, land)])
  check(`the preview's fields are smooth round each pole, no star, land and sea apart (the largest step between neighbouring pixels of a pole row: ${across.map(([k, r]) => `${k} ${r.toFixed(3)}`).join(', ')} of the ring's range)`, across.every(([, r]) => r < 0.25))
  // No seam: the step from the last column to the first is no larger than
  // the largest step between neighbours inside the chart.
  const seams = Object.entries(scalars).map(([k, f]) => {
    let seam = 0
    let inner = 0
    for (let y = 0; y < RY; y++) {
      const row = y * RX
      seam = Math.max(seam, Math.abs(f[row] - f[row + RX - 1]))
      for (let x = 0; x + 1 < RX; x++) inner = Math.max(inner, Math.abs(f[row + x + 1] - f[row + x]))
    }
    return [k, seam, inner]
  }).filter(([, seam, inner]) => seam > inner)
  check('no field steps at the chart\'s seam more than inside it', seams.length === 0, seams.map(([k, a, b]) => `${k} ${a.toFixed(3)} > ${b.toFixed(3)}`).join(', '))

  // A supplied sphere sample replaces the synthetic one on the sphere only.
  const flat = new Float32Array((size.width / 2) * (size.height / 2)).fill(-0.5)
  p.dispatch({ type: 'planetSample', width: size.width / 2, height: size.height / 2, elevation: flat.buffer, shape: 'sphere' })
  p.dispatch({ type: 'planetPreview', ...size, shape: 'sphere' })
  await until(() => p.count('planetPreviewData') >= 3, { label: 'the sphere preview on the supplied sample', timeout: 60000 })
  check('the sphere preview runs on the supplied sphere sample', hash(p.last('planetPreviewData').buffer) !== hash(s.buffer))
  p.dispatch({ type: 'planetPreview', ...size })
  await until(() => p.count('planetPreviewData') >= 4, { label: 'the torus preview again', timeout: 60000 })
  const again = p.last('planetPreviewData')
  check('the torus preview is untouched by the sphere\'s sample', hash(again.buffer) + hash(again.temperature) === torusHash)
})

test('every message type is dispatchable from a cold start', async () => {
  // Not "does something sensible" — that is what the tests above are for. This
  // asks the cheaper question the HANDLERS table cannot: does any handler throw
  // when the state it expects is not there. A cold pipeline is the state every
  // one of them can actually meet, since the screen sends on user gestures.
  const cold = [
    { type: 'tectonicsStop' }, { type: 'tectonicsStart' }, { type: 'resetStage', stage: 'erosion' },
    { type: 'requestElevationField' },
    { type: 'planetPreview', width: ARCHEAN_INIT.width, height: ARCHEAN_INIT.height },
    { type: 'planetSample', width: 2, height: 1, elevation: new Float32Array(2).buffer },
    { type: 'climateRun', temperatureOffset: 0, temperatureContrast: 1, humidity: 1, equatorOffset: 0 },
    { type: 'hydrologyRun' },
    { type: 'ecologyRun' }, { type: 'migrationRun', origins: [] },
    { type: 'serializeWorld' },
    ...['genesis', 'tectonics', 'erosion', 'climate', 'hydrology', 'ecology', 'migration'].map((stage) => ({ type: 'resetStage', stage })),
    { type: 'genesisStart' }, { type: 'genesisStop' }, { type: 'genesisFinalize' },
  ]
  const p = await freshPipeline()
  const threw = []
  for (const message of cold) {
    try {
      p.dispatch(message)
    } catch (error) {
      threw.push(`${message.type}: ${error.message}`)
    }
  }
  await settle(200)
  p.dispatch({ type: 'genesisStop' })
  check(`all ${cold.length} messages survive a cold start`, threw.length === 0, threw.join('; '))
})

// ------------------------------------------------------------------- determinism

test('two pipelines given the same messages agree byte for byte', async () => {
  const a = await freshPipeline()
  const b = await freshPipeline()
  await growWorld(a)
  await growWorld(b)
  check('the same seed and the same messages produce the same world', hash(a.last('rendered').elevation) === hash(b.last('rendered').elevation))
  // The standing-water list and the level field it derives (phase 1 of the
  // adaptive-mesh plan): the save carries the list, so two runs of one world
  // must agree on every basin's level to the byte, not just on the terrain.
  for (const p of [a, b]) {
    // Eroded first, so the sediment basins (F1) have deposits to list — by
    // exactly one epoch each, so the two worlds are comparable.
    const epochBefore = p.last('rendered').epoch
    const settledBefore = p.settledRenders()
    await runOneEpoch(p)
    // A stop is a stop: the epoch in flight settles, and nothing runs after
    // it. The seamless tick (2026-09-26) once outlived the stop and ran one
    // more epoch behind the settled picture — the rivers of N+1 over the
    // land of N.
    check('a start and a stop are exactly one epoch and one settled render', p.last('rendered').epoch === epochBefore + 1 && p.settledRenders() === settledBefore + 1, `epochs +${p.last('rendered').epoch - epochBefore}, settled +${p.settledRenders() - settledBefore}`)
    p.dispatch({ type: 'climateRun', temperatureOffset: 0, temperatureContrast: 1, humidity: 1, equatorOffset: 0 })
    await until(() => p.count('climateData') >= 1, { label: 'climate' })
    p.dispatch({ type: 'hydrologyRun' })
    await until(() => p.count('hydrologyData') >= 1, { label: 'hydrology' })
  }
  check('both worlds ran the same number of epochs', a.last('rendered').epoch === b.last('rendered').epoch, `${a.last('rendered').epoch} vs ${b.last('rendered').epoch}`)
  check('the eroded terrains agree byte for byte', hash(a.last('rendered').elevation) === hash(b.last('rendered').elevation))
  const ha = a.last('hydrologyData'), hb = b.last('hydrologyData')
  check('the water bodies are the same list', JSON.stringify(ha.waterBodies) === JSON.stringify(hb.waterBodies) && Array.isArray(ha.waterBodies))
  check('the water level field is byte-identical', hash(new Float32Array(ha.waterLevel)) === hash(new Float32Array(hb.waterLevel)) && ha.waterLevel.byteLength > 0)
  check('the river graph is byte-identical', ha.riverGraph !== null && hb.riverGraph !== null && ha.riverGraph.json === hb.riverGraph.json && hash(new Int32Array(ha.riverGraph.cells)) === hash(new Int32Array(hb.riverGraph.cells)))
  check('the river courses are byte-identical', ha.riverGraph !== null && hb.riverGraph !== null && hash(new Float32Array(ha.riverGraph.coursePoints)) === hash(new Float32Array(hb.riverGraph.coursePoints)))
  check('a re-route carries the list, a repeat does not', ha.waterSurface.byteLength === ha.waterLevel.byteLength / 4)
  check('the ice is byte-identical', hash(new Float32Array(ha.iceThickness)) === hash(new Float32Array(hb.iceThickness)) && ha.iceThickness.byteLength === ha.waterLevel.byteLength, `ice ${ha.iceThickness.byteLength} / ${hb.iceThickness.byteLength} bytes, level ${ha.waterLevel.byteLength}; hashes ${hash(new Float32Array(ha.iceThickness))} ${hash(new Float32Array(hb.iceThickness))}`)
  check('the sediment basins are the same list', JSON.stringify(ha.sedimentBasins) === JSON.stringify(hb.sedimentBasins) && Array.isArray(ha.sedimentBasins) && ha.sedimentBasins.length > 0)
  check('the coast is byte-identical', ha.coast !== null && hb.coast !== null && JSON.stringify(ha.coast.reaches) === JSON.stringify(hb.coast.reaches) && hash(new Uint8Array(ha.coastType)) === hash(new Uint8Array(hb.coastType)) && ha.coastType.byteLength > 0)
  check('the coast\'s nodes, the discharge and the watersheds are byte-identical', hash(new Int32Array(ha.coast.nodes)) === hash(new Int32Array(hb.coast.nodes)) && hash(new Float32Array(ha.discharge)) === hash(new Float32Array(hb.discharge)) && hash(new Uint16Array(ha.watersheds)) === hash(new Uint16Array(hb.watersheds)) && ha.discharge.byteLength > 0)
})

// DEC-0036 phase 7b: the hydrology runs on the mesh's nodes, so a world
// saved and loaded again answers with the same discharge, lakes,
// watersheds, river network and coast walk as the session it was saved
// from — the mesh and its heights are the save's bit for bit, and its
// routing is derived from them as the last epoch's erosion left it. And
// the save's discharge per node is the session's. And since 2026-10-12 all
// of it: the save carries what the last epoch left per node (the sediment
// flux, the heights its erosion started from, the ice — mesh/sedimentFlux.
// f32, mesh/preErosionZ.f32, mesh/ice.f32), so the reaches' loads, the
// river courses' deltas, the coast's supply and types, the sediment basins
// and the glaciers are the session's too. Before, a load had neither the
// flux nor the start: its reaches carried no sediment, its coasts had
// other types, it had no basins and its ice was the steady state of the
// loaded climate.
test('a loaded world runs the hydrology the session ran', async () => {
  const p = await freshPipeline()
  // 28 Archean epochs, not the harness's 20: since DEC-0036 phase 8d
  // (the cut near the snow line is the buzzsaw's, no longer twice the
  // sliding's) the 20-epoch world's trunk river runs through a chain of
  // lakes and leaves no reach long enough for a course; since phase 8f
  // (the plates' speed) the 22-epoch world has none either; since phase
  // 8g-2 (the uplift at the continents' margins) none of 18–24 has one
  // (26, 28 and 30 have courses).
  await growWorld(p, { epochs: 28 })
  await runOneEpoch(p)
  // Humidity 160 %: with the colder, drier mid-latitudes of DEC-0036
  // phase 8b-2 no river of this small world is wide enough for a course,
  // and the check below needs courses to compare.
  const climate = { type: 'climateRun', temperatureOffset: 0, temperatureContrast: 1, humidity: 1.6, equatorOffset: 0 }
  p.dispatch(climate)
  await until(() => p.count('climateData') >= 1, { label: 'climate' })
  p.dispatch({ type: 'hydrologyRun' })
  await until(() => p.count('hydrologyData') >= 1, { label: 'hydrology' })
  await quiet(p)
  const world = worldDataOf(p)
  const q = await freshPipeline()
  q.dispatch(asRestore(world))
  await until(() => q.count('rendered') >= 1, { label: 'the restore render' })
  await quiet(q)
  q.dispatch(climate)
  await until(() => q.count('climateData') >= 1, { label: 'the loaded climate' })
  q.dispatch({ type: 'hydrologyRun' })
  await until(() => q.count('hydrologyData') >= 1, { label: 'the loaded hydrology' })
  await quiet(q)
  const hs = p.last('hydrologyData'), hl = q.last('hydrologyData')
  const reloaded = worldDataOf(q)
  check('the loaded discharge, watersheds and lakes are the session\'s, byte for byte', hash(hs.discharge) === hash(hl.discharge) && hash(hs.watersheds) === hash(hl.watersheds) && hash(hs.lakeDepth) === hash(hl.lakeDepth) && hs.discharge.byteLength > 0)
  const gs = JSON.parse(hs.riverGraph.json)
  const loaded = gs.reaches.reduce((n, r) => n + (r.sedimentM3 > 0 ? 1 : 0), 0)
  check(`the loaded river graph is the session's, the reaches' sediment loads included (${loaded} of ${gs.reaches.length} reaches carry sediment)`, hs.riverGraph.json === hl.riverGraph.json && hash(hs.riverGraph.cells) === hash(hl.riverGraph.cells) && loaded > 0)
  check('the loaded river courses are the session\'s, their deltas included', hash(hs.riverGraph.coursePoints) === hash(hl.riverGraph.coursePoints) && hs.riverGraph.coursePoints.byteLength > 0, `${hs.riverGraph.coursePoints.byteLength} / ${hl.riverGraph.coursePoints.byteLength} bytes`)
  const types = new Set(hs.coast.reaches.map((r) => r.type))
  check(`the loaded coast is the session's, its supply and types included (${hs.coast.reaches.length} reaches, ${types.size} types)`, JSON.stringify(hs.coast.reaches) === JSON.stringify(hl.coast.reaches) && hash(hs.coast.nodes) === hash(hl.coast.nodes) && hash(hs.coastType) === hash(hl.coastType))
  check(`the loaded sediment basins are the session's (${hs.sedimentBasins.length})`, JSON.stringify(hs.sedimentBasins) === JSON.stringify(hl.sedimentBasins) && hs.sedimentBasins.length > 0)
  check('the loaded ice is the session\'s', hash(hs.iceThickness) === hash(hl.iceThickness) && hs.iceThickness.byteLength > 0)
  check('the save\'s discharge per node comes back the same from the loaded world', world.land?.discharge != null && reloaded.land?.discharge != null && hash(world.land.discharge) === hash(reloaded.land.discharge))
})

// A save between two pictures: the history draws every renderEvery-th
// epoch, and the mesh's bytes for the save were encoded once per picture
// (runtime.meshPayload), so a save at an epoch that drew none got the
// mesh of an earlier epoch under the plates of this one — a world that
// does not continue (2026-10-12). Polled between two epochs while the
// loop runs: at an epoch that drew no picture, the save's mesh must be the
// one the stop's own picture of that same epoch encodes afresh.
test('a save between two pictures carries the epoch\'s own mesh', async () => {
  const p = await freshPipeline()
  await growWorld(p)
  p.dispatch({ type: 'tectonicsStart' })
  let previous = null
  let found = null
  const deadline = Date.now() + 600000
  while (!found && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5))
    const w = worldDataOf(p)
    const drawn = p.last('rendered')?.epoch ?? -1
    // This epoch drew no picture, and the save before it was of the epoch
    // before: what it encoded, a stale cache would hand out again.
    if (previous && w.snapshot.epoch === previous.snapshot.epoch + 1 && drawn < w.snapshot.epoch) found = { w, previous }
    previous = w
  }
  if (!found) throw new Error('no epoch without a picture after a saved one')
  // Stopped in this macrotask: no epoch in flight, so the settled picture is
  // of the same epoch, and the save after it encodes the mesh afresh.
  const settled = p.settledRenders()
  p.dispatch({ type: 'tectonicsStop' })
  await until(() => p.settledRenders() > settled, { label: 'the settled render' })
  await quiet(p)
  const fresh = worldDataOf(p)
  const meshHash = (w) => [w.mesh.nodes, w.mesh.connectivity, w.mesh.z, w.mesh.column, w.mesh.sedimentFlux, w.mesh.ice].map((b) => (b ? hash(b) : '-')).join('.')
  check('the stop settled on the epoch the save was taken at', fresh.snapshot.epoch === found.w.snapshot.epoch, `${fresh.snapshot.epoch} vs ${found.w.snapshot.epoch}`)
  check(`the save at epoch ${found.w.snapshot.epoch} (no picture) carries that epoch's mesh, not epoch ${found.previous.snapshot.epoch}'s`, meshHash(found.w) === meshHash(fresh) && meshHash(found.w) !== meshHash(found.previous))
})

// -------------------------------------------------------------------- stopping

// A stop that lands BETWEEN two epochs — as the screen's does: the message
// waits in the worker's queue while an epoch runs. No epoch may START after
// it, so the settled picture is of the epoch the world stood at when the
// stop was handled — read in the same macrotask (worldEpoch), not off a
// picture, which shows only every renderEvery-th epoch. Until 2026-10-11
// the loop was an interval plus a zero-delay tick per late epoch: the
// ticks built chains that queued ahead of the stop and ran epochs past it
// (settled one epoch behind the stop, now and then), and the hydrology then
// drew the rivers of N+1 over the land of N.
test('a stop between two epochs runs no epoch after it', async () => {
  const p = await freshPipeline()
  await growWorld(p)
  const settledBefore = p.settledRenders()
  const renders = p.count('rendered')
  p.dispatch({ type: 'tectonicsStart' })
  await until(() => p.count('rendered') > renders, { label: 'the first epoch picture', timeout: 180000 })
  // One epoch more, so the stop finds the loop between two epochs and not
  // just after its first.
  const first = worldEpoch(p)
  await until(() => worldEpoch(p) > first, { label: 'a second epoch', timeout: 180000 })
  // Queued as the screen's message would be: a macrotask between two epochs.
  // The world's epoch is read in that same macrotask.
  let atStop = -1
  await new Promise((r) => setTimeout(() => {
    atStop = worldEpoch(p)
    p.dispatch({ type: 'tectonicsStop' })
    r()
  }, 0))
  await until(() => p.settledRenders() > settledBefore, { label: 'the settled render', timeout: 180000 })
  await quiet(p)
  const all = p.messages.filter((m) => m.type === 'rendered').slice(renders)
  const settled = all.findLast((m) => !m.intermediate)
  const sequence = all.map((m) => `${m.epoch}${m.intermediate ? 'i' : 's'}`).join(' ')
  check('no epoch starts after the stop', settled.epoch === atStop && all.at(-1) === settled && all.every((m) => m.epoch <= atStop) && worldEpoch(p) === atStop, `epoch at the stop ${atStop}, settled epoch ${settled.epoch}; renders: ${sequence}`)
  check('exactly one settled render follows the stop', p.settledRenders() === settledBefore + 1, `+${p.settledRenders() - settledBefore}`)
})

// The loop keeps ONE timer at most: a step, then the next one scheduled
// when it is done. The interval it replaced added a zero-delay tick per
// epoch that outlasted the interval, and those chains never died (6 after
// 22 epochs, 2026-10-11). Counted on the timers the runtime module itself
// creates, by the stack that creates them.
test('the history keeps one timer at most, and none after the stop', async () => {
  const p = await freshPipeline()
  await growWorld(p)
  const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval }
  const pending = new Set()
  let most = 0
  const fromRuntime = () => (new Error().stack ?? '').includes('pipeline/runtime.ts')
  const track = (handle) => {
    pending.add(handle)
    most = Math.max(most, pending.size)
    return handle
  }
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (!fromRuntime()) return real.setTimeout(fn, ms, ...args)
    const handle = real.setTimeout((...a) => { pending.delete(handle); fn(...a) }, ms, ...args)
    return track(handle)
  }
  globalThis.setInterval = (fn, ms, ...args) => {
    const handle = real.setInterval(fn, ms, ...args)
    return fromRuntime() ? track(handle) : handle
  }
  globalThis.clearTimeout = (handle) => { pending.delete(handle); real.clearTimeout(handle) }
  globalThis.clearInterval = (handle) => { pending.delete(handle); real.clearInterval(handle) }
  try {
    const settledBefore = p.settledRenders()
    const target = worldEpoch(p) + 6
    p.dispatch({ type: 'tectonicsStart' })
    await until(() => worldEpoch(p) >= target, { label: 'six epochs', timeout: 600000 })
    p.dispatch({ type: 'tectonicsStop' })
    const atStop = worldEpoch(p)
    await until(() => p.settledRenders() > settledBefore, { label: 'the settled render', timeout: 180000 })
    await quiet(p)
    check('at most one runtime timer pending at any time while it ran', most === 1, `at most ${most}`)
    check('none pending after the stop', pending.size === 0, `${pending.size} pending`)
    const messages = p.messages.length
    await settle(1500)
    check('and nothing runs after it: no message, the same epoch', p.messages.length === messages && worldEpoch(p) === atStop, `${p.messages.length - messages} messages, epoch ${atStop} → ${worldEpoch(p)}`)
  } finally {
    Object.assign(globalThis, real)
  }
})

// A step that throws ends its loop: the stage is said to have failed
// (stageFailed, which the screen shows and on which it leaves its running
// state), the settled picture follows without a stop, and the harness — or
// the worker — lives on. Before 2026-10-11 the step's promise had no catch:
// in node the rejection ended the process, in the browser the screen waited
// for a settled picture that never came. Made to throw from outside: the
// Archean through the host's engine, the tectonics on a world with no
// plates (a restored snapshot without seeds).
test('a history step that throws stops its loop and says so', async () => {
  const quietConsole = console.error
  console.error = () => {}
  try {
    const a = await freshPipeline()
    a.dispatch({ ...ARCHEAN_INIT })
    await until(() => a.count('rendered') >= 1, { label: 'the first Archean render' })
    a.dispatch({ type: 'genesisStart' })
    await until(() => a.count('genesisStatus') >= 3, { label: 'three Archean epochs' })
    a.failSteps(true)
    await until(() => a.count('stageFailed') >= 1, { label: 'the failed Archean step' })
    const statuses = a.count('genesisStatus')
    await settle(300)
    check('a throwing Archean step answers stageFailed for the genesis', a.count('stageFailed') === 1 && a.last('stageFailed').stage === 'genesis', a.messages.filter((m) => m.type === 'stageFailed').map((m) => `${m.stage}: ${m.error}`).join('; '))
    check('and its loop stops', a.count('genesisStatus') === statuses, `${statuses} -> ${a.count('genesisStatus')} statuses`)
    a.failSteps(false)
    a.dispatch({ type: 'genesisStart' })
    await until(() => a.count('genesisStatus') > statuses + 2, { label: 'the Archean again' })
    a.dispatch({ type: 'genesisStop' })
    await quiet(a)
    check('the Archean starts again after it', a.count('stageFailed') === 1)

    const p = await freshPipeline()
    await growWorld(p)
    const world = structuredClone(worldDataOf(p))
    world.snapshot.seeds = []
    const q = await freshPipeline()
    q.dispatch(asRestore(world))
    await until(() => q.count('rendered') >= 1, { label: 'the restore render' })
    await quiet(q)
    const settledBefore = q.settledRenders()
    q.dispatch({ type: 'tectonicsStart' })
    await until(() => q.count('stageFailed') >= 1, { label: 'the failed epoch', timeout: 180000 })
    await until(() => q.settledRenders() > settledBefore, { label: 'the settled render after the failure', timeout: 180000 })
    await quiet(q)
    check('a throwing epoch answers stageFailed for the tectonics', q.count('stageFailed') === 1 && q.last('stageFailed').stage === 'tectonics', q.messages.filter((m) => m.type === 'stageFailed').map((m) => `${m.stage}: ${m.error}`).join('; '))
    const after = q.messages.slice(q.messages.findIndex((m) => m.type === 'stageFailed'))
    check('the settled picture follows it, unasked, and nothing after', q.settledRenders() === settledBefore + 1 && after.filter((m) => m.type === 'rendered').length === 1 && !q.last('rendered').intermediate, after.map((m) => m.type).join(' '))
    const messages = q.messages.length
    await settle(500)
    check('the loop is stopped', q.messages.length === messages)
  } finally {
    console.error = quietConsole
  }
})

// --------------------------------------------------------- level 1's replay

test("the replay makes the saved world again, across a load", async () => {
  // The engine's replay of a world's history (world/replay.ts's plan) —
  // what the job worker does for level 1 (docs/decisions/detail-ladder.md,
  // fork 2). At the history's budget it must land on the bytes the runtime
  // saved, or every level is of another world. The world here is made the
  // way the screen makes one, with a load in the middle (the `restored`
  // run). The checkpoints are the native build's (engine/scripts/smoke.mjs).
  const RP = await server.ssrLoadModule('/src/world/runParams.ts')
  const WS = await server.ssrLoadModule('/src/world/save/worldSpec.ts')
  const WH = await server.ssrLoadModule('/src/world/save/worldHistory.ts')
  const RE = await server.ssrLoadModule('/src/world/replay.ts')
  const values = Object.fromEntries(WS.WORLD_SPEC_FIELDS.map((f) => [f.path, f.input.default]))
  const genesis = { mantleDiffusion: RP.mantleDiffusionFromVigour(values['genesis.mantleVigour']), landShare: RP.landShareFromControl(values['genesis.landShare']) }
  const start = { type: 'tectonicsStart', alluvium: values['tectonics.alluvium'], rockContrast: values['tectonics.rockContrast'], weather: RP.weatherParamsFrom((path) => values[path]) }
  const run = async (q, n) => {
    const settledBefore = q.settledRenders()
    const renders = q.count('rendered')
    q.dispatch(start)
    await until(() => q.count('rendered') >= renders + n, { label: `${n} pictures`, timeout: 180000 })
    q.dispatch({ type: 'tectonicsStop' })
    await until(() => q.settledRenders() > settledBefore, { label: 'the settled render', timeout: 180000 })
    await quiet(q)
    return q.last('rendered').epoch
  }
  const serialize = async (q) => {
    const before = q.count('worldData')
    q.dispatch({ type: 'serializeWorld' })
    await until(() => q.count('worldData') > before, { label: 'the serialized world' })
    return q.last('worldData')
  }

  const p = await freshPipeline()
  p.dispatch({ ...ARCHEAN_INIT, seed: 'replay', ...genesis })
  await until(() => p.count('rendered') >= 1, { label: 'the first Archean render' })
  p.dispatch({ type: 'genesisStart', ...genesis })
  await until(() => p.count('genesisStatus') >= ARCHEAN_EPOCHS, { label: 'the Archean' })
  p.dispatch({ type: 'genesisStop' })
  await quiet(p)
  const handover = p.count('rendered')
  p.dispatch({ type: 'genesisFinalize' })
  await until(() => p.count('rendered') > handover, { label: 'the hand-over render' })
  await quiet(p)
  const archeanEpochs = p.last('genesisStatus').epoch
  // Two pictures are at least four epochs (one every third, the first
  // always): a scheduled climate epoch inside the run, where a checkpoint
  // is offered.
  const before = await run(p, 2)
  const saved = await serialize(p)
  const q = await freshPipeline()
  q.dispatch(asRestore(saved, 'replay'))
  await until(() => q.count('rendered') >= 1, { label: 'the restore render' })
  await quiet(q)
  const after = await run(q, 1)
  const final = (await serialize(q)).mesh

  const runOf = (epochs, fields, restored) => ({ epochs, generator: '', code: '', values: WH.runValues(fields, values), ...(restored ? { restored: true } : {}) })
  const recipe = {
    seed: 'replay', width: W, height: H,
    history: { genesis: [runOf(archeanEpochs, WH.GENESIS_RUN_FIELDS)], tectonics: [runOf(before, WH.TECTONICS_RUN_FIELDS), runOf(after - before, WH.TECTONICS_RUN_FIELDS, true)] },
  }
  // Bytes, whatever holds them: the save's ArrayBuffers, the encoder's views.
  const bytes = (x) => (x instanceof ArrayBuffer ? x : x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength))
  const parts = (mesh) => ['nodes', 'connectivity', 'z', 'column'].map((k) => hash(bytes(mesh[k]))).join(' ')
  const savedParts = parts(final)
  const replay = WASM.Replay.start(RE.planFromRecipe(recipe), 0)
  while (replay.step());
  const replayed = replay.world()
  check('the replay lands on the saved mesh bit for bit', parts(replayed.meshPayload()) === savedParts, `${before} + ${after - before} epochs`)
  replayed.free()
  check('a history without its code is refused', RE.replayRefusal(recipe.history, 'abc') !== null)

  // The same replay through the runtime (the generator's "make again" on
  // load): progress per epoch, the end, the render, the same bytes.
  const g = await freshPipeline()
  g.dispatch({ type: 'replayRuns', plan: RE.planFromRecipe(recipe) })
  await until(() => g.count('replayDone') >= 1 && g.messages.findIndex((m) => m.type === 'rendered') > g.messages.findIndex((m) => m.type === 'replayDone'), { label: 'the replay in the runtime', timeout: 600000 })
  await quiet(g)
  const done = g.last('replayDone')
  const total = recipe.history.tectonics.reduce((n, r) => n + r.epochs, 0)
  check('the runtime replays with progress per epoch, then its end, then a render', g.count('replayProgress') === total && done.epoch === after && done.archeanEpochs === archeanEpochs, `${g.count('replayProgress')} progress for ${total} epochs; epoch ${done.epoch}, archean ${done.archeanEpochs}`)
  check('and lands on the same bytes', parts((await serialize(g)).mesh) === savedParts)
})

// ------------------------------------------------------------------------- run

console.log('')
const started = Date.now()
// Each test's wall time, for the summary at the end: the harness's cost is
// where it is spent, and a slow test is otherwise invisible in the total.
const timings = []
for (const { name, run } of TESTS) {
  if (!name.includes(ONLY)) continue
  console.log(`— ${name}`)
  const t0 = Date.now()
  try {
    await run()
  } catch (error) {
    failures++
    console.log(`  FAIL  ${error.message}`)
  }
  timings.push({ name, s: (Date.now() - t0) / 1000 })
}

// The coverage holds for the whole run only.
if (ONLY === '') {
  console.log('— coverage')
  const handled = (await server.ssrLoadModule('/src/generator/pipeline/runtime.ts')).HANDLED_MESSAGE_TYPES
  const untested = handled.filter((t) => !dispatchedTypes.has(t))
  check(`every one of the ${handled.length} message types is exercised somewhere above`, untested.length === 0, untested.join(', '))
}

await server.close()
console.log('\n— time per test, slowest first')
for (const { name, s } of [...timings].sort((a, b) => b.s - a.s)) console.log(`  ${s.toFixed(1).padStart(6)} s  ${name.length > 90 ? `${name.slice(0, 87)}...` : name}`)
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failed, ${Math.round((Date.now() - started) / 1000)}s`)
process.exit(failures === 0 ? 0 : 1)
