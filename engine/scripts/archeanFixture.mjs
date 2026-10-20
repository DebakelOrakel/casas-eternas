// Writes the module test fixture for the engine's Archean: a world made
// from a seed string by the TypeScript engine's archean/, 200 Archean
// epochs (saved and restored at the 100th), the hand-over to the plates
// and 20 tectonic epochs, a hash of the whole state after every step, on
// both shapes; the Rust port must make the same bits
// (docs/decisions/rust-engine.md, fork 5).
//
//   node engine/scripts/archeanFixture.mjs           write the fixture
//   node engine/scripts/archeanFixture.mjs --check   fail if it is stale
//
// About half a minute: `make test` checks it, not `make lint`.
// crates/casas-engine/tests/archean.rs runs the same: change one, change
// the other.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { archeanHash, stateHash } from './simHash.mjs'

const CLIENT = fileURLToPath(new URL('../../client', import.meta.url))
const OUT = new URL('../crates/casas-engine/tests/fixtures/archean.txt', import.meta.url)

const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
const AS = await L('/src/generator/archean/archeanState.ts')
const ST = await L('/src/generator/archean/archeanStep.ts')
const SN = await L('/src/generator/archean/archeanSnapshot.ts')
const FA = await L('/src/generator/archean/finalizeArchean.ts')
const M = await L('/src/generator/mantle/mantleField.ts')
const PS = await L('/src/generator/tectonics/plateSimulation.ts')
await server.close()

const ARCHEAN_EPOCHS = 200
const RESTORE_AT = 100
const TECTONIC_EPOCHS = 20

const lines = [
  '# Hashes of an Archean world, its hand-over and its first tectonic epochs (client/src/generator/archean/), for crates/casas-engine/tests/archean.rs.',
  '# Written by engine/scripts/archeanFixture.mjs; do not edit.',
]
for (const shape of ['torus', 'sphere']) {
  let sim = AS.createArcheanSimulation('casas-fixture', 2048, 1024, shape)
  lines.push(`${shape} archean 0 ${archeanHash(sim)}`)
  for (let e = 1; e <= ARCHEAN_EPOCHS; e++) {
    ST.archeanStep(sim)
    if (e === RESTORE_AT) {
      const snap = structuredClone(SN.serializeArchean(sim))
      sim = SN.deserializeArchean(snap, M.savedMantle(sim.mantle, sim.domain), Int16Array.from(sim.upwellingStreak), shape)
    }
    lines.push(`${shape} archean ${e} ${archeanHash(sim)}`)
  }
  const plates = FA.finalizeArchean(sim)
  lines.push(`${shape} handover 0 ${stateHash(plates, [])}`)
  for (let e = 1; e <= TECTONIC_EPOCHS; e++) lines.push(`${shape} handover ${e} ${stateHash(plates, PS.stepEpoch(plates))}`)
}

const text = lines.join('\n') + '\n'
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('engine/crates/casas-engine/tests/fixtures/archean.txt is stale — run node engine/scripts/archeanFixture.mjs')
    process.exit(1)
  }
} else {
  writeFileSync(OUT, text)
  console.log(`archean fixture: ${lines.length - 2} lines`)
}
