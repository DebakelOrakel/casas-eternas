// Initial-migration core (see docs/decisions/anthropology-initial-migration.md):
// from user-placed origins (one per race), spread least-cost over a PHYSICAL
// movement-cost field (slope + depth-based water + coast/river corridors) via a
// multi-source Dijkstra, producing a predecessor tree + population-flow
// accumulation — the "migration arrow-tree". Coarse (climate grid); pure &
// headless-testable. Rendering + UI come later.

import { CLIMATE_RES_X, CLIMATE_RES_Y, sampleElevationAtCell } from '../climate/climateField'
import { OCEAN_PRECIP } from '../climate/precipitation'
import { MinHeap } from '../core/minHeap'
import { wrapValue } from '../core/field'
import { SEA_LEVEL, SLOPE_RECALIBRATION, metersToElevation } from '../elevation/elevationScale'

export interface MigrationOrigin {
  cell: number // gy * resX + gx (on the climate grid)
  race: number // 0..(raceCount-1)
}

export interface MigrationParams {
  // Cost budget N: cells beyond this cost-distance from any origin stay
  // unsettled (empty frontier — the "how far the migration got" knob).
  spreadBudget: number
  // 0..1: how far shallow seas are crossable (deeper max-passable water). 0 =
  // only land bridges cross; 1 = broad shallow shelves crossable.
  seaCrossing: number
}

export interface MigrationFields {
  resX: number
  resY: number
  cost: Float32Array // cost-distance from the nearest origin (Infinity = unreached)
  race: Int8Array // owning race per cell (-1 = unreached)
  predecessor: Int32Array // parent cell toward the origin (-1 = root/unreached)
  density: Float32Array // population per cell (carryingCapacity × frontier fill; 0 unreached)
  flow: Float32Array // population accumulated up the predecessor tree (arrow width)
}

// --- cost field -------------------------------------------------------------

const LAND_BASE = 1
// Scaled by SLOPE_RECALIBRATION (see elevationScale.ts) — the slope this
// multiplies halved, and mountains should stay as discouraging to cross as they
// were tuned to be.
const SLOPE_COST = 14 * SLOPE_RECALIBRATION // steep terrain penalty (× slope)
const CORRIDOR_DISCOUNT = 0.5 // coast/river cells are cheap highways
const RIVER_DISCHARGE_FRAC = 0.05 // discharge above this fraction of max = a river corridor
const WATER_BASE = 3 // shallow water is costlier than land to cross
// Depth thresholds, restated in metres now that the elevation scale is anchored
// (elevationScale.ts). The old bare 0.25 would read as 2250 m of open ocean
// "still passable at seaCrossing = 1" — never the intent; on the old scale, where
// ocean ran -0.45 to -1.0, a quarter unit was a shallow fringe. 600 m is the real
// limit of the water proto-humans crossed: the shelf and the straits over it, not
// the deep basins.
//
// This constraint only starts to MEAN anything now. Before, there was no shelf —
// the coast dropped from continent to abyssal plain within a few cells — so at
// the coarse climate grid these fields run on, shallow water barely existed as a
// sampleable thing, and island hopping was near-impossible whatever the slider
// said. With a real shelf there is finally passable water to cross.
const SEA_CROSSING_MAX_DEPTH = metersToElevation(600)
// Scaled with it, so the cost at the deepest crossable water stays what it was
// tuned to be.
const WATER_DEPTH_COST = 25 * (0.25 / SEA_CROSSING_MAX_DEPTH) // per unit depth below sea level

// Builds the per-cell movement cost (cost to ENTER the cell). Land: base × slope,
// discounted on coast/river corridors. Water: rises with depth; beyond the
// sea-crossing max depth it's Infinity (a hard barrier). Land bridges are just
// land, so they're always passable regardless of seaCrossing.
function buildCostField(precipitation: Float32Array, elevation: Float32Array, coarseDischarge: Float32Array | null, maxDischarge: number, seaCrossing: number, worldWidth: number, worldHeight: number): { cost: Float32Array; land: Uint8Array } {
  const n = CLIMATE_RES_X * CLIMATE_RES_Y
  const cost = new Float32Array(n)
  const land = new Uint8Array(n)
  const maxDepth = SEA_CROSSING_MAX_DEPTH * Math.max(0, Math.min(1, seaCrossing))
  for (let gy = 0; gy < CLIMATE_RES_Y; gy++) {
    for (let gx = 0; gx < CLIMATE_RES_X; gx++) {
      const i = gy * CLIMATE_RES_X + gx
      const isLand = precipitation[i] !== OCEAN_PRECIP
      const e = sampleElevationAtCell(elevation, gx, gy, worldWidth, worldHeight)
      if (!isLand) {
        const depth = SEA_LEVEL - e
        cost[i] = depth <= maxDepth ? WATER_BASE + WATER_DEPTH_COST * Math.max(0, depth) : Infinity
        continue
      }
      land[i] = 1
      const eE = sampleElevationAtCell(elevation, wrapValue(gx + 1, CLIMATE_RES_X), gy, worldWidth, worldHeight)
      const eS = sampleElevationAtCell(elevation, gx, wrapValue(gy + 1, CLIMATE_RES_Y), worldWidth, worldHeight)
      const slope = Math.hypot(eE - e, eS - e)
      let c = LAND_BASE + SLOPE_COST * slope
      // Corridor discount: coastal (an ocean 4-neighbour) or a river cell.
      const coastal =
        precipitation[wrapValue(gy, CLIMATE_RES_Y) * CLIMATE_RES_X + wrapValue(gx + 1, CLIMATE_RES_X)] === OCEAN_PRECIP ||
        precipitation[wrapValue(gy, CLIMATE_RES_Y) * CLIMATE_RES_X + wrapValue(gx - 1, CLIMATE_RES_X)] === OCEAN_PRECIP ||
        precipitation[wrapValue(gy + 1, CLIMATE_RES_Y) * CLIMATE_RES_X + gx] === OCEAN_PRECIP ||
        precipitation[wrapValue(gy - 1, CLIMATE_RES_Y) * CLIMATE_RES_X + gx] === OCEAN_PRECIP
      const river = coarseDischarge != null && maxDischarge > 0 && coarseDischarge[i] > RIVER_DISCHARGE_FRAC * maxDischarge
      if (coastal || river) c *= CORRIDOR_DISCOUNT
      cost[i] = c
    }
  }
  return { cost, land }
}

// 8-neighbour offsets (with movement distance for the diagonals).
const NEIGHBOURS = [
  { dx: 1, dy: 0, d: 1 }, { dx: -1, dy: 0, d: 1 }, { dx: 0, dy: 1, d: 1 }, { dx: 0, dy: -1, d: 1 },
  { dx: 1, dy: 1, d: Math.SQRT2 }, { dx: 1, dy: -1, d: Math.SQRT2 }, { dx: -1, dy: 1, d: Math.SQRT2 }, { dx: -1, dy: -1, d: Math.SQRT2 },
]

// --- entry point ------------------------------------------------------------

export function computeMigration(
  carryingCapacity: Float32Array,
  precipitation: Float32Array,
  elevation: Float32Array,
  coarseDischarge: Float32Array | null,
  maxDischarge: number,
  origins: MigrationOrigin[],
  worldWidth: number,
  worldHeight: number,
  params: MigrationParams,
): MigrationFields {
  const rx = CLIMATE_RES_X
  const ry = CLIMATE_RES_Y
  const n = rx * ry
  const budget = params.spreadBudget
  const { cost: cellCost } = buildCostField(precipitation, elevation, coarseDischarge, maxDischarge, params.seaCrossing, worldWidth, worldHeight)

  const cost = new Float32Array(n).fill(Infinity)
  const race = new Int8Array(n).fill(-1)
  const predecessor = new Int32Array(n).fill(-1)
  const settled = new Uint8Array(n)

  // Multi-source Dijkstra: every enabled origin seeded at cost 0.
  const heap = new MinHeap(n)
  for (const o of origins) {
    if (o.cell < 0 || o.cell >= n || cellCost[o.cell] === Infinity) continue
    if (cost[o.cell] === 0) continue
    cost[o.cell] = 0
    race[o.cell] = o.race
    predecessor[o.cell] = -1
    heap.push(0, o.cell)
  }
  while (heap.length > 0) {
    heap.pop()
    const c = heap.poppedKey
    const cell = heap.poppedIndex
    if (settled[cell]) continue
    settled[cell] = 1
    if (c > budget) continue // reached but don't expand past the budget frontier
    const gy = Math.floor(cell / rx)
    const gx = cell - gy * rx
    for (const nb of NEIGHBOURS) {
      const nx = wrapValue(gx + nb.dx, rx)
      const ny = wrapValue(gy + nb.dy, ry)
      const ni = ny * rx + nx
      if (settled[ni]) continue
      const step = cellCost[ni]
      if (step === Infinity) continue
      const nc = c + step * nb.d
      if (nc < cost[ni]) {
        cost[ni] = nc
        race[ni] = race[cell]
        predecessor[ni] = cell
        heap.push(nc, ni)
      }
    }
  }

  // Frontier-gradient density: carryingCapacity × fillFraction (full at the
  // origin, thin at the front); unsettled → 0.
  const density = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    if (race[i] < 0) continue
    if (cost[i] > budget) { race[i] = -1; predecessor[i] = -1; continue } // beyond the frontier = unsettled
    const fill = budget > 0 ? Math.max(0, Math.min(1, (budget - cost[i]) / budget)) : 1
    const cap = carryingCapacity[i]
    density[i] = (cap > 0 ? cap : 0) * fill
  }

  // Population flow up the predecessor tree (leaf→root): process reached cells by
  // DECREASING cost, adding each cell's flow to its parent — trunk = whole
  // subtree's population (the arrow width). Like discharge accumulation.
  const flow = Float32Array.from(density)
  const reached: number[] = []
  for (let i = 0; i < n; i++) if (race[i] >= 0 && cost[i] <= budget) reached.push(i)
  reached.sort((a, b) => cost[b] - cost[a])
  for (const cell of reached) {
    const p = predecessor[cell]
    if (p >= 0) flow[p] += flow[cell]
  }

  return { resX: rx, resY: ry, cost, race, predecessor, density, flow }
}
