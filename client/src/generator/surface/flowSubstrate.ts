import { wrapValue } from '../core/field'
import type { FlowRouting } from './flowRouting'

// THE FLOW SUBSTRATE (ADAPTIVE_MESH_PLAN.md phase 4.3): what the hydrology
// and the river graph read of the thing water flows over — a set of
// ELEMENTS (raster cells, or the mesh's nodes) with a receiver each, the
// flood's filled height and pop order, a position, an area and two
// neighbourhoods. Everything the hydrology computes — discharge, lakes,
// the channel criterion, the regime, the feature graph — is written over
// this once and runs on both: the raster (`rasterSubstrate`, the FlowRouting
// the bake and the raster consumers still produce) and the mesh
// (mesh/meshHydrology.ts). The raster wrapper reproduces the old per-cell
// arithmetic exactly — same neighbour order, same integer distances, area
// one — so the raster path stays bit-identical to what it was.
//
// Positions are TEXEL coordinates (world cells): `x`/`y` where an element
// is drawn (a cell's centre, +0.5; a node's own position), `px`/`py` where
// its climate is sampled (a cell's integer index — the convention the
// climate samplers were written in; a node's position again).
export interface FlowSubstrate {
  readonly kind: 'raster' | 'mesh'
  // The world's extent in cells, for seam tests and climate sampling.
  readonly width: number
  readonly height: number
  readonly count: number
  readonly filled: Float32Array
  readonly flowTarget: Int32Array
  readonly popOrder: Int32Array
  readonly poppedCount: number
  x(c: number): number
  y(c: number): number
  px(c: number): number
  py(c: number): number
  // The element's area in macro cells (1 on the raster).
  area(c: number): number
  // Distance from a to b in cells, across the seam.
  step(a: number, b: number): number
  // Neighbours that share a facet (4-connected on the raster; the star on
  // the mesh) — what a basin region is gathered over. Writes into `out`,
  // returns the count.
  facetNeighbours(c: number, out: Int32Array): number
  // Every neighbour (8-connected on the raster; the star on the mesh).
  rimNeighbours(c: number, out: Int32Array): number
}

const FOUR: ReadonlyArray<readonly [number, number]> = [[-1, 0], [1, 0], [0, -1], [0, 1]]
const EIGHT: ReadonlyArray<readonly [number, number]> = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]

export function rasterSubstrate(routing: FlowRouting): FlowSubstrate {
  const { width, height } = routing
  const wrap = (x: number, y: number): number => wrapValue(y, height) * width + wrapValue(x, width)
  return {
    kind: 'raster',
    width,
    height,
    count: width * height,
    filled: routing.filled,
    flowTarget: routing.flowTarget,
    popOrder: routing.popOrder,
    poppedCount: routing.poppedCount,
    x: (c) => (c % width) + 0.5,
    y: (c) => Math.floor(c / width) + 0.5,
    px: (c) => c % width,
    py: (c) => Math.floor(c / width),
    area: () => 1,
    step: (a, b) => {
      // The old receiverSlope's distance, to the operation: axis deltas
      // folded over the seam, hypot, and 1 for a coincident pair.
      const ax = a % width
      const ay = (a - ax) / width
      const bx = b % width
      const by = (b - bx) / width
      let dx = Math.abs(bx - ax)
      if (dx > width / 2) dx = width - dx
      let dy = Math.abs(by - ay)
      if (dy > height / 2) dy = height - dy
      return Math.hypot(dx, dy) || 1
    },
    facetNeighbours: (c, out) => {
      const cx = c % width
      const cy = (c - cx) / width
      for (let i = 0; i < 4; i++) out[i] = wrap(cx + FOUR[i][0], cy + FOUR[i][1])
      return 4
    },
    rimNeighbours: (c, out) => {
      const cx = c % width
      const cy = (c - cx) / width
      for (let i = 0; i < 8; i++) out[i] = wrap(cx + EIGHT[i][0], cy + EIGHT[i][1])
      return 8
    },
  }
}
