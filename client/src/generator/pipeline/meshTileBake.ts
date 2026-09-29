import { wrapValue } from '../core/field'
import { SEA_LEVEL } from '../elevation/elevationScale'
import { runMeshErosion, type MeshRouting } from '../mesh/meshErosion'
import { meshAreas } from '../mesh/meshHydrology'
import { buildTileMesh, TILE_CELLS, TILE_ROLE_EDGE, TILE_ROLE_HALO, type TileId, type TileMesh, type TileParent } from '../mesh/meshTile'
import { BAKE_ENGINE_OVERRIDES } from '../surface/amplify'
import type { PipelineOptions, WorkerLike } from '../surface/erosionEnginePool'
import { assembleNodeForcing, type ErosionControlsV2 } from '../surface/erosionForcingFields'
import type { RiverGraph } from '../surface/riverGraph'

// THE BAKE OF ONE TILE of the top level (docs/decisions/tile-jobs.md): the
// tile's mesh (mesh/meshTile.ts) eroded for a short transient with the
// level bake's policy — no uplift, the coastline pinned to the parent's —
// and with the tile's own boundary rule:
//
// - the halo is frozen: computed around the tile for the triangulation,
//   not eroded;
// - the edge row is PINNED (the engine's pinnedZ): it keeps the parent
//   surface's height through every iteration and is a seed of the flood,
//   so water and sediment leave the tile over it wherever the ground
//   falls to it, and two neighbours hold the same ground on the line;
// - the rivers of level 1 that cross the edge INTO the tile bring their
//   discharge: each crossing adds its catchment, in the engine's unit, to
//   the drainage weight of the first node inside (the network is frozen,
//   answer 4 — the tile reshapes the ground under it, it does not
//   re-route it).
//
// The water weights are normalised by the WORLD's mean land water
// (`meanLandWater`, hydrology.meanLandRunoff on the macro grid), not by
// the tile's: the discharge a crossing river carries is in the same unit
// then — the hydrology's mm/yr over contributing cells divided by that
// mean is the engine's weighted area exactly.

export interface TileBakeInputs {
  parent: TileParent
  // Level 1's river graph (its artifact's), for the inflow; null for none.
  parentGraph: RiverGraph | null
  width: number
  height: number
  detailSeed: number
  lithoSeed: number
  controls: ErosionControlsV2
  uplift: Float32Array | null
  erodibility: Float32Array | null
  forcingResX: number
  forcingResY: number
  precipitation: Float32Array | null
  climateResX: number
  climateResY: number
  // The world's mean land water, mm/yr (hydrology.meanLandRunoff).
  meanLandWater: number
}

export interface TileBakeOptions {
  rounds: number
  pool?: { createWorker: () => WorkerLike } & PipelineOptions
  onProgress?: (phase: 'mesh' | 'erosion', fraction: number) => void
}

export interface BakedTile {
  tile: TileMesh
  // Eroded heights per node of tile.mesh.
  z: Float32Array
  routing: MeshRouting
  // How many level-1 rivers enter the tile, and their discharge summed
  // (the hydrology's unit).
  inflows: number
  inflowDischarge: number
  erodedFluxM3: number
}

export async function bakeMeshTile(inputs: TileBakeInputs, id: TileId, options: TileBakeOptions): Promise<BakedTile> {
  const { width, height, parent } = inputs
  options.onProgress?.('mesh', 0)
  const tile = buildTileMesh(parent, id, { seed: inputs.detailSeed, width, height })
  options.onProgress?.('mesh', 1)
  const { mesh } = tile
  const slots = mesh.vertexSlots
  const xs = new Float64Array(slots)
  const ys = new Float64Array(slots)
  for (let v = 0; v < slots; v++) {
    xs[v] = wrapValue(tile.originX + mesh.vx[v], width)
    ys[v] = wrapValue(tile.originY + mesh.vy[v], height)
  }
  const areas = meshAreas(mesh)
  const coarse = {
    uplift: inputs.uplift, hardness: inputs.erodibility,
    forcingResX: inputs.forcingResX || 1, forcingResY: inputs.forcingResY || 1,
    water: inputs.precipitation, waterResX: inputs.climateResX || 1, waterResY: inputs.climateResY || 1,
    lithoSeed: inputs.lithoSeed,
  }
  const { forcing, params } = assembleNodeForcing(coarse, xs, ys, mesh.vAlive, slots, tile.z, areas, width, height, inputs.controls, inputs.meanLandWater > 0 ? inputs.meanLandWater : undefined)
  // The coastline is the parent's, as in the level bake.
  const statusMask = new Uint8Array(slots)
  for (let v = 0; v < slots; v++) if (mesh.vAlive[v]) statusMask[v] = parent.sampler.heightAt(xs[v], ys[v]) > SEA_LEVEL ? 1 : 2
  forcing.statusMask = statusMask
  // The edge row pinned, the halo frozen.
  const pinnedZ = new Float32Array(slots).fill(NaN)
  const frozen = new Uint8Array(slots)
  for (let v = 0; v < slots; v++) {
    if (!mesh.vAlive[v]) continue
    if (tile.role[v] === TILE_ROLE_EDGE) pinnedZ[v] = tile.z[v]
    else if (tile.role[v] === TILE_ROLE_HALO) frozen[v] = 1
  }
  forcing.pinnedZ = pinnedZ
  // The rivers that enter.
  let inflows = 0
  let inflowDischarge = 0
  if (inputs.parentGraph && forcing.accumulationWeights && inputs.meanLandWater > 0) {
    const weights = forcing.accumulationWeights
    for (const crossing of inflowCrossings(inputs.parentGraph, tile, width, height)) {
      const v = firstInsideNode(tile, crossing.x, crossing.y)
      if (v < 0 || areas[v] <= 0) continue
      weights[v] += crossing.discharge / inputs.meanLandWater / areas[v]
      inflows++
      inflowDischarge += crossing.discharge
    }
  }
  const result = await runMeshErosion(mesh, tile.z, forcing, {
    age: options.rounds,
    params: { ...params, upliftDt: BAKE_ENGINE_OVERRIDES.upliftDt },
    pool: options.pool,
    frozen,
    onProgress: (fraction) => options.onProgress?.('erosion', fraction),
  })
  return { tile, z: result.z, routing: result.routing, inflows, inflowDischarge, erodedFluxM3: result.erodedFluxM3 }
}

// Where level 1's rivers cross the tile's edge inward: the first cell of a
// reach inside the tile after one outside it, in the tile's local frame,
// with the discharge there (interpolated along the reach by cell count).
function inflowCrossings(graph: RiverGraph, tile: TileMesh, width: number, height: number): { x: number; y: number; discharge: number }[] {
  const out: { x: number; y: number; discharge: number }[] = []
  const x0 = tile.originX + tile.halo
  const y0 = tile.originY + tile.halo
  const local = (x: number, y: number): [number, number] => [wrapValue(x - x0, width), wrapValue(y - y0, height)]
  const inside = (lx: number, ly: number): boolean => lx < TILE_CELLS && ly < TILE_CELLS
  for (const reach of graph.reaches) {
    if (reach.kind !== 'river' || reach.cellCount < 2) continue
    let [px, py] = local(graph.cellX[reach.cellStart], graph.cellY[reach.cellStart])
    for (let i = 1; i < reach.cellCount; i++) {
      const [qx, qy] = local(graph.cellX[reach.cellStart + i], graph.cellY[reach.cellStart + i])
      if (!inside(px, py) && inside(qx, qy)) {
        const t = i / (reach.cellCount - 1)
        out.push({ x: qx + tile.halo, y: qy + tile.halo, discharge: reach.dischargeIn + (reach.dischargeOut - reach.dischargeIn) * t })
      }
      px = qx
      py = qy
    }
  }
  return out
}

// The tile node nearest a point inside it that is neither edge nor halo:
// the corners of the triangle under it, then their neighbours.
function firstInsideNode(tile: TileMesh, x: number, y: number): number {
  const { mesh, role } = tile
  const t = mesh.locate(x, y)
  const candidates: number[] = []
  const star = new Int32Array(256)
  for (let c = 0; c < 3; c++) {
    const v = mesh.tris[3 * t + c]
    candidates.push(v)
    const n = mesh.neighbours(v, star)
    for (let k = 0; k < n; k++) candidates.push(star[k])
  }
  let best = -1
  let bestD = Infinity
  for (const v of candidates) {
    if (role[v] === TILE_ROLE_EDGE || role[v] === TILE_ROLE_HALO) continue
    const d = mesh.domain.distanceSq(mesh.vx[v], mesh.vy[v], x, y)
    if (d < bestD) {
      bestD = d
      best = v
    }
  }
  return best
}
