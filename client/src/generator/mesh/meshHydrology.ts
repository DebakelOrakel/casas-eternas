import { metersToElevation, SEA_LEVEL } from '../elevation/elevationScale'
import { DEFAULT_ENGINE_PARAMS, ErosionEngine, type ErosionEngineParams } from '../surface/erosionEngine'
import type { EngineIndex } from '../surface/erosionEngineState'
import type { FlowSubstrate } from '../surface/flowSubstrate'
import { SEA_WATER_LEVEL, SURFACE_ICE, SURFACE_LAKE, SURFACE_SEA, type WaterBody } from '../surface/hydrology'
import { SURFACE_TUNING } from '../surface/surfaceTuneParams'
import { buildMeshEngineIndex, type MeshRouting } from './meshErosion'
import type { PeriodicTriangulation } from './periodicDelaunay'
import { barycentric } from './remesh'

// THE MESH AS A FLOW SUBSTRATE (surface/flowSubstrate.ts; ADAPTIVE_MESH_PLAN.md
// phase 4.3, second half): the hydrology's discharge, lakes, channel
// criterion and regime, and the river graph, run over the mesh's nodes
// through this — the same functions that run over the raster's cells. An
// element is a vertex slot; dead slots have no receiver and are never in
// the pop order, so they fall out of every walk. Positions are the nodes'
// (texel coordinates ARE world cells), the area is the Voronoi cell in
// cells, a step is the edge length in cells, and both neighbourhoods are
// the Delaunay star (every star edge is a Voronoi facet).
export function meshSubstrate(mesh: PeriodicTriangulation, routing: MeshRouting, areas: Float32Array): FlowSubstrate {
  const { domain } = mesh
  return {
    kind: 'mesh',
    width: domain.width,
    height: domain.height,
    count: mesh.vertexSlots,
    filled: routing.filled,
    flowTarget: routing.flowTarget,
    popOrder: routing.popOrder,
    poppedCount: routing.poppedCount,
    x: (v) => mesh.vx[v],
    y: (v) => mesh.vy[v],
    px: (v) => mesh.vx[v],
    py: (v) => mesh.vy[v],
    area: (v) => areas[v],
    step: (a, b) => Math.sqrt(domain.distanceSq(mesh.vx[a], mesh.vy[a], mesh.vx[b], mesh.vy[b])) || 1,
    facetNeighbours: (v, out) => (mesh.vAlive[v] ? mesh.neighbours(v, out) : 0),
    rimNeighbours: (v, out) => (mesh.vAlive[v] ? mesh.neighbours(v, out) : 0),
  }
}

// Every node's Voronoi area in cells (0 for a dead slot).
export function meshAreas(mesh: PeriodicTriangulation): Float32Array {
  const areas = new Float32Array(mesh.vertexSlots)
  for (let v = 0; v < mesh.vertexSlots; v++) if (mesh.vAlive[v]) areas[v] = mesh.voronoiArea(v)
  return areas
}

// The routing of a terrain on the mesh without eroding it — what a restored
// world needs (the save carries the mesh and its heights, the routing is
// derived): the engine's index and one routing refresh, exactly the flood
// and receivers an erosion run ends with.
// `reuse`: an engine index of this same mesh (buildMeshEngineIndex), taken
// as it is where z freezes the same nodes.
export function meshRouting(mesh: PeriodicTriangulation, z: Float32Array, params: ErosionEngineParams = DEFAULT_ENGINE_PARAMS, reuse?: EngineIndex): MeshRouting {
  const index = buildMeshEngineIndex(mesh, z, params, undefined, undefined, reuse)
  const neutral = new Float32Array(index.cellCount)
  const engine = ErosionEngine.onIndex(index, z, { uplift: neutral, erodibility: neutral }, params)
  engine.refreshRouting()
  const { active, activeCount } = index
  const flowTarget = new Int32Array(index.cellCount).fill(-1)
  for (let a = 0; a < activeCount; a++) {
    const t = engine.views.flowTarget[a]
    if (t >= 0) flowTarget[active[a]] = active[t]
  }
  const popOrder = new Int32Array(engine.poppedCount)
  for (let i = 0; i < engine.poppedCount; i++) popOrder[i] = active[engine.views.popOrder[i]]
  const filled = new Float32Array(index.cellCount)
  filled.set(z.subarray(0, index.cellCount))
  const accumulation = new Float32Array(index.cellCount)
  for (let a = 0; a < activeCount; a++) {
    filled[active[a]] = engine.views.filled[a]
    accumulation[active[a]] = engine.views.accumulation[a]
  }
  return { flowTarget, filled, accumulation, popOrder, poppedCount: engine.poppedCount }
}

// THE WATER FIELDS ON THE RASTER, FROM THE MESH: what the cell-walking
// consumers (the climate refinement's dry-floor override, the riparian
// biomes, the map's water plugin, the save's lakeDepth layer) read of the
// mesh's lakes. Every cell takes the body of the NEAREST node of the
// triangle it lies in (the largest barycentric weight) and applies the
// per-cell rules of computeLakesOn to its own rasterised height: wet
// below the body's level (depth, frozen surface), a dry terminal floor
// under sea level (dryBasin, the evaporite band). The level field
// extends over every cell a basin node is nearest to, wet or dry — the
// shore is drawn as its iso-line, so the level must reach past the water.
//
// NOT recovered from the body list on the raster (basinCellsBelow): the
// rasterised terrain interpolates between nodes, and between a basin's
// rim nodes and a lower node beyond its pour point it dips under the
// spill — a flood from the seed then leaks into the next valley. Measured
// 2026-09-23 on the real save: the leaks made three recoveries cost 80 s
// (a basin flooding half the map each) where this pass costs one.
export interface RasterWaterFields {
  depth: Float32Array
  level: Float32Array
  body: Int32Array
  surface: Uint8Array
  saltFlat: Uint8Array
  dryBasin: Uint8Array
  frozen: Uint8Array
}

export function waterFieldsFromMesh(mesh: PeriodicTriangulation, nodeBody: Int32Array, bodies: readonly WaterBody[], elevation: Float32Array, width: number, height: number): RasterWaterFields {
  const n = width * height
  const depth = new Float32Array(n)
  const level = new Float32Array(n).fill(SEA_WATER_LEVEL)
  const body = new Int32Array(n).fill(-1)
  const surface = new Uint8Array(n).fill(SURFACE_SEA)
  const saltFlat = new Uint8Array(n)
  const dryBasin = new Uint8Array(n)
  const frozen = new Uint8Array(n)
  const sx = mesh.domain.width / width
  const sy = mesh.domain.height / height
  const bary = new Float64Array(3)
  let hint = mesh.lastTri
  let rowStart = hint
  for (let py = 0; py < height; py++) {
    hint = rowStart
    for (let px = 0; px < width; px++) {
      const x = px * sx
      const y = py * sy
      const t = mesh.locate(x, y, hint)
      hint = t
      if (px === 0) rowStart = t
      barycentric(mesh, t, x, y, bary)
      let corner = 0
      if (bary[1] > bary[corner]) corner = 1
      if (bary[2] > bary[corner]) corner = 2
      const id = nodeBody[mesh.tris[3 * t + corner]]
      if (id < 0) continue
      const b = bodies[id]
      const c = py * width + px
      const z = elevation[c]
      body[c] = id
      level[c] = b.level
      surface[c] = b.frozen ? SURFACE_ICE : SURFACE_LAKE
      if (z <= b.level) {
        if (b.kind !== 'dry') {
          depth[c] = b.level - z
          if (b.frozen) frozen[c] = 1
        }
      } else if (b.kind !== 'lake' && z <= SEA_LEVEL) {
        dryBasin[c] = 1
        if (z <= b.level + metersToElevation(SURFACE_TUNING.saltBandM)) saltFlat[c] = 1
      }
    }
  }
  return { depth, level, body, surface, saltFlat, dryBasin, frozen }
}
