import { chartField } from '../../generator/climate/climateChart'
import { CLIMATE_RES_X, CLIMATE_RES_Y } from '../../generator/climate/climateField'
import { climateMesh } from '../../generator/climate/climateMesh'
import type { RefinedClimate } from '../../generator/climate/refinement'
import type { Domain } from '../../generator/core/domain'
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

// The crate's chart of level 1 (casas-incubator chart.rs), as both its
// builds have it: the level's mesh decoded once; a node field on a
// raster; one walk over the chart for the heights, the biomes and, at
// OVERLAY_DIVISOR, the nodes, whose arrays are taken one by one. The
// chart worker paints with it, the history's job takes its node map: the
// same walk, the same bits.
export interface HistoryChart {
  raster(z: Float32Array, w: number, h: number): Float32Array
  pass(z: Float32Array, land: Uint8Array, biome: Uint8Array, w: number, h: number): void
  takeElevation(): Float32Array
  takeBiome(): Uint8Array
  takeNodes(): Int32Array
}
export type ChartBuild<T> = new (sphere: boolean, width: number, height: number, count: number, nodes: Float32Array, connectivity: Uint8Array) => T

// The crate's chart of a level on the world raster's domain.
export function chartOf<T>(Build: ChartBuild<T>, kind: CellInput['kind'], width: number, height: number, level: Pick<MeshLevelArtifact, 'count' | 'nodes' | 'connectivity'>): T {
  return new Build(kind === 'sphere', width, height, level.count, level.nodes, level.connectivity)
}

// The cells' input from level 1, its land fields and the chart's node map.
export function cellInputOf(kind: CellInput['kind'], width: number, height: number, nodes: Int32Array, level: Pick<MeshLevelArtifact, 'z' | 'rivers'>, land: LevelLand): CellInput {
  return {
    kind, width, height,
    nodes, nodeW: CHART_WIDTH / OVERLAY_DIVISOR, nodeH: CHART_HEIGHT / OVERLAY_DIVISOR,
    land: land.land, biome: land.biome, koppen: land.koppen, z: level.z, lakeDepth: land.lakeDepth,
    ecology: Object.fromEntries((['game', 'carryingCapacity', ...LEVEL_ECOLOGY] as const).flatMap((id) => (land.ecology[id] ? [[id, land.ecology[id]]] : []))),
    shelfCarrying: land.shelfEcology.carryingCapacity ?? null,
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
  originOf(seed: number, reachKm?: number, seaLowM?: number): number
}
export type IncubatorBuild<T> = new (sphere: boolean, spacingKm: number, width: number, height: number, nodes: Int32Array, nodeW: number, nodeH: number, land: Uint8Array, biome: Uint8Array, koppen: Uint8Array, z: Float32Array, lakeDepth: Float32Array, ecology: Uint8Array, present: number, riverPoints?: Float32Array, riverLengths?: Uint32Array, riverRegimes?: Uint8Array, shelfCarrying?: Uint8Array) => T

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
  return new Build(input.kind === 'sphere', spacingKm, input.width, input.height, input.nodes, input.nodeW, input.nodeH, input.land, input.biome, input.koppen, input.z, input.lakeDepth, ecology, present, r ? Float32Array.from(r.points) : undefined, r ? Uint32Array.from(r.lengths) : undefined, r ? Uint8Array.from(r.regimes) : undefined, input.shelfCarrying ?? undefined)
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
