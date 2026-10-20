// Loads both builds from engine/dist/ and checks that they answer the same
// as each other and as the TypeScript engine: the version, and an Archean
// grown through the engine's surface (docs/decisions/rust-engine.md,
// fork 6) on both shapes — its mantle bit for bit, its raft count.
// Run by `make test` after `make engine`.
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const dist = new URL('../dist/', import.meta.url)
const native = createRequire(import.meta.url)(new URL('casas-engine.node', dist).pathname)
const wasm = await import(new URL('wasm/casas-engine.js', dist).href)
await wasm.default({ module_or_path: await readFile(new URL('wasm/casas-engine_bg.wasm', dist)) })

const CLIENT = fileURLToPath(new URL('../../client', import.meta.url))
const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
const { createArcheanSimulation } = await L('/src/generator/archean/archeanState.ts')
const { archeanStep, DEFAULT_ARCHEAN_PARAMS } = await L('/src/generator/archean/archeanStep.ts')
const { finalizeArchean } = await L('/src/generator/archean/finalizeArchean.ts')
const { serializePlateSimulation } = await L('/src/generator/tectonics/plateSimulation.ts')
const { savedOceanAge } = await L('/src/generator/tectonics/oceanAge.ts')
const { savedMantle } = await L('/src/generator/mantle/mantleField.ts')
const { TECTONIC_MA_PER_EPOCH } = await L('/src/generator/core/worldTime.ts')
const CE = await L('/src/generator/pipeline/coupledEpoch.ts')
const { defaultWeatherParams } = await L('/src/generator/climate/weather.ts')
const { TECTONICS_INPUTS } = await L('/src/generator/tectonics/tectonicsInputParams.ts')
await server.close()

let failed = false
const fail = (message) => {
  console.error(`engine: ${message}`)
  failed = true
}

if (native.version() !== wasm.version()) fail(`native ${native.version()} and wasm ${wasm.version()} differ`)

// A value as canonical JSON: keys sorted, typed arrays as their bytes'
// hex, so two values compare equal when their data does.
const canonical = (v) => {
  if (ArrayBuffer.isView(v)) return `"${v.constructor.name}:${Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('hex')}"`
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  return JSON.stringify(v)
}
const same = (a, b) => a.length === b.length && Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength))
const STEPS = 60
const EPOCHS = 6
for (const shape of ['torus', 'sphere']) {
  const [seed, width, height, diffusion, landShare] = ['smoke', 512, 256, 2, 0.4]
  const ts = createArcheanSimulation(seed, width, height, shape)
  const params = { ...DEFAULT_ARCHEAN_PARAMS, diffusion, landShare }
  const n = native.World.genesis(seed, width, height, shape, diffusion, landShare)
  const w = wasm.World.genesis(seed, width, height, shape, diffusion, landShare)
  for (let i = 0; i < STEPS; i++) {
    archeanStep(ts, params)
    n.archeanStep()
    w.archeanStep()
  }
  const tsMantle = Float64Array.from(ts.mantle)
  if (!same(n.mantle(), tsMantle)) fail(`${shape}: the native mantle differs from TypeScript's`)
  if (!same(w.mantle(), tsMantle)) fail(`${shape}: the wasm mantle differs from TypeScript's`)
  if (n.raftCount !== ts.rafts.length || w.raftCount !== ts.rafts.length) fail(`${shape}: rafts native ${n.raftCount}, wasm ${w.raftCount}, TypeScript ${ts.rafts.length}`)
  if (n.archeanEpoch !== ts.epoch || w.archeanEpoch !== ts.epoch) fail(`${shape}: the epoch differs`)
  console.log(`engine: ${shape} Archean, ${STEPS} steps, ${ts.rafts.length} rafts — native, wasm and TypeScript agree`)

  // The hand-over and two coupled epochs.
  const sim = finalizeArchean(ts)
  sim.epochMa = TECTONIC_MA_PER_EPOCH
  const coupled = CE.createCoupledTerrain(sim, CE.HISTORY_DEFAULTS.budget)
  n.finalize()
  w.finalize()
  const weather = defaultWeatherParams()
  const controls = { alluvium: TECTONICS_INPUTS.alluvium.default, rockContrast: TECTONICS_INPUTS.rockContrast.default, ...weather }
  let eventCount = 0
  for (let e = 0; e < EPOCHS; e++) {
    const D = CE.HISTORY_DEFAULTS
    const stats = await CE.stepCoupledEpoch(sim, coupled, {
      iterationsPerEpoch: D.iterationsPerEpoch, budget: D.budget, climateEvery: D.climateEvery, remeshEvery: D.remeshEvery, upliftScale: D.upliftScale,
      controls: { alluvium: controls.alluvium, rockContrast: controls.rockContrast }, weather,
    })
    eventCount += stats.events.length
    const events = canonical(stats.events)
    if (canonical(n.epoch(controls)) !== events) fail(`${shape}: epoch ${e + 1}'s native events differ`)
    if (canonical(w.epoch(controls)) !== events) fail(`${shape}: epoch ${e + 1}'s wasm events differ`)
  }
  const snapshot = canonical(serializePlateSimulation(sim))
  if (canonical(n.snapshot()) !== snapshot) fail(`${shape}: the native snapshot differs`)
  if (canonical(w.snapshot()) !== snapshot) fail(`${shape}: the wasm snapshot differs`)
  if (Object.keys(n.snapshot()).join() !== Object.keys(serializePlateSimulation(sim)).join()) fail(`${shape}: the snapshot's keys come in another order`)
  const fields = canonical([savedMantle(sim.mantle, sim.domain), savedOceanAge(sim.oceanAge, sim.domain)])
  if (canonical(n.savedFields()) !== fields) fail(`${shape}: the native saved fields differ`)
  if (canonical(w.savedFields()) !== fields) fail(`${shape}: the wasm saved fields differ`)
  const bytes = CE.encodeCoupledTerrain(coupled)
  const count = bytes.z.length
  const mesh = canonical({
    count, nodes: bytes.nodes, connectivity: bytes.connectivity, z: bytes.z, column: bytes.column,
    sedimentFlux: coupled.sedimentFlux.length >= count ? coupled.sedimentFlux.slice(0, count) : new Float32Array(count),
    preErosionZ: coupled.preErosionZ.length >= count ? coupled.preErosionZ.slice(0, count) : bytes.z.slice(),
    ice: coupled.ice.length >= count ? coupled.ice.slice(0, count) : undefined,
  })
  if (canonical(n.meshPayload()) !== mesh) fail(`${shape}: the native mesh payload differs`)
  if (canonical(w.meshPayload()) !== mesh) fail(`${shape}: the wasm mesh payload differs`)
  w.free()
  console.log(`engine: ${shape} hand-over and ${EPOCHS} epochs, ${sim.rafts.length} rafts, ${count} nodes, ${eventCount} events — snapshot, events, fields and mesh agree`)
}
if (failed) process.exit(1)
console.log(`engine: native and wasm ${wasm.version()}`)
process.exit(0)
