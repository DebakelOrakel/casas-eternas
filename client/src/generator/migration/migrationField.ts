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
import { SEA_LEVEL } from '../elevation/elevationScale'
import { MIGRATION_TUNING } from './migrationTuneParams'
import { detHypot } from '../core/detMath'

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
//
// Tuning constants come from MIGRATION_TUNING and are read straight off it, so
// each one has exactly one name and adding another is a single edit.

// Builds the per-cell movement cost (cost to ENTER the cell). Land: base × slope,
// discounted on coast/river corridors. Water: rises with depth; beyond the
// sea-crossing max depth it's Infinity (a hard barrier). Land bridges are just
// land, so they're always passable regardless of seaCrossing.
function buildCostField(precipitation: Float32Array, elevation: Float32Array, coarseDischarge: Float32Array | null, maxDischarge: number, seaCrossing: number, worldWidth: number, worldHeight: number): Float32Array {
  const n = CLIMATE_RES_X * CLIMATE_RES_Y
  const cost = new Float32Array(n)
  const maxDepth = MIGRATION_TUNING.seaCrossingMaxDepth * Math.max(0, Math.min(1, seaCrossing))
  for (let gy = 0; gy < CLIMATE_RES_Y; gy++) {
    for (let gx = 0; gx < CLIMATE_RES_X; gx++) {
      const i = gy * CLIMATE_RES_X + gx
      const isLand = precipitation[i] !== OCEAN_PRECIP
      const e = sampleElevationAtCell(elevation, gx, gy, worldWidth, worldHeight)
      if (!isLand) {
        const depth = SEA_LEVEL - e
        cost[i] = depth <= maxDepth ? MIGRATION_TUNING.waterBase + MIGRATION_TUNING.waterDepthCost * Math.max(0, depth) : Infinity
        continue
      }
      const eE = sampleElevationAtCell(elevation, wrapValue(gx + 1, CLIMATE_RES_X), gy, worldWidth, worldHeight)
      const eS = sampleElevationAtCell(elevation, gx, wrapValue(gy + 1, CLIMATE_RES_Y), worldWidth, worldHeight)
      const slope = detHypot(eE - e, eS - e)
      let c = MIGRATION_TUNING.landBase + MIGRATION_TUNING.slopeCost * slope
      // Corridor discount: coastal (an ocean 4-neighbour) or a river cell.
      const coastal =
        precipitation[wrapValue(gy, CLIMATE_RES_Y) * CLIMATE_RES_X + wrapValue(gx + 1, CLIMATE_RES_X)] === OCEAN_PRECIP ||
        precipitation[wrapValue(gy, CLIMATE_RES_Y) * CLIMATE_RES_X + wrapValue(gx - 1, CLIMATE_RES_X)] === OCEAN_PRECIP ||
        precipitation[wrapValue(gy + 1, CLIMATE_RES_Y) * CLIMATE_RES_X + gx] === OCEAN_PRECIP ||
        precipitation[wrapValue(gy - 1, CLIMATE_RES_Y) * CLIMATE_RES_X + gx] === OCEAN_PRECIP
      const river = coarseDischarge != null && maxDischarge > 0 && coarseDischarge[i] > MIGRATION_TUNING.riverDischargeFrac * maxDischarge
      if (coastal || river) c *= MIGRATION_TUNING.corridorDiscount
      cost[i] = c
    }
  }
  return cost
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
  const cellCost = buildCostField(precipitation, elevation, coarseDischarge, maxDischarge, params.seaCrossing, worldWidth, worldHeight)

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
