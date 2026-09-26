import { torusDomain, type Domain } from '../core/domain'
import { toroidalDistanceSq } from '../core/toroidal'
import { ITERATION_YEARS } from '../surface/erosionEngine'
import { TECTONIC_MA_PER_EPOCH } from '../core/worldTime'
import { raftField } from '../crust/raftField'
import { dynamicTopographyAt } from '../elevation/dynamicTopography'
import { raftBaselineAt } from '../elevation/elevationField'
import { ELEVATION_METERS, marginParameter } from '../elevation/elevationScale'
import { synthesisSampler } from '../elevation/elevationSampler'
import { MANTLE_RES_X, MANTLE_RES_Y } from '../mantle/mantleField'
import { buildMesh, densityTarget, MESH_Z, triangulatePoints } from '../mesh/meshBuild'
import { MESH_TUNING } from '../mesh/meshDensity'
import { addColumnField, columnVolumeM3, createColumn, cut, decodeColumn, deposit, encodeColumn, erodibilityOver, MESH_COLUMN, COLUMN_DEPTH, openLayer, permuteColumn, type SedimentColumn } from '../mesh/meshColumn'
import { computeCratonOldnessField } from '../crust/raftField'
import { deflectionAt, elasticThicknessKm, flexuralResponse } from '../tectonics/flexure'
import { foldFactorAt } from '../tectonics/folds'
import { buildFeatureBuckets } from '../elevation/elevationField'
import { sampleOceanAge } from '../tectonics/oceanAge'
import { computeWeather, defaultWeatherParams, type Weather, type WeatherParams } from '../climate/weather'
import { computeBiomes } from '../climate/biomes'
import { coverField, COVER_TUNING } from '../surface/cover'
import { SURFACE_TUNING } from '../surface/surfaceTuneParams'
import { DEFAULT_PLANET_FORCING } from '../planet/planetForcing'
import { worldAgeMa } from '../core/worldTime'
import { computeIceOnMesh, glacialErosionOnMesh } from '../surface/glacial'
import { computeCoastal } from '../surface/coastal'
import { rasteriseNodeField } from '../mesh/meshRaster'
import { meshRouting, meshSubstrate } from '../mesh/meshHydrology'
import { accumulateDischargeOn, computeLakesOn } from '../surface/hydrology'
import type { LakeAgeRecord } from '../tectonics/plateSimulationTypes'
import { worldEpoch } from '../core/worldTime'
import { runMeshErosion, type MeshRouting } from '../mesh/meshErosion'
import { compactMesh, decodeMesh, encodeMesh, permute } from '../mesh/meshSerial'
import { MeshState } from '../mesh/meshState'
import type { PeriodicTriangulation } from '../mesh/periodicDelaunay'
import { coarsen, refine } from '../mesh/remesh'
import { CLIMATE_RES_X, CLIMATE_RES_Y } from '../climate/climateField'
import type { PipelineOptions, WorkerLike } from '../surface/erosionEnginePool'
import { assembleNodeForcing, erosionLithoSeed, scaleEngineParamsForDt, upsampleAt, type ErosionControlsV2 } from '../surface/erosionForcingFields'
import { advancePointByMotion } from '../tectonics/plateMotion'
import { stepEpoch, type PlateSimulation, type SimEvent } from '../tectonics/plateSimulation'
import { TECTONICS_TUNING } from '../tectonics/tectonicsTuneParams'
import { METERS_PER_CELL } from '../core/mapConfig'
import { coarseForcingFields } from './erosionForcing'

// THE COUPLED EPOCH (ADAPTIVE_MESH_PLAN.md phase 5.1; decisions 5, 6, 8 of
// docs/decisions/adaptive-mesh.md): erosion runs inside every tectonic
// epoch, on the mesh, whose nodes move with their plates.
//
// THE STATE. A node carries a height `z` that is the sum of two things:
// the BASELINE the tectonics prescribe at its position — the raft
// baseline (continental hypsometry over the margin profile, the ocean
// floor by its age) and the dynamic topography, both analytic point
// fields the tectonic model already has — and a RELIEF `h` = z − baseline,
// the accumulated uplift and erosion, which is what the history is. Per
// epoch the tectonics move, the baseline is re-evaluated where the node
// now stands, and z = baseline' + h: the ocean floor deepens with its
// age, a raft's interior keeps its hypsometry, and the relief the erosion
// carved rides on the plate. The ridged mountain synthesis of the raster
// pipeline exists only as the INITIAL relief (the mesh is built from the
// synthesis at the first epoch); after that, mountains are what the
// engine's uplift raises and its erosion works down.
//
// THE MOTION. A node belongs to the plate whose seed is nearest (the rule
// every drifting thing in the tectonics follows), and advances by that
// plate's motion. Within a plate the motion is rigid and the triangulation
// stays valid; at the boundaries nodes converge and diverge, so the mesh
// is rebuilt from the moved nodes each epoch (the same nodes with the
// same state — no resampling, which is what decision 8 forbade) and the
// remesh does the rest: where plates converge the nodes crowd under the
// removal threshold and go, their columns merged into the neighbours
// (subduction); where they diverge the gaps exceed the insertion threshold
// and new nodes appear (rifting). A new node inherits its relief from the
// neighbours scaled by the raft margin at its position, so fresh crust at
// a rift starts as sea floor and a node densifying an orogen inherits the
// orogen.
//
// THE TIME. An epoch is `sim.epochMa` (the tectonics panel's epochLength;
// TECTONIC_MA_PER_EPOCH, 1, is what the world clock and the ocean age's
// depth still count in — the slider is the EROSION's clock for now, the
// plates step as they always did). The engine's calibrated iteration is
// ITERATION_YEARS, fifty to a 1 Myr epoch — too many to run live. The loop runs `iterationsPerEpoch` LONGER iterations with the
// rates scaled to the step (erosionForcingFields.scaleEngineParamsForDt),
// which is the calibration question phase 5 opens, measured here and
// decided later. The water forcing is uniform until the climate runs per
// epoch (5.4).

export interface CoupledTerrain {
  mesh: PeriodicTriangulation
  // Height per vertex slot, elevation units.
  z: Float32Array
  // The tectonic baseline at each node's position, as last evaluated.
  baseline: Float32Array
  // The last epoch's routing, areas and sediment flux — what the hydrology
  // reads of a mesh terrain (meshErosionStage.MeshTerrain); null before the
  // first epoch.
  routing: MeshRouting | null
  areas: Float32Array
  sedimentFlux: Float32Array
  // The last epoch's weather on the coarse raster, kept for the epochs
  // between two climate runs (CoupledEpochOptions.climateEvery) — with
  // the epoch it was computed in and the parameters it was computed
  // with, so a moved slider recomputes. Null before the first epoch and
  // after a restore: the continuation after a restore runs its climate
  // on its first epoch, an unbroken run on its scheduled one.
  weather: { epoch: number; params: string; result: Weather } | null
  // The heights the last epoch's erosion started from (after the motion
  // and the baseline swap) — the "before" of what that epoch deposited.
  preErosionZ: Float32Array
  // The sediment column per node (phase 5.2, mesh/meshColumn.ts): the
  // epochs' deposits as layers over the bedrock, moved and remeshed with
  // the relief, cut from the top by the erosion.
  column: SedimentColumn
  // The last epoch's ice thickness per node, metres (phase 6, derived from
  // the epoch's climate — not saved; empty before the first epoch and
  // after a restore).
  ice: Float32Array
}

export interface CoupledEpochOptions {
  // The climate panel's parameters (phase 5.4): the climate runs per epoch
  // on the coarse raster of the pre-erosion terrain and forces the water;
  // absent → the declared defaults.
  weather?: WeatherParams
  iterationsPerEpoch: number
  // The density rule's budget scalar during the history (decision 1: the
  // macro mesh and the tiles are one rule with a budget each). 1 is the
  // end state's density; 4 quadruples the spacing for the epochs — the
  // relief the history carries, at a sixteenth of the nodes.
  budget?: number
  // The climate runs every this many epochs (1: every epoch) and the
  // epochs between reuse the last weather on the terrain of the moment —
  // the ice, the sea level, the forcing and the ledger read it as if it
  // were the epoch's. A preview economy: the weather chain costs a
  // second an epoch at any node count.
  climateEvery?: number
  // A scale on the tectonics' uplift forcing — the calibration's knob
  // against the erosion rates, 1 = the engine's calibrated ratio.
  upliftScale?: number
  controls?: ErosionControlsV2
  pool?: { createWorker: () => WorkerLike } & PipelineOptions
}

// The history's interim setting, from the first calibration round
// (scripts/calibrateHistory.mjs, 2026-09-23; the table is in
// ADAPTIVE_MESH_PLAN.md phase 5.1): budget 4 for the LIVE loop (decided
// 2026-09-25, the first lever of the performance round: on 2048×1024
// budget 2 ran 190–390 k nodes at 5–11 s an epoch, budget 4 runs
// 54–111 k at 0.7–1.2 s with the land statistics the same — mean land
// 403–420 against 414–427 m, peaks 1.6–2.8 km both; the full density is
// the level-1 job's, which continues the same history from the last
// checkpoint, never a re-run — a re-run at another density is a
// sibling world), four
// iterations per epoch (rates ×12.5; pure erosion lowers a 365 m plain
// by 30 % in 16 Ma — sane), and the uplift at a quarter. The quarter is
// the finding, not a tuning: the tectonics' uplift field lifts 88–98 %
// of the land with a mean of 0.4–0.5 (it was made for a 0.8 Myr
// transient), so at 1 the mean land rises 200 m an epoch and the whole
// continent stands 4 km high after 16 Ma. The balance belongs to 5.3
// (flexural compensation) and to a U field confined to the orogens;
// until then the quarter keeps a 50 Ma history in the range of a
// world (mean land +0.5 km, orogens to 3 km at 16 Ma).
// climateEvery and renderEvery (2026-09-26, the second lever of the
// performance round, profiled on 2048×1024 at budget 4: of ~3 s an epoch
// the weather chain was 1.0 and the intermediate picture 1.0, the erosion
// 0.1): the live loop runs the climate and draws every third epoch. The
// full-density job (5.8b) runs both every epoch — the time is the job's.
export const HISTORY_DEFAULTS = { iterationsPerEpoch: 4, budget: 4, upliftScale: 0.25, climateEvery: 3, renderEvery: 3 } as const

// The flexure raster's cell in macro cells: 4 (31 km at 2048) — the
// flexural parameter is tens to a hundred-odd km, and the kernel wants a
// few cells across it.
const FLEXURE_CELL = 4
// The climate history kept on the sim: the last this many epochs.
const CLIMATE_HISTORY_CAP = 512
// A lake is the same lake next epoch when its seed lies within this many
// macro cells (47 km) and its level within this many metres of last
// epoch's — the seed drifts with the plate and jumps with the remesh.
const LAKE_MATCH_CELLS = 6
const LAKE_MATCH_LEVEL_M = 300

export interface CoupledEpochStats {
  // The column's ledger for the epoch, m³: what the walk laid down, what
  // the cut took back out of sediment (the rest was bedrock), and the
  // column's volume after — the harness closes deposited − re-eroded
  // against the volume's change, remesh included.
  depositedM3: number
  reErodedM3: number
  columnVolumeM3: number
  // The flexural answer to the epoch's load change (phase 5.3), metres:
  // the largest lift (unloaded ranges rise) and the deepest sag (loaded
  // basins sink).
  reboundMaxM: number
  subsidenceMaxM: number
  // The epoch's climate (phase 5.4): the land's mean annual temperature,
  // the ice the coarse balance-flux inversion holds, the sea level the ice
  // locks up (≤ 0), and the standing lakes with the oldest's age.
  meanLandTempC: number
  iceVolumeKm3: number
  seaLevelM: number
  lakes: number
  oldestLakeMa: number
  // The vegetation cover's mean over the land (phase 5.5), 0 before the
  // land-plants moment.
  meanLandCover: number
  // The hillslope's ledger (phase 5.6): the scree creep laid down, m³, and
  // the share of the land in the periglacial band this epoch.
  screeM3: number
  solifluctionShare: number
  // The share of the land under a folding range this epoch (phase 5.7).
  foldedShare: number
  // The ice of the epoch (phase 6): its share of the land, what the ice
  // cut and the till it left, m³, and the mean equilibrium line over the
  // land, metres.
  iceAreaShare: number
  glacialCutM3: number
  tillM3: number
  elaMeanM: number
  // The coast of the epoch (phase 7): shore nodes, what the waves cut,
  // what the drift laid down and what it exported, m³.
  shoreNodes: number
  coastCutM3: number
  coastDepositM3: number
  coastExportM3: number
  events: SimEvent[]
  nodesBefore: number
  nodesAfter: number
  removed: number
  inserted: number
  // Land area (nodes' Voronoi cells) after the epoch, in macro cells.
  landCells: number
  // Sum over land of z × area — the relief's volume, elevation units × cells.
  landVolume: number
  erodedFluxM3: number
  exportedFluxM3: number
  // Milliseconds per phase, the calibration's cost side.
  timing: { membership: number; tectonics: number; rebuild: number; remesh: number; baseline: number; forcing: number; erosion: number; flexure: number; climate: number; lakes: number; ice: number; coast: number }
}

// The baseline: the raft profile over the ocean floor, the mantle's
// dynamic topography, and the sea the ice lowered (phase 5.4: sim.eustaticM
// ≤ 0 is the sea level against the ice-free one, so the solid surface
// stands that much higher against it).
function baselineAt(sim: PlateSimulation, x: number, y: number): number {
  return raftBaselineAt(x, y, sim.rafts, sim.oceanAge, sim.width, sim.height, sim.warpSeed, sim.seaLevelOffset)
    + dynamicTopographyAt(sim.mantle, MANTLE_RES_X, MANTLE_RES_Y, x, y, sim.width, sim.height)
    - sim.eustaticM / ELEVATION_METERS
}

// The terrain at the start of the history: the mesh from the synthesis,
// the baseline evaluated at every node, the relief the difference.
export function createCoupledTerrain(sim: PlateSimulation, budget = 1): CoupledTerrain {
  const domain = torusDomain(sim.width, sim.height)
  const built = buildMesh(domain, synthesisSampler(sim), { seed: sim.warpSeed, budget })
  const { mesh, order } = compactMesh(built.mesh)
  const z = permute(built.state.get(MESH_Z), order)
  const baseline = new Float32Array(mesh.vertexSlots)
  for (let v = 0; v < mesh.vertexSlots; v++) baseline[v] = baselineAt(sim, mesh.vx[v], mesh.vy[v])
  return { mesh, z, baseline, routing: null, areas: meshAreasOf(mesh), sedimentFlux: new Float32Array(0), preErosionZ: z.slice(), column: createColumn(mesh.vertexSlots), ice: new Float32Array(0), weather: null }
}

function meshAreasOf(mesh: PeriodicTriangulation): Float32Array {
  const areas = new Float32Array(mesh.vertexSlots)
  for (let v = 0; v < mesh.vertexSlots; v++) if (mesh.vAlive[v]) areas[v] = mesh.voronoiArea(v)
  return areas
}

// One epoch: tectonics, motion, rebuild and remesh, baseline swap, erosion.
export async function stepCoupledEpoch(sim: PlateSimulation, terrain: CoupledTerrain, options: CoupledEpochOptions): Promise<CoupledEpochStats> {
  const { width, height } = sim
  const domain: Domain = terrain.mesh.domain
  const mesh0 = terrain.mesh
  const nodesBefore = mesh0.aliveVertices
  const timing = { membership: 0, tectonics: 0, rebuild: 0, remesh: 0, baseline: 0, forcing: 0, erosion: 0, flexure: 0, climate: 0, lakes: 0, ice: 0, coast: 0 }
  let tick = performance.now()
  const lap = (): number => { const now = performance.now(); const dt = now - tick; tick = now; return dt }
  // Plate membership BEFORE the plates move: nearest seed.
  const host = new Int32Array(mesh0.vertexSlots).fill(-1)
  for (let v = 0; v < mesh0.vertexSlots; v++) {
    if (!mesh0.vAlive[v]) continue
    let best = 0
    let bestSq = Infinity
    for (let p = 0; p < sim.seeds.length; p++) {
      const d = toroidalDistanceSq(mesh0.vx[v], mesh0.vy[v], sim.seeds[p].x, sim.seeds[p].y, width, height)
      if (d < bestSq) { bestSq = d; best = p }
    }
    host[v] = best
  }
  timing.membership = lap()
  const events = stepEpoch(sim)
  timing.tectonics = lap()
  // The nodes move with their plates; their relief goes with them.
  const count = nodesBefore
  const xs = new Float64Array(count)
  const ys = new Float64Array(count)
  const hMoved = new Float32Array(count)
  const columnMoved = new Float32Array(count * COLUMN_DEPTH)
  let k = 0
  for (let v = 0; v < mesh0.vertexSlots; v++) {
    if (!mesh0.vAlive[v]) continue
    const moved = advancePointByMotion(mesh0.vx[v], mesh0.vy[v], sim.motions[host[v]], TECTONICS_TUNING.epochAngleStep, width, height)
    xs[k] = moved.x
    ys[k] = moved.y
    hMoved[k] = terrain.z[v] - terrain.baseline[v]
    for (let j = 0; j < COLUMN_DEPTH; j++) columnMoved[k * COLUMN_DEPTH + j] = terrain.column.data[v * COLUMN_DEPTH + j]
    k++
  }
  // The mesh from the moved nodes, then the remesh: crowded nodes go
  // (subduction), gaps fill (rifting).
  const rebuilt = triangulatePoints(domain, xs, ys, count, MESH_TUNING.oceanSpacingM / METERS_PER_CELL)
  timing.rebuild = lap()
  const mesh1 = rebuilt.mesh
  const state = new MeshState(mesh1.vertexSlots * 2)
  // The relief is a thickness over the baseline: EXTENSIVE, so a node
  // that subduction removes hands its relief to its neighbours by area
  // and the landscape's volume is conserved through the remesh.
  const h = state.add('h', 'extensive')
  for (let i = 0; i < count; i++) h[rebuilt.mapping[i]] = hMoved[i]
  // The column, the same way: layers are thickness per area, extensive.
  const col = addColumnField(state)
  for (let i = 0; i < count; i++) {
    const dst = rebuilt.mapping[i] * COLUMN_DEPTH
    for (let j = 0; j < COLUMN_DEPTH; j++) col[dst + j] = columnMoved[i * COLUMN_DEPTH + j]
  }
  // z on the rebuilt mesh, for the density rule: baseline at the new
  // position plus the relief.
  const z = state.add(MESH_Z, 'intensive')
  for (let v = 0; v < mesh1.vertexSlots; v++) if (mesh1.vAlive[v]) z[v] = baselineAt(sim, mesh1.vx[v], mesh1.vy[v]) + h[v]
  timing.baseline = lap()
  const target = densityTarget(state, options.budget ?? 1)
  const c = coarsen(mesh1, state, target)
  const r = refine(mesh1, state, target, {
    seed: (sim.warpSeed ^ sim.epoch) >>> 0,
    sample: (v, x, y) => {
      // A new node: relief inherited from the neighbours, scaled by the
      // margin — fresh sea floor at a rift starts with none.
      const t = marginParameter(raftField(x, y, sim.rafts, width, height))
      const scale = Math.min(1, Math.max(0, t))
      const hv = state.get('h')
      hv[v] *= scale
      const cv = state.get(MESH_COLUMN)
      for (let j = 0; j < COLUMN_DEPTH; j++) cv[v * COLUMN_DEPTH + j] *= scale
      state.get(MESH_Z)[v] = baselineAt(sim, x, y) + hv[v]
    },
  })
  timing.remesh = lap()
  const { mesh, order } = compactMesh(mesh1)
  const hCanon = permute(state.get('h'), order)
  const column: SedimentColumn = { data: permuteColumn(state.get(MESH_COLUMN), order), epochs: terrain.column.epochs }
  if (column.data.length < mesh.vertexSlots * COLUMN_DEPTH) {
    const grown = new Float32Array(mesh.vertexSlots * COLUMN_DEPTH)
    grown.set(column.data)
    column.data = grown
  }
  // This epoch's deposits get a layer of their own (the oldest two merge
  // when the cap is reached).
  openLayer(column, sim.epoch, mesh.vertexSlots)
  const baseline = new Float32Array(mesh.vertexSlots)
  const zCanon = new Float32Array(mesh.vertexSlots)
  for (let v = 0; v < mesh.vertexSlots; v++) {
    baseline[v] = baselineAt(sim, mesh.vx[v], mesh.vy[v])
    // The elevation scale's range, as the synthesis clamps it
    // (elevationField.computeElevation): a trench node carries a relief of
    // −3000 m under an abyssal baseline, and a baseline that subsides
    // under it would take z past the floor the whole pipeline assumes.
    zCanon[v] = Math.max(-1, Math.min(1, baseline[v] + hCanon[v]))
  }
  timing.baseline += lap()
  // THE CLIMATE OF THE EPOCH (phase 5.4, decision 13): the weather chain
  // on the coarse raster of the pre-erosion terrain — the same chain the
  // climate stage runs, at its own resolution, with the panel's parameters
  // — is the erosion's water forcing this epoch, the ice's balance, the
  // sea level's, and what a deposit records. The final full-resolution
  // climate stays the last stage.
  const coarseZ = rasteriseNodeField(mesh, zCanon, CLIMATE_RES_X, CLIMATE_RES_Y)
  const weatherParams = options.weather ?? defaultWeatherParams()
  const climateEvery = Math.max(1, options.climateEvery ?? 1)
  // The parameters compared by value: a caller without a panel passes a
  // fresh default object every epoch, and an identity check would run the
  // chain every epoch and never say so.
  const paramsKey = JSON.stringify(weatherParams)
  const cached = terrain.weather
  const climateDue = !cached || cached.params !== paramsKey || sim.epoch - cached.epoch >= climateEvery
  const weather = climateDue ? computeWeather(coarseZ, CLIMATE_RES_X, CLIMATE_RES_Y, weatherParams) : cached.result
  if (climateDue) terrain.weather = { epoch: sim.epoch, params: paramsKey, result: weather }
  const precipitation = weather.seasonal.annual
  const climateCellM = (width / CLIMATE_RES_X) * METERS_PER_CELL
  const climateCellM2 = climateCellM * ((height / CLIMATE_RES_Y) * METERS_PER_CELL)
  let oceanCells = 0
  let landTempSum = 0
  let landClimateCells = 0
  for (let i = 0; i < coarseZ.length; i++) {
    if (coarseZ[i] <= 0) oceanCells++
    else { landTempSum += weather.temperature[i]; landClimateCells++ }
  }
  timing.climate = lap()
  // THE ICE (phase 6, surface/glacial.ts): the epoch's climate as ice on
  // the mesh, at its steady state; the erosion it does before the rivers
  // run (the cut, the buzzsaw at the ELA), the till at the termini. The
  // ice's volume is what sets the sea level below.
  const areasNow = meshAreasOf(mesh)
  const cellM2Now = METERS_PER_CELL * METERS_PER_CELL
  const cratonFieldForTill = computeCratonOldnessField(sim.rafts, worldEpoch(sim.archeanEpochs, sim.epoch), CLIMATE_RES_X, CLIMATE_RES_Y, width, height)
  const ice = computeIceOnMesh({ mesh, z: zCanon, temperature: weather.temperature, precipitation, coarseZ, climateResX: CLIMATE_RES_X, climateResY: CLIMATE_RES_Y, width, height, cellM: METERS_PER_CELL })
  const glacial = glacialErosionOnMesh(mesh, zCanon, ice, (sim.epochMa || TECTONIC_MA_PER_EPOCH) * 1e6, METERS_PER_CELL)
  let iceVolumeM3 = 0
  let iceArea = 0
  let landAreaNow = 0
  let elaSum = 0
  for (let v = 0; v < mesh.vertexSlots; v++) {
    if (!mesh.vAlive[v]) continue
    const areaM2 = areasNow[v] * cellM2Now
    if (zCanon[v] > 0) { landAreaNow += areasNow[v]; elaSum += ice.elaM[v] * areasNow[v] }
    if (ice.thickness[v] > 0) { iceVolumeM3 += ice.thickness[v] * areaM2; iceArea += areasNow[v] }
    // The cut comes off the column first, the rest is rock; the till goes
    // into this epoch's layer at the terminus, half coarse, half fine,
    // under the epoch's climate. Both move z now, before the rivers.
    const cutM = glacial.cutM[v]
    if (cutM > 0) {
      cut(column, v, cutM)
      zCanon[v] = Math.max(-1, zCanon[v] - cutM / ELEVATION_METERS)
    }
    const tillM = glacial.tillM[v]
    if (tillM > 0) {
      const tempC = upsampleAt(weather.temperature, CLIMATE_RES_X, CLIMATE_RES_Y, mesh.vx[v], mesh.vy[v], width, height)
      const precipHere = Math.max(0, upsampleAt(precipitation, CLIMATE_RES_X, CLIMATE_RES_Y, mesh.vx[v], mesh.vy[v], width, height))
      const cratonHere = upsampleAt(cratonFieldForTill, CLIMATE_RES_X, CLIMATE_RES_Y, mesh.vx[v], mesh.vy[v], width, height)
      deposit(column, v, tillM * SURFACE_TUNING.glacialTillCoarse, cratonHere, 1, tempC, precipHere, true)
      deposit(column, v, tillM * (1 - SURFACE_TUNING.glacialTillCoarse), cratonHere, 1, tempC, precipHere, false)
      zCanon[v] = Math.min(1, zCanon[v] + tillM / ELEVATION_METERS)
    }
  }
  const iceAreaShare = landAreaNow > 0 ? iceArea / landAreaNow : 0
  const elaMeanM = landAreaNow > 0 ? elaSum / landAreaNow : 0
  timing.ice = lap()
  // The sea as a global water level: the ice's water, at its density,
  // taken out of the ocean's area — applied to z after the erosion below.
  const seaLevelM = oceanCells > 0 ? -(iceVolumeM3 * 0.917) / (oceanCells * climateCellM2) : 0
  const meanLandTempC = landClimateCells > 0 ? landTempSum / landClimateCells : 0
  // THE COVER (phase 5.5): the epoch's coarse biomes, as the vegetation
  // that holds the ground — once the planet's schedule has land plants.
  const plantsFromMa = (weatherParams.planet ?? DEFAULT_PLANET_FORCING).landPlantsFromMa
  const plantsPresent = worldAgeMa(sim.archeanEpochs, sim.epoch) >= plantsFromMa
  const biomes = computeBiomes(weather.temperature, precipitation, weather.seasonalAmplitude, weather.seasonal.index, coarseZ, CLIMATE_RES_X, CLIMATE_RES_Y)
  const cover = coverField(biomes, plantsPresent)
  // Erosion for the epoch, with the tectonics' forcing at the nodes, the
  // epoch's water, and the rates scaled to the step.
  const { uplift, hardness } = coarseForcingFields(sim, width, height)
  const areas = meshAreasOf(mesh)
  const { forcing, params } = assembleNodeForcing({
    uplift, hardness, forcingResX: CLIMATE_RES_X, forcingResY: CLIMATE_RES_Y,
    water: precipitation, waterResX: CLIMATE_RES_X, waterResY: CLIMATE_RES_Y, lithoSeed: erosionLithoSeed(sim.warpSeed),
  }, mesh.vx, mesh.vy, mesh.vAlive, mesh.vertexSlots, zCanon, areas, width, height, options.controls ?? {})
  // The column's word on the forcing: a node under a fill erodes as
  // sediment, not as its bedrock; and what a cut hands to the walk carries
  // the craton oldness and the crust hardness under the node (the coarse
  // fields at the node's position), so a deposit knows its source.
  const cratonField = cratonFieldForTill
  // THE FOLDS (phase 5.7): the uplift modulated across every range by the
  // buckling train — the same features the uplift field is built from.
  const featureBuckets = buildFeatureBuckets(sim.features, width, height)
  let foldedArea = 0
  const cratonAge = new Float32Array(mesh.vertexSlots)
  const rockHard = new Float32Array(mesh.vertexSlots)
  const slopeScale = new Float32Array(mesh.vertexSlots)
  const diffScale = new Float32Array(mesh.vertexSlots)
  const layers = column.epochs.length
  let coverSum = 0
  let coverArea = 0
  let solifluctionArea = 0
  for (let v = 0; v < mesh.vertexSlots; v++) {
    if (!mesh.vAlive[v]) continue
    cratonAge[v] = upsampleAt(cratonField, CLIMATE_RES_X, CLIMATE_RES_Y, mesh.vx[v], mesh.vy[v], width, height)
    rockHard[v] = upsampleAt(hardness, CLIMATE_RES_X, CLIMATE_RES_Y, mesh.vx[v], mesh.vy[v], width, height)
    // The cover holds the ground: the erodibility falls with it, after the
    // column's word (a fill under forest is soft fill, held).
    const c = zCanon[v] > 0 ? upsampleAt(cover, CLIMATE_RES_X, CLIMATE_RES_Y, mesh.vx[v], mesh.vy[v], width, height) : 0
    if (forcing.uplift[v] > 0) {
      const fold = foldFactorAt(featureBuckets, mesh.vx[v], mesh.vy[v], width, height)
      if (fold !== 1) { forcing.uplift[v] *= fold; if (zCanon[v] > 0) foldedArea += areas[v] }
    }
    const bedrockK = forcing.erodibility[v]
    const k = erodibilityOver(column.data, v, layers, bedrockK)
    // Under the ice the rivers rest (phase 6).
    forcing.erodibility[v] = ice.thickness[v] > 0 ? 0 : k * (1 - COVER_TUNING.erodibilityDrop * c)
    // THE HILLSLOPE'S SCALES (phase 5.6): the critical slope from the
    // lithology (hard stands steeper, a fill lies flatter) and the cover's
    // hold; the diffusivity from the cold — solifluction in the
    // periglacial band, where freeze and thaw move regolith that nothing
    // else would.
    slopeScale[v] = Math.pow(k, -SURFACE_TUNING.massWastingLithoExponent) * (1 + COVER_TUNING.criticalSlopeRise * c)
    const tempC = upsampleAt(weather.temperature, CLIMATE_RES_X, CLIMATE_RES_Y, mesh.vx[v], mesh.vy[v], width, height)
    const cold = Math.min(1, Math.max(0, (SURFACE_TUNING.solifluctionBelowC - tempC) / SURFACE_TUNING.solifluctionSpanC))
    diffScale[v] = 1 + (SURFACE_TUNING.solifluctionBoost - 1) * cold
    if (zCanon[v] > 0) { coverSum += c * areas[v]; coverArea += areas[v]; if (cold > 0) solifluctionArea += areas[v] }
  }
  const meanLandCover = coverArea > 0 ? coverSum / coverArea : 0
  const solifluctionShare = coverArea > 0 ? solifluctionArea / coverArea : 0
  const foldedShare = coverArea > 0 ? foldedArea / coverArea : 0
  forcing.cratonAge = cratonAge
  forcing.rockHard = rockHard
  forcing.slopeScale = slopeScale
  forcing.diffScale = diffScale
  const epochMa = sim.epochMa || TECTONIC_MA_PER_EPOCH
  const dtScale = (epochMa * 1e6 / options.iterationsPerEpoch) / ITERATION_YEARS
  const scaled = scaleEngineParamsForDt({ ...params, epsM: 0 }, dtScale)
  scaled.upliftDt *= options.upliftScale ?? 1
  timing.forcing = lap()
  const result = await runMeshErosion(mesh, zCanon, forcing, { age: options.iterationsPerEpoch, params: scaled, pool: options.pool, routingEvery: Math.max(1, Math.min(4, options.iterationsPerEpoch)) })
  // The same range after the engine (marine diffusion can take a floor
  // node a few metres under it); the relief the next epoch carries is
  // read from this z, so the clamp is the terrain's, not a display one.
  for (let v = 0; v < mesh.vertexSlots; v++) result.z[v] = Math.max(-1, Math.min(1, result.z[v]))
  // The column's ledger from the run's record: the cut comes off the top
  // of the column first (the remainder was bedrock), the deposit goes into
  // this epoch's layer with the provenance the walk carried to it. The
  // creep's ledger too (phase 5.6): what a node lost to creep comes off
  // its column first, what it gained is SCREE — a coarse layer of the
  // node's own rock, formed under the epoch's climate. Uplift moves no
  // column.
  const cellM2 = METERS_PER_CELL * METERS_PER_CELL
  let depositedM3 = 0
  let reErodedM3 = 0
  let screeM3 = 0
  for (let v = 0; v < mesh.vertexSlots; v++) {
    if (!mesh.vAlive[v]) continue
    const areaM2 = areas[v] * cellM2
    if (areaM2 <= 0) continue
    const hill = result.hillNetM3[v]
    const cutM = (result.cutM3[v] + (hill < 0 ? -hill : 0)) / areaM2
    if (cutM > 0) reErodedM3 += cut(column, v, cutM) * areaM2
    if (hill > 0) {
      // Tallied apart from the walk's deposits: the scree's supply is the
      // creep's loss, not the cut, and the harness closes both ledgers.
      screeM3 += hill
      const tempC = upsampleAt(weather.temperature, CLIMATE_RES_X, CLIMATE_RES_Y, mesh.vx[v], mesh.vy[v], width, height)
      const precip = Math.max(0, upsampleAt(precipitation, CLIMATE_RES_X, CLIMATE_RES_Y, mesh.vx[v], mesh.vy[v], width, height))
      deposit(column, v, hill / areaM2, cratonAge[v], rockHard[v], tempC, precip, true)
    }
    const depositM3 = result.depositM3[v]
    if (depositM3 > 0) {
      depositedM3 += depositM3
      const craton = result.depositCraton[v] / depositM3
      const hard = result.depositHard[v] / depositM3
      const coarseM3 = result.depositCoarseM3[v]
      // The climate the layer formed under: the epoch's, at the node.
      const tempC = upsampleAt(weather.temperature, CLIMATE_RES_X, CLIMATE_RES_Y, mesh.vx[v], mesh.vy[v], width, height)
      const precip = Math.max(0, upsampleAt(precipitation, CLIMATE_RES_X, CLIMATE_RES_Y, mesh.vx[v], mesh.vy[v], width, height))
      deposit(column, v, (depositM3 - coarseM3) / areaM2, craton, hard, tempC, precip, false)
      deposit(column, v, coarseM3 / areaM2, craton, hard, tempC, precip, true)
    }
  }
  // The export tally (decision C of 5.2, 2026-09-23): what left the shelf
  // band for the deep ocean, summed over the history on the sim — the
  // crust takes it as a load in 5.3; nothing feeds back yet.
  sim.sedimentExportM3 += result.exportedFluxM3
  timing.erosion = lap()
  // THE COAST (phase 7, surface/coastal.ts): the waves cut the shore
  // towards the wave base, the drift carries what they and the rivers
  // supply along the shore and lays it down where the capacity falls —
  // beaches, spits. The cut comes off the column first; the deposit is a
  // sand layer (coarse) under the epoch's climate. Both move z now, so
  // the plate answers to them below and the lakes see the new shore.
  const coastal = computeCoastal({
    mesh, z: result.z, areas, wind: weather.wind, coarseZ, climateResX: CLIMATE_RES_X, climateResY: CLIMATE_RES_Y, width, height, cellM: METERS_PER_CELL,
    hardness: rockHard, sedimentFlux: result.sedimentFlux, iterations: options.iterationsPerEpoch, epochYears: (sim.epochMa || TECTONIC_MA_PER_EPOCH) * 1e6,
  })
  for (let v = 0; v < mesh.vertexSlots; v++) {
    if (!mesh.vAlive[v]) continue
    const cutM = coastal.cutM[v]
    if (cutM > 0) {
      cut(column, v, cutM)
      result.z[v] = Math.max(-1, result.z[v] - cutM / ELEVATION_METERS)
    }
    const depM = coastal.depositM[v]
    if (depM > 0) {
      const tempC = upsampleAt(weather.temperature, CLIMATE_RES_X, CLIMATE_RES_Y, mesh.vx[v], mesh.vy[v], width, height)
      const precipHere = Math.max(0, upsampleAt(precipitation, CLIMATE_RES_X, CLIMATE_RES_Y, mesh.vx[v], mesh.vy[v], width, height))
      deposit(column, v, depM, cratonAge[v], rockHard[v], tempC, precipHere, true)
      result.z[v] = Math.min(1, result.z[v] + depM / ELEVATION_METERS)
    }
  }
  timing.coast = lap()
  // FLEXURAL ISOSTASY (phase 5.3, tectonics/flexure.ts): the epoch's
  // load change — rock cut, sediment laid down — binned by area onto a
  // coarse raster, the plate's deflection computed there with the
  // elastic thickness of each cell, and read back at the nodes. Crust
  // moves; the column does not (it rides on the crust), and the relief
  // takes the deflection as height over the baseline.
  const flexResX = Math.max(16, Math.round(width / FLEXURE_CELL))
  const flexResY = Math.max(8, Math.round(height / FLEXURE_CELL))
  const flexCellKm = ((width / flexResX) * METERS_PER_CELL) / 1000
  const flexCellM2 = (flexCellKm * 1000) * (flexCellKm * 1000)
  const loadM = new Float32Array(flexResX * flexResY)
  for (let v = 0; v < mesh.vertexSlots; v++) {
    if (!mesh.vAlive[v]) continue
    // The epoch's load change: the walk's deposits and cuts, the ice's
    // cut and till, and the ice itself at its density over the rock's.
    const dv = result.depositM3[v] - result.cutM3[v] + (glacial.tillM[v] - glacial.cutM[v] + coastal.depositM[v] - coastal.cutM[v] + ice.thickness[v] * (917 / TECTONICS_TUNING.flexureCrustDensity)) * areas[v] * cellM2
    if (dv === 0) continue
    const cx = (((Math.floor((mesh.vx[v] / width) * flexResX) % flexResX) + flexResX) % flexResX)
    const cy = (((Math.floor((mesh.vy[v] / height) * flexResY) % flexResY) + flexResY) % flexResY)
    loadM[cy * flexResX + cx] += dv / flexCellM2
  }
  const teKm = new Float32Array(flexResX * flexResY)
  for (let cy = 0; cy < flexResY; cy++) {
    for (let cx = 0; cx < flexResX; cx++) {
      const x = ((cx + 0.5) / flexResX) * width
      const y = ((cy + 0.5) / flexResY) * height
      const continental = raftField(x, y, sim.rafts, width, height) > 0.5
      const oldness = upsampleAt(cratonField, CLIMATE_RES_X, CLIMATE_RES_Y, x, y, width, height)
      const ageMa = sampleOceanAge(sim.oceanAge, x, y, width, height) * (sim.epochMa || TECTONIC_MA_PER_EPOCH)
      teKm[cy * flexResX + cx] = elasticThicknessKm(continental, oldness, ageMa)
    }
  }
  const deflection = flexuralResponse(loadM, teKm, flexResX, flexResY, flexCellKm)
  let reboundMaxM = 0
  let subsidenceMaxM = 0
  for (let v = 0; v < mesh.vertexSlots; v++) {
    if (!mesh.vAlive[v]) continue
    const wM = deflectionAt(deflection, flexResX, flexResY, mesh.vx[v], mesh.vy[v], width, height)
    if (wM > reboundMaxM) reboundMaxM = wM
    if (-wM > subsidenceMaxM) subsidenceMaxM = -wM
    result.z[v] = Math.max(-1, Math.min(1, result.z[v] + wM / ELEVATION_METERS))
  }
  timing.flexure = lap()
  // THE SEA LEVEL'S CHANGE, applied now: the solid surface stands higher
  // against a sea the ice lowered (or lower against one it released), and
  // the baseline it is measured from moves with it, so the relief is
  // untouched and a restore — which evaluates the baseline with the sea
  // level now in force — reproduces this z exactly.
  const seaShift = -(seaLevelM - sim.eustaticM) / ELEVATION_METERS
  sim.eustaticM = seaLevelM
  if (seaShift !== 0) {
    // The baseline re-evaluated rather than shifted: a shift added in
    // float32 differs from the direct evaluation by an ulp, and a restore
    // evaluates directly — the bytes must agree.
    for (let v = 0; v < mesh.vertexSlots; v++) {
      if (!mesh.vAlive[v]) continue
      result.z[v] = Math.max(-1, Math.min(1, result.z[v] + seaShift))
      baseline[v] = baselineAt(sim, mesh.vx[v], mesh.vy[v])
    }
  }
  // THE ROUTING ON THE TERRAIN AS THE EPOCH LEAVES IT. The erosion's
  // routing ran on the z before the coast, the flexure and the sea level
  // moved it, so its flood stood above the moved surface — measured
  // 2026-09-25 on the calibration seed after 20 epochs: one "terminal"
  // body of 53 k nodes from −2.7 km to +430 m, painted as a lake over
  // 41 k ocean cells (the "lakes in the ocean" of the picture check).
  // The lakes below and the hydrology stage read this one instead.
  const routing = meshRouting(mesh, result.z, scaled)
  // THE LAKES' AGES (phase 5.4, decision B of 5.2): the standing water on
  // the epoch's terrain, each body matched to the nearest of last epoch's
  // by its seed (within LAKE_MATCH_CELLS macro cells — the seed drifts with
  // its plate and the remesh — and a level within LAKE_MATCH_LEVEL_M) and
  // aged by the epoch; a body with no match is new. The hydrology stage
  // recomputes the bodies at full detail after the stop; these carry the
  // history.
  const sub = meshSubstrate(mesh, routing, areas)
  const discharge = accumulateDischargeOn(sub, result.z, precipitation, CLIMATE_RES_X, CLIMATE_RES_Y)
  const lakes = computeLakesOn(sub, discharge, result.z, weather.temperature, precipitation, CLIMATE_RES_X, CLIMATE_RES_Y)
  const epochMaForAges = sim.epochMa || TECTONIC_MA_PER_EPOCH
  const previous = sim.lakeAges
  const ages: LakeAgeRecord[] = []
  let oldestLakeMa = 0
  for (const body of lakes.bodies) {
    if (body.kind === 'dry') continue
    let ageMa = epochMaForAges
    let bestSq = LAKE_MATCH_CELLS * LAKE_MATCH_CELLS
    for (const p of previous) {
      if (Math.abs(p.level - body.level) * ELEVATION_METERS > LAKE_MATCH_LEVEL_M) continue
      const dSq = toroidalDistanceSq(p.x, p.y, body.seedX, body.seedY, width, height)
      if (dSq >= bestSq) continue
      bestSq = dSq
      ageMa = p.ageMa + epochMaForAges
    }
    if (ageMa > oldestLakeMa) oldestLakeMa = ageMa
    ages.push({ x: body.seedX, y: body.seedY, level: body.level, ageMa })
  }
  sim.lakeAges = ages
  timing.lakes = lap()
  // The history's record of the epoch.
  const iceVolumeKm3 = iceVolumeM3 / 1e9
  sim.climateHistory.push({ epoch: sim.epoch, meanLandTempC, iceVolumeKm3, seaLevelM })
  if (sim.climateHistory.length > CLIMATE_HISTORY_CAP) sim.climateHistory.splice(0, sim.climateHistory.length - CLIMATE_HISTORY_CAP)
  terrain.mesh = mesh
  terrain.column = column
  terrain.ice = ice.thickness
  terrain.z = result.z
  terrain.baseline = baseline
  terrain.routing = routing
  terrain.areas = areas
  terrain.sedimentFlux = result.sedimentFlux
  terrain.preErosionZ = zCanon
  let landCells = 0
  let landVolume = 0
  for (let v = 0; v < mesh.vertexSlots; v++) {
    if (!mesh.vAlive[v] || result.z[v] <= 0) continue
    landCells += areas[v]
    landVolume += result.z[v] * areas[v]
  }
  const areaM2 = new Float64Array(mesh.vertexSlots)
  for (let v = 0; v < mesh.vertexSlots; v++) areaM2[v] = areas[v] * cellM2
  return { events, nodesBefore, nodesAfter: mesh.aliveVertices, removed: c.removed, inserted: r.inserted, landCells, landVolume, erodedFluxM3: result.erodedFluxM3, exportedFluxM3: result.exportedFluxM3, depositedM3, reErodedM3, columnVolumeM3: columnVolumeM3(column, mesh, areaM2), reboundMaxM, subsidenceMaxM, meanLandTempC, iceVolumeKm3, seaLevelM, lakes: ages.length, oldestLakeMa, meanLandCover, screeM3, solifluctionShare, foldedShare, iceAreaShare, glacialCutM3: glacial.cutM3, tillM3: glacial.tillM3, elaMeanM, shoreNodes: coastal.shoreNodes, coastCutM3: coastal.erodedM3, coastDepositM3: coastal.depositedM3, coastExportM3: coastal.exportedM3, timing }
}

// The terrain's bytes for a save or a harness hash.
export function encodeCoupledTerrain(terrain: CoupledTerrain): { nodes: Float32Array; connectivity: Uint8Array; z: Float32Array; column: Uint8Array } {
  const order = new Int32Array(terrain.mesh.aliveVertices)
  for (let i = 0; i < order.length; i++) order[i] = i
  const serial = encodeMesh(terrain.mesh, order)
  return { nodes: serial.nodes, connectivity: serial.connectivity, z: terrain.z.slice(0, serial.count), column: encodeColumn(terrain.column, serial.count) }
}

// A terrain restored from its bytes: the baseline re-evaluated from the sim.
// A save from before the column (formatVersion 3) restores with an empty one.
export function decodeCoupledTerrain(sim: PlateSimulation, bytes: { nodes: Float32Array; connectivity: Uint8Array; z: Float32Array; column?: Uint8Array }): CoupledTerrain {
  const mesh = decodeMesh(torusDomain(sim.width, sim.height), { count: bytes.z.length, nodes: bytes.nodes, connectivity: bytes.connectivity })
  const baseline = new Float32Array(mesh.vertexSlots)
  for (let v = 0; v < mesh.vertexSlots; v++) baseline[v] = baselineAt(sim, mesh.vx[v], mesh.vy[v])
  const column = bytes.column ? decodeColumn(bytes.column, bytes.z.length, mesh.vertexSlots) : createColumn(mesh.vertexSlots)
  return { mesh, z: bytes.z, baseline, routing: null, areas: meshAreasOf(mesh), sedimentFlux: new Float32Array(0), preErosionZ: bytes.z.slice(), column, ice: new Float32Array(0), weather: null }
}
