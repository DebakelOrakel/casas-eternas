// Initial-migration core (see docs/decisions/anthropology-initial-migration.md):
// from user-placed origins (one per race), spread least-cost over a PHYSICAL
// movement-cost field (slope + depth-based water + coast/river corridors) via a
// multi-source Dijkstra, producing a predecessor tree + population-flow
// accumulation — the "migration arrow-tree". Coarse (climate grid); pure &
// headless-testable. Rendering + UI come later.

import { CLIMATE_RES_X, CLIMATE_RES_Y, sampleElevationAtCell } from '../climate/climateField'
import { OCEAN_PRECIP } from '../climate/precipitation'
import { SEA_LEVEL } from '../erosion'

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
const SLOPE_COST = 14 // steep terrain penalty (× slope)
const CORRIDOR_DISCOUNT = 0.5 // coast/river cells are cheap highways
const RIVER_DISCHARGE_FRAC = 0.05 // discharge above this fraction of max = a river corridor
const WATER_BASE = 3 // shallow water is costlier than land to cross
const WATER_DEPTH_COST = 25 // per unit depth below sea level
const SEA_CROSSING_MAX_DEPTH = 0.25 // at seaCrossing=1, water this deep is still passable

// Builds the per-cell movement cost (cost to ENTER the cell). Land: base × slope,
// discounted on coast/river corridors. Water: rises with depth; beyond the
// sea-crossing max depth it's Infinity (a hard barrier). Land bridges are just
// land, so they're always passable regardless of seaCrossing.
function buildCostField(precipitation: Float32Array, elevation: Float32Array, coarseDischarge: Float32Array | null, maxDischarge: number, seaCrossing: number, worldWidth: number, worldHeight: number): { cost: Float32Array; land: Uint8Array } {
  const n = CLIMATE_RES_X * CLIMATE_RES_Y
  const cost = new Float32Array(n)
  const land = new Uint8Array(n)
  const maxDepth = SEA_CROSSING_MAX_DEPTH * Math.max(0, Math.min(1, seaCrossing))
  const wrap = (i: number, m: number): number => ((i % m) + m) % m
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
      const eE = sampleElevationAtCell(elevation, wrap(gx + 1, CLIMATE_RES_X), gy, worldWidth, worldHeight)
      const eS = sampleElevationAtCell(elevation, gx, wrap(gy + 1, CLIMATE_RES_Y), worldWidth, worldHeight)
      const slope = Math.hypot(eE - e, eS - e)
      let c = LAND_BASE + SLOPE_COST * slope
      // Corridor discount: coastal (an ocean 4-neighbour) or a river cell.
      const coastal =
        precipitation[wrap(gy, CLIMATE_RES_Y) * CLIMATE_RES_X + wrap(gx + 1, CLIMATE_RES_X)] === OCEAN_PRECIP ||
        precipitation[wrap(gy, CLIMATE_RES_Y) * CLIMATE_RES_X + wrap(gx - 1, CLIMATE_RES_X)] === OCEAN_PRECIP ||
        precipitation[wrap(gy + 1, CLIMATE_RES_Y) * CLIMATE_RES_X + gx] === OCEAN_PRECIP ||
        precipitation[wrap(gy - 1, CLIMATE_RES_Y) * CLIMATE_RES_X + gx] === OCEAN_PRECIP
      const river = coarseDischarge != null && maxDischarge > 0 && coarseDischarge[i] > RIVER_DISCHARGE_FRAC * maxDischarge
      if (coastal || river) c *= CORRIDOR_DISCOUNT
      cost[i] = c
    }
  }
  return { cost, land }
}

// --- min-heap for Dijkstra --------------------------------------------------

class MinHeap {
  private costs: number[] = []
  private cells: number[] = []
  get size(): number { return this.cells.length }
  push(cost: number, cell: number): void {
    this.costs.push(cost)
    this.cells.push(cell)
    let i = this.cells.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.costs[p] <= this.costs[i]) break
      this.swap(i, p)
      i = p
    }
  }
  pop(): { cost: number; cell: number } {
    const cost = this.costs[0]
    const cell = this.cells[0]
    const lastC = this.costs.pop()!
    const lastCell = this.cells.pop()!
    if (this.cells.length > 0) {
      this.costs[0] = lastC
      this.cells[0] = lastCell
      let i = 0
      const nn = this.cells.length
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let s = i
        if (l < nn && this.costs[l] < this.costs[s]) s = l
        if (r < nn && this.costs[r] < this.costs[s]) s = r
        if (s === i) break
        this.swap(i, s)
        i = s
      }
    }
    return { cost, cell }
  }
  private swap(a: number, b: number): void {
    const c = this.costs[a]; this.costs[a] = this.costs[b]; this.costs[b] = c
    const e = this.cells[a]; this.cells[a] = this.cells[b]; this.cells[b] = e
  }
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
  const wrap = (i: number, m: number): number => ((i % m) + m) % m

  // Multi-source Dijkstra: every enabled origin seeded at cost 0.
  const heap = new MinHeap()
  for (const o of origins) {
    if (o.cell < 0 || o.cell >= n || cellCost[o.cell] === Infinity) continue
    if (cost[o.cell] === 0) continue
    cost[o.cell] = 0
    race[o.cell] = o.race
    predecessor[o.cell] = -1
    heap.push(0, o.cell)
  }
  while (heap.size > 0) {
    const { cost: c, cell } = heap.pop()
    if (settled[cell]) continue
    settled[cell] = 1
    if (c > budget) continue // reached but don't expand past the budget frontier
    const gy = Math.floor(cell / rx)
    const gx = cell - gy * rx
    for (const nb of NEIGHBOURS) {
      const nx = wrap(gx + nb.dx, rx)
      const ny = wrap(gy + nb.dy, ry)
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
