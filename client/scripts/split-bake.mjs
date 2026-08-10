// Bake a saved world twice — once whole, once cut into regions — and show the
// difference. A DEBUGGING tool, not a harness: it exists because the split
// bake's divergence from a whole one is chaotic (see
// docs/design/splitting-the-bake.md, "the accuracy failure is explained"), and
// numbers alone do not say where on the map it lives or what it looks like.
//
//   node --max-old-space-size=8192 scripts/split-bake.mjs <world.zip> [factor] [regions]
//
//   factor   2 → 4096x2048, 4 → 8192x4096 (default 2). 4 needs ~12 GB of heap.
//   regions  how many jobs to cut the land into (default 4)
//
// Writes into ./split-bake-out/:
//   whole.f32   the undivided bake's elevation (Float32, row-major)
//   split.f32   the composite of the region bakes, same layout
//   diff.png    |Δ| in metres, log-scaled heatmap: dark = exact,
//               blue ≈ 1 m, yellow ≈ 30 m, red ≥ 1000 m; ocean is near-black
//
// This is the comparison that only exists at or below 8K — above that there is
// no whole bake to be the second operand, which is exactly why the user asked
// for 8K splitting to stay reachable (the design doc holds that rule).
//
// The requests mirror scripts/bake.ts field for field — same save reader, same
// seed, same erosion controls, production's AMPLIFY_EROSION_ROUNDS — so what is
// measured is the split, not a second opinion about the parameters.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const zipPath = process.argv[2]
const FACTOR = Number(process.argv[3] ?? 2)
const REGIONS = Number(process.argv[4] ?? 4)
if (!zipPath || !Number.isInteger(FACTOR) || FACTOR < 1 || !Number.isInteger(REGIONS) || REGIONS < 2) {
  console.error('usage: node --max-old-space-size=8192 scripts/split-bake.mjs <world.zip> [factor] [regions>=2]')
  process.exit(2)
}

const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
const M = {
  inputs: await L('/src/world/save/loadWorldInputs.ts'),
  amplify: await L('/src/worldgen/surface/runAmplification.ts'),
  plan: await L('/src/worldgen/surface/bakePlan.ts'),
  scale: await L('/src/worldgen/elevation/elevationScale.ts'),
  settings: await L('/src/world/bakeSettings.ts'),
}
const { SEA_LEVEL } = M.scale
const METRES = 9000

const raw = readFileSync(zipPath)
const inputs = await M.inputs.readWorldInputs(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
if (!inputs) { console.error(`${zipPath}: not a readable world archive`); process.exit(1) }
const MW = inputs.width, MH = inputs.height
const W = MW * FACTOR, H = MH * FACTOR
console.log(`${basename(zipPath)}: ${MW}x${MH} macro, factor ${FACTOR} -> ${W}x${H}`)
if (!inputs.climate) console.log('  (no climate in this save: no rivers, and the channel-threshold scalars stay 0)')

// The request scripts/bake.ts builds, minus the job envelope.
const REQUEST = {
  elevation: inputs.elevations,
  macroWidth: MW,
  macroHeight: MH,
  factor: FACTOR,
  seed: inputs.detailSeed,
  erosionRounds: M.settings.AMPLIFY_EROSION_ROUNDS,
  erosionStrength: inputs.erosionControls.strength,
  drainageRefresh: inputs.erosionControls.refresh,
  precipitation: inputs.climate?.data,
  climateResX: inputs.climate?.resX,
  climateResY: inputs.climate?.resY,
  riverDensity: inputs.erosionControls.riverDensity,
}

let macroLand = 0
for (let i = 0; i < inputs.elevations.length; i++) if (inputs.elevations[i] > SEA_LEVEL) macroLand++

console.log('\nplanning ...')
const plan = await M.plan.planBake({
  elevation: inputs.elevations, width: MW, height: MH,
  precipitation: inputs.climate?.data, climateResX: inputs.climate?.resX, climateResY: inputs.climate?.resY,
  budgetCells: Math.ceil(macroLand / REGIONS),
})
console.log(`  ${plan.groups.length} regions (asked for ${REGIONS}); macro cells ${plan.groups.map((g) => g.cells).join(', ')}`)

console.log('\nbaking whole ...')
let t = Date.now()
const whole = await M.amplify.runAmplification(REQUEST)
const wholeMs = Date.now() - t
console.log(`  ${Math.round(wholeMs / 1000)}s, ${whole.rivers.lengths.length} river polylines`)

// Ownership comes from the SEEDED field: amplification gives the coastline
// islands the macro raster never had, and those cells must belong to somebody.
const seeded = await M.amplify.runAmplification({ ...REQUEST, erosionRounds: 0 })
const ownership = M.plan.fineOwnership(plan, MW, MH, seeded.elevation, FACTOR)

console.log('\nbaking region by region ...')
const composite = new Float32Array(W * H)
const writes = new Uint8Array(W * H)
let riverTotal = 0
let splitMs = 0
let slowest = 0
for (let g = 0; g < plan.groups.length; g++) {
  const owned = new Uint8Array(W * H)
  let cells = 0
  for (let i = 0; i < ownership.length; i++) if (ownership[i] === g) { owned[i] = 1; cells++ }
  if (cells === 0) { console.log(`  region ${g}: owns no fine cells, skipped`); continue }
  t = Date.now()
  const piece = await M.amplify.runAmplification({
    ...REQUEST,
    region: { owned, haloCells: M.amplify.DEFAULT_HALO_CELLS },
    maxDischarge: plan.maxDischarge, meanRunoff: plan.meanRunoff,
  })
  const ms = Date.now() - t
  splitMs += ms
  if (ms > slowest) slowest = ms
  riverTotal += piece.rivers.lengths.length
  for (let i = 0; i < owned.length; i++) {
    if (!owned[i]) continue
    writes[i]++
    composite[i] = piece.elevation[i]
  }
  console.log(`  region ${g}: ${cells} fine cells, ${Math.round(ms / 1000)}s, ${piece.rivers.lengths.length} polylines`)
}

// Everything a region does not own it left drowned; the composite fills those
// cells from the whole bake so the two rasters differ only where the split
// itself differs — otherwise the heatmap would be dominated by the ocean the
// regions never claimed to compute.
for (let i = 0; i < writes.length; i++) if (!writes[i]) composite[i] = whole.elevation[i]

let twice = 0
for (let i = 0; i < writes.length; i++) if (writes[i] > 1) twice++
let neverLand = 0
for (let i = 0; i < writes.length; i++) if (!writes[i] && seeded.elevation[i] > SEA_LEVEL) neverLand++
console.log(`\ncoverage: ${twice} cells written twice, ${neverLand} land cells written by nobody (both should be 0)`)
console.log(`rivers: whole ${whole.rivers.lengths.length}, regions together ${riverTotal}`)

// --- the difference ----------------------------------------------------------
const sample = []
let n = 0, sum = 0, worst = 0, over1 = 0, over10 = 0, over50 = 0
let worstAt = ''
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = y * W + x
    if (!writes[i]) continue
    const d = Math.abs(composite[i] - whole.elevation[i]) * METRES
    n++; sum += d
    if (d > 1) over1++
    if (d > 10) over10++
    if (d > 50) over50++
    if (d > worst) { worst = d; worstAt = `(${x},${y})` }
    if (n % 97 === 0) sample.push(d)
  }
}
sample.sort((a, b) => a - b)
const q = (f) => sample[Math.min(sample.length - 1, Math.floor(sample.length * f))] ?? 0
console.log(`\nsplit vs whole over ${n} owned cells:`)
console.log(`  mean ${(sum / Math.max(1, n)).toFixed(3)} m; median ${q(0.5).toFixed(3)} m, p90 ${q(0.9).toFixed(2)} m, p99 ${q(0.99).toFixed(2)} m`)
console.log(`  over 1 m: ${((over1 / n) * 100).toFixed(2)}%   over 10 m: ${((over10 / n) * 100).toFixed(3)}%   over 50 m: ${((over50 / n) * 100).toFixed(4)}%`)
console.log(`  worst ${worst.toFixed(1)} m at ${worstAt}`)
console.log(`\ntime: whole ${Math.round(wholeMs / 1000)}s; regions ${Math.round(splitMs / 1000)}s total, slowest ${Math.round(slowest / 1000)}s`)
console.log(`      (the slowest region is the wall clock if they ran in parallel: ${(wholeMs / Math.max(1, slowest)).toFixed(2)}x vs whole)`)

// --- outputs -----------------------------------------------------------------
const OUT = join(process.cwd(), 'split-bake-out')
mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'whole.f32'), Buffer.from(whole.elevation.buffer, whole.elevation.byteOffset, whole.elevation.byteLength))
writeFileSync(join(OUT, 'split.f32'), Buffer.from(composite.buffer))

// |Δ| as a log-scaled heatmap. Log because the interesting range spans five
// orders of magnitude: quantisation-level metres next to kilometre outliers,
// and a linear ramp would show only the outliers.
const rgb = new Uint8Array(W * H * 3)
// dark → blue → cyan → yellow → red over 0.1 m .. 1000 m (four decades)
const STOPS = [
  [0.0, 16, 16, 20],
  [0.25, 40, 80, 200],
  [0.5, 60, 200, 220],
  [0.75, 240, 220, 60],
  [1.0, 230, 40, 30],
]
const ramp = (tt) => {
  for (let s = 1; s < STOPS.length; s++) {
    if (tt <= STOPS[s][0]) {
      const [t0, r0, g0, b0] = STOPS[s - 1]
      const [t1, r1, g1, b1] = STOPS[s]
      const f = (tt - t0) / (t1 - t0)
      return [r0 + (r1 - r0) * f, g0 + (g1 - g0) * f, b0 + (b1 - b0) * f]
    }
  }
  return STOPS[STOPS.length - 1].slice(1)
}
for (let i = 0; i < W * H; i++) {
  let r = 8, g2 = 8, b = 12 // unowned (ocean): near-black, so land structure reads
  if (writes[i]) {
    const d = Math.abs(composite[i] - whole.elevation[i]) * METRES
    const tt = d <= 0.1 ? 0 : Math.min(1, Math.log10(d / 0.1) / 4)
    ;[r, g2, b] = ramp(tt)
  }
  rgb[i * 3] = r; rgb[i * 3 + 1] = g2; rgb[i * 3 + 2] = b
}
writeFileSync(join(OUT, 'diff.png'), pngRGB(W, H, rgb))
console.log(`\nwrote ${OUT}/whole.f32, split.f32 (${W}x${H} Float32) and diff.png`)

// Minimal PNG encoder: 8-bit RGB, filter 0 on every scanline. Hand-rolled
// because this script has no browser canvas and the repo has no Node image
// dependency — and a PNG is just three chunks around a deflate stream.
function pngRGB(width, height, pixels) {
  const rows = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    rows[y * (width * 3 + 1)] = 0
    Buffer.from(pixels.buffer, pixels.byteOffset + y * width * 3, width * 3)
      .copy(rows, y * (width * 3 + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 2   // colour type: truecolour
  const chunk = (type, data) => {
    const out = Buffer.alloc(data.length + 12)
    out.writeUInt32BE(data.length, 0)
    out.write(type, 4, 'ascii')
    data.copy(out, 8)
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
    return out
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
function crc32(buf) {
  let crc = ~0
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]
    for (let b = 0; b < 8; b++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return ~crc >>> 0
}

await server.close()
