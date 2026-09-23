import { torusDomain } from '../core/domain'
import { synthesisSampler, type SynthesisSources } from '../elevation/elevationSampler'
import { buildMesh, MESH_Z } from '../mesh/meshBuild'
import { runMeshErosion, type MeshErosionResult } from '../mesh/meshErosion'
import { rasteriseNodeField } from '../mesh/meshRaster'
import { compactMesh, permute } from '../mesh/meshSerial'
import type { PeriodicTriangulation } from '../mesh/periodicDelaunay'
import type { WorkerLike } from '../surface/erosionEnginePool'
import type { PipelineOptions } from '../surface/erosionEnginePool'
import { assembleNodeForcing, erosionLithoSeed, type ErosionControlsV2 } from '../surface/erosionForcingFields'
import { computeWeather, defaultWeatherParams, type WeatherParams } from '../climate/weather'
import { CLIMATE_RES_X, CLIMATE_RES_Y } from '../climate/climateField'
import { coarseForcingFields, type ErosionForcingSources } from './erosionForcing'

// THE EROSION STAGE ON THE MESH (ADAPTIVE_MESH_PLAN.md phase 4.3): what
// the generator's erode request runs, and what the golden harness gates —
// ONE function, for the same reason pipeline/erosionForcing.ts is one: the
// harness must watch exactly the world the player gets.
//
// The mesh is built fresh for every run from the tectonics' point
// synthesis (elevation/elevationSampler.ts) under the density rule, so
// its nodes stand on ridges the 2048 raster only averages; the forcing is
// evaluated at the nodes (surface/erosionForcingFields.assembleNodeForcing)
// with the same coarse fields and the same water chain the raster stage
// used; the engine runs on it (mesh/meshErosion.ts). What comes out is the
// mesh with its eroded heights — the world's terrain from here on, what
// the save carries — and, until the map and the hydrology read the mesh
// (phases 4.4 on), a 2048 RASTERISATION of it for every consumer that
// still walks cells. The sediment flux is rasterised the same way; a
// channel quantity sampled linearly is smeared across the triangle, which
// the river graph's reach load tolerates and phase 4.4 removes.
//
// The mesh is handed back in CANONICAL form (mesh/meshSerial.ts): Hilbert
// numbered, rebuilt through the codec — the mesh a reload of the save
// produces, bit for bit.

export interface MeshTerrain {
  mesh: PeriodicTriangulation
  // Heights per vertex (canonical numbering), elevation units.
  z: Float32Array
}

export interface MeshErosionStageOptions {
  age: number
  controls?: ErosionControlsV2
  weather?: WeatherParams
  pool?: { createWorker: () => WorkerLike } & PipelineOptions
  onProgress?: (fraction: number) => void
  // A 2048 rasterisation every ~eighth of the run, for a redraw.
  onChunkComplete?: (elevations: Float32Array, chunk: number) => void | Promise<void>
  shouldCancel?: () => boolean
  // Fraction 0..1 of the build stage (mesh + forcing) before the run.
  onBuildProgress?: (fraction: number) => void
}

export interface MeshErosionStageResult {
  terrain: MeshTerrain
  // The rasterised terrain and sediment flux, `width` × `height`. `before`
  // is the rasterisation of the mesh's INITIAL heights — what "before
  // erosion" means for this world's cells. The synthesis raster is not
  // that: between two deep-ocean nodes 40 km apart the mesh is a plane and
  // the raster is the synthesis, metres apart cell by cell, and a consumer
  // that compares the eroded raster with the synthesis reads the
  // difference as deposition (the sediment basins ×7, measured on the
  // first golden run).
  before: Float32Array
  elevations: Float32Array
  sedimentFlux: Float32Array
  accumulation: Float32Array
  result: MeshErosionResult
}

export async function erodeOnMesh(
  sources: SynthesisSources & ErosionForcingSources,
  rawElevations: Float32Array,
  width: number,
  height: number,
  options: MeshErosionStageOptions,
): Promise<MeshErosionStageResult> {
  const domain = torusDomain(width, height)
  const sampler = synthesisSampler(sources)
  options.onBuildProgress?.(0)
  const built = buildMesh(domain, sampler, { seed: sources.warpSeed })
  options.onBuildProgress?.(0.6)
  // Canonical numbering before anything reads the mesh.
  const { mesh, order } = compactMesh(built.mesh)
  const z = permute(built.state.get(MESH_Z), order)
  const areas = new Float64Array(mesh.vertexSlots)
  for (let v = 0; v < mesh.vertexSlots; v++) if (mesh.vAlive[v]) areas[v] = mesh.voronoiArea(v)
  const { uplift, hardness } = coarseForcingFields(sources, width, height)
  const water = computeWeather(rawElevations, width, height, options.weather ?? defaultWeatherParams()).seasonal.annual
  const { forcing, params } = assembleNodeForcing({
    uplift, hardness, forcingResX: CLIMATE_RES_X, forcingResY: CLIMATE_RES_Y,
    water, waterResX: CLIMATE_RES_X, waterResY: CLIMATE_RES_Y,
    lithoSeed: erosionLithoSeed(sources.warpSeed),
  }, mesh.vx, mesh.vy, mesh.vAlive, mesh.vertexSlots, z, areas, width, height, options.controls ?? {})
  options.onBuildProgress?.(1)
  const result = await runMeshErosion(mesh, z, forcing, {
    age: options.age,
    params,
    pool: options.pool,
    onProgress: options.onProgress,
    onChunkComplete: options.onChunkComplete
      ? (chunkZ, chunk) => options.onChunkComplete!(rasteriseNodeField(mesh, chunkZ, width, height), chunk)
      : undefined,
    shouldCancel: options.shouldCancel,
  })
  return {
    terrain: { mesh, z: result.z },
    before: rasteriseNodeField(mesh, z, width, height),
    elevations: rasteriseNodeField(mesh, result.z, width, height),
    sedimentFlux: rasteriseNodeField(mesh, result.sedimentFlux, width, height),
    accumulation: rasteriseNodeField(mesh, result.routing.accumulation, width, height),
    result,
  }
}
