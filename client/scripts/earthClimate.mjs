// The climate refinement's instrument on Earth (docs/design/climate-refinement.md,
// the calibration): the generator's climate run on Earth's own relief, and
// compared where the answer is known — about fifty places with their
// Köppen–Geiger class, January and July mean temperature and annual rain
// (rounded climate normals), and every land cell against Beck et al.'s
// Köppen–Geiger map for 1991–2020 (scripts/fixtures/earth-koppen.tif): the
// share of the land with the right class and group, the groups' shares and
// where each real group ends up. Not a gate: it prints the table and a
// score the calibration is judged on, so a change reads as better or worse.
//
//   node scripts/earthClimate.mjs [heightmap.png] [key=value …]
//
// The heightmap is an 8-bit grayscale equirectangular PNG, west edge at
// −180°, north at the top, with the sea's floor in it:
// scripts/fixtures/earth-heightmap.png unless another is named. Its scale
// was read off the file itself (2026-09-29): sea level between 158 and 159
// (the 29 % of Earth that is land lies above 158.5, area-weighted; the
// Netherlands, the Amazon and the Dead Sea all read 159); land 61.6 m per
// level, fitted on thirteen cities and plateaus from Munich (520 m, 167)
// to Lake Titicaca (3812 m, 219), within 10 % — so 255 is some 5940 m and
// the high peaks are cut off there (Everest and K2 both read 241–255); sea
// to −10 994 m at 0 (the Mariana Trench reads 15; abyssal plains and
// trenches give 55–75 m per level, so the sea's scale is rougher). A first
// reading took the land up to 8849 m at 255, which put every highland
// 1.4–1.7 times too high (Lhasa 6200 m) and left Tibet at −16 °C in July. Any key=value is set on CLIMATE_TUNING first,
// so a constant can be tried without editing it.
//
// Earth runs at the generator's scale: 2048 cells round, some 16 000 km,
// about 1 : 2.5. The climate's constants work per cell, so that is the
// world they are meant for; a distance a constant names ("fog reaches two
// cells inland") is read at that scale. The torus joins the poles, so the
// high latitudes are the least trustworthy part of the comparison.
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const args = process.argv.slice(2)
const png = args.find((a) => !a.includes('=')) ?? `${CLIENT}/scripts/fixtures/earth-heightmap.png`

const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
const M = {
  weather: await L('/src/generator/climate/weather.ts'),
  refinement: await L('/src/generator/climate/refinement.ts'),
  biomes: await L('/src/generator/climate/biomes.ts'),
  koppen: await L('/src/generator/climate/koppen.ts'),
  tune: await L('/src/generator/climate/climateTuneParams.ts'),
  scale: await L('/src/generator/elevation/elevationScale.ts'),
}
for (const a of args.filter((x) => x.includes('='))) {
  const [k, v] = a.split('=')
  if (!(k in M.tune.CLIMATE_TUNING)) { console.error(`no such constant: ${k}`); process.exit(2) }
  M.tune.CLIMATE_TUNING[k] = Number(v)
}
// Earth at this scale has its heights on a 2.5 times shorter distance, so
// every slope is 2.5 times too steep. The upslope rain is the one term that
// reads a slope: it runs at 1/2.5 of its rate here (after any key=value).
M.tune.CLIMATE_TUNING.precipOrographicRate /= 2.5

// --- the heightmap -----------------------------------------------------------

function decodeGrayPng(bytes) {
  let o = 8, width = 0, height = 0
  const idat = []
  while (o < bytes.length) {
    const len = bytes.readUInt32BE(o), type = bytes.toString('ascii', o + 4, o + 8), data = bytes.subarray(o + 8, o + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4)
      if (data[8] !== 8 || data[9] !== 0) throw new Error('expected an 8-bit grayscale PNG')
    }
    if (type === 'IDAT') idat.push(data)
    o += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const px = new Uint8Array(width * height)
  let prev = new Uint8Array(width)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (width + 1)]
    const row = raw.subarray(y * (width + 1) + 1, (y + 1) * (width + 1))
    const cur = new Uint8Array(width)
    for (let x = 0; x < width; x++) {
      const a = x ? cur[x - 1] : 0, b = prev[x], c = x ? prev[x - 1] : 0
      let v = row[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c }
      cur[x] = v & 255
    }
    px.set(cur, y * width)
    prev = cur
  }
  return { px, width, height }
}

const SEA_GRAY = 158.5
const metres = (v) => (v >= SEA_GRAY ? (v - SEA_GRAY) * 61.6 : ((v - SEA_GRAY) * 10994) / SEA_GRAY)
const W = 2048, H = 1024
const map = decodeGrayPng(readFileSync(png))
const sx = map.width / W, sy = map.height / H
// North goes to the BOTTOM rows: the map is drawn mirrored in y, so they are
// the screen's upper half, the half with the northern calendar
// (climateField.TOP_SUMMER_MONTH). Every latitude below is read the same
// way: row = (90° + lat) / 180° of the height.
const elevation = new Float32Array(W * H)
for (let y = 0; y < H; y++) {
  const my = H - 1 - y
  for (let x = 0; x < W; x++) {
    let sum = 0, count = 0
    for (let dy = 0; dy < sy; dy++) for (let dx = 0; dx < sx; dx++) { sum += metres(map.px[(my * sy + dy) * map.width + x * sx + dx]); count++ }
    elevation[y * W + x] = M.scale.metersToElevation(sum / count)
  }
}

// --- the climate ---------------------------------------------------------------

const params = M.weather.defaultWeatherParams()
const cheap = M.weather.computeWeather(elevation, W, H, params)
const started = performance.now()
const r = M.refinement.refineClimate(elevation, W, H, params, cheap.temperature, cheap.wind)
const ms = performance.now() - started
const RX = 256, RY = 128, n = RX * RY
const land = (i) => r.precipitation[i] >= 0
// The months' temperatures at sea level (the lapse of the cell's own sampled
// height taken off), so a place can be given its own height back.
const seaLevel = []
for (let m = 0; m < 12; m++) seaLevel.push(M.biomes.reduceTemperatureToSeaLevel(r.temperature.subarray(m * n, (m + 1) * n), elevation, W, H))
const lapsePerM = M.tune.CLIMATE_TUNING.lapseCPerElevation / M.scale.ELEVATION_METERS

// --- the places ---------------------------------------------------------------

// name, lon, lat, height m, Köppen, January °C, July °C, rain mm/yr.
const PLACES = [
  ['London', -0.1, 51.5, 20, 'Cfb', 5, 19, 600], ['Paris', 2.35, 48.85, 40, 'Cfb', 5, 20, 640],
  ['Rome', 12.5, 41.9, 20, 'Csa', 8, 25, 800], ['Madrid', -3.7, 40.4, 650, 'Csa', 6, 26, 420],
  ['Istanbul', 29, 41, 40, 'Csa', 6, 24, 800], ['Oslo', 10.7, 59.9, 20, 'Dfb', -4, 17, 760],
  ['Moscow', 37.6, 55.8, 150, 'Dfb', -7, 19, 700], ['Reykjavik', -21.9, 64.1, 20, 'Cfc', 0, 11, 850],
  ['Cairo', 31.2, 30, 20, 'BWh', 14, 28, 25], ['Riyadh', 46.7, 24.7, 610, 'BWh', 15, 36, 100],
  ['Tehran', 51.4, 35.7, 1200, 'BSk', 3, 30, 230], ['Delhi', 77.2, 28.6, 220, 'Cwa', 14, 31, 800],
  ['Mumbai', 72.9, 19.1, 10, 'Am', 24, 28, 2300], ['Kolkata', 88.4, 22.6, 10, 'Aw', 20, 29, 1600],
  ['Yakutsk', 129.7, 62, 100, 'Dfd', -38, 19, 240], ['Beijing', 116.4, 39.9, 50, 'Dwa', -3, 27, 570],
  ['Shanghai', 121.5, 31.2, 5, 'Cfa', 5, 29, 1200], ['Tokyo', 139.7, 35.7, 20, 'Cfa', 5, 26, 1530],
  ['Singapore', 103.8, 1.35, 20, 'Af', 27, 28, 2400], ['Jakarta', 106.8, -6.2, 10, 'Am', 27, 28, 1800],
  ['Darwin', 130.8, -12.5, 30, 'Aw', 29, 25, 1700], ['Alice Springs', 133.9, -23.7, 550, 'BWh', 29, 12, 280],
  ['Perth', 115.9, -31.9, 20, 'Csa', 25, 13, 730], ['Sydney', 151.2, -33.9, 40, 'Cfa', 23, 13, 1200],
  ['Cape Town', 18.4, -33.9, 40, 'Csb', 21, 13, 520], ['Johannesburg', 28, -26.2, 1750, 'Cwb', 20, 10, 710],
  ['Nairobi', 36.8, -1.3, 1800, 'Cwb', 18, 16, 900], ['Kinshasa', 15.3, -4.3, 300, 'Aw', 26, 23, 1400],
  ['Lagos', 3.4, 6.5, 40, 'Aw', 27, 25, 1500], ['Dakar', -17.4, 14.7, 20, 'BSh', 21, 27, 400],
  ['New York', -74, 40.7, 10, 'Cfa', 1, 25, 1200], ['Chicago', -87.6, 41.9, 180, 'Dfa', -5, 23, 950],
  ['Miami', -80.2, 25.8, 5, 'Am', 20, 29, 1550], ['Denver', -105, 39.7, 1600, 'BSk', -1, 23, 400],
  ['Los Angeles', -118.2, 34, 70, 'Csb', 14, 21, 380], ['Seattle', -122.3, 47.6, 50, 'Csb', 5, 19, 950],
  ['Winnipeg', -97.1, 49.9, 240, 'Dfb', -16, 20, 520], ['Anchorage', -149.9, 61.2, 40, 'Dfc', -9, 15, 420],
  ['Nuuk', -51.7, 64.2, 20, 'ET', -7, 7, 750], ['Mexico City', -99.1, 19.4, 2240, 'Cwb', 14, 18, 800],
  ['Lima', -77, -12, 150, 'BWh', 23, 17, 10], ['Bogota', -74.1, 4.7, 2640, 'Cfb', 14, 14, 1000],
  ['Manaus', -60, -3.1, 90, 'Af', 26, 27, 2300], ['Brasilia', -47.9, -15.8, 1170, 'Aw', 22, 20, 1500],
  ['Buenos Aires', -58.4, -34.6, 25, 'Cfa', 25, 11, 1200], ['Santiago', -70.7, -33.4, 520, 'Csb', 21, 9, 310],
  ['Ushuaia', -68.3, -54.8, 20, 'Cfc', 10, 2, 550],
]

// The nearest land cell to a place, within three cells: a 62 km cell on a
// coast is often sea.
function nearestLand(lon, lat) {
  const gx = Math.floor(((lon + 180) / 360) * RX), gy = Math.min(RY - 1, Math.floor(((90 + lat) / 180) * RY))
  let best = -1, bestD = Infinity
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    const x = (gx + dx + RX) % RX, y = gy + dy
    if (y < 0 || y >= RY) continue
    const i = y * RX + x
    if (!land(i)) continue
    const d = dx * dx + dy * dy
    if (d < bestD) { bestD = d; best = i }
  }
  return best
}

let exact = 0, group = 0, janErr = 0, julErr = 0, meanErr = 0, swingErr = 0, rainErr = 0, counted = 0
const rows = []
for (const [name, lon, lat, height, realClass, realJan, realJul, realRain] of PLACES) {
  const i = nearestLand(lon, lat)
  if (i < 0) { rows.push(`${name.padEnd(13)} no land cell`); continue }
  const t = new Float64Array(12), p = new Float64Array(12)
  let rain = 0
  for (let m = 0; m < 12; m++) {
    t[m] = seaLevel[m][i] - lapsePerM * height
    p[m] = Math.max(0, r.precipitation[m * n + i]) / 12
    rain += p[m]
  }
  const cls = M.koppen.koppenCode(M.koppen.classifyKoppen(t, p)) ?? '—'
  counted++
  if (cls === realClass) exact++
  if (cls[0] === realClass[0]) group++
  janErr += Math.abs(t[0] - realJan)
  julErr += Math.abs(t[6] - realJul)
  // The same two months as a mean and a swing (July − January, signed by
  // hemisphere through the data): which of the two is off.
  meanErr += (t[0] + t[6]) / 2 - (realJan + realJul) / 2
  swingErr += Math.abs(t[6] - t[0]) - Math.abs(realJul - realJan)
  rainErr += Math.abs(Math.log((rain + 50) / (realRain + 50)))
  rows.push(`${name.padEnd(13)} ${realClass.padEnd(4)}→ ${cls.padEnd(4)} ${cls === realClass ? ' ' : cls[0] === realClass[0] ? '~' : '✗'}  Jan ${String(realJan).padStart(4)}→${t[0].toFixed(0).padStart(4)}  Jul ${String(realJul).padStart(4)}→${t[6].toFixed(0).padStart(4)}  rain ${String(realRain).padStart(5)}→${String(Math.round(rain)).padStart(5)}`)
}
console.log(rows.join('\n'))

// --- the Köppen map ------------------------------------------------------------

// Beck et al.'s Köppen–Geiger map for 1991–2020 at 0.5°
// (scripts/fixtures/earth-koppen.tif, its legend beside it): a GeoTIFF of
// 720×360 bytes, deflate-compressed strips, west edge −180°, north +90°,
// 0 the sea. Read here for what this file needs and no more.
function decodeKoppenTiff(bytes) {
  if (bytes.toString('ascii', 0, 2) !== 'II') throw new Error('expected a little-endian TIFF')
  const ifd = bytes.readUInt32LE(4)
  const tags = new Map()
  for (let k = 0; k < bytes.readUInt16LE(ifd); k++) {
    const o = ifd + 2 + 12 * k
    const type = bytes.readUInt16LE(o + 2), count = bytes.readUInt32LE(o + 4)
    const size = type === 3 ? 2 : 4
    const at = count * size <= 4 ? o + 8 : bytes.readUInt32LE(o + 8)
    const values = []
    for (let j = 0; j < Math.min(count, 64); j++) values.push(type === 3 ? bytes.readUInt16LE(at + 2 * j) : bytes.readUInt32LE(at + 4 * j))
    tags.set(bytes.readUInt16LE(o), values)
  }
  const width = tags.get(256)[0], height = tags.get(257)[0]
  if (tags.get(258)[0] !== 8 || tags.get(259)[0] !== 8 || (tags.get(317)?.[0] ?? 1) !== 1) throw new Error('expected 8-bit deflate strips without a predictor')
  const offsets = tags.get(273), lengths = tags.get(279)
  const px = new Uint8Array(width * height)
  let at = 0
  for (let k = 0; k < offsets.length; k++) {
    const strip = inflateSync(bytes.subarray(offsets[k], offsets[k] + lengths[k]))
    px.set(strip.subarray(0, Math.min(strip.length, px.length - at)), at)
    at += strip.length
  }
  return { px, width, height }
}
const koppenMap = decodeKoppenTiff(readFileSync(`${CLIENT}/scripts/fixtures/earth-koppen.tif`))
const legend = new Map(readFileSync(`${CLIENT}/scripts/fixtures/earth-koppen-legend.txt`, 'utf8').split('\n').slice(1)
  .map((line) => line.split('\t')).filter((f) => f.length > 1 && f[1] !== '-').map((f) => [Number(f[0]), f[1]]))

// Per climate cell, the class most of its map cells have (land only), and
// the comparison over the cells that are land in both, weighted by area.
// The world's shares of the five groups, over each one's land.
const GROUPS = ['A', 'B', 'C', 'D', 'E']
const share = { A: 0, B: 0, C: 0, D: 0, E: 0 }
const beck = { A: 0, B: 0, C: 0, D: 0, E: 0 }
const confusion = Object.fromEntries(GROUPS.map((g) => [g, { A: 0, B: 0, C: 0, D: 0, E: 0 }]))
let area = 0, beckArea = 0, both = 0, cellsExact = 0, cellsGroup = 0
const kx = koppenMap.width / RX, ky = koppenMap.height / RY
for (let y = 0; y < RY; y++) {
  const w = Math.cos(((y + 0.5) / RY - 0.5) * Math.PI)
  for (let x = 0; x < RX; x++) {
    const counts = new Map()
    const ry = RY - 1 - y
    for (let my = Math.floor(ry * ky); my < Math.floor((ry + 1) * ky); my++) {
      for (let mx = Math.floor(x * kx); mx < Math.floor((x + 1) * kx); mx++) {
        const v = koppenMap.px[my * koppenMap.width + mx]
        if (v) counts.set(v, (counts.get(v) ?? 0) + 1)
      }
    }
    let real = null, most = 0
    for (const [v, c] of counts) if (c > most) { most = c; real = legend.get(v) }
    const code = M.koppen.koppenCode(r.koppen[y * RX + x])
    if (code) { share[code[0]] += w; area += w }
    if (!real || !code) continue
    both += w
    if (code === real) cellsExact += w
    if (code[0] === real[0]) cellsGroup += w
    confusion[real[0]][code[0]] += w
  }
}
// The real shares from the map itself, each 0.5° cell by its area: a
// majority per climate cell overstates the classes of coasts and islands
// (A came out 27 % instead of 23).
for (let my = 0; my < koppenMap.height; my++) {
  const w = Math.cos(((my + 0.5) / koppenMap.height - 0.5) * Math.PI)
  for (let mx = 0; mx < koppenMap.width; mx++) {
    const code = legend.get(koppenMap.px[my * koppenMap.width + mx])
    if (code) { beck[code[0]] += w; beckArea += w }
  }
}
let shareErr = 0
const shares = GROUPS.map((g) => {
  const pct = (100 * share[g]) / area, want = (100 * beck[g]) / beckArea
  shareErr += Math.abs(pct - want)
  return `${g} ${pct.toFixed(0)} (${want.toFixed(0)})`
}).join('  ')
// Where each real group went: of its land, the share per modelled group.
console.log('\nreal → modelled group, % of the real group\'s land:')
for (const g of GROUPS) {
  const total = GROUPS.reduce((s, h) => s + confusion[g][h], 0)
  console.log(`  ${g}: ${GROUPS.map((h) => `${h} ${String(Math.round((100 * confusion[g][h]) / total)).padStart(3)}`).join('  ')}`)
}

// The phase of the year: which month the northern land (10–70° N) is
// warmest in. On Earth nearly all of it in July, a coastal fringe in
// August.
const warmest = new Array(12).fill(0)
for (let y = Math.round(RY * 100 / 180); y < Math.round(RY * 160 / 180); y++) {
  for (let x = 0; x < RX; x++) {
    const i = y * RX + x
    if (!land(i)) continue
    let best = 0
    for (let m = 1; m < 12; m++) if (r.temperature[m * n + i] > r.temperature[best * n + i]) best = m
    warmest[best]++
  }
}
const landN = warmest.reduce((a, b) => a + b, 0)
console.log(`northern land's warmest month, %: ${['Jun', 'Jul', 'Aug', 'Sep'].map((name, k) => `${name} ${Math.round((100 * warmest[k + 5]) / landN)}`).join('  ')}`)
console.log(`\nrefinement ${Math.round(ms)} ms`)
console.log(`Köppen groups, % of land (Beck 1991–2020): ${shares}`)
console.log(`cells: class ${((100 * cellsExact) / both).toFixed(0)} %, group ${((100 * cellsGroup) / both).toFixed(0)} % of the land both have`)
console.log(`places: class ${exact}/${counted}, group ${group}/${counted}; mean |error| January ${(janErr / counted).toFixed(1)} °C, July ${(julErr / counted).toFixed(1)} °C (bias: mean ${(meanErr / counted).toFixed(1)}, swing ${(swingErr / counted).toFixed(1)}), rain ×${Math.exp(rainErr / counted).toFixed(2)}; groups off by ${shareErr.toFixed(0)} points`)
await server.close()
