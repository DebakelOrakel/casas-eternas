// Writes the module test fixture for the engine's level refinement: hashes
// of what the TypeScript engine's mesh/meshSampler.ts, surface/amplify.ts
// and mesh/meshRefine.ts make of a built mesh, which the Rust port must
// make bit for bit (docs/decisions/rust-engine.md, fork 5).
//
//   node engine/scripts/levelFixture.mjs           write the fixture
//   node engine/scripts/levelFixture.mjs --check   fail if it is stale
//
// crates/casas-engine/tests/level.rs runs the same scenarios: change one,
// change the other.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('../../client', import.meta.url))
const OUT = new URL('../crates/casas-engine/tests/fixtures/level.txt', import.meta.url)

const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
const { torusDomain, sphereDomain } = await L('/src/generator/core/domain.ts')
const { detSin, detCos } = await L('/src/generator/core/detMath.ts')
const { buildMesh, MESH_Z } = await L('/src/generator/mesh/meshBuild.ts')
const MS = await L('/src/generator/mesh/meshSampler.ts')
const A = await L('/src/generator/surface/amplify.ts')
const MR = await L('/src/generator/mesh/meshRefine.ts')
const { compactMesh, permute } = await L('/src/generator/mesh/meshSerial.ts')
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
const addAll = (a) => {
  for (let i = 0; i < a.length; i++) add(a[i])
}
const hex = () => h.toString(16).padStart(8, '0')
const lines = [
  '# Hashes of client/src/generator/mesh/meshSampler.ts, surface/amplify.ts and mesh/meshRefine.ts, for crates/casas-engine/tests/level.rs.',
  '# Written by engine/scripts/levelFixture.mjs; do not edit.',
]
const line = (name) => lines.push(`${name} ${hex()}`)

// The amplification's functions.
state = 1
h = 0x811c9dc5
for (const [k, v] of Object.entries(A.AMPLIFY_CONSTANTS)) { for (let i = 0; i < k.length; i++) add(k.charCodeAt(i)); add(v) }
for (const r of [256, 1024, 2048, 4096, 8192, 65536]) addAll(A.seedCascadeScales(r))
for (let i = 0; i < 400; i++) add(A.seedRoughnessAmplitude(uniform(-0.1, 0.3)))
const sphere = sphereDomain(2048, 1024)
for (let i = 0; i < 4000; i++) {
  const x = uniform(0, 2048)
  const y = uniform(0, 1024)
  add(A.ridgedAt(x, y, 2048, 1024, (i * 7919) >>> 0))
  add(A.ridgedAtOn(sphere, x, y, (i * 104729) >>> 0))
}
line('amplify')

const heightAt = (x, y) => 0.09 * detSin(x * 0.006) * detCos(y * 0.008) + 0.05 * detSin(x * 0.019 + y * 0.011) + 0.03 * detCos(x * 0.043 - y * 0.027) - 0.02
const sampler = { heightAt }
for (const [name, domain] of [['torus', torusDomain(2048, 1024)], ['sphere', sphere]]) {
  const { mesh, state: s } = buildMesh(domain, sampler, { seed: 7, budget: 4 })
  const z = s.get(MESH_Z).slice(0, mesh.vertexSlots)
  // The sampler, plain and over a dense region.
  state = 2
  h = 0x811c9dc5
  for (const dense of [undefined, { x: 1900, y: 300, width: 300, height: 200, nodes: 40000 }]) {
    const ms = MS.createMeshSampler(mesh, z, dense)
    const n = new Float64Array(3)
    for (let i = 0; i < 3000; i++) {
      const x = uniform(-10, 2058)
      const y = uniform(0, 1024)
      add(ms.triangleAt(x, y))
      add(ms.heightAt(x, y))
      add(ms.sampleAt(z, x, y))
      add(ms.nearestNodeAt(x, y))
      ms.normalAt(x, y, n)
      addAll(n)
    }
  }
  // The walk's length too: the hint grids change nothing but the walk.
  add(mesh.lastTri)
  add(mesh.walkSteps)
  line(`${name}_sampler`)

  // The level synthesis, both forms.
  state = 3
  h = 0x811c9dc5
  for (const sph of [undefined, domain.kind === 'sphere' ? domain : undefined]) {
    const synth = MR.levelSynthesis({ seed: 4242, level: 1, budget: 1, width: 2048, height: 1024, sphere: sph }, (x, y) => 0.02 + 0.01 * detSin(x * 0.01 + y))
    for (let i = 0; i < 3000; i++) add(synth(uniform(0, 2048), uniform(0, 1024), uniform(-0.05, 0.2)))
  }
  add(MR.levelSeed({ seed: 4242, level: 2 }))
  line(`${name}_synthesis`)
}

// One rung, budget 4 to 2, on a torus. The parent is compacted first, as
// a level bake's is (it comes from the save): refineMeshLevel copies the
// parent through the codec in slot order, which needs no dead slots.
{
  const domain = torusDomain(1024, 512)
  const built = buildMesh(domain, sampler, { seed: 7, budget: 4 })
  const { mesh, order } = compactMesh(built.mesh)
  const z = permute(built.state.get(MESH_Z), order)
  const r = MR.refineMeshLevel(mesh, z, { budget: 2, seed: 4242, level: 1, width: 1024, height: 512 })
  h = 0x811c9dc5
  add(r.inserted)
  const m = r.mesh
  addAll(m.vx.subarray(0, m.vertexSlots))
  addAll(m.vy.subarray(0, m.vertexSlots))
  addAll(m.tris.subarray(0, 3 * m.triSlots))
  addAll(r.z)
  addAll(r.parent)
  line('refine')
}

const text = lines.join('\n') + '\n'
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('engine/crates/casas-engine/tests/fixtures/level.txt is stale — run node engine/scripts/levelFixture.mjs')
    process.exit(1)
  }
} else {
  writeFileSync(OUT, text)
  console.log(`level fixture: ${lines.length - 2} lines`)
}
