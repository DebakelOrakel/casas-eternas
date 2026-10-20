// Writes the module test fixture for the engine's static climate: hashes of
// what the TypeScript engine's climate/ (climateMesh, temperature, wind,
// seasonality, precipitation, monsoon, oceanCurrents, weather) and
// planet/planetForcing make of an analytic terrain on both shapes, which
// the Rust port must make bit for bit (docs/decisions/rust-engine.md,
// fork 5).
//
//   node engine/scripts/climateFixture.mjs           write the fixture
//   node engine/scripts/climateFixture.mjs --check   fail if it is stale
//
// crates/casas-engine/tests/climate.rs runs the same scenarios from the
// same fields: change one, change the other.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('../../client', import.meta.url))
const OUT = new URL('../crates/casas-engine/tests/fixtures/climate.txt', import.meta.url)

const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
const D = await L('/src/generator/core/domain.ts')
const { detSin, detCos } = await L('/src/generator/core/detMath.ts')
const CM = await L('/src/generator/climate/climateMesh.ts')
const CF = await L('/src/generator/climate/climateField.ts')
const T = await L('/src/generator/climate/temperature.ts')
const W = await L('/src/generator/climate/wind.ts')
const P = await L('/src/generator/climate/precipitation.ts')
const M = await L('/src/generator/climate/monsoon.ts')
const OC = await L('/src/generator/climate/oceanCurrents.ts')
const WE = await L('/src/generator/climate/weather.ts')
const PF = await L('/src/generator/planet/planetForcing.ts')
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
  '# Hashes of client/src/generator/climate/ (the static climate) and planet/planetForcing.ts, for crates/casas-engine/tests/climate.rs.',
  '# Written by engine/scripts/climateFixture.mjs; do not edit.',
]
const line = (name) => lines.push(`${name} ${hex()}`)
const solveHash = (s) => { add(s.iterations); add(s.residual); add(s.converged) }

// The planet's factors and the bands, over their ranges.
h = 0x811c9dc5
for (let k = 0; k <= 40; k++) {
  const deg = 5 + k
  add(PF.obliquityContrast(deg))
  add(PF.solarTemperatureOffsetC(0.9 + k * 0.005))
  add(PF.hadleyEdge(10 + k))
  const forcing = { ...PF.DEFAULT_PLANET_FORCING, obliquityDeg: deg, eccentricity: k * 0.002, precessionDeg: k * 9 }
  add(PF.seasonalityFactor(forcing, true))
  add(PF.seasonalityFactor(forcing, false))
}
for (let k = 0; k <= 200; k++) {
  const phi = k / 200
  add(P.bandFactor(phi))
  add(P.bandFactor(phi, 0.25))
  add(P.evaporation(-40 + k * 0.4))
  add(CF.beltYNorm(phi, 0.07, 'torus'))
  add(CF.beltYNorm(phi, -0.07, 'sphere'))
  add(CF.topSummerCos(k * 0.1))
  add(CF.inTopSummerHalf(k % 12))
  add(T.baseTemperatureAtLatitude(phi, 1.3, PF.DEFAULT_PLANET_FORCING, k % 2 ? 'sphere' : 'torus'))
}
addAll(T.seaLevelTemperatureBand(2, 0.8, PF.DEFAULT_PLANET_FORCING, 'sphere'))
line('functions')

// The analytic terrain, 512 × 256 over the world: continents and seas, a
// few dry floors below sea level.
const RX = 512
const RY = 256
const heightAt = (x, y) => 0.08 * detSin(x * 0.006) * detCos(y * 0.009) + 0.04 * detSin(x * 0.021 + y * 0.013) + 0.02 * detCos(x * 0.05 - y * 0.03) - 0.03
const elevation = new Float32Array(RX * RY)
const dry = new Uint8Array(RX * RY)
for (let i = 0; i < elevation.length; i++) {
  const x = (i % RX) * 4 + 2
  const y = Math.floor(i / RX) * 4 + 2
  elevation[i] = heightAt(x, y)
  if (elevation[i] < 0 && elevation[i] > -0.01 && i % 3 === 0) dry[i] = 1
}

for (const [name, d] of [['torus', D.torusDomain(2048, 1024)], ['sphere', D.sphereDomain(2048, 1024)]]) {
  const terrain = CM.climateTerrain(d, elevation, RX, RY, dry)
  const { cm } = terrain
  h = 0x811c9dc5
  add(cm.mesh.count)
  add(cm.cellM)
  add(cm.bands)
  addAll(cm.band)
  addAll(terrain.z)
  addAll(terrain.land)
  addAll(terrain.dry)
  addAll(terrain.meanElevation())
  addAll(terrain.peakElevation())
  addAll(CM.zonalMean(cm, terrain.z))
  addAll(CM.zonalMean(cm, terrain.z, (i) => terrain.land[i] === 1))
  const { dist, nearest } = CM.distanceToSea(cm.mesh, terrain.land)
  addAll(dist)
  addAll(nearest)
  const parts = CM.meshComponents(cm.mesh, terrain.land)
  addAll(parts.label)
  addAll(parts.area)
  const rows = CM.basinRows(terrain)
  addAll(rows.eastward)
  addAll(rows.runPoints)
  addAll(rows.runM)
  for (const ring of rows.rings) { add(ring.count); add(ring.pointM); addAll(ring.runStart) }
  line(`${name}_mesh`)

  for (const [variant, params] of [
    ['default', WE.defaultWeatherParams()],
    ['moved', { temperatureOffset: 3, temperatureContrast: 1.2, humidity: 0.8, equatorOffset: 0.05, planet: { ...PF.DEFAULT_PLANET_FORCING, obliquityDeg: 30, rotationHours: 30, eccentricity: 0.03, precessionDeg: 20, solarConstant: 1.04 } }],
  ]) {
    const { mesh: wm } = WE.computeWeather(terrain, params)
    h = 0x811c9dc5
    addAll(wm.temperature)
    addAll(wm.wind.e)
    addAll(wm.wind.s)
    addAll(wm.currents.e)
    addAll(wm.currents.s)
    addAll(wm.currents.psi)
    solveHash(wm.currents.solve)
    add(wm.currents.islands)
    add(wm.currents.landmasses)
    addAll(wm.currentAnomaly)
    addAll(wm.seasonalAmplitude)
    addAll(wm.seasonal.annual)
    addAll(wm.seasonal.index)
    line(`${name}_weather_${variant}`)

    // The refinement's pieces of the ocean and the rain.
    const n = cm.mesh.count
    h = 0x811c9dc5
    const wind2 = W.computeWind(cm, 0.02, 20, 0.04)
    addAll(wind2.e)
    addAll(wind2.s)
    addAll(OC.computeUpwelling(terrain, wm.wind, params.equatorOffset, 26))
    const sink = new Float64Array(n)
    for (let i = 0; i < n; i++) sink[i] = terrain.land[i] ? 0 : Math.max(0, cm.yNorm[i] - 0.8) + (i % 13 === 0 ? 0.01 : 0)
    const flow = OC.computeSinkInflow(terrain, sink)
    addAll(flow.e)
    addAll(flow.s)
    solveHash(flow.solve)
    const highHpa = new Float64Array(n)
    const seaAnomaly = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      highHpa[i] = 6 * detSin(cm.mesh.x[i] * 0.01) * detCos(cm.mesh.y[i] * 0.02)
      seaAnomaly[i] = 2 * detCos(cm.mesh.x[i] * 0.005 + cm.mesh.y[i] * 0.003)
    }
    const refined = { seaTemperature: wm.temperature.map((t) => t + 1), seaAnomaly, highHpa }
    addAll(P.computePrecipitation(terrain, wm.temperature, wm.wind, 1.1, params.equatorOffset, 0.03, refined, 0.3))
    addAll(M.seasonalityMagnitude(Float32Array.from(wm.seasonal.index)))
    line(`${name}_refined_${variant}`)
  }
}

const text = lines.join('\n') + '\n'
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('engine/crates/casas-engine/tests/fixtures/climate.txt is stale — run node engine/scripts/climateFixture.mjs')
    process.exit(1)
  }
} else {
  writeFileSync(OUT, text)
  console.log(`climate fixture: ${lines.length - 2} lines`)
}
