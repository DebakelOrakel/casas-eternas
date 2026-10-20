// Writes the module test fixture for the engine's erosion: hashes of what
// the TypeScript engine's surface/erosionEngine.ts and its pool drivers
// (erosionEnginePool.ts), run through mesh/meshErosion.ts on a mesh, make
// of fixed scenarios, which the Rust port must make bit for bit
// (docs/decisions/rust-engine.md, fork 5).
//
//   node engine/scripts/erosionFixture.mjs           write the fixture
//   node engine/scripts/erosionFixture.mjs --check   fail if it is stale
//
// crates/casas-engine/tests/erosion.rs runs the same scenarios from the
// same analytic fields: change one, change the other. The pool runs on
// real worker threads (client/scripts/engineWorkerHost.mjs).

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

const CLIENT = fileURLToPath(new URL('../../client', import.meta.url))
const OUT = new URL('../crates/casas-engine/tests/fixtures/erosion.txt', import.meta.url)
const HOST = new URL('../../client/scripts/engineWorkerHost.mjs', import.meta.url)

const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
const { torusDomain, sphereDomain } = await L('/src/generator/core/domain.ts')
const { detSin, detCos } = await L('/src/generator/core/detMath.ts')
const E = await L('/src/generator/surface/erosionEngine.ts')
const { buildMesh, MESH_Z } = await L('/src/generator/mesh/meshBuild.ts')
const { runMeshErosion } = await L('/src/generator/mesh/meshErosion.ts')
await server.close()

const f = new Float64Array(1)
const w = new Uint32Array(f.buffer)
let h = 0
const add = (v) => {
  if (v !== v) {
    w[1] = 0x7ff80000
    w[0] = 0
  } else f[0] = v
  h = Math.imul(h ^ w[0], 0x01000193) >>> 0
  h = Math.imul(h ^ w[1], 0x01000193) >>> 0
}
const addAll = (a, n = a.length) => {
  for (let i = 0; i < n; i++) add(a[i])
}
const hex = () => h.toString(16).padStart(8, '0')
const lines = [
  '# Hashes of client/src/generator/surface/erosionEngine*.ts runs, for crates/casas-engine/tests/erosion.rs.',
  '# Written by engine/scripts/erosionFixture.mjs; do not edit.',
]
const line = (name) => lines.push(`${name} ${hex()}`)

// The analytic fields both sides build from, at a point of the 2048 × 1024 map.
const heightAt = (x, y) => 0.06 * detSin(x * 0.011) * detCos(y * 0.017) + 0.03 * detSin(x * 0.041 + y * 0.023) - 0.04
const dischargeAt = (x, y) => 2500 * (1 + detSin(x * 0.05 + y * 0.03))
const sampler = { heightAt, dischargeAt }
function forcingAt(xs, ys, z, n, extras) {
  const fo = {
    uplift: new Float32Array(n),
    erodibility: new Float32Array(n),
    coastMask: new Uint8Array(n),
    accumulationWeights: new Float32Array(n),
    cratonAge: new Float32Array(n),
    rockHard: new Float32Array(n),
    slopeScale: new Float32Array(n),
    diffScale: new Float32Array(n),
  }
  for (let i = 0; i < n; i++) {
    const x = xs[i]
    const y = ys[i]
    fo.uplift[i] = 0.6 + 0.5 * detSin(x * 0.013 + y * 0.007)
    fo.erodibility[i] = 1 + 0.4 * detCos(x * 0.021 - y * 0.011)
    fo.coastMask[i] = z[i] > 0 || i % 11 === 0 ? 1 : 0
    fo.accumulationWeights[i] = 0.8 + 0.6 * detSin(y * 0.031)
    fo.cratonAge[i] = 0.5 + 0.5 * detCos(x * 0.004)
    fo.rockHard[i] = 0.5 + 0.5 * detSin(y * 0.009 + x * 0.002)
    fo.slopeScale[i] = 1 + 0.3 * detSin(x * 0.017)
    fo.diffScale[i] = 1 + 0.5 * detCos(y * 0.013)
  }
  if (extras) {
    fo.statusMask = new Uint8Array(n)
    fo.pinnedZ = new Float32Array(n).fill(NaN)
    for (let i = 0; i < n; i++) {
      fo.statusMask[i] = i % 13 === 0 ? 1 : i % 17 === 0 ? 2 : 0
      if (i % 29 === 0) fo.pinnedZ[i] = z[i] + 0.001
    }
  }
  return fo
}
function engineHash(views, popped, tallies) {
  for (const k of ['z', 'cutVolume', 'depositVolume', 'depositCoarse', 'depositCraton', 'depositHard', 'hillNet', 'upliftNet', 'flux', 'fluxCoarse', 'fluxCraton', 'fluxHard', 'donorMin', 'erosionVolume', 'erosionCoarse', 'filled', 'flowTarget', 'flowDir', 'accumulation', 'segment', 'stage']) addAll(views[k])
  addAll(views.popOrder, popped)
  add(popped)
  add(tallies[0])
  add(tallies[1])
}

// The raster engine: two shapes, the full forcing; then the status rule
// and pinned heights.
const RES_X = 256
const RES_Y = 128
for (const [name, domain] of [['torus', torusDomain(RES_X, RES_Y)], ['sphere', sphereDomain(RES_X, RES_Y)]]) {
  const grid = domain.grid(RES_X, RES_Y)
  const n = RES_X * RES_Y
  const xs = new Float64Array(n)
  const ys = new Float64Array(n)
  const z = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    xs[i] = (i % RES_X) * 8 + 4
    ys[i] = Math.floor(i / RES_X) * 8 + 4
    z[i] = heightAt(xs[i], ys[i]) * 1.4
  }
  for (const [variant, extras, iterations, every] of [['full', false, 12, 4], ['status', true, 8, 3]]) {
    const engine = E.ErosionEngine.onRaster(grid, z, forcingAt(xs, ys, z, n, extras), { ...E.DEFAULT_ENGINE_PARAMS, epsM: 0 })
    h = 0x811c9dc5
    add(engine.index.activeCount)
    add(engine.index.frozenCount)
    addAll(engine.index.active)
    engine.run(iterations, every, (i, residual) => { add(i); add(residual) })
    engineHash(engine.views, engine.poppedCount, [engine.erodedFluxM3, engine.exportedFluxM3])
    addAll(engine.expandZ(z))
    line(`raster_${name}_${variant}`)
  }
  // The default calm threshold, which stops a run early.
  const calm = E.ErosionEngine.onRaster(grid, z, { uplift: new Float32Array(n), erodibility: new Float32Array(n).fill(1) })
  h = 0x811c9dc5
  add(calm.run(40, 4, (i, residual) => { add(i); add(residual) }))
  addAll(calm.z)
  line(`raster_${name}_calm`)
}

// The mesh: the single engine and the pool's two schemes on worker threads.
const spawn = () => {
  const worker = new Worker(HOST)
  worker.on('error', (e) => {
    console.error(`worker error: ${e?.message ?? e}`)
    process.exit(1)
  })
  return worker
}
function resultHash(r) {
  for (const k of ['z', 'sedimentFlux', 'cutM3', 'depositM3', 'depositCoarseM3', 'hillNetM3', 'upliftM3', 'depositCraton', 'depositHard']) addAll(r[k])
  addAll(r.routing.flowTarget)
  addAll(r.routing.filled)
  addAll(r.routing.accumulation)
  addAll(r.routing.popOrder)
  add(r.routing.poppedCount)
  add(r.erodedFluxM3)
  add(r.exportedFluxM3)
  add(r.index.activeCount)
}
for (const [name, domain] of [['torus', torusDomain(2048, 1024)], ['sphere', sphereDomain(2048, 1024)]]) {
  const { mesh, state } = buildMesh(domain, sampler, { seed: 7, budget: 16 })
  const n = mesh.vertexSlots
  const z = state.get(MESH_Z).slice(0, n)
  const forcing = forcingAt(mesh.vx, mesh.vy, z, n, false)
  const params = { ...E.DEFAULT_ENGINE_PARAMS, epsM: 0 }
  const frozen = new Uint8Array(n)
  for (let v = 0; v < n; v++) frozen[v] = v % 23 === 0 ? 1 : 0
  for (const [variant, options] of [
    ['single', { age: 10, routingEvery: 4, params }],
    ['frozen', { age: 6, routingEvery: 2, params, frozen }],
    ['overlapped', { age: 10, params, pool: { createWorker: spawn, stencilWorkers: 3, refreshWorkers: 1, pipelineDepth: 3 } }],
    ['synchronous', { age: 9, params, pool: { createWorker: spawn, stencilWorkers: 2, refreshWorkers: 2, pipelineDepth: 4, synchronous: true } }],
  ]) {
    const result = await runMeshErosion(mesh, z, forcing, options)
    h = 0x811c9dc5
    resultHash(result)
    line(`mesh_${name}_${variant}`)
  }
}

const text = lines.join('\n') + '\n'
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('engine/crates/casas-engine/tests/fixtures/erosion.txt is stale — run node engine/scripts/erosionFixture.mjs')
    process.exit(1)
  }
} else {
  writeFileSync(OUT, text)
  console.log(`erosion fixture: ${lines.length - 2} lines`)
}
process.exit(0)
