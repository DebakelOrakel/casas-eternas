// Writes the module test fixture for the engine's replay: hashes of what
// the TypeScript engine's pipeline/replayRuns.ts makes of a plan — two
// Archean runs, the hand-over, a tectonics run and a restored one with
// other levers — on both shapes, its checkpoints, and the same world
// resumed from a checkpoint, which the Rust port must make bit for bit
// (docs/decisions/rust-engine.md, fork 5).
//
//   node engine/scripts/replayFixture.mjs           write the fixture
//   node engine/scripts/replayFixture.mjs --check   fail if it is stale
//
// About a minute: `make test` checks it, not `make lint`.
// crates/casas-engine/tests/replay.rs runs the same plan: change one,
// change the other.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stateHash } from './simHash.mjs'

const CLIENT = fileURLToPath(new URL('../../client', import.meta.url))
const OUT = new URL('../crates/casas-engine/tests/fixtures/replay.txt', import.meta.url)

const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
const RR = await L('/src/generator/pipeline/replayRuns.ts')
const WE = await L('/src/generator/climate/weather.ts')
await server.close()

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
  '# Hashes of client/src/generator/pipeline/replayRuns.ts, for crates/casas-engine/tests/replay.rs.',
  '# Written by engine/scripts/replayFixture.mjs; do not edit.',
]
const snapshotHash = (s) => {
  h = 0x811c9dc5
  addAll(s.oceanAge.values)
  addAll(s.mantle.values)
  addAll(s.latticeAccumulated)
  addAll(s.latticeLockedEpochs)
  addAll(s.latticeLastClassCode)
  for (const k of ['nodes', 'connectivity', 'z', 'column', 'ice']) addAll(s.mesh[k])
  return hex()
}
const terrainHash = (t) => {
  h = 0x811c9dc5
  const n = t.mesh.vertexSlots
  addAll(t.z.subarray(0, n))
  addAll(t.baseline.subarray(0, n))
  addAll(t.column.data.subarray(0, n * 48))
  addAll(t.ice)
  addAll(t.routing.flowTarget)
  return hex()
}

const defaults = WE.defaultWeatherParams()
for (const [name, shape] of [['torus', 'torus'], ['sphere', 'sphere']]) {
  const plan = {
    seed: `Morvane ${name}`, width: 2048, height: 1024, shape,
    genesis: [{ epochs: 30, diffusion: 0.5, landShare: 0.3 }, { epochs: 20, diffusion: 0.8, landShare: 0.35 }],
    tectonics: [
      { epochs: 4, controls: {}, weather: defaults },
      { epochs: 3, controls: { alluvium: 65, rockContrast: 35 }, weather: { ...defaults, humidity: 1.2, temperatureOffset: -1 }, restored: true },
    ],
  }
  // A snapshot shares the live simulation's objects (serializePlateSimulation
  // hands out its arrays): kept past the next epoch it would change with
  // the world, so it is copied as it is taken. The job worker writes it to
  // disk before the replay goes on.
  const checkpoints = []
  const full = await RR.replayRuns(plan, {
    budget: 4,
    onCheckpoint: (position, take) => { const s = structuredClone(take()); checkpoints.push({ position, s }); lines.push(`${name} checkpoint ${position.run} ${position.epoch} ${snapshotHash(s)}`) },
  })
  lines.push(`${name} full ${terrainHash(full.terrain)} ${stateHash(full.sim, [])}`)
  const at = checkpoints[1]
  const resumed = await RR.replayRuns(plan, { budget: 4, resume: { position: at.position, snapshot: at.s } })
  lines.push(`${name} resumed ${at.position.run} ${at.position.epoch} ${terrainHash(resumed.terrain)} ${stateHash(resumed.sim, [])}`)
}

const text = lines.join('\n') + '\n'
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('engine/crates/casas-engine/tests/fixtures/replay.txt is stale — run node engine/scripts/replayFixture.mjs')
    process.exit(1)
  }
} else {
  writeFileSync(OUT, text)
  console.log(`replay fixture: ${lines.length - 2} lines`)
}
process.exit(0)
