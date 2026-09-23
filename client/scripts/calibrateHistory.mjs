// The coupled history's instrument (ADAPTIVE_MESH_PLAN.md phase 5.1, the
// calibration phase 5 opens): one world, N epochs under one setting, and
// per epoch what the setting does to the mesh and the land — nodes, land
// fraction, heights, the time it costs. Not a gate: nothing here passes or
// fails, it prints the table the calibration is judged on.
//
//   node scripts/calibrateHistory.mjs [key=value …]
//     seed=harness width=256 height=128 archean=60 epochs=20 iterations=4
//     budget=1 uplift=1
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
const M = {
  archean: await L('/src/generator/archean/archeanState.ts'),
  archeanStep: await L('/src/generator/archean/archeanStep.ts'),
  finalize: await L('/src/generator/archean/finalizeArchean.ts'),
  coupled: await L('/src/generator/pipeline/coupledEpoch.ts'),
  scale: await L('/src/generator/elevation/elevationScale.ts'),
}
const opt = { seed: 'harness', width: 256, height: 128, archean: 60, epochs: 20, iterations: 4, budget: 1, uplift: 1 }
for (const arg of process.argv.slice(2)) { const [k, v] = arg.split('='); if (k in opt) opt[k] = k === 'seed' ? v : Number(v) }
console.log(JSON.stringify(opt))
const archean = M.archean.createArcheanSimulation(opt.seed, opt.width, opt.height)
for (let e = 0; e < opt.archean; e++) M.archeanStep.archeanStep(archean)
const sim = M.finalize.finalizeArchean(archean)
let t = performance.now()
const terrain = M.coupled.createCoupledTerrain(sim, opt.budget)
const stats = (terrain) => {
  const { mesh, z } = terrain
  const hs = []
  let land = 0, area = 0
  for (let v = 0; v < mesh.vertexSlots; v++) {
    if (!mesh.vAlive[v]) continue
    const a = mesh.voronoiArea(v)
    area += a
    if (z[v] > 0) { land += a; hs.push(z[v] * M.scale.ELEVATION_METERS) }
  }
  hs.sort((a, b) => a - b)
  const p = (q) => hs.length ? hs[Math.floor(q * (hs.length - 1))] : 0
  const mean = hs.length ? hs.reduce((s, h) => s + h, 0) / hs.length : 0
  return { nodes: mesh.aliveVertices, land: land / area, mean, p50: p(0.5), p90: p(0.9), max: p(1) }
}
const s0 = stats(terrain)
console.log(`build ${((performance.now() - t) / 1000).toFixed(1)} s: ${s0.nodes} nodes, land ${(s0.land * 100).toFixed(1)} %, mean ${s0.mean.toFixed(0)} m, p90 ${s0.p90.toFixed(0)} m, max ${s0.max.toFixed(0)} m`)
console.log('epoch  nodes   removed inserted  land%   mean   p50   p90    max   s')
for (let e = 0; e < opt.epochs; e++) {
  t = performance.now()
  const st = await M.coupled.stepCoupledEpoch(sim, terrain, { iterationsPerEpoch: opt.iterations, budget: opt.budget, upliftScale: opt.uplift })
  const s = stats(terrain)
  console.log(`${String(e + 1).padStart(5)} ${String(s.nodes).padStart(7)} ${String(st.removed).padStart(8)} ${String(st.inserted).padStart(8)}  ${(s.land * 100).toFixed(1).padStart(5)} ${s.mean.toFixed(0).padStart(6)} ${s.p50.toFixed(0).padStart(5)} ${s.p90.toFixed(0).padStart(5)} ${s.max.toFixed(0).padStart(6)} ${((performance.now() - t) / 1000).toFixed(1).padStart(5)}`)
}
await server.close()
