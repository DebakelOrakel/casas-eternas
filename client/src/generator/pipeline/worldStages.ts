import type { Domain, DomainGrid } from '../core/domain'
import type { PlateSimulation } from '../tectonics/plateSimulation'
import type { MeshTerrain } from './meshErosionStage'
import type { CoupledTerrain } from './coupledEpoch'
import { landBilinearAtNodes, nearestCellAtNodes, rasteriseNodeField, rasteriseNodePart, type TriangleRaster } from '../mesh/meshRaster'
import { Biome, classifyPoints } from '../climate/biomes'
import { SURFACE_TUNING } from '../surface/surfaceTuneParams'
import { computeHydrogeology, type SpringFeature } from '../surface/hydrogeology'
import { coverField } from '../surface/cover'
import { DEFAULT_PLANET_FORCING, type PlanetForcing } from '../planet/planetForcing'
import { climateAtPoints, climateCellsFromRefined, climateCellsFromWeather, meshPoints, type ClimateCells, type ClimatePoints, type PointClimate } from '../climate/climatePoints'
import { refinedChart, weatherChart } from '../climate/climateChart'
import { OCEAN_PRECIP } from '../climate/precipitation'
import { computeIceOnMesh } from '../surface/glacial'
import type { PeriodicTriangulation } from '../mesh/periodicDelaunay'
import { meshSubstrate, waterFieldsFromMesh } from '../mesh/meshHydrology'
import { coarseForcingFields } from './erosionForcing'
import { worldAgeMa, worldEpoch } from '../core/worldTime'
import { accumulateDischargeOn, computeLakesOn, watershedsOn, densityToCriticalArea, channelThreshold, CANONICAL_RIVER_DENSITY, accumulateRegimeInputsOn, riparianPrecipitationOn, type LakeFields } from '../surface/hydrology'
import type { TerrainFeature } from '../tectonics/terrainFeatures'
import { computeWeather } from '../climate/weather'
import { climateTerrain, type ClimateTerrain } from '../climate/climateMesh'
import { annualFromMonths, refineClimate, refinedAnnualWind, type RefinedClimate } from '../climate/refinement'
import type { CellVectors } from '../climate/wind'
import { SEA_LEVEL } from '../elevation/elevationScale'
import { buildRiverGraph, type RiverGraph } from '../surface/riverGraph'
import { computeRiverCourses } from '../surface/riverCourse'
import { buildCoastGraph, type CoastGraph } from '../surface/coastGraph'
import { findSedimentBasins, type SedimentBasin } from '../surface/sedimentBasins'
import { CLIMATE_RES_X, CLIMATE_RES_Y } from '../climate/climateField'
import type { EcologyInputs } from '../ecology/ecologyField'
import { collectVolcanoes } from '../tectonics/volcanoes'
import { computeCratonOldnessField } from '../crust/raftField'

// THE STAGES' COMPUTATIONS (docs/decisions/rust-engine.md): what the
// runtime (runtime.ts) computes for a stage, as functions of their inputs
// alone — no module state, no messages, no render. The runtime holds the
// state, decides when a stage runs, posts its results and draws; these say
// what the result is. Taken out of the runtime's handlers unchanged
// (2026-10-20), so that the Rust engine has one function to port per step
// and its test one function to compare against.

// The climate's controls (the climate panel's and the planet's).
export interface ClimateParams {
  temperatureOffset: number
  temperatureContrast: number
  humidity: number
  equatorOffset: number
  planet?: PlanetForcing
}

// A climate at the nodes of one terrain mesh (the coupled terrain's, the
// arrays it had then).
export interface LandClimate {
  mesh: PeriodicTriangulation
  z: Float32Array
  points: ClimatePoints
  climate: PointClimate
  biome: Uint8Array
  koppen: Uint8Array
}

// One climate pass, v1 or v2: the full chain in its load-bearing order — base
// temperature → wind → ocean currents (SST adjusts temperature) → seasonal
// amplitude → monsoon/precipitation — on the climate's field mesh
// (climate/weather.computeWeather, shared with the history's epochs, so the
// panel's overlays and the carved valleys can never disagree about what
// the climate IS). `dryLand` is the terminal-basin dry-floor override
// (LakeFields.dryBasin): those sub-sea cells count as land throughout,
// with an unclamped downward lapse (see computeTemperature). `domain`:
// what the elevation raster covers, one cell per unit. The cells every
// reader samples (climatePoints.climateCellsFromWeather) and the chart the
// screen paints (climateChart.weatherChart) come with it.
export function climateChain(elevation: Float32Array, domain: Domain, params: ClimateParams, dryLand?: Uint8Array) {
  const { width, height } = domain
  const weather = computeWeather(climateTerrain(domain, elevation, width, height, dryLand), params)
  return { weather, cells: climateCellsFromWeather(weather), chart: weatherChart(weather) }
}
export type ClimateChain = ReturnType<typeof climateChain>

// The climate at a terrain's nodes and its biomes there. `dry`: the
// terminal basins' dry floors per node (land below the sea), or null.
export function landClimateOf(cells: ClimateCells, terrain: { mesh: PeriodicTriangulation; z: Float32Array }, dry: Uint8Array | null = null): LandClimate {
  const points = meshPoints(terrain.mesh, terrain.z, dry)
  const atNodes = climateAtPoints(cells, points)
  const { biome, koppen } = classifyPoints(atNodes, points, terrain.mesh.domain)
  return { mesh: terrain.mesh, z: terrain.z, points, climate: atNodes, biome, koppen }
}

// The world raster's land for the land fields' rasters: above the sea, or
// a terminal basin's dry floor (null: none).
export function pixelLandOf(elevation: Float32Array, dryBasin: Uint8Array | null): Uint8Array {
  const out = new Uint8Array(elevation.length)
  for (let i = 0; i < out.length; i++) if (elevation[i] > SEA_LEVEL || (dryBasin !== null && dryBasin[i] === 1)) out[i] = 1
  return out
}

// A node field of the land on the world raster (rasteriseNodePart over
// the land's nodes and pixels).
export function landRaster(land: LandClimate, field: ArrayLike<number>, pixelLand: Uint8Array, width: number, height: number, outside: number, nearest: boolean, plan: TriangleRaster): Float32Array {
  return rasteriseNodePart(land.mesh, field, land.points.land, pixelLand, outside, width, height, nearest, undefined, plan)
}

// A biome or a Köppen class per node on the world raster: a land pixel
// the heaviest land corner's id, the sea Ocean / 0.
export function idRaster(land: LandClimate, ids: Uint8Array, pixelLand: Uint8Array, width: number, height: number, sea: number, plan: TriangleRaster): Uint8Array {
  return Uint8Array.from(landRaster(land, ids, pixelLand, width, height, sea, true, plan))
}

// The coast type per shore node (coastGraph.CoastGraph.type) on the world
// raster for the water shader: the raster's own shore pixels (a land pixel
// with a sea pixel among its eight neighbours — the drawn coastline) take
// the heaviest shore corner of their triangle, every other pixel 0.
export function coastTypeRaster(mesh: PeriodicTriangulation, nodeType: Uint8Array, elevation: Float32Array, grid: DomainGrid, plan: TriangleRaster): Uint8Array {
  const { resX: width, resY: height } = grid
  const shorePixel = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x
      if (elevation[p] <= SEA_LEVEL) continue
      for (let dy = -1; dy <= 1 && !shorePixel[p]; dy++) for (let dx = -1; dx <= 1; dx++) if (elevation[grid.neighbour(x, y, dx, dy)] <= SEA_LEVEL) { shorePixel[p] = 1; break }
    }
  }
  const typed = new Uint8Array(mesh.vertexSlots)
  for (let v = 0; v < typed.length; v++) if (nodeType[v] > 0) typed[v] = 1
  return Uint8Array.from(rasteriseNodePart(mesh, nodeType, typed, shorePixel, 0, width, height, true, undefined, plan))
}

// The largest of a node field over the land nodes in each cell of the
// climate's chart (256 × 128) — the migration's river corridors, which run
// on the chart (0 where no land node lies).
export function chartMaxOfNodes(mesh: PeriodicTriangulation, field: Float32Array, z: Float32Array): Float32Array {
  const grid = mesh.domain.grid(CLIMATE_RES_X, CLIMATE_RES_Y)
  const out = new Float32Array(CLIMATE_RES_X * CLIMATE_RES_Y)
  for (let v = 0; v < mesh.vertexSlots; v++) {
    if (!mesh.vAlive[v] || z[v] <= SEA_LEVEL) continue
    const c = grid.cellAt(mesh.vx[v], mesh.vy[v])
    if (field[v] > out[c]) out[c] = field[v]
  }
  return out
}

// Current fold-mountain (continent-continent collision) belts, for the ecology
// layer's tin / lode-gold / gem provenance: 'range' features that are NON-volcanic
// (excludes subduction/island arcs) and non-subsiding (excludes oceanic ridges),
// with real positive uplift, and a real plate pair (excludes hotspot -1 / flood
// basalt -2 and rift-valley troughs, which are negative). On-crust (unlike the
// fixed-coord sutures), so they don't drift off into the ocean.
export function collectOrogens(features: TerrainFeature[]): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = []
  for (const f of features) {
    if (f.kind === 'range' && !f.volcanic && !f.subsides && f.thickness > 3 && f.plateB >= 0) out.push({ x: f.x, y: f.y })
  }
  return out
}

// THE CLIMATE STEP'S REFINEMENT (climate/refinement.ts), on the climate
// the step shows and the terrain it was computed on: the values per cell
// (a save's, taken as they are, or computed), the chart, the cells every
// reader samples, the annual fields of the chart and of the mesh.
export function refinedClimateOf(
  elevation: Float32Array, domain: Domain, params: ClimateParams, meshClimate: { temperature: Float64Array; wind: CellVectors },
  restored: RefinedClimate | undefined, onShare: (share: number) => void,
) {
  const { width, height } = domain
  const r: RefinedClimate = restored ?? refineClimate(elevation, domain, params, meshClimate.temperature, meshClimate.wind, onShare)
  const terrain = climateTerrain(domain, elevation, width, height)
  const chart = refinedChart(r, terrain)
  const cells = climateCellsFromRefined(r, terrain)
  // The refined climate takes the history's place (build step 5b): its
  // annual fields derived from the months, its biomes classified from them.
  const n = CLIMATE_RES_X * CLIMATE_RES_Y
  const annual = annualFromMonths(chart, n)
  const annualWind = new Float32Array(n * 2)
  for (let m = 0; m < chart.months; m++) for (let i = 0; i < n * 2; i++) annualWind[i] += chart.wind[m * n * 2 + i] / chart.months
  const meshWind = refinedAnnualWind(r)
  const meshAnnual = annualFromMonths(r, r.cells)
  return { refined: r, terrain, chart, cells, annual, annualWind, meshWind, meshTemperature: Float64Array.from(meshAnnual.temperature) }
}

// THE HYDROLOGY ON THE MESH (phase 4.3): the lakes and the discharge over
// the mesh's own routing under the climate at its nodes (DEC-0036 phase
// 7), and the raster fields the map and the save's rasters read,
// rasterised from the nodes' bodies (meshHydrology.waterFieldsFromMesh) —
// one truth, the bodies, two representations.
export interface MeshHydrology {
  discharge: Float32Array
  lakes: LakeFields
  // The climate at the nodes it ran under (a terminal basin's dry floor is
  // land there).
  land: LandClimate
  // Per node, once the pass has run: the map's biome (the riparian
  // corridors, the salt flats, the frozen lakes and the glaciers), the
  // ecology's (the same without the glaciers' ice: a glacier is the ice
  // with a thickness, the ground under it keeps its class) and the water
  // table's depth (metres, −1 under water).
  biome: Uint8Array | null
  ecologyBiome: Uint8Array | null
  waterTable: Float32Array | null
  // The raster recovery of the bodies.
  raster: { depth: Float32Array; saltFlat: Uint8Array; dryBasin: Uint8Array; frozen: Uint8Array; level: Float32Array; body: Int32Array; surface: Uint8Array }
}

export function hydrologyOnMesh(terrain: MeshTerrain, elevationRaster: Float32Array, width: number, height: number, land: LandClimate): MeshHydrology {
  const sub = meshSubstrate(terrain.mesh, terrain.routing, terrain.areas)
  const discharge = accumulateDischargeOn(sub, terrain.z, land.climate.precipitation, land.climate.temperature)
  const lakes = computeLakesOn(sub, discharge, terrain.z, land.climate.temperature)
  return { discharge, lakes, land, biome: null, ecologyBiome: null, waterTable: null, raster: waterFieldsFromMesh(terrain.mesh, lakes.body, lakes.bodies, elevationRaster, width, height) }
}

// The climate the hydrology starts from: the step's (its cells, its
// controls, whether it is the refinement) and its climate at the nodes.
export interface HydrologyClimate {
  params: ClimateParams
  cells: ClimateCells
  refined: boolean
  land: LandClimate
}

// THE HYDROLOGY'S ROUTE: the lakes and the discharge on the mesh, under
// the climate at its nodes (the mesh's own routing, derived with the
// terrain); and, unless the climate is the step's refinement, the climate
// on the CURRENT terrain with the terminal basins' dry floors as land, the
// hydrology once more under it. `terrain`: the terrain's raster (the
// climate's input), `elevation`: the raster the lakes' recovery is drawn
// against. `onClimate` sees the v2 chain, the climate at the nodes and the
// dry floors on the raster as soon as they are made, before the hydrology
// runs again under them (the runtime posts the climate there).
//
// CLIMATE REFINEMENT (v2, k=1): climate v1 was computed on the
// PRE-EROSION terrain with the optimistic mask (every sub-sea cell =
// water) — the stage sits before erosion since the stage-2 coupling.
// This pass re-runs the chain on the CURRENT (eroded) terrain with
// the terminal-basin dry floors counted as land, and is therefore
// UNCONDITIONAL since 2026-08-16: it is where the post-erosion
// climate and biome truth comes from at all — the first golden run
// after the reorder caught v1 biomes calling erosion-grown coast
// cells Ocean above sea level. Then re-derive the
// precipitation-dependent hydrology once: discharge and lakes — the
// ROUTING is untouched (the terrain didn't move), so no re-flood.
// Deliberately ONE refinement step, mirroring the riparian pattern:
// iterate further and this becomes a fixed-point solver for a
// second-decimal correction nobody can see.
// Not over the step's refinement: it is computed on the step's own
// land mask, without the dry-basin override, and recomputing the
// cheap chain here would put the history's climate back in its place.
export function routeHydrology(
  mt: MeshTerrain, terrain: Float32Array, elevation: Float32Array, domain: Domain, width: number, height: number, weather: HydrologyClimate,
  onClimate?: (chain: ClimateChain, land: LandClimate, dryBasin: Uint8Array) => void,
): MeshHydrology {
  let land = weather.land.mesh === mt.mesh && weather.land.z === mt.z ? weather.land : landClimateOf(weather.cells, mt)
  let onMesh = hydrologyOnMesh(mt, elevation, width, height, land)
  if (weather.refined) return onMesh
  const chain = climateChain(terrain, domain, weather.params, onMesh.raster.dryBasin)
  land = landClimateOf(chain.cells, mt, onMesh.lakes.dryBasin)
  onClimate?.(chain, land, onMesh.raster.dryBasin)
  return hydrologyOnMesh(mt, elevation, width, height, land)
}

// What the hydrology's features read of the world beyond the mesh: the
// plate simulation (the forcing's hardness, the cratons' age, the world's
// age) and the coupled terrain (the column, the last epoch's ice and its
// start), when it is the mesh's.
export interface HydrologyWorld {
  sim: PlateSimulation
  coupled: CoupledTerrain | null
  planet: PlanetForcing | undefined
}

export interface HydrologyFeatures {
  graph: RiverGraph
  coast: CoastGraph
  sedimentBasins: SedimentBasin[]
  oases: SpringFeature[]
  // Ice thickness in metres on the world raster.
  ice: Float32Array
  // The map's rasters of the mesh's results.
  precipitationEffective: Float32Array
  watersheds: Uint16Array
  discharge: Float32Array
  coastType: Uint8Array
  biomes: Uint8Array
}

// THE HYDROLOGY'S FEATURES on a route: the riparian biomes, the feature
// graph, the hydrogeology, the river courses, the coast, the sediment
// basins and the ice, per node, and their rasters. Sets the route's
// biomes and water table (MeshHydrology.biome, ecologyBiome, waterTable).
// `terrain`: the terrain's raster, `elevation`: the raster the lakes were
// recovered against, `dryBasin`: the recovery's dry floors on it, `cells`:
// the climate's cells (the coast's wind), `plan`: the pixels' triangles of
// the mesh, asked for where a raster is drawn (the runtime keeps them).
export function hydrologyFeatures(
  world: HydrologyWorld, mt: MeshTerrain, om: MeshHydrology, maxDischarge: number, threshold: number,
  terrain: Float32Array, elevation: Float32Array, dryBasin: Uint8Array | null, cells: ClimateCells, width: number, height: number, plan: () => TriangleRaster,
): HydrologyFeatures {
  const { sim, coupled } = world
  const domain = sim.domain
  const land = om.land
  const sub = meshSubstrate(mt.mesh, mt.routing, mt.areas)
  const pixelLand = pixelLandOf(terrain, dryBasin)
  // THE RIPARIAN BIOMES on the mesh (DEC-0036 phase 7): the rivers and
  // lakes moisten the land around them (hydrology.
  // riparianPrecipitationOn), and the biomes are classified again from
  // that effective rain; a terminal basin's salt flat and a frozen
  // basin are hydrology states, not climates — they win.
  const precipEff = riparianPrecipitationOn(sub, mt.z, om.discharge, threshold, maxDischarge, om.lakes.depth, om.lakes.frozen, land.climate.precipitation)
  const nodeBiome = classifyPoints(land.climate, land.points, domain, precipEff).biome
  const precipitationEffective = landRaster(land, precipEff, pixelLand, width, height, OCEAN_PRECIP, false, plan())
  for (let v = 0; v < nodeBiome.length; v++) {
    if (!land.points.land[v]) continue
    if (om.lakes.saltFlat[v]) nodeBiome[v] = Biome.SaltFlat
    if (om.lakes.frozen[v]) nodeBiome[v] = Biome.Glacier
  }
  om.ecologyBiome = nodeBiome.slice()
  // The forcing's hardness at the nodes (the nearest cell of its raster):
  // the hydrogeology's, the coast's and the sediment basins' input.
  const forcingFields = coarseForcingFields(sim, sim.domain)
  const nodeHardness = nearestCellAtNodes(forcingFields.hardness, CLIMATE_RES_X, CLIMATE_RES_Y, mt.mesh)
  // The cover (phase 5.5) from the climate's own biomes at the nodes,
  // for the infiltration.
  const plantsFromMa = (world.planet ?? DEFAULT_PLANET_FORCING).landPlantsFromMa
  const cover = coverField(land.biome, worldAgeMa(sim.archeanEpochs, sim.epoch) >= plantsFromMa)
  // THE FEATURE GRAPH (phase 2) on the mesh (phase 4.3): the network
  // as data, with the biomes as bank material and the last erosion's
  // sediment flux as load. The ribbons derive from it.
  const regime = accumulateRegimeInputsOn(sub, mt.z, land.climate.temperature, land.climate.precipitation, land.climate.monsoonIndex, land.climate.months ?? undefined)
  const graph = buildRiverGraph({
    substrate: sub, discharge: om.discharge, elevation: mt.z, threshold, maxDischarge,
    bodies: om.lakes.bodies, body: om.lakes.body, lakeDepth: om.lakes.depth,
    sedimentFlux: mt.sedimentFlux.length === mt.mesh.vertexSlots ? mt.sedimentFlux : undefined,
    biomes: nodeBiome,
    regime,
    criticalArea: densityToCriticalArea(CANONICAL_RIVER_DENSITY, domain),
  })
  // THE HYDROGEOLOGY (phase 5a): the column's materials, the springs
  // on the graph, the regime re-judged with the baseflow, the water
  // table — on the mesh, under the climate at its nodes.
  const ground = computeHydrogeology({
    sub, elevation: mt.z, graph,
    column: coupled && coupled.mesh === mt.mesh ? coupled.column : null,
    hardness: nodeHardness,
    precipitation: land.climate.precipitation, temperature: land.climate.temperature, monsoonIndex: land.climate.monsoonIndex,
    cover, regime, discharge: om.discharge, cellM: domain.metresAround / width,
  })
  om.waterTable = ground.waterTableDepthM
  const oases = ground.springs.filter((s) => s.oasis)
  // THE RIVER COURSE (phase 3): pattern, meanders, braids and deltas per
  // reach, seeded from the world so a world always gets the same bends.
  graph.courses = computeRiverCourses(graph, { cellM: domain.metresAround / width, seed: sim.warpSeed, domain })
  // THE COAST (F5) on the mesh's shore nodes: exposure from the wind
  // (the climate's cells read at the nodes), hardness from the erosion
  // forcing's field, sediment from the graph's mouths — a type per reach.
  const windy = climateAtPoints(cells, land.points, { wind: true })
  const coast = buildCoastGraph({ mesh: mt.mesh, z: mt.z, windE: windy.windE!, windS: windy.windS!, hardness: nodeHardness, graph })
  // SEDIMENT BASINS (F1): what the last epoch's erosion deposited, per
  // node against the heights it started from, with the provenance of
  // the catchments feeding each basin. A loaded save brings the start
  // with it (`mesh/preErosionZ.f32`); a world before its first epoch
  // has none (its preErosionZ is its z) and gets no basins.
  const sedimentBasins = coupled && coupled.mesh === mt.mesh && coupled.preErosionZ.length === mt.z.length && coupled.preErosionZ !== mt.z
    ? findSedimentBasins({
      mesh: mt.mesh, before: coupled.preErosionZ, after: mt.z, substrate: sub, graph,
      cratonAge: nearestCellAtNodes(computeCratonOldnessField(sim.rafts, worldEpoch(sim.archeanEpochs, sim.epoch), sim.archeanEpochs, CLIMATE_RES_X, CLIMATE_RES_Y, sim.domain), CLIMATE_RES_X, CLIMATE_RES_Y, mt.mesh),
      hardness: nodeHardness,
    }).basins
    : []
  // The map's rasters of the mesh's results (fork 5: the chart is the
  // address and the textures): the watersheds and the discharge a land
  // pixel's heaviest land corner's, the coast type on the raster's own
  // shore pixels from the shore nodes.
  const watersheds = Uint16Array.from(landRaster(land, watershedsOn(sub, mt.z), pixelLand, width, height, 0, true, plan()))
  const discharge = landRaster(land, om.discharge, pixelLand, width, height, 0, true, plan())
  const coastType = coastTypeRaster(mt.mesh, coast.type, elevation, sim.domain.grid(width, height), plan())
  // THE ICE: the history's own (phase 6, the last epoch's steady state
  // on the mesh) when the terrain has been through an epoch, or a save
  // of one was loaded (`mesh/ice.f32`); otherwise the steady state of
  // this climate on the mesh (a world before its first epoch).
  const nodeIce = coupled && coupled.mesh === mt.mesh && coupled.ice.length === mt.mesh.vertexSlots
    ? coupled.ice
    : computeIceOnMesh({ mesh: mt.mesh, z: mt.z, seaLevelTemperature: land.climate.seaLevelTemperature, precipitation: land.climate.precipitation, seasonalAmplitude: land.climate.seasonalAmplitude, cellM: domain.metresPerUnit }).thickness
  const ice = rasteriseNodeField(mt.mesh, nodeIce, width, height)
  for (let c = 0; c < ice.length; c++) if (elevation[c] <= 0 || ice[c] < SURFACE_TUNING.iceMinThicknessM) ice[c] = 0
  // THE ICE BODY IS A BIOME (phase 6, decided 2026-09-23: the climate
  // class Ice stays, Glacier is the ice with a thickness): under ice the
  // node's biome is Glacier, whatever the climate said.
  for (let v = 0; v < nodeBiome.length; v++) if (land.points.land[v] && mt.z[v] > SEA_LEVEL && nodeIce[v] >= SURFACE_TUNING.iceMinThicknessM) nodeBiome[v] = Biome.Glacier
  om.biome = nodeBiome
  const biomes = idRaster(land, nodeBiome, pixelLand, width, height, Biome.Ocean, plan())
  return { graph, coast, sedimentBasins, oases, ice, precipitationEffective, watersheds, discharge, coastType, biomes }
}

// The lake depths per node with frozen basins zeroed — what the ecology
// (fish) should see as WATER. Computed on demand rather than stored: the
// full depth stays the display/save truth (ice is water).
export function liquidLakeDepth(lakes: LakeFields): Float32Array {
  const out = lakes.depth.slice()
  for (let i = 0; i < out.length; i++) if (lakes.frozen[i]) out[i] = 0
  return out
}

// THE ECOLOGY'S INPUTS (ecology/ecologyField.prepareEcology) on the
// terrain mesh: the climate at its nodes (the hydrology's, when it ran on
// this mesh), its waters, the world's volcanoes, collision belts and
// cratons. Hydrology is optional — without it, fish falls back to its
// marine component.
export function ecologyInputsOf(
  sim: PlateSimulation, mt: MeshTerrain, land: LandClimate, om: MeshHydrology | null,
  hydrology: { maxDischarge: number; oases: { x: number; y: number }[] } | null,
): EcologyInputs {
  const cratonField = computeCratonOldnessField(sim.rafts, worldEpoch(sim.archeanEpochs, sim.epoch), sim.archeanEpochs, CLIMATE_RES_X, CLIMATE_RES_Y, sim.domain)
  return {
    mesh: mt.mesh,
    z: mt.z,
    land: land.points.land,
    climate: land.climate,
    biomes: om?.ecologyBiome ?? land.biome,
    discharge: om?.discharge ?? null,
    maxDischarge: hydrology?.maxDischarge ?? 0,
    // Liquid water only: a frozen basin is a glacier and feeds no fishery.
    lakeDepth: om ? liquidLakeDepth(om.lakes) : null,
    saltFlat: om?.lakes.saltFlat ?? null,
    waterTable: om?.waterTable ?? null,
    oases: hydrology?.oases ?? [],
    volcanoes: collectVolcanoes(sim.features),
    // Collision belts for tin/lode-gold/gems: current fold mountains (on-crust)
    // + the accumulated (advected) deep-time sutures.
    orogenPoints: [...collectOrogens(sim.features), ...sim.sutures],
    cratonAge: landBilinearAtNodes(cratonField, sim.domain.grid(CLIMATE_RES_X, CLIMATE_RES_Y), mt.mesh),
    warpSeed: sim.warpSeed,
    domain: sim.domain,
  }
}

// The hydrology's channel criterion: the canonical density over the
// world's mean runoff.
export function hydrologyThreshold(domain: Domain, meanRunoff: number): number {
  return channelThreshold(densityToCriticalArea(CANONICAL_RIVER_DENSITY, domain), meanRunoff)
}

// The climate the step computed, kept for the stages after it.
export type { ClimateTerrain }
