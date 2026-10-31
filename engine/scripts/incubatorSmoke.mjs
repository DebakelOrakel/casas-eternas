// The incubator's history (docs/decisions/incubator-history-engine.md): its
// crate's WASM build on worlds made here — no world, no level 1 from a
// store — against a recorded reference. Two small synthetic worlds, a torus
// and a sphere (its raster 256 wide, the globe an eighth of the map's
// 2 048: at 8 km some 40 000 cells), with continents and islands, ice, the
// climates' belts, rivers, the ecology's fields, the rain's reliability:
// the habitat, the flora, the fauna, the history (its packed bytes), its
// peoples (their arrays in the pack, since the incubator's v3), where its
// goods came from (their arrays in the pack, since 2026-10-30) and its
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
const { historyStage, parseHistoryStage, peoplingInput, PEOPLING_DEFAULTS } = await L('/src/world/historyArtifacts.ts')
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
  // The carrying capacity with the dry shelf as land (the level's
  // shelfEcology, TEG-13): to 120 m below the sea, the land's by latitude.
  const shelfCarrying = new Uint8Array(count).fill(ECOLOGY_FINE_OCEAN)
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
        if (-zz * 9000 <= 120) shelfCarrying[k] = fine(a > 72 ? 0 : a > 62 ? 0.3 : a > 50 ? 0.6 : a > 16 ? 1 : 1.5)
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
    cells: { kind, spacingKm: kind === 'torus' ? 10 : 8, width, height, nodes, nodeW, nodeH, land, biome, koppen: kop, z, lakeDepth, ecology, shelfCarrying, rivers: { points: Float32Array.from(points), lengths: Uint32Array.from(lengths), regimes: Uint8Array.from(regimes) } },
    rain: { width: rw, height: rh, variability, enso, ensoStrength: 0.8 },
    // The sphere's seed gives a herding centre, a told split and a told
    // merge (`reaches`). Of the seeds 1 to 30 on the sphere, 14 gave a
    // herding centre, 11 a told split, 4 a told merge, and only 29 gave
    // all three; 12345 gave none of the three (2026-10-30, TEG-99). Its
    // history costs about the same as 12345's (both run 100 000 years).
    // Since the dry shelf carries its own ecology (TEG-13, 2026-10-30),
    // seed 29 tells no merge; of the seeds 1 to 12 only 5 and 6 reach all
    // three. Since the post-glacial rebound (TEG-22, 2026-10-31) seed 5
    // and 6 give no herding centre and no told merge; of the seeds 1 to 14
    // only 4 reaches all three. Since the latest city (TEG-10,
    // 2026-10-31) the sphere's history ends at +20 000 (a farmers' town
    // of 8 575 people, over CITY_LATEST_PEOPLE).
    seed: kind === 'sphere' ? 4 : 12345,
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
  return new build.Incubator(c.kind === 'sphere', c.spacingKm, c.width, c.height, c.nodes, c.nodeW, c.nodeH, c.land, c.biome, c.koppen, c.z, c.lakeDepth, ecology, present, c.rivers.points, c.rivers.lengths, c.rivers.regimes, c.shelfCarrying)
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
// WHERE THE GOODS CAME FROM (the pack's last arrays since the incubator's
// v6, 2026-10-30; pack.rs): hashed apart, and the history's hash is that
// of the pack without them, the bytes it had before them. So the goods
// cannot change the rest of the history unseen.
const pad8 = (n) => (n + 7) & ~7
function goodsApart(pack) {
  const bytes = bytesOf(pack)
  const length = bytes.readUInt32LE(0)
  const head = bytes.subarray(4, 4 + length).toString('utf8')
  const arrays = JSON.parse(head).arrays
  const goods = arrays.filter((a) => a.name.startsWith('goods'))
  const end = Math.min(...goods.map((a) => a.offset))
  if (goods.length !== 4 || arrays.some((a) => !a.name.startsWith('goods') && a.offset >= end)) throw new Error('the goods are not the pack\'s last arrays')
  const rest = Buffer.from(head.replace(/,\{"name":"goods[A-Za-z]*","type":"[a-z0-9]+","offset":\d+,"length":\d+\}/g, ''), 'utf8')
  const data = pad8(4 + length)
  const history = Buffer.alloc(pad8(4 + rest.length) + end)
  history.writeUInt32LE(rest.length, 0)
  rest.copy(history, 4)
  bytes.copy(history, pad8(4 + rest.length), data, data + end)
  const size = { 'i32': 4, 'f32': 4 }
  const of = Object.fromEntries(goods.map((a) => [a.name, bytes.subarray(data + a.offset, data + a.offset + a.length * size[a.type])]))
  return { history, goods: of, bytes: bytes.length, before: history.length }
}
// STEP 1'S CONTROLS (2026-10-30, DES-0032): the defaults given are the
// defaults left out (the history's bits above are the defaults'); another
// reach over sea or another lowest sea level reaches another share of the
// land, and names another H1 (the default's stage unchanged).
function peoplingControls(kind, rs, seed) {
  const origin = rs.originOf(seed)
  const land = rs.bytes('land')
  const reached = (...controls) => {
    rs.people(Int32Array.of(origin), seed, ...controls)
    const arrival = rs.peoplingFloats('arrival')
    let on = 0
    let all = 0
    for (let i = 0; i < arrival.length; i++) {
      if (!land[i]) continue
      all++
      if (arrival[i] < Infinity) on++
    }
    return on / all
  }
  const share = reached()
  if (reached(PEOPLING_DEFAULTS.reachKm, PEOPLING_DEFAULTS.seaLowM) !== share) fail(`${kind} controls: the defaults given are not the defaults left out`)
  const shares = { 'reach 100 km': reached(100, undefined), 'reach 1000 km': reached(1000, undefined), 'sea low 60 m': reached(undefined, 60), 'sea low 150 m': reached(undefined, 150) }
  console.log(`incubator: ${kind} — step 1 reached ${(100 * share).toFixed(1)} % of the land at the defaults; ${Object.entries(shares).map(([k, v]) => `${k} ${(100 * v).toFixed(1)} %`).join(', ')}`)
  if (shares['reach 100 km'] >= shares['reach 1000 km']) fail(`${kind} controls: the reach over sea changes nothing`)
  if (shares['sea low 60 m'] === shares['sea low 150 m']) fail(`${kind} controls: the lowest sea level changes nothing`)
  const stages = [peoplingInput(origin), peoplingInput(origin, { reachKm: 600 }), peoplingInput(origin, { seaLowM: 90 }), peoplingInput(origin, { reachKm: 600, seaLowM: 90 })].map(historyStage)
  if (stages[0] !== `H1:${origin}` || new Set(stages).size !== stages.length) fail(`${kind} controls: the H1 stages ${stages.join(' ')}`)
  for (const stage of stages) if (historyStage(parseHistoryStage(stage)) !== stage) fail(`${kind} controls: ${stage} does not read back`)
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
  peoplingControls(kind, rs, world.seed)
  const r = world.rain
  t0 = performance.now()
  const pack = rs.simulate(-1, world.seed, r.width, r.height, r.variability, r.enso, r.ensoStrength, undefined)
  const runMs = performance.now() - t0
  const apart = goodsApart(pack)
  hashes[`${kind} history`] = hashOf(apart.history)
  hashes[`${kind} goods`] = hashOf(...Object.values(apart.goods))
  const history = unpackHistory(pack.buffer.slice(pack.byteOffset, pack.byteOffset + pack.byteLength))
  if (!history) {
    fail(`${kind} history: its pack does not read`)
    continue
  }
  // THE PEOPLES (the pack's since v3): their arrays alone, so a change to
  // them is named apart from the rest of the history's.
  const peoplesHash = (h) => hashOf(...Object.entries(h.peoples).flatMap(([name, a]) => (name === 'ids' ? a : [a])))
  hashes[`${kind} peoples`] = peoplesHash(history)
  const tree = history.peoples
  const alive = [...tree.ended].filter((e, id) => e === Infinity && tree.big[id]).length
  if (tree.parent.some((p) => p >= 0)) seen.add('people split')
  if (tree.mergedInto.some((m) => m >= 0)) seen.add('people merged')
  if (alive >= 2) seen.add('peoples')
  const v = history.lifeways.villages
  t0 = performance.now()
  const settledPack = rs.settleHistory(history.people.arrival, history.lifeways.farmAt, history.lifeways.herdAt, v.villages, v.villageFrom, v.villageTo, v.villageTown, history.end)
  const settleMs = performance.now() - t0
  hashes[`${kind} settlement`] = hashOf(settledPack)
  const settled = unpackSettled(settledPack.buffer.slice(settledPack.byteOffset, settledPack.byteOffset + settledPack.byteLength))
  if (settled?.trade) seen.add('trade')
  // The goods' shares are the links' weights, by source and village:
  // their sums are one.
  const shares = new Float32Array(apart.goods.goodsShare.buffer.slice(apart.goods.goodsShare.byteOffset, apart.goods.goodsShare.byteOffset + apart.goods.goodsShare.byteLength))
  const sharesSum = shares.reduce((a, x) => a + x, 0)
  const links = settled?.arrays.get('links') ?? new Float32Array(0)
  let linksSum = 0
  for (let k = 2; k < links.length; k += 3) linksSum += links[k]
  if (Math.abs(sharesSum - linksSum) > 1e-4 * Math.max(1, linksSum)) fail(`${kind} goods: their shares sum to ${sharesSum}, the links' weights to ${linksSum}`)
  if (shares.length > 0) seen.add('goods')
  console.log(`incubator: ${kind} — H1 ${apart.bytes} bytes, ${apart.before} without the goods (+${(100 * (apart.bytes - apart.before) / apart.before).toFixed(2)} %): ${apart.goods.goodsSources.length / 12} sources, ${shares.length} shares`)
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
  console.log(`incubator: ${kind} — ${rs.count()} cells, ${landCount} on land, ${landmasses} landmasses; ${count('crossing')} crossings, ${count('centre')} centres (${history.log.filter((e) => e.kind === 'centre' && e.lifeway === 3).length} herding), ${count('village')} villages, ${count('camp')} camps, ${count('famine')} famines, ${count('extinct')} extinctions, ${tree.parent.length} peoples (${alive} big ones alive at the end, ${count('peopleSplit')} splits and ${count('peopleMerged')} merges and ${count('peopleReplaced')} replacements told) (cells ${Math.round(cellsMs)} ms, flora and fauna ${Math.round(growMs)} ms, history ${Math.round(runMs)} ms, settlement ${Math.round(settleMs)} ms)`)
  // The native build on the same world.
  t0 = performance.now()
  const nat = wasmCells(world.cells, native)
  nat.growFlora(world.seed)
  nat.populate(world.seed)
  const natPack = nat.simulate(-1, world.seed, r.width, r.height, r.variability, r.enso, r.ensoStrength)
  const natSettled = nat.settleHistory(history.people.arrival, history.lifeways.farmAt, history.lifeways.herdAt, v.villages, v.villageFrom, v.villageTo, v.villageTown, history.end)
  const natMs = performance.now() - t0
  const natHashes = {
    habitat: hashOf(nat.owners(), ...['areaKm2', 'heightM', 'slope', 'seaDepthM', 'riverSize', 'distKm', 'u', 'v'].map((name) => nat.floats(name)), ...CELL_ECOLOGY.map((id) => nat.floats(`eco:${id}`)), ...['land', 'biome', 'koppen', 'nearRiver', 'nearLake', 'nearSea'].map((name) => nat.bytes(name)), ...['landmass', 'nbrStart', 'nbr'].map((name) => nat.ints(name)), nat.landmassKm2(), nat.scalars(), nat.iceKm(), native.coldCurve(world.seed)),
    flora: hashOf(nat.floraCodes(), nat.floraShares()),
    fauna: hashOf(nat.faunaCodes(), nat.faunaShares()),
    history: hashOf(goodsApart(natPack).history),
    goods: hashOf(...Object.values(goodsApart(natPack).goods)),
    peoples: peoplesHash(unpackHistory(natPack.buffer.slice(natPack.byteOffset, natPack.byteOffset + natPack.byteLength))),
    settlement: hashOf(natSettled),
  }
  for (const [part, h] of Object.entries(natHashes)) if (h !== hashes[`${kind} ${part}`]) fail(`${kind} ${part}: the native build differs from the WASM's`)
  console.log(`incubator: ${kind} — the native build in ${Math.round(natMs)} ms`)
  // Step 1's controls reach the history in both builds alike (the job's
  // and the browser's), and change it.
  if (kind === 'torus') {
    const wasmOther = hashOf(rs.simulate(-1, world.seed, r.width, r.height, r.variability, r.enso, r.ensoStrength, undefined, 600, 90))
    const natOther = hashOf(nat.simulate(-1, world.seed, r.width, r.height, r.variability, r.enso, r.ensoStrength, 600, 90))
    if (wasmOther !== natOther) fail(`${kind} controls: the native build's history differs from the WASM's`)
    if (wasmOther === hashOf(pack)) fail(`${kind} controls: the history does not change with them`)
  }
  if (golden) for (const part of ['habitat', 'flora', 'fauna', 'history', 'peoples', 'settlement', 'goods']) {
    const key = `${kind} ${part}`
    if (golden[key] !== hashes[key]) fail(`${key}: not the reference's (${hashes[key].slice(0, 12)} against ${String(golden[key]).slice(0, 12)})`)
  }
  rs.free()
}

// THE REACH: each kind of event at least once on the two worlds, or the
// check passes on less than it claims; then the worlds are to be changed.
// Not 'villageLeft' and not 'ice' (a cell lived in, left and lived in
// again): since the history begins where step 1 of the prehistory ends,
// after the cold, no village is left and the ice only gives land back
// (2026-10-28); they come back with step 2's rising sea and drying land.
// Not 'city': no town grew to a city after REACH_END (2026-10-28); since
// the rising sea and the cold spells (2026-10-28) the worlds reach it
// again, by chance. Not 'drowned': the sea takes less than
// DROWNED_TOLD_KM2 of these small worlds' shelves in a CLIMATE_YEARS.
// Not 'drying' (2026-10-29): no landmass of these small worlds loses
// DRYING_TOLD_KM2 of its dry belt in a CLIMATE_YEARS.
// Not 'seaFloodsIce' and not 'landRises' (2026-10-31, TEG-22): the
// rebound's coasts move less than REBOUND_TOLD_KM2 of these small worlds'
// land in a CLIMATE_YEARS; the bits did not change with them.
// THE PEOPLES (2026-10-29): two big ones alive at the end on a world, a
// people parted from another, one merged into another; the chronicle's
// events of each kind (peoples.rs Tree::tell). A told split and a told
// merge are rare since the incubator's v6 and step 2's times toward the
// earth's (2026-10-29): no split is told in step 2's first
// EARLY_SPLIT_YEARS, and no split or merge is told that did not hold
// TOLD_LIVES_YEARS. With seed 12345 neither world told one, and only the
// torus reached a herding centre ('centre 3'); the sphere's seed 29 told
// one of each and reached a herding centre, so the three were in again
// (2026-10-30, TEG-99); seed 5 since the dry shelf's ecology (TEG-13), seed 4
// since the post-glacial rebound (TEG-22). Seed 4 also tells a people
// THE WAVES took as replaced (TEG-14, 2026-10-31: 2 merges and 1
// replacement, 3 merges before). Since the latest city (TEG-10,
// 2026-10-31: simulation.rs CITY_LATEST_YEARS) the sphere's history ends
// at +20 000, not at SPAN_YEARS: seed 4 tells 1 split, 2 merges and no
// replacement; the torus, whose short step 2 now tells the splits and
// merges that held to its end (TEG-11), 3 splits and 2 replacements.
// Also in peoples.rs
// `a_split_is_told_once_it_held`,
// `a_split_that_held_to_a_short_history_s_end_is_told`,
// `the_tree_keeps_ids_and_records_splits_and_merges` and
// `a_people_the_waves_took_is_told_replaced`.
const reaches = ['departure', 'trade', 'crossing', 'centre 3', 'centre 4', 'domesticated', 'extinct', 'famine', 'village', 'camp', 'campLeft', 'population', 'copper', 'coldSpell', 'peoples', 'people split', 'people merged', 'peopleSplit', 'peopleMerged', 'peopleReplaced', 'peopleGone', 'peopleFarmers', 'goods']
for (const r of reaches) if (!seen.has(r)) fail(`the worlds no longer reach ${r}: the check would pass on less than it claims`)
if (!golden && !failed) {
  await writeFile(GOLDEN, JSON.stringify(hashes, null, 2) + '\n')
  console.log('incubator: recorded the reference')
}
if (failed) process.exit(1)
console.log(golden ? 'incubator: the WASM build gives the reference\'s bits' : 'incubator: recorded')
