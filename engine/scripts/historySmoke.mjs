// The incubator's history: its crate's WASM build against the TypeScript
// it was ported from (docs/decisions/incubator-history-engine.md, the way
// there 2–6), on worlds made here — no world, no level 1 from a store. Two
// small synthetic worlds, a torus and a sphere (its raster 256 wide, the
// globe an eighth of the map's 2 048: at 8 km some 40 000 cells), with continents
// and islands, ice, the climates' belts, rivers, the ecology's fields, the
// rain's reliability. Both sides take the same inputs; the habitat, the
// flora, the fauna, the history (its packed bytes) and its settlement must
// be the same bits. And the world must reach what it is there to test:
// a crossing, a farming and a herding centre, a village, a camp, a famine,
// an extinction, the ice coming and going (`reaches`), or the check would
// pass on less than it claims.
//
//   node engine/scripts/historySmoke.mjs
//
// Needs `make engine` (engine/dist/history).

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const dist = new URL('../dist/', import.meta.url)
const wasm = await import(new URL('history/casas-history.js', dist).href)
await wasm.default({ module_or_path: await readFile(new URL('history/casas-history_bg.wasm', dist)) })

const CLIENT = fileURLToPath(new URL('../../client', import.meta.url))
const { createServer } = await import(new URL('../../client/node_modules/vite/dist/node/index.js', import.meta.url).href)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
const { buildCells } = await L('/src/screens/incubator/cells.ts')
const { growFlora } = await L('/src/screens/incubator/flora.ts')
const { populate } = await L('/src/screens/incubator/fauna.ts')
const { simulate } = await L('/src/screens/incubator/simulation.ts')
const { packHistory, unpackHistory } = await L('/src/screens/incubator/historyPack.ts')
const { originOf } = await L('/src/screens/incubator/people.ts')
const { MEGAFAUNA } = await L('/src/screens/incubator/settle.ts')
const { PLANTS } = await L('/src/screens/incubator/plants.ts')
const catalog = (await L('casas-history-data/catalog.json')).default
const { Biome } = await L('/src/generator/climate/biomes.ts')
const { KOPPEN_CODES } = await L('/src/generator/climate/koppen.ts')
const { ECOLOGY_FINE_OCEAN, ECOLOGY_FINE_STEP } = await L('/src/generator/ecology/ecologyField.ts')
await server.close()

let failed = false
const fail = (message) => {
  console.error(`history: ${message}`)
  failed = true
}
const bytesOf = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength)
const same = (label, a, b) => {
  if (a.length !== b.length) return fail(`${label}: ${a.length} against ${b.length} values`)
  if (!bytesOf(a).equals(bytesOf(b))) {
    let k = 0
    while (k < a.length && (a[k] === b[k] || (Number.isNaN(a[k]) && Number.isNaN(b[k])))) k++
    fail(`${label}: differs from ${k} on (${a[k]} against ${b[k]})`)
  }
}

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
function wasmCells(c) {
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
  return new wasm.Incubator(c.kind === 'sphere', c.spacingKm, c.width, c.height, c.nodes, c.nodeW, c.nodeH, c.land, c.biome, c.koppen, c.z, c.lakeDepth, ecology, present, c.rivers.points, c.rivers.lengths, c.rivers.regimes)
}

// What the worlds reached between them.
const seen = new Set()
for (const kind of ['torus', 'sphere']) {
  const world = synthWorld(kind)
  const started = performance.now()
  const ts = buildCells(world.cells)
  const tsMs = performance.now() - started
  const rs = wasmCells(world.cells)
  const rsMs = performance.now() - started - tsMs
  const h = ts.habitat
  console.log(`history: ${kind} — ${h.count} cells, ${h.landCount} on land, ${h.landmasses} landmasses (TS ${Math.round(tsMs)} ms, WASM ${Math.round(rsMs)} ms)`)
  same(`${kind} owners`, ts.owners, rs.owners())
  for (const name of ['areaKm2', 'heightM', 'slope', 'seaDepthM', 'riverSize', 'distKm', 'u', 'v']) same(`${kind} ${name}`, h[name], rs.floats(name))
  for (const id of CELL_ECOLOGY) same(`${kind} ecology ${id}`, h.ecology[id], rs.floats(`eco:${id}`))
  for (const name of ['land', 'biome', 'koppen', 'nearRiver', 'nearLake', 'nearSea']) same(`${kind} ${name}`, h[name], rs.bytes(name))
  for (const name of ['landmass', 'nbrStart', 'nbr']) same(`${kind} ${name}`, h[name], rs.ints(name))
  same(`${kind} landmassKm2`, h.landmassKm2, rs.landmassKm2())
  same(`${kind} scalars`, Float64Array.of(h.landCount, h.landmasses, h.radiusKm, h.widthKm, h.heightKm), rs.scalars())

  // The flora and the fauna.
  let t0 = performance.now()
  const flora = growFlora(h, world.seed)
  const fauna = populate(h, world.seed)
  const tsGrow = performance.now() - t0
  t0 = performance.now()
  rs.growFlora(world.seed)
  rs.populate(world.seed)
  const rsGrow = performance.now() - t0
  const layers = [...flora.plants, ...flora.trees]
  const joined = (list) => {
    const out = new Uint8Array(list.length * h.count)
    list.forEach((l, k) => out.set(l.codes, k * h.count))
    return out
  }
  same(`${kind} flora codes`, joined(layers), rs.floraCodes())
  same(`${kind} flora shares`, Float64Array.from(layers.flatMap((l) => [l.suitable, l.reached, l.empty])), rs.floraShares())
  same(`${kind} fauna codes`, joined(fauna), rs.faunaCodes())
  same(`${kind} fauna shares`, Float64Array.from(fauna.flatMap((l) => [l.suitable, l.reached, l.empty])), rs.faunaShares())
  console.log(`history: ${kind} — ${layers.filter((l) => l.reached > 0).length} of ${layers.length} plants and trees, ${fauna.filter((l) => l.reached > 0).length} of ${fauna.length} animals (TS ${Math.round(tsGrow)} ms, WASM ${Math.round(rsGrow)} ms)`)

  // The history, its inputs as the incubator's worker makes them.
  const carrying = h.carrying ?? new Float32Array(h.count).fill(0.4)
  const origin = originOf(h, carrying)
  const FARM_PLANTS = new Set(PLANTS.filter((p) => p.domesticable && p.use === 'starch').map((p) => p.id))
  const HERD_ANIMALS = new Set(catalog.herdAnimals)
  const r = world.rain
  const variability = new Float32Array(h.count)
  const enso = new Float32Array(h.count)
  for (let i = 0; i < h.count; i++) {
    const t = Math.min(r.height - 1, Math.floor(h.v[i] * r.height)) * r.width + Math.min(r.width - 1, Math.floor(h.u[i] * r.width))
    variability[i] = r.variability[t]
    enso[i] = r.enso[t]
  }
  t0 = performance.now()
  const history = simulate(h, {
    carrying, origin, seed: world.seed,
    bigGame: fauna.filter((a) => a.id in MEGAFAUNA).map((a) => ({ id: a.id, codes: a.codes, vulnerability: MEGAFAUNA[a.id] })),
    crops: flora.plants.filter((p) => FARM_PLANTS.has(p.id)),
    herds: fauna.filter((a) => HERD_ANIMALS.has(a.id)),
    rain: { variability, enso, ensoStrength: r.ensoStrength },
  })
  const tsRun = performance.now() - t0
  const tsPack = new Uint8Array(packHistory(history))
  t0 = performance.now()
  const rsPack = rs.simulate(-1, world.seed, r.width, r.height, r.variability, r.enso, r.ensoStrength, undefined)
  const rsRun = performance.now() - t0
  if (!Buffer.from(tsPack).equals(Buffer.from(rsPack))) {
    // Where they part: read both back.
    const a = unpackHistory(tsPack.buffer)
    const b = unpackHistory(rsPack.buffer.slice(rsPack.byteOffset, rsPack.byteOffset + rsPack.byteLength))
    if (!b) fail(`${kind} history: the WASM's pack does not read (${rsPack.length} against ${tsPack.length} bytes)`)
    else {
      const parts = { arrival: (x) => x.people.arrival, from: (x) => x.people.from, flow: (x) => x.people.flow, crossings: (x) => x.people.crossings, population: (x) => x.lifeways.population, farmAt: (x) => x.lifeways.farmAt, villages: (x) => x.lifeways.villages.villages }
      for (const [name, get] of Object.entries(parts)) same(`${kind} history ${name}`, get(a), get(b))
      const la = JSON.stringify(a.log), lb = JSON.stringify(b.log)
      if (la !== lb) {
        let k = 0
        while (k < a.log.length && JSON.stringify(a.log[k]) === JSON.stringify(b.log[k])) k++
        fail(`${kind} history log: differs from event ${k} on (${JSON.stringify(a.log[k])} against ${JSON.stringify(b.log[k])})`)
      }
      fail(`${kind} history: the packs differ (${tsPack.length} against ${rsPack.length} bytes)`)
    }
  }
  const count = (k) => history.log.filter((e) => e.kind === k).length
  // What the world reached, for `reaches` (both worlds together).
  for (const e of history.log) seen.add(e.kind === 'centre' ? `centre ${e.lifeway}` : e.kind)
  // The ice: a cell lived in, left (its people gone in a kept state), lived
  // in again.
  const frames = history.kept
  for (let i = 0; i < h.count && !seen.has('ice'); i++) {
    let was = 0
    for (const f of frames) {
      const p = f.people[i] > 0
      if (was === 0 && p) was = 1
      else if (was === 1 && !p) was = 2
      else if (was === 2 && p) {
        seen.add('ice')
        break
      }
    }
  }
  if (process.env.HISTORY_DEBUG) {
    const herds = fauna.filter((a) => HERD_ANIMALS.has(a.id))
    const byLm = new Map()
    for (let i = 0; i < h.count; i++) {
      if (!h.land[i] || !(history.people.arrival[i] < Infinity)) continue
      const wild = herds.filter((a) => a.codes[i] >= 2).length
      const pas = h.ecology.pasture[i]
      const m = h.landmass[i]
      const e = byLm.get(m) ?? { cells: 0, pasture: 0, two: 0, both: 0 }
      e.cells++
      if (pas >= 0.5) e.pasture++
      if (wild >= 2) e.two++
      if (pas >= 0.5 && wild >= 2) e.both++
      byLm.set(m, e)
    }
    console.log(kind, 'herd candidates by landmass', JSON.stringify([...byLm]))
  }
  console.log(`history: ${kind} — ${count('crossing')} crossings, ${count('centre')} centres, ${count('village')} villages, ${count('camp')} camps, ${count('famine')} famines, ${count('extinct')} extinctions (TS ${Math.round(tsRun)} ms, WASM ${Math.round(rsRun)} ms)`)
  rs.free()
}

// THE REACH: each kind of event at least once on the two worlds, or the
// check passes on less than it claims; then the worlds are to be changed.
const reaches = ['departure', 'crossing', 'centre 4', 'centre 3', 'domesticated', 'extinct', 'famine', 'village', 'villageLeft', 'camp', 'campLeft', 'population', 'ice']
for (const r of reaches) if (!seen.has(r)) fail(`the worlds no longer reach ${r}: the check would pass on less than it claims`)
if (failed) process.exit(1)
console.log('history: the WASM build gives the TypeScript\'s bits')
