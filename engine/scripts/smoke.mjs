// Loads both builds from engine/dist/ and checks that they answer the same
// as each other and as the TypeScript engine through the engine's surface
// (docs/decisions/rust-engine.md, fork 6), on both shapes: the version; an
// Archean grown, rendered, saved and restored; the hand-over; coupled
// epochs (one shape under another planet) and their renders; the climate
// step and its refinement; the tectonic save; a world restored from it,
// its climate with the saved refinement, and its next epoch. A save goes
// through JSON and back, as it does through a file. Run by `make test`
// after `make engine`; about five minutes, most of it the refinement in
// TypeScript.
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const dist = new URL('../dist/', import.meta.url)
const native = createRequire(import.meta.url)(new URL('casas-engine.node', dist).pathname)
const wasm = await import(new URL('wasm/casas-engine.js', dist).href)
await wasm.default({ module_or_path: await readFile(new URL('wasm/casas-engine_bg.wasm', dist)) })

const CLIENT = fileURLToPath(new URL('../../client', import.meta.url))
const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
const { createArcheanSimulation } = await L('/src/generator/archean/archeanState.ts')
const { archeanStep, DEFAULT_ARCHEAN_PARAMS } = await L('/src/generator/archean/archeanStep.ts')
const { serializeArchean } = await L('/src/generator/archean/archeanSnapshot.ts')
const { finalizeArchean } = await L('/src/generator/archean/finalizeArchean.ts')
const { serializePlateSimulation } = await L('/src/generator/tectonics/plateSimulation.ts')
const { savedOceanAge } = await L('/src/generator/tectonics/oceanAge.ts')
const { savedMantle } = await L('/src/generator/mantle/mantleField.ts')
const { TECTONIC_MA_PER_EPOCH } = await L('/src/generator/core/worldTime.ts')
const CE = await L('/src/generator/pipeline/coupledEpoch.ts')
const { defaultWeatherParams } = await L('/src/generator/climate/weather.ts')
const { DEFAULT_PLANET_FORCING } = await L('/src/generator/planet/planetForcing.ts')
const { TECTONICS_INPUTS } = await L('/src/generator/tectonics/tectonicsInputParams.ts')
const { renderSimulationImage } = await L('/src/generator/render/elevationMapImage.ts')
const { rasteriseMantle } = await L('/src/generator/mantle/mantleField.ts')
const { rasteriseNodeField, triangleRaster } = await L('/src/generator/mesh/meshRaster.ts')
const WS = await L('/src/generator/pipeline/worldStages.ts')
const { meshRouting } = await L('/src/generator/mesh/meshHydrology.ts')
const { Biome } = await L('/src/generator/climate/biomes.ts')
// The render pool's worker, in this process through a stand-in `self` (as
// client/scripts/pipeline.mjs does), one band over the whole raster; the
// worker posts through it, so it stays.
const shim = { postMessage: (m) => { shim.posted = m } }
globalThis.self = shim
await L('/src/generator/render/elevationRenderWorker.ts')
const pool = {
  async renderElevations(rw, rh, ww, wh, base, features, warpSeed, shape) {
    shim.onmessage({ data: { type: 'renderSlice', requestId: 0, startY: 0, endY: rh, renderWidth: rw, renderHeight: rh, worldWidth: ww, worldHeight: wh, blendedBaselineSlice: base.slice().buffer, features, warpSeed, shape } })
    return new Float32Array(shim.posted.elevations)
  },
}
await server.close()
// The Archean's restore in TypeScript in a module graph of its own: the
// field meshes and their walks are module state per domain there, and a
// second world in this graph would move the walks the first one reads.
async function freshArchean() {
  const fresh = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
  const F = (p) => fresh.ssrLoadModule(p)
  const m = { ...(await F('/src/generator/archean/archeanSnapshot.ts')), ...(await F('/src/generator/archean/archeanStep.ts')) }
  await fresh.close()
  return m
}
let failed = false
const fail = (message) => {
  console.error(`engine: ${message}`)
  failed = true
}

if (native.version() !== wasm.version()) fail(`native ${native.version()} and wasm ${wasm.version()} differ`)

// A value as canonical JSON: keys sorted, typed arrays as their bytes'
// hex, so two values compare equal when their data does.
const canonical = (v) => {
  if (ArrayBuffer.isView(v)) return `"${v.constructor.name}:${Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('hex')}"`
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  return JSON.stringify(v)
}
const viaJson = (v) => JSON.parse(JSON.stringify(v))
// Both builds' worlds against the TypeScript value.
const agree = (label, ts, worlds, read) => {
  const want = canonical(ts)
  for (const [name, w] of Object.entries(worlds)) if (canonical(read(w)) !== want) fail(`${label}: ${name} differs from TypeScript`)
}
const each = (worlds, f) => Object.values(worlds).forEach(f)

// The epoch's options (the runtime's tectonics loop) from the history's
// controls (its historyControls).
const D = CE.HISTORY_DEFAULTS
const optionsOf = (c) => ({ iterationsPerEpoch: D.iterationsPerEpoch, budget: D.budget, climateEvery: D.climateEvery, remeshEvery: D.remeshEvery, upliftScale: D.upliftScale, controls: { alluvium: c.alluvium, rockContrast: c.rockContrast }, weather: c.weather })
// The coupled terrain as the save's mesh payload (the runtime's
// serializeMeshTerrain over it).
const meshPayloadOf = (coupled) => {
  const bytes = CE.encodeCoupledTerrain(coupled)
  const count = bytes.z.length
  return {
    count, nodes: bytes.nodes, connectivity: bytes.connectivity, z: bytes.z, column: bytes.column,
    sedimentFlux: coupled.sedimentFlux.length >= count ? coupled.sedimentFlux.slice(0, count) : new Float32Array(count),
    preErosionZ: coupled.preErosionZ.length >= count ? coupled.preErosionZ.slice(0, count) : bytes.z.slice(),
    ice: coupled.ice.length >= count ? coupled.ice.slice(0, count) : undefined,
  }
}

// A render as the runtime makes it: the raw elevation, then the mantle's
// raster — in the Archean from the synthesis (renderArcheanAndPost), after
// the hand-over from the terrain mesh (renderTerrain).
const renderArchean = async (a, scale) => {
  const world = { width: a.width, height: a.height, domain: a.domain, seeds: [], rafts: a.rafts, features: [], oceanAge: null, warpSeed: a.warpSeed, mantle: a.mantle }
  const result = await renderSimulationImage(world, pool, { elevationScale: scale })
  return { elevations: result.rawElevations, mantle: rasteriseMantle(a.mantle, a.domain) }
}
const renderPlates = (sim, coupled) => {
  const elevations = rasteriseNodeField(coupled.mesh, coupled.z, sim.width, sim.height)
  return { elevations, mantle: rasteriseMantle(sim.mantle, sim.domain) }
}

// The climate step as the runtime's handlers make it (handleClimateRun,
// handleClimateRefine) on a TypeScript world `t` = { sim, coupled,
// elevation (the last render's), plan (the pixels' triangles), climate }:
// the bodies of the messages they post.
const vectors = (spacingM, f) => ({ cells: f.e.length, spacingM, e: Float64Array.from(f.e), s: Float64Array.from(f.s) })
const terrainOf = (coupled) => {
  if (!coupled.routing) coupled.routing = meshRouting(coupled.mesh, coupled.z)
  return { mesh: coupled.mesh, z: coupled.z }
}
const idRasterOf = (t, land, ids, pixelLand, sea) => {
  const { width, height } = t.sim
  if (!t.plan || t.plan.mesh !== land.mesh) t.plan = triangleRaster(land.mesh, width, height)
  return WS.idRaster(land, ids, pixelLand, width, height, sea, t.plan)
}
const climateData = (t, f, windMesh, currentsMesh, land, pixelLand) => ({
  temperature: f.temperature, wind: f.wind, windMesh, currentsMesh, currents: f.currents, currentAnomaly: f.currentAnomaly,
  precipitation: f.precipitation, seasonalAmplitude: f.seasonalAmplitude, monsoonIndex: f.monsoonIndex,
  koppen: idRasterOf(t, land, land.koppen, pixelLand, 0), biomes: idRasterOf(t, land, land.biome, pixelLand, Biome.Ocean),
})
const tsClimate = (t, params) => {
  const terrain = terrainOf(t.coupled)
  const chain = WS.climateChain(t.elevation, t.sim.domain, params)
  const land = WS.landClimateOf(chain.cells, terrain)
  const pixelLand = WS.pixelLandOf(t.elevation, null)
  const { cellM } = chain.weather.terrain.cm
  t.climate = { params, mesh: { temperature: chain.weather.mesh.temperature, wind: chain.weather.mesh.wind } }
  return climateData(t, chain.chart, vectors(cellM, chain.weather.mesh.wind), vectors(cellM, chain.weather.mesh.currents), land, pixelLand)
}
const tsRefine = (t, restored) => {
  const terrain = terrainOf(t.coupled)
  const step = WS.refinedClimateOf(t.elevation, t.sim.domain, t.climate.params, t.climate.mesh, restored, () => {})
  const { refined: r, chart } = step
  const land = WS.landClimateOf(step.cells, terrain)
  const pixelLand = WS.pixelLandOf(t.elevation, null)
  t.climate = { params: t.climate.params, mesh: { temperature: step.meshTemperature, wind: step.meshWind } }
  const { solves, ...values } = r
  const refined = {
    months: chart.months, refined: values, temperature: chart.temperature, precipitation: chart.precipitation,
    koppen: idRasterOf(t, land, land.koppen, pixelLand, 0), fog: chart.fog, foehn: chart.foehn,
    rainVariability: chart.reliability.rainVariability, ensoPattern: chart.reliability.ensoPattern,
    ensoPeriodYears: chart.reliability.ensoPeriodYears, ensoStrength: chart.reliability.ensoStrength,
    salinity: chart.salinity, deepWater: chart.deepWater, ...chart.storms, pressure: chart.pressure, wind: chart.wind,
    currents: chart.currents, currentAnomaly: chart.currentAnomaly, upwelling: chart.upwelling,
  }
  const a = step.annual
  const annual = climateData(t, { ...a, wind: step.annualWind, currents: chart.currents, currentAnomaly: chart.currentAnomaly },
    vectors(r.spacingM, step.meshWind), vectors(r.spacingM, { e: r.currentE, s: r.currentS }), land, pixelLand)
  return { refined, annual }
}

const STEPS = 60
const EPOCHS = 6
for (const shape of ['torus', 'sphere']) {
  const [seed, width, height, diffusion, landShare] = ['smoke', 512, 256, 2, 0.4]
  const params = { ...DEFAULT_ARCHEAN_PARAMS, diffusion, landShare }
  const ts = createArcheanSimulation(seed, width, height, shape)
  const worlds = { native: native.World.genesis(seed, width, height, shape, diffusion, landShare), wasm: wasm.World.genesis(seed, width, height, shape, diffusion, landShare) }
  for (let i = 0; i < STEPS; i++) {
    archeanStep(ts, params)
    each(worlds, (w) => w.archeanStep())
    // The live preview's render while the Archean runs, the settled one.
    if (i === 19 || i === 39) {
      const scale = i === 19 ? 2 : 1
      agree(`${shape}: the Archean's render at step ${i + 1}`, await renderArchean(ts, scale), worlds, (w) => w.render(scale))
    }
  }
  agree(`${shape}: the Archean`, [Float64Array.from(ts.mantle), ts.epoch, ts.rafts.length], worlds, (w) => [w.mantle(), w.archeanEpoch, w.raftCount])

  // The Archean saved, restored from the save and grown on.
  const archeanSave = { snapshot: serializeArchean(ts), mantle: savedMantle(ts.mantle, ts.domain), streak: ts.upwellingStreak }
  agree(`${shape}: the Archean's save`, archeanSave, worlds, (w) => w.archeanSave())
  const saved = { snapshot: viaJson(archeanSave.snapshot), mantle: archeanSave.mantle, streak: Int16Array.from(archeanSave.streak) }
  const A = await freshArchean()
  const tsAgain = A.deserializeArchean(saved.snapshot, saved.mantle, saved.streak.slice(), shape)
  const again = {
    native: native.World.restoreArchean(shape, saved.snapshot, saved.mantle, saved.streak, diffusion, landShare),
    wasm: wasm.World.restoreArchean(shape, saved.snapshot, saved.mantle, saved.streak, diffusion, landShare),
  }
  for (let i = 0; i < 5; i++) {
    A.archeanStep(tsAgain, { ...A.DEFAULT_ARCHEAN_PARAMS, diffusion, landShare })
    each(again, (w) => w.archeanStep())
  }
  agree(`${shape}: the restored Archean`, Float64Array.from(tsAgain.mantle), again, (w) => w.mantle())
  again.wasm.free()

  // The hand-over and the coupled epochs; the torus under another planet.
  const sim = finalizeArchean(ts)
  sim.epochMa = TECTONIC_MA_PER_EPOCH
  const coupled = CE.createCoupledTerrain(sim, D.budget)
  each(worlds, (w) => w.finalize())
  const weather = shape === 'torus' ? { ...defaultWeatherParams(), planet: { ...DEFAULT_PLANET_FORCING, obliquityDeg: 31, rotationHours: 30 } } : defaultWeatherParams()
  const controls = { alluvium: TECTONICS_INPUTS.alluvium.default, rockContrast: TECTONICS_INPUTS.rockContrast.default, weather }
  const t = { sim, coupled, elevation: null, plan: null, climate: null }
  const renderT = () => {
    const r = renderPlates(sim, coupled)
    t.elevation = r.elevations
    return r
  }
  agree(`${shape}: the hand-over's render`, renderT(), worlds, (w) => w.render(1))
  let eventCount = 0
  for (let e = 0; e < EPOCHS; e++) {
    const stats = await CE.stepCoupledEpoch(sim, coupled, optionsOf(controls))
    eventCount += stats.events.length
    agree(`${shape}: epoch ${e + 1}'s events`, stats.events, worlds, (w) => w.epoch(controls))
    if (e % 2 === 1) agree(`${shape}: epoch ${e + 1}'s render`, renderT(), worlds, (w) => w.render(1))
  }

  // The climate step and its refinement.
  agree(`${shape}: the climate`, tsClimate(t, weather), worlds, (w) => w.climate(weather))
  const refinement = tsRefine(t, undefined)
  agree(`${shape}: the refinement`, refinement, worlds, (w) => w.refineClimate(null))

  // The tectonic save.
  const snapshot = serializePlateSimulation(sim)
  agree(`${shape}: the snapshot`, snapshot, worlds, (w) => w.snapshot())
  if (Object.keys(worlds.native.snapshot()).join() !== Object.keys(snapshot).join()) fail(`${shape}: the snapshot's keys come in another order`)
  const mantle = savedMantle(sim.mantle, sim.domain)
  const oceanAge = savedOceanAge(sim.oceanAge, sim.domain)
  agree(`${shape}: the saved fields`, [mantle, oceanAge], worlds, (w) => w.savedFields())
  const mesh = meshPayloadOf(coupled)
  agree(`${shape}: the mesh payload`, mesh, worlds, (w) => w.meshPayload())

  // The world restored from its save goes on as the world it was saved
  // from: its next epoch is the uninterrupted one's. (A TypeScript world
  // restored in a fresh process does not on the sphere: its field meshes'
  // walks are module state the save does not hold. The engine's world
  // holds its own, and a restore starts them as the hand-over did.)
  const lattice = { accumulated: sim.latticeAccumulated.slice(), lockedEpochs: sim.latticeLockedEpochs.slice(), lastClassCode: sim.latticeLastClassCode.slice() }
  const back = viaJson(snapshot)
  const restored = {
    native: native.World.restorePlates(shape, back, oceanAge, mantle, lattice, mesh),
    wasm: wasm.World.restorePlates(shape, back, oceanAge, mantle, lattice, mesh),
  }
  agree(`${shape}: the restored world`, snapshot, restored, (w) => w.snapshot())
  // Rendered, its climate again and the saved refinement taken as it is.
  agree(`${shape}: the restored world's render`, renderT(), restored, (w) => w.render(1))
  each(worlds, (w) => w.render(1))
  const all = { ...worlds, ...Object.fromEntries(Object.entries(restored).map(([k, w]) => [`restored ${k}`, w])) }
  agree(`${shape}: the restored world's climate`, tsClimate(t, weather), all, (w) => w.climate(weather))
  agree(`${shape}: the saved refinement`, tsRefine(t, refinement.refined.refined), all, (w) => w.refineClimate(refinement.refined.refined))
  await CE.stepCoupledEpoch(sim, coupled, optionsOf(controls))
  each(restored, (w) => w.epoch(controls))
  each(worlds, (w) => w.epoch(controls))
  agree(`${shape}: the uninterrupted world's next epoch`, [serializePlateSimulation(sim), meshPayloadOf(coupled)], worlds, (w) => [w.snapshot(), w.meshPayload()])
  agree(`${shape}: the restored world's next epoch`, [serializePlateSimulation(sim), meshPayloadOf(coupled)], restored, (w) => [w.snapshot(), w.meshPayload()])
  restored.wasm.free()
  worlds.wasm.free()
  console.log(`engine: ${shape} — ${STEPS} Archean steps (${ts.rafts.length} rafts) saved and restored; the hand-over, ${EPOCHS} epochs (${eventCount} events, ${mesh.count} nodes) saved and restored: native, wasm and TypeScript agree`)
}
if (failed) process.exit(1)
console.log(`engine: native and wasm ${wasm.version()}`)
process.exit(0)
