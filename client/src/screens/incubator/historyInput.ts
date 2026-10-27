import { chartField } from '../../generator/climate/climateChart'
import { CLIMATE_RES_X, CLIMATE_RES_Y } from '../../generator/climate/climateField'
import { climateMesh } from '../../generator/climate/climateMesh'
import type { RefinedClimate } from '../../generator/climate/refinement'
import type { Domain } from '../../generator/core/domain'
import type { PeriodicTriangulation } from '../../generator/mesh/periodicDelaunay'
import { barycentric } from '../../generator/mesh/remesh'
import type { LevelLand, MeshLevelArtifact } from '../../world/meshArtifacts'
import { LEVEL_ECOLOGY, type CellInput } from './cellsShared'

// WHAT A HISTORY IS RUN FROM (2026-10-27): the chart's node map, the
// cells' input, the rain — made the same way in the incubator (its chart
// worker, its worker) and in the history's job (client/scripts/
// incubatorPipeline.ts), so the two give the same bits under the same H1 key.
// No DOM, no i18n: the job worker bundles it.

// The chart the level is painted on, texels: 2.4 km a texel at the
// sphere's equator, 2 km on the torus — a level-1 node (LEVEL_NODE_SPACING_M)
// per texel or so. Two such RGBA textures are 128 MB each.
export const CHART_WIDTH = 8192
export const CHART_HEIGHT = 4096
// The overlay's texel and the node map's: 2 × 2 of the chart's
// (incubatorOverlay.ts).
export const OVERLAY_DIVISOR = 2

// One walk over the chart for the heights, the biomes and the nodes. The
// heights as rasteriseNodeField gives them (the same walk, the same sum in
// the same order, so the same bits); the biome of the triangle's nearest
// corner, of its nearest land corner where the texel is land; the nearest
// corner on every second row and column for `nodes`.
export function chartPass(mesh: PeriodicTriangulation, z: Float32Array, land: Pick<LevelLand, 'land' | 'biome'>, W: number, H: number): { elevation: Float32Array; biome: Uint8Array; nodes: Int32Array } {
  const elevation = new Float32Array(W * H)
  const biome = new Uint8Array(W * H)
  const half = W >> 1
  const nodes = new Int32Array(half * (H >> 1))
  const sx = mesh.domain.width / W
  const sy = mesh.domain.height / H
  const bary = new Float64Array(3)
  const corner = new Int32Array(3)
  let hint = mesh.lastTri
  let rowStart = hint
  for (let py = 0; py < H; py++) {
    const y = py * sy
    hint = rowStart
    for (let px = 0; px < W; px++) {
      const x = px * sx
      const t = mesh.locate(x, y, hint)
      hint = t
      if (px === 0) rowStart = t
      barycentric(mesh, t, x, y, bary)
      corner[0] = mesh.tris[3 * t]
      corner[1] = mesh.tris[3 * t + 1]
      corner[2] = mesh.tris[3 * t + 2]
      const i = py * W + px
      const h = bary[0] * z[corner[0]] + bary[1] * z[corner[1]] + bary[2] * z[corner[2]]
      elevation[i] = h
      let near = 0
      for (let k = 1; k < 3; k++) if (bary[k] > bary[near]) near = k
      let nearLand = -1
      if (h > 0) for (let k = 0; k < 3; k++) if (land.land[corner[k]] && (nearLand < 0 || bary[k] > bary[nearLand])) nearLand = k
      biome[i] = land.biome[corner[nearLand >= 0 ? nearLand : near]]
      if (((px | py) & 1) === 0) nodes[(py >> 1) * half + (px >> 1)] = corner[near]
    }
  }
  return { elevation, biome, nodes }
}

// The cells' input from level 1, its land fields and the chart's node map.
export function cellInputOf(kind: CellInput['kind'], width: number, height: number, nodes: Int32Array, level: Pick<MeshLevelArtifact, 'z' | 'rivers'>, land: LevelLand): CellInput {
  return {
    kind, width, height,
    nodes, nodeW: CHART_WIDTH / OVERLAY_DIVISOR, nodeH: CHART_HEIGHT / OVERLAY_DIVISOR,
    land: land.land, biome: land.biome, koppen: land.koppen, z: level.z, lakeDepth: land.lakeDepth,
    ecology: Object.fromEntries((['game', 'carryingCapacity', ...LEVEL_ECOLOGY] as const).flatMap((id) => (land.ecology[id] ? [[id, land.ecology[id]]] : []))),
    rivers: level.rivers,
  }
}

// CELL_ECOLOGY's order (casas-incubator habitat.rs): the fields the crate
// takes, one after the other, a bit each.
const CELL_ECOLOGY = ['game', 'carryingCapacity', 'arable', 'pasture', 'fish', 'toolStone', 'salt', 'copper'] as const

// The crate's incubator, as both its builds have it (casas-incubator-wasm,
// casas-incubator-node): what the history's run asks of it.
export interface HistoryIncubator {
  count(): number
  growFlora(seed: number): void
  populate(seed: number): void
  originOf(): number
}
export type IncubatorBuild<T> = new (sphere: boolean, spacingKm: number, width: number, height: number, nodes: Int32Array, nodeW: number, nodeH: number, land: Uint8Array, biome: Uint8Array, koppen: Uint8Array, z: Float32Array, lakeDepth: Float32Array, ecology: Uint8Array, present: number, riverPoints?: Float32Array, riverLengths?: Uint32Array, riverRegimes?: Uint8Array) => T

// The crate's incubator on the cells' input.
export function incubatorOf<T>(Build: IncubatorBuild<T>, input: CellInput, spacingKm = 10): T {
  const n = input.land.length
  let present = 0
  const parts: Uint8Array[] = []
  CELL_ECOLOGY.forEach((id, k) => {
    const field = input.ecology[id]
    if (!field) return
    present |= 1 << k
    parts.push(field)
  })
  const ecology = new Uint8Array(parts.length * n)
  parts.forEach((p, k) => ecology.set(p, k * n))
  const r = input.rivers
  return new Build(input.kind === 'sphere', spacingKm, input.width, input.height, input.nodes, input.nodeW, input.nodeH, input.land, input.biome, input.koppen, input.z, input.lakeDepth, ecology, present, r ? Float32Array.from(r.points) : undefined, r ? Uint32Array.from(r.lengths) : undefined, r ? Uint8Array.from(r.regimes) : undefined)
}

// The rain's reliability on the climate's chart, as the history takes it:
// the refinement's variability and its ENSO pattern charted as
// map/refinedLayers.ts charts them (chartRefined), and the ENSO's
// strength. Null where the refinement does not fit the domain's mesh.
export interface HistoryRain {
  width: number
  height: number
  variability: Float32Array
  enso: Float32Array
  ensoStrength: number
}
export function rainOf(domain: Domain, refined: RefinedClimate): HistoryRain | null {
  const cm = climateMesh(domain)
  if (cm.mesh.count !== refined.cells) return null
  return {
    width: CLIMATE_RES_X,
    height: CLIMATE_RES_Y,
    variability: chartField(cm, refined.reliability.rainVariability),
    enso: chartField(cm, refined.reliability.ensoPattern),
    ensoStrength: refined.reliability.ensoStrength,
  }
}
