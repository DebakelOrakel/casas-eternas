// Writes the module test fixture for the engine's raft field and mantle:
// hashes of what the TypeScript engine's crust/raftField.ts and
// mantle/mantleField.ts make in fixed scenarios on both shapes, which the
// Rust port must make bit for bit (docs/decisions/rust-engine.md, fork 5).
//
//   node engine/scripts/mantleFixture.mjs           write the fixture
//   node engine/scripts/mantleFixture.mjs --check   fail if it is stale
//
// crates/casas-engine/tests/mantle.rs runs the same scenarios from the same
// generator: change one, change the other.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('../../client', import.meta.url))
const OUT = new URL('../crates/casas-engine/tests/fixtures/mantle.txt', import.meta.url)

const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
const D = await L('/src/generator/core/domain.ts')
const { mulberry32 } = await L('/src/generator/core/rng.ts')
const RF = await L('/src/generator/crust/raftField.ts')
const M = await L('/src/generator/mantle/mantleField.ts')
await server.close()

let state = 0
const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0)
const uniform = (lo, hi) => lo + (hi - lo) * (next() / 4294967296)
const int = (lo, hi) => Math.floor(uniform(lo, hi))

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
const lines = [
  '# Hashes of client/src/generator/crust/raftField.ts and mantle/mantleField.ts, for crates/casas-engine/tests/mantle.rs.',
  '# Written by engine/scripts/mantleFixture.mjs; do not edit.',
]
const line = (name) => lines.push(`${name} ${h.toString(16).padStart(8, '0')}`)

// Rafts: 30 of 3–8 blobs each, some without a birth epoch.
function makeRafts(d) {
  const rafts = []
  for (let r = 0; r < 30; r++) {
    const cx = uniform(0, d.width)
    const cy = uniform(0, d.height)
    const blobs = []
    const n = int(3, 9)
    for (let b = 0; b < n; b++) {
      const blob = { x: d.wrapX(cx + uniform(-80, 80)), y: Math.min(d.height, Math.max(0, cy + uniform(-60, 60))), radius: uniform(20, 120) }
      if (b % 3 !== 0) blob.birthEpoch = int(0, 200)
      blobs.push(blob)
    }
    rafts.push({ id: r, name: null, blobs })
  }
  return rafts
}

for (const [name, d, seed] of [['torus', D.torusDomain(2048, 1024), 1], ['sphere', D.sphereDomain(2048, 1024), 2]]) {
  state = seed
  const rafts = makeRafts(d)
  h = 0x811c9dc5
  const index = RF.buildBlobIndex(rafts, d)
  const near = RF.buildBlobIndex(rafts, d, 2)
  const perRaft = new Float64Array(rafts.length)
  for (let k = 0; k < 20000; k++) {
    const special = k % 997 === 0
    const x = special ? (k % 2 ? Infinity : NaN) : uniform(-100, d.width + 100)
    const y = special ? 3 : uniform(0, d.height)
    add(RF.raftField(x, y, rafts, d))
    add(RF.raftFieldIndexed(x, y, index))
    add(RF.nearestRaftIndexed(x, y, near, 2))
    add(RF.raftMembership(x, y, rafts, d))
    if (!special) {
      add(RF.raftFieldsIndexed(x, y, index, perRaft))
      addAll(perRaft)
    }
  }
  const xs = new Float64Array(5000)
  const ys = new Float64Array(5000)
  for (let i = 0; i < xs.length; i++) {
    xs[i] = uniform(0, d.width)
    ys[i] = uniform(0, d.height)
  }
  addAll(RF.computeMembershipAt(rafts, xs, ys, d))
  addAll(RF.computeCratonOldnessField(rafts, 120, 80, 256, 128, d))
  addAll(RF.computeCratonOldnessField(rafts, 0, 0, 64, 32, d))
  addAll(RF.computeOwnerField(rafts, 256, 128, d))
  const seeds = []
  for (let i = 0; i < 200; i++) seeds.push({ x: uniform(0, d.width), y: uniform(0, d.height) })
  for (const t of RF.derivePlateTypes(seeds, rafts, d)) add(t === 'continental' ? 1 : 0)
  add(RF.stabilisedFraction(rafts, 150, 60))
  add(RF.stabilisedFraction([], 150, 60))
  line(`${name}_raft_field`)

  h = 0x811c9dc5
  const mm = M.mantleMesh(d)
  add(mm.cellM)
  add(mm.cellUnits)
  add(mm.totalArea)
  add(mm.stableStep)
  add(mm.mesh.count)
  let field = M.createMantleField(mulberry32(seed * 7), d)
  addAll(field)
  for (let e = 0; e < 10; e++) {
    field = M.evolveMantleField(field, rafts, d, e % 2 === 0 ? 1 : 1.7)
    addAll(field)
  }
  M.sustainMantleVigour(field, 0.4, d)
  addAll(field)
  M.coolMantleAt(field, uniform(0, d.width), uniform(0, d.height), d, 300, 0.8)
  addAll(field)
  const flow = M.computeMantleFlow(field, d)
  addAll(flow.east)
  addAll(flow.south)
  const v = { x: 0, y: 0 }
  for (let k = 0; k < 2000; k++) {
    const x = uniform(0, d.width)
    const y = uniform(0, d.height)
    add(M.mantleAt(field, d, x, y))
    M.mantleFlowAt(flow, d, x, y, v)
    add(v.x)
    add(v.y)
  }
  addAll(M.rasteriseMantle(field, d))
  const saved = M.savedMantle(field, d)
  add(saved.cells)
  add(saved.spacingM)
  add(M.mantleFits(d, saved.cells, saved.spacingM) ? 1 : 0)
  add(M.mantleFits(d, saved.cells + 1, saved.spacingM) ? 1 : 0)
  add(mm.mesh.tri.lastTri)
  add(mm.mesh.tri.walkSteps)
  line(`${name}_mantle`)
}

const text = lines.join('\n') + '\n'
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('engine/crates/casas-engine/tests/fixtures/mantle.txt is stale — run node engine/scripts/mantleFixture.mjs')
    process.exit(1)
  }
} else {
  writeFileSync(OUT, text)
  console.log(text)
}
