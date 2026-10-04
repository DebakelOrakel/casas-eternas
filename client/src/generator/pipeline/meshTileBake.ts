import { wrapValue } from '../core/field'
import { SEA_LEVEL } from '../elevation/elevationScale'
import { DEFAULT_ROUTING_EVERY, runMeshErosion, type MeshRouting } from '../mesh/meshErosion'
import { meshAreas } from '../mesh/meshHydrology'
import { buildTileMesh, tileCorner, TILE_ROLE_EDGE, TILE_ROLE_HALO, tileSpec, type TileId, type TileMesh, type TileParent } from '../mesh/meshTile'
import { tileAt } from './tilePlan'
import { BAKE_ENGINE_OVERRIDES } from '../surface/amplify'
import type { PipelineOptions, WorkerLike } from '../surface/erosionEnginePool'
import { assembleNodeForcing, type ErosionControlsV2 } from '../surface/erosionForcingFields'
import type { RiverGraph } from '../surface/riverGraph'

// THE BAKE OF ONE TILE of a fine level (docs/decisions/tile-jobs.md): the
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
// - water enters over the edge (docs/decisions/detail-ladder.md, step 5,
//   fork 6): from an UPSTREAM tile of the same level (the tile plan's flow
//   edges, generator/pipeline/tilePlan.ts) at every edge node, as that
//   tile's outflow there; from any other side as the rivers of level 1
//   that cross it, each crossing's catchment. Either is added, in the
//   engine's unit, to the drainage weight of the first node inside (the
//   network is frozen, answer 4 — the tile reshapes the ground under it,
//   it does not re-route it).
// - water leaves over the edge: the outflow at each edge node — the
//   drainage of the inside nodes that flow into it — is the tile's, for
//   the tile below.
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
  // The upstream tiles of the same level, with their outflow (empty for
  // none): a crossing from one of these comes from its outflow, not from
  // level 1's rivers.
  upstream: UpstreamTile[]
}

// An upstream tile as the bake reads it: its inside nodes in cells from
// its corner and the outflow at each (world/meshTileArtifacts.ts).
export interface UpstreamTile {
  tile: TileId
  count: number
  nodes: Float32Array
  outflow: Float32Array
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
  // The water entering from upstream tiles, summed (the engine's unit),
  // and over how many edge nodes.
  upstreamInflow: number
  upstreamNodes: number
  // Per node of tile.mesh: the drainage that leaves over it (edge nodes
  // only; the engine's unit, water-weighted macro cells).
  outflow: Float32Array
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
  // The water from upstream tiles, at every edge node they share.
  const upstreamKeys = new Set(inputs.upstream.map((u) => `${u.tile.x},${u.tile.y}`))
  let upstreamInflow = 0
  let upstreamNodes = 0
  if (forcing.accumulationWeights && inputs.upstream.length > 0) {
    const weights = forcing.accumulationWeights
    const spec = tileSpec(id.level)
    const edgeAt = new Map<string, number>()
    for (let v = 0; v < slots; v++) if (mesh.vAlive[v] && tile.role[v] === TILE_ROLE_EDGE) edgeAt.set(`${xs[v]},${ys[v]}`, v)
    for (const up of inputs.upstream) {
      const corner = tileCorner(up.tile, spec)
      for (let i = 0; i < up.count; i++) {
        if (!(up.outflow[i] > 0)) continue
        const e = edgeAt.get(`${wrapValue(corner.x + up.nodes[2 * i], width)},${wrapValue(corner.y + up.nodes[2 * i + 1], height)}`)
        if (e === undefined) continue
        const v = insideNodeNear(tile, e)
        if (v < 0 || areas[v] <= 0) continue
        weights[v] += up.outflow[i] / areas[v]
        upstreamInflow += up.outflow[i]
        upstreamNodes++
      }
    }
  }
  // The rivers of level 1 that enter from any other side.
  let inflows = 0
  let inflowDischarge = 0
  if (inputs.parentGraph && forcing.accumulationWeights && inputs.meanLandWater > 0) {
    const weights = forcing.accumulationWeights
    for (const crossing of inflowCrossings(inputs.parentGraph, tile, width, height)) {
      const from = tileAt(id.level, crossing.fromX, crossing.fromY, width, height)
      if (upstreamKeys.has(`${from.x},${from.y}`)) continue
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
    // The pool on the single engine's cadence: fresh routing every
    // DEFAULT_ROUTING_EVERY rounds, waited for (erosionEnginePool.ts,
    // PipelineOptions.synchronous). A tile's rounds are few, and water that
    // follows the cut is the point of eroding them.
    pool: options.pool && { ...options.pool, pipelineDepth: DEFAULT_ROUTING_EVERY, synchronous: true },
    frozen,
    onProgress: (fraction) => options.onProgress?.('erosion', fraction),
  })
  // The outflow: the drainage of the inside nodes that flow onto the edge.
  const outflow = new Float32Array(slots)
  const target = result.routing.flowTarget
  for (let v = 0; v < slots; v++) {
    if (!mesh.vAlive[v] || tile.role[v] === TILE_ROLE_EDGE || tile.role[v] === TILE_ROLE_HALO) continue
    const t = target[v]
    if (t >= 0 && tile.role[t] === TILE_ROLE_EDGE) outflow[t] += result.routing.accumulation[v]
  }
  return { tile, z: result.z, routing: result.routing, inflows, inflowDischarge, upstreamInflow, upstreamNodes, outflow, erodedFluxM3: result.erodedFluxM3 }
}

// Where level 1's rivers cross the tile's edge inward: the first cell of a
// reach inside the tile after one outside it, in the tile's local frame,
// with the discharge there (interpolated along the reach by cell count).
function inflowCrossings(graph: RiverGraph, tile: TileMesh, width: number, height: number): { x: number; y: number; fromX: number; fromY: number; discharge: number }[] {
  const out: { x: number; y: number; fromX: number; fromY: number; discharge: number }[] = []
  const x0 = tile.originX + tile.halo
  const y0 = tile.originY + tile.halo
  const local = (x: number, y: number): [number, number] => [wrapValue(x - x0, width), wrapValue(y - y0, height)]
  const cells = tileSpec(tile.tile.level).cells
  const inside = (lx: number, ly: number): boolean => lx < cells && ly < cells
  for (const reach of graph.reaches) {
    if (reach.kind !== 'river' || reach.cellCount < 2) continue
    let [px, py] = local(graph.cellX[reach.cellStart], graph.cellY[reach.cellStart])
    for (let i = 1; i < reach.cellCount; i++) {
      const [qx, qy] = local(graph.cellX[reach.cellStart + i], graph.cellY[reach.cellStart + i])
      if (!inside(px, py) && inside(qx, qy)) {
        const t = i / (reach.cellCount - 1)
        out.push({
          x: qx + tile.halo, y: qy + tile.halo,
          fromX: graph.cellX[reach.cellStart + i - 1], fromY: graph.cellY[reach.cellStart + i - 1],
          discharge: reach.dischargeIn + (reach.dischargeOut - reach.dischargeIn) * t,
        })
      }
      px = qx
      py = qy
    }
  }
  return out
}

// The inside node nearest an edge node, by the mesh: its star first, then
// ring by ring — in sparse ground a corner's triangles may hold edge nodes
// only, so a fixed neighbourhood can come up empty (2026-10-01).
function insideNodeNear(tile: TileMesh, e: number): number {
  const { mesh, role } = tile
  const star = new Int32Array(256)
  const seen = new Set<number>([e])
  let ring = [e]
  for (let depth = 0; depth < 64 && ring.length > 0; depth++) {
    const next: number[] = []
    let best = -1
    let bestD = Infinity
    for (const u of ring) {
      const n = mesh.neighbours(u, star)
      for (let k = 0; k < n; k++) {
        const w = star[k]
        if (seen.has(w)) continue
        seen.add(w)
        if (role[w] === TILE_ROLE_HALO) continue
        if (role[w] !== TILE_ROLE_EDGE) {
          const d = mesh.domain.distanceSq(mesh.vx[w], mesh.vy[w], mesh.vx[e], mesh.vy[e])
          if (d < bestD || (d === bestD && w < best)) {
            bestD = d
            best = w
          }
        } else next.push(w)
      }
    }
    if (best >= 0) return best
    ring = next
  }
  return -1
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
