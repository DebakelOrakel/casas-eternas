// Writes the module test fixture for the engine's coupled epoch: hashes of
// what the TypeScript engine's pipeline/coupledEpoch.ts makes of the
// synthetic plate simulation after 12 tectonic epochs — the terrain from
// the synthesis, then 4 coupled epochs at the history's settings — on both
// shapes, which the Rust port must make bit for bit
// (docs/decisions/rust-engine.md, fork 5).
//
//   node engine/scripts/coupledFixture.mjs           write the fixture
//   node engine/scripts/coupledFixture.mjs --check   fail if it is stale
//
// About a minute: `make test` checks it, not `make lint`. The simulation is
// syntheticSim.mjs's; crates/casas-engine/tests/coupled.rs runs the same:
// change one, change the other.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stateHash } from './simHash.mjs'
import { syntheticSim } from './syntheticSim.mjs'

const CLIENT = fileURLToPath(new URL('../../client', import.meta.url))
const OUT = new URL('../crates/casas-engine/tests/fixtures/coupled.txt', import.meta.url)

const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
const D = await L('/src/generator/core/domain.ts')
const { mulberry32 } = await L('/src/generator/core/rng.ts')
const PM = await L('/src/generator/tectonics/plateMotion.ts')
const OA = await L('/src/generator/tectonics/oceanAge.ts')
const PS = await L('/src/generator/tectonics/plateSimulation.ts')
const CE = await L('/src/generator/pipeline/coupledEpoch.ts')
await server.close()

const EPOCHS = 12
const COUPLED = 4
const f = new Float64Array(1)
const w = new Uint32Array(f.buffer)
let h = 0
const add = (v) => {
  if (v === true) v = 1
  else if (v === false) v = 0
  if (v === undefined || v !== v) {
    w[1] = 0x7ff80000
    w[0] = 0
  } else f[0] = v
  h = Math.imul(h ^ w[0], 0x01000193) >>> 0
  h = Math.imul(h ^ w[1], 0x01000193) >>> 0
}
const addAll = (a) => {
  for (let i = 0; i < a.length; i++) add(a[i])
}
const hex = () => h.toString(16).padStart(8, '0')
const lines = [
  '# Hashes of client/src/generator/pipeline/coupledEpoch.ts, for crates/casas-engine/tests/coupled.rs.',
  '# Written by engine/scripts/coupledFixture.mjs; do not edit.',
]

function terrainHash(t) {
  const m = t.mesh
  const n = m.vertexSlots
  addAll(m.vx.subarray(0, n))
  addAll(m.vy.subarray(0, n))
  addAll(m.tris.subarray(0, 3 * m.triSlots))
  addAll(t.z.subarray(0, n))
  addAll(t.baseline.subarray(0, n))
  addAll(t.areas.subarray(0, n))
  addAll(t.sedimentFlux)
  addAll(t.preErosionZ.subarray(0, n))
  addAll(t.column.data.subarray(0, n * 48))
  addAll(t.column.epochs)
  addAll(t.ice)
  if (t.routing) {
    addAll(t.routing.flowTarget)
    addAll(t.routing.filled)
    addAll(t.routing.popOrder)
  }
  const bytes = CE.encodeCoupledTerrain(t)
  addAll(bytes.connectivity)
  addAll(bytes.column)
}
function coupledSimHash(sim) {
  add(sim.sedimentExportM3)
  add(sim.eustaticM)
  for (const r of sim.lakeAges) { add(r.x); add(r.y); add(r.level); add(r.ageMa) }
  for (const r of sim.climateHistory) { add(r.epoch); add(r.meanLandTempC); add(r.iceVolumeKm3); add(r.seaLevelM) }
}
const STATS = ['depositedM3', 'reErodedM3', 'iceCoastColumnM3', 'columnVolumeM3', 'reboundMaxM', 'subsidenceMaxM', 'meanLandTempC', 'iceVolumeKm3', 'seaLevelM', 'lakes', 'oldestLakeMa', 'meanLandCover', 'screeM3', 'solifluctionShare', 'foldedShare', 'iceAreaShare', 'glacialCutM3', 'tillM3', 'elaMeanM', 'shoreNodes', 'coastCutM3', 'coastDepositM3', 'coastExportM3', 'iceLoadM3', 'iceWeightM3', 'upliftLoadM3', 'nodesBefore', 'nodesAfter', 'removed', 'inserted', 'landCells', 'landVolume', 'erodedFluxM3', 'exportedFluxM3']

const options = { iterationsPerEpoch: 4, budget: 4, climateEvery: 3, remeshEvery: 3, upliftScale: 1 }
for (const [name, d, seed] of [['torus', D.torusDomain(2048, 1024), 7], ['sphere', D.sphereDomain(2048, 1024), 8]]) {
  const sim = syntheticSim({ PM, OA, PS, mulberry32 }, d, seed)
  for (let e = 0; e < EPOCHS; e++) PS.stepEpoch(sim)
  const terrain = CE.createCoupledTerrain(sim, 4)
  h = 0x811c9dc5
  terrainHash(terrain)
  lines.push(`${name} 0 ${hex()} ${stateHash(sim, [])}`)
  for (let e = 1; e <= COUPLED; e++) {
    const stats = await CE.stepCoupledEpoch(sim, terrain, options)
    h = 0x811c9dc5
    terrainHash(terrain)
    coupledSimHash(sim)
    for (const k of STATS) add(stats[k])
    lines.push(`${name} ${e} ${hex()} ${stateHash(sim, stats.events)}`)
    console.log(name, e, 'nodes', stats.nodesAfter, 'lakes', stats.lakes, 'ice km3', stats.iceVolumeKm3.toFixed(0), 'shore', stats.shoreNodes, 'removed', stats.removed, 'inserted', stats.inserted)
  }
}

const text = lines.join('\n') + '\n'
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('engine/crates/casas-engine/tests/fixtures/coupled.txt is stale — run node engine/scripts/coupledFixture.mjs')
    process.exit(1)
  }
} else {
  writeFileSync(OUT, text)
  console.log(`coupled fixture: ${lines.length - 2} lines`)
}
process.exit(0)
