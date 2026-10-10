import { SEA_LEVEL, elevationToMeters } from '../elevation/elevationScale'
import { torusDomain, type Domain, type DomainGrid } from '../core/domain'
import { SURFACE_TUNING } from './surfaceTuneParams'
import { rasterCellAt, type RiverGraph } from './riverGraph'
import { detHypot } from '../core/detMath'

// THE COAST AS A FEATURE (ADAPTIVE_MESH_PLAN.md F5, docs/design/coast.md
// "Forerunner"): the shoreline cut into REACHES with attributes like a
// river's, and a coast TYPE per reach from them — a classification with no
// process behind it yet. The picture first, the physics after: wave
// erosion, the one-line sediment transport and the shore generator are the
// coast process of phase 7 and run on exactly these reaches.
//
// A coast cell is a land cell with a sea cell (elevation ≤ SEA_LEVEL) among
// its eight neighbours — the renderer's own shore rule, so the data and
// the drawing agree. Reaches are walks along the coast, cut at river mouths
// and every `coastReachCells` cells. Per cell:
//
//   exposure  wave energy from the wind: speed² × fetch, the fetch being
//             the open water UPWIND of the cell (the direction the waves
//             come from) up to `coastFetchCapKm`, normalised to the
//             world's 90th-percentile coast and clamped, so it is
//             relative (0..1; the top tenth reads 1). Measured 2026-09-22
//             on golden alpha against the maximum instead: the median
//             coast read 0.01 and nine of ten reaches came out rocky —
//             a few storm coasts set the scale for all.
//   relief    the highest land within one cell, metres above the sea: a
//             steep coast is what waves can cut a cliff into.
//   hardness  the erodibility K factor (1 neutral, below 1 hard) from the
//             erosion forcing's field.
//   supply    river sediment reaching the cell: every sea mouth's load
//             spread over `coastSupplyReachKm`, relative to the world's
//             90th-percentile fed coast like the exposure.
//
// From those the type, in this order (the first rule that fits): DELTA
// within two cells of a mouth whose course is one; MARSH where the water is
// calm, the land flat and river sediment arrives; CLIFF where the coast is
// steep and exposed and the rock not soft; BEACH where sediment arrives or
// the waves work a low coast; ROCKY for the sheltered, unfed, hard rest.
// A reach takes the type most of its cells have.
export type CoastType = 'rocky' | 'cliff' | 'beach' | 'marsh' | 'delta'

// The type as the rasters and the shader carry it, one byte per cell
// (0 = not a coast cell).
export const COAST_TYPE_CODE: Record<CoastType, number> = { rocky: 1, cliff: 2, beach: 3, marsh: 4, delta: 5 }
const CODE_TYPE: CoastType[] = ['rocky', 'rocky', 'cliff', 'beach', 'marsh', 'delta']

export interface CoastReach {
  id: number
  // The reach's coast cells in walk order (CoastGraph.cells).
  cellStart: number
  cellCount: number
  lengthKm: number
  // Means over the cells (exposure, relief m, hardness) and the summed
  // relative supply.
  exposure: number
  reliefM: number
  hardness: number
  supply: number
  type: CoastType
  // The river reach that ends on this coast reach, -1 for none.
  mouthReach: number
}

export interface CoastGraph {
  width: number
  height: number
  reaches: CoastReach[]
  cells: Int32Array
  // The type per cell (COAST_TYPE_CODE), 0 off the coast.
  type: Uint8Array
}

export interface CoastGraphInputs {
  elevation: Float32Array
  width: number
  height: number
  // The world's topology; the raster above is its grid, one cell per
  // world unit, so a cell's (x, y) is a world point.
  domain: Domain
  // The climate grid's wind, interleaved [u, v] (climate/wind.ts).
  wind: Float32Array
  climateResX: number
  climateResY: number
  // The erodibility K factor on the climate grid, or absent (neutral).
  hardness?: Float32Array
  graph: RiverGraph | null
  cellM: number
}

const D8: [number, number][] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]

// Scale a per-cell value over the coast cells so its 90th percentile is 1,
// clamped at 1; all zero stays all zero.
function normaliseToP90(field: Float32Array, coast: Uint8Array): void {
  const values: number[] = []
  for (let c = 0; c < field.length; c++) if (coast[c] && field[c] > 0) values.push(field[c])
  if (values.length === 0) return
  values.sort((a, b) => a - b)
  const p90 = values[Math.min(values.length - 1, Math.floor(0.9 * values.length))]
  if (p90 <= 0) return
  for (let c = 0; c < field.length; c++) {
    if (!coast[c]) continue
    const v = field[c] / p90
    field[c] = v > 1 ? 1 : v
  }
}

// The nearest coast cell to `cell` within `radius` cells (rings outward,
// the first hit), or `cell` itself when none is.
function nearestCoastCell(coast: Uint8Array, cell: number, grid: DomainGrid, radius: number): number {
  const width = grid.resX
  const cx = cell % width
  const cy = (cell - cx) / width
  for (let r = 1; r <= radius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
        const c = grid.index(cx + dx, cy + dy)
        if (coast[c]) return c
      }
    }
  }
  return cell
}

export function buildCoastGraph(input: CoastGraphInputs): CoastGraph {
  const { elevation, width, height, domain, wind, climateResX, climateResY, hardness, graph, cellM } = input
  const n = width * height
  const cellKm = cellM / 1000
  const isSea = (c: number): boolean => elevation[c] <= SEA_LEVEL
  const grid = domain.grid(width, height)
  const at = (x: number, y: number): number => grid.index(x, y)

  // Coast cells.
  const coast = new Uint8Array(n)
  let coastCount = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = y * width + x
      if (isSea(c)) continue
      for (const [dx, dy] of D8) {
        if (isSea(at(x + dx, y + dy))) { coast[c] = 1; coastCount++; break }
      }
    }
  }

  // Mouths: the last land cell of every river reach that ends in the sea.
  const mouthAt = new Int32Array(n).fill(-1)
  const deltaAt = new Uint8Array(n)
  if (graph) {
    const courseOf = new Map<number, boolean>()
    for (const c of graph.courses ?? []) courseOf.set(c.reach, c.lobeAges.length > 0)
    for (const r of graph.reaches) {
      const node = graph.nodes[r.to]
      // Graph places as raster cells: the graph may be the mesh's
      // (phase 4.3), so its ids are read through their positions.
      if (node.kind !== 'mouth' || !isSea(rasterCellAt(node.x, node.y, grid))) continue
      const k = r.cellStart + r.cellCount - 2
      let last = k >= r.cellStart ? rasterCellAt(graph.cellX[k], graph.cellY[k], grid) : undefined
      // A mesh reach's last land node need not sit ON a raster coast cell
      // (its nodes stand kilometres apart): the nearest coast cell within
      // three cells is the mouth's.
      if (last !== undefined && !coast[last]) last = nearestCoastCell(coast, last, grid, 3)
      if (last === undefined || !coast[last]) continue
      if (mouthAt[last] < 0 || graph.reaches[mouthAt[last]].dischargeOut < r.dischargeOut) mouthAt[last] = r.id
      if (courseOf.get(r.id)) deltaAt[last] = 1
    }
  }

  // Per-cell attributes.
  const exposure = new Float32Array(n)
  const relief = new Float32Array(n)
  const hard = new Float32Array(n)
  const supply = new Float32Array(n)
  const fetchCap = Math.max(1, Math.round((SURFACE_TUNING.coastFetchCapKm * 1000) / cellM))
  const march = { x: 0, y: 0 }
  const moved = { x: 0, y: 0 }
  let maxExposure = 0
  for (let c = 0; c < n; c++) {
    if (!coast[c]) continue
    const x = c % width
    const y = (c - x) / width
    const gx = Math.min(climateResX - 1, Math.floor((x / width) * climateResX))
    const gy = Math.min(climateResY - 1, Math.floor((y / height) * climateResY))
    const gi = gy * climateResX + gx
    const u = wind[gi * 2]
    const v = wind[gi * 2 + 1]
    const speed = detHypot(u, v)
    if (speed > 1e-6) {
      // March upwind over the sea, one cell per step: on the sphere along
      // the great circle, the direction carried along with the point
      // (Domain.displace, transport — on the torus the sum by hand and the
      // same direction, as before; step 4e).
      march.x = -u / speed
      march.y = -v / speed
      let fetch = 0
      let px = x + 0.5
      let py = y + 0.5
      for (let k = 0; k < fetchCap; k++) {
        domain.displace(px, py, march.x, march.y, moved)
        domain.transport(march.x, march.y, px, py, moved.x, moved.y, march)
        px = moved.x
        py = moved.y
        if (!isSea(at(Math.floor(px), Math.floor(py)))) break
        fetch++
      }
      exposure[c] = speed * speed * (fetch / fetchCap)
      if (exposure[c] > maxExposure) maxExposure = exposure[c]
    }
    let top = elevation[c]
    for (const [dx, dy] of D8) {
      const nb = at(x + dx, y + dy)
      if (!isSea(nb) && elevation[nb] > top) top = elevation[nb]
    }
    relief[c] = elevationToMeters(top - SEA_LEVEL)
    hard[c] = hardness ? hardness[gi] : 1
  }
  void maxExposure
  normaliseToP90(exposure, coast)

  // Sediment supply from the sea mouths, spread along the coast.
  const reachCells = (SURFACE_TUNING.coastSupplyReachKm * 1000) / cellM
  const mouths: { x: number; y: number; load: number }[] = []
  if (graph) {
    for (let c = 0; c < n; c++) {
      if (mouthAt[c] < 0) continue
      const r = graph.reaches[mouthAt[c]]
      const load = r.sedimentM3 > 0 ? r.sedimentM3 : 0
      if (load > 0) mouths.push({ x: c % width, y: Math.floor(c / width), load })
    }
  }
  let maxSupply = 0
  if (mouths.length > 0) {
    const r2 = reachCells * reachCells
    for (let c = 0; c < n; c++) {
      if (!coast[c]) continue
      const x = c % width
      const y = (c - x) / width
      let s = 0
      for (const m of mouths) {
        // Between the cells' centres: on the sphere a row's index is not
        // its colatitude (row 0's would be the pole). On the torus the same
        // offsets.
        const d2 = domain.distanceSq(x + 0.5, y + 0.5, m.x + 0.5, m.y + 0.5)
        if (d2 > r2) continue
        s += m.load * (1 - Math.sqrt(d2) / reachCells)
      }
      supply[c] = s
      if (s > maxSupply) maxSupply = s
    }
    void maxSupply
    normaliseToP90(supply, coast)
  }

  // The type per cell.
  const type = new Uint8Array(n)
  // Two cells each way, east-west as many of a row's cells as span two
  // equator cells (the sphere's narrow rows; 2 on the torus).
  const deltaReach = new Int32Array(height)
  for (let y = 0; y < height; y++) deltaReach[y] = Math.min(width >> 1, Math.max(2, Math.round(2 / grid.rowScale(y))))
  const nearDelta = (c: number): boolean => {
    const x = c % width
    const y = (c - x) / width
    const rx = deltaReach[y]
    for (let dy = -2; dy <= 2; dy++) for (let dx = -rx; dx <= rx; dx++) if (deltaAt[at(x + dx, y + dy)]) return true
    return false
  }
  for (let c = 0; c < n; c++) {
    if (!coast[c]) continue
    let t: CoastType
    if (nearDelta(c)) t = 'delta'
    else if (exposure[c] < SURFACE_TUNING.coastCalmExposure && relief[c] < SURFACE_TUNING.coastMarshReliefM && supply[c] >= SURFACE_TUNING.coastMarshSupply) t = 'marsh'
    else if (relief[c] >= SURFACE_TUNING.coastCliffReliefM && exposure[c] >= SURFACE_TUNING.coastCliffExposure && hard[c] <= SURFACE_TUNING.coastCliffMaxK) t = 'cliff'
    else if (supply[c] >= SURFACE_TUNING.coastBeachSupply || (exposure[c] >= SURFACE_TUNING.coastCliffExposure && relief[c] < SURFACE_TUNING.coastCliffReliefM)) t = 'beach'
    else t = 'rocky'
    type[c] = COAST_TYPE_CODE[t]
  }

  // Reaches: walks along the coast. Start at cells with one coast
  // neighbour (the ends of a stretch) first, then anywhere unvisited; step
  // to an unvisited coast neighbour, 4-neighbours before diagonals; cut at
  // a mouth and at the length cap.
  const visited = new Uint8Array(n)
  const cells: number[] = []
  const reaches: CoastReach[] = []
  const coastDegree = (c: number): number => {
    const x = c % width
    const y = (c - x) / width
    let d = 0
    for (const [dx, dy] of D8) if (coast[at(x + dx, y + dy)]) d++
    return d
  }
  const nextOf = (c: number): number => {
    const x = c % width
    const y = (c - x) / width
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]] as const) {
      const nb = at(x + dx, y + dy)
      if (coast[nb] && !visited[nb]) return nb
    }
    return -1
  }
  const closeReach = (start: number, mouthReach: number): void => {
    const count = cells.length - start
    if (count === 0) return
    let ex = 0, rl = 0, hd = 0, sp = 0
    const votes = new Int32Array(6)
    let km = 0
    for (let k = start; k < cells.length; k++) {
      const c = cells[k]
      ex += exposure[c]; rl += relief[c]; hd += hard[c]; sp += supply[c]
      votes[type[c]]++
      if (k > start) {
        // The step between the two cells' centres: 1 or √2 cells on the
        // torus (sqrt of 1 or 2, Math.SQRT2's bits), the arc on the sphere.
        const a = cells[k - 1]
        const ax = a % width
        const cx = c % width
        km += cellKm * Math.sqrt(domain.distanceSq(cx + 0.5, (c - cx) / width + 0.5, ax + 0.5, (a - ax) / width + 0.5))
      }
    }
    let best = 1
    for (let t = 1; t < 6; t++) if (votes[t] > votes[best]) best = t
    reaches.push({
      id: reaches.length, cellStart: start, cellCount: count, lengthKm: km,
      exposure: ex / count, reliefM: rl / count, hardness: hd / count, supply: sp,
      type: CODE_TYPE[best], mouthReach,
    })
  }
  const walkFrom = (start: number): void => {
    let c = start
    let reachStart = cells.length
    while (c >= 0) {
      visited[c] = 1
      cells.push(c)
      const atMouth = mouthAt[c] >= 0
      if (atMouth || cells.length - reachStart >= SURFACE_TUNING.coastReachCells) {
        closeReach(reachStart, atMouth ? mouthAt[c] : -1)
        reachStart = cells.length
      }
      c = nextOf(c)
    }
    closeReach(reachStart, -1)
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let c = 0; c < n; c++) {
      if (!coast[c] || visited[c]) continue
      if (pass === 0 && coastDegree(c) !== 1) continue
      walkFrom(c)
    }
  }
  void coastCount
  return { width, height, reaches, cells: Int32Array.from(cells), type }
}

// The invariants of a coast graph, as riverGraphInvariants: check name →
// violations.
// `grid`: the coast's raster over its domain (the torus's when not given,
// as the graph was checked before the sphere).
export function coastGraphInvariants(coast: CoastGraph, elevation: Float32Array, grid: DomainGrid = torusDomain(coast.width, coast.height).grid(coast.width, coast.height)): Record<string, number> {
  const out: Record<string, number> = { cellsOnCoast: 0, cellsOnce: 0, typeKnown: 0, reachesContiguous: 0 }
  const seen = new Uint8Array(coast.width * coast.height)
  for (const r of coast.reaches) {
    if (!(r.type in COAST_TYPE_CODE)) out.typeKnown++
    for (let k = 0; k < r.cellCount; k++) {
      const c = coast.cells[r.cellStart + k]
      if (elevation[c] <= SEA_LEVEL || coast.type[c] === 0) out.cellsOnCoast++
      if (seen[c]) out.cellsOnce++
      seen[c] = 1
      if (k > 0) {
        // One of the previous cell's eight neighbours, through the grid (on
        // the sphere across a pole too).
        const a = coast.cells[r.cellStart + k - 1]
        const ax = a % coast.width
        const ay = (a - ax) / coast.width
        let adjacent = false
        for (const [dx, dy] of D8) if (grid.neighbour(ax, ay, dx, dy) === c) adjacent = true
        if (!adjacent) out.reachesContiguous++
      }
    }
  }
  return out
}
