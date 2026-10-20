// Writes the module test fixture for the engine's surface stages, first
// part: hashes of what the TypeScript engine's mesh/meshColumn.ts,
// surface/cover.ts, surface/glacial.ts and surface/coastal.ts make on a
// built mesh of each shape with a synthetic climate, which the Rust port
// must make bit for bit (docs/decisions/rust-engine.md, fork 5).
//
//   node engine/scripts/surfaceFixture.mjs           write the fixture
//   node engine/scripts/surfaceFixture.mjs --check   fail if it is stale
//
// crates/casas-engine/tests/surface.rs runs the same scenarios: change
// one, change the other.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('../../client', import.meta.url))
const OUT = new URL('../crates/casas-engine/tests/fixtures/surface.txt', import.meta.url)

const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
const { torusDomain, sphereDomain } = await L('/src/generator/core/domain.ts')
const { detSin, detCos } = await L('/src/generator/core/detMath.ts')
const { buildMesh, MESH_Z } = await L('/src/generator/mesh/meshBuild.ts')
const C = await L('/src/generator/mesh/meshColumn.ts')
const { coverField } = await L('/src/generator/surface/cover.ts')
const G = await L('/src/generator/surface/glacial.ts')
const K = await L('/src/generator/surface/coastal.ts')
await server.close()

let state = 0
const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0)
const uniform = (lo, hi) => lo + (hi - lo) * (next() / 4294967296)
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
  '# Hashes of client/src/generator/mesh/meshColumn.ts and surface/{cover,glacial,coastal}.ts, for crates/casas-engine/tests/surface.rs.',
  '# Written by engine/scripts/surfaceFixture.mjs; do not edit.',
]
const line = (name) => lines.push(`${name} ${hex()}`)

// The column: layers past the cap, deposits, cuts, the bytes.
{
  state = 1
  const slots = 300
  const col = C.createColumn(slots)
  h = 0x811c9dc5
  for (let e = 0; e < 11; e++) {
    C.openLayer(col, 100 + e * 3, slots)
    for (let k = 0; k < 500; k++) {
      const v = next() % slots
      C.deposit(col, v, uniform(-2, 30), uniform(0, 1), uniform(0.3, 2), uniform(-20, 30), uniform(0, 3000), k % 3 === 0)
    }
    for (let k = 0; k < 200; k++) add(C.cut(col, next() % slots, uniform(-1, 40)))
    addAll(col.epochs)
    for (let v = 0; v < slots; v += 7) { add(C.columnThickness(col.data, v, col.epochs.length)); add(C.erodibilityOver(col.data, v, col.epochs.length, 0.7)) }
  }
  addAll(col.data)
  const bytes = C.encodeColumn(col, slots)
  addAll(bytes)
  const back = C.decodeColumn(bytes, slots, slots + 20)
  addAll(back.data)
  addAll(back.epochs)
  const order = new Int32Array(slots)
  for (let i = 0; i < slots; i++) order[i] = (i * 37) % slots
  addAll(C.permuteColumn(col.data, order))
  const biomes = new Uint8Array(40)
  for (let i = 0; i < 40; i++) biomes[i] = i % 20
  addAll(coverField(biomes, true))
  addAll(coverField(biomes, false))
  line('column')
}

const heightAt = (x, y) => 0.09 * detSin(x * 0.006) * detCos(y * 0.008) + 0.05 * detSin(x * 0.019 + y * 0.011) + 0.03 * detCos(x * 0.043 - y * 0.027) - 0.03
const sampler = { heightAt, dischargeAt: (x, y) => 2500 * (1 + detSin(x * 0.05 + y * 0.03)) }

for (const [name, domain] of [['torus', torusDomain(2048, 1024)], ['sphere', sphereDomain(2048, 1024)]]) {
  const { mesh, state: ms } = buildMesh(domain, sampler, { seed: 7, budget: 12 })
  const slots = mesh.vertexSlots
  const z = ms.get(MESH_Z).slice(0, slots)
  const cellM = domain.metresPerUnit
  const tsl = new Float32Array(slots)
  const precip = new Float32Array(slots)
  const amp = new Float32Array(slots)
  const windE = new Float32Array(slots)
  const windS = new Float32Array(slots)
  const hardness = new Float32Array(slots)
  const flux = new Float32Array(slots)
  const areas = new Float32Array(slots)
  for (let v = 0; v < slots; v++) {
    if (!mesh.vAlive[v]) continue
    const lat = Math.abs(mesh.vy[v] / domain.height - 0.5) * 2
    tsl[v] = 27 - 55 * lat + 3 * detSin(mesh.vx[v] * 0.01)
    precip[v] = z[v] > 0 ? 400 + 900 * (1 + detSin(mesh.vx[v] * 0.007 + mesh.vy[v] * 0.004)) : -1
    amp[v] = z[v] > 0 ? 8 + 30 * lat : -1
    windE[v] = detCos(mesh.vy[v] * 0.012) * 0.9
    windS[v] = 0.3 * detSin(mesh.vx[v] * 0.009)
    hardness[v] = 0.8 + 0.6 * detCos(mesh.vx[v] * 0.02)
    flux[v] = z[v] > 0 ? 1e7 * (1 + detSin(mesh.vx[v] * 0.03)) : 0
    areas[v] = mesh.voronoiArea(v)
  }
  const ice = G.computeIceOnMesh({ mesh, z, seaLevelTemperature: tsl, precipitation: precip, seasonalAmplitude: amp, cellM })
  h = 0x811c9dc5
  add(slots)
  for (const k of ['thickness', 'balance', 'receiver', 'slope', 'order', 'elaM']) addAll(ice[k])
  add(ice.massIn)
  add(ice.massMelt)
  add(ice.massOut)
  const glacial = G.glacialErosionOnMesh(mesh, z, ice, 1e6, cellM)
  addAll(glacial.cutM)
  addAll(glacial.tillM)
  add(glacial.cutM3)
  add(glacial.tillM3)
  line(`${name}_ice`)

  h = 0x811c9dc5
  const shore = K.findShore(mesh, z)
  addAll(shore.shore)
  addAll(shore.normalX)
  addAll(shore.normalY)
  const coast = K.computeCoastal({ mesh, z, areas, windE, windS, cellM, hardness, sedimentFlux: flux, iterations: 4, epochYears: 1e6 })
  addAll(coast.cutM)
  addAll(coast.depositM)
  addAll(coast.exposure)
  add(coast.shoreNodes)
  add(coast.erodedM3)
  add(coast.suppliedM3)
  add(coast.depositedM3)
  add(coast.exportedM3)
  add(mesh.lastTri)
  line(`${name}_coast`)
}

const text = lines.join('\n') + '\n'
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('engine/crates/casas-engine/tests/fixtures/surface.txt is stale — run node engine/scripts/surfaceFixture.mjs')
    process.exit(1)
  }
} else {
  writeFileSync(OUT, text)
  console.log(`surface fixture: ${lines.length - 2} lines`)
}
