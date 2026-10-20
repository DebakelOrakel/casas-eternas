// Writes the module test fixture for the engine's mesh building: hashes of
// what the TypeScript engine's mesh/ (hilbert, lattice, meshDensity,
// meshState, meshRelief, remesh, meshBuild) and core/rng make in fixed
// scenarios, which the Rust port must make bit for bit
// (docs/decisions/rust-engine.md, fork 5).
//
//   node engine/scripts/meshFixture.mjs           write the fixture
//   node engine/scripts/meshFixture.mjs --check   fail if it is stale
//
// crates/casas-engine/tests/mesh.rs runs the same scenarios from the same
// generator and the same analytic fields: change one, change the other.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('../../client', import.meta.url))
const OUT = new URL('../crates/casas-engine/tests/fixtures/mesh.txt', import.meta.url)

const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
const { torusDomain, sphereDomain } = await L('/src/generator/core/domain.ts')
const { detSin, detCos } = await L('/src/generator/core/detMath.ts')
const { mulberry32 } = await L('/src/generator/core/rng.ts')
const { hilbertKey, hilbertOrder } = await L('/src/generator/mesh/hilbert.ts')
const { hexLattice, geodesicLattice, centroidalGeodesicLattice } = await L('/src/generator/mesh/lattice.ts')
const { targetSpacingM, MESH_TUNING } = await L('/src/generator/mesh/meshDensity.ts')
const { MeshState } = await L('/src/generator/mesh/meshState.ts')
const { buildMesh, densityTarget, triangulatePoints, MESH_Z, MESH_DISCHARGE } = await L('/src/generator/mesh/meshBuild.ts')
const { remesh } = await L('/src/generator/mesh/remesh.ts')
const { MESH_COLUMN, COLUMN_DEPTH } = await L('/src/generator/mesh/meshColumn.ts')
await server.close()

let state = 0
const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0)
const uniform = (lo, hi) => lo + (hi - lo) * (next() / 4294967296)

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
function meshHash(m) {
  addAll(m.vx, m.vertexSlots)
  addAll(m.vy, m.vertexSlots)
  addAll(m.vEdge, m.vertexSlots)
  addAll(m.vAlive, m.vertexSlots)
  addAll(m.tris, 3 * m.triSlots)
  addAll(m.twin, 3 * m.triSlots)
  addAll(m.tAlive, m.triSlots)
  add(m.walkSteps)
  add(m.flips)
}
function stateHash(m, s) {
  for (const field of s.fields) addAll(field.data, m.vertexSlots * field.depth)
}
function statsHash(stats) {
  add(stats.rounds)
  add(stats.inserted)
  add(stats.removed)
  addAll(stats.perRound)
}

// The analytic fields both sides build from.
const heightAt = (x, y) => 0.06 * detSin(x * 0.011) * detCos(y * 0.017) + 0.03 * detSin(x * 0.041 + y * 0.023) - 0.04
const dischargeAt = (x, y) => 2500 * (1 + detSin(x * 0.05 + y * 0.03))
const sampler = { heightAt, dischargeAt }

const lines = [
  '# Hashes of client/src/generator/mesh/ and core/rng.ts, for crates/casas-engine/tests/mesh.rs.',
  '# Written by engine/scripts/meshFixture.mjs; do not edit.',
]
const line = (name) => lines.push(`${name} ${hex()}`)

// mulberry32
h = 0x811c9dc5
for (const seed of [0, 1, 0x9e3779b9, 0xffffffff]) {
  const r = mulberry32(seed)
  for (let i = 0; i < 1000; i++) add(r())
}
line('mulberry32')

// The Hilbert key, at the edges too, and an order.
state = 1
h = 0x811c9dc5
for (const [x, y] of [[0, 0], [-1, 5], [2048, 1024], [3000, -7], [NaN, 3], [Infinity, -Infinity], [2047.9999, 1023.9999]]) add(hilbertKey(x, y, 2048, 1024))
for (let i = 0; i < 100000; i++) add(hilbertKey(uniform(-100, 2148), uniform(-100, 1124), 2048, 1024))
line('hilbert_key')
{
  const xs = new Float64Array(50000)
  const ys = new Float64Array(50000)
  for (let i = 0; i < xs.length; i++) {
    xs[i] = uniform(0, 2048)
    ys[i] = Math.floor(uniform(0, 64)) * 16
  }
  h = 0x811c9dc5
  addAll(hilbertOrder(xs, ys, xs.length, 2048, 1024))
  line('hilbert_order')
}

// The density rule over random inputs, NaN and the edges among them.
state = 2
h = 0x811c9dc5
for (let i = 0; i < 20000; i++) {
  const slope = i % 97 === 0 ? NaN : uniform(-0.01, 0.3)
  const q = i % 89 === 0 ? 0 : uniform(-10, 20000)
  const k = uniform(-1e-3, 1e-3)
  const column = uniform(0, 100)
  const height = uniform(-1000, 3000)
  add(targetSpacingM(slope, q, k, column, height, i % 2 === 0 ? 1 : 0.25))
}
line('target_spacing')

// The lattices.
h = 0x811c9dc5
meshHash(hexLattice(torusDomain(2048, 1024), 40))
line('hex_lattice')
h = 0x811c9dc5
meshHash(geodesicLattice(sphereDomain(2048, 1024), 30))
line('geodesic_lattice')
h = 0x811c9dc5
meshHash(centroidalGeodesicLattice(sphereDomain(2048, 1024), 60))
line('centroidal_lattice')

// Build, rebuild from moved points, remesh with three kinds of field.
const BUDGET = 16
for (const [name, domain] of [['torus', torusDomain(2048, 1024)], ['sphere', sphereDomain(2048, 1024)]]) {
  const built = buildMesh(domain, sampler, { seed: 7, budget: BUDGET })
  h = 0x811c9dc5
  meshHash(built.mesh)
  stateHash(built.mesh, built.state)
  statsHash(built.stats)
  line(`${name}_build`)

  state = 3
  const m0 = built.mesh
  const xs = []
  const ys = []
  for (let v = 0; v < m0.vertexSlots; v++) {
    if (!m0.vAlive[v]) continue
    xs.push(m0.vx[v] + uniform(-0.6, 0.6))
    ys.push(m0.vy[v] + uniform(-0.6, 0.6))
  }
  const spacing = (MESH_TUNING.oceanSpacingM * BUDGET) / domain.metresPerUnit
  const { mesh, mapping } = triangulatePoints(domain, xs, ys, xs.length, spacing)
  h = 0x811c9dc5
  meshHash(mesh)
  addAll(mapping)
  line(`${name}_triangulate`)

  const s = new MeshState(mesh.vertexSlots)
  s.add(MESH_Z, 'intensive')
  s.add(MESH_DISCHARGE, 'intensive')
  s.add('sediment', 'extensive')
  s.add(MESH_COLUMN, 'extensive', COLUMN_DEPTH)
  const fill = (v, x, y) => {
    s.get(MESH_Z)[v] = heightAt(x, y) * 1.4
    s.get(MESH_DISCHARGE)[v] = dischargeAt(x, y)
    s.get('sediment')[v] = 10 + 5 * detCos(x * 0.03)
    const c = s.get(MESH_COLUMN)
    c[v * COLUMN_DEPTH] = 40 * (1 + detSin(x * 0.02 + y * 0.01))
    c[v * COLUMN_DEPTH + 7] = 12 * (1 + detCos(y * 0.05))
  }
  for (let v = 0; v < mesh.vertexSlots; v++) if (mesh.vAlive[v]) fill(v, mesh.vx[v], mesh.vy[v])
  const stats = remesh(mesh, s, densityTarget(s, BUDGET / 2), {
    seed: 11,
    sample: (v, x, y) => {
      s.get(MESH_Z)[v] = heightAt(x, y) * 1.4
    },
  })
  h = 0x811c9dc5
  meshHash(mesh)
  stateHash(mesh, s)
  statsHash(stats)
  line(`${name}_remesh`)
  const errors = mesh.validate()
  if (errors.length > 0) throw new Error(`${name}: invalid after the remesh: ${errors.slice(0, 3).join('; ')}`)
}

const text = lines.join('\n') + '\n'
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('engine/crates/casas-engine/tests/fixtures/mesh.txt is stale — run node engine/scripts/meshFixture.mjs')
    process.exit(1)
  }
} else {
  writeFileSync(OUT, text)
  console.log(text)
}
