// The incubator's history (docs/decisions/incubator-history-engine.md): its
// crate's WASM build on worlds made here — no world, no level 1 from a
// store — against a recorded reference. Two small synthetic worlds, a torus
// and a sphere (its raster 256 wide, the globe an eighth of the map's
// 2 048: at 8 km some 40 000 cells), with continents and islands, ice, the
// climates' belts, rivers, the ecology's fields, the rain's reliability:
// the habitat, the flora, the fauna, the history (its packed bytes) and its
// settlement, hashed, must be the reference's. The reference was recorded
// while the TypeScript the crate was ported from still stood beside it and
// gave the same bits (2026-10-27; and on Morvane, the whole H1 alike); it
// is recorded again only on purpose, with --record, when the history is
// meant to change (and the incubator's version with it: a tuning changed
// changes it by itself, the code changed by INCUBATOR_ALGO_VERSION). And the worlds must reach
// what they are there to test (`reaches`), or the check passes on less than
// it claims.
//
//   node engine/scripts/incubatorSmoke.mjs [--record]
//
// The native build (the job worker's) runs the same worlds and must give
// the WASM's bits. Needs `make engine` (engine/dist/incubator,
// engine/dist/casas-incubator.node).

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const dist = new URL('../dist/', import.meta.url)
const wasm = await import(new URL('incubator/casas-incubator.js', dist).href)
await wasm.default({ module_or_path: await readFile(new URL('incubator/casas-incubator_bg.wasm', dist)) })
// The native build, the job worker's: the same bits as the WASM's.
const native = createRequire(import.meta.url)(fileURLToPath(new URL('casas-incubator.node', dist)))

const CLIENT = fileURLToPath(new URL('../../client', import.meta.url))
const { createServer } = await import(new URL('../../client/node_modules/vite/dist/node/index.js', import.meta.url).href)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
const { Biome } = await L('/src/generator/climate/biomes.ts')
const { KOPPEN_CODES } = await L('/src/generator/climate/koppen.ts')
const { ECOLOGY_FINE_OCEAN, ECOLOGY_FINE_STEP } = await L('/src/generator/ecology/ecologyField.ts')
const { unpackHistory, unpackSettled } = await L('/src/screens/incubator/historyPack.ts')
await server.close()

let failed = false
const fail = (message) => {
  console.error(`incubator: ${message}`)
  failed = true
}
const bytesOf = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength)

// THE SYNTHETIC WORLDS. Fields on a node grid twice the world raster's
// size, one node a texel (the chart's node map the identity).
const CELL_ECOLOGY = ['game', 'carryingCapacity', 'arable', 'pasture', 'fish', 'toolStone', 'salt', 'copper']
const koppen = (code) => KOPPEN_CODES.indexOf(code)
function synthWorld(kind) {
  const width = kind === 'torus' ? 384 : 256
  const height = width / 2
  const nodeW = 2 * width
  const nodeH = 2 * height
  const count = nodeW * nodeH
  const nodes = Int32Array.from({ length: count }, (_, k) => k)
  const land = new Uint8Array(count)
  const biome = new Uint8Array(count)
  const kop = new Uint8Array(count)
  const z = new Float32Array(count)
  const lakeDepth = new Float32Array(count)
  const ecology = Object.fromEntries(CELL_ECOLOGY.map((id) => [id, new Uint8Array(count)]))
  const fine = (v) => Math.max(0, Math.min(254, Math.round(v / ECOLOGY_FINE_STEP)))
  // Three continents, a chain of islands between two of them, a polar
  // land; the distance wraps across.
  const blobs = [[0.2, 0.42, 0.26, 0.5], [0.62, 0.3, 0.2, 0.5], [0.84, 0.7, 0.16, 0.45], [0.425, 0.4, 0.04, 0.35], [0.47, 0.38, 0.035, 0.35], [0.5, 0.06, 0.3, 0.42], [0.3, 0.82, 0.12, 0.45]]
  const wrap = (d) => d - Math.round(d)
  for (let py = 0; py < nodeH; py++) {
    for (let px = 0; px < nodeW; px++) {
      const k = py * nodeW + px
      const x = (px + 0.5) / nodeW
      const y = (py + 0.5) / nodeH
      let f = 0
      for (const [bx, by, r, top] of blobs) {
        const d = Math.hypot(wrap(x - bx) * 2, y - by) / r
        f = Math.max(f, top * (1 - d * d))
      }
      f += 0.03 * Math.sin(37 * x + 5 * y) * Math.cos(29 * y - 3 * x)
      const zz = f - 0.08
      z[k] = zz
      const lat = (0.5 - y) * 180
      const a = Math.abs(lat)
      const moist = 0.5 + 0.5 * Math.sin(11 * x + 7 * y)
      if (zz <= 0) {
        biome[k] = Biome.Ocean
        for (const id of CELL_ECOLOGY) ecology[id][k] = ECOLOGY_FINE_OCEAN
        continue
      }
      land[k] = 1
      let b, c, carrying
      if (a > 72) [b, c, carrying] = [Biome.Ice, 'EF', 0]
      else if (a > 62) [b, c, carrying] = [Biome.Tundra, 'ET', 0.3]
      else if (a > 50) [b, c, carrying] = [Biome.Boreal, moist > 0.5 ? 'Dfc' : 'Dfb', 0.6]
      else if (a > 38) [b, c, carrying] = moist > 0.5 ? [Biome.TemperateForest, 'Cfb', 1.4] : [Biome.Grassland, 'Dfa', 1.2]
      else if (a > 28) [b, c, carrying] = moist > 0.6 ? [Biome.MediterraneanScrub, 'Csa', 1.2] : moist > 0.3 ? [Biome.Steppe, 'BSk', 0.9] : [Biome.TemperateForest, 'Cfa', 1.5]
      else if (a > 16) [b, c, carrying] = moist > 0.5 ? [Biome.Desert, 'BWh', 0.2] : [Biome.Savanna, 'BSh', 0.8]
      else [b, c, carrying] = moist > 0.5 ? [Biome.TropicalRainforest, 'Af', 2] : [Biome.Savanna, 'Aw', 1.6]
      if (zz > 0.33) [b, c] = [Biome.Glacier, 'EF']
      biome[k] = b
      kop[k] = koppen(c)
      if (Math.sin(53 * x) * Math.sin(47 * y) > 0.97) lakeDepth[k] = 20
      const open = b === Biome.Grassland || b === Biome.Steppe || b === Biome.Savanna || b === Biome.MediterraneanScrub
      ecology.carryingCapacity[k] = fine(carrying)
      ecology.game[k] = fine(carrying * (open ? 1.2 : 0.8))
      ecology.arable[k] = fine(c === 'Csa' || c === 'Cfa' || c === 'Cfb' || c === 'Aw' || c === 'Dfa' ? 0.8 : 0.2)
      ecology.pasture[k] = fine(open || c === 'Dfa' ? 0.9 : 0.25)
      ecology.fish[k] = fine(zz < 0.03 ? 1.2 : 0.1)
      ecology.toolStone[k] = fine(Math.sin(19 * x) * Math.sin(23 * y) > 0.9 ? 1 : 0.1)
      ecology.salt[k] = fine(b === Biome.Desert && moist < 0.2 ? 1 : 0)
      ecology.copper[k] = fine(zz > 0.2 && zz < 0.3 ? 0.8 : 0)
    }
  }
  // Rivers, in the world raster's texels: from each continent's height to
  // its coast, wider downstream.
  const points = []
  const lengths = []
  const regimes = []
  for (const [bx, by, r] of blobs.slice(0, 3)) {
    for (const angle of [0.3, 2.2, 4.1]) {
      const steps = 12
      for (let s = 0; s < steps; s++) {
        const d = (s / steps) * r * 0.9
        points.push((((bx + (d * Math.cos(angle)) / 2) % 1) + 1) % 1 * width, (by + d * Math.sin(angle)) * height, 0.4 + 3.6 * (s / steps))
      }
      lengths.push(steps)
      regimes.push(angle > 4 ? 1 : 0)
    }
  }
  // The rain's reliability on a raster of the world's size.
  const rw = width
  const rh = height
  const variability = new Float32Array(rw * rh)
  const enso = new Float32Array(rw * rh)
  for (let ry = 0; ry < rh; ry++) for (let rx = 0; rx < rw; rx++) {
    const x = (rx + 0.5) / rw
    const y = (ry + 0.5) / rh
    variability[ry * rw + rx] = 0.15 + 0.35 * (0.5 + 0.5 * Math.sin(9 * x - 4 * y))
    enso[ry * rw + rx] = Math.abs(0.5 - y) < 0.2 ? Math.sin(6.283 * x) : 0
  }
  return {
    cells: { kind, spacingKm: kind === 'torus' ? 10 : 8, width, height, nodes, nodeW, nodeH, land, biome, koppen: kop, z, lakeDepth, ecology, rivers: { points: Float32Array.from(points), lengths: Uint32Array.from(lengths), regimes: Uint8Array.from(regimes) } },
    rain: { width: rw, height: rh, variability, enso, ensoStrength: 0.8 },
    seed: 12345,
  }
}

// The WASM build's habitat for the same input.
function wasmCells(c, build = wasm) {
  let present = 0
  const parts = []
  CELL_ECOLOGY.forEach((id, k) => {
    if (!c.ecology[id]) return
    present |= 1 << k
    parts.push(c.ecology[id])
  })
  const ecology = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    ecology.set(p, at)
    at += p.length
  }
  return new build.Incubator(c.kind === 'sphere', c.spacingKm, c.width, c.height, c.nodes, c.nodeW, c.nodeH, c.land, c.biome, c.koppen, c.z, c.lakeDepth, ecology, present, c.rivers.points, c.rivers.lengths, c.rivers.regimes)
}

const GOLDEN = new URL('incubatorSmoke.golden.json', import.meta.url)
const golden = process.argv.includes('--record') ? null : JSON.parse(await readFile(GOLDEN, 'utf8'))
// The WASM's outputs hashed, against the reference.
const hashes = {}
// What the worlds reached between them.
const seen = new Set()
const hashOf = (...parts) => {
  const digest = createHash('sha256')
  for (const p of parts) digest.update(ArrayBuffer.isView(p) ? bytesOf(p) : p)
  return digest.digest('hex')
}
for (const kind of ['torus', 'sphere']) {
  const world = synthWorld(kind)
  let t0 = performance.now()
  const rs = wasmCells(world.cells)
  const cellsMs = performance.now() - t0
  const [landCount, landmasses] = rs.scalars()
  hashes[`${kind} habitat`] = hashOf(
    rs.owners(),
    ...['areaKm2', 'heightM', 'slope', 'seaDepthM', 'riverSize', 'distKm', 'u', 'v'].map((name) => rs.floats(name)),
    ...CELL_ECOLOGY.map((id) => rs.floats(`eco:${id}`)),
    ...['land', 'biome', 'koppen', 'nearRiver', 'nearLake', 'nearSea'].map((name) => rs.bytes(name)),
    ...['landmass', 'nbrStart', 'nbr'].map((name) => rs.ints(name)),
    rs.landmassKm2(), rs.scalars(), rs.iceKm(), wasm.coldCurve(world.seed),
  )
  t0 = performance.now()
  rs.growFlora(world.seed)
  rs.populate(world.seed)
  const growMs = performance.now() - t0
  hashes[`${kind} flora`] = hashOf(rs.floraCodes(), rs.floraShares())
  hashes[`${kind} fauna`] = hashOf(rs.faunaCodes(), rs.faunaShares())
  const r = world.rain
  t0 = performance.now()
  const pack = rs.simulate(-1, world.seed, r.width, r.height, r.variability, r.enso, r.ensoStrength, undefined)
  const runMs = performance.now() - t0
  hashes[`${kind} history`] = hashOf(pack)
  const history = unpackHistory(pack.buffer.slice(pack.byteOffset, pack.byteOffset + pack.byteLength))
  if (!history) {
    fail(`${kind} history: its pack does not read`)
    continue
  }
  const v = history.lifeways.villages
  t0 = performance.now()
  const settledPack = rs.settleHistory(history.people.arrival, history.lifeways.farmAt, history.lifeways.herdAt, v.villages, v.villageFrom, v.villageTo)
  const settleMs = performance.now() - t0
  hashes[`${kind} settlement`] = hashOf(settledPack)
  const settled = unpackSettled(settledPack.buffer.slice(settledPack.byteOffset, settledPack.byteOffset + settledPack.byteLength))
  if (settled?.trade) seen.add('trade')
  // What the world reached, for `reaches`.
  for (const e of history.log) seen.add(e.kind === 'centre' ? `centre ${e.lifeway}` : e.kind)
  // The ice: a cell lived in, left (its people gone in a kept state), lived
  // in again.
  const n = history.people.arrival.length
  for (let i = 0; i < n && !seen.has('ice'); i++) {
    let was = 0
    for (const f of history.kept) {
      const p = f.people[i] > 0
      if (was === 0 && p) was = 1
      else if (was === 1 && !p) was = 2
      else if (was === 2 && p) {
        seen.add('ice')
        break
      }
    }
  }
  const count = (k) => history.log.filter((e) => e.kind === k).length
  console.log(`incubator: ${kind} — ${rs.count()} cells, ${landCount} on land, ${landmasses} landmasses; ${count('crossing')} crossings, ${count('centre')} centres, ${count('village')} villages, ${count('camp')} camps, ${count('famine')} famines, ${count('extinct')} extinctions (cells ${Math.round(cellsMs)} ms, flora and fauna ${Math.round(growMs)} ms, history ${Math.round(runMs)} ms, settlement ${Math.round(settleMs)} ms)`)
  // The native build on the same world.
  t0 = performance.now()
  const nat = wasmCells(world.cells, native)
  nat.growFlora(world.seed)
  nat.populate(world.seed)
  const natPack = nat.simulate(-1, world.seed, r.width, r.height, r.variability, r.enso, r.ensoStrength)
  const natSettled = nat.settleHistory(history.people.arrival, history.lifeways.farmAt, history.lifeways.herdAt, v.villages, v.villageFrom, v.villageTo)
  const natMs = performance.now() - t0
  const natHashes = {
    habitat: hashOf(nat.owners(), ...['areaKm2', 'heightM', 'slope', 'seaDepthM', 'riverSize', 'distKm', 'u', 'v'].map((name) => nat.floats(name)), ...CELL_ECOLOGY.map((id) => nat.floats(`eco:${id}`)), ...['land', 'biome', 'koppen', 'nearRiver', 'nearLake', 'nearSea'].map((name) => nat.bytes(name)), ...['landmass', 'nbrStart', 'nbr'].map((name) => nat.ints(name)), nat.landmassKm2(), nat.scalars(), nat.iceKm(), native.coldCurve(world.seed)),
    flora: hashOf(nat.floraCodes(), nat.floraShares()),
    fauna: hashOf(nat.faunaCodes(), nat.faunaShares()),
    history: hashOf(natPack),
    settlement: hashOf(natSettled),
  }
  for (const [part, h] of Object.entries(natHashes)) if (h !== hashes[`${kind} ${part}`]) fail(`${kind} ${part}: the native build differs from the WASM's`)
  console.log(`incubator: ${kind} — the native build in ${Math.round(natMs)} ms`)
  if (golden) for (const part of ['habitat', 'flora', 'fauna', 'history', 'settlement']) {
    const key = `${kind} ${part}`
    if (golden[key] !== hashes[key]) fail(`${key}: not the reference's (${hashes[key].slice(0, 12)} against ${String(golden[key]).slice(0, 12)})`)
  }
  rs.free()
}

// THE REACH: each kind of event at least once on the two worlds, or the
// check passes on less than it claims; then the worlds are to be changed.
// Not 'villageLeft': since the history begins where step 1 of the
// prehistory ends, after the cold, no village is left (2026-10-28, eight
// seeds); it comes back with step 2's rising sea and drying land.
const reaches = ['departure', 'trade', 'crossing', 'centre 4', 'centre 3', 'domesticated', 'extinct', 'famine', 'village', 'camp', 'campLeft', 'population', 'ice']
for (const r of reaches) if (!seen.has(r)) fail(`the worlds no longer reach ${r}: the check would pass on less than it claims`)
if (!golden && !failed) {
  await writeFile(GOLDEN, JSON.stringify(hashes, null, 2) + '\n')
  console.log('incubator: recorded the reference')
}
if (failed) process.exit(1)
console.log(golden ? 'incubator: the WASM build gives the reference\'s bits' : 'incubator: recorded')
