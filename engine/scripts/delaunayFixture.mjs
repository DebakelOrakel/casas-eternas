// Writes the module test fixture for the engine's periodic Delaunay
// triangulation: hashes of what the TypeScript engine's
// mesh/periodicDelaunay.ts makes in fixed scenarios, which the Rust port
// must make bit for bit (docs/decisions/rust-engine.md, fork 5).
//
//   node engine/scripts/delaunayFixture.mjs           write the fixture
//   node engine/scripts/delaunayFixture.mjs --check   fail if it is stale
//
// A scenario, on the torus and on the sphere: a jittered bootstrap lattice,
// inserts, removals, duplicates and edge midpoints, inserts again, a clone,
// point queries, the Voronoi areas. After each step a hash of the whole
// state. crates/casas-engine/tests/periodic_delaunay.rs runs the same
// scenario, step for step, from the same generator: change one, change the
// other.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('../../client', import.meta.url))
const OUT = new URL('../crates/casas-engine/tests/fixtures/periodic_delaunay.txt', import.meta.url)

const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const { PeriodicTriangulation, buildFromTriangles } = await server.ssrLoadModule('/src/generator/mesh/periodicDelaunay.ts')
const { torusDomain, sphereDomain } = await server.ssrLoadModule('/src/generator/core/domain.ts')
await server.close()

// The generator: a 32-bit LCG, as in detMathFixture.mjs.
let state = 0
const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0)
const uniform = (lo, hi) => lo + (hi - lo) * (next() / 4294967296)
const index = (n) => Math.floor(uniform(0, n))

// The hash: FNV-1a over the two words of each value as a double, a NaN as
// the canonical one.
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
function stateHash(m) {
  h = 0x811c9dc5
  add(m.vertexSlots)
  add(m.aliveVertices)
  add(m.triSlots)
  add(m.aliveTriangles)
  addAll(m.vx.subarray(0, m.vertexSlots))
  addAll(m.vy.subarray(0, m.vertexSlots))
  addAll(m.vEdge.subarray(0, m.vertexSlots))
  addAll(m.vAlive.subarray(0, m.vertexSlots))
  if (m.globe) addAll(m.vu.subarray(0, 3 * m.vertexSlots))
  addAll(m.tris.subarray(0, 3 * m.triSlots))
  addAll(m.twin.subarray(0, 3 * m.triSlots))
  addAll(m.tAlive.subarray(0, m.triSlots))
  add(m.lastTri)
  add(m.walkSteps)
  add(m.flips)
  add(m.walkFallbacks)
  return h.toString(16).padStart(8, '0')
}

// The bootstrap: on the torus a lattice of nx × ny jittered points, odd rows
// shifted half a cell, two triangles per cell; on the sphere the octahedron.
function bootstrap(domain) {
  const xs = []
  const ys = []
  const tris = []
  if (domain.kind === 'sphere') {
    const W = domain.width
    const H = domain.height
    xs.push(0, 0, 0, W / 4, W / 2, (3 * W) / 4)
    ys.push(0, H, H / 2, H / 2, H / 2, H / 2)
    for (let k = 0; k < 4; k++) {
      const a = 2 + k
      const b = 2 + ((k + 1) % 4)
      tris.push(0, a, b, 1, b, a)
    }
    return buildFromTriangles(domain, xs, ys, xs.length, tris)
  }
  const nx = 16
  const ny = 8
  const cw = domain.width / nx
  const ch = domain.height / ny
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      xs.push((i + 0.5 * (j % 2) + uniform(-0.2, 0.2)) * cw)
      ys.push((j + uniform(-0.2, 0.2)) * ch)
    }
  }
  const id = (i, j) => (((j % ny) + ny) % ny) * nx + (((i % nx) + nx) % nx)
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      tris.push(id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j), id(i + 1, j + 1), id(i, j + 1))
    }
  }
  const m = buildFromTriangles(domain, xs, ys, xs.length, tris)
  m.legaliseAll()
  return m
}

function scenario(name, domain, seed) {
  state = seed
  const lines = []
  const step = (label, extra = '') => lines.push(`${name} ${label} ${stateHash(m)}${extra}`)
  const W = domain.width
  const H = domain.height
  let m = bootstrap(domain)
  step('bootstrap')
  for (let i = 0; i < 20000; i++) m.insert(uniform(0, W), uniform(0, H))
  // Near the poles too, where the sphere's chart crowds.
  for (let i = 0; i < 1000; i++) m.insert(uniform(0, W), uniform(0, H / 200))
  step('insert')
  let removed = 0
  for (let i = 0; i < 6000; i++) if (m.remove(index(m.vertexSlots))) removed++
  step('remove', ` ${removed}`)
  // Duplicates of live vertices (at a vertex) and halfedge midpoints (on an
  // edge).
  for (let i = 0; i < 500; i++) {
    const v = index(m.vertexSlots)
    if (m.vAlive[v]) m.insert(m.vx[v], m.vy[v])
  }
  const fr = new Float64Array(6)
  for (let i = 0; i < 500; i++) {
    const t = index(m.triSlots)
    if (!m.tAlive[t]) continue
    m.frame(t, fr)
    m.insert((fr[0] + fr[2]) / 2, (fr[1] + fr[3]) / 2)
  }
  step('special')
  for (let i = 0; i < 6000; i++) m.insert(uniform(-W / 2, 1.5 * W), uniform(-H / 2, 1.5 * H))
  step('reinsert')
  const copy = m.clone()
  for (let i = 0; i < 2000; i++) copy.insert(uniform(0, W), uniform(0, H))
  for (let i = 0; i < 500; i++) copy.remove(index(copy.vertexSlots))
  lines.push(`${name} clone ${stateHash(copy)}`)
  // Queries: the located triangle, where on it, the weights.
  h = 0x811c9dc5
  const bw = new Float64Array(3)
  for (let i = 0; i < 5000; i++) {
    const x = uniform(0, W)
    const y = uniform(0, H)
    const t = m.locate(x, y, index(m.triSlots))
    m.barycentric(t, x, y, bw)
    add(t)
    add(m.onEdge)
    add(m.atVertex)
    addAll(bw)
  }
  lines.push(`${name} query ${h.toString(16).padStart(8, '0')}`)
  h = 0x811c9dc5
  for (let v = 0; v < m.vertexSlots; v++) if (m.vAlive[v]) add(m.voronoiArea(v))
  lines.push(`${name} area ${h.toString(16).padStart(8, '0')}`)
  const errors = m.validate()
  if (errors.length > 0) throw new Error(`${name}: the TypeScript triangulation is invalid: ${errors.slice(0, 3).join('; ')}`)
  return lines
}

const lines = [
  '# Hashes of client/src/generator/mesh/periodicDelaunay.ts, for crates/casas-engine/tests/periodic_delaunay.rs.',
  '# Written by engine/scripts/delaunayFixture.mjs; do not edit.',
  ...scenario('torus', torusDomain(2048, 1024), 1),
  ...scenario('sphere', sphereDomain(2048, 1024), 2),
]
const text = lines.join('\n') + '\n'
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('engine/crates/casas-engine/tests/fixtures/periodic_delaunay.txt is stale — run node engine/scripts/delaunayFixture.mjs')
    process.exit(1)
  }
} else {
  writeFileSync(OUT, text)
  console.log(text)
}
