// Writes the module test fixture for the engine's tectonic epoch: a hash of
// the whole plate simulation after each of 120 epochs, on both shapes, from
// one synthetic snapshot, as the TypeScript engine's
// tectonics/plateSimulation.ts steps it; the Rust port must step it to the
// same bits (docs/decisions/rust-engine.md, fork 5).
//
//   node engine/scripts/epochFixture.mjs           write the fixture
//   node engine/scripts/epochFixture.mjs --check   fail if it is stale
//
// About a minute: `make test` checks it, not `make lint`.
// crates/casas-engine/tests/epoch.rs builds the same snapshot from the same
// generator and hashes the same state: change one, change the other.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stateHash } from './simHash.mjs'

const CLIENT = fileURLToPath(new URL('../../client', import.meta.url))
const OUT = new URL('../crates/casas-engine/tests/fixtures/epoch.txt', import.meta.url)

const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
const D = await L('/src/generator/core/domain.ts')
const { mulberry32 } = await L('/src/generator/core/rng.ts')
const PM = await L('/src/generator/tectonics/plateMotion.ts')
const OA = await L('/src/generator/tectonics/oceanAge.ts')
const PS = await L('/src/generator/tectonics/plateSimulation.ts')
await server.close()

const EPOCHS = 120
let state = 0
const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0)
const uniform = (lo, hi) => lo + (hi - lo) * (next() / 4294967296)

const lines = [
  '# Hashes of the plate simulation after each epoch (client/src/generator/tectonics/plateSimulation.ts), for crates/casas-engine/tests/epoch.rs.',
  '# Written by engine/scripts/epochFixture.mjs; do not edit.',
]
for (const [name, d, seed] of [['torus', D.torusDomain(2048, 1024), 7], ['sphere', D.sphereDomain(2048, 1024), 8]]) {
  state = seed
  const seeds = []
  for (let i = 0; i < 18; i++) seeds.push({ x: uniform(0, d.width), y: uniform(0, d.height) })
  const rafts = []
  for (let r = 0; r < 12; r++) {
    const cx = uniform(0, d.width)
    const cy = uniform(0, d.height)
    const blobs = []
    for (let b = 0; b < 6; b++) {
      const blob = { x: d.wrapX(cx + uniform(-90, 90)), y: Math.min(d.height, Math.max(0, cy + uniform(-60, 60))), radius: uniform(40, 120) }
      if (b % 2 === 0) blob.birthEpoch = Math.floor(uniform(0, 150))
      blobs.push(blob)
    }
    rafts.push({ id: r, name: r % 3 === 0 ? 'Morvane' : null, blobs })
  }
  const snap = {
    width: d.width, height: d.height, initialPlateCount: 18, seeds,
    motions: PM.generatePlateMotions(seeds, d, mulberry32(seed)),
    ages: seeds.map(() => Math.floor(uniform(0, 80))), rafts, features: [], epoch: 0, archeanEpochs: 150,
    warpSeed: 2900000000 + seed, supercontinentActive: false, continentalRiftCooldownUntil: 0,
    hotspots: [], sutures: [], rngState: 12345 + seed,
  }
  const sim = PS.deserializePlateSimulation(snap, OA.savedOceanAge(OA.createOceanAgeField(40, d), d), undefined, d.kind)
  lines.push(`${name} 0 ${stateHash(sim, [])}`)
  for (let e = 1; e <= EPOCHS; e++) lines.push(`${name} ${e} ${stateHash(sim, PS.stepEpoch(sim))}`)
}

const text = lines.join('\n') + '\n'
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('engine/crates/casas-engine/tests/fixtures/epoch.txt is stale — run node engine/scripts/epochFixture.mjs')
    process.exit(1)
  }
} else {
  writeFileSync(OUT, text)
  console.log(`epoch fixture: ${lines.length - 2} lines`)
}
