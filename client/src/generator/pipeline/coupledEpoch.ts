import { torusDomain, type Domain } from '../core/domain'
import { toroidalDistanceSq } from '../core/toroidal'
import { ITERATION_YEARS } from '../surface/erosionEngine'
import { TECTONIC_MA_PER_EPOCH } from '../core/worldTime'
import { raftField } from '../crust/raftField'
import { dynamicTopographyAt } from '../elevation/dynamicTopography'
import { raftBaselineAt } from '../elevation/elevationField'
import { marginParameter } from '../elevation/elevationScale'
import { synthesisSampler } from '../elevation/elevationSampler'
import { MANTLE_RES_X, MANTLE_RES_Y } from '../mantle/mantleField'
import { buildMesh, densityTarget, MESH_Z, triangulatePoints } from '../mesh/meshBuild'
import { MESH_TUNING } from '../mesh/meshDensity'
import { runMeshErosion, type MeshRouting } from '../mesh/meshErosion'
import { compactMesh, decodeMesh, encodeMesh, permute } from '../mesh/meshSerial'
import { MeshState } from '../mesh/meshState'
import type { PeriodicTriangulation } from '../mesh/periodicDelaunay'
import { coarsen, refine } from '../mesh/remesh'
import { CLIMATE_RES_X, CLIMATE_RES_Y } from '../climate/climateField'
import type { PipelineOptions, WorkerLike } from '../surface/erosionEnginePool'
import { assembleNodeForcing, erosionLithoSeed, scaleEngineParamsForDt, type ErosionControlsV2 } from '../surface/erosionForcingFields'
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
  // The heights the last epoch's erosion started from (after the motion
  // and the baseline swap) — the "before" of what that epoch deposited.
  preErosionZ: Float32Array
}

export interface CoupledEpochOptions {
  iterationsPerEpoch: number
  // The density rule's budget scalar during the history (decision 1: the
  // macro mesh and the tiles are one rule with a budget each). 1 is the
  // end state's density; 2 doubles the spacing for the epochs — the
  // relief the history carries, at a quarter of the nodes.
  budget?: number
  // A scale on the tectonics' uplift forcing — the calibration's knob
  // against the erosion rates, 1 = the engine's calibrated ratio.
  upliftScale?: number
  controls?: ErosionControlsV2
  pool?: { createWorker: () => WorkerLike } & PipelineOptions
}

// The history's interim setting, from the first calibration round
// (scripts/calibrateHistory.mjs, 2026-09-23; the table is in
// ADAPTIVE_MESH_PLAN.md phase 5.1): budget 2 (the history at half the
// end state's density — a 512×256 world grows 41 k → 65 k nodes over
// 16 Ma at 2 s an epoch, where budget 1 grew 40 k → 310 k), four
// iterations per epoch (rates ×12.5; pure erosion lowers a 365 m plain
// by 30 % in 16 Ma — sane), and the uplift at a quarter. The quarter is
// the finding, not a tuning: the tectonics' uplift field lifts 88–98 %
// of the land with a mean of 0.4–0.5 (it was made for a 0.8 Myr
// transient), so at 1 the mean land rises 200 m an epoch and the whole
// continent stands 4 km high after 16 Ma. The balance belongs to 5.3
// (flexural compensation) and to a U field confined to the orogens;
// until then the quarter keeps a 50 Ma history in the range of a
// world (mean land +0.5 km, orogens to 3 km at 16 Ma).
export const HISTORY_DEFAULTS = { iterationsPerEpoch: 4, budget: 2, upliftScale: 0.25 } as const

export interface CoupledEpochStats {
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
  timing: { membership: number; tectonics: number; rebuild: number; remesh: number; baseline: number; forcing: number; erosion: number }
}

function baselineAt(sim: PlateSimulation, x: number, y: number): number {
  return raftBaselineAt(x, y, sim.rafts, sim.oceanAge, sim.width, sim.height, sim.warpSeed, sim.seaLevelOffset)
    + dynamicTopographyAt(sim.mantle, MANTLE_RES_X, MANTLE_RES_Y, x, y, sim.width, sim.height)
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
  return { mesh, z, baseline, routing: null, areas: meshAreasOf(mesh), sedimentFlux: new Float32Array(0), preErosionZ: z.slice() }
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
  const timing = { membership: 0, tectonics: 0, rebuild: 0, remesh: 0, baseline: 0, forcing: 0, erosion: 0 }
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
  let k = 0
  for (let v = 0; v < mesh0.vertexSlots; v++) {
    if (!mesh0.vAlive[v]) continue
    const moved = advancePointByMotion(mesh0.vx[v], mesh0.vy[v], sim.motions[host[v]], TECTONICS_TUNING.epochAngleStep, width, height)
    xs[k] = moved.x
    ys[k] = moved.y
    hMoved[k] = terrain.z[v] - terrain.baseline[v]
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
      const hv = state.get('h')
      hv[v] *= Math.min(1, Math.max(0, t))
      state.get(MESH_Z)[v] = baselineAt(sim, x, y) + hv[v]
    },
  })
  timing.remesh = lap()
  const { mesh, order } = compactMesh(mesh1)
  const hCanon = permute(state.get('h'), order)
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
  // Erosion for the epoch, with the tectonics' forcing at the nodes and
  // the rates scaled to the step.
  timing.baseline += lap()
  const { uplift, hardness } = coarseForcingFields(sim, width, height)
  const areas = meshAreasOf(mesh)
  const { forcing, params } = assembleNodeForcing({
    uplift, hardness, forcingResX: CLIMATE_RES_X, forcingResY: CLIMATE_RES_Y,
    water: null, waterResX: 1, waterResY: 1, lithoSeed: erosionLithoSeed(sim.warpSeed),
  }, mesh.vx, mesh.vy, mesh.vAlive, mesh.vertexSlots, zCanon, areas, width, height, options.controls ?? {})
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
  timing.erosion = lap()
  terrain.mesh = mesh
  terrain.z = result.z
  terrain.baseline = baseline
  terrain.routing = result.routing
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
  return { events, nodesBefore, nodesAfter: mesh.aliveVertices, removed: c.removed, inserted: r.inserted, landCells, landVolume, erodedFluxM3: result.erodedFluxM3, exportedFluxM3: result.exportedFluxM3, timing }
}

// The terrain's bytes for a save or a harness hash.
export function encodeCoupledTerrain(terrain: CoupledTerrain): { nodes: Float32Array; connectivity: Uint8Array; z: Float32Array } {
  const order = new Int32Array(terrain.mesh.aliveVertices)
  for (let i = 0; i < order.length; i++) order[i] = i
  const serial = encodeMesh(terrain.mesh, order)
  return { nodes: serial.nodes, connectivity: serial.connectivity, z: terrain.z.slice(0, serial.count) }
}

// A terrain restored from its bytes: the baseline re-evaluated from the sim.
export function decodeCoupledTerrain(sim: PlateSimulation, bytes: { nodes: Float32Array; connectivity: Uint8Array; z: Float32Array }): CoupledTerrain {
  const mesh = decodeMesh(torusDomain(sim.width, sim.height), { count: bytes.z.length, nodes: bytes.nodes, connectivity: bytes.connectivity })
  const baseline = new Float32Array(mesh.vertexSlots)
  for (let v = 0; v < mesh.vertexSlots; v++) baseline[v] = baselineAt(sim, mesh.vx[v], mesh.vy[v])
  return { mesh, z: bytes.z, baseline, routing: null, areas: meshAreasOf(mesh), sedimentFlux: new Float32Array(0), preErosionZ: bytes.z.slice() }
}
