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
await server.close()

let failed = false
const fail = (message) => {
  console.error(`engine: ${message}`)
  failed = true
}

if (native.version() !== wasm.version()) fail(`native ${native.version()} and wasm ${wasm.version()} differ`)

const same = (a, b) => a.length === b.length && Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength))
const STEPS = 30
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
  w.free()
  console.log(`engine: ${shape} Archean, ${STEPS} steps, ${ts.rafts.length} rafts — native, wasm and TypeScript agree`)
}
if (failed) process.exit(1)
console.log(`engine: native and wasm ${wasm.version()}`)
process.exit(0)
