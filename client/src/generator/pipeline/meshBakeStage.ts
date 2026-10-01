import { torusDomain } from '../core/domain'
import { CLIMATE_RES_X, CLIMATE_RES_Y } from '../climate/climateField'
import { SEA_LEVEL } from '../elevation/elevationScale'
import { runMeshErosion, type MeshRouting } from '../mesh/meshErosion'
import { meshAreas, meshSubstrate } from '../mesh/meshHydrology'
import { refineMeshLevel } from '../mesh/meshRefine'
import { createMeshSampler } from '../mesh/meshSampler'
import { decodeMesh } from '../mesh/meshSerial'
import type { PeriodicTriangulation } from '../mesh/periodicDelaunay'
import { BAKE_ENGINE_OVERRIDES } from '../surface/amplify'
import type { PipelineOptions, WorkerLike } from '../surface/erosionEnginePool'
import { assembleNodeForcing, type ErosionControlsV2 } from '../surface/erosionForcingFields'
import { accumulateDischargeOn, accumulateRegimeInputsOn, CANONICAL_RIVER_DENSITY, channelThreshold, computeLakesOn, densityToCriticalArea, maxDischargeOverLand, meanLandRunoff, type RiverPolylines, type WaterBody } from '../surface/hydrology'
import { WORLD_WIDTH_METERS } from '../surface/erosionEngine'
import { computeRiverCourses } from '../surface/riverCourse'
import { buildRiverGraph, riverPolylinesFromGraph, type RiverGraph } from '../surface/riverGraph'
import type { SavedMesh } from '../mesh/meshSerial'

// THE GLOBAL BAKE OF ONE LEVEL (decision 3 of docs/decisions/adaptive-mesh.md,
// ADAPTIVE_MESH_PLAN.md phase 4.5): the save's mesh refined to a finer
// budget (mesh/meshRefine.ts), eroded for a short transient with the
// bake's policy — no uplift, the coastline pinned to the parent's — and
// the hydrology and the river graph derived on the level. What comes out
// is the level: a mesh with heights, its water bodies, its graph, the
// ribbons — the artifact (world/meshArtifacts.ts). Deterministic from the
// save alone, so the browser and the server bake identical bytes, and the
// same function runs in both (scripts/bake.ts is the server's caller).
//
// Until phase 5 the level is the detail role of the engine only: it
// refines the macro's eroded state, it does not resume the history. The
// coast is pinned strictly (a node keeps the parent's land/sea status);
// the raster bake's delta allowance around river mouths waits until the
// graph is a save member the bake can read.

export interface MeshBakeInputs {
  // The save's mesh (loadWorldInputs.WorldInputs.mesh).
  mesh: SavedMesh
  width: number
  height: number
  detailSeed: number
  lithoSeed: number
  controls: ErosionControlsV2
  // The save's coarse layers; null where the save has none (neutral).
  uplift: Float32Array | null
  erodibility: Float32Array | null
  forcingResX: number
  forcingResY: number
  precipitation: Float32Array | null
  temperature: Float32Array | null
  monsoonIndex: Float32Array | null
  climateResX: number
  climateResY: number
}

export interface MeshBakeOptions {
  level: number
  // The density budget of the level (0.5 = twice as fine as the macro).
  budget: number
  // The transient's iterations (the raster bake's erosionRounds).
  rounds: number
  pool?: { createWorker: () => WorkerLike } & PipelineOptions
  onProgress?: (phase: 'refine' | 'erosion' | 'hydrology', fraction: number) => void
}

export interface MeshLevel {
  level: number
  mesh: PeriodicTriangulation
  z: Float32Array
  routing: MeshRouting
  discharge: Float32Array
  waterBodies: WaterBody[]
  graph: RiverGraph | null
  rivers: RiverPolylines | null
  // How many nodes the refinement added over the parent.
  inserted: number
}

// The level's budget by its number — the detail ladder (docs/decisions/
// detail-ladder.md, fork 1): level 0 at the history's 4, each level a
// quarter of the one before (4, 1, 1/4, 1/16).
export function levelBudget(level: number): number {
  return 4 / Math.pow(4, level)
}

export async function bakeMeshLevel(inputs: MeshBakeInputs, options: MeshBakeOptions): Promise<MeshLevel> {
  const { width, height } = inputs
  const domain = torusDomain(width, height)
  const parent = decodeMesh(domain, { count: inputs.mesh.count, nodes: inputs.mesh.nodes, connectivity: inputs.mesh.connectivity })
  // The coastline the level keeps: the parent's, sampled where each node
  // stands (the parent mesh is refined in place below, so sample first).
  const parentSampler = createMeshSampler(decodeMesh(domain, { count: inputs.mesh.count, nodes: inputs.mesh.nodes, connectivity: inputs.mesh.connectivity }), inputs.mesh.z)
  options.onProgress?.('refine', 0)
  const refined = refineMeshLevel(parent, inputs.mesh.z, { budget: options.budget, seed: inputs.detailSeed, level: options.level, width, height })
  options.onProgress?.('refine', 1)
  const { mesh } = refined
  const areas = meshAreas(mesh)
  const coarse = {
    uplift: inputs.uplift, hardness: inputs.erodibility,
    forcingResX: inputs.forcingResX || 1, forcingResY: inputs.forcingResY || 1,
    water: inputs.precipitation, waterResX: inputs.climateResX || 1, waterResY: inputs.climateResY || 1,
    lithoSeed: inputs.lithoSeed,
  }
  const { forcing, params } = assembleNodeForcing(coarse, mesh.vx, mesh.vy, mesh.vAlive, mesh.vertexSlots, refined.z, areas, width, height, inputs.controls)
  // The coastline is the parent's: every node is pinned to the land/sea
  // status of the parent surface where it stands.
  const statusMask = new Uint8Array(mesh.vertexSlots)
  for (let v = 0; v < mesh.vertexSlots; v++) if (mesh.vAlive[v]) statusMask[v] = parentSampler.heightAt(mesh.vx[v], mesh.vy[v]) > SEA_LEVEL ? 1 : 2
  forcing.statusMask = statusMask
  const result = await runMeshErosion(mesh, refined.z, forcing, {
    age: options.rounds,
    params: { ...params, upliftDt: BAKE_ENGINE_OVERRIDES.upliftDt },
    pool: options.pool,
    onProgress: (fraction) => options.onProgress?.('erosion', fraction),
  })
  options.onProgress?.('hydrology', 0)
  const z = result.z
  const water = inputs.precipitation && inputs.temperature
    ? levelHydrology(mesh, z, result.routing, areas, result.sedimentFlux, {
      precipitation: inputs.precipitation, temperature: inputs.temperature, monsoonIndex: inputs.monsoonIndex,
      climateResX: inputs.climateResX || CLIMATE_RES_X, climateResY: inputs.climateResY || CLIMATE_RES_Y,
    }, { width, height, budget: options.budget, detailSeed: inputs.detailSeed })
    : { discharge: new Float32Array(mesh.vertexSlots), waterBodies: [], graph: null, rivers: null }
  options.onProgress?.('hydrology', 1)
  return { level: options.level, mesh, z, routing: result.routing, ...water, inserted: refined.inserted }
}

// The climate a level's waters are derived from, on the climate grid.
export interface LevelClimate {
  precipitation: Float32Array
  temperature: Float32Array
  monsoonIndex: Float32Array | null
  climateResX: number
  climateResY: number
}

// A level's waters from its terrain: the discharge, the lakes, the channel
// criterion and the river graph with its courses. One derivation for the
// two ways a level is made — refined from the save (bakeMeshLevel) and
// replayed from the recipe (world/replay.ts) — so they draw the same
// rivers from the same terrain.
export function levelHydrology(
  mesh: PeriodicTriangulation, z: Float32Array, routing: MeshRouting, areas: Float32Array, sedimentFlux: Float32Array,
  climate: LevelClimate, level: { width: number; height: number; budget: number; detailSeed: number },
): { discharge: Float32Array; waterBodies: WaterBody[]; graph: RiverGraph; rivers: RiverPolylines } {
  const { width, height } = level
  const { precipitation, temperature, climateResX: CRX, climateResY: CRY } = climate
  const sub = meshSubstrate(mesh, routing, areas)
  const discharge = accumulateDischargeOn(sub, z, precipitation, CRX, CRY)
  const lakes = computeLakesOn(sub, discharge, z, temperature, precipitation, CRX, CRY)
  // The channel criterion as the raster bake derives it: the canonical
  // density over the world's mean runoff.
  const macroLand = new Float32Array(width * height)
  const meanRunoff = meanLandRunoff(precipitation, macroLandFrom(mesh, z, width, height, macroLand), width, height, CRX, CRY)
  const threshold = channelThreshold(densityToCriticalArea(CANONICAL_RIVER_DENSITY), meanRunoff)
  const maxDischarge = maxDischargeOverLand(discharge, z)
  const graph = buildRiverGraph({
    substrate: sub, discharge, elevation: z, threshold, maxDischarge,
    bodies: lakes.bodies, body: lakes.body, lakeDepth: lakes.depth, sedimentFlux,
    regime: accumulateRegimeInputsOn(sub, z, temperature, precipitation, climate.monsoonIndex ?? undefined, CRX, CRY),
    criticalArea: densityToCriticalArea(CANONICAL_RIVER_DENSITY),
  })
  graph.courses = computeRiverCourses(graph, { cellM: (WORLD_WIDTH_METERS / width) * level.budget, seed: level.detailSeed })
  return { discharge, waterBodies: lakes.bodies, graph, rivers: riverPolylinesFromGraph(graph, maxDischarge) }
}

// The land mask the mean runoff is taken over — the macro grid's cells
// under land nodes, a rasterisation cheap enough to be exact here.
function macroLandFrom(mesh: PeriodicTriangulation, z: Float32Array, width: number, height: number, out: Float32Array): Float32Array {
  for (let v = 0; v < mesh.vertexSlots; v++) {
    if (!mesh.vAlive[v] || z[v] <= SEA_LEVEL) continue
    const cx = ((Math.floor(mesh.vx[v]) % width) + width) % width
    const cy = ((Math.floor(mesh.vy[v]) % height) + height) % height
    out[cy * width + cx] = 1
  }
  return out
}
