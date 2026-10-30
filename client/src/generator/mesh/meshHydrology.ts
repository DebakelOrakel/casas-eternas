import { metersToElevation, SEA_LEVEL } from '../elevation/elevationScale'
import { SEA_WATER_LEVEL, SURFACE_ICE, SURFACE_LAKE, SURFACE_SEA, type WaterBody } from '../surface/hydrology'
import { SURFACE_TUNING } from '../pipeline/engineConstants'
import type { PeriodicTriangulation } from './periodicDelaunay'

// THE WATER FIELDS ON THE RASTER, FROM THE MESH: what the cell-walking
// consumers (the climate refinement's dry-floor override, the riparian
// biomes, the map's water plugin, the save's lakeDepth layer) read of the
// mesh's lakes. Every cell takes the body of the NEAREST node of the
// triangle it lies in (the largest barycentric weight) and applies the
// per-cell rules of the engine's `compute_lakes_on` to its own rasterised height: wet
// below the body's level (depth, frozen surface), a dry terminal floor
// under sea level (dryBasin, the evaporite band). The level field
// extends over every cell a basin node is nearest to, wet or dry — the
// shore is drawn as its iso-line, so the level must reach past the water.
//
// NOT recovered from the body list on the raster (the engine's `basin_cells_below`): the
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
      mesh.barycentric(t, x, y, bary)
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
