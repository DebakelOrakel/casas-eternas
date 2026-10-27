import type { EcologyFieldId } from '../../generator/ecology/ecologyField'
import type { RiverPolylines } from '../../generator/surface/hydrology'
import type { LogEvent } from './historyLogShared'
import type { AnimalUse } from './animals'
import type { PlantUse } from './plants'
import type { WoodUse } from './trees'

// WHAT THE INCUBATOR'S WORKER AND ITS SCREEN SHARE (2026-10-27): the cells'
// input, the layers the flora and the fauna grow, the people's spread, the
// settlement — the shapes of the worker's answers, which casas-incubator
// computes (docs/decisions/incubator-history-engine.md). Its own module for
// the reason peopleShared.ts gives.

// The ecology's fields the habitat carries besides the game and the
// carrying capacity (casas-incubator habitat.rs CELL_ECOLOGY).
export const LEVEL_ECOLOGY: readonly EcologyFieldId[] = ['arable', 'pasture', 'fish', 'toolStone', 'salt', 'copper']

// What the cells are made from (casas-incubator habitat.rs CellInput).
export interface CellInput {
  kind: 'sphere' | 'torus'
  // The world raster's size, the domain's.
  width: number
  height: number
  // The level's node under each texel, `nodeW` × `nodeH` over the chart.
  nodes: Int32Array
  nodeW: number
  nodeH: number
  // Per node: the level's land, biome, Köppen class, height (elevation
  // units), lakes' depth, and the ecology's fields as their fine codes.
  land: Uint8Array
  biome: Uint8Array
  koppen: Uint8Array
  z: Float32Array
  lakeDepth: Float32Array
  ecology: Partial<Record<EcologyFieldId, Uint8Array>>
  // The level's rivers, in the world raster's texels.
  rivers: Pick<RiverPolylines, 'points' | 'lengths' | 'regimes'> | null
}

// A plant's, a tree's, an animal's layer: one code a cell (0 nothing, 1
// suitable but not reached, 2 … 255 in the range), and its shares of the
// land (suitable, reached, suitable and not reached).
interface Layer {
  id: string
  codes: Uint8Array
  suitable: number
  reached: number
  empty: number
}
export interface PlantLayer extends Layer {
  use: PlantUse
  domesticable: boolean
}
export interface TreeLayer extends Layer {
  woods: readonly WoodUse[]
}
export interface AnimalLayer extends Layer {
  uses: readonly AnimalUse[]
}

// The people's spread over the cells.
export interface PeopleResult {
  // Years from the departure to the arrival, the sea's cells crossed too;
  // Infinity where people never came.
  arrival: Float32Array
  // 1 on the land: where people settle.
  land: Uint8Array
  // The routes' tree: the cell each was reached from, -1 at the origin and
  // where none came; how many land cells were reached through each.
  from: Int32Array
  flow: Float32Array
  origin: number
  // [landmass, cell, time, km] each crossing made: the landmass and the
  // cell landed on, when, and the open water's widest stretch on the way.
  crossings: Float32Array
  // Each crossing's way, in the same order, each ended by -1.
  crossingWays: Int32Array
}

// The settlement: the history's times and its villages, and what the
// settlement adds of them.
export interface SettleResult {
  // The end state's largest lifeway and density.
  lifeway: Uint8Array
  density: Float32Array
  // The times the lifeways follow (settleShared.ts), the arrival aside.
  farmAt: Float32Array
  herdAt: Float32Array
  fishOk: Uint8Array
  farmSuit: Float32Array
  herdSuit: Float32Array
  fishSuit: Float32Array
  carrying: Float32Array
  // The people over the span, every POPULATION_STEP years.
  population: Float32Array
  // [cell, time, lifeway] a centre of the farming or of the herding.
  centres: Float32Array
  // What a centre tamed, when, and when its wave came to each cell, in
  // CAME_STEP years (CAME_NEVER where it never did).
  domestications: { kind: 'plant' | 'animal'; id: string; cell: number; at: number; came: Uint16Array }[]
  // [cell, lifeway] a village — or a camp, where the lifeway is the
  // foragers' or the herders' — when it began and when it was left
  // (Infinity: never).
  villages: Int32Array
  villageFrom: Float32Array
  villageTo: Float32Array
  // [cell, good index] a source; [village a, village b, weight] a link.
  sources: Int32Array
  links: Float32Array
  // Where a species of the big game died out: on a landmass, when, at a
  // cell of it.
  extinctions: { id: string; landmass: number; areaKm2: number; at: number; cell: number }[]
  // The history's log (historyLogShared.ts) with the first trade.
  log: LogEvent[]
  // Each cell's landmass, -1 at sea.
  landmass: Int32Array
}

// The people's count every POPULATION_STEP years (casas-incubator).
export const POPULATION_STEP = 500
