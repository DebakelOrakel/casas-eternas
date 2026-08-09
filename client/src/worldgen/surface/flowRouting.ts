import { MinHeap } from '../core/minHeap'

// Drainage routing on the flat torus: priority-flood depression filling, D8 flow
// direction, multiple-flow-direction edges, and drainage-area accumulation. This
// is the layer that turns a raw elevation raster into a river network, and it is
// deliberately separate from what then ERODES along that network (erosion.ts) —
// hydrology.ts needs the network without wanting any erosion at all, and used to
// have to reach into erosion.ts to get it.
//
// Ported from worldgen-sphere/erosion.ts's model (Cordonnier et al. 2016 — see
// docs/decisions/plate-tectonics-simulation.md) rather than imported from it:
// that tree stays untouched, and this map's topology differs in two structural
// ways worth calling out.
//
// - The sphere grid wraps x at the longitude seam but *clamps* y at the poles (a
//   row above 0 or below the last one doesn't exist). This map wraps in both axes
//   — it's a torus, not a bounded lat/long rectangle — so d8Neighbor below wraps
//   y exactly like x, never returning -1 for an off-the-top/bottom step the way
//   the sphere version does.
// - The sphere grid weights drainage area and horizontal distance by sin(polar
//   angle) to correct for equirectangular pole convergence (cellAreaWeight /
//   buildRowHorizontalScale in worldgen-sphere/grid.ts) — real distortion there,
//   not here. Every cell on this flat torus has identical area and identical
//   spacing in both axes, so accumulateFlow below weights every cell by a flat 1.

// Called at every progress-reporting checkpoint across this module's
// long loops (fillDepressions' pop count, and one per outer iteration in
// runStreamPowerIterations/runThermalErosion) — always
// awaits a real macrotask boundary (a zero-delay setTimeout), not just
// every Nth call. This exists entirely for the generator pipeline's 'erode'
// handler (pipeline/runtime.ts): postMessage calls made during a long, uninterrupted
// synchronous stretch get queued for delivery, but browsers commonly
// don't actually flush that delivery to the main thread until the
// sending side yields back to its own event loop — without yielding
// often enough, a ~10+ second erosion pass reads as one all-at-once
// burst of progress messages right before the final render, not a live
// updating percentage. Unconditional rather than throttled to every Nth
// call — an earlier 1-in-8 version still wasn't frequent enough to read
// as live, so this trades the small per-yield overhead (browser-clamped,
// often 1-4ms) for actually solving the problem.
export function maybeYield(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

// Fixed N,NE,E,SE,S,SW,W,NW order — fillDepressionsAndRouteFlow and any
// future river tracing both walk neighbors in this order, so a stored
// direction index means the same thing everywhere it's used.
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

export function d8Neighbor(x: number, y: number, dx: number, dy: number, width: number, height: number): number {
  const nx = (x + dx + width) % width
  const ny = (y + dy + height) % height
  return ny * width + nx
}

// Clamped (non-wrapping) neighbor for BOUNDED grids — the micro-tile
// prototype's window is a plain rectangle cut out of the torus, so a step off
// its edge leads out of the tile, not around to the far side. Returns -1
// off-grid; callers skip it.
export function d8NeighborBounded(x: number, y: number, dx: number, dy: number, width: number, height: number): number {
  const nx = x + dx
  const ny = y + dy
  if (nx < 0 || nx >= width || ny < 0 || ny >= height) return -1
  return ny * width + nx
}

export interface FlowRouting {
  width: number
  height: number
  // Depression-filled elevations — always >= raw everywhere. A cell whose
  // filled value differs from its raw value is (part of) a lake; this is
  // also exactly the data a future rivers/lakes pass needs (see the
  // module comment at the bottom of this file).
  filled: Float32Array
  // D8 downstream neighbor's cell index, or -1 for an unrouted/terminal
  // cell (only possible if there were zero ocean seed cells — see below).
  // Single-target, used only for stream-power incision (see
  // runStreamPowerIterations) — accumulateFlow uses `mfd` instead, not
  // this.
  flowTarget: Int32Array
  // Multiple-flow-direction edges, used for drainage-area accumulation
  // (see computeMfdEdges's own comment for why accumulation and incision
  // deliberately use different routing).
  mfd: MfdEdges
  // Cells in the exact order the flood popped them — a valid topological
  // order for the flow graph (a cell is always popped before any
  // neighbor it floods, so flow only ever runs from a later-popped cell
  // into an earlier-popped one). Only the first poppedCount entries are
  // valid.
  popOrder: Int32Array
  poppedCount: number
}

const EPSILON_FLOOD_STEP = 1e-7

// Mask of the largest 4-connected ≤ seaLevel component — the world ocean.
// Null when there is no water at all. O(n) flood fill; cheap next to the
// priority flood it feeds.
export function largestWaterComponent(raw: Float32Array, width: number, height: number, seaLevel: number): Uint8Array | null {
  const n = width * height
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
      for (const nb of [y * width + ((x + 1) % width), y * width + ((x + width - 1) % width), (((y + 1) % height) * width) + x, (((y + height - 1) % height) * width) + x]) {
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

// Priority-flood depression filling + D8 flow-direction assignment,
// seeded from the ocean (every cell at or below seaLevel) rather than a
// map edge — this grid wraps in both axes (no edge to drain off of
// either), so the ocean itself plays the role a map's border plays in
// the classic (bounded-tile) priority-flood algorithm (Barnes, Lehman &
// Mulla 2014). Uses the "epsilon-flood" variant (each newly-flooded cell
// gets max(raw, filled[source]) + a tiny epsilon) so the filled surface
// has a well-defined downhill gradient *everywhere*, including across a
// lake, without a separate flat-drainage resolution pass.
//
// This pass only produces `filled` and `popOrder`/`poppedCount` — flow
// *direction* is deliberately NOT assigned here (see the empirical note
// on computeSteepestDescentFlowTargets below for why an earlier version
// that did assign it here, as a side effect of which cell's expansion
// reached a neighbor first, turned out to be a real bug, not just a
// simplification).
//
// If there are zero cells at or below seaLevel (a fully continental
// world), nothing gets seeded, poppedCount stays 0, and filled stays all
// zero — a graceful no-routing degradation (computeSteepestDescentFlowTargets
// then finds no downhill gradient anywhere and leaves every flowTarget at
// -1) rather than a crash.
async function fillDepressions(raw: Float32Array, width: number, height: number, seaLevel: number, onProgress?: (fraction: number) => void, bounded = false): Promise<{ filled: Float32Array; popOrder: Int32Array; poppedCount: number }> {
  const cellCount = width * height
  const filled = new Float32Array(cellCount)
  const popOrder = new Int32Array(cellCount)
  const visited = new Uint8Array(cellCount)
  const heap = new MinHeap(cellCount)

  // Torus mode seeds only the WORLD OCEAN — the largest connected ≤ seaLevel
  // body (2026-08-06). Seeding every ≤ seaLevel cell made any ENCLOSED
  // sub-sea-level basin (a landlocked ocean remnant, a deep rift graben) an
  // unconditional "sea at level 0": always brim-full regardless of climate,
  // and a base level the flood radiated from. Seeded from the world ocean
  // alone, an enclosed basin is what it physically is — a depression: the
  // flood fills it to its spill, computeLakes then classifies it as a
  // TERMINAL SEA and sets its real water level from inflow vs evaporation
  // (the Caspian/Chad class). Bounded tiles keep the old all-water + border
  // seeding — a tile window can't know which of its water bodies connects to
  // the world ocean outside the window, and its rim is the drain anyway.
  const oceanSeed = bounded ? null : largestWaterComponent(raw, width, height, seaLevel)
  for (let i = 0; i < cellCount; i++) {
    const isBorderSeed = bounded && ((i % width) === 0 || (i % width) === width - 1 || i < width || i >= cellCount - width)
    const isWaterSeed = oceanSeed ? oceanSeed[i] === 1 : raw[i] <= seaLevel
    if (isWaterSeed || isBorderSeed) {
      filled[i] = raw[i]
      visited[i] = 1
      heap.push(filled[i], i)
    }
  }

  let poppedCount = 0
  // Reporting every pop would itself be a meaningful cost at ~2M pops —
  // ~200 progress callbacks over the whole run is enough for a UI
  // progress bar without that overhead.
  const progressStep = Math.max(1, Math.floor(cellCount / 200))
  while (heap.length > 0) {
    heap.pop()
    const current = heap.poppedIndex
    popOrder[poppedCount] = current
    poppedCount++
    if (poppedCount % progressStep === 0) {
      onProgress?.(poppedCount / cellCount)
      await maybeYield()
    }

    const y = (current / width) | 0
    const x = current - y * width
    for (const [dx, dy] of D8_OFFSETS) {
      const neighbor = bounded ? d8NeighborBounded(x, y, dx, dy, width, height) : d8Neighbor(x, y, dx, dy, width, height)
      if (neighbor < 0 || visited[neighbor]) continue
      visited[neighbor] = 1
      // Scaled by step distance (a diagonal hop is really √2 away, not
      // 1), for consistency with computeSteepestDescentFlowTargets's own
      // distance normalization — but note this alone does NOT explain a
      // real, empirically-confirmed cardinal-direction drift under
      // repeated erosion passes (see DEFAULT_STREAM_POWER_PARAMS' own
      // comment); re-tested after adding this and the drift was
      // unchanged; EPSILON_FLOOD_STEP (1e-7) is simply too small relative
      // to real per-pass elevation deltas (~1e-3) for its own distance
      // scaling to matter. Left in as a real (if minor) correctness fix
      // on its own terms, not as the fix for that drift.
      const stepDistance = dx !== 0 && dy !== 0 ? Math.SQRT2 : 1
      filled[neighbor] = Math.max(raw[neighbor], filled[current]) + EPSILON_FLOOD_STEP * stepDistance
      heap.push(filled[neighbor], neighbor)
    }
  }

  onProgress?.(1)
  return { filled, popOrder, poppedCount }
}

// True per-cell steepest descent over the filled surface — distance-
// weighted (a diagonal neighbor is really √2 away, not 1), independent
// for every cell, rather than derived from priority-flood's own
// expansion order.
//
// This replaced an earlier version that assigned flowTarget[neighbor] =
// current directly inside fillDepressions's own flood loop (whichever
// already-processed cell's expansion reached a given neighbor *first*
// claimed it) — which measured out, empirically, to a severe artifact
// rather than a harmless shortcut: a direction histogram over a real
// eroded field showed 99.7% of all flow assignments landing on one of
// the 4 diagonal directions and just 0.3% on the 4 cardinal ones, with
// that same ~99.7/0.3 split holding equally on steep and near-flat
// terrain alike. That terrain-independence is what rules out "the real
// gradients here just happen to be diagonal" — it's the flood's own
// 8-connected spanning tree that's diagonal-biased (orthogonal neighbors
// of a newly-popped cell are topologically shared with more
// already-processed neighbors, so they tend to already be claimed by the
// time that cell's own turn comes to expand into them, leaving diagonal
// connections to dominate the tree almost regardless of actual
// elevation shape). The visible symptom was drainage that read as
// artificially streaky/parallel rather than naturally branching.
function computeSteepestDescentFlowTargets(filled: Float32Array, width: number, height: number, bounded = false): Int32Array {
  const cellCount = width * height
  const flowTarget = new Int32Array(cellCount).fill(-1)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = y * width + x
      const ownElevation = filled[cell]
      let bestGradient = 0 // > 0 required — never route to an uphill or equal-elevation neighbor
      let bestTarget = -1
      for (const [dx, dy] of D8_OFFSETS) {
        const neighbor = bounded ? d8NeighborBounded(x, y, dx, dy, width, height) : d8Neighbor(x, y, dx, dy, width, height)
        if (neighbor < 0) continue
        const distance = dx !== 0 && dy !== 0 ? Math.SQRT2 : 1
        const gradient = (ownElevation - filled[neighbor]) / distance
        if (gradient > bestGradient) {
          bestGradient = gradient
          bestTarget = neighbor
        }
      }
      flowTarget[cell] = bestTarget
    }
  }
  return flowTarget
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
  // byte, and the cell index is recovered with the same d8Neighbor call
  // that built it (see edgeTarget below). Storing absolute Int32 indices
  // cost four bytes per edge for information three bits carry; at ~2.9
  // edges per cell that is ~9 bytes per cell of pure overhead, which on the
  // worldmap's amplified grids ran into hundreds of megabytes (measured
  // 2026-08-07: 97 MB of a routing's 327 MB at 4096², four times that at
  // 8192²). Bit-exact — the decoded target is the same index that used to
  // be stored.
  outEdgeDirections: Uint8Array
  outEdgeWeights: Float32Array
  // Which neighbor rule the edges were built with, so decoding reproduces
  // it: a bounded (micro-tile) grid must not wrap where a torus would.
  bounded: boolean
}

// Decode one CSR edge back to its target cell index.
export function edgeTarget(mfd: MfdEdges, cell: number, edge: number, width: number, height: number): number {
  const x = cell % width
  const y = (cell - x) / width
  const [dx, dy] = D8_OFFSETS[mfd.outEdgeDirections[edge]]
  return mfd.bounded ? d8NeighborBounded(x, y, dx, dy, width, height) : d8Neighbor(x, y, dx, dy, width, height)
}

// Multiple-flow-direction routing (Freeman 1991 / Quinn et al. 1991):
// distributes each cell's outflow across *every* downhill neighbor,
// weighted by slope, instead of committing 100% of it to a single
// steepest one — used only for accumulateFlow's drainage-area estimate.
// runStreamPowerIterations still incises along a single steepest path
// per cell (FlowRouting.flowTarget) — the standard combination in
// landscape-evolution models: channel incision genuinely happens along
// one thalweg, so a single representative slope is physically
// reasonable there, but upstream drainage *area* is exactly where
// single-flow-direction's grid-aligned channelization showed up in
// practice (see DEFAULT_STREAM_POWER_PARAMS' own comment for the
// empirical history: a direction histogram over repeated erosion passes
// drifted from ~54% to ~68% cardinal-direction share, and neither
// epsilon scaling nor the incision step's own distance weighting turned
// out to be the cause when tested directly — MFD sidesteps the whole
// "which single direction wins" question for area instead of chasing
// that cause further).
//
// Linear weighting (weight ∝ slope, not slope^p for some p > 1) rather
// than the literature-typical Freeman exponent (~1.1) — a starting
// simplification, not an empirically-tuned choice; a higher exponent
// would concentrate flow more (closer to single-flow-direction) and a
// lower one would spread it more evenly. Computes each cell's downhill
// neighbor set twice (once to size the CSR arrays, once to fill them)
// rather than caching it between passes — twice through an 8-neighbor
// scan is still a small, linear cost next to the actual per-pixel
// elevation query elsewhere in this app's render pipeline.
function computeMfdEdges(filled: Float32Array, width: number, height: number, bounded = false): MfdEdges {
  const cellCount = width * height
  const outDegree = new Uint8Array(cellCount)
  // Reused across every cell rather than allocated fresh each time — at
  // most 8 entries ever live at once (one per D8 neighbor).
  const scratchDirections = new Uint8Array(8)
  const scratchWeights = new Float32Array(8)

  const collectDownhillNeighbors = (cell: number, x: number, y: number): number => {
    const ownElevation = filled[cell]
    let count = 0
    let weightSum = 0
    for (let dir = 0; dir < D8_OFFSETS.length; dir++) {
      const [dx, dy] = D8_OFFSETS[dir]
      const neighbor = bounded ? d8NeighborBounded(x, y, dx, dy, width, height) : d8Neighbor(x, y, dx, dy, width, height)
      if (neighbor < 0) continue
      const drop = ownElevation - filled[neighbor]
      if (drop <= 0) continue
      const distance = dx !== 0 && dy !== 0 ? Math.SQRT2 : 1
      const weight = drop / distance
      scratchDirections[count] = dir
      scratchWeights[count] = weight
      weightSum += weight
      count++
    }
    for (let i = 0; i < count; i++) scratchWeights[i] /= weightSum
    return count
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = y * width + x
      outDegree[cell] = collectDownhillNeighbors(cell, x, y)
    }
  }

  const outEdgeStart = new Int32Array(cellCount + 1)
  for (let i = 0; i < cellCount; i++) outEdgeStart[i + 1] = outEdgeStart[i] + outDegree[i]
  const outEdgeDirections = new Uint8Array(outEdgeStart[cellCount])
  const outEdgeWeights = new Float32Array(outEdgeStart[cellCount])

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = y * width + x
      const count = collectDownhillNeighbors(cell, x, y)
      const base = outEdgeStart[cell]
      for (let i = 0; i < count; i++) {
        outEdgeDirections[base + i] = scratchDirections[i]
        outEdgeWeights[base + i] = scratchWeights[i]
      }
    }
  }

  return { outEdgeStart, outEdgeDirections, outEdgeWeights, bounded }
}

// `bounded = true` treats the grid as a plain rectangle instead of a torus —
// neighbors clamp at the edges and the border ring is seeded as a drain. Used
// by the micro-tile prototype (removed 2026-08-09); every existing global caller
// keeps the torus default and identical behavior.
export async function fillDepressionsAndRouteFlow(raw: Float32Array, width: number, height: number, seaLevel: number, onProgress?: (fraction: number) => void, bounded = false): Promise<FlowRouting> {
  const { filled, popOrder, poppedCount } = await fillDepressions(raw, width, height, seaLevel, onProgress, bounded)
  // popOrder remains a valid topological order for both of these, with
  // no change needed: both steepest descent and every MFD edge only ever
  // route a cell to a neighbor at or below its own filled elevation, and
  // filled is monotonically non-decreasing outward from the ocean by
  // construction — so a cell's target(s) were always popped no later
  // than the cell itself, exactly what accumulateFlow's reverse walk
  // requires.
  const flowTarget = computeSteepestDescentFlowTargets(filled, width, height, bounded)
  const mfd = computeMfdEdges(filled, width, height, bounded)
  return { width, height, filled, flowTarget, mfd, popOrder, poppedCount }
}

// Drainage-area accumulation via MFD (see MfdEdges' own comment for why
// this uses multiple weighted edges instead of routing.flowTarget).
// Every cell contributes an equal base weight of 1 — unlike the sphere
// version, there's no equirectangular pole-convergence artifact to
// correct for on a flat torus, so this skips straight to uniform
// weighting rather than porting cellAreaWeight. Single O(edges) pass, no
// heap: walking popOrder in reverse visits every cell only after all of
// its own upstream contributors already have (see FlowRouting.popOrder).
// `baseAccumulation` (optional) replaces the uniform per-cell weight of 1 with
// caller-provided starting weights — the micro-tile prototype injects the MACRO
// river's upstream drainage area at the fine cells where it enters the tile, so
// a mouth tile sees the whole catchment's discharge, not just the rain that
// falls inside the window.
export function accumulateFlow(routing: FlowRouting, baseAccumulation?: Float32Array): Float32Array {
  const { width, height, mfd, popOrder, poppedCount } = routing
  const accumulation = baseAccumulation ? baseAccumulation.slice() : new Float32Array(width * height).fill(1)
  for (let i = poppedCount - 1; i >= 0; i--) {
    const cell = popOrder[i]
    const cellAccumulation = accumulation[cell]
    for (let e = mfd.outEdgeStart[cell]; e < mfd.outEdgeStart[cell + 1]; e++) {
      accumulation[edgeTarget(mfd, cell, e, width, height)] += cellAccumulation * mfd.outEdgeWeights[e]
    }
  }
  return accumulation
}
