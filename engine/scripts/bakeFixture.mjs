// Writes the module test fixture for the engine's level bake: hashes of
// what the TypeScript engine's pipeline/meshBakeStage.ts makes of a
// synthetic save — a compacted mesh with its heights, coarse forcing
// layers and a climate per cell of the climate mesh — which the Rust port
// must make bit for bit (docs/decisions/rust-engine.md, fork 5).
//
//   node engine/scripts/bakeFixture.mjs           write the fixture
//   node engine/scripts/bakeFixture.mjs --check   fail if it is stale
//
// crates/casas-engine/tests/bake.rs runs the same scenarios: change one,
// change the other.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('../../client', import.meta.url))
const OUT = new URL('../crates/casas-engine/tests/fixtures/bake.txt', import.meta.url)

const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
const { torusDomain } = await L('/src/generator/core/domain.ts')
const { detSin, detCos } = await L('/src/generator/core/detMath.ts')
const { buildMesh, MESH_Z } = await L('/src/generator/mesh/meshBuild.ts')
const { hilbertVertexOrder, encodeMesh, permute } = await L('/src/generator/mesh/meshSerial.ts')
const { climateMesh } = await L('/src/generator/climate/climateMesh.ts')
const H = await L('/src/generator/surface/hydrology.ts')
const B = await L('/src/generator/pipeline/meshBakeStage.ts')
await server.close()

const f = new Float64Array(1)
const w = new Uint32Array(f.buffer)
let h = 0
const add = (v) => {
  if (v === true) v = 1
  else if (v === false) v = 0
  if (v !== v) {
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
  '# Hashes of client/src/generator/pipeline/meshBakeStage.ts, for crates/casas-engine/tests/bake.rs.',
  '# Written by engine/scripts/bakeFixture.mjs; do not edit.',
]
const line = (name) => lines.push(`${name} ${hex()}`)
const KIND = { lake: 0, terminal: 1, dry: 2 }
const NODE = { source: 0, junction: 1, mouth: 2, inlet: 3, outlet: 4 }
const PATTERN = { straight: 0, meandering: 1, braided: 2, anastomosing: 3 }
const levelHash = (lv) => {
  add(lv.level); add(lv.inserted)
  const m = lv.mesh
  addAll(m.vx.subarray(0, m.vertexSlots)); addAll(m.vy.subarray(0, m.vertexSlots)); addAll(m.tris.subarray(0, 3 * m.triSlots))
  addAll(lv.z)
  addAll(lv.routing.flowTarget); addAll(lv.routing.filled); addAll(lv.routing.accumulation); addAll(lv.routing.popOrder); add(lv.routing.poppedCount)
  addAll(lv.discharge)
  for (const b of lv.waterBodies) { add(b.id); add(KIND[b.kind]); add(b.level); add(b.spill); add(b.floor); add(b.seedX); add(b.seedY); add(b.outletX); add(b.outletY); add(b.cells); add(b.frozen) }
  const g = lv.graph
  add(g !== null)
  if (g) {
    for (const n of g.nodes) { add(NODE[n.kind]); add(n.cell); add(n.x); add(n.y); add(n.body); add(n.catchmentCells) }
    for (const r of g.reaches) { add(r.from); add(r.to); add(r.cellCount); add(r.dischargeOut); add(r.widthPx); add(r.lengthKm); add(r.slope); add(r.sedimentM3); add(r.order); add(H.RIVER_REGIME_CODE[r.regime]) }
    addAll(g.cells); addAll(g.cellX); addAll(g.cellY)
    for (const c of g.courses) {
      add(c.reach); add(PATTERN[c.pattern]); add(c.widthM); add(c.sinuosity); add(c.beltWidthM)
      for (const l of c.lines) addAll(l)
      for (const o of c.oxbows) addAll(o)
      addAll(c.lineWidth); addAll(c.lobeAges)
    }
    addAll(lv.rivers.points); addAll(lv.rivers.lengths); addAll(lv.rivers.regimes)
  }
}

const W = 1024
const HGT = 512
const domain = torusDomain(W, HGT)
const heightAt = (x, y) => 0.09 * detSin(x * 0.006) * detCos(y * 0.008) + 0.05 * detSin(x * 0.019 + y * 0.011) + 0.03 * detCos(x * 0.043 - y * 0.027) - 0.02 - 0.06 * Math.max(0, detSin(x * 0.011 + 2) * detCos(y * 0.013 + 1) - 0.6)
const built = buildMesh(domain, { heightAt }, { seed: 7, budget: 4 })
const order = hilbertVertexOrder(built.mesh)
const serial = encodeMesh(built.mesh, order)
const mesh = { ...serial, z: permute(built.state.get(MESH_Z), order) }
// The climate per cell of the climate mesh.
const cm = climateMesh(domain)
const nc = cm.mesh.count
const climate = { cells: nc, spacingM: cm.cellM, seaLevelTemperature: new Float32Array(nc), precipitation: new Float32Array(nc), seasonalAmplitude: new Float32Array(nc), monsoonIndex: new Float32Array(nc) }
for (let i = 0; i < nc; i++) {
  const x = cm.mesh.x[i]
  const y = cm.mesh.y[i]
  const lat = Math.abs(y / HGT - 0.5) * 2
  const land = heightAt(x, y) > 0
  climate.seaLevelTemperature[i] = 28 - 40 * lat + 3 * detSin(x * 0.02)
  climate.precipitation[i] = land ? 200 + 800 * (1 + detSin(x * 0.009 + y * 0.005)) : -1
  climate.seasonalAmplitude[i] = 4 + 14 * lat
  climate.monsoonIndex[i] = land ? 0.7 * detCos(x * 0.004) : -1
}
const uplift = new Float32Array(64 * 32)
const erodibility = new Float32Array(64 * 32)
for (let i = 0; i < uplift.length; i++) {
  uplift[i] = 0.5 + 0.5 * detSin(i * 0.13)
  erodibility[i] = 1 + 0.4 * detCos(i * 0.07)
}
const inputs = { mesh, width: W, height: HGT, detailSeed: 4242, lithoSeed: 99, controls: { alluvium: 60, rockContrast: 35 }, uplift, erodibility, forcingResX: 64, forcingResY: 32, climate }

h = 0x811c9dc5
for (let k = 0; k <= 4; k++) add(B.levelBudget(k))
line('budget')
for (const [name, extra] of [['climate', {}], ['dry', { climate: null, uplift: null, erodibility: null, forcingResX: 0, forcingResY: 0 }]]) {
  h = 0x811c9dc5
  const lv = await B.bakeMeshLevel({ ...inputs, ...extra }, { level: 1, budget: 2, rounds: 6 })
  levelHash(lv)
  if (lv.graph) console.log(name, 'nodes', lv.mesh.vertexSlots, 'reaches', lv.graph.reaches.length, 'courses', lv.graph.courses.length, 'bodies', lv.waterBodies.length)
  line(`level_${name}`)
}

const text = lines.join('\n') + '\n'
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('engine/crates/casas-engine/tests/fixtures/bake.txt is stale — run node engine/scripts/bakeFixture.mjs')
    process.exit(1)
  }
} else {
  writeFileSync(OUT, text)
  console.log(`bake fixture: ${lines.length - 2} lines`)
}
