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
