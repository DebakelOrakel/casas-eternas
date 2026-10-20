// Writes the module test fixture for the engine's field mesh: hashes of
// what the TypeScript engine's fields/ (fieldMesh, fieldOperators) makes in
// fixed scenarios on both shapes, which the Rust port must make bit for bit
// (docs/decisions/rust-engine.md, fork 5).
//
//   node engine/scripts/fieldsFixture.mjs           write the fixture
//   node engine/scripts/fieldsFixture.mjs --check   fail if it is stale
//
// crates/casas-engine/tests/fields.rs runs the same scenarios from the same
// generator and the same analytic fields: change one, change the other.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('../../client', import.meta.url))
const OUT = new URL('../crates/casas-engine/tests/fixtures/fields.txt', import.meta.url)

const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
const { torusDomain, sphereDomain } = await L('/src/generator/core/domain.ts')
const { detSin, detCos } = await L('/src/generator/core/detMath.ts')
const FM = await L('/src/generator/fields/fieldMesh.ts')
const OP = await L('/src/generator/fields/fieldOperators.ts')
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
const report = (r) => {
  add(r.iterations)
  add(r.residual)
  add(r.converged ? 1 : 0)
  add(r.removedMean)
}
const lines = [
  '# Hashes of client/src/generator/fields/, for crates/casas-engine/tests/fields.rs.',
  '# Written by engine/scripts/fieldsFixture.mjs; do not edit.',
]
const line = (name) => lines.push(`${name} ${h.toString(16).padStart(8, '0')}`)

const SPACING_M = 150000
for (const [name, domain, seed] of [['torus', torusDomain(2048, 1024), 1], ['sphere', sphereDomain(2048, 1024), 2]]) {
  state = seed
  const fm = FM.createFieldMesh(domain, SPACING_M)
  h = 0x811c9dc5
  for (const a of [fm.x, fm.y, fm.u, fm.east, fm.south, fm.area, fm.nbrStart, fm.nbr, fm.rev, fm.wall, fm.dist, fm.coupling, fm.offE, fm.offS, fm.turnC, fm.turnS, fm.gradE, fm.gradS]) addAll(a)
  add(fm.count)
  add(fm.pentagons)
  add(fm.maxDegree)
  add(fm.radiusM)
  line(`${name}_mesh`)

  const n = fm.count
  const phi = new Float64Array(n)
  const ve = new Float64Array(n)
  const vs = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    phi[i] = detSin(fm.x[i] * 0.01) * detCos(fm.y[i] * 0.02) * 100
    ve[i] = 10 * detCos(fm.y[i] * 0.006)
    vs[i] = 3 * detSin(fm.x[i] * 0.004)
  }
  const sampler = FM.createFieldSampler(fm)
  h = 0x811c9dc5
  const corners = new Int32Array(3)
  const weights = new Float64Array(3)
  const v = { x: 0, y: 0 }
  for (let k = 0; k < 5000; k++) {
    const x = uniform(-10, domain.width + 10)
    const y = uniform(0, domain.height)
    add(sampler.taps(x, y, corners, weights))
    addAll(corners)
    addAll(weights)
    add(sampler.sample(phi, x, y))
    const to = k % 3 === 0 ? -1 : Math.floor(uniform(0, n))
    sampler.sampleVector(ve, vs, x, y, to, v)
    add(v.x)
    add(v.y)
    add(sampler.nearestCell(x, y))
  }
  addAll(FM.rasteriseField(fm, phi, 128, 64))
  addAll(FM.rasteriseVectorField(sampler, ve, vs, 64, 32))
  addAll(FM.rasterOwners(sampler, 64, 32))
  add(fm.tri.lastTri)
  add(fm.tri.walkSteps)
  line(`${name}_sampler`)

  h = 0x811c9dc5
  const out = new Float64Array(n)
  const out2 = new Float64Array(n)
  addAll(OP.laplacian(fm, phi, out))
  const dt = OP.stableDiffusionStep(fm, 2000)
  add(dt)
  addAll(OP.diffuseExplicit(fm, phi, 2000, dt, out))
  const implicit = Float64Array.from(phi)
  report(OP.diffuseImplicit(fm, implicit, 2000, dt * 40, implicit))
  addAll(implicit)
  addAll(OP.smoothGaussian(fm, phi, 400000, out))
  OP.gradient(fm, phi, out, out2)
  addAll(out)
  addAll(out2)
  const within = new Uint8Array(n)
  for (let i = 0; i < n; i++) within[i] = phi[i] > -20 ? 1 : 0
  addAll(OP.divergence(fm, ve, vs, out))
  addAll(OP.divergence(fm, ve, vs, out, within))
  for (let e = 0; e < 40; e++) {
    const p = OP.carryFrom(fm, e, 1.5, -0.5, v)
    void p
    add(v.x)
    add(v.y)
  }
  addAll(OP.eastWallNormals(fm))
  line(`${name}_operators`)

  h = 0x811c9dc5
  const dep = OP.departures(fm)
  OP.computeDepartures(fm, sampler, ve, vs, 3e4 * 86400 / 30, dep, 2)
  for (const a of [dep.x, dep.y, dep.corners, dep.weights, dep.unit, dep.offE, dep.offS]) addAll(a)
  const ge = new Float64Array(n)
  const gs = new Float64Array(n)
  OP.gradient(fm, phi, ge, gs)
  addAll(OP.transportScalar(fm, dep, phi, out))
  addAll(OP.transportScalar(fm, dep, phi, out, ge, gs))
  addAll(OP.transportScalar(fm, dep, phi, out, ge, gs, true))
  OP.transportVector(fm, dep, ve, vs, out, out2)
  addAll(out)
  addAll(out2)
  const px = new Float64Array(n)
  const py = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    px[i] = fm.x[i] + uniform(-3, 3)
    py[i] = Math.min(domain.height, Math.max(0, fm.y[i] + uniform(-3, 3)))
  }
  const dep2 = OP.departures(fm)
  OP.departuresFromPoints(fm, sampler, px, py, dep2)
  for (const a of [dep2.x, dep2.y, dep2.corners, dep2.weights, dep2.unit, dep2.offE, dep2.offS]) addAll(a)
  line(`${name}_transport`)

  h = 0x811c9dc5
  const sol = new Float64Array(n)
  report(OP.solveHelmholtz(fm, 1e-11, phi, sol))
  addAll(sol)
  const sol0 = new Float64Array(n)
  report(OP.solveHelmholtz(fm, 0, phi, sol0, { tolerance: 1e-9 }))
  addAll(sol0)
  // A non-symmetric system on the mesh: the Helmholtz rows plus an east
  // advection term, solved by BiCGSTAB with ILU(0) and with the two-level
  // preconditioner.
  const ew = OP.eastWallNormals(fm)
  const rows = []
  for (let i = 0; i < n; i++) {
    const row = [[i, 1e-11 * fm.area[i]]]
    for (let e = fm.nbrStart[i]; e < fm.nbrStart[i + 1]; e++) {
      row.push([i, fm.coupling[e]])
      row.push([fm.nbr[e], -fm.coupling[e] + 0.3 * ew[e] / fm.dist[e]])
    }
    rows.push(row)
  }
  const m = OP.sparseMatrix(rows)
  addAll(m.start)
  addAll(m.col)
  addAll(m.val)
  const b = new Float64Array(n)
  for (let i = 0; i < n; i++) b[i] = fm.area[i] * phi[i] * 1e-9
  const apply = (x, o) => OP.sparseApply(m, x, o)
  const xa = new Float64Array(n)
  report(OP.solveBiCGSTAB(n, apply, OP.ilu0(m), b, xa, { tolerance: 1e-10 }))
  addAll(xa)
  const agg = OP.aggregate(m, 2)
  addAll(agg.of)
  add(agg.count)
  const xb = new Float64Array(n)
  report(OP.solveBiCGSTAB(n, apply, OP.twoLevelPreconditioner(m, agg), b, xb, { tolerance: 1e-10 }))
  addAll(xb)
  const xc = new Float64Array(n)
  const diag = new Float64Array(n)
  for (let i = 0; i < n; i++) for (let k = m.start[i]; k < m.start[i + 1]; k++) if (m.col[k] === i) diag[i] = m.val[k]
  report(OP.solveBiCGSTAB(n, apply, (r, o) => { for (let i = 0; i < n; i++) o[i] = r[i] / diag[i] }, b, xc, { maxIterations: 30 }))
  addAll(xc)
  line(`${name}_solvers`)
}

const text = lines.join('\n') + '\n'
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('engine/crates/casas-engine/tests/fixtures/fields.txt is stale — run node engine/scripts/fieldsFixture.mjs')
    process.exit(1)
  }
} else {
  writeFileSync(OUT, text)
  console.log(text)
}
