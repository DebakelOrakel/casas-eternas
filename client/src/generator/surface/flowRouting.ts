import type { Domain, DomainGrid } from '../core/domain'

// The raster's routing vocabulary, as the erosion engine's raster index
// (erosionEngineState.ts) and its bridge (erosionEngineBridge.ts) still use
// it: the D8 slot order, the routing's shape, the MFD edges, the world
// ocean. The raster ROUTING itself — the priority flood, the D8-LTD
// receivers and the MFD edges over a 2:1 raster, which turned a raw
// elevation raster into a river network for the hydrology — went in
// DEC-0036 phase 7b: the hydrology runs on the terrain mesh's flow
// substrate (flowSubstrate.ts, mesh/meshHydrology.ts). Its algorithm
// (Cordonnier et al. 2016, docs/decisions/plate-tectonics-simulation.md)
// lives on in the erosion engine's own routing (erosionEngine.ts), which
// the mesh's routing is.

// Fixed N,NE,E,SE,S,SW,W,NW order — the raster engine walks neighbours in
// this order, so a stored direction index means the same thing everywhere
// it's used.
export const D8_OFFSETS: ReadonlyArray<readonly [dx: number, dy: number]> = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
]

export interface FlowRouting {
  width: number
  height: number
  // The domain the raster covers, one cell per unit (its extent is
  // width × height), and the raster's grid over it.
  domain: Domain
  grid: DomainGrid
  // Depression-filled elevations — always >= raw everywhere. A cell whose
  // filled value differs from its raw value is (part of) a lake.
  filled: Float32Array
  // Downstream neighbor's cell index (single-flow, chosen by D8-LTD — the
  // engine's receiver scan), or -1 for an unrouted/terminal cell (only
  // possible if there were zero ocean seed cells).
  flowTarget: Int32Array
  // Multiple-flow-direction edges, used for drainage-area accumulation
  // (accumulation and incision deliberately use different routing — the
  // generator CLAUDE.md's "Routing differs by step").
  mfd: MfdEdges
  // Cells in the exact order the flood popped them — a valid topological
  // order for the flow graph (a cell is always popped before any
  // neighbor it floods, so flow only ever runs from a later-popped cell
  // into an earlier-popped one). Only the first poppedCount entries are
  // valid.
  popOrder: Int32Array
  poppedCount: number
}

// Mask of the largest 4-connected ≤ seaLevel component — the world ocean.
// Null when there is no water at all. O(n) flood fill; cheap next to the
// priority flood it seeds (the raster engine's).
export function largestWaterComponent(raw: Float32Array, grid: DomainGrid, seaLevel: number): Uint8Array | null {
  const width = grid.resX
  const n = width * grid.resY
  const label = new Int32Array(n).fill(-1)
  const sizes: number[] = []
  const stack: number[] = []
  for (let s = 0; s < n; s++) {
    if (raw[s] > seaLevel || label[s] !== -1) continue
    const id = sizes.length
    let size = 0
    stack.push(s)
    label[s] = id
    while (stack.length) {
      const i = stack.pop()!
      size++
      const y = (i / width) | 0
      const x = i - y * width
      // The four sides through the grid: on the sphere the side across a
      // pole is the far meridian's cell (a row table cannot say that). The
      // order of the four does not change the mask, only the walk.
      for (const nb of [grid.neighbour(x, y, 1, 0), grid.neighbour(x, y, -1, 0), grid.neighbour(x, y, 0, 1), grid.neighbour(x, y, 0, -1)]) {
        if (raw[nb] <= seaLevel && label[nb] === -1) {
          label[nb] = id
          stack.push(nb)
        }
      }
    }
    sizes.push(size)
  }
  if (sizes.length === 0) return null
  let best = 0
  for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[best]) best = i
  const mask = new Uint8Array(n)
  for (let i = 0; i < n; i++) if (label[i] === best) mask[i] = 1
  return mask
}

export interface MfdEdges {
  // CSR layout: cell i's outgoing (downhill) edges are
  // outEdgeDirections[outEdgeStart[i] .. outEdgeStart[i + 1]), each paired
  // with the weight at the same index in outEdgeWeights. A given cell's
  // own edge weights sum to 1, except cells with zero downhill neighbors
  // (deep ocean, or a genuine local minimum in `filled`), which have zero
  // edges and contribute nothing further downstream.
  outEdgeStart: Int32Array
  // An edge's target as a D8 DIRECTION INDEX into D8_OFFSETS, not as a cell
  // index — a target is always one of the eight neighbors, so it fits in a
  // byte, and the cell index is recovered with the same grid.neighbour call
  // that built it. Storing absolute Int32 indices
  // cost four bytes per edge for information three bits carry; at ~2.9
  // edges per cell that is ~9 bytes per cell of pure overhead, which on the
  // worldmap's amplified grids ran into hundreds of megabytes (measured
  // 2026-08-07: 97 MB of a routing's 327 MB at 4096², four times that at
  // 8192²). Bit-exact — the decoded target is the same index that used to
  // be stored.
  outEdgeDirections: Uint8Array
  outEdgeWeights: Float32Array
}
