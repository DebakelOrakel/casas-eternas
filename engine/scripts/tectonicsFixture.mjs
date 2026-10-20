// Writes the module test fixture for the engine's tectonics: hashes of what
// the TypeScript engine's tectonics/ makes in fixed scenarios on both
// shapes, which the Rust port must make bit for bit
// (docs/decisions/rust-engine.md, fork 5).
//
//   node engine/scripts/tectonicsFixture.mjs           write the fixture
//   node engine/scripts/tectonicsFixture.mjs --check   fail if it is stale
//
// crates/casas-engine/tests/tectonics.rs runs the same scenarios from the
// same generator: change one, change the other.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('../../client', import.meta.url))
const OUT = new URL('../crates/casas-engine/tests/fixtures/tectonics.txt', import.meta.url)

const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
const D = await L('/src/generator/core/domain.ts')
const { mulberry32 } = await L('/src/generator/core/rng.ts')
const M = await L('/src/generator/mantle/mantleField.ts')
const PM = await L('/src/generator/tectonics/plateMotion.ts')
const PV = await L('/src/generator/tectonics/plateVelocityDecomposition.ts')
const BL = await L('/src/generator/tectonics/boundaryLattice.ts')
const BD = await L('/src/generator/tectonics/boundaryDetection.ts')
const BC = await L('/src/generator/tectonics/boundaryClassification.ts')
const TF = await L('/src/generator/tectonics/terrainFeatures.ts')
const V = await L('/src/generator/tectonics/volcanoes.ts')
const { TECTONICS_TUNING } = await L('/src/generator/tectonics/tectonicsTuneParams.ts')
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
const addMotion = (m) => {
  if ('rate' in m) {
    add(m.poleX)
    add(m.poleY)
    add(m.poleZ)
    add(m.rate)
  } else {
    add(m.driftX)
    add(m.driftY)
    add(m.spin)
    add(m.centroidX)
    add(m.centroidY)
  }
}
const CLASSES = ['convergent', 'divergent', 'transform']
const CHARACTERS = ['foldMountains', 'subductionArc', 'islandArc', 'riftValley', 'midOceanRidge', 'transformFault']
const SIDES = ['a', 'b', 'both']
const KINDS = ['hotspot', 'flood', 'arc']
const addFeature = (t) => {
  for (const v of [t.x, t.y, t.thickness, t.tangentX, t.tangentY, t.kind === 'trench' ? 1 : 0, t.plateA, t.plateB, t.movesWithPlate === 'both' ? -1 : t.movesWithPlate, t.subsides ? 1 : 0, t.epochsSinceDeposit]) add(v)
}
const lines = [
  '# Hashes of client/src/generator/tectonics/, for crates/casas-engine/tests/tectonics.rs.',
  '# Written by engine/scripts/tectonicsFixture.mjs; do not edit.',
]
const line = (name) => lines.push(`${name} ${h.toString(16).padStart(8, '0')}`)

h = 0x811c9dc5
for (const v of Object.values(TECTONICS_TUNING)) add(v)
line('tuning')

for (const [name, d, seed] of [['torus', D.torusDomain(2048, 1024), 1], ['sphere', D.sphereDomain(2048, 1024), 2]]) {
  state = seed
  const seeds = []
  for (let i = 0; i < 30; i++) seeds.push({ x: uniform(0, d.width), y: uniform(0, d.height) })
  const motions = PM.generatePlateMotions(seeds, d, mulberry32(seed * 11))
  h = 0x811c9dc5
  for (const m of motions) addMotion(m)
  for (let k = 0; k < 3000; k++) {
    const p = { x: uniform(0, d.width), y: uniform(0, d.height) }
    const m = motions[int(0, motions.length)]
    const v = PM.getVelocityAt(p, m, d)
    add(v.vx)
    add(v.vy)
    const step = uniform(0.5, 5)
    const a = PM.advancePointByMotion(p.x, p.y, m, step, d)
    add(a.x)
    add(a.y)
    const b = PM.reversePointByMotion(a.x, a.y, m, step, d)
    add(b.x)
    add(b.y)
    addMotion(PM.motionMovingAt(p.x, p.y, uniform(-3, 3), uniform(-3, 3), d))
    if (d.kind === 'sphere') add(PM.arcToEulerPole(p.x, p.y, m, d))
    add(PM.kmPerMyr(v.vx, d))
  }
  const field = M.createMantleField(mulberry32(seed * 13), d)
  const flow = M.computeMantleFlow(field, d)
  const fit = PM.fitMotionsToFlow(seeds, flow, d)
  for (const m of fit) addMotion(m)
  for (let p = 0; p < motions.length; p++) {
    PM.relaxMotionToward(motions[p], fit[p], 0.15)
    addMotion(motions[p])
  }
  line(`${name}_motion`)

  h = 0x811c9dc5
  const lattice = BL.generateDetectionLattice(d, 256, 128)
  add(lattice.length)
  for (const p of lattice) {
    add(p.x)
    add(p.y)
  }
  const boundaries = BD.detectBoundaries(lattice, seeds, d)
  const types = seeds.map(() => (next() & 1 ? 'continental' : 'oceanic'))
  const ages = seeds.map(() => uniform(0, 100))
  for (const b of boundaries) {
    for (const v of [b.latticeIndex, b.x, b.y, b.plateA, b.plateB]) add(v)
    const c = PV.classifyBoundaryMotion(b, seeds[b.plateA], motions[b.plateA], seeds[b.plateB], motions[b.plateB], d)
    add(c.normal)
    add(c.tangential)
    add(CLASSES.indexOf(c.motionClass))
    const k = BC.classifyBoundary(types[b.plateA], ages[b.plateA], types[b.plateB], ages[b.plateB], c.motionClass)
    add(CHARACTERS.indexOf(k.character))
    add(SIDES.indexOf(k.upliftSide))
    add(k.rate)
    add(k.elevationSign)
  }
  line(`${name}_boundaries`)

  h = 0x811c9dc5
  const features = []
  for (let k = 0; k < boundaries.length; k += 3) {
    const b = boundaries[k]
    const moves = k % 2 === 0 ? 'both' : (next() & 1 ? b.plateA : b.plateB)
    const i = TF.findOrCreateFeatureIndex(features, b.x, b.y, b.plateA, b.plateB, moves, uniform(-1, 1), uniform(-1, 1), k % 5 === 0 ? 'trench' : 'range', k % 7 === 0, d)
    add(i)
  }
  for (const t of features) {
    t.thickness = uniform(-10, 20)
    t.epochsSinceDeposit = int(0, 12)
    if (next() & 1) t.volcanic = true
  }
  for (let e = 0; e < 5; e++) TF.advanceTerrainFeatures(features, motions, 1, d)
  for (const t of features) addFeature(t)
  features.push({ x: 10, y: 20, thickness: 5, tangentX: 1, tangentY: 0, kind: 'range', subsides: false, plateA: 3, plateB: -1, movesWithPlate: 3, epochsSinceDeposit: 0 })
  features.push({ x: 30, y: 40, thickness: -7, tangentX: 1, tangentY: 0, kind: 'range', subsides: false, plateA: 3, plateB: -2, movesWithPlate: 3, epochsSinceDeposit: 0 })
  for (const v of V.collectVolcanoes(features)) {
    add(v.x)
    add(v.y)
    add(v.thickness)
    add(KINDS.indexOf(v.kind))
  }
  line(`${name}_features`)
}

const text = lines.join('\n') + '\n'
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('engine/crates/casas-engine/tests/fixtures/tectonics.txt is stale — run node engine/scripts/tectonicsFixture.mjs')
    process.exit(1)
  }
} else {
  writeFileSync(OUT, text)
  console.log(text)
}
