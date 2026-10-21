// Loads both builds from engine/dist/ and checks that they answer the same
// as each other and as the TypeScript engine through the engine's surface
// (docs/decisions/rust-engine.md, fork 6), on both shapes: the version; an
// Archean grown, rendered, saved and restored; the hand-over; coupled
// epochs (one shape under another planet) and their renders; the climate
// step, the hydrology with the climate v2, the refinement and the
// hydrology on it, the ecology on both, with its months, and what the
// migration reads of them; the tectonic
// save; a world restored from it, its climate with the saved refinement,
// its hydrology, its ecology and its next epoch; then level 1 by replay,
// native only, with its checkpoints and resumed from one, the tile plan on
// it and a level-3 tile baked with what it waits for; the planet preview's
// climate on a sample world; the replay at level 0 and the world it ends
// on. A save goes
// through JSON and back, as it does through a file. Run by `make test`
// after `make engine`; about ten minutes, most of it TypeScript's
// refinement and its level-1 replay.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const dist = new URL('../dist/', import.meta.url)
const wasm = await import(new URL('wasm/casas-engine.js', dist).href)
await wasm.default({ module_or_path: await readFile(new URL('wasm/casas-engine_bg.wasm', dist)) })

const CLIENT = fileURLToPath(new URL('../../client', import.meta.url))
const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
// The native build through the job worker's loader.
const native = (await L('/scripts/engineNative.ts')).loadNativeEngine(fileURLToPath(new URL('casas-engine.node', dist)))
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
const { dischargeToM3s, maxDischargeOverLand, SURFACE_ICE } = await L('/src/generator/surface/hydrology.ts')
const { climateAtPoints, climateCellsFromWeather, meanLandRunoff, meshPoints } = await L('/src/generator/climate/climatePoints.ts')
const { riverPolylinesFromGraph, serializeRiverGraph } = await L('/src/generator/surface/riverGraph.ts')
const { metersToElevation } = await L('/src/generator/elevation/elevationScale.ts')
const E = await L('/src/generator/ecology/ecologyField.ts')
const RR = await L('/src/generator/pipeline/replayRuns.ts')
const { levelBudget, levelHydrology } = await L('/src/generator/pipeline/meshBakeStage.ts')
const { meshLevelToArtifact, meshLevelMesh } = await L('/src/world/meshArtifacts.ts')
const { planTiles } = await L('/src/generator/pipeline/tilePlan.ts')
const { bakeMeshTile } = await L('/src/generator/pipeline/meshTileBake.ts')
const { bakedTileToArtifact } = await L('/src/world/meshTileArtifacts.ts')
const { tileBakeInputs } = await L('/src/world/bakeInputs.ts')
const MT = await L('/src/generator/mesh/meshTile.ts')
const { cubeTileSamples } = await L('/src/generator/mesh/meshTileCube.ts')
const { tileParentOn } = await L('/src/generator/mesh/tileLayout.ts')
const { createMeshSampler } = await L('/src/generator/mesh/meshSampler.ts')
const { coarseForcingFields } = await L('/src/generator/pipeline/erosionForcing.ts')
const { SHELF_BREAK } = await L('/src/generator/elevation/elevationScale.ts')
const { climateCellValues } = await L('/src/generator/climate/climatePoints.ts')
const { CLIMATE_RES_X, CLIMATE_RES_Y } = await L('/src/generator/climate/climateField.ts')
const { domainOfKind } = await L('/src/generator/core/domain.ts')
const { classifyPoints } = await L('/src/generator/climate/biomes.ts')
const { rasteriseNodePart } = await L('/src/generator/mesh/meshRaster.ts')
const { sampleWorldElevation } = await L('/src/generator/planet/sampleWorld.ts')
const { chartLand, chartLandField } = await L('/src/generator/climate/climateChart.ts')
const { OCEAN_PRECIP } = await L('/src/generator/climate/precipitation.ts')
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
  return { mesh: coupled.mesh, z: coupled.z, routing: coupled.routing, areas: coupled.areas, sedimentFlux: coupled.sedimentFlux }
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
  t.climate = { params, cells: chain.cells, terrain: chain.weather.terrain, mesh: { temperature: chain.weather.mesh.temperature, wind: chain.weather.mesh.wind }, refined: false, land }
  t.hydrology = null
  t.ecology = null
  return climateData(t, chain.chart, vectors(cellM, chain.weather.mesh.wind), vectors(cellM, chain.weather.mesh.currents), land, pixelLand)
}
const tsRefine = (t, restored) => {
  const terrain = terrainOf(t.coupled)
  const step = WS.refinedClimateOf(t.elevation, t.sim.domain, t.climate.params, t.climate.mesh, restored, () => {})
  const { refined: r, chart } = step
  const land = WS.landClimateOf(step.cells, terrain)
  const pixelLand = WS.pixelLandOf(t.elevation, null)
  t.climate = { params: t.climate.params, cells: step.cells, terrain: step.terrain, mesh: { temperature: step.meshTemperature, wind: step.meshWind }, refined: true, land }
  t.hydrology = null
  t.ecology = null
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
// The hydrology step as the runtime's handleHydrologyRun makes it, with
// the river graph as the RiverGraph it serializes, the v2's climateData
// and the render after the route (of it, what the engine gives).
const tsHydrology = (t, planet) => {
  const { sim } = t
  const { width, height, domain } = sim
  const mt = terrainOf(t.coupled)
  const terrain = t.elevation
  let weather = t.climate
  let result = t.hydrology
  let climate = null
  let render = null
  const rerouted = !result
  if (rerouted) {
    const onMesh = WS.routeHydrology(mt, terrain, terrain, domain, width, height, weather, (chain, land, dryBasin) => {
      const { cellM } = chain.weather.terrain.cm
      climate = climateData(t, chain.chart, vectors(cellM, chain.weather.mesh.wind), vectors(cellM, chain.weather.mesh.currents), land, WS.pixelLandOf(terrain, dryBasin))
      weather = t.climate = { params: weather.params, cells: chain.cells, terrain: chain.weather.terrain, mesh: { temperature: chain.weather.mesh.temperature, wind: chain.weather.mesh.wind }, refined: false, land }
    })
    const lakes = onMesh.raster
    render = { mantle: rasteriseMantle(sim.mantle, sim.domain), dryBasin: lakes.dryBasin, saltFlat: lakes.saltFlat }
    t.ecology = null
    result = t.hydrology = { onMesh, maxDischarge: maxDischargeOverLand(onMesh.discharge, mt.z), meanRunoff: meanLandRunoff(weather.cells), graph: null, coast: null, sedimentBasins: [], ice: null }
  }
  const threshold = WS.hydrologyThreshold(domain, result.meanRunoff)
  const lakes = result.onMesh.raster
  const levelOut = rerouted ? lakes.level.slice() : new Float32Array(0)
  const surfaceOut = rerouted ? lakes.surface.slice() : new Uint8Array(0)
  let out = { biomes: new Uint8Array(0), precipitationEffective: new Float32Array(0), watersheds: new Uint16Array(0), discharge: new Float32Array(0), coastType: new Uint8Array(0) }
  if (rerouted) {
    const plan = () => {
      if (!t.plan || t.plan.mesh !== mt.mesh) t.plan = triangleRaster(mt.mesh, width, height)
      return t.plan
    }
    const f = WS.hydrologyFeatures({ sim, coupled: t.coupled, planet }, mt, result.onMesh, result.maxDischarge, threshold, terrain, terrain, lakes.dryBasin, weather.cells, width, height, plan)
    Object.assign(result, { graph: f.graph, coast: f.coast, sedimentBasins: f.sedimentBasins, ice: f.ice, oases: f.oases })
    out = { biomes: f.biomes, precipitationEffective: f.precipitationEffective, watersheds: f.watersheds, discharge: f.discharge, coastType: f.coastType }
  }
  const rivers = result.graph ? riverPolylinesFromGraph(result.graph, result.maxDischarge, domain) : { points: new Float32Array(0), lengths: new Uint32Array(0), regimes: new Uint8Array(0) }
  if (rerouted && result.ice) {
    for (let c = 0; c < levelOut.length; c++) {
      if (result.ice[c] <= 0) continue
      levelOut[c] = Math.max(levelOut[c], terrain[c] + metersToElevation(result.ice[c]))
      surfaceOut[c] = SURFACE_ICE
    }
  }
  return {
    ...out, riverPoints: rivers.points, riverLengths: rivers.lengths, riverRegimes: rivers.regimes,
    lakeDepth: rerouted ? lakes.depth : new Float32Array(0), maxDischarge: result.maxDischarge,
    waterBodies: rerouted ? result.onMesh.lakes.bodies : null, waterLevel: levelOut, waterSurface: surfaceOut,
    riverGraph: rerouted ? result.graph : null, coast: rerouted ? { reaches: result.coast.reaches, nodes: result.coast.nodes } : null,
    sedimentBasins: rerouted ? result.sedimentBasins : null, iceThickness: rerouted && result.ice ? result.ice : new Float32Array(0),
    climate, render,
  }
}
// What the migration reads as the runtime's handleMigrationRun reads it:
// the climate's land rain on its chart, the hydrology's discharge as each
// chart cell's largest over its nodes.
const tsMigration = (t) => {
  const { cells, terrain } = t.climate
  const precipitation = chartLandField(cells.cm, cells.precipitation, (i) => cells.precipitation[i] !== OCEAN_PRECIP, OCEAN_PRECIP, chartLand(terrain))
  const h = t.hydrology
  return { precipitation, discharge: h ? WS.chartMaxOfNodes(h.onMesh.land.mesh, h.onMesh.discharge, h.onMesh.land.z) : null, maxDischarge: h?.maxDischarge ?? 0 }
}

// The ecology step as the runtime's handleEcologyRun and
// handleEcologyMonth make it: the physics kept while only the sliders
// move, the pixels' triangles the stages' one cache.
const tsEcology = (t, params) => {
  const { sim } = t
  const mt = terrainOf(t.coupled)
  if (!t.ecology) {
    const h = t.hydrology
    const om = h ? h.onMesh : null
    const base = E.prepareEcology(WS.ecologyInputsOf(sim, mt, om ? om.land : t.climate.land, om, h ? { maxDischarge: h.maxDischarge, oases: h.oases } : null))
    if (!t.plan || t.plan.mesh !== mt.mesh) t.plan = triangleRaster(mt.mesh, sim.width, sim.height)
    base.raster = t.plan
    t.ecology = { base, pixelLand: WS.pixelLandOf(t.elevation, h ? h.onMesh.raster.dryBasin : null), params: null }
  }
  t.ecology.params = params
  const eco = E.ecologyRasters(t.ecology.base, E.applyEcology(t.ecology.base, params).fields, t.ecology.pixelLand, sim.domain.grid(sim.width, sim.height))
  return {
    resX: eco.resX, resY: eco.resY, fields: Object.entries(eco.fields).map(([id, data]) => ({ id, data })),
    fine: { resX: eco.fine.resX, resY: eco.fine.resY, fields: Object.entries(eco.fine.fields).map(([id, data]) => ({ id, data: E.encodeFineField(data) })) },
  }
}
const tsEcologyMonth = (t, field, month) => {
  const eco = t.ecology
  const nodes = eco && eco.params && E.isSeasonalEcologyField(field) ? E.ecologyMonth(eco.base, field, month, eco.params.weights?.[field] ?? 1) : null
  const { width, height } = t.sim
  const data = nodes ? E.ecologyFine(eco.base, nodes, eco.pixelLand, width, height, field === 'fish') : null
  return { field, month, resX: data ? width : 0, resY: data ? height : 0, data: data ? E.encodeFineField(data) : new Uint8Array(0) }
}
// The save's climate and land fields as the runtime's serializeWorld
// makes them (climatePayload, landPayload): the land fields only while
// they are at the nodes of the terrain mesh now.
const tsSaveFields = (t) => {
  if (!t.climate) return [null, null]
  const mesh = t.coupled.mesh
  const om = t.hydrology && t.hydrology.onMesh.land.mesh === mesh ? t.hydrology.onMesh : null
  const land = om ? om.land : t.climate.land
  if (land.mesh !== mesh) return [climateCellValues(t.climate.cells), null]
  const count = mesh.aliveVertices
  let discharge = null
  if (om) {
    const unit = dischargeToM3s(1, mesh.domain.metresPerUnit)
    discharge = new Float32Array(count)
    for (let v = 0; v < count; v++) discharge[v] = om.discharge[v] * unit
  }
  return [climateCellValues(t.climate.cells), {
    count, biome: (om?.biome ?? land.biome).slice(0, count), koppen: land.koppen.slice(0, count),
    waterTable: om?.waterTable ? om.waterTable.slice(0, count) : null, discharge, lakeBody: om ? om.lakes.body.slice(0, count) : null,
  }]
}
const saveFields = (w) => [w.climatePayload(), w.landPayload()]

const SLIDERS = [
  { carryingCapacity: 100, concentration: 0, provinceStrength: 0.45 },
  { carryingCapacity: 140, concentration: 30, provinceStrength: 0.8, tinRarity: 0.6, weights: { fish: 1.5, gold: 0.5, copper: 1.2 } },
]
// Returns how many of the months asked had a month to give.
const agreeEcology = (label, t, worlds) => {
  SLIDERS.forEach((params, k) => agree(`${label} (sliders ${k + 1})`, tsEcology(t, params), worlds, (w) => w.ecology(params)))
  let months = 0
  for (const [field, month] of [['fish', 1], ['arable', 7], ['salt', 12], ['timber', 3]]) {
    const ts = tsEcologyMonth(t, field, month)
    if (ts.data.length > 0) months++
    agree(`${label}: ${field} in month ${month}`, ts, worlds, (w) => w.ecologyMonth(field, month))
  }
  return months
}

// The hydrology in both builds against TypeScript's, and what the world
// layer writes of it in TypeScript's key order: the river graph's JSON,
// the water bodies, the coast reaches, the sediment basins.
const agreeHydrology = (label, ts, worlds, planet) => {
  const json = (h) => h.riverGraph ? [serializeRiverGraph(h.riverGraph).json, JSON.stringify([h.waterBodies, h.coast.reaches, h.sedimentBasins])] : null
  const want = JSON.stringify(json(ts))
  agree(label, ts, worlds, (w) => {
    const h = w.hydrology(planet)
    if (JSON.stringify(json(h)) !== want) fail(`${label}: the save's JSON differs`)
    return h
  })
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
  const t = { sim, coupled, elevation: null, plan: null, climate: null, hydrology: null, ecology: null }
  const renderT = () => {
    const r = renderPlates(sim, coupled)
    t.elevation = r.elevations
    t.climate = null
    t.hydrology = null
    t.ecology = null
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
  agree(`${shape}: the migration's inputs on the climate`, tsMigration(t), worlds, (w) => w.migrationInputs())
  // The hydrology on it, with the climate v2.
  const planet = weather.planet ?? null
  const hydrology = tsHydrology(t, planet ?? undefined)
  agreeHydrology(`${shape}: the hydrology with the v2`, hydrology, worlds, planet)
  agree(`${shape}: the migration's inputs on the hydrology`, tsMigration(t), worlds, (w) => w.migrationInputs())
  agreeEcology(`${shape}: the ecology on the annual climate`, t, worlds)
  const water = `${hydrology.riverGraph.reaches.length} reaches, ${hydrology.waterBodies.length} water bodies, ${hydrology.coast.reaches.length} coast reaches, ${hydrology.sedimentBasins.length} sediment basins, ${hydrology.riverGraph.courses?.length ?? 0} courses, ${hydrology.riverGraph.springs?.length ?? 0} springs, ${hydrology.render.dryBasin.reduce((a, b) => a + b, 0)} dry-floor pixels`
  const refinement = tsRefine(t, undefined)
  agree(`${shape}: the refinement`, refinement, worlds, (w) => w.refineClimate(null))
  // The hydrology on the refinement, routed, then once more from its route.
  agreeHydrology(`${shape}: the hydrology`, tsHydrology(t, planet ?? undefined), worlds, planet)
  agreeHydrology(`${shape}: the hydrology again`, tsHydrology(t, planet ?? undefined), worlds, planet)
  agree(`${shape}: the migration's inputs on the refinement`, tsMigration(t), worlds, (w) => w.migrationInputs())
  const months = agreeEcology(`${shape}: the ecology on the refinement`, t, worlds)

  // The tectonic save.
  agree(`${shape}: the save's climate and land fields`, tsSaveFields(t), worlds, saveFields)
  const snapshot = serializePlateSimulation(sim)
  agree(`${shape}: the snapshot`, snapshot, worlds, (w) => w.snapshot())
  // state.json as the world layer writes it: the keys in TypeScript's order too.
  each(worlds, (w) => { if (JSON.stringify(w.snapshot()) !== JSON.stringify(snapshot)) fail(`${shape}: the snapshot's JSON differs`) })
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
  agreeHydrology(`${shape}: the restored world's hydrology`, tsHydrology(t, planet ?? undefined), all, planet)
  agreeEcology(`${shape}: the restored world's ecology`, t, all)
  agree(`${shape}: the restored world's climate and land fields`, tsSaveFields(t), all, saveFields)
  await CE.stepCoupledEpoch(sim, coupled, optionsOf(controls))
  each(restored, (w) => w.epoch(controls))
  each(worlds, (w) => w.epoch(controls))
  agree(`${shape}: the uninterrupted world's next epoch`, [serializePlateSimulation(sim), meshPayloadOf(coupled)], worlds, (w) => [w.snapshot(), w.meshPayload()])
  agree(`${shape}: the restored world's next epoch`, [serializePlateSimulation(sim), meshPayloadOf(coupled)], restored, (w) => [w.snapshot(), w.meshPayload()])
  each(all, (w) => { if (JSON.stringify(w.snapshot()) !== JSON.stringify(serializePlateSimulation(sim))) fail(`${shape}: the next epoch's snapshot JSON differs`) })
  // The land fields are of the mesh before the epoch now.
  agree(`${shape}: the climate and land fields after the epoch`, tsSaveFields(t), all, saveFields)
  restored.wasm.free()
  worlds.wasm.free()
  console.log(`engine: ${shape} — ${STEPS} Archean steps (${ts.rafts.length} rafts) saved and restored; the hand-over, ${EPOCHS} epochs (${eventCount} events, ${mesh.count} nodes) saved and restored; the climate, the hydrology (${water}), the ecology (${months} of 4 months given): native, wasm and TypeScript agree`)
}
// A level's tiles with land or shelf on the save's raster, as the job
// worker's landTiles and cubeLandTiles find them (scripts/jobWorker.ts;
// copied, since that module runs a worker when it loads).
const landTilesOf = (world, elevations, level) => {
  const spec = MT.tileSpec(level)
  const { width, height } = world
  const out = []
  if (world.kind === 'sphere') {
    cubeTileSamples(world, spec.level, spec.cells, (tile, xs, ys) => {
      for (let k = 0; k < xs.length; k++) {
        const x = Math.min(width - 1, Math.floor(xs[k]))
        const y = Math.min(height - 1, Math.max(0, Math.floor(ys[k])))
        if (elevations[y * width + x] > SHELF_BREAK) { out.push([tile.x, tile.y]); return }
      }
    })
    return out
  }
  const { cols, rows } = MT.tileGrid(width, height, spec)
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const corner = MT.tileCorner({ level, x: tx, y: ty }, spec)
      let found = false
      for (let dy = 0; dy < spec.cells && !found; dy++) {
        const y = (corner.y + dy) % height
        for (let dx = 0; dx < spec.cells; dx++) if (elevations[y * width + (corner.x + dx) % width] > SHELF_BREAK) { found = true; break }
      }
      if (found) out.push([tx, ty])
    }
  }
  return out
}
// The tiles a tile waits for, itself last, deduplicated: what a worker
// bakes before it.
const closureOf = (plan, target) => {
  const byKey = new Map(plan.map((p) => [`${p.tile.level}:${p.tile.x},${p.tile.y}`, p]))
  const order = []
  const seen = new Set()
  const visit = (t) => {
    const k = `${t.level}:${t.x},${t.y}`
    if (seen.has(k)) return
    seen.add(k)
    const p = byKey.get(k)
    for (const d of [...p.parents, ...p.upstream]) visit(d)
    order.push(p)
  }
  visit(target)
  return order
}

// LEVEL 1 BY REPLAY, native only (fork 3): the plan replayed at level 1's
// budget one epoch at a time with its checkpoints, the level's waters on
// its end as the artifact holds them, and the replay resumed from a
// checkpoint, against TypeScript's replayRuns and the job worker's
// replayLevel.
for (const shape of ['torus', 'sphere']) {
  const [width, height, detailSeed] = [512, 256, 12345]
  const weather = defaultWeatherParams()
  const controls = { alluvium: TECTONICS_INPUTS.alluvium.default, rockContrast: TECTONICS_INPUTS.rockContrast.default }
  const plan = {
    seed: 'replay', width, height, shape,
    genesis: [{ epochs: 40, diffusion: 2, landShare: 0.4 }],
    tectonics: [{ epochs: 4, controls, weather }, { epochs: 3, controls, weather: { ...weather, temperatureOffset: -2 }, restored: true }],
  }
  const checkpoints = []
  const { sim: replayed, terrain } = await RR.replayRuns(plan, { budget: levelBudget(1), onCheckpoint: (position, take) => { checkpoints.push({ position, snapshot: structuredClone(take()) }) } })
  const cells = climateCellsFromWeather(terrain.weather.result)
  const atNodes = climateAtPoints(cells, meshPoints(terrain.mesh, terrain.z))
  const water = levelHydrology(terrain.mesh, terrain.z, terrain.routing, terrain.areas, terrain.sedimentFlux, {
    precipitation: atNodes.precipitation, temperature: atNodes.temperature, monsoonIndex: atNodes.monsoonIndex, meanRunoff: meanLandRunoff(cells),
  }, { width, height, budget: levelBudget(1), detailSeed })
  const artifact = meshLevelToArtifact({ level: 1, mesh: terrain.mesh, z: terrain.z, routing: terrain.routing, ...water, inserted: 0 })
  const json = (a) => JSON.stringify([a.graph && serializeRiverGraph(a.graph).json, a.waterBodies])

  const replay = native.Replay.start(plan, 1, null, 4)
  const due = []
  for (;;) {
    const position = replay.checkpointDue()
    if (position) due.push({ position, snapshot: replay.snapshot() })
    if (!replay.step()) break
  }
  if (canonical(due) !== canonical(checkpoints)) fail(`${shape}: level 1's checkpoints differ from TypeScript`)
  const level = replay.level(width, detailSeed)
  if (canonical(level) !== canonical(artifact)) fail(`${shape}: level 1 differs from TypeScript`)
  if (json(level) !== json(artifact)) fail(`${shape}: level 1's JSON differs from TypeScript`)
  // Resumed from the last checkpoint, its state through JSON as a
  // checkpoint's state.json goes.
  const at = checkpoints[checkpoints.length - 1]
  const resumed = native.Replay.start(plan, 1, { position: at.position, snapshot: { ...at.snapshot, state: viaJson(at.snapshot.state) } }, null)
  while (resumed.step());
  if (canonical(resumed.level(width, detailSeed)) !== canonical(artifact)) fail(`${shape}: level 1 resumed differs from TypeScript`)
  console.log(`engine: ${shape} — level 1 replayed (${artifact.count} nodes, ${artifact.graph.reaches.length} reaches, ${artifact.graph.courses.length} courses), ${checkpoints.length} checkpoints, resumed: native and TypeScript agree`)

  // THE TILE LEVELS on it: the plan, then a level-3 tile with its
  // closure baked in order — the level-2 parents with their upstream
  // tiles, the level-3 upstream ones — on one baker, as a worker does.
  const world = terrain.mesh.domain
  const elevations = rasteriseNodeField(terrain.mesh, terrain.z, width, height)
  const land = Object.fromEntries([2, 3].map((l) => [l, landTilesOf(world, elevations, l)]))
  const mesh1 = meshLevelMesh(artifact, width, height, shape)
  const tsPlan = planTiles({ mesh: mesh1, z: artifact.z, routing: meshRouting(mesh1, artifact.z), width, height, levels: [2, 3], landTiles: (l) => land[l].map(([x, y]) => ({ level: l, x, y })) })
  const tilePlan = native.planTiles(level, width, height, shape, land)
  if (canonical(tilePlan) !== canonical(tsPlan)) fail(`${shape}: the tile plan differs from TypeScript`)
  const third = tsPlan.filter((p) => p.tile.level === 3).map((p) => closureOf(tsPlan, p.tile))
  const withUpstream = third.filter((c) => c.some((p) => p.upstream.length > 0))
  const bakes = (withUpstream.length ? withUpstream : third).sort((a, b) => a.length - b.length)[0]
  const { uplift, hardness } = coarseForcingFields(replayed, world)
  const saved = {
    width, height, kind: shape === 'sphere' ? 'SphereWorld' : 'TorusWorld', detailSeed, lithoSeed: 777,
    erosionControls: controls, climate: climateCellValues(cells),
    uplift: { data: uplift, resX: CLIMATE_RES_X, resY: CLIMATE_RES_Y }, erodibility: { data: hardness, resX: CLIMATE_RES_X, resY: CLIMATE_RES_Y },
  }
  const baker = native.TileBaker.open(level, { width, height, shape, detailSeed, lithoSeed: 777, controls, uplift, erodibility: hardness, forcingResX: CLIMATE_RES_X, forcingResY: CLIMATE_RES_Y, climate: saved.climate }, 4)
  const macro = createMeshSampler(mesh1, artifact.z)
  const done = new Map()
  const keyOf = (t) => `${t.level}:${t.x},${t.y}`
  for (const p of bakes) {
    const t = p.tile
    const upstream = p.upstream.map((u) => done.get(keyOf(u))).map((a) => ({ tile: a.tile, count: a.count, nodes: a.nodes, outflow: a.outflow }))
    let parent = { mesh: mesh1, z: artifact.z, discharge: null, sampler: macro, macro }
    let pieces = null
    if (t.level === 3) {
      pieces = p.parents.map((q) => done.get(keyOf(q))).map((a) => ({ tile: a.tile, count: a.count, nodes: a.nodes, z: a.z }))
      const patch = tileParentOn(pieces, world)
      parent = { mesh: patch.mesh, z: patch.z, discharge: null, sampler: createMeshSampler(patch.mesh, patch.z, patch.region), macro }
    }
    const want = bakedTileToArtifact(await bakeMeshTile(tileBakeInputs(saved, parent, artifact.graph, upstream), t, { rounds: 2 }))
    done.set(keyOf(t), want)
    if (canonical(baker.bake(t, pieces, upstream, 2)) !== canonical(want)) fail(`${shape}: tile ${keyOf(t)} differs from TypeScript`)
  }
  console.log(`engine: ${shape} — the tile plan (${tsPlan.length} tiles), ${bakes.length} tiles baked (${bakes.filter((p) => p.upstream.length).length} with upstream, ${bakes.filter((p) => p.tile.level === 3).length} of level 3): native and TypeScript agree`)
}

// THE PLANET PREVIEW (the runtime's handlePlanetPreview): the climate on
// the sample world of both shapes, twice under other controls (the
// meshes' walks go on from the first), on one Preview of each build.
{
  const previews = { native: new native.Preview(), wasm: new wasm.Preview() }
  const [width, height] = [128, 64]
  for (const shape of ['torus', 'sphere']) {
    const domain = domainOfKind(shape, width, height)
    const elevation = sampleWorldElevation(domain)
    let plan = null
    for (const params of [defaultWeatherParams(), { ...defaultWeatherParams(), temperatureOffset: 3, humidity: 1.2 }]) {
      const chain = WS.climateChain(elevation, domain, params)
      const { cm, z, land, dry } = chain.weather.terrain
      const points = { count: cm.mesh.count, x: cm.mesh.x, y: cm.mesh.y, height: z, land, dry, alive: null }
      const classes = classifyPoints(climateAtPoints(chain.cells, points), points, domain)
      const pixelLand = WS.pixelLandOf(elevation, null)
      plan ??= triangleRaster(cm.mesh.tri, width, height)
      const raster = (ids, sea) => Uint8Array.from(rasteriseNodePart(cm.mesh.tri, ids, land, pixelLand, sea, width, height, true, undefined, plan))
      const c = chain.chart
      const want = {
        temperature: c.temperature, wind: c.wind, windMesh: vectors(cm.cellM, chain.weather.mesh.wind), currentsMesh: vectors(cm.cellM, chain.weather.mesh.currents),
        currents: c.currents, currentAnomaly: c.currentAnomaly, precipitation: c.precipitation, seasonalAmplitude: c.seasonalAmplitude, monsoonIndex: c.monsoonIndex,
        koppen: raster(classes.koppen, 0), biomes: raster(classes.biome, Biome.Ocean),
      }
      agree(`${shape}: the preview's climate`, want, previews, (p) => p.climate(shape, width, height, elevation, params))
    }
  }
  console.log('engine: the planet preview on both shapes, twice each: native, wasm and TypeScript agree')
}

// THE REPLAY AT LEVEL 0 (the runtime's handleReplayRuns): the world a
// plan's replay ends on, against TypeScript's replayRuns in a module graph
// of its own (the field meshes' walks are module state per domain there).
for (const shape of ['torus', 'sphere']) {
  const fresh = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
  const F = (p) => fresh.ssrLoadModule(p)
  const replayRuns = (await F('/src/generator/pipeline/replayRuns.ts')).replayRuns
  const { serializePlateSimulation: serialize } = await F('/src/generator/tectonics/plateSimulation.ts')
  const { encodeCoupledTerrain } = await F('/src/generator/pipeline/coupledEpoch.ts')
  await fresh.close()
  const weather = defaultWeatherParams()
  const controls = { alluvium: TECTONICS_INPUTS.alluvium.default, rockContrast: TECTONICS_INPUTS.rockContrast.default }
  const plan = {
    seed: 'level0', width: 256, height: 128, shape,
    genesis: [{ epochs: 30, diffusion: 2, landShare: 0.4 }],
    tectonics: [{ epochs: 3, controls, weather }, { epochs: 2, controls, weather: { ...weather, humidity: 0.8 }, restored: true }],
  }
  const { sim: replayed, terrain } = await replayRuns(plan, { budget: D.budget })
  const bytes = encodeCoupledTerrain(terrain)
  const worlds = {}
  for (const [name, build] of Object.entries({ native, wasm })) {
    const replay = build.Replay.start(plan, 0)
    while (replay.step());
    worlds[name] = replay.world()
  }
  agree(`${shape}: the replayed world's snapshot`, viaJson(serialize(replayed)), worlds, (w) => w.snapshot())
  agree(`${shape}: the replayed world's terrain`, { nodes: bytes.nodes, connectivity: bytes.connectivity, z: bytes.z }, worlds, (w) => {
    const m = w.meshPayload()
    return { nodes: m.nodes, connectivity: m.connectivity, z: m.z }
  })
  worlds.wasm.free()
  console.log(`engine: ${shape} — a plan replayed at level 0 (${replayed.epoch} epochs): native, wasm and TypeScript agree`)
}

if (failed) process.exit(1)
console.log(`engine: native and wasm ${wasm.version()}`)
process.exit(0)
