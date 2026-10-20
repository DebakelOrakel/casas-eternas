// Writes the module test fixture for the engine's ecology: hashes of what
// the TypeScript engine's ecology/ecologyField.ts makes of a built mesh of
// each shape with a synthetic climate, hydrology and tectonic features —
// the base, the sliders twice, the months, the rasters — which the Rust
// port must make bit for bit (docs/decisions/rust-engine.md, fork 5).
//
//   node engine/scripts/ecologyFixture.mjs           write the fixture
//   node engine/scripts/ecologyFixture.mjs --check   fail if it is stale
//
// crates/casas-engine/tests/ecology.rs runs the same scenarios: change one,
// change the other.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('../../client', import.meta.url))
const OUT = new URL('../crates/casas-engine/tests/fixtures/ecology.txt', import.meta.url)

const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
const { torusDomain, sphereDomain } = await L('/src/generator/core/domain.ts')
const { detSin, detCos } = await L('/src/generator/core/detMath.ts')
const { buildMesh, MESH_Z } = await L('/src/generator/mesh/meshBuild.ts')
const { rasteriseNodeField } = await L('/src/generator/mesh/meshRaster.ts')
const E = await L('/src/generator/ecology/ecologyField.ts')
const { ECOLOGY_TUNING } = await L('/src/generator/ecology/ecologyTuneParams.ts')
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
  '# Hashes of client/src/generator/ecology/ecologyField.ts, for crates/casas-engine/tests/ecology.rs.',
  '# Written by engine/scripts/ecologyFixture.mjs; do not edit.',
]
const line = (name) => lines.push(`${name} ${hex()}`)

h = 0x811c9dc5
for (const [k, v] of Object.entries(ECOLOGY_TUNING)) { for (let i = 0; i < k.length; i++) add(k.charCodeAt(i)); add(v) }
for (let c = 0; c <= 255; c++) add(E.decodeFineValue(c))
addAll(E.encodeFineField(Float32Array.from([-1, 0, 0.01, 1.5, 2.999, 3, 7, -0.2, NaN])))
line('tuning')

const heightAt = (x, y) => 0.09 * detSin(x * 0.006) * detCos(y * 0.008) + 0.05 * detSin(x * 0.019 + y * 0.011) + 0.03 * detCos(x * 0.043 - y * 0.027) - 0.02 - 0.06 * Math.max(0, detSin(x * 0.011 + 2) * detCos(y * 0.013 + 1) - 0.6)

for (const [name, domain] of [['torus', torusDomain(2048, 1024)], ['sphere', sphereDomain(2048, 1024)]]) {
  const { mesh, state } = buildMesh(domain, { heightAt }, { seed: 7, budget: 12 })
  const n = mesh.vertexSlots
  const z = state.get(MESH_Z).slice(0, n)
  const land = new Uint8Array(n)
  const temperature = new Float32Array(n)
  const precipitation = new Float32Array(n)
  const upwelling = new Float32Array(n)
  const rainVariability = new Float32Array(n)
  const biomes = new Uint8Array(n)
  const discharge = new Float32Array(n)
  const lakeDepth = new Float32Array(n)
  const saltFlat = new Uint8Array(n)
  const waterTable = new Float32Array(n)
  const cratonAge = new Float32Array(n)
  const mt = new Float32Array(12 * n)
  const mp = new Float32Array(12 * n)
  let maxDischarge = 0
  for (let v = 0; v < n; v++) {
    const x = mesh.vx[v]
    const y = mesh.vy[v]
    const lat = Math.abs(y / domain.height - 0.5) * 2
    land[v] = mesh.vAlive[v] && z[v] > 0 ? 1 : 0
    temperature[v] = 30 - 48 * lat + 3 * detSin(x * 0.01) - (land[v] ? z[v] * 58 : 0)
    precipitation[v] = land[v] ? 50 + 900 * (1 + detSin(x * 0.007 + y * 0.004)) : -1
    upwelling[v] = land[v] ? 0 : Math.max(0, 4 * detCos(x * 0.005) * detSin(y * 0.02))
    rainVariability[v] = 0.3 + 0.3 * detSin(y * 0.01)
    biomes[v] = 1 + ((v * 5 + Math.floor(x / 61)) % 17)
    discharge[v] = land[v] ? Math.max(0, 5e5 * (detSin(x * 0.03) * detCos(y * 0.021) - 0.2)) : 0
    if (discharge[v] > maxDischarge) maxDischarge = discharge[v]
    lakeDepth[v] = land[v] && v % 37 === 0 ? 0.002 : 0
    saltFlat[v] = land[v] && v % 53 === 0 ? 1 : 0
    waterTable[v] = land[v] ? 40 * (1 + detSin(x * 0.02 - y * 0.01)) - 15 : -1
    cratonAge[v] = detSin(x * 0.004) * detCos(y * 0.005)
    for (let m = 0; m < 12; m++) {
      mt[m * n + v] = temperature[v] + 11 * detCos(m * 0.523 + (y < domain.height / 2 ? 0 : 3.1))
      mp[m * n + v] = precipitation[v] < 0 ? -1 : precipitation[v] * (1 + 0.8 * detSin(m * 0.523 + x * 0.002))
    }
  }
  const volcanoes = []
  const orogen = []
  const oases = []
  for (let k = 0; k < 90; k++) {
    const x = (k * 233.7) % domain.width
    const y = (k * 91.3 + 37) % domain.height
    volcanoes.push({ x, y, thickness: k % 5, kind: k % 3 === 0 ? 'hotspot' : k % 3 === 1 ? 'arc' : 'flood' })
    orogen.push({ x: (x + 400) % domain.width, y: (y * 0.7 + 100) % domain.height })
    if (k % 9 === 0) oases.push({ x: (x + 50) % domain.width, y })
  }
  const zero = new Float32Array(n)
  const climates = [
    { count: n, seaLevelTemperature: temperature, temperature, precipitation, seasonalAmplitude: zero, monsoonIndex: zero, months: { count: 12, temperature: mt, precipitation: mp }, upwelling, rainVariability, windE: null, windS: null },
    { count: n, seaLevelTemperature: temperature, temperature, precipitation, seasonalAmplitude: zero, monsoonIndex: zero, months: null, upwelling: null, rainVariability: null, windE: null, windS: null },
  ]
  const paramSets = [
    { carryingCapacity: 100, concentration: 0, provinceStrength: 0.5 },
    { carryingCapacity: 130, concentration: 40, provinceStrength: 1, weights: { fish: 1.4, tin: 0.7, gems: 2, arable: 0.8 }, tinRarity: 0.6 },
  ]
  const grid = domain.grid(512, 256)
  const pixelLand = new Uint8Array(512 * 256)
  const el = rasteriseNodeField(mesh, z, 512, 256)
  for (let p = 0; p < pixelLand.length; p++) pixelLand[p] = el[p] > 0 ? 1 : 0
  for (const [variant, climate, hydro] of [['refined', climates[0], true], ['plain', climates[1], false]]) {
    h = 0x811c9dc5
    const eco = E.prepareEcology({
      mesh, z, land, climate, biomes,
      discharge: hydro ? discharge : null, maxDischarge: hydro ? maxDischarge : 0,
      lakeDepth: hydro ? lakeDepth : null, saltFlat: hydro ? saltFlat : null, waterTable: hydro ? waterTable : null,
      oases: hydro ? oases : [], volcanoes, orogenPoints: orogen, cratonAge, warpSeed: 3735928559, domain,
    })
    for (const k of Object.keys(eco.raw)) addAll(eco.raw[k])
    addAll(eco.gemBelt); addAll(eco.aridity); addAll(eco.provinceDeviation)
    for (const p of eco.tinPoints) { add(p.x); add(p.y) }
    let fields
    for (const params of paramSets) {
      fields = E.applyEcology(eco, params).fields
      for (const id of E.ECOLOGY_FIELD_IDS) addAll(fields[id])
    }
    for (const id of E.SEASONAL_ECOLOGY_FIELDS) {
      for (const m of [1, 7, 12]) {
        const month = E.ecologyMonth(eco, id, m, 1.3)
        add(month !== null)
        if (month) addAll(month)
      }
    }
    const rasters = E.ecologyRasters(eco, { carryingCapacity: fields.carryingCapacity, fish: fields.fish, gold: fields.gold }, pixelLand, grid)
    for (const id of ['carryingCapacity', 'fish', 'gold']) { addAll(rasters.fields[id]); addAll(rasters.fine.fields[id]) }
    add(mesh.lastTri)
    line(`${name}_${variant}`)
    console.log(name, variant, 'land', land.reduce((a, b) => a + b, 0), 'cc mean', fields.carryingCapacity.filter((v) => v >= 0).reduce((a, b) => a + b, 0) / land.reduce((a, b) => a + b, 0))
  }
}

const text = lines.join('\n') + '\n'
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('engine/crates/casas-engine/tests/fixtures/ecology.txt is stale — run node engine/scripts/ecologyFixture.mjs')
    process.exit(1)
  }
} else {
  writeFileSync(OUT, text)
  console.log(`ecology fixture: ${lines.length - 2} lines`)
}
