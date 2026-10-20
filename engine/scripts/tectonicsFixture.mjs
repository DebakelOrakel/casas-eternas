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
const OA = await L('/src/generator/tectonics/oceanAge.ts')
const FX = await L('/src/generator/tectonics/flexure.ts')
const PL = await L('/src/generator/tectonics/plumes.ts')
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

// The ocean age, the flexure and the plumes, on the shared mesh.
for (const [name, d, seed] of [['torus', D.torusDomain(2048, 1024), 21], ['sphere', D.sphereDomain(2048, 1024), 22]]) {
  state = seed
  let seeds = []
  for (let i = 0; i < 30; i++) seeds.push({ x: uniform(0, d.width), y: uniform(0, d.height) })
  const motions = PM.generatePlateMotions(seeds, d, mulberry32(seed))
  const rafts = []
  for (let r = 0; r < 20; r++) {
    const cx = uniform(0, d.width)
    const cy = uniform(0, d.height)
    const blobs = []
    for (let b = 0; b < 4; b++) blobs.push({ x: d.wrapX(cx + uniform(-60, 60)), y: Math.min(d.height, Math.max(0, cy + uniform(-40, 40))), radius: uniform(20, 90), birthEpoch: int(0, 100) })
    rafts.push({ id: r, name: null, blobs })
  }
  h = 0x811c9dc5
  let age = OA.createOceanAgeField(TECTONICS_TUNING.oceanAgeInit, d)
  const membership = OA.oceanAgeMembership(rafts, d)
  addAll(membership)
  for (let e = 0; e < 8; e++) {
    const previous = e === 0 ? null : seeds.map((p) => ({ x: p.x, y: p.y }))
    seeds = seeds.map((p, k) => PM.advancePointByMotion(p.x, p.y, motions[k], 1, d))
    age = OA.advectOceanAge(age, seeds, motions, 1, d, membership, previous)
    addAll(age)
  }
  for (let k = 0; k < 5; k++) OA.resetOceanAgeAround(age, uniform(0, d.width), uniform(0, d.height), uniform(5, 60), d)
  addAll(age)
  for (let k = 0; k < 2000; k++) add(OA.oceanAgeAt(age, d, uniform(0, d.width), uniform(0, d.height)))
  addAll(OA.oceanAgeRaster(age, d, 256, 128))
  const saved = OA.savedOceanAge(age, d)
  add(saved.cells)
  add(saved.spacingM)
  add(OA.oceanAgeFits(d, saved.cells, saved.spacingM) ? 1 : 0)
  line(`${name}_ocean_age`)

  h = 0x811c9dc5
  const shared = FX.flexureMesh(d)
  const fm = shared.mesh
  for (let k = 0; k < 500; k++) {
    add(FX.elasticThicknessKm(k % 2 === 0, uniform(-0.5, 1.5), uniform(-10, 200)))
    const te = uniform(3, 80)
    add(FX.flexuralRigidityM4(te))
    add(FX.flexuralAlphaKm(te))
  }
  const spread = FX.nodeLoadSpreader(shared.sampler)
  const loadM3 = new Float64Array(fm.count)
  for (let k = 0; k < 3000; k++) {
    const area = k % 4 === 0 ? uniform(1e10, 6e10) : uniform(1e7, 2e9)
    spread(uniform(0, d.width), uniform(0, d.height), area, uniform(-3, 3) * area, loadM3)
  }
  addAll(loadM3)
  const loadM = new Float64Array(fm.count)
  const rigidity = new Float64Array(fm.count)
  for (let i = 0; i < fm.count; i++) {
    loadM[i] = loadM3[i] / fm.area[i]
    rigidity[i] = FX.flexuralRigidityM4(FX.elasticThicknessKm(age[i] === 0, 0.5, age[i]))
  }
  const deflection = new Float64Array(fm.count)
  const r = FX.flexuralResponse(fm, loadM, rigidity, deflection)
  add(r.iterations)
  add(r.residual)
  add(r.converged ? 1 : 0)
  addAll(deflection)
  add(fm.tri.lastTri)
  add(fm.tri.walkSteps)
  line(`${name}_flexure`)

  h = 0x811c9dc5
  let field = M.createMantleField(mulberry32(seed + 100), d)
  for (let e = 0; e < 4; e++) field = M.evolveMantleField(field, rafts, d)
  M.sustainMantleVigour(field, 0.6, d)
  const plumes = PL.findPlumeSites(field, d, 0)
  for (let e = 1; e <= 12; e++) {
    field = M.evolveMantleField(field, rafts, d)
    M.sustainMantleVigour(field, 0.6, d)
    PL.advancePlumes(plumes, field, d, e)
    add(plumes.length)
    for (const p of plumes) {
      add(p.x)
      add(p.y)
      add(p.id)
      add(p.birthEpoch)
    }
  }
  line(`${name}_plumes`)
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
