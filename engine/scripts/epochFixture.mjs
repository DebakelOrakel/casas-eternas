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
// The snapshot is syntheticSim.mjs's; crates/casas-engine/tests/epoch.rs
// builds the same one and hashes the same state: change one, change the
// other.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stateHash } from './simHash.mjs'
import { syntheticSim } from './syntheticSim.mjs'

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

const lines = [
  '# Hashes of the plate simulation after each epoch (client/src/generator/tectonics/plateSimulation.ts), for crates/casas-engine/tests/epoch.rs.',
  '# Written by engine/scripts/epochFixture.mjs; do not edit.',
]
for (const [name, d, seed] of [['torus', D.torusDomain(2048, 1024), 7], ['sphere', D.sphereDomain(2048, 1024), 8]]) {
  const sim = syntheticSim({ PM, OA, PS, mulberry32 }, d, seed)
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
