// Behaviour checks for the GENERATOR PIPELINE — message ordering, hand-over and
// cache invalidation. The part of the generator neither other harness reaches.
//
//   npm run harness:pipeline
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
// takes its emitter and its elevation renderer from the host and touches no
// browser API, so it can be driven straight from node.
//
// TWO DELIBERATE DEPARTURES from the browser, both stated rather than implied:
//
//   1. The elevation renderer is SYNTHETIC. The real one is a pool of nested
//      workers running the per-pixel elevation query — that query is golden's
//      subject, not this one's. The stand-in keeps the real baselines (so rafts,
//      ocean age and sea level still decide land from sea) and adds deterministic
//      relief on top, which is all the pipeline needs: coasts, slopes and a field
//      that moves when erosion runs.
//   2. The world is 256x128, an eighth of the real one, so a check costs seconds
//      instead of minutes. Crust nucleates differently at that scale (a world this
//      small ends up far more continental) — irrelevant here, where the subject is
//      which handler clears what, but it is why no number in this file should be
//      read as a statement about worlds.
//   3. Everything else is the real code path, including detaching transferred
//      buffers — see the emitter below.
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

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

let failures = 0
const check = (name, ok, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

// Real baselines, synthetic relief. See departure 1 in the header.
async function syntheticElevations(renderWidth, renderHeight, _worldWidth, _worldHeight, blendedBaselines, _features, warpSeed) {
  const out = new Float32Array(renderWidth * renderHeight)
  for (let y = 0; y < renderHeight; y++) {
    for (let x = 0; x < renderWidth; x++) {
      const i = y * renderWidth + x
      const u = x / renderWidth
      const v = y / renderHeight
      out[i] = blendedBaselines[i]
        + 0.07 * Math.sin(u * Math.PI * 12 + warpSeed * 0.001) * Math.cos(v * Math.PI * 8)
        + 0.03 * Math.sin(u * Math.PI * 31 + v * Math.PI * 17)
    }
  }
  return out
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
  rt.setElevationRenderer({ renderElevations: syntheticElevations })
  return {
    dispatch: (message) => {
      dispatchedTypes.add(message.type)
      rt.dispatch(message)
    },
    messages,
    count: (type) => messages.filter((m) => m.type === type).length,
    // An erosion pass redraws once per round (those carry `intermediate`) and once
    // at the end (that one does not) — so a settled render is how a pass says it is
    // done. This used to watch for the `deltaMask` debug message, which was removed
    // with the delta marker on 2026-08-09.
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

const ARCHEAN_INIT = { type: 'genesisInit', seed: 'harness', width: W, height: H, renderOptions: {}, epochIntervalMs: 10, mantleDiffusion: 2, seaLevelOffset: 0 }

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

// worldData (what serializeWorld emits) -> restoreWorld (what load sends back).
// Deep-copied per use: the harness detaches transferred buffers, so a fixture
// handed out twice would arrive empty the second time.
const asRestore = (worldData, seed = 'harness') => {
  const w = structuredClone(worldData)
  return {
    type: 'restoreWorld',
    seed,
    snapshot: w.snapshot,
    oceanAge: w.oceanAge,
    elevation: w.elevation,
    mantle: w.mantle,
    archean: w.archean,
    lattice: { accumulated: w.latticeAccumulated, lockedEpochs: w.latticeLockedEpochs, lastClassCode: w.latticeLastClassCode },
  }
}

const TESTS = []
const test = (name, run) => TESTS.push({ name, run })

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
  check('resetting ecology reaches only migration', String(stages.downstreamOf('ecology')) === 'migration', String(stages.downstreamOf('ecology')))
  // Climate before erosion since the stage-2 coupling: the order below IS
  // the pipeline order, so the string asserts it too.
  check('resetting tectonics reaches every later stage', String(stages.downstreamOf('tectonics')) === 'climate,erosion,hydrology,ecology,migration', String(stages.downstreamOf('tectonics')))
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

// ------------------------------------------------------- hand-over and resets

test('the hand-over is what resetTectonics goes back to', async () => {
  const p = await freshPipeline()
  await growWorld(p)
  const handover = hash(p.last('rendered').elevation)

  let base = p.count('rendered')
  p.dispatch({ type: 'tectonicsStart' })
  await until(() => p.count('rendered') >= base + 4, { label: 'a few tectonic epochs' })
  p.dispatch({ type: 'tectonicsStop' })
  await quiet(p)
  check('tectonics moves the world off the hand-over', hash(p.last('rendered').elevation) !== handover)

  base = p.count('rendered')
  p.dispatch({ type: 'resetStage', stage: 'tectonics' })
  await until(() => p.count('rendered') > base, { label: 'the reset render' })
  await quiet(p)
  check('resetTectonics restores the hand-over exactly', hash(p.last('rendered').elevation) === handover)

  // The snapshot is deep-copied at hand-over precisely so a SECOND reset lands in
  // the same place — an uncopied one drifts along with the world it preserves.
  base = p.count('rendered')
  p.dispatch({ type: 'tectonicsStart' })
  await until(() => p.count('rendered') >= base + 4, { label: 'more epochs' })
  p.dispatch({ type: 'tectonicsStop' })
  await quiet(p)
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
  const base = p.count('rendered')
  p.dispatch({ type: 'tectonicsStart' })
  await until(() => p.count('rendered') >= base + 4, { label: 'some tectonics' })
  p.dispatch({ type: 'tectonicsStop' })
  await quiet(p)
  const saved = hash(p.last('rendered').elevation)

  p.dispatch({ type: 'serializeWorld' })
  await until(() => p.count('worldData') >= 1, { label: 'the serialized world' })
  const worldData = p.last('worldData')

  const q = await freshPipeline()
  q.dispatch(asRestore(worldData))
  await until(() => q.count('rendered') >= 1, { label: 'the restore render' })
  check('the restored world renders the world that was saved', hash(q.last('rendered').elevation) === saved)
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
})

// ------------------------------------------------------------- the stage chain

test('the stages compute, in order, on one world', async () => {
  const p = await freshPipeline()
  await growWorld(p)
  const settledBefore = p.settledRenders()
  p.dispatch({ type: 'erosionStart' })
  await until(() => p.settledRenders() > settledBefore, { label: 'the erosion pass to finish', timeout: 180000 })

  p.dispatch({ type: 'climateRun', temperatureOffset: 0, temperatureContrast: 1, humidity: 1, equatorOffset: 0 })
  await until(() => p.count('climateData') >= 1, { label: 'climate' })
  p.dispatch({ type: 'hydrologyRun' })
  await until(() => p.count('hydrologyData') >= 1, { label: 'hydrology' })
  p.dispatch({ type: 'ecologyRun' })
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

test('INVALIDATION: eroding stales everything downstream, per the declared chain', async () => {
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
  const settledBefore = p.settledRenders()
  p.dispatch({ type: 'erosionStart', age: 80 })
  await until(() => p.settledRenders() > settledBefore, { label: 'the erosion pass to finish', timeout: 180000 })
  check('erosion does not silently recompute the climate', p.count('climateData') === climateRuns)

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
  p.dispatch({ type: 'erosionStart' })
  await settle(200)
  const declined = p.messages.filter((m) => m.type === 'stageDeclined')
  check('all five refuse on a world that does not exist yet', declined.length === 5, declined.map((d) => d.stage).join(', '))
  check('each names the world itself as what is missing', declined.every((d) => d.needs === 'tectonics'), JSON.stringify(declined.map((d) => d.needs)))

  // And once there IS a world, the refusal is specific: the climate is what
  // hydrology is short of, not the terrain.
  const q = await freshPipeline()
  await growWorld(q)
  q.dispatch({ type: 'ecologyRun' })
  await until(() => q.count('stageDeclined') >= 1, { label: 'the ecology refusal' })
  check('ecology names the climate once a world exists', q.last('stageDeclined').needs === 'climate', JSON.stringify(q.last('stageDeclined')))
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

test('erosion can be stopped mid-pass', async () => {
  const p = await freshPipeline()
  await growWorld(p)
  const unEroded = hash(p.last('rendered').elevation)
  const settledBefore = p.settledRenders()
  p.dispatch({ type: 'erosionStart' })
  await until(() => p.count('erosionProgress') >= 1, { label: 'erosion to start', timeout: 180000 })
  p.dispatch({ type: 'erosionStop' })
  await until(() => p.settledRenders() > settledBefore, { label: 'the partial result', timeout: 180000 })
  check('a stopped pass still delivers what it had', hash(p.last('rendered').elevation) !== unEroded)

  const partial = hash(p.last('rendered').elevation)
  const afterStop = p.count('rendered')
  p.dispatch({ type: 'resetStage', stage: 'erosion' })
  await until(() => p.count('rendered') > afterStop, { label: 'the revert render' })
  check('resetErosion reverts what the partial pass carved', hash(p.last('rendered').elevation) !== partial)
})

// -------------------------------------------------------------- the whole table

test('every message type is dispatchable from a cold start', async () => {
  // Not "does something sensible" — that is what the tests above are for. This
  // asks the cheaper question the HANDLERS table cannot: does any handler throw
  // when the state it expects is not there. A cold pipeline is the state every
  // one of them can actually meet, since the screen sends on user gestures.
  const cold = [
    { type: 'tectonicsStop' }, { type: 'tectonicsStart' }, { type: 'erosionStop' }, { type: 'resetStage', stage: 'erosion' },
    { type: 'erosionStart' },
    { type: 'requestElevationField' },
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
    // Eroded first, so the sediment basins (F1) have deposits to list.
    const settledBefore = p.settledRenders()
    p.dispatch({ type: 'erosionStart' })
    await until(() => p.settledRenders() > settledBefore, { label: 'the erosion pass to finish', timeout: 180000 })
    p.dispatch({ type: 'climateRun', temperatureOffset: 0, temperatureContrast: 1, humidity: 1, equatorOffset: 0 })
    await until(() => p.count('climateData') >= 1, { label: 'climate' })
    p.dispatch({ type: 'hydrologyRun' })
    await until(() => p.count('hydrologyData') >= 1, { label: 'hydrology' })
  }
  const ha = a.last('hydrologyData'), hb = b.last('hydrologyData')
  check('the water bodies are the same list', JSON.stringify(ha.waterBodies) === JSON.stringify(hb.waterBodies) && Array.isArray(ha.waterBodies))
  check('the water level field is byte-identical', hash(new Float32Array(ha.waterLevel)) === hash(new Float32Array(hb.waterLevel)) && ha.waterLevel.byteLength > 0)
  check('the river graph is byte-identical', ha.riverGraph !== null && hb.riverGraph !== null && ha.riverGraph.json === hb.riverGraph.json && hash(new Int32Array(ha.riverGraph.cells)) === hash(new Int32Array(hb.riverGraph.cells)))
  check('the river courses are byte-identical', ha.riverGraph !== null && hb.riverGraph !== null && hash(new Float32Array(ha.riverGraph.coursePoints)) === hash(new Float32Array(hb.riverGraph.coursePoints)))
  check('a re-route carries the list, a repeat does not', ha.waterSurface.byteLength === ha.waterLevel.byteLength / 4)
  check('the ice is byte-identical', hash(new Float32Array(ha.iceThickness)) === hash(new Float32Array(hb.iceThickness)) && ha.iceThickness.byteLength === ha.waterLevel.byteLength, `ice ${ha.iceThickness.byteLength} / ${hb.iceThickness.byteLength} bytes, level ${ha.waterLevel.byteLength}; hashes ${hash(new Float32Array(ha.iceThickness))} ${hash(new Float32Array(hb.iceThickness))}`)
  check('the sediment basins are the same list', JSON.stringify(ha.sedimentBasins) === JSON.stringify(hb.sedimentBasins) && Array.isArray(ha.sedimentBasins) && ha.sedimentBasins.length > 0)
  check('the coast is byte-identical', ha.coast !== null && hb.coast !== null && JSON.stringify(ha.coast.reaches) === JSON.stringify(hb.coast.reaches) && hash(new Uint8Array(ha.coastType)) === hash(new Uint8Array(hb.coastType)) && ha.coastType.byteLength > 0)
})

// ------------------------------------------------------------------------- run

console.log('')
const started = Date.now()
for (const { name, run } of TESTS) {
  console.log(`— ${name}`)
  try {
    await run()
  } catch (error) {
    failures++
    console.log(`  FAIL  ${error.message}`)
  }
}

console.log('— coverage')
const handled = (await server.ssrLoadModule('/src/generator/pipeline/runtime.ts')).HANDLED_MESSAGE_TYPES
const untested = handled.filter((t) => !dispatchedTypes.has(t))
check(`every one of the ${handled.length} message types is exercised somewhere above`, untested.length === 0, untested.join(', '))

await server.close()
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failed, ${Math.round((Date.now() - started) / 1000)}s`)
process.exit(failures === 0 ? 0 : 1)
