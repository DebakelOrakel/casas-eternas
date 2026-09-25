// The coupled history's instrument (ADAPTIVE_MESH_PLAN.md phase 5.1, the
// calibration phase 5 opens): one world, N epochs under one setting, and
// per epoch what the setting does to the mesh and the land — nodes, land
// fraction, heights, the time it costs. Not a gate: nothing here passes or
// fails, it prints the table the calibration is judged on.
//
//   node scripts/calibrateHistory.mjs [key=value …]
//     seed=harness width=256 height=128 archean=60 epochs=20 iterations=4
//     budget=1 uplift=1 flex=1 sedK=3 plain=0
//
// `plain` runs that many plain plate epochs between the hand-over and the
// coupling (the golden's world has 46): the hand-over leaves every range
// freshly fed, so the uplift forcing is broad there and narrows only as
// dead boundaries' ranges decay — a history judged at the hand-over is
// judged at its widest uplift. The instrument prints the U field's reach
// over land at the coupling's start.
//
// `flex` is TECTONICS_TUNING.flexureDeflectionScale for the run (0 = no
// isostasy), `sedK` COLUMN_TUNING.sedimentErodibility — the two knobs
// phases 5.2 and 5.3 left to the calibration.
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
  tune: await L('/src/generator/tectonics/tectonicsTuneParams.ts'),
  sim: await L('/src/generator/tectonics/plateSimulation.ts'),
  forcing: await L('/src/generator/pipeline/erosionForcing.ts'),
  raft: await L('/src/generator/crust/raftField.ts'),
  climate: await L('/src/generator/climate/climateField.ts'),
  column: await L('/src/generator/mesh/meshColumn.ts'),
}
const opt = { seed: 'harness', width: 256, height: 128, archean: 60, epochs: 20, iterations: 4, budget: 1, buildBudget: 0, uplift: 1, flex: 1, sedK: 3, plain: 0 }
for (const arg of process.argv.slice(2)) { const [k, v] = arg.split('='); if (k in opt) opt[k] = k === 'seed' ? v : Number(v) }
console.log(JSON.stringify(opt))
M.tune.TECTONICS_TUNING.flexureDeflectionScale = opt.flex
M.column.COLUMN_TUNING.sedimentErodibility = opt.sedK
const archean = M.archean.createArcheanSimulation(opt.seed, opt.width, opt.height)
for (let e = 0; e < opt.archean; e++) M.archeanStep.archeanStep(archean)
const sim = M.finalize.finalizeArchean(archean)
for (let e = 0; e < opt.plain; e++) M.sim.stepEpoch(sim)
{
  // The uplift forcing's reach: over the land cells of the forcing grid
  // (raft membership at the cell centre), the mean of U and the share of
  // cells forced at all / above a half.
  const { uplift } = M.forcing.coarseForcingFields(sim, opt.width, opt.height)
  const RX = M.climate.CLIMATE_RES_X, RY = M.climate.CLIMATE_RES_Y
  let land = 0, forced = 0, strong = 0, sum = 0
  for (let y = 0; y < RY; y++) for (let x = 0; x < RX; x++) {
    if (M.raft.raftField(((x + 0.5) / RX) * opt.width, ((y + 0.5) / RY) * opt.height, sim.rafts, opt.width, opt.height) <= 0.5) continue
    land++
    const u = uplift[y * RX + x]
    sum += u
    if (u > 0.05) forced++
    if (u > 0.5) strong++
  }
  console.log(`uplift forcing over land after ${opt.plain} plain epochs: mean ${(sum / Math.max(1, land)).toFixed(2)}, forced ${(forced / Math.max(1, land) * 100).toFixed(0)} %, above a half ${(strong / Math.max(1, land) * 100).toFixed(0)} %`)
}
let t = performance.now()
// buildBudget: the mesh built at another budget than the epochs run at —
// a save from before a budget change, coarsened by the remesh.
const terrain = M.coupled.createCoupledTerrain(sim, opt.buildBudget || opt.budget)
const stats = (terrain) => {
  const { mesh, z, column } = terrain
  const hs = []
  let land = 0, area = 0, fine = 0, coarse = 0
  const D = M.column.COLUMN_DEPTH, V = M.column.COLUMN_VALUES
  for (let v = 0; v < mesh.vertexSlots; v++) {
    if (!mesh.vAlive[v]) continue
    const a = mesh.voronoiArea(v)
    area += a
    if (z[v] > 0) { land += a; hs.push(z[v] * M.scale.ELEVATION_METERS) }
    for (let layer = 0; layer < column.epochs.length; layer++) { fine += column.data[v * D + layer * V] * a; coarse += column.data[v * D + layer * V + 1] * a }
  }
  hs.sort((a, b) => a - b)
  const p = (q) => hs.length ? hs[Math.floor(q * (hs.length - 1))] : 0
  const mean = hs.length ? hs.reduce((s, h) => s + h, 0) / hs.length : 0
  return { nodes: mesh.aliveVertices, land: land / area, mean, p50: p(0.5), p90: p(0.9), max: p(1), coarseShare: fine + coarse > 0 ? coarse / (fine + coarse) : 0 }
}
const s0 = stats(terrain)
console.log(`build ${((performance.now() - t) / 1000).toFixed(1)} s: ${s0.nodes} nodes, land ${(s0.land * 100).toFixed(1)} %, mean ${s0.mean.toFixed(0)} m, p90 ${s0.p90.toFixed(0)} m, max ${s0.max.toFixed(0)} m`)
console.log('epoch  nodes   removed inserted  land%   mean   p50   p90    max  cut km³ dep km³ exp km³ col km³ coarse% rebound subs.    s  (seconds per phase)')
for (let e = 0; e < opt.epochs; e++) {
  t = performance.now()
  const st = await M.coupled.stepCoupledEpoch(sim, terrain, { iterationsPerEpoch: opt.iterations, budget: opt.budget, upliftScale: opt.uplift })
  const s = stats(terrain)
  const km3 = (m3) => (m3 / 1e9).toFixed(0).padStart(7)
  console.log(`${String(e + 1).padStart(5)} ${String(s.nodes).padStart(7)} ${String(st.removed).padStart(8)} ${String(st.inserted).padStart(8)}  ${(s.land * 100).toFixed(1).padStart(5)} ${s.mean.toFixed(0).padStart(6)} ${s.p50.toFixed(0).padStart(5)} ${s.p90.toFixed(0).padStart(5)} ${s.max.toFixed(0).padStart(6)} ${km3(st.erodedFluxM3)} ${km3(st.depositedM3)} ${km3(st.exportedFluxM3)} ${km3(st.columnVolumeM3)} ${(s.coarseShare * 100).toFixed(0).padStart(7)} ${st.reboundMaxM.toFixed(0).padStart(7)} ${st.subsidenceMaxM.toFixed(0).padStart(5)} ${((performance.now() - t) / 1000).toFixed(1).padStart(5)}  (${['membership', 'tectonics', 'rebuild', 'remesh', 'baseline', 'climate', 'forcing', 'erosion', 'flexure', 'lakes'].map((k) => `${k.slice(0, 4)} ${(st.timing[k] / 1000).toFixed(1)}`).join(' ')})`)
}
await server.close()
