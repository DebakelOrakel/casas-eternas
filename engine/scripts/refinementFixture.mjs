// Writes the module test fixture for the climate's refinement: hashes of
// what the TypeScript engine's climate/refinement.ts (with pressure,
// energyBalance, phenomena, reliability, storms, salinity) makes of an
// analytic terrain on both shapes, and of the climate at points it gives,
// which the Rust port must make bit for bit (docs/decisions/rust-engine.md,
// fork 5).
//
//   node engine/scripts/refinementFixture.mjs           write the fixture
//   node engine/scripts/refinementFixture.mjs --check   fail if it is stale
//
// Half a minute or so: `make test` checks it, not `make lint`.
// crates/casas-engine/tests/refinement.rs runs the same scenarios: change
// one, change the other.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('../../client', import.meta.url))
const OUT = new URL('../crates/casas-engine/tests/fixtures/refinement.txt', import.meta.url)

const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
const D = await L('/src/generator/core/domain.ts')
const { detSin, detCos } = await L('/src/generator/core/detMath.ts')
const CM = await L('/src/generator/climate/climateMesh.ts')
const WE = await L('/src/generator/climate/weather.ts')
const R = await L('/src/generator/climate/refinement.ts')
const EB = await L('/src/generator/climate/energyBalance.ts')
const CP = await L('/src/generator/climate/climatePoints.ts')
const B = await L('/src/generator/climate/biomes.ts')
const PF = await L('/src/generator/planet/planetForcing.ts')
const CC = await L('/src/generator/climate/climateChart.ts')
await server.close()

const f = new Float64Array(1)
const w = new Uint32Array(f.buffer)
let h = 0
const add = (v) => {
  if (v === true) v = 1
  else if (v === false) v = 0
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
  '# Hashes of client/src/generator/climate/refinement.ts and its parts, for crates/casas-engine/tests/refinement.rs.',
  '# Written by engine/scripts/refinementFixture.mjs; do not edit.',
]
const line = (name) => lines.push(`${name} ${hex()}`)
const solveHash = (s) => { add(s.iterations); add(s.residual); add(s.converged) }

h = 0x811c9dc5
for (let k = 0; k <= 300; k++) {
  const planet = { ...PF.DEFAULT_PLANET_FORCING, obliquityDeg: 10 + (k % 31), eccentricity: (k % 7) * 0.01, precessionDeg: k * 3, solarConstant: 0.95 + (k % 11) * 0.01 }
  add(EB.monthInsolation(((k % 61) - 30) * 0.05, (k % 24) / 24, planet))
}
line('insolation')

const W = 2048
const H = 1024
const heightAt = (x, y) => 0.08 * detSin(x * 0.006) * detCos(y * 0.009) + 0.04 * detSin(x * 0.021 + y * 0.013) + 0.02 * detCos(x * 0.05 - y * 0.03) + 0.05 * Math.max(0, detSin(x * 0.004 + 1) * detSin(y * 0.007)) - 0.03
const elevation = new Float32Array(W * H)
for (let i = 0; i < elevation.length; i++) elevation[i] = heightAt((i % W) + 0.5, Math.floor(i / W) + 0.5)

let state = 3
const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0)
const uniform = (lo, hi) => lo + (hi - lo) * (next() / 4294967296)

for (const [name, d] of [['torus', D.torusDomain(W, H)], ['sphere', D.sphereDomain(W, H)]]) {
  let last = null
  for (const [variant, params] of [
    ['default', WE.defaultWeatherParams()],
    ['moved', { temperatureOffset: -2, temperatureContrast: 0.9, humidity: 1.3, equatorOffset: 0, planet: { ...PF.DEFAULT_PLANET_FORCING, obliquityDeg: 28, rotationHours: 20, eccentricity: 0.04, precessionDeg: 200 } }],
  ]) {
    const terrain = CM.climateTerrain(d, elevation, W, H)
    const { mesh: wm } = WE.computeWeather(terrain, params)
    const r = R.refineClimate(elevation, d, params, wm.temperature, wm.wind)
    h = 0x811c9dc5
    add(r.months)
    add(r.cells)
    add(r.spacingM)
    for (const k of ['temperature', 'precipitation', 'pressure', 'windE', 'windS', 'currentE', 'currentS', 'currentAnomaly', 'upwelling', 'salinity', 'deepWater', 'fog', 'foehn']) addAll(r[k])
    addAll(r.reliability.rainVariability)
    addAll(r.reliability.ensoPattern)
    add(r.reliability.ensoPeriodYears)
    add(r.reliability.ensoStrength)
    for (const k of R.REFINED_STORMS) addAll(r.storms[k])
    solveHash(r.solves.currents)
    solveHash(r.solves.inflow)
    for (const s of r.solves.cycle) solveHash(s)
    line(`${name}_refined_${variant}`)

    const cells = CP.climateCellsFromRefined(r, terrain)
    state = 3
    const count = 4000
    const xs = new Float64Array(count)
    const ys = new Float64Array(count)
    const height = new Float32Array(count)
    const land = new Uint8Array(count)
    for (let i = 0; i < count; i++) {
      xs[i] = uniform(0, d.width)
      ys[i] = uniform(0, d.height)
      height[i] = uniform(-0.1, 0.5)
      land[i] = height[i] > 0 || i % 6 === 0 ? 1 : 0
    }
    const points = { count, x: xs, y: ys, height, land, dry: null, alive: null }
    const at = CP.climateAtPoints(cells, points, { wind: true })
    h = 0x811c9dc5
    for (const k of ['seaLevelTemperature', 'precipitation', 'seasonalAmplitude', 'monsoonIndex', 'windE', 'windS']) addAll(cells[k])
    addAll(cells.months.seaLevelTemperature)
    for (const k of ['seaLevelTemperature', 'temperature', 'precipitation', 'seasonalAmplitude', 'monsoonIndex', 'upwelling', 'rainVariability', 'windE', 'windS']) addAll(at[k])
    addAll(at.months.temperature)
    addAll(at.months.precipitation)
    const b = B.classifyPoints(at, points, d)
    addAll(b.biome)
    addAll(b.koppen)
    line(`${name}_points_${variant}`)
    last = { terrain, wm, r, cells }
  }

  // The charts of the last variant (climate/climateChart.ts).
  const { terrain, wm, r, cells } = last
  h = 0x811c9dc5
  const wc = CC.weatherChart({ terrain, mesh: wm })
  for (const k of ['temperature', 'wind', 'seasonalAmplitude', 'precipitation', 'monsoonIndex', 'currents', 'currentAnomaly']) addAll(wc[k])
  const rc = CC.refinedChart(r, terrain)
  for (const k of ['temperature', 'precipitation', 'pressure', 'wind', 'currents', 'currentAnomaly', 'upwelling', 'salinity', 'deepWater', 'fog', 'foehn']) addAll(rc[k])
  addAll(rc.reliability.rainVariability)
  addAll(rc.reliability.ensoPattern)
  for (const k of R.REFINED_STORMS) addAll(rc.storms[k])
  const chartTerrain = { domain: d, elevation, resX: W, resY: H, dryLand: null }
  for (const [rx, ry] of [[256, 128], [512, 256]]) {
    const cc = CC.cellsChart(cells, chartTerrain, rx, ry)
    for (const k of ['temperature', 'precipitation', 'seasonalAmplitude', 'monsoonIndex', 'landMask']) addAll(cc[k])
  }
  line(`${name}_chart`)
}

const text = lines.join('\n') + '\n'
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('engine/crates/casas-engine/tests/fixtures/refinement.txt is stale — run node engine/scripts/refinementFixture.mjs')
    process.exit(1)
  }
} else {
  writeFileSync(OUT, text)
  console.log(`refinement fixture: ${lines.length - 2} lines`)
}
