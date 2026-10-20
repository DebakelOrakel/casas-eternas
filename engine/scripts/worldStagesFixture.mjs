// Writes the module test fixture for the engine's world stages: hashes of
// what the TypeScript engine's pipeline/worldStages.ts makes of the
// synthetic plate simulation after 12 tectonic epochs and 2 coupled ones —
// the climate chain, the climate at the nodes, the hydrology's route with
// the climate v2 and its features, the ecology on them, then the climate
// step's refinement and the hydrology on it — on both shapes, in the
// runtime's order, which the Rust port must make bit for bit
// (docs/decisions/rust-engine.md, fork 5).
//
//   node engine/scripts/worldStagesFixture.mjs           write the fixture
//   node engine/scripts/worldStagesFixture.mjs --check   fail if it is stale
//
// About a minute: `make test` checks it. crates/casas-engine/tests/
// world_stages.rs runs the same: change one, change the other.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { syntheticSim } from './syntheticSim.mjs'

const CLIENT = fileURLToPath(new URL('../../client', import.meta.url))
const OUT = new URL('../crates/casas-engine/tests/fixtures/worldStages.txt', import.meta.url)

const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
const D = await L('/src/generator/core/domain.ts')
const { mulberry32 } = await L('/src/generator/core/rng.ts')
const PM = await L('/src/generator/tectonics/plateMotion.ts')
const OA = await L('/src/generator/tectonics/oceanAge.ts')
const PS = await L('/src/generator/tectonics/plateSimulation.ts')
const CE = await L('/src/generator/pipeline/coupledEpoch.ts')
const WS = await L('/src/generator/pipeline/worldStages.ts')
const { rasteriseNodeField, triangleRaster } = await L('/src/generator/mesh/meshRaster.ts')
const { meanLandRunoff } = await L('/src/generator/climate/climatePoints.ts')
const { maxDischargeOverLand } = await L('/src/generator/surface/hydrology.ts')
const E = await L('/src/generator/ecology/ecologyField.ts')
await server.close()

const f = new Float64Array(1)
const w = new Uint32Array(f.buffer)
let h = 0
const add = (v) => {
  if (v === true) v = 1
  else if (v === false) v = 0
  if (v === undefined || v !== v) {
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
  '# Hashes of client/src/generator/pipeline/worldStages.ts, for crates/casas-engine/tests/world_stages.rs.',
  '# Written by engine/scripts/worldStagesFixture.mjs; do not edit.',
]
const line = (name) => { lines.push(`${name} ${hex()}`); h = 0x811c9dc5 }

const cellsHash = (c) => { addAll(c.seaLevelTemperature); addAll(c.precipitation); addAll(c.seasonalAmplitude); addAll(c.monsoonIndex) }
const chartHash = (c) => { for (const k of ['temperature', 'wind', 'seasonalAmplitude', 'precipitation', 'monsoonIndex', 'currents', 'currentAnomaly']) addAll(c[k]) }
const landHash = (l) => { addAll(l.points.land); addAll(l.climate.temperature); addAll(l.climate.precipitation); addAll(l.biome); addAll(l.koppen) }
const meshHydrologyHash = (om) => {
  addAll(om.discharge)
  for (const k of ['depth', 'saltFlat', 'dryBasin', 'frozen', 'level', 'body']) addAll(om.lakes[k])
  add(om.lakes.bodies.length)
  for (const b of om.lakes.bodies) { add(b.level); add(b.cells) }
  for (const k of ['depth', 'level', 'body', 'surface', 'saltFlat', 'dryBasin', 'frozen']) addAll(om.raster[k])
  landHash(om.land)
}
const featuresHash = (ft, om) => {
  const g = ft.graph
  add(g.nodes.length); add(g.reaches.length)
  for (const r of g.reaches) { add(r.from); add(r.to); add(r.dischargeOut); add(r.order); add(r.springFed); add(r.runoffOut) }
  addAll(g.cells); addAll(g.cellX)
  add(g.courses.length)
  for (const c of g.courses) { add(c.reach); add(c.widthM); add(c.sinuosity); for (const l of c.lines) addAll(l) }
  addAll(ft.coast.nodes); addAll(ft.coast.type)
  for (const r of ft.coast.reaches) { add(r.nodeCount); add(r.exposure); add(r.supply) }
  for (const b of ft.sedimentBasins) { add(b.nodes); add(b.volumeKm3); add(b.cratonAge); add(b.hardness); add(b.x) }
  for (const s of ft.oases) { add(s.cell); add(s.x) }
  addAll(ft.ice); addAll(ft.precipitationEffective); addAll(ft.watersheds); addAll(ft.discharge); addAll(ft.coastType); addAll(ft.biomes)
  addAll(om.biome); addAll(om.ecologyBiome); addAll(om.waterTable)
}

// Hot and dry: terminal basins, dry ones among them, and oases. (No dry
// floor below the sea forms on these worlds, so the v2's dry floors and
// the salt flats stay empty here.)
const params = { temperatureOffset: 9, temperatureContrast: 1, humidity: 0.35, equatorOffset: 0 }
for (const [name, d, seed] of [['torus', D.torusDomain(2048, 1024), 7], ['sphere', D.sphereDomain(2048, 1024), 8]]) {
  const sim = syntheticSim({ PM, OA, PS, mulberry32 }, d, seed)
  for (let e = 0; e < 12; e++) PS.stepEpoch(sim)
  const coupled = CE.createCoupledTerrain(sim, 4)
  for (let e = 0; e < 2; e++) await CE.stepCoupledEpoch(sim, coupled, { iterationsPerEpoch: 4, budget: 4, climateEvery: 3, remeshEvery: 3, upliftScale: 1 })
  const mt = { mesh: coupled.mesh, z: coupled.z, routing: coupled.routing, areas: coupled.areas, sedimentFlux: coupled.sedimentFlux }
  const W = sim.width
  const H = sim.height
  const raster = rasteriseNodeField(mt.mesh, mt.z, W, H)
  let plan = null
  const planOf = () => (plan ??= triangleRaster(mt.mesh, W, H))
  h = 0x811c9dc5

  // The climate step: the chain on the terrain, the climate at its nodes.
  const chain = WS.climateChain(raster, sim.domain, params)
  cellsHash(chain.cells); chartHash(chain.chart)
  const land = WS.landClimateOf(chain.cells, mt)
  landHash(land)
  line(`${name}_climate`)

  // The hydrology: the route with the climate v2, its features.
  let v2 = null
  const om = WS.routeHydrology(mt, raster, raster, sim.domain, W, H, { params, cells: chain.cells, refined: false, land }, (c, l, dry) => { v2 = { chain: c, land: l, dry } })
  cellsHash(v2.chain.cells); chartHash(v2.chain.chart); landHash(v2.land); addAll(v2.dry)
  meshHydrologyHash(om)
  const maxQ = maxDischargeOverLand(om.discharge, mt.z)
  const meanRunoff = meanLandRunoff(v2.chain.cells)
  const threshold = WS.hydrologyThreshold(sim.domain, meanRunoff)
  add(maxQ); add(meanRunoff); add(threshold)
  line(`${name}_route`)
  const ft = WS.hydrologyFeatures({ sim, coupled, planet: undefined }, mt, om, maxQ, threshold, raster, raster, om.raster.dryBasin, v2.chain.cells, W, H, planOf)
  featuresHash(ft, om)
  addAll(WS.chartMaxOfNodes(mt.mesh, om.discharge, mt.z))
  for (const p of WS.collectOrogens(sim.features)) { add(p.x); add(p.y) }
  console.log(name, 'dry floors', om.lakes.dryBasin.reduce((a, b) => a + b, 0), 'salt flats', om.lakes.saltFlat.reduce((a, b) => a + b, 0), 'dry bodies', om.lakes.bodies.filter((b) => b.kind === 'dry').length)
  console.log(name, 'reaches', ft.graph.reaches.length, 'coast', ft.coast.reaches.length, 'basins', ft.sedimentBasins.length, 'oases', ft.oases.length)
  line(`${name}_features`)

  // The ecology on them.
  const inputs = WS.ecologyInputsOf(sim, mt, om.land, om, { maxDischarge: maxQ, oases: ft.oases })
  const base = E.prepareEcology(inputs)
  const fields = E.applyEcology(base, { carryingCapacity: 100, concentration: 0, provinceStrength: 0.5 }).fields
  for (const id of E.ECOLOGY_FIELD_IDS) addAll(fields[id])
  const rasters = E.ecologyRasters(base, { carryingCapacity: fields.carryingCapacity }, WS.pixelLandOf(raster, om.raster.dryBasin), sim.domain.grid(W, H))
  addAll(rasters.fields.carryingCapacity); addAll(rasters.fine.fields.carryingCapacity)
  line(`${name}_ecology`)

  // The climate step's refinement, and the hydrology on it.
  const step = WS.refinedClimateOf(raster, sim.domain, params, { temperature: chain.weather.mesh.temperature, wind: chain.weather.mesh.wind }, undefined, () => {})
  cellsHash(step.cells); addAll(step.annual.temperature); addAll(step.annual.precipitation); addAll(step.annualWind); addAll(step.meshWind.e); addAll(step.meshTemperature)
  addAll(step.chart.temperature); addAll(step.chart.fog)
  const land2 = WS.landClimateOf(step.cells, mt)
  landHash(land2)
  const om2 = WS.routeHydrology(mt, raster, raster, sim.domain, W, H, { params, cells: step.cells, refined: true, land: land2 }, () => { throw new Error('no v2 over a refinement') })
  meshHydrologyHash(om2)
  const maxQ2 = maxDischargeOverLand(om2.discharge, mt.z)
  const threshold2 = WS.hydrologyThreshold(sim.domain, meanLandRunoff(step.cells))
  const ft2 = WS.hydrologyFeatures({ sim, coupled, planet: undefined }, mt, om2, maxQ2, threshold2, raster, raster, om2.raster.dryBasin, step.cells, W, H, planOf)
  featuresHash(ft2, om2)
  add(mt.mesh.lastTri)
  line(`${name}_refined`)
}

const text = lines.join('\n') + '\n'
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('engine/crates/casas-engine/tests/fixtures/worldStages.txt is stale — run node engine/scripts/worldStagesFixture.mjs')
    process.exit(1)
  }
} else {
  writeFileSync(OUT, text)
  console.log(`world stages fixture: ${lines.length - 2} lines`)
}
process.exit(0)
