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

// The tectonics for AT LEAST n epochs, then the stop and its settled render.
// Since the coupled history (phase 5.1) every epoch erodes: this is how a
// harness world gets its eroded terrain. "At least", because an epoch the
// tick started just before the stop finishes and renders as the settled one
// — a test that needs an exact count uses runOneEpoch.
async function runEpochs(p, n) {
  const settledBefore = p.settledRenders()
  const renders = p.count('rendered')
  p.dispatch({ type: 'tectonicsStart' })
  await until(() => p.count('rendered') >= renders + n, { label: `${n} eroding epoch${n === 1 ? '' : 's'}`, timeout: 180000 })
  p.dispatch({ type: 'tectonicsStop' })
  await until(() => p.settledRenders() > settledBefore, { label: 'the settled render', timeout: 180000 })
  await quiet(p)
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
const poleRowsConstant = (field, resX, resY) => [0, resY - 1].every((j) => field.subarray(j * resX, (j + 1) * resX).every((v) => v === field[j * resX]))
const allFinite = (field) => field.every((v) => Number.isFinite(v))

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
  check('its mantle is one value along each pole row', poleRowsConstant(mantle, r.mantleResX, r.mantleResY))
  check('its land fraction and gauges are in range', r.landFraction >= 0 && r.landFraction <= 1 && status.stabilisedFraction >= 0 && status.stabilisedFraction <= 1 && Number.isFinite(status.crustFraction), `land ${r.landFraction.toFixed(3)}, stabilised ${status.stabilisedFraction.toFixed(3)}, ${status.cratonCount} cratons`)
  check('the plumes lie on the sphere', r.hotspots.every((h) => h.x >= 0 && h.x < W && h.y >= 0 && h.y <= H), `${r.hotspots.length} plumes`)

  const before = p.count('rendered')
  p.dispatch({ type: 'resetStage', stage: 'genesis' })
  await until(() => p.count('rendered') > before, { label: 'the sphere reset render' })
  await quiet(p)
  check('a reset makes the sphere again, not a torus', hash(p.last('rendered').mantle) === firstMantle)
})

test('a sphere Archean at full size, then its plates: finite, pole-handled, plausible against the torus', async () => {
  const L = (m) => server.ssrLoadModule(m)
  const [AS, AT, RF, MF, IM, OA] = await Promise.all([
    L('/src/generator/archean/archeanState.ts'), L('/src/generator/archean/archeanStep.ts'),
    L('/src/generator/crust/raftField.ts'), L('/src/generator/mantle/mantleField.ts'),
    L('/src/generator/render/elevationMapImage.ts'), L('/src/generator/tectonics/oceanAge.ts'),
  ])
  // The REAL slice renderer this time (elevationRenderWorker.ts), driven in
  // this process through a stand-in `self`: the sphere's warp and noise are
  // the part of the render the synthetic one above skips. The stand-in goes
  // again when this test ends.
  const shim = { postMessage: (m) => { shim.posted = m } }
  globalThis.self = shim
  try {
    await sphereAtFullSize(L, shim, { AS, AT, RF, MF, IM, OA })
  } finally {
    delete globalThis.self
  }
})

async function sphereAtFullSize(L, shim, { AS, AT, RF, MF, IM, OA }) {
  await L('/src/generator/render/elevationRenderWorker.ts')
  const slices = {
    async renderElevations(rw, rh, ww, wh, base, features, warpSeed, shape) {
      shim.onmessage({ data: { type: 'renderSlice', requestId: 0, startY: 0, endY: rh, renderWidth: rw, renderHeight: rh, worldWidth: ww, worldHeight: wh, blendedBaselineSlice: base.slice().buffer, features, warpSeed, shape } })
      return new Float32Array(shim.posted.elevations)
    },
  }
  const FW = 2048, FH = 1024, EPOCHS = 60
  const result = {}
  for (const shape of ['torus', 'sphere']) {
    const started = performance.now()
    const sim = AS.createArcheanSimulation('harness', FW, FH, 0, shape)
    for (let e = 0; e < EPOCHS; e++) AT.archeanStep(sim, AT.DEFAULT_ARCHEAN_PARAMS)
    const stepped = performance.now() - started
    const flow = MF.computeMantleFlow(sim.mantle, sim.domain)
    const age = RF.computeCratonOldnessField(sim.rafts, sim.epoch, MF.MANTLE_RES_X, MF.MANTLE_RES_Y, sim.domain)
    // The live preview's render, a quarter of the world per axis.
    const rendered = await IM.renderSimulationImage(
      { width: FW, height: FH, domain: sim.domain, seeds: [], rafts: sim.rafts, features: [], oceanAge: new Float32Array(OA.OCEAN_AGE_RES_X * OA.OCEAN_AGE_RES_Y), warpSeed: sim.warpSeed, seaLevelOffset: 0, mantle: sim.mantle },
      slices, { elevationScale: 4 },
    )
    result[shape] = {
      sim,
      finite: allFinite(sim.mantle) && allFinite(flow) && allFinite(age) && allFinite(rendered.rawElevations),
      poles: poleRowsConstant(sim.mantle, MF.MANTLE_RES_X, MF.MANTLE_RES_Y),
      land: rendered.landFraction,
      stabilised: RF.stabilisedFraction(sim.rafts, sim.epoch, AT.DEFAULT_ARCHEAN_PARAMS.stabilisationEpochs),
      cratons: sim.rafts.length,
      ms: stepped,
      renderMs: performance.now() - started - stepped,
    }
  }
  const say = (r) => `land ${r.land.toFixed(3)}, stabilised ${r.stabilised.toFixed(3)}, ${r.cratons} cratons, ${EPOCHS} epochs in ${(r.ms / 1000).toFixed(1)} s, render ${(r.renderMs / 1000).toFixed(1)} s`
  const { torus, sphere } = result
  check('the sphere\'s mantle, flow, craton age and elevation are finite', sphere.finite && torus.finite)
  check('the sphere\'s mantle is one value along each pole row (the torus has none)', sphere.poles && !torus.poles)
  // Plausible, not calibrated: crust has formed and some of it has
  // stabilised, and land stays a minority. The sphere's surface is W² / π
  // against the torus's W · H, 64 % of it, so the same crust covers more of
  // it — its land fraction runs higher for the same seed.
  check('the sphere makes land, and not too much', sphere.land > 0.01 && sphere.land < 0.6, say(sphere))
  check('its crust has begun to stabilise', sphere.stabilised > 0 && sphere.stabilised <= 1 && sphere.cratons > 0)
  check('the torus, same seed, for comparison', torus.land > 0.01 && torus.land < 0.6, say(torus))
  await spherePlatesAtFullSize(L, slices, IM, { torus: torus.sim, sphere: sphere.sim })
}

// THE PLATES ON THE SPHERE (DEC-0035, step 4d3): the hand-over from the
// Archean just run and the plate simulation alone (stepEpoch — what the
// coupled epoch calls for the plates, without the mesh, the erosion and
// the climate), sphere against torus for the same seed. The motion model's
// own arithmetic first (an Euler rotation forth and back, a velocity field
// that is rigid and tangent, a fit that finds a rigid flow's ω again),
// then the run: finite, pole-handled, a plate count that neither collapses
// nor runs away, speeds, land and boundaries of the torus's order. Then the
// elevation's feature query near a pole against every feature.
async function spherePlatesAtFullSize(L, slices, IM, archeans) {
  const [FA, PS, PM, TT, BD, EF, MF, FO] = await Promise.all([
    L('/src/generator/archean/finalizeArchean.ts'), L('/src/generator/tectonics/plateSimulation.ts'),
    L('/src/generator/tectonics/plateMotion.ts'), L('/src/generator/tectonics/tectonicsTuneParams.ts'),
    L('/src/generator/tectonics/boundaryDetection.ts'), L('/src/generator/elevation/elevationField.ts'),
    L('/src/generator/mantle/mantleField.ts'), L('/src/generator/tectonics/folds.ts'),
  ])
  const EPOCHS = 30
  const step = TT.TECTONICS_TUNING.epochAngleStep
  const result = {}
  for (const shape of ['torus', 'sphere']) {
    const started = performance.now()
    const sim = FA.finalizeArchean(archeans[shape])
    const { domain } = sim
    const speed = () => sim.seeds.reduce((sum, s, i) => { const v = PM.getVelocityAt(s, sim.motions[i], domain); return sum + Math.hypot(v.vx, v.vy) }, 0) / sim.seeds.length
    const counts = [sim.seeds.length]
    const speeds = [speed()]
    for (let e = 0; e < EPOCHS; e++) {
      PS.stepEpoch(sim)
      counts.push(sim.seeds.length)
      speeds.push(speed())
    }
    const stepped = performance.now() - started
    const rendered = await IM.renderSimulationImage(sim, slices, { elevationScale: 4 })
    const boundaries = BD.detectBoundaries(sim.lattice, sim.seeds, domain)
    const grid = domain.grid(sim.width, sim.height)
    let edge = 0
    let area = 0
    for (let y = 0; y < sim.height; y++) {
      const a = grid.cellArea(y)
      area += a * sim.width
      for (let x = 0; x < sim.width; x++) edge += rendered.boundaryMask[y * sim.width + x] * a
    }
    const motionsFinite = sim.motions.every((m) => Object.values(m).every(Number.isFinite))
    result[shape] = {
      sim,
      finite: allFinite(sim.oceanAge) && allFinite(rendered.rawElevations) && allFinite(sim.mantle) && motionsFinite
        && sim.seeds.every((s) => Number.isFinite(s.x + s.y)) && sim.features.every((f) => Number.isFinite(f.x + f.y + f.thickness + f.tangentX + f.tangentY))
        && sim.rafts.every((r) => r.blobs.every((b) => Number.isFinite(b.x + b.y))) && rendered.boundaryMask.some((v) => v === 1),
      onDomain: [...sim.seeds, ...sim.features, ...sim.hotspots, ...sim.rafts.flatMap((r) => r.blobs)].every((p) => p.x >= 0 && p.x < sim.width && p.y >= 0 && p.y <= sim.height),
      poles: poleRowsConstant(sim.oceanAge, 256, 128) && poleRowsConstant(sim.mantle, MF.MANTLE_RES_X, MF.MANTLE_RES_Y),
      counts,
      speeds,
      meanSpeed: speeds.reduce((a, b) => a + b, 0) / speeds.length,
      land: rendered.landFraction,
      boundary: boundaries.length / sim.lattice.length,
      edge: edge / area,
      features: sim.features.length,
      ms: stepped,
      renderMs: performance.now() - started - stepped,
    }
  }
  const { torus, sphere } = result
  const say = (r) => `plates ${r.counts.join(' ')}; speed ${r.speeds[0].toFixed(1)} → ${r.speeds.at(-1).toFixed(1)} (mean ${r.meanSpeed.toFixed(1)}); land ${r.land.toFixed(3)}; on a boundary ${(100 * r.boundary).toFixed(1)} % of the lattice, Voronoi edges ${(100 * r.edge).toFixed(2)} % of the surface; ${r.features} features; ${EPOCHS} epochs in ${(r.ms / 1000).toFixed(1)} s, render ${(r.renderMs / 1000).toFixed(1)} s`
  check('the sphere\'s seeds, motions, ocean age, rafts, features, boundaries and elevation are finite (the torus\'s too)', sphere.finite && torus.finite)
  check('every point the plates move stays on the sphere', sphere.onDomain && torus.onDomain)
  check('the sphere\'s ocean age and mantle are one value along each pole row', sphere.poles && !torus.poles)
  const plausibleCount = (r) => r.counts.every((n) => n >= Math.max(2, TT.TECTONICS_TUNING.minPlateCount) && n <= 3 * r.counts[0])
  check('the sphere\'s plate count neither collapses nor runs away', plausibleCount(sphere) && plausibleCount(torus))
  // Speeds: generated in the torus's range (LINEAR_SPEED_MIN_PX..MAX_PX at
  // the seed) and, fitted to the mantle flow from then on, of its order.
  check('the sphere\'s plates move at the torus\'s speeds', sphere.speeds[0] >= 30 && sphere.speeds[0] <= 90 && sphere.meanSpeed > 0.5 * torus.meanSpeed && sphere.meanSpeed < 2 * torus.meanSpeed)
  check('land and boundaries are plausible', [sphere, torus].every((r) => r.land > 0.02 && r.land < 0.6 && r.boundary > 0.03 && r.boundary < 0.6 && r.edge > 0.002 && r.edge < 0.1), say(sphere))
  check('the torus, same seed, for comparison', torus.finite, say(torus))

  // The motion model on the sphere itself, over the motions of the run.
  const sim = sphere.sim
  const { domain } = sim
  const R = domain.noise.radius
  const frame = { px: 0, py: 0, pz: 0, ex: 0, ey: 0, ez: 0, sx: 0, sy: 0, sz: 0 }
  let rand = 0x2545f491
  const random = () => ((rand = (Math.imul(rand, 1664525) + 1013904223) >>> 0) / 4294967296)
  const points = [{ x: 0, y: 0 }, { x: 700, y: sim.height }, { x: 123.4, y: 1e-7 }]
  for (let i = 0; i < 400; i++) points.push({ x: random() * sim.width, y: (Math.acos(1 - 2 * random()) * sim.height) / Math.PI })
  let roundTrip = 0
  let rigid = 0
  let rigidRef = 0
  let speedLaw = 0
  for (const motion of sim.motions) {
    for (const p of points) {
      const there = PM.advancePointByMotion(p.x, p.y, motion, step, domain)
      const back = PM.reversePointByMotion(there.x, there.y, motion, step, domain)
      roundTrip = Math.max(roundTrip, Math.sqrt(domain.distanceSq(back.x, back.y, p.x, p.y)) / R)
      const v = PM.getVelocityAt(p, motion, domain)
      speedLaw = Math.max(speedLaw, Math.abs(Math.hypot(v.vx, v.vy) - motion.rate * R * Math.sin(PM.arcToEulerPole(p.x, p.y, motion, domain))) / (motion.rate * R))
    }
    // Rigid and tangent: two points' velocities in 3D, (v_p − v_q) · (r_p − r_q)
    // = 0 and v · r = 0, against |v| |r|.
    const at = (p) => {
      const v = PM.getVelocityAt(p, motion, domain)
      domain.noise.frame(p.x, p.y, frame)
      return { r: [frame.px, frame.py, frame.pz], v: [0, 1, 2].map((k) => v.vx * [frame.ex, frame.ey, frame.ez][k] + v.vy * [frame.sx, frame.sy, frame.sz][k]) }
    }
    for (let i = 0; i + 1 < points.length; i += 2) {
      const a = at(points[i])
      const b = at(points[i + 1])
      const dot = (u, w) => u[0] * w[0] + u[1] * w[1] + u[2] * w[2]
      const sub = (u, w) => u.map((c, k) => c - w[k])
      rigid = Math.max(rigid, Math.abs(dot(sub(a.v, b.v), sub(a.r, b.r))), Math.abs(dot(a.v, a.r)))
      rigidRef = Math.max(rigidRef, motion.rate * R * R)
    }
  }
  check('a point turned by +ω and then −ω returns', roundTrip <= 1e-12, `${roundTrip.toExponential(1)} R over ${sim.motions.length} motions × ${points.length} points`)
  check('a plate\'s velocity is rigid and tangent, |v| = |ω| R sin θ', rigid <= 1e-12 * rigidRef && speedLaw <= 1e-12, `rigidity ${(rigid / rigidRef).toExponential(1)}, speed law ${speedLaw.toExponential(1)}`)
  // The fit finds a rigid flow's ω again: the flow of the run's own motions,
  // each laid under the cells nearest its seed.
  const flow = new Float32Array(MF.MANTLE_RES_X * MF.MANTLE_RES_Y * 2)
  for (let gy = 0; gy < MF.MANTLE_RES_Y; gy++) {
    for (let gx = 0; gx < MF.MANTLE_RES_X; gx++) {
      const x = ((gx + 0.5) / MF.MANTLE_RES_X) * sim.width
      const y = ((gy + 0.5) / MF.MANTLE_RES_Y) * sim.height
      let best = 0
      for (let p = 1; p < sim.seeds.length; p++) if (domain.distanceSq(x, y, sim.seeds[p].x, sim.seeds[p].y) < domain.distanceSq(x, y, sim.seeds[best].x, sim.seeds[best].y)) best = p
      const v = PM.getVelocityAt({ x, y }, sim.motions[best], domain)
      flow[(gy * MF.MANTLE_RES_X + gx) * 2] = v.vx
      flow[(gy * MF.MANTLE_RES_X + gx) * 2 + 1] = v.vy
    }
  }
  const fitted = PM.fitMotionsToFlow(sim.seeds, flow, domain)
  let fitError = 0
  for (let p = 0; p < fitted.length; p++) {
    const m = sim.motions[p]
    const f = fitted[p]
    fitError = Math.max(fitError, Math.hypot(f.poleX * f.rate - m.poleX * m.rate, f.poleY * f.rate - m.poleY * m.rate, f.poleZ * f.rate - m.poleZ * m.rate) / m.rate)
  }
  check('the fit to the mantle flow finds a rigid flow\'s ω again', fitError < 1e-3, `largest error ${fitError.toExponential(1)} of |ω|`)

  // The feature query (the elevation, the folds) near a pole: every feature
  // a point can reach is in the buckets it searches. Points on a ring of
  // colatitudes down to the pole, features laid round them.
  const reach = 65
  const ring = []
  for (const y of [0, 3, 20, 60, 120, 300, 512]) for (let k = 0; k < 24; k++) ring.push({ x: (k / 24) * sim.width + 0.37, y })
  const probe = ring.map((p, i) => ({ x: p.x, y: p.y, thickness: 1, tangentX: 1, tangentY: 0, kind: 'range', subsides: false, plateA: 0, plateB: 1, movesWithPlate: 0, epochsSinceDeposit: 0, id: i }))
  const scatter = []
  for (const p of ring) {
    for (let k = 0; k < 6; k++) {
      const out = { x: 0, y: 0 }
      const a = (k / 6) * 2 * Math.PI + 0.2
      domain.advance(p.x, p.y, 0.9 * reach * Math.cos(a), 0.9 * reach * Math.sin(a), out)
      scatter.push({ ...probe[0], x: out.x, y: out.y })
    }
  }
  const buckets = EF.buildFeatureBuckets([...probe, ...scatter], domain)
  let missed = 0
  let reachable = 0
  for (const p of ring) {
    const found = new Set()
    const n = EF.nearFeatureBuckets(buckets, p.x, p.y)
    const seen = new Set()
    for (let k = 0; k < n; k++) {
      if (seen.has(buckets.near[k])) missed += 1000
      seen.add(buckets.near[k])
      for (const f of buckets.buckets[buckets.near[k]]) found.add(f)
    }
    for (const f of [...probe, ...scatter]) {
      if (domain.distanceSq(p.x, p.y, f.x, f.y) > reach * reach) continue
      reachable++
      if (!found.has(f)) missed++
    }
  }
  check('the feature query near a pole finds every feature in reach, each bucket once', missed === 0 && reachable > ring.length, `${reachable} in reach, ${missed} missed`)
  const fold = FO.foldFactorAt(buckets, 0, 0, domain)
  check('a fold at the pole reads the features there', Number.isFinite(fold) && fold !== 1, `factor ${fold.toFixed(3)}`)
}

// THE HISTORY ON THE SPHERE (DEC-0035, step 4d5): the coupled epoch —
// plates, node motion, rebuild and remesh, the erosion engine, the column,
// the climate per epoch, the ice, the coast, the flexure — on a sphere
// world. Through the runtime first: the hand-over and the tectonics step's
// eroding epochs, then the save's mesh read back and checked on the globe.
test('a sphere world runs its history through the runtime', async () => {
  const p = await freshPipeline()
  p.dispatch({ ...ARCHEAN_INIT, shape: 'sphere' })
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
  // The seam: the step across x = 0 / W is a step like any other in its row.
  let seam = 0
  let inner = 0
  for (let y = 0; y < r.elevationResY; y++) {
    const row = elevation.subarray(y * r.elevationResX, (y + 1) * r.elevationResX)
    seam = Math.max(seam, Math.abs(row[0] - row[row.length - 1]))
    for (let x = 1; x < row.length; x++) inner = Math.max(inner, Math.abs(row[x] - row[x - 1]))
  }
  check('the rendered terrain has no seam at x = 0 / W', seam <= inner, `seam step ${seam.toFixed(3)}, largest inner step ${inner.toFixed(3)}`)
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

// The coupled epoch on the sphere, on the modules at this harness's size:
// the checks harness:mesh makes of the torus's history (a valid mesh every
// epoch, the column's ledger, supply-bounded deposits, a sane climate,
// determinism, a restore that continues the same bytes), made on the globe
// — the mesh by Euler's formula and its cells' sum, the rasters by their
// pole rows and their seam, the climate by its zonal means toward both
// poles — and a continent laid on the north pole. The pole handling's
// primitives each against the globe, each with a mutation the check must
// catch (the pole handling broken on purpose).
test('the coupled epoch on a sphere: a valid globe every epoch, conserved, pole-handled, plausible', async () => {
  const L = (m) => server.ssrLoadModule(m)
  const [D, AS, AT, FA, CE, MR, CF, WE, FX, MH, HY, RG, BI, CO, GW, MC, MAP, ES] = await Promise.all([
    L('/src/generator/core/domain.ts'), L('/src/generator/archean/archeanState.ts'), L('/src/generator/archean/archeanStep.ts'),
    L('/src/generator/archean/finalizeArchean.ts'), L('/src/generator/pipeline/coupledEpoch.ts'), L('/src/generator/mesh/meshRaster.ts'),
    L('/src/generator/climate/climateField.ts'), L('/src/generator/climate/weather.ts'), L('/src/generator/tectonics/flexure.ts'),
    L('/src/generator/mesh/meshHydrology.ts'), L('/src/generator/surface/hydrology.ts'), L('/src/generator/surface/riverGraph.ts'),
    L('/src/generator/climate/biomes.ts'), L('/src/generator/surface/cover.ts'), L('/src/generator/surface/hydrogeology.ts'),
    L('/src/generator/mesh/meshColumn.ts'), L('/src/generator/core/mapConfig.ts'), L('/src/generator/elevation/elevationScale.ts'),
  ])
  const RX = CF.CLIMATE_RES_X, RY = CF.CLIMATE_RES_Y
  const R = W / (2 * Math.PI)
  const sphereArea = 4 * Math.PI * R * R
  // Seed and Archean length chosen so the small sphere keeps a sea with
  // both poles under it (most at this size end nearly all land, the
  // disproportion a small world has — see the torus beside it).
  const world = (shape, seed = 'harness', archeanEpochs = 30) => {
    const archean = AS.createArcheanSimulation(seed, W, H, 0, shape)
    for (let e = 0; e < archeanEpochs; e++) AT.archeanStep(archean)
    return FA.finalizeArchean(archean)
  }
  const OPTIONS = { ...CE.HISTORY_DEFAULTS, climateEvery: 1, remeshEvery: 2 }
  const EPOCHS = 6
  // V − E + F from the halfedges themselves, and the cells' sum.
  const globeAudit = (mesh) => {
    let F = 0
    for (let t = 0; t < mesh.triSlots; t++) if (mesh.tAlive[t]) F++
    let area = 0
    for (let v = 0; v < mesh.vertexSlots; v++) if (mesh.vAlive[v]) area += mesh.voronoiArea(v)
    return { euler: mesh.aliveVertices - (3 * F) / 2 + F, area: area / sphereArea - 1, errors: mesh.validate() }
  }
  const run = async (sim, terrain, epochs) => {
    const r = { valid: true, worstEuler: 2, worstArea: 0, finite: true, ledger: 0, column: 0, bounded: true, climate: true, trace: [], ms: 0 }
    for (let e = 0; e < epochs; e++) {
      const t0 = performance.now()
      const st = await CE.stepCoupledEpoch(sim, terrain, OPTIONS)
      r.ms += performance.now() - t0
      const a = globeAudit(terrain.mesh)
      if (a.errors.length > 0) r.valid = false
      if (a.euler !== 2) r.worstEuler = a.euler
      r.worstArea = Math.max(r.worstArea, Math.abs(a.area))
      for (const f of [terrain.z, terrain.baseline, terrain.column.data, terrain.ice, terrain.sedimentFlux]) if (!allFinite(f)) r.finite = false
      r.ledger += st.depositedM3 + st.screeM3 - st.reErodedM3 + st.iceCoastColumnM3
      r.column = st.columnVolumeM3
      if (st.depositedM3 + st.exportedFluxM3 > st.erodedFluxM3 * 1.001 + 1) r.bounded = false
      if (!Number.isFinite(st.meanLandTempC) || st.meanLandTempC < -60 || st.meanLandTempC > 60 || st.iceVolumeKm3 < 0 || st.seaLevelM > 0) r.climate = false
      r.trace.push(`${st.nodesAfter}n ${st.meanLandTempC.toFixed(1)}°C ${(performance.now() - t0).toFixed(0)}ms`)
    }
    return r
  }

  // (1) The history on a sphere world, beside the torus of the same seed.
  const sim = world('sphere')
  const terrain = CE.createCoupledTerrain(sim, CE.HISTORY_DEFAULTS.budget)
  const s = await run(sim, terrain, EPOCHS)
  const simT = world('torus')
  const t = await run(simT, CE.createCoupledTerrain(simT, CE.HISTORY_DEFAULTS.budget), EPOCHS)
  check(`${EPOCHS} coupled epochs on the sphere keep a valid globe (V − E + F = 2, wound one way, Delaunay, cells sum to 4πR²)`, s.valid && s.worstEuler === 2 && s.worstArea < 1e-9, `cells off 4πR² by ${s.worstArea.toExponential(1)}`)
  check('every height, baseline, column value, ice thickness and flux stays finite', s.finite)
  console.log(`        sphere ${s.trace.join(' | ')}`)
  console.log(`        torus  ${t.trace.join(' | ')}`)
  check(`the column's ledger closes on the sphere (${(s.ledger / 1e9).toFixed(1)} vs ${(s.column / 1e9).toFixed(1)} km³; the torus ${(t.ledger / 1e9).toFixed(1)} vs ${(t.column / 1e9).toFixed(1)})`, s.column > 0 && Math.abs(s.ledger - s.column) <= 0.15 * Math.max(s.ledger, s.column))
  check('every epoch\'s deposits are bounded by its supply', s.bounded && t.bounded)
  check('every epoch has a sane climate (land temperature, ice ≥ 0, sea level ≤ 0)', s.climate)
  {
    // The temperature product may be negative (a layer laid down below
    // freezing); nothing else may — the craton product neither, since a
    // source with no crust enters as 0, not as the oldness field's −1.
    let negative = 0
    const d = terrain.column.data
    for (let v = 0; v < terrain.mesh.vertexSlots; v++) {
      if (!terrain.mesh.vAlive[v]) continue
      for (let k = 0; k < MC.COLUMN_DEPTH; k++) if (k % MC.COLUMN_VALUES !== 4 && d[v * MC.COLUMN_DEPTH + k] < 0) negative++
    }
    check('no thickness, craton, hardness or precipitation value of a layer goes negative', negative === 0, `${negative}`)
  }

  // (2) The rasters of the epoch's terrain: no seam, finite; the climate's.
  const seamOf = (field, rx, ry) => {
    let seam = 0, inner = 0
    for (let y = 0; y < ry; y++) {
      const row = field.subarray(y * rx, (y + 1) * rx)
      seam = Math.max(seam, Math.abs(row[0] - row[rx - 1]))
      for (let x = 1; x < rx; x++) inner = Math.max(inner, Math.abs(row[x] - row[x - 1]))
    }
    return { seam, inner }
  }
  const weather = terrain.weather.result
  const coarseZ = MR.rasteriseNodeField(terrain.mesh, terrain.preErosionZ, RX, RY)
  const fineZ = MR.rasteriseNodeField(terrain.mesh, terrain.z, W, H)
  const seams = { z: seamOf(fineZ, W, H), temperature: seamOf(weather.temperature, RX, RY), precipitation: seamOf(weather.seasonal.annual, RX, RY) }
  check('the rasterised terrain and the epoch\'s temperature and precipitation have no seam at x = 0 / W', Object.values(seams).every((q) => q.seam <= q.inner), Object.entries(seams).map(([k, q]) => `${k} ${q.seam.toFixed(2)} ≤ ${q.inner.toFixed(2)}`).join(', '))
  check('the epoch\'s climate is finite', [weather.temperature, weather.seasonal.annual, weather.currents, weather.seasonalAmplitude, weather.wind].every(allFinite))
  // Temperature by latitude, area-weighted: it falls from the equator toward
  // BOTH poles (the sphere's y is colatitude; the climate reads it so).
  const grid = sim.domain.grid(RX, RY)
  const band = (lo, hi, north) => {
    let sum = 0, area = 0
    for (let gy = 0; gy < RY; gy++) {
      const lat = 90 - ((gy + 0.5) / RY) * 180
      if ((north ? lat : -lat) < lo || (north ? lat : -lat) >= hi) continue
      for (let gx = 0; gx < RX; gx++) { sum += weather.temperature[gy * RX + gx] * grid.cellArea(gy); area += grid.cellArea(gy) }
    }
    return sum / area
  }
  const bands = [true, false].map((north) => [band(0, 20, north), band(40, 60, north), band(70, 90, north)])
  check('the temperature falls from the equator toward both poles', bands.every(([eq, mid, pole]) => eq > mid && mid > pole), bands.map((b, i) => `${i === 0 ? 'N' : 'S'} ${b.map((v) => v.toFixed(1)).join(' > ')} °C`).join('; '))
  const latitudeTrue = Array.from({ length: RY }, (_, gy) => Math.abs(CF.latitudeAt(gy) - sim.domain.latitude((gy + 0.5) / RY)) + Math.abs(CF.latitudeAt(gy) - Math.abs(90 - ((gy + 0.5) / RY) * 180) / 90)).every((d) => d < 1e-12)
  check('the climate\'s latitude per row is the sphere\'s own (the Domain\'s, and |φ| / 90° of the row centre)', latitudeTrue)

  // (3) The pole handling, each on its primitive, each with a mutation.
  // A grid that breaks one method on purpose (the domain otherwise the same).
  const broken = (domain, patch) => ({ ...domain, scaledTo: (w, h) => broken(domain.scaledTo(w, h), patch), grid: (rx, ry) => {
    const g = domain.grid(rx, ry)
    return new Proxy(g, { get: (target, key) => (key in patch ? (...args) => patch[key](target, ...args) : typeof target[key] === 'function' ? target[key].bind(target) : target[key]) })
  } })
  // (a) No star at a pole: the sea of each pole row is one value (the SST
  // after the currents carry it), and the pole rows of a field the stage
  // smooths (the flexure's deflection) too.
  const climateDomain = sim.domain.scaledTo(RX, RY)
  const starAt = (temperature, z) => {
    let spread = 0
    for (const row of [0, RY - 1]) {
      let lo = Infinity, hi = -Infinity
      for (let gx = 0; gx < RX; gx++) if (z[row * RX + gx] <= 0) { lo = Math.min(lo, temperature[row * RX + gx]); hi = Math.max(hi, temperature[row * RX + gx]) }
      if (hi >= lo) spread = Math.max(spread, hi - lo)
    }
    return spread
  }
  const params = WE.defaultWeatherParams()
  const sea = starAt(WE.computeWeather(coarseZ, climateDomain, params).temperature, coarseZ)
  const seaBroken = starAt(WE.computeWeather(coarseZ, broken(climateDomain, { averagePoleRows: () => {} }), params).temperature, coarseZ)
  check('the sea at each pole is one temperature (no star); without the pole averaging it is not', sea === 0 && seaBroken > 0, `spread ${sea} °C; mutated ${seaBroken.toFixed(3)} °C`)
  // (b) A departure along the globe: tapsAt reaches the point its offset's
  // length away, east-west near a pole too, and across it. Checked against
  // the Domain's own distance from the cell centre to the sampled point.
  const departure = (g) => {
    let worst = 0
    const taps = D.bilinearTaps(1)
    const cell = sim.domain.width / RX
    for (const gy of [0, 1, 3, 10, 64, 120, 127]) {
      for (const [dx, dy] of [[3, 0], [0, -2], [-2, 1.5], [0, 4]]) {
        g.tapsAt(17, gy, dx, dy, taps, 0)
        // Where the taps point: the cell centres they weigh, mean of the
        // two rows by ty, read back as a point (good to a cell's size).
        const at = (k) => { const c = taps.cells[k]; return { x: ((c % RX) + 0.5) * cell, y: (Math.floor(c / RX) + 0.5) * cell } }
        const p0 = at(0), p3 = at(3)
        const mid = { x: 0, y: 0 }
        const dd = { x: 0, y: 0 }
        sim.domain.delta(p3.x, p3.y, p0.x, p0.y, dd)
        sim.domain.advance(p0.x, p0.y, dd.x / 2, dd.y / 2, mid)
        const reached = Math.sqrt(sim.domain.distanceSq((17 + 0.5) * cell, (gy + 0.5) * cell, mid.x, mid.y)) / cell
        worst = Math.max(worst, Math.abs(reached - Math.hypot(dx, dy)))
      }
    }
    return worst
  }
  const sphereGrid = sim.domain.grid(RX, RY)
  const chartStep = { tapsAt: (g, gx, gy, dx, dy, out, at) => D.torusDomain(sim.domain.width, sim.domain.height).grid(RX, RY).tapsAt(gx, gy, dx, dy, out, at) }
  const dep = departure(sphereGrid)
  const depBroken = departure(broken(sim.domain, chartStep).grid(RX, RY))
  check('an advection departs along the globe, its offset\'s length away, near and across a pole; stepping the chart does not', dep < 1.5 && depBroken > 3, `worst ${dep.toFixed(2)} cells off (to the taps' cell size); chart-stepped ${depBroken.toFixed(1)}`)
  // (c) The flexure answers a load with its weight, wherever it lies: the
  // deflection's integral over the globe is the compensated load's, a load
  // at the equator, at 70° and at the pole alike (∫ G dA = 1); its pole
  // rows one value. Without the area weights a polar load's answer grows.
  const flexX = W / 4, flexY = H / 4
  const TT = await L('/src/generator/tectonics/tectonicsTuneParams.ts')
  const compensation = (TT.TECTONICS_TUNING.flexureCrustDensity / TT.TECTONICS_TUNING.flexureMantleDensity) * TT.TECTONICS_TUNING.flexureDeflectionScale
  const flexGrid = sim.domain.grid(flexX, flexY)
  const flexIntegral = (domain, row) => {
    const load = new Float32Array(flexX * flexY)
    const te = new Float32Array(flexX * flexY).fill(30)
    load[row * flexX + 5] = 1
    const w = FX.flexuralResponse(load, te, domain.grid(flexX, flexY), 31.2)
    let integral = 0
    for (let y = 0; y < flexY; y++) for (let x = 0; x < flexX; x++) integral += w[y * flexX + x] * flexGrid.cellArea(y)
    return { ratio: -integral / (compensation * flexGrid.cellArea(row)), w }
  }
  const ratios = [flexY >> 1, Math.round(flexY * 0.11), 0].map((row) => flexIntegral(sim.domain, row))
  const brokenRatio = flexIntegral(broken(sim.domain, { cellArea: () => 1 }), 0).ratio
  const poleFlat = poleRowsConstant(ratios[2].w, flexX, flexY)
  const spreadRatios = ratios.map((q) => q.ratio)
  check('a load\'s deflection integrates to its compensated weight at the equator, at 70° and at the pole; without the area weights not', spreadRatios.every((q) => Math.abs(q - 1) < 1e-4) && poleFlat && Math.abs(brokenRatio - 1) > 0.1, `∫w dA over the compensated load: ${spreadRatios.map((q) => q.toFixed(6)).join(', ')}; area weights off, a polar load: ${brokenRatio.toFixed(3)}`)
  // (d) The smoothing in a length: the climate's box blur spreads a point
  // as far east-west as north-south at 60° (in distance on the globe); in
  // cells it would be half as far.
  const PR = await L('/src/generator/climate/pressure.ts')
  const spreadOf = (g) => {
    const f = new Float32Array(RX * RY)
    const gy = Math.round(RY / 6 - 0.5)
    f[gy * RX + 100] = 1
    PR.blur(f, 3, g)
    let ew = 0, ns = 0, m = 0
    const s0 = sphereGrid.rowScale(gy)
    for (let y = 0; y < RY; y++) for (let x = 0; x < RX; x++) {
      const v = f[y * RX + x] * sphereGrid.cellArea(y)
      let dx = x - 100; if (dx > RX / 2) dx -= RX; if (dx < -RX / 2) dx += RX
      ew += v * (dx * s0) ** 2; ns += v * (y - gy) ** 2; m += v
    }
    return Math.sqrt(ew / m) / Math.sqrt(ns / m)
  }
  const iso = spreadOf(sphereGrid)
  const isoBroken = spreadOf(broken(sim.domain, { rowScale: () => 1 }).grid(RX, RY))
  check('the climate\'s blur spreads as far east-west as north-south at 60°; counting cells it does not', Math.abs(iso - 1) < 0.15 && isoBroken < 0.7, `east-west / north-south ${iso.toFixed(2)}; in cells ${isoBroken.toFixed(2)}`)

  // (4) Determinism and a restore on the sphere.
  const simB = world('sphere')
  const terrainB = CE.createCoupledTerrain(simB, CE.HISTORY_DEFAULTS.budget)
  for (let e = 0; e < EPOCHS; e++) await CE.stepCoupledEpoch(simB, terrainB, OPTIONS)
  const encA = CE.encodeCoupledTerrain(terrain), encB = CE.encodeCoupledTerrain(terrainB)
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])
  check('the same sphere history gives the same terrain and column bytes', same(encA.z, encB.z) && same(encA.nodes, encB.nodes) && same(encA.column, encB.column) && JSON.stringify(sim.climateHistory) === JSON.stringify(simB.climateHistory))
  const restored = CE.decodeCoupledTerrain(simB, encB)
  await CE.stepCoupledEpoch(sim, terrain, OPTIONS)
  await CE.stepCoupledEpoch(simB, restored, OPTIONS)
  const nextA = CE.encodeCoupledTerrain(terrain), nextB = CE.encodeCoupledTerrain(restored)
  check('a sphere terrain restored from its bytes continues identically', same(nextA.z, nextB.z) && same(nextA.column, nextB.column))

  // (5) The hydrogeology on the sphere's history terrain (as harness:mesh
  // runs it on the torus's): its invariants hold.
  {
    const sub = MH.meshSubstrate(terrain.mesh, terrain.routing, terrain.areas)
    const rz = MR.rasteriseNodeField(terrain.mesh, terrain.z, RX, RY)
    const wx = WE.computeWeather(rz, climateDomain, params)
    const precip = wx.seasonal.annual
    const discharge = HY.accumulateDischargeOn(sub, terrain.z, precip, RX, RY)
    const lakes = HY.computeLakesOn(sub, discharge, terrain.z, wx.temperature, precip, RX, RY)
    const threshold = HY.channelThreshold(HY.densityToCriticalArea(HY.CANONICAL_RIVER_DENSITY), HY.meanLandRunoff(precip, rz, climateDomain, RX, RY))
    const regime = HY.accumulateRegimeInputsOn(sub, terrain.z, wx.temperature, precip, wx.seasonal.index, RX, RY)
    const graph = RG.buildRiverGraph({ substrate: sub, discharge, elevation: terrain.z, threshold, maxDischarge: HY.maxDischargeOverLand(discharge, terrain.z), bodies: lakes.bodies, body: lakes.body, lakeDepth: lakes.depth, regime, criticalArea: HY.densityToCriticalArea(HY.CANONICAL_RIVER_DENSITY) })
    const biomes = BI.computeBiomes(wx.temperature, precip, wx.seasonalAmplitude, wx.seasonal.index, rz, RX, RY)
    const ground = GW.computeHydrogeology({ sub, elevation: terrain.z, graph, column: terrain.column, hardness: null, climateResX: RX, climateResY: RY, precipitation: precip, temperature: wx.temperature, monsoonIndex: wx.seasonal.index, cover: CO.coverField(biomes, true), regime, discharge, cellM: MAP.METERS_PER_CELL })
    const bad = Object.entries(GW.hydrogeologyInvariants(ground, graph, terrain.z)).filter(([, n]) => n > 0)
    check(`the hydrogeology holds its invariants on the sphere (${ground.springs.length} springs, ${graph.reaches.length} reaches)`, bad.length === 0 && graph.reaches.length > 0, bad.map(([k, n]) => `${k}:${n}`).join(' '))
  }

  // (6) Land at a pole: the largest raft turned on the globe so its first
  // blob sits on the north pole, then the history. The terrain starts with
  // land there, the epochs keep the globe valid and finite, and the pole's
  // land is cold.
  {
    const simP = world('sphere', 'polar-continent', 60)
    const frame = D.globeFrame()
    const raft = simP.rafts.reduce((best, r) => (r.blobs.length > best.blobs.length ? r : best))
    simP.domain.noise.frame(raft.blobs[0].x, raft.blobs[0].y, frame)
    const u = [frame.px / R, frame.py / R, frame.pz / R]
    // The rotation taking u to the north pole (0, 0, 1): about u × k by acos(u_z).
    const k = [u[1], -u[0], 0]
    const kl = Math.hypot(k[0], k[1]) || 1
    const axis = k.map((c) => c / kl)
    const angle = Math.acos(Math.max(-1, Math.min(1, u[2])))
    const turn = (p) => {
      const c = Math.cos(angle), sn = Math.sin(angle)
      const kv = axis[0] * p[0] + axis[1] * p[1] + axis[2] * p[2]
      const kx = [axis[1] * p[2] - axis[2] * p[1], axis[2] * p[0] - axis[0] * p[2], axis[0] * p[1] - axis[1] * p[0]]
      return [0, 1, 2].map((i) => p[i] * c + kx[i] * sn + axis[i] * kv * (1 - c))
    }
    const out = { x: 0, y: 0 }
    for (const b of raft.blobs) {
      simP.domain.noise.frame(b.x, b.y, frame)
      const q = turn([frame.px, frame.py, frame.pz])
      simP.domain.noise.locate(q[0], q[1], q[2], out)
      b.x = out.x
      b.y = out.y
    }
    const terrainP = CE.createCoupledTerrain(simP, CE.HISTORY_DEFAULTS.budget)
    const polarLand = (tr) => {
      let land = 0, cap = 0
      for (let v = 0; v < tr.mesh.vertexSlots; v++) {
        if (!tr.mesh.vAlive[v] || tr.mesh.vy[v] > H / 18) continue
        cap += tr.areas[v]
        if (tr.z[v] > 0) land += tr.areas[v]
      }
      return land / cap
    }
    const landStart = polarLand(terrainP)
    const rp = await run(simP, terrainP, 3)
    const wp = terrainP.weather.result
    const cz = MR.rasteriseNodeField(terrainP.mesh, terrainP.preErosionZ, RX, RY)
    let poleLandT = 0, poleLand = 0
    for (let gx = 0; gx < RX; gx++) if (cz[gx] > 0) { poleLandT += wp.temperature[gx]; poleLand++ }
    check('a continent on the north pole: land there from the start, the epochs valid and finite, the pole\'s land cold',
      landStart > 0.5 && rp.valid && rp.worstEuler === 2 && rp.finite && poleLand > 0 && poleLandT / poleLand < 0,
      `land over 80°N ${(100 * landStart).toFixed(0)} % → ${(100 * polarLand(terrainP)).toFixed(0)} %; ${poleLand} land cells in the pole row at ${(poleLandT / Math.max(1, poleLand)).toFixed(1)} °C`)
  }
  check(`an epoch on the sphere at this size costs ${(s.ms / EPOCHS).toFixed(0)} ms (the torus ${(t.ms / EPOCHS).toFixed(0)} ms)`, s.ms / EPOCHS < 20000)
})

// THE CLIMATE STEP ON THE SPHERE (DEC-0035, step 4e): what the step runs —
// the climate, its refinement, the rivers, lakes, coast, ice, basins and
// the ground water — through the runtime on a sphere world after its
// history, then four of its primitives on the modules with a mutation
// each. The torus's checks of the same stages (golden's invariants) are
// mirrored where the messages carry what they read.
// A sphere world through the runtime up to the climate step's end: its
// Archean, the hand-over, four eroding epochs, climateRun, the refinement
// and hydrologyRun — what the climate step's test and the ecology's stand on.
async function sphereThroughHydrology() {
  const p = await freshPipeline()
  p.dispatch({ ...ARCHEAN_INIT, shape: 'sphere' })
  await until(() => p.count('rendered') >= 1, { label: 'the first sphere render' })
  p.dispatch({ type: 'genesisStart' })
  await until(() => p.count('genesisStatus') >= ARCHEAN_EPOCHS, { label: `${ARCHEAN_EPOCHS} sphere epochs` })
  p.dispatch({ type: 'genesisStop' })
  await quiet(p)
  const handed = p.count('rendered')
  p.dispatch({ type: 'genesisFinalize' })
  await until(() => p.count('rendered') > handed, { label: 'the sphere hand-over render' })
  await quiet(p)
  await runEpochs(p, 4)
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
    ...Object.fromEntries(['lakeDepth', 'discharge', 'waterLevel', 'iceThickness', 'waterTable', 'precipitationEffective', 'riverPoints'].map((k) => [`hydrology.${k}`, f32(h[k])])),
  }
  const notFinite = Object.entries(fields).filter(([, f]) => f.length === 0 || !allFinite(f)).map(([k]) => k)
  check(`every field of the climate, the refinement and the hydrology is whole and finite (${Object.keys(fields).length} fields)`, notFinite.length === 0 && Number.isFinite(r.ensoPeriodYears) && Number.isFinite(h.maxDischarge), notFinite.join(', '))

  // The pole rows: a field the step smooths, solves or carries is one
  // value along a pole row, its land and its sea each (a row may hold both).
  const landC = new Uint8Array(n)
  const precipA = f32(cr.precipitation)
  for (let i = 0; i < n; i++) landC[i] = precipA[i] >= 0 ? 1 : 0
  const poleSpread = (field, layers = 1) => {
    let worst = 0
    for (let m = 0; m < layers; m++) {
      for (const row of [0, RY - 1]) {
        for (const kind of [0, 1]) {
          let lo = Infinity
          let hi = -Infinity
          for (let x = 0; x < RX; x++) {
            const i = row * RX + x
            if (landC[i] !== kind) continue
            const v = field[m * n + i]
            lo = Math.min(lo, v)
            hi = Math.max(hi, v)
          }
          if (hi > lo) worst = Math.max(worst, hi - lo)
        }
      }
    }
    return worst
  }
  // The months' temperature is the year's mean plus the cycle and the
  // overturning's warmth: the parts the refinement adds are what is one
  // value. (The mean carries each cell's own lapse over its ground.)
  const cycle = f32(r.temperature).map((v, k) => v - f32(cr.temperature)[k % n])
  const scalars = {
    pressure: [f32(r.pressure), r.months], cycle: [cycle, r.months], precipitation: [f32(r.precipitation), r.months],
    salinity: [f32(r.salinity), 1], deepWater: [f32(r.deepWater), 1], upwelling: [f32(r.upwelling), 1], currentAnomaly: [f32(r.currentAnomaly), 1],
    fog: [f32(r.fog), 1], foehn: [f32(r.foehn), 1], rainVariability: [f32(r.rainVariability), 1], ensoPattern: [f32(r.ensoPattern), 1],
    cyclone: [f32(r.cyclone), 1], tornado: [f32(r.tornado), 1], blizzard: [f32(r.blizzard), 1], dust: [f32(r.dust), 1], thunder: [f32(r.thunder), 1],
    'climate.seasonalAmplitude': [f32(c0.seasonalAmplitude), 1], 'refined.seasonalAmplitude': [f32(cr.seasonalAmplitude), 1], 'refined.monsoonIndex': [f32(cr.monsoonIndex), 1],
  }
  const spread = Object.entries(scalars).map(([k, [f, layers]]) => [k, poleSpread(f, layers)]).filter(([, s]) => s > 1e-3)
  check(`the refined fields are one value along each pole row, land and sea apart (${Object.keys(scalars).length} fields)`, spread.length === 0, spread.map(([k, s]) => `${k} ${s.toFixed(4)}`).join(', '))
  const tSpread = poleSpread(f32(cr.temperature))
  check('the temperature along a pole row differs only by its cells\' ground (under 1 °C)', tSpread < 1, `${tSpread.toFixed(3)} °C`)

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
  const cc = f32(cr.currents)
  const polarSea = band(cc, 75, 90, sea(cc))
  check(`the wind's bands: polar easterlies (u ${polar.u.toFixed(2)}), westerlies (${westerly.u.toFixed(2)}), trades toward the equator (u ${trades.u.toFixed(2)}, poleward ${trades.vPole.toFixed(2)}); the polar seas' currents flow round the pole, not into it (poleward ${polarSea.vPole.toFixed(3)} of ${polarSea.speed.toFixed(3)})`,
    polar.u < 0 && westerly.u > 0 && trades.u < 0 && trades.vPole < 0 && Math.abs(polarSea.vPole) < 0.2 * polarSea.speed)

  // The seam: the step across x = 0 / W is a step like any other in its row.
  const seamOf = (field, rx, ry, layers = 1) => {
    let seam = 0
    let inner = 0
    for (let m = 0; m < layers; m++) {
      for (let y = 0; y < ry; y++) {
        const row = field.subarray(m * rx * ry + y * rx, m * rx * ry + (y + 1) * rx)
        seam = Math.max(seam, Math.abs(row[0] - row[rx - 1]))
        for (let x = 1; x < rx; x++) inner = Math.max(inner, Math.abs(row[x] - row[x - 1]))
      }
    }
    return { seam, inner }
  }
  // The fields that vary smoothly; the derived ones (fog, föhn, the storms)
  // jump from cell to cell anywhere, and a seam check reads nothing there.
  const smooth = ['pressure', 'cycle', 'precipitation', 'salinity', 'currentAnomaly', 'climate.seasonalAmplitude', 'refined.seasonalAmplitude', 'refined.monsoonIndex']
  const seamed = Object.entries({ ...Object.fromEntries(smooth.map((k) => [k, scalars[k]])), temperature: [f32(r.temperature), r.months] })
    .map(([k, [f, layers]]) => [k, seamOf(f, RX, RY, layers)]).filter(([, s]) => s.seam > s.inner)
  check(`no smooth field of the climate step has a seam at x = 0 / W (${smooth.length + 1} fields)`, seamed.length === 0, seamed.map(([k, s]) => `${k} ${s.seam.toFixed(3)} > ${s.inner.toFixed(3)}`).join(', '))

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

  // The coast's invariants on the sphere's grid, the ice on land only.
  const CG = await server.ssrLoadModule('/src/generator/surface/coastGraph.ts')
  const coast = { width: W2, height: H2, reaches: h.coast.reaches, cells: new Int32Array(h.coast.cells), type: new Uint8Array(h.coastType) }
  const coastBroken = Object.entries(CG.coastGraphInvariants(coast, elevation, world.grid(W2, H2))).filter(([, c]) => c > 0)
  check(`the coast holds its invariants on the sphere's grid (${coast.reaches.length} reaches)`, coastBroken.length === 0 && coast.reaches.length > 0, coastBroken.map(([k, c]) => `${k}:${c}`).join(' '))
  const ice = f32(h.iceThickness)
  check('the ice lies on land only', ice.every((t, i) => t <= 0 || elevation[i] > 0))

  // The basins: finite, their areas the world's (a cell's area between the
  // pole row's and the equator's), the centroid on the globe.
  const basins = h.sedimentBasins ?? []
  const cellKm2 = (40000 / W2) ** 2
  const badBasins = basins.filter((b) => !(Number.isFinite(b.x) && Number.isFinite(b.y) && b.x >= 0 && b.x < W2 && b.y >= 0 && b.y <= H2 && Number.isFinite(b.cratonAge) && b.areaKm2 > 0 && b.areaKm2 <= b.cells * cellKm2 * 1.5))
  check(`the sediment basins are finite and on the globe (${basins.length} basins)`, badBasins.length === 0, JSON.stringify(badBasins[0] ?? ''))
})

// The picture's step: RIVER_CHART_STEP in surface/riverGraph.ts.
const RIVER_CHART_STEP_HARNESS = 2

test('the climate step\'s primitives on the sphere, each against its mutation', async () => {
  const L = (m) => server.ssrLoadModule(m)
  const [D, FR, SB, RG, ES, CT, EB, OC, CF, PF, RC, MAP] = await Promise.all([
    L('/src/generator/core/domain.ts'), L('/src/generator/surface/flowRouting.ts'), L('/src/generator/surface/sedimentBasins.ts'),
    L('/src/generator/surface/riverGraph.ts'), L('/src/generator/elevation/elevationScale.ts'), L('/src/generator/climate/climateTuneParams.ts'),
    L('/src/generator/climate/energyBalance.ts'), L('/src/generator/climate/oceanCurrents.ts'), L('/src/generator/climate/climateField.ts'),
    L('/src/generator/planet/planetForcing.ts'), L('/src/generator/surface/riverCourse.ts'), L('/src/generator/core/mapConfig.ts'),
  ])
  const sphere = D.sphereDomain(W, H)
  const torus = D.torusDomain(W, H)
  const R = W / (2 * Math.PI)
  const frame = D.globeFrame()
  // Unit vector of a chart point, and the arc between two (in cells).
  const unit = (x, y) => { sphere.noise.frame(x, y, frame); return [frame.px / R, frame.py / R, frame.pz / R] }
  const arc = (ax, ay, bx, by) => Math.sqrt(sphere.distanceSq(ax, ay, bx, by))

  // (1) The sediment basins' centroid on the globe: four discs of deposit —
  // a cap on the north pole, one holding the south pole off its centre, one
  // across the seam, one at mid-latitude. The centroid lies in its basin
  // and at the disc's centre; the torus's circular mean over the same
  // cells (the formula before step 4e) misses the polar ones by cells.
  {
    const discs = [[0, 0, 4.5], [50, H - 3, 6.5], [0.5, 64, 4.5], [180, 40, 3.5]]
    const before = new Float32Array(W * H).fill(0.05)
    const after = before.slice()
    const add = ES.metersToElevation(80)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        for (const [cx, cy, r] of discs) if (arc(x + 0.5, y + 0.5, cx, cy) <= r) after[y * W + x] += add
      }
    }
    const centroids = async (domain) => {
      const routing = await FR.fillDepressionsAndRouteFlow(after, domain, 0)
      return SB.findSedimentBasins({ before, after, width: W, height: H, routing, graph: null, cellM: 1000 })
    }
    const s = await centroids(sphere)
    const t = await centroids(torus)
    const missOf = (result) => discs.map(([cx, cy]) => {
      const b = result.basins.reduce((best, bb) => (arc(bb.x, bb.y, cx, cy) < arc(best.x, best.y, cx, cy) ? bb : best))
      return arc(b.x, b.y, cx, cy)
    })
    const inside = s.basins.every((b) => s.label[sphere.grid(W, H).cellAt(b.x, b.y)] === b.id + 1)
    const miss = missOf(s)
    const missTorus = missOf(t)
    check(`the basins' centroids lie in their basins, at the discs' centres on the globe (${s.basins.length} basins, off by ${miss.map((m) => m.toFixed(2)).join(', ')} cells)`,
      s.basins.length === discs.length && inside && miss.every((m) => m < 0.75))
    check(`mutation: the torus's circular mean on the same cells misses the polar basins (${missTorus.map((m) => m.toFixed(2)).join(', ')} cells)`, missTorus[0] > 1 && missTorus[1] > 1)
  }

  // (2) The river ribbons near and across a pole: a reach along a meridian
  // over the north pole, and one that steps east-west in the pole row. With
  // the domain the ribbons step at most a few texels in the chart and are
  // cut where they cross the pole; without it (the drawing before step 4e)
  // the pole-row step is one chart line across a sixth of the map.
  {
    const path = [[10, 6], [10, 4], [10, 2], [10, 0.6], [10 + W / 2, 0.7], [10 + W / 2, 2.5], [10 + W / 2, 4]]
    const ring = [[40, 0.8], [80, 0.8], [81, 2]]
    const cells = [...path, ...ring]
    const graph = {
      width: W, height: H, substrate: 'mesh', bodies: [],
      nodes: [{ id: 0, kind: 'source', cell: 0 }, { id: 1, kind: 'mouth', cell: path.length - 1 }, { id: 2, kind: 'source', cell: path.length }, { id: 3, kind: 'mouth', cell: cells.length - 1 }],
      reaches: [
        { id: 0, from: 0, to: 1, cellStart: 0, cellCount: path.length, dischargeIn: 1, dischargeOut: 2, regime: 'perennial' },
        { id: 1, from: 2, to: 3, cellStart: path.length, cellCount: ring.length, dischargeIn: 1, dischargeOut: 2, regime: 'perennial' },
      ],
      cells: Int32Array.from(cells.map((_, i) => i)),
      cellX: Float32Array.from(cells.map((c) => c[0])),
      cellY: Float32Array.from(cells.map((c) => c[1])),
    }
    const measure = (lines) => {
      let o = 0
      let longest = 0
      let across = 0
      for (const len of lines.lengths) {
        for (let k = 1; k < len; k++) {
          const dx = Math.abs(lines.points[(o + k) * 3] - lines.points[(o + k - 1) * 3])
          if (dx > W / 4) across++
          longest = Math.max(longest, Math.hypot(dx, lines.points[(o + k) * 3 + 1] - lines.points[(o + k - 1) * 3 + 1]))
        }
        o += len
      }
      return { longest, across, lines: lines.lengths.length }
    }
    const withDomain = measure(RG.riverPolylinesFromGraph(graph, 2, sphere))
    const without = measure(RG.riverPolylinesFromGraph(graph, 2))
    check(`a ribbon over a pole is cut there and every step is a few texels at most (${withDomain.lines} lines, the longest step ${withDomain.longest.toFixed(1)} texels)`, withDomain.across === 0 && withDomain.longest <= RIVER_CHART_STEP_HARNESS + 0.5 && withDomain.lines >= 3)
    check(`mutation: drawn without the domain, the pole row's step is one chart line of ${without.longest.toFixed(0)} texels`, without.longest > 30)
  }

  // (3) The single-flow receiver measures in lengths: at 70°N a plane that
  // falls as steeply east as south, in length (z falls by rowScale per cell
  // east-west), so the true fall line is 45° from east. The receivers'
  // mean step, in length, points that way; on the chart's square metric
  // (the torus grid over the same raster) they turn toward the south, to
  // atan(1 / cos φ).
  {
    const grid = sphere.grid(W, H)
    const y0 = Math.round(H * (20 / 180))
    const x0 = W / 2
    const raw = new Float32Array(W * H).fill(-0.2)
    for (let y = y0 - 10; y <= y0 + 10; y++) {
      for (let x = x0 - 40; x <= x0 + 40; x++) raw[y * W + x] = 0.5 + 0.004 * (-(x - x0) * grid.rowScale(y0) - (y - y0))
    }
    const angleOf = async (domain) => {
      const routing = await FR.fillDepressionsAndRouteFlow(raw, domain, 0)
      let east = 0
      let south = 0
      const s = grid.rowScale(y0)
      for (let y = y0 - 5; y <= y0 + 5; y++) {
        for (let x = x0 - 25; x <= x0 + 25; x++) {
          const t = routing.flowTarget[y * W + x]
          if (t < 0) continue
          east += ((t % W) - x) * s
          south += Math.floor(t / W) - y
        }
      }
      return (Math.atan2(south, east) * 180) / Math.PI
    }
    const onSphere = await angleOf(sphere)
    const onChart = await angleOf(torus)
    check(`the receivers follow the fall line in length at 70° (${onSphere.toFixed(1)}° from east, the plane's 45°)`, Math.abs(onSphere - 45) < 6)
    check(`mutation: on the chart's square cells they turn to ${onChart.toFixed(1)}°`, onChart > 60)
  }

  // (4) A river's course at 75°N: a meandering reach along the parallel.
  // Its bends are laid out in the plane about the reach on the globe, so
  // the course's own sinuosity is the true one — the line put back on the
  // globe is as long as it says. In the chart's plane (the torus's frame,
  // the course before step 4e) the parallel is four times too long, the
  // bends crowd four times as close on the globe, and the line on the globe
  // is far longer than its sinuosity says.
  {
    const y = H * (15 / 180)
    const path = []
    for (let x = 20; x <= 80; x++) path.push([x, y])
    const graph = {
      width: W, height: H, substrate: 'mesh', bodies: [],
      nodes: [{ id: 0, kind: 'source', cell: 0 }, { id: 1, kind: 'junction', cell: path.length - 1 }],
      reaches: [{ id: 0, kind: 'river', from: 0, to: 1, cellStart: 0, cellCount: path.length, dischargeIn: 1e7, dischargeOut: 2e7, slope: 1e-4, bank: -1, sedimentM3: 0, regime: 'perennial' }],
      cells: Int32Array.from(path.map((_, i) => i)), cellX: Float32Array.from(path.map((c) => c[0])), cellY: Float32Array.from(path.map((c) => c[1])),
    }
    let reachLength = 0
    for (let k = 1; k < path.length; k++) reachLength += arc(path[k - 1][0], y, path[k][0], y)
    const truthOf = (domain) => {
      const [c] = RC.computeRiverCourses(graph, { cellM: MAP.METERS_PER_CELL, seed: 7, domain })
      if (!c || c.pattern !== 'meandering') return { pattern: c?.pattern, ratio: NaN, finite: false }
      const line = c.lines[0]
      let length = 0
      for (let k = 1; k < line.length / 2; k++) length += arc(line[2 * k - 2], line[2 * k - 1], line[2 * k], line[2 * k + 1])
      return { pattern: c.pattern, ratio: length / (reachLength * c.sinuosity), sinuosity: c.sinuosity, finite: allFinite(line) }
    }
    const s = truthOf(sphere)
    const t = truthOf(torus)
    check(`a meandering course at 75°N is as long on the globe as its sinuosity says (${s.ratio.toFixed(3)}, sinuosity ${s.sinuosity?.toFixed(2)})`, s.finite && Math.abs(s.ratio - 1) < 0.03)
    check(`mutation: laid out in the chart's plane it is ${t.ratio.toFixed(2)} times as long`, !(Math.abs(t.ratio - 1) < 0.3))
  }

  // (5) The refinement's two solves on the sphere: the year's temperature
  // cycle and the overturning's inflow, at the tuned iteration counts
  // against four times as many, on a world with land in the polar rows
  // (where point Gauss-Seidel would leave a row near its start). The cycle
  // converges; the inflow's Poisson solve does not on either shape at its
  // tuned count (found 2026-10-10, left as it is), and on the sphere it
  // must come no further from its limit than the torus's does.
  {
    const RXc = CF.CLIMATE_RES_X
    const RYc = CF.CLIMATE_RES_Y
    const nc = RXc * RYc
    const g = sphere.grid(RXc, RYc)
    const landC = new Uint8Array(nc)
    const annual = new Float32Array(nc)
    const wind = new Float32Array(nc * 2)
    const sink = new Float32Array(nc)
    for (let y = 0; y < RYc; y++) {
      for (let x = 0; x < RXc; x++) {
        const i = y * RXc + x
        const u = unit((x + 0.5) * (W / RXc), (y + 0.5) * (H / RYc))
        landC[i] = u[0] * 0.8 + u[2] * 0.6 > 0.55 || Math.abs(u[1]) > 0.97 ? 1 : 0
        annual[i] = 28 - 50 * (Math.abs(u[2]) ** 1.5)
        wind[i * 2] = 0.6 * Math.cos(3 * Math.asin(u[2]))
        sink[i] = !landC[i] && u[2] > 0.85 ? 1 : 0
      }
    }
    const iters = { ebm: CT.CLIMATE_TUNING.ebmSolveIters, conveyor: CT.CLIMATE_TUNING.conveyorSolveIters }
    const cycleA = EB.seasonalCycle(landC, annual, wind, g, PF.DEFAULT_PLANET_FORCING, 0, 12)
    const inflowA = OC.computeSinkInflow(sink, landC, g)
    CT.CLIMATE_TUNING.ebmSolveIters = iters.ebm * 4
    CT.CLIMATE_TUNING.conveyorSolveIters = iters.conveyor * 4
    let cycleB, inflowB
    try {
      cycleB = EB.seasonalCycle(landC, annual, wind, g, PF.DEFAULT_PLANET_FORCING, 0, 12)
      inflowB = OC.computeSinkInflow(sink, landC, g)
    } finally {
      CT.CLIMATE_TUNING.ebmSolveIters = iters.ebm
      CT.CLIMATE_TUNING.conveyorSolveIters = iters.conveyor
    }
    let dCycle = 0
    let range = 0
    for (let k = 0; k < cycleA.length; k++) { dCycle = Math.max(dCycle, Math.abs(cycleA[k] - cycleB[k])); range = Math.max(range, Math.abs(cycleB[k])) }
    let dInflow = 0
    for (let k = 0; k < inflowA.length; k++) dInflow = Math.max(dInflow, Math.abs(inflowA[k] - inflowB[k]))
    const gt = torus.grid(RXc, RYc)
    const torusA = OC.computeSinkInflow(sink, landC, gt)
    CT.CLIMATE_TUNING.conveyorSolveIters = iters.conveyor * 4
    let torusB
    try {
      torusB = OC.computeSinkInflow(sink, landC, gt)
    } finally {
      CT.CLIMATE_TUNING.conveyorSolveIters = iters.conveyor
    }
    let dTorus = 0
    for (let k = 0; k < torusA.length; k++) dTorus = Math.max(dTorus, Math.abs(torusA[k] - torusB[k]))
    check(`the year's cycle converges on the sphere (within ${dCycle.toFixed(4)} °C of a ${range.toFixed(1)} °C swing), the inflow no worse than on the torus (${dInflow.toFixed(3)} against ${dTorus.toFixed(3)})`,
      allFinite(cycleA) && allFinite(inflowA) && dCycle < 0.01 * range && dInflow <= dTorus)
  }

  // (6) The season's wind cells at a pole: the banded wind of the month
  // whose belts are shifted most, on the sphere's climate grid. With the
  // sphere's shape the shift ends at the pole and the wind there is one
  // vector field on the globe; the MUTATION is the torus's shape (the
  // bands slide across the pole, as they do over the torus's seam), which
  // leaves a ring of 0.5 (4 m/s) in the cells' frames at the pole row.
  {
    const WD = await L('/src/generator/climate/wind.ts')
    const shift = CT.CLIMATE_TUNING.monsoonItczSeasonalShift
    const RXc = CF.CLIMATE_RES_X
    const RYc = CF.CLIMATE_RES_Y
    const jump = (shape) => Math.max(...[shift, -shift].map((b) => poleVectorJump(WD.computeWind(0, PF.DEFAULT_PLANET_FORCING.rotationHours, b, shape), RXc, RYc)))
    const kept = jump('sphere')
    const slid = jump('torus')
    check(`the season's wind cells end at the pole on the sphere: the step across a pole ${kept.toFixed(2)} × the step to the next row (the bands slid across it: ${slid.toFixed(2)})`, kept < 2 && slid > 2)
  }
})

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

  // The pole rows: one value along each, the land's (and the fish's sea)
  // apart — on the climate grid and on the fine raster, the months too.
  const fineSea = fine.carryingCapacity.map((c) => (c === EF.ECOLOGY_FINE_OCEAN ? 1 : 0))
  const spreadOf = (field, rx, ry, isSea, value = (v) => v) => {
    let worst = 0
    for (const row of [0, ry - 1]) {
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
  const coarseSea = (i) => (coarse.carryingCapacity[i] === EF.ECOLOGY_OCEAN ? 1 : 0)
  const poles = ids.flatMap((id) => [[`coarse.${id}`, spreadOf(coarse[id], RX, RY, coarseSea)], [`fine.${id}`, spreadOf(fine[id], FX, FY, (i) => fineSea[i])]])
  const months = p.messages.filter((m) => m.type === 'ecologyMonthData')
  for (const m of months) poles.push([`month ${m.field} ${m.month}`, m.data.byteLength === FX * FY ? spreadOf(new Uint8Array(m.data), FX, FY, (i) => fineSea[i]) : Infinity])
  const spread = poles.filter(([, v]) => v > 1e-6)
  let polarLand = 0
  for (const row of [0, FY - 1]) for (let x = 0; x < FX; x++) if (!fineSea[row * FX + x]) polarLand++
  check(`the ecology's fields are one value along each pole row, land and sea apart (${poles.length} fields, ${polarLand} pole-row land pixels)`, spread.length === 0 && months.length === 2 && months.every((m) => m.data.byteLength === FX * FY), spread.map(([k, v]) => `${k} ${v}`).join(', '))

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
  const seams = ['carryingCapacity', 'arable', 'game', 'pasture', 'fish', 'iron'].map((id) => [id, seamOf(fine[id])])
  const seamed = seams.filter(([, s]) => s.seam > 2 * s.inner + 1)
  check(`no ecology field has a seam at x = 0 / W (${seams.map(([id, s]) => `${id} ${s.seam.toFixed(1)}/${s.inner.toFixed(1)}`).join(', ')} codes, ${seams[0][1].seamN} seam pairs)`, seamed.length === 0)

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
  check(`plausible by latitude (bands 0–30–55–70–90°): carrying capacity ${fmt(cc)}, game ${fmt(game)}, arable ${fmt(arable)} — the polar band the lowest; every field in range, the sea's fish ${fishMean.toFixed(3)}`,
    known(cc[0]) && low && inRange && fishSea.length > 0 && fishMean > 0 && fishMean < 1)
})

test('the ecology on the sphere at high latitude: a deposit\'s halo is a disc in true lengths, against its mutation', async () => {
  const L = (m) => server.ssrLoadModule(m)
  const [D, EF, ET, B, CF] = await Promise.all([
    L('/src/generator/core/domain.ts'), L('/src/generator/ecology/ecologyField.ts'), L('/src/generator/ecology/ecologyTuneParams.ts'),
    L('/src/generator/climate/biomes.ts'), L('/src/generator/climate/climateField.ts'),
  ])
  // A world of land at a real deposit size: 1024 × 512, σ = 0.02 · 512
  // = 10.2 pixels. Arc volcanoes along 75°N and 75°S, 128 pixels apart in
  // the chart (33 on the globe: their halos stay apart), and a row along
  // the equator for the reference; many, since the copper lottery keeps a
  // third.
  const FW = 1024
  const FH = 512
  const RXc = CF.CLIMATE_RES_X
  const RYc = CF.CLIMATE_RES_Y
  const nc = RXc * RYc
  const yAt = (lat) => ((90 - lat) / 180) * FH
  const volcanoes = []
  for (let k = 0; k < 8; k++) volcanoes.push({ x: 20.3 + k * (FW / 8), y: yAt(75) + 0.37, thickness: 1, kind: 'arc' })
  for (let k = 0; k < 8; k++) volcanoes.push({ x: 84.6 + k * (FW / 8), y: yAt(-75) + 0.29, thickness: 1, kind: 'arc' })
  for (let k = 0; k < 24; k++) volcanoes.push({ x: 31.7 + k * (FW / 24), y: yAt(0) + 0.21, thickness: 1, kind: 'arc' })
  const inputsOn = (domain) => ({
    temperature: new Float32Array(nc).fill(12), precipitation: new Float32Array(nc).fill(800), biomes: new Uint8Array(nc).fill(B.Biome.Grassland),
    biomesFine: null, upwelling: null, months: null, rainVariability: null, elevation: new Float32Array(FW * FH).fill(0.05),
    discharge: null, maxDischarge: 0, lakeDepth: null, saltFlat: null, dryBasin: null, waterTable: null, oases: [], volcanoes, orogenPoints: [],
    cratonAge: new Float32Array(nc).fill(0.5), warpSeed: 12345, domain,
  })
  const sphere = D.sphereDomain(FW, FH)
  const params = { carryingCapacity: 100, concentration: 0, provinceStrength: 0.5 }
  const s = EF.computeEcology(inputsOn(sphere), params)
  const t = EF.computeEcology(inputsOn(D.torusDomain(FW, FH)), params)
  const notFinite = EF.ECOLOGY_FIELD_IDS.filter((id) => !allFinite(s.fine.fields[id]) || !allFinite(s.fields[id]))
  check('every fine and coarse field is finite on a sphere of land', notFinite.length === 0, notFinite.join(', '))
  // Each kept volcano's half-maximum: walked east and south from its pixel,
  // the true distance (on the globe) where the copper falls below 0.5.
  const sigma = Math.min(FW, FH) * ET.ECOLOGY_TUNING.copperRadiusFrac
  const expected = sigma * Math.sqrt(2 * Math.log(2))
  const halfWidths = (field, v) => {
    const cx = Math.floor(v.x)
    const cy = Math.floor(v.y)
    if (field[cy * FW + cx] < 0.9) return null
    const walk = (dx, dy) => {
      for (let k = 1; k < FW / 2; k++) {
        const x = (cx + dx * k + FW) % FW
        const y = cy + dy * k
        if (field[y * FW + x] < 0.5) return Math.sqrt(sphere.distanceSq(x + 0.5, y + 0.5, v.x, v.y))
      }
      return Infinity
    }
    return { east: (walk(1, 0) + walk(-1, 0)) / 2, south: (walk(0, 1) + walk(0, -1)) / 2 }
  }
  const measure = (field, lat) => volcanoes.filter((v) => Math.abs(v.y - yAt(lat)) < 1).map((v) => halfWidths(field, v)).filter((m) => m !== null)
  const high = [...measure(s.fine.fields.copper, 75), ...measure(s.fine.fields.copper, -75)]
  const equator = measure(s.fine.fields.copper, 0)
  const highTorus = [...measure(t.fine.fields.copper, 75), ...measure(t.fine.fields.copper, -75)]
  const ratio = (ms) => ms.reduce((a, m) => a + m.east / m.south, 0) / ms.length
  const mean = (ms, k) => ms.reduce((a, m) => a + m[k], 0) / ms.length
  check(`a copper halo at 75° is a disc in true lengths: east-west / north-south ${ratio(high).toFixed(2)}, half-maximum ${mean(high, 'east').toFixed(1)} / ${mean(high, 'south').toFixed(1)} px against σ√(2 ln 2) = ${expected.toFixed(1)} (${high.length} halos; at the equator ${ratio(equator).toFixed(2)})`,
    high.length > 0 && equator.length > 0 && Math.abs(ratio(high) - 1) < 0.12 && Math.abs(mean(high, 'south') / expected - 1) < 0.15 && Math.abs(ratio(equator) - 1) < 0.12)
  check(`mutation: drawn in the chart (the torus over the same pixels), the halo at 75° is ${ratio(highTorus).toFixed(2)} as wide east-west as north-south in true lengths (cos 75° = ${Math.cos((75 * Math.PI) / 180).toFixed(2)})`,
    highTorus.length > 0 && ratio(highTorus) < 0.5)
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

// The sphere's coordinate noise (DEC-0035, fork 1): the warp, the ridged and
// fine noise and the hypsometry are sampled at the point's place on the
// globe (Domain.noise), not at its chart coordinates. Checked on the noise
// functions themselves at the world's real size: one value at each pole,
// no seam at the longitude wrap, the same roughness east-west as
// north-south at 60° (the chart's lattice is stretched 1 / cos φ = 2× there),
// and the torus noise's spread over the torus.
test('the sphere samples its noise on the globe: poles, seam, isotropy, spread', async () => {
  const L = (m) => server.ssrLoadModule(m)
  const [D, RN, HY, EF] = await Promise.all([
    L('/src/generator/core/domain.ts'), L('/src/generator/elevation/ridgedNoise.ts'),
    L('/src/generator/elevation/hypsometry.ts'), L('/src/generator/elevation/elevationField.ts'),
  ])
  const FW = 2048, FH = 1024
  const sphere = D.sphereDomain(FW, FH)
  const torus = D.torusDomain(FW, FH)
  const frame = D.globeFrame()
  const SEED = 0x2545f491
  // The scalar noises, by name, and the warp as the warped point's place on
  // the globe (a chart point at a pole names one place under every x).
  const noises = {
    ridged: (d, x, y) => RN.ridgedMultifractalOn(d, x, y, SEED),
    fine: (d, x, y) => RN.fineDetailNoiseOn(d, x, y, SEED),
    hypsometry: (d, x, y) => HY.continentalHypsometry(x, y, 1, d, SEED),
  }
  const warpedAt = (x, y) => {
    const { wx, wy } = EF.warpedSamplePoint(x, y, sphere, SEED)
    sphere.noise.frame(wx, wy, frame)
    return [frame.px, frame.py, frame.pz]
  }
  const gap3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
  const xs = Array.from({ length: 97 }, (_, i) => (i * FW) / 97 + 0.37)

  // (1) One value at each pole, for every x.
  const poleSpread = {}
  for (const [name, f] of Object.entries(noises)) {
    let worst = 0
    for (const y of [0, FH]) {
      const ref = f(sphere, 0, y)
      for (const x of xs) worst = Math.max(worst, Math.abs(f(sphere, x, y) - ref) / Math.max(Math.abs(ref), 1e-3))
    }
    poleSpread[name] = worst
  }
  let warpPole = 0
  for (const y of [0, FH]) {
    const ref = warpedAt(0, y)
    for (const x of xs) warpPole = Math.max(warpPole, gap3(warpedAt(x, y), ref) / sphere.noise.radius)
  }
  // The chart's lattice, for contrast: a different value at every x.
  const chartPole = Math.max(...xs.map((x) => Math.abs(RN.ridgedMultifractal(x, 0, FW, FH, SEED) - RN.ridgedMultifractal(0, 0, FW, FH, SEED))))
  const fmt = (o) => Object.entries(o).map(([k, v]) => `${k} ${v.toExponential(1)}`).join(', ')
  check('the sphere\'s noise is one value at each pole', Object.values(poleSpread).every((v) => v <= 1e-12) && warpPole <= 1e-12,
    `worst relative spread ${fmt(poleSpread)}, warped point ${warpPole.toExponential(1)} (the chart lattice's ridged noise: ${chartPole.toFixed(3)})`)

  // (2) No seam: x just below W and x = 0 agree for the same y.
  const seam = {}
  const ys = Array.from({ length: 64 }, (_, j) => ((j + 0.5) * FH) / 64)
  for (const [name, f] of Object.entries(noises)) {
    let worst = 0
    for (const y of ys) worst = Math.max(worst, Math.abs(f(sphere, FW - 1e-9, y) - f(sphere, 0, y)) / Math.max(Math.abs(f(sphere, 0, y)), 1e-3))
    seam[name] = worst
  }
  let warpSeam = 0
  for (const y of ys) warpSeam = Math.max(warpSeam, gap3(warpedAt(FW - 1e-9, y), warpedAt(0, y)))
  check('no seam at the longitude wrap', Object.values(seam).every((v) => v <= 1e-6) && warpSeam <= 1e-6, `worst relative step ${fmt(seam)}, warped point ${warpSeam.toExponential(1)} units`)

  // (3) Isotropy at 60° latitude: the mean |difference| over one domain unit
  // along the globe east-west against north-south, both hemispheres.
  const step = { x: 0, y: 0 }
  const roughness = (f, d, x, y, dx, dy) => {
    sphere.advance(x, y, dx, dy, step)
    const a = f(d, step.x, step.y)
    sphere.advance(x, y, -dx, -dy, step)
    return Math.abs(a - f(d, step.x, step.y))
  }
  // Many seeds: the hypsometry's lattice has three cells round that circle,
  // and its ratio converges slowly (16 seeds 1.13, 64 1.06, 256 1.02).
  const seeded = {
    ridged: (k) => (d, x, y) => RN.ridgedMultifractalOn(d, x, y, k),
    fine: (k) => (d, x, y) => RN.fineDetailNoiseOn(d, x, y, k),
    hypsometry: (k) => (d, x, y) => HY.continentalHypsometry(x, y, 1, d, k),
  }
  const iso = {}
  let chartRatio = 0
  for (const [name, at] of Object.entries(seeded)) {
    let ew = 0, ns = 0, cew = 0, cns = 0
    const seeds = name === 'hypsometry' ? 256 : 16
    for (let k = 0; k < seeds; k++) {
      const f = at((k * 2654435761 + 5) >>> 0)
      for (let i = 0; i < 16000 / seeds; i++) {
        const x = ((i * 0.618034) % 1) * FW
        const y = (i % 2 ? 1 / 6 : 5 / 6) * FH + ((i * 0.414214) % 1 - 0.5) * 4
        ew += roughness(f, sphere, x, y, 0.5, 0)
        ns += roughness(f, sphere, x, y, 0, 0.5)
        // The same steps on the chart's lattice (the torus's noise at the chart point).
        if (name === 'ridged') { cew += roughness(f, torus, x, y, 0.5, 0); cns += roughness(f, torus, x, y, 0, 0.5) }
      }
    }
    iso[name] = ew / ns
    if (name === 'ridged') chartRatio = cew / cns
  }
  check('the noise is as rough east-west as north-south at 60°', Object.values(iso).every((r) => Math.abs(r - 1) <= 0.1),
    `east-west / north-south ${Object.entries(iso).map(([k, v]) => `${k} ${v.toFixed(3)}`).join(', ')} (the chart lattice's ridged: ${chartRatio.toFixed(2)})`)

  // (4) The spread: mean and standard deviation over the sphere (area-
  // uniform points) against the torus noise over the torus, many seeds;
  // the warp as the distance it moves a point. The hypsometry's coarsest
  // octave has about ten cells over the whole sphere (fifteen on the
  // torus), so its spread per seed varies much and needs the seeds; over
  // 256 seeds its sphere std is 8 % under the torus's (2026-10-10), the
  // few cells' share of a field this coarse, not a gain.
  let rng = 1
  const rand = () => { rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0; return rng / 4294967296 }
  const onTorus = () => [rand() * FW, rand() * FH]
  const onSphere = () => [rand() * FW, (Math.acos(1 - 2 * rand()) * FH) / Math.PI]
  const moment = (f, at) => {
    let m = 0, m2 = 0, n = 0
    for (let k = 0; k < 128; k++) {
      const seed = (k * 2654435761 + 11) >>> 0
      for (let i = 0; i < 1500; i++) { const [x, y] = at(); const v = f(x, y, seed); m += v; m2 += v * v; n++ }
    }
    return { mean: m / n, std: Math.sqrt(m2 / n - (m / n) ** 2) }
  }
  const spreadOf = {
    ridged: [(x, y, k) => RN.ridgedMultifractalOn(torus, x, y, k), (x, y, k) => RN.ridgedMultifractalOn(sphere, x, y, k)],
    fine: [(x, y, k) => RN.fineDetailNoiseOn(torus, x, y, k), (x, y, k) => RN.fineDetailNoiseOn(sphere, x, y, k)],
    hypsometry: [(x, y, k) => HY.continentalHypsometry(x, y, 1, torus, k), (x, y, k) => HY.continentalHypsometry(x, y, 1, sphere, k)],
    warp: [
      (x, y, k) => { const w = EF.warpedSamplePoint(x, y, torus, k); return Math.sqrt(torus.distanceSq(x, y, w.wx, w.wy)) },
      (x, y, k) => { const w = EF.warpedSamplePoint(x, y, sphere, k); return Math.sqrt(sphere.distanceSq(x, y, w.wx, w.wy)) },
    ],
  }
  const spread = {}
  for (const [name, [ft, fs]] of Object.entries(spreadOf)) {
    const t = moment(ft, onTorus)
    const sp = moment(fs, onSphere)
    spread[name] = { t, s: sp, ok: Math.abs(sp.mean - t.mean) <= 0.15 * Math.max(Math.abs(t.mean), t.std) && Math.abs(sp.std / t.std - 1) <= 0.15 }
  }
  check('the sphere\'s noise has the torus noise\'s spread', Object.values(spread).every((r) => r.ok),
    Object.entries(spread).map(([k, r]) => `${k} mean ${r.s.mean.toPrecision(3)} / ${r.t.mean.toPrecision(3)}, std ${r.s.std.toPrecision(3)} / ${r.t.std.toPrecision(3)}`).join('; '))
})

// ------------------------------------------------------- hand-over and resets

test('the hand-over is what resetTectonics goes back to', async () => {
  const p = await freshPipeline()
  await growWorld(p)
  const handover = hash(p.last('rendered').elevation)

  let base = p.count('rendered')
  p.dispatch({ type: 'tectonicsStart' })
  // Four pictures are ten epochs since the loop draws every third one
  // (HISTORY_DEFAULTS.renderEvery, 2026-09-26) — a few seconds each on this
  // world, where the uplift field's cost does not shrink with the size.
  await until(() => p.count('rendered') >= base + 4, { label: 'a few tectonic epochs', timeout: 180000 })
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
  await until(() => p.count('rendered') >= base + 4, { label: 'more epochs', timeout: 180000 })
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
  await until(() => p.count('rendered') >= base + 4, { label: 'some tectonics', timeout: 180000 })
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
})

// -------------------------------------------------------------------- stopping

// A stop that lands BETWEEN two epochs — as the screen's does: the message
// waits in the worker's queue while an epoch runs. No epoch may START after
// it: one settled render follows, of the epoch that was running or the
// terrain as it stands — at most renderEvery epochs past the last picture,
// since the pictures come every renderEvery-th epoch and the epochs between
// are never shown. The seamless tick (2026-09-26) once ran epochs past the
// stop here (renders 1i 2s 3s …), and the hydrology then drew the rivers
// of N+1 over the land of N.
test('a stop between two epochs runs no epoch after it', async () => {
  const p = await freshPipeline()
  await growWorld(p)
  const settledBefore = p.settledRenders()
  const renders = p.count('rendered')
  p.dispatch({ type: 'tectonicsStart' })
  await until(() => p.count('rendered') > renders, { label: 'the first epoch picture', timeout: 180000 })
  const shown = p.last('rendered').epoch
  // Queued as the screen's message would be: a macrotask that lands before
  // the tick the epoch's end may have scheduled with a zero delay.
  await new Promise((r) => setTimeout(() => { p.dispatch({ type: 'tectonicsStop' }); r() }, 0))
  await until(() => p.settledRenders() > settledBefore, { label: 'the settled render', timeout: 180000 })
  await quiet(p)
  const settled = p.messages.filter((m) => m.type === 'rendered' && !m.intermediate).at(-1)
  const sequence = p.messages.filter((m) => m.type === 'rendered').slice(renders).map((m) => `${m.epoch}${m.intermediate ? 'i' : 's'}`).join(' ')
  const renderEvery = (await server.ssrLoadModule('/src/generator/pipeline/coupledEpoch.ts')).HISTORY_DEFAULTS.renderEvery
  check('no epoch starts after the stop', settled.epoch >= shown && settled.epoch <= shown + renderEvery, `shown epoch ${shown}, settled epoch ${settled.epoch}; renders: ${sequence}`)
  check('exactly one settled render follows the stop', p.settledRenders() === settledBefore + 1, `+${p.settledRenders() - settledBefore}`)
})

// --------------------------------------------------------- level 1's replay

test("level 1's replay makes the saved world again, across a load and a checkpoint", async () => {
  // world/replay.ts runs a world's history as direct calls — what the job
  // worker does for level 1 (docs/decisions/detail-ladder.md, fork 2). At
  // the history's budget it must land on the bytes the runtime saved, or
  // the worker's own check refuses every world. The world here is made the
  // way the screen makes one, with a load in the middle (the `restored`
  // run), and the replay is resumed once from a checkpoint.
  const RP = await server.ssrLoadModule('/src/world/runParams.ts')
  const WS = await server.ssrLoadModule('/src/world/save/worldSpec.ts')
  const WH = await server.ssrLoadModule('/src/world/save/worldHistory.ts')
  const RE = await server.ssrLoadModule('/src/world/replay.ts')
  const CE = await server.ssrLoadModule('/src/generator/pipeline/coupledEpoch.ts')
  const values = Object.fromEntries(WS.WORLD_SPEC_FIELDS.map((f) => [f.path, f.input.default]))
  const genesis = { mantleDiffusion: RP.mantleDiffusionFromVigour(values['genesis.mantleVigour']), seaLevelOffset: RP.seaLevelOffsetFromWater(values['genesis.water']) }
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
  q.dispatch({ ...asRestore(saved, 'replay'), mesh: structuredClone(saved.mesh) })
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
  let checkpoint = null
  const replayed = await RE.replayHistory(recipe, {
    budget: CE.HISTORY_DEFAULTS.budget,
    onCheckpoint: (position, take) => { if (!checkpoint && position.epoch > 0) checkpoint = { position, snapshot: structuredClone(take()) } },
  })
  check('the replay lands on the saved mesh bit for bit', parts(CE.encodeCoupledTerrain(replayed.terrain)) === savedParts, `${before} + ${after - before} epochs`)
  check('the replay offered a checkpoint inside a run', checkpoint !== null)
  if (checkpoint) {
    const resumed = await RE.replayHistory(recipe, { budget: CE.HISTORY_DEFAULTS.budget, resume: checkpoint })
    check('a replay resumed from its checkpoint lands on the same bytes', parts(CE.encodeCoupledTerrain(resumed.terrain)) === savedParts, JSON.stringify(checkpoint.position))
  }
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
