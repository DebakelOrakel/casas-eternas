// Writes the module test fixture for the engine's elevation: hashes of what
// the TypeScript engine's elevation/ (scale, capsule, the noises, the warp,
// the hypsometry, the elevation field) and tectonics/trench.ts and
// folds.ts give for fixed inputs on both shapes, which the Rust port must
// give bit for bit (docs/decisions/rust-engine.md, fork 5).
//
//   node engine/scripts/elevationFixture.mjs           write the fixture
//   node engine/scripts/elevationFixture.mjs --check   fail if it is stale
//
// crates/casas-engine/tests/elevation.rs makes the same calls from the same
// generator: change one, change the other.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('../../client', import.meta.url))
const OUT = new URL('../crates/casas-engine/tests/fixtures/elevation.txt', import.meta.url)

const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
const D = await L('/src/generator/core/domain.ts')
const { mulberry32 } = await L('/src/generator/core/rng.ts')
const ES = await L('/src/generator/elevation/elevationScale.ts')
const { capsuleWeight } = await L('/src/generator/elevation/capsule.ts')
const { ELEVATION_TUNING } = await L('/src/generator/elevation/elevationTuneParams.ts')
const GN = await L('/src/generator/elevation/globeNoise.ts')
const RN = await L('/src/generator/elevation/ridgedNoise.ts')
const DW = await L('/src/generator/elevation/domainWarp.ts')
const HY = await L('/src/generator/elevation/hypsometry.ts')
const EF = await L('/src/generator/elevation/elevationField.ts')
const RF = await L('/src/generator/crust/raftField.ts')
const OA = await L('/src/generator/tectonics/oceanAge.ts')
const PM = await L('/src/generator/tectonics/plateMotion.ts')
const TR = await L('/src/generator/tectonics/trench.ts')
const FO = await L('/src/generator/tectonics/folds.ts')
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
  '# Hashes of client/src/generator/elevation/, tectonics/trench.ts and folds.ts, for crates/casas-engine/tests/elevation.rs.',
  '# Written by engine/scripts/elevationFixture.mjs; do not edit.',
]
const line = (name) => lines.push(`${name} ${h.toString(16).padStart(8, '0')}`)
const SEEDS = [0, 1, 12345, 2147483647, 2147483648, 3000000000, 4294967295]

// The scale, the capsule and the tuning.
state = 1
h = 0x811c9dc5
for (const v of Object.values(ELEVATION_TUNING)) add(v)
for (const v of [ES.LAND_BASE, ES.COASTAL_PLAIN, ES.SHELF_BREAK, ES.SLOPE_FOOT, ES.RIDGE_CREST, ES.ABYSSAL_FLOOR, ES.SHORELINE_FIELD]) add(v)
for (let k = 0; k < 5000; k++) {
  const t = uniform(-0.2, 1.2)
  add(ES.marginProfile(t, uniform(-0.7, -0.2)))
  add(ES.marginParameter(uniform(-0.2, 1.5)))
  add(capsuleWeight(uniform(-50, 50), uniform(-50, 50), uniform(-1, 1), uniform(-1, 1), uniform(5, 40), uniform(5, 40)))
}
line('scale')

// The noises, the warp and the hypsometry on both shapes.
for (const [name, d] of [['torus', D.torusDomain(2048, 1024)], ['sphere', D.sphereDomain(2048, 1024)]]) {
  state = name === 'torus' ? 2 : 3
  h = 0x811c9dc5
  const p = { x: 0, y: 0 }
  const gf = D.globeFrame()
  for (const seed of SEEDS) {
    for (let k = 0; k < 600; k++) {
      const x = uniform(-100, d.width + 100)
      const y = uniform(0, d.height)
      add(RN.periodicValueNoise2D(uniform(-10, 600), uniform(-10, 300), 512, 256, seed))
      add(RN.ridgedMultifractal(x, y, d.width, d.height, seed))
      add(RN.ridgedMultifractalOn(d, x, y, seed))
      add(RN.fineDetailNoise(x, y, d.width, d.height, seed))
      add(RN.fineDetailNoiseOn(d, x, y, seed))
      if (d.kind === 'sphere') add(RN.fineDetailNoiseScaledOn(d, x, y, 3, seed))
      add(GN.valueNoise3D(uniform(-50, 50), uniform(-50, 50), uniform(-50, 50), seed))
      if (d.kind === 'sphere') {
        d.noise.frame(x, y, gf)
        add(GN.globeOctaveOn(gf, 64, d, seed))
        add(GN.globeOctave(gf, 64, d.width, seed))
      }
      add(DW.domainWarpDelta(x, y, d, seed, 'x'))
      add(DW.domainWarpDelta(x, y, d, seed, 'y'))
      DW.domainWarpPoint(x, y, d, seed, p)
      add(p.x)
      add(p.y)
      const t = uniform(0, 1)
      add(HY.hypsometryWeight(uniform(0.5, 1)))
      add(HY.hypsometryRelief(x, y, d, seed))
      add(HY.continentalHypsometry(x, y, t, d, seed))
    }
  }
  line(`${name}_noise`)
}

// The elevation field, the trench and the folds on both shapes.
for (const [name, d, seed] of [['torus', D.torusDomain(2048, 1024), 4], ['sphere', D.sphereDomain(2048, 1024), 5]]) {
  state = seed
  const seeds = []
  for (let i = 0; i < 24; i++) seeds.push({ x: uniform(0, d.width), y: uniform(0, d.height) })
  const motions = PM.generatePlateMotions(seeds, d, mulberry32(seed))
  const ages = seeds.map(() => uniform(0, 150))
  const rafts = []
  for (let r = 0; r < 16; r++) {
    const cx = uniform(0, d.width)
    const cy = uniform(0, d.height)
    const blobs = []
    for (let b = 0; b < 5; b++) blobs.push({ x: d.wrapX(cx + uniform(-60, 60)), y: Math.min(d.height, Math.max(0, cy + uniform(-40, 40))), radius: uniform(20, 90), birthEpoch: 0 })
    rafts.push({ id: r, name: null, blobs })
  }
  const features = []
  for (let k = 0; k < 400; k++) {
    const tx = uniform(-1, 1)
    const ty = uniform(-1, 1)
    const l = Math.sqrt(tx * tx + ty * ty) || 1
    features.push({
      x: uniform(0, d.width), y: uniform(0, d.height), thickness: uniform(-20, 60),
      tangentX: tx / l, tangentY: ty / l, kind: k % 4 === 0 ? 'trench' : 'range', subsides: false,
      plateA: 0, plateB: 1, movesWithPlate: 'both', epochsSinceDeposit: 0,
    })
  }
  const warpSeed = 2900000000 + seed
  h = 0x811c9dc5
  const fb = EF.buildFeatureBuckets(features, d)
  add(fb.bucketsX)
  add(fb.bucketsY)
  add(fb.bucketSizeX)
  add(fb.bucketSizeY)
  addAll(fb.rowSpan)
  const empty = EF.buildFeatureBuckets([], d)
  add(empty.bucketsX)
  add(empty.bucketsY)
  for (let k = 0; k < 3000; k++) {
    const x = uniform(0, d.width)
    const y = uniform(0, d.height)
    const n = EF.nearFeatureBuckets(fb, x, y)
    add(n)
    for (let i = 0; i < n; i++) add(fb.near[i])
    const deck = EF.upliftDeckAt(x, y, fb, d)
    add(deck)
    add(EF.computeElevation(x, y, uniform(-0.6, 0.2), fb, d, uniform(0, 1), k % 3 === 0 ? uniform(-0.5, 0.5) : 0))
    add(EF.oceanFloorAtAge(uniform(0, 200)))
    add(FO.foldFactorAt(fb, x, y, d, k % 2 === 0 ? 0 : uniform(0.5, 4)))
    const ws = EF.warpedSamplePoint(x, y, d, warpSeed)
    add(ws.wx)
    add(ws.wy)
  }
  line(`${name}_features`)

  h = 0x811c9dc5
  let age = OA.createOceanAgeField(30, d)
  for (let i = 0; i < age.length; i++) age[i] = uniform(0, 160)
  const blobs = RF.buildBlobIndex(rafts, d)
  const trench = TR.trenchDepression({ domain: d, seeds, motions, ages, rafts })
  let trenches = 0
  for (let k = 0; k < 4000; k++) {
    const x = uniform(0, d.width)
    const y = uniform(0, d.height)
    add(EF.raftBaselineAt(x, y, rafts, null, d, warpSeed))
    add(EF.raftBaselineAt(x, y, rafts, age, d, warpSeed, blobs))
    add(EF.raftBaselineAt(x, y, rafts, age, d, warpSeed, undefined, trench))
    const td = trench(x, y, uniform(-0.05, 0.2), uniform(0, 160))
    if (td !== 0) trenches++
    add(td)
  }
  add(trenches)
  addAll(EF.computeRaftBaseline(rafts, age, 256, 128, d, warpSeed))
  addAll(EF.computeRaftBaseline(rafts, null, 64, 32, d, warpSeed))
  const om = OA.oceanAgeMesh(d)
  add(om.mesh.tri.lastTri)
  add(om.mesh.tri.walkSteps)
  line(`${name}_baseline`)
}

// The redistribution, on a small torus whose raster is its own extent.
state = 6
h = 0x811c9dc5
{
  const d = D.torusDomain(256, 128)
  const rafts = []
  for (let r = 0; r < 6; r++) rafts.push({ id: r, name: null, blobs: [{ x: uniform(0, 256), y: uniform(0, 128), radius: uniform(10, 40) }] })
  const owner = RF.computeOwnerField(rafts, 64, 32, d)
  const elev = new Float32Array(256 * 128)
  for (let i = 0; i < elev.length; i++) elev[i] = uniform(-0.3, 0.6)
  EF.applyMountainRedistribution(elev, d, owner, 64, 32)
  addAll(elev)
}
line('redistribution')

const text = lines.join('\n') + '\n'
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('engine/crates/casas-engine/tests/fixtures/elevation.txt is stale — run node engine/scripts/elevationFixture.mjs')
    process.exit(1)
  }
} else {
  writeFileSync(OUT, text)
  console.log(text)
}
