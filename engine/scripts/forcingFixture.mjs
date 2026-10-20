// Writes the module test fixture for the erosion forcing: hashes of what
// the TypeScript engine's elevation/upliftField.ts, elevation/
// erodibilityField.ts, surface/erosionForcingFields.ts and
// pipeline/erosionForcing.coarseForcingFields make of a synthetic plate
// simulation after 30 epochs, which the Rust port must make bit for bit
// (docs/decisions/rust-engine.md, fork 5).
//
//   node engine/scripts/forcingFixture.mjs           write the fixture
//   node engine/scripts/forcingFixture.mjs --check   fail if it is stale
//
// About half a minute: `make test` checks it, not `make lint`. The
// simulation is syntheticSim.mjs's; crates/casas-engine/tests/forcing.rs
// runs the same scenarios: change one, change the other.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { syntheticSim } from './syntheticSim.mjs'

const CLIENT = fileURLToPath(new URL('../../client', import.meta.url))
const OUT = new URL('../crates/casas-engine/tests/fixtures/forcing.txt', import.meta.url)

const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
const D = await L('/src/generator/core/domain.ts')
const { mulberry32 } = await L('/src/generator/core/rng.ts')
const { worldEpoch } = await L('/src/generator/core/worldTime.ts')
const PM = await L('/src/generator/tectonics/plateMotion.ts')
const OA = await L('/src/generator/tectonics/oceanAge.ts')
const PS = await L('/src/generator/tectonics/plateSimulation.ts')
const { computeUpliftField } = await L('/src/generator/elevation/upliftField.ts')
const { computeErodibilityField } = await L('/src/generator/elevation/erodibilityField.ts')
const F = await L('/src/generator/surface/erosionForcingFields.ts')
const { coarseForcingFields } = await L('/src/generator/pipeline/erosionForcing.ts')
await server.close()

const EPOCHS = 30
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
  '# Hashes of the erosion forcing (client/src/generator/elevation/upliftField.ts, erodibilityField.ts, surface/erosionForcingFields.ts), for crates/casas-engine/tests/forcing.rs.',
  '# Written by engine/scripts/forcingFixture.mjs; do not edit.',
]
const line = (name) => lines.push(`${name} ${hex()}`)
const paramsHash = (p) => { for (const k of Object.keys(p).sort()) add(p[k]) }
const assembledHash = (a) => {
  addAll(a.forcing.uplift)
  addAll(a.forcing.erodibility)
  addAll(a.forcing.coastMask)
  addAll(a.forcing.accumulationWeights)
  paramsHash(a.params)
}

for (const [name, d, seed] of [['torus', D.torusDomain(2048, 1024), 7], ['sphere', D.sphereDomain(2048, 1024), 8]]) {
  const sim = syntheticSim({ PM, OA, PS, mulberry32 }, d, seed)
  for (let e = 0; e < EPOCHS; e++) PS.stepEpoch(sim)
  h = 0x811c9dc5
  add(sim.features.length)
  add(sim.sutures.length)
  addAll(computeUpliftField(sim.features, d, 256, 128))
  addAll(computeUpliftField(sim.features, d, 100, 50))
  addAll(computeUpliftField([], d, 10, 5))
  line(`${name}_uplift`)

  // The flood basalts a plume would leave, on top of the epochs' features.
  state = seed + 100
  const features = sim.features.slice()
  for (let k = 0; k < 6; k++) {
    features.push({ x: uniform(0, d.width), y: uniform(0, d.height), thickness: uniform(-30, 40), tangentX: 1, tangentY: 0, kind: 'range', plateA: -1, plateB: -2, movesWith: 'both', subsides: false, epochsSinceDeposit: 0 })
  }
  const current = worldEpoch(sim.archeanEpochs, sim.epoch)
  h = 0x811c9dc5
  addAll(computeErodibilityField(sim.rafts, sim.sutures, features, current, sim.archeanEpochs, d, 256, 128))
  addAll(computeErodibilityField(sim.rafts, [], [], current, sim.archeanEpochs, d, 64, 32))
  line(`${name}_erodibility`)

  const { uplift, hardness } = coarseForcingFields(sim, d)
  h = 0x811c9dc5
  addAll(uplift)
  addAll(hardness)
  line(`${name}_coarse`)

  // The forcing on a point set: water per node, a water raster with a
  // given land mean, and nothing at all.
  state = seed + 200
  const count = 5000
  const xs = new Float64Array(count)
  const ys = new Float64Array(count)
  const alive = new Uint8Array(count)
  const z = new Float32Array(count)
  const areas = new Float32Array(count)
  const waterNodes = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    xs[i] = uniform(0, d.width)
    ys[i] = uniform(0, d.height)
    alive[i] = i % 7 === 0 ? 0 : 1
    z[i] = uniform(-0.3, 0.2)
    areas[i] = uniform(0.5, 2)
    waterNodes[i] = uniform(-0.1, 3)
  }
  const water = new Float32Array(64 * 32)
  for (let i = 0; i < water.length; i++) water[i] = uniform(-0.2, 2)
  const lithoSeed = F.erosionLithoSeed(sim.warpSeed)
  const base = { uplift, hardness, forcingResX: 256, forcingResY: 128, water: null, waterResX: 1, waterResY: 1, lithoSeed }
  h = 0x811c9dc5
  add(lithoSeed)
  assembledHash(F.assembleNodeForcing({ ...base, waterNodes }, xs, ys, alive, count, z, areas, d, { alluvium: 30, rockContrast: 80 }))
  assembledHash(F.assembleNodeForcing({ ...base, water, waterResX: 64, waterResY: 32 }, xs, ys, alive, count, z, areas, d, {}, 1.3))
  assembledHash(F.assembleNodeForcing({ ...base, uplift: null, hardness: null }, xs, ys, alive, count, z, areas, d, { rockContrast: 0 }))
  line(`${name}_nodes`)

  // The forcing on a raster of 256 × 128 cells over the same shape.
  const rd = d.kind === 'sphere' ? D.sphereDomain(256, 128) : D.torusDomain(256, 128)
  const raw = new Float32Array(256 * 128)
  for (let i = 0; i < raw.length; i++) raw[i] = uniform(-0.3, 0.2)
  h = 0x811c9dc5
  assembledHash(F.assembleFineForcing({ ...base, water, waterResX: 64, waterResY: 32 }, raw, rd, { alluvium: 70 }))
  assembledHash(F.assembleFineForcing(base, raw, rd))
  paramsHash(F.scaleEngineParamsForDt(F.engineParamsFor({ alluvium: 10 }), 12.5))
  line(`${name}_raster`)
}

const text = lines.join('\n') + '\n'
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('engine/crates/casas-engine/tests/fixtures/forcing.txt is stale — run node engine/scripts/forcingFixture.mjs')
    process.exit(1)
  }
} else {
  writeFileSync(OUT, text)
  console.log(`forcing fixture: ${lines.length - 2} lines`)
}
