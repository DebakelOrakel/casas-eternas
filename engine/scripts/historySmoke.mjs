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
  const blobs = [[0.2, 0.42, 0.26, 0.5], [0.62, 0.36, 0.2, 0.5], [0.84, 0.7, 0.16, 0.45], [0.425, 0.4, 0.04, 0.35], [0.47, 0.38, 0.035, 0.35], [0.5, 0.06, 0.3, 0.42], [0.3, 0.82, 0.12, 0.45]]
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
  rs.free()
}

if (failed) process.exit(1)
console.log('history: the WASM build gives the TypeScript\'s bits')
