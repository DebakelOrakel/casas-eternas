import { wrappedDelta } from './toroidal'

// Flat-torus port of worldgen-sphere/erosion.ts's stream-power/D8 model
// (Cordonnier et al. 2016 — see docs/decisions/plate-tectonics-simulation.md).
// Deliberately a separate, self-contained module rather than an import
// from worldgen-sphere/ — that tree stays untouched; only the algorithm
// itself is carried over, adapted to this map's own topology, which
// differs from the sphere grid in two structural ways worth calling out:
//
// - The sphere grid wraps x at the longitude seam but *clamps* y at the
//   poles (a row above 0 or below the last one doesn't exist). This map
//   wraps in both axes — it's a torus, not a bounded lat/long rectangle
//   — so d8Neighbor below wraps y exactly like x, never returning -1 for
//   an off-the-top/bottom step the way the sphere version does.
// - The sphere grid weights drainage area and horizontal distance by
//   sin(polar angle) specifically to correct for equirectangular pole
//   convergence (cellAreaWeight/buildRowHorizontalScale in
//   worldgen-sphere/grid.ts) — real distortion there, not here. Every
//   cell on this flat torus has identical area and identical spacing in
//   both axes, so accumulateFlow below weights every cell by a flat 1,
//   and runStreamPowerIterations uses plain wrapped pixel distance
//   instead of any trig-based row scale.

export const SEA_LEVEL = 0

// Called at every progress-reporting checkpoint across this module's
// long loops (fillDepressions' pop count, and one per outer iteration in
// runStreamPowerIterations/runThermalErosion/runPeakWeathering) — always
// awaits a real macrotask boundary (a zero-delay setTimeout), not just
// every Nth call. This exists entirely for plateSimulationWorker.ts's
// 'erode' handler: postMessage calls made during a long, uninterrupted
// synchronous stretch get queued for delivery, but browsers commonly
// don't actually flush that delivery to the main thread until the
// sending side yields back to its own event loop — without yielding
// often enough, a ~10+ second erosion pass reads as one all-at-once
// burst of progress messages right before the final render, not a live
// updating percentage. Unconditional rather than throttled to every Nth
// call — an earlier 1-in-8 version still wasn't frequent enough to read
// as live, so this trades the small per-yield overhead (browser-clamped,
// often 1-4ms) for actually solving the problem.
function maybeYield(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

// Fixed N,NE,E,SE,S,SW,W,NW order — fillDepressionsAndRouteFlow and any
// future river tracing both walk neighbors in this order, so a stored
// direction index means the same thing everywhere it's used.
const D8_OFFSETS: ReadonlyArray<readonly [dx: number, dy: number]> = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
]

function d8Neighbor(x: number, y: number, dx: number, dy: number, width: number, height: number): number {
  const nx = (x + dx + width) % width
  const ny = (y + dy + height) % height
  return ny * width + nx
}

// Typed-array-backed binary min-heap, keyed by "filled" elevation. Pop
// results are written into poppedKey/poppedIndex rather than returned as
// an allocated object — this runs up to ~2M times per erosion pass, and
// an allocation per pop would add real GC pressure at that scale.
class MinHeap {
  private readonly keys: Float32Array
  private readonly indices: Int32Array
  private size = 0
  poppedKey = 0
  poppedIndex = -1

  constructor(capacity: number) {
    this.keys = new Float32Array(capacity)
    this.indices = new Int32Array(capacity)
  }

  get length(): number {
    return this.size
  }

  push(key: number, index: number): void {
    let i = this.size++
    this.keys[i] = key
    this.indices[i] = index
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.keys[parent] <= this.keys[i]) break
      this.swapEntries(parent, i)
      i = parent
    }
  }

  pop(): void {
    this.poppedKey = this.keys[0]
    this.poppedIndex = this.indices[0]
    this.size--
    this.keys[0] = this.keys[this.size]
    this.indices[0] = this.indices[this.size]
    let i = 0
    for (;;) {
      const left = i * 2 + 1
      const right = i * 2 + 2
      let smallest = i
      if (left < this.size && this.keys[left] < this.keys[smallest]) smallest = left
      if (right < this.size && this.keys[right] < this.keys[smallest]) smallest = right
      if (smallest === i) break
      this.swapEntries(smallest, i)
      i = smallest
    }
  }

  private swapEntries(a: number, b: number): void {
    const tempKey = this.keys[a]
    this.keys[a] = this.keys[b]
    this.keys[b] = tempKey
    const tempIndex = this.indices[a]
    this.indices[a] = this.indices[b]
    this.indices[b] = tempIndex
  }
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
async function fillDepressions(raw: Float32Array, width: number, height: number, seaLevel: number, onProgress?: (fraction: number) => void): Promise<{ filled: Float32Array; popOrder: Int32Array; poppedCount: number }> {
  const cellCount = width * height
  const filled = new Float32Array(cellCount)
  const popOrder = new Int32Array(cellCount)
  const visited = new Uint8Array(cellCount)
  const heap = new MinHeap(cellCount)

  for (let i = 0; i < cellCount; i++) {
    if (raw[i] <= seaLevel) {
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
      const neighbor = d8Neighbor(x, y, dx, dy, width, height)
      if (visited[neighbor]) continue
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
function computeSteepestDescentFlowTargets(filled: Float32Array, width: number, height: number): Int32Array {
  const cellCount = width * height
  const flowTarget = new Int32Array(cellCount).fill(-1)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = y * width + x
      const ownElevation = filled[cell]
      let bestGradient = 0 // > 0 required — never route to an uphill or equal-elevation neighbor
      let bestTarget = -1
      for (const [dx, dy] of D8_OFFSETS) {
        const neighbor = d8Neighbor(x, y, dx, dy, width, height)
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
  // outEdgeTargets[outEdgeStart[i] .. outEdgeStart[i + 1]), each paired
  // with the weight at the same index in outEdgeWeights. A given cell's
  // own edge weights sum to 1, except cells with zero downhill neighbors
  // (deep ocean, or a genuine local minimum in `filled`), which have zero
  // edges and contribute nothing further downstream.
  outEdgeStart: Int32Array
  outEdgeTargets: Int32Array
  outEdgeWeights: Float32Array
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
function computeMfdEdges(filled: Float32Array, width: number, height: number): MfdEdges {
  const cellCount = width * height
  const outDegree = new Uint8Array(cellCount)
  // Reused across every cell rather than allocated fresh each time — at
  // most 8 entries ever live at once (one per D8 neighbor).
  const scratchTargets = new Int32Array(8)
  const scratchWeights = new Float32Array(8)

  const collectDownhillNeighbors = (cell: number, x: number, y: number): number => {
    const ownElevation = filled[cell]
    let count = 0
    let weightSum = 0
    for (const [dx, dy] of D8_OFFSETS) {
      const neighbor = d8Neighbor(x, y, dx, dy, width, height)
      const drop = ownElevation - filled[neighbor]
      if (drop <= 0) continue
      const distance = dx !== 0 && dy !== 0 ? Math.SQRT2 : 1
      const weight = drop / distance
      scratchTargets[count] = neighbor
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
  const outEdgeTargets = new Int32Array(outEdgeStart[cellCount])
  const outEdgeWeights = new Float32Array(outEdgeStart[cellCount])

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = y * width + x
      const count = collectDownhillNeighbors(cell, x, y)
      const base = outEdgeStart[cell]
      for (let i = 0; i < count; i++) {
        outEdgeTargets[base + i] = scratchTargets[i]
        outEdgeWeights[base + i] = scratchWeights[i]
      }
    }
  }

  return { outEdgeStart, outEdgeTargets, outEdgeWeights }
}

export async function fillDepressionsAndRouteFlow(raw: Float32Array, width: number, height: number, seaLevel: number, onProgress?: (fraction: number) => void): Promise<FlowRouting> {
  const { filled, popOrder, poppedCount } = await fillDepressions(raw, width, height, seaLevel, onProgress)
  // popOrder remains a valid topological order for both of these, with
  // no change needed: both steepest descent and every MFD edge only ever
  // route a cell to a neighbor at or below its own filled elevation, and
  // filled is monotonically non-decreasing outward from the ocean by
  // construction — so a cell's target(s) were always popped no later
  // than the cell itself, exactly what accumulateFlow's reverse walk
  // requires.
  const flowTarget = computeSteepestDescentFlowTargets(filled, width, height)
  const mfd = computeMfdEdges(filled, width, height)
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
export function accumulateFlow(routing: FlowRouting): Float32Array {
  const { width, height, mfd, popOrder, poppedCount } = routing
  const accumulation = new Float32Array(width * height).fill(1)
  for (let i = poppedCount - 1; i >= 0; i--) {
    const cell = popOrder[i]
    const cellAccumulation = accumulation[cell]
    for (let e = mfd.outEdgeStart[cell]; e < mfd.outEdgeStart[cell + 1]; e++) {
      accumulation[mfd.outEdgeTargets[e]] += cellAccumulation * mfd.outEdgeWeights[e]
    }
  }
  return accumulation
}

export interface StreamPowerParams {
  iterations: number
  erodibilityK: number
  areaExponentM: number
  slopeExponentN: number
  timeStep: number
}

// erodibilityK re-verified for this grid via a headless dump script
// (createPlateSimulation -> 100 epochs -> the real elevation query at
// 2048x1024 -> runErosionPass -> diff against the pre-erosion field
// through the same redistribution+color path the renderer uses), not
// assumed. The sphere version's own value (0.00003) was calibrated
// against *that* grid's distance units — tiny (radians: a row's
// vertical step is π/height ≈ 0.003, similarly small longitude-scaled
// horizontal steps) — whereas a D8 step here is a plain pixel distance
// of 1 or √2, hundreds of times larger; since slope =
// Δelevation/distance, the unmodified sphere value against this grid's
// ~300x larger denominator measured out to only 13505/2097152 pixels
// (0.6%) shifting by even a single RGB unit after a 100-epoch run —
// erosion was running correctly end to end but numerically
// imperceptible. Scanning erodibilityK x{100, 300, 1000} against that
// same diff confirmed the ~300x theoretical scaling: 100x
// (erodibilityK=0.003, the value below) already reaches 279443/2097152
// pixels (13%) visibly changed with no sign of the stream-power loop's
// conditional-stability issues (elevations stayed bounded, no
// oscillation) — chosen as a deliberately less-aggressive starting point
// within the verified-safe range rather than 300x/1000x, since it's
// easier to push a visible-but-subtle effect further by eye than to walk
// back an overcorrected one.
export const DEFAULT_STREAM_POWER_PARAMS: StreamPowerParams = {
  iterations: 100,
  erodibilityK: 0.003,
  areaExponentM: 0.5,
  slopeExponentN: 1,
  timeStep: 1,
}

// Mutates `elevations` in place, starting from FlowRouting.filled.
// flowTarget/accumulation are held fixed for the whole loop — recomputing
// full priority-flood every iteration is not viable at this grid size;
// only slope (and therefore dh) changes iteration to iteration. Ocean
// cells are excluded via isLand (derived from *raw*, not filled,
// elevation) so a river mouth doesn't carve an unphysical trench where
// accumulation peaks.
//
// Iterates in popOrder (downstream-to-upstream topological order, not
// flat cell-index order) specifically so that when a cell eroded this
// iteration reads its downstream target's elevation, that target has
// already been updated *this same iteration* — a Gauss-Seidel-style
// update that propagates changes coherently outward from the ocean each
// pass, rather than mixing this-iteration and previous-iteration values
// depending on arbitrary index order.
//
// This is explicit forward-Euler, only conditionally stable — too large
// a timeStep/erodibilityK relative to grid spacing can oscillate into
// spiky, unrealistic terrain rather than smooth incision. The
// elevations[cell] = max(elevations[target], ...) clamp below is the
// first line of defense; if tuning timeStep down doesn't tame it, the
// known escape hatch is Braun & Willett (2013)'s semi-implicit scheme
// (unconditionally stable, more code) — not built here.
export async function runStreamPowerIterations(
  elevations: Float32Array,
  routing: FlowRouting,
  accumulation: Float32Array,
  isLand: Uint8Array,
  width: number,
  height: number,
  params: StreamPowerParams,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  const { flowTarget, popOrder, poppedCount } = routing
  const useSqrtForArea = params.areaExponentM === 0.5
  const slopeExponentIsOne = params.slopeExponentN === 1

  for (let iteration = 0; iteration < params.iterations; iteration++) {
    for (let k = 0; k < poppedCount; k++) {
      const cell = popOrder[k]
      if (!isLand[cell]) continue
      const target = flowTarget[cell]
      if (target === -1) continue

      const y = (cell / width) | 0
      const x = cell - y * width
      const ty = (target / width) | 0
      const tx = target - ty * width

      // Wrapped in both axes (unlike the sphere version, which only
      // needed to wrap x) — a D8 step off the top/bottom edge here wraps
      // through to the opposite edge rather than not existing.
      const dx = wrappedDelta(tx, x, width)
      const dy = wrappedDelta(ty, y, height)
      const distance = Math.max(1e-6, Math.sqrt(dx * dx + dy * dy))

      const slope = Math.max(0, (elevations[cell] - elevations[target]) / distance)
      const area = useSqrtForArea ? Math.sqrt(accumulation[cell]) : Math.pow(accumulation[cell], params.areaExponentM)
      const slopeTerm = slopeExponentIsOne ? slope : Math.pow(slope, params.slopeExponentN)

      const dh = -params.erodibilityK * area * slopeTerm
      elevations[cell] = Math.max(elevations[target], elevations[cell] + dh * params.timeStep)
    }
    onProgress?.((iteration + 1) / params.iterations)
    await maybeYield()
  }
}

export interface ThermalErosionParams {
  iterations: number
  // Critical slope (dimensionless rise/run, matching runStreamPowerIterations'
  // own slope units) — below this, a land cell's own material is treated
  // as stable and untouched; at or above it, the excess above this angle
  // slides toward the lower neighbor. This is what makes thermal erosion
  // target steep terrain specifically rather than smoothing everything.
  talusSlope: number
  // Fraction of a downhill pair's excess-above-talusSlope that actually
  // moves each iteration — see DEFAULT_THERMAL_EROSION_PARAMS for how
  // this was picked.
  transportRate: number
}

// talusSlope set from a real land-cell downhill-slope distribution
// (headless dump: createPlateSimulation -> 100 epochs -> the real
// elevation query at 2048x1024 -> every downhill D8 neighbor pair's
// slope), not guessed: median 0.00214, p90 0.00603, p99 0.00929, max
// 0.01382. Set at the ~90th percentile so only the steepest ~10% of
// downhill slopes on the map — concentrated at ridgelines and peaks,
// exactly the grey/white high terrain that stream-power erosion (area-
// driven, and a peak's own drainage area is always minimal since it's a
// divide, not a collector) barely ever touches — count as unstable.
// transportRate=0.3 chosen alongside it: at that talusSlope, produced a
// clearly visible per-pass change concentrated at high elevation with no
// runaway/oscillation across the same headless comparison used for
// erodibilityK.
export const DEFAULT_THERMAL_EROSION_PARAMS: ThermalErosionParams = {
  iterations: 50,
  talusSlope: 0.006,
  transportRate: 0.3,
}

// Gravity-driven mass-wasting (talus slide), independent of drainage
// area or flow direction entirely — the standard complement to stream-
// power erosion in landscape-evolution models, and the piece that
// actually answers "make erosion reach the mountains directly": stream-
// power only ever carves where a channel happens to route (an area-
// driven process a ridge crest structurally can't attract, since by
// definition almost nothing drains into one), while this acts on local
// slope alone, which is highest exactly at peaks and ridgelines
// regardless of any drainage network.
//
// Whole-map delta computed before any of it is applied (not updated
// cell-by-cell in place mid-pass) so processing order doesn't bias which
// direction material happens to slide first — each downhill pair is only
// evaluated once, from the higher cell's own neighbor scan (the lower
// cell's own scan sees a non-positive drop to that same neighbor and
// skips it), so mass moved off a cell and mass moved onto it never
// double-counts within one iteration.
export async function runThermalErosion(elevations: Float32Array, isLand: Uint8Array, width: number, height: number, params: ThermalErosionParams, onProgress?: (fraction: number) => void): Promise<void> {
  const cellCount = width * height
  const delta = new Float32Array(cellCount)

  for (let iteration = 0; iteration < params.iterations; iteration++) {
    delta.fill(0)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const cell = y * width + x
        if (!isLand[cell]) continue
        const ownElevation = elevations[cell]
        for (const [dx, dy] of D8_OFFSETS) {
          const neighbor = d8Neighbor(x, y, dx, dy, width, height)
          const drop = ownElevation - elevations[neighbor]
          if (drop <= 0) continue
          const distance = dx !== 0 && dy !== 0 ? Math.SQRT2 : 1
          const slope = drop / distance
          if (slope <= params.talusSlope) continue
          const excess = (slope - params.talusSlope) * distance
          // Split in half — the pair moves toward equalizing at the
          // critical angle rather than fully in one iteration, which is
          // what keeps this stable without needing a separate clamp the
          // way runStreamPowerIterations needs one against its target.
          const amount = excess * params.transportRate * 0.5
          delta[cell] -= amount
          delta[neighbor] += amount
        }
      }
    }
    for (let i = 0; i < cellCount; i++) elevations[i] += delta[i]
    onProgress?.((iteration + 1) / params.iterations)
    await maybeYield()
  }
}

// Cheap integer hash + periodic (tiles exactly at cellsX/cellsY) value
// noise, same technique as domainWarp.ts's own — but deliberately not
// shared with it: domainWarp.ts's octaves are tuned for continent-scale
// coastline roughness, while this needs a texture-scale frequency (tens
// of cells across the map, not domainWarp.ts's 8/16/32) so multiple
// ridges/grooves can appear within a single mountain feature's own
// footprint (FEATURE_FALLOFF_RADIUS=160px in elevationField.ts) — a
// different enough tuning concern that duplicating this ~15-line helper
// reads clearer than parameterizing one shared function for both.
function hashLatticePoint(ix: number, iy: number, seed: number): number {
  let h = (ix * 374761393 + iy * 668265263 + seed * 2246822519) >>> 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h = (h ^ (h >>> 16)) >>> 0
  return h / 4294967296 // [0, 1)
}

function smoothstep01(t: number): number {
  return t * t * (3 - 2 * t)
}

function ridgeNoise01(x: number, y: number, width: number, height: number, seed: number, cellsX: number, cellsY: number): number {
  const lx = (x / width) * cellsX
  const ly = (y / height) * cellsY
  const x0 = Math.floor(lx)
  const y0 = Math.floor(ly)
  const fx = lx - x0
  const fy = ly - y0
  const x0m = ((x0 % cellsX) + cellsX) % cellsX
  const y0m = ((y0 % cellsY) + cellsY) % cellsY
  const x1m = (x0m + 1) % cellsX
  const y1m = (y0m + 1) % cellsY
  const v00 = hashLatticePoint(x0m, y0m, seed)
  const v10 = hashLatticePoint(x1m, y0m, seed)
  const v01 = hashLatticePoint(x0m, y1m, seed)
  const v11 = hashLatticePoint(x1m, y1m, seed)
  const sx = smoothstep01(fx)
  const sy = smoothstep01(fy)
  const top = v00 + (v10 - v00) * sx
  const bottom = v01 + (v11 - v01) * sx
  return top + (bottom - top) * sy
}

export interface PeakWeatheringParams {
  iterations: number
  // Elevation at/below which nothing weathers.
  thresholdElevation: number
  // Elevation at/above which weathering reaches full base rate — a
  // linear ramp between thresholdElevation and this, so there's no hard
  // visible seam right at the threshold.
  fullStrengthElevation: number
  // Max fraction of excess-above-threshold removed per iteration, BEFORE
  // noise modulation (see noiseMinFactor) — the noise is what matters
  // for ridges, not this on its own.
  baseRate: number
  // Actual per-cell rate is baseRate * lerp(noiseMinFactor, 1, noise) —
  // this floor is what keeps some strips of an otherwise near-uniform
  // cap eroding much slower than their neighbors even at the identical
  // elevation. That differential, not the elevation ramp alone, is what
  // carves grooves into a cap instead of uniformly lowering the whole
  // thing into a smaller, still-flat dome — the un-grooved strips
  // between fast-eroding patches are what end up reading as ridges.
  noiseMinFactor: number
  noiseCellsX: number
  noiseCellsY: number
}

// thresholdElevation/fullStrengthElevation bracket the "mountain"/"peak"
// color bands (elevationColor.ts's own stops sit at 0.45 and 0.75) —
// deliberately starting the ramp a little below the grey band itself so
// there's no seam right at a color boundary.
//
// baseRate re-verified headless (same methodology as erodibilityK), not
// guessed: applied every round for DEFAULT_EROSION_PASS_PARAMS.rounds x
// this.iterations = 100 total compounded applications, so per-application
// rate and total effect are very different numbers. An initial guess of
// 0.05 compounds to (1-0.05)^100 ≈ 0.6% of excess-above-threshold
// remaining even for the *slowest* (noiseMinFactor-floored) cells —
// confirmed empirically: it collapsed the map's highest point from 0.815
// to 0.65 and flattened the whole peak band toward thresholdElevation
// regardless of noise modulation, exactly the uniform "rounding" this
// was built to avoid, just via compounding rather than a smooth formula.
// 0.005 keeps fast-modulation cells eroding clearly (peak-band
// meanAbsDelta 0.0624 vs 0.0143 with peak weathering off entirely) while
// leaving real elevation still standing (max drops only to 0.778, not
// 0.65) — a starting point still worth checking visually and retuning
// further by eye, like the rest of this file's visual-tuning constants.
export const DEFAULT_PEAK_WEATHERING_PARAMS: PeakWeatheringParams = {
  // DISABLED (2026-07-23, iterations 0 = no-op): peak weathering was built
  // to carve ridge grooves into the otherwise-smooth tectonic caps so
  // fluvial erosion had something to follow — a job the ridged-multifractal
  // detail now added directly to the tectonic uplift field (ridgedNoise.ts)
  // does earlier and more directly, so this became largely redundant.
  // Turned to 0 rather than removed so it's trivially restorable if the
  // caps turn out to want it after all — set back to 20. The rest of the
  // params below stay at their tuned values for that case.
  iterations: 0,
  thresholdElevation: 0.55,
  fullStrengthElevation: 0.75,
  baseRate: 0.005,
  noiseMinFactor: 0.15,
  noiseCellsX: 96,
  noiseCellsY: 48,
}

// Elevation-driven weathering, independent of both drainage area (stream-
// power) and local slope (thermal erosion) — the piece that actually
// reaches the near-flat peak caps neither of those two structurally
// touch (see DEFAULT_THERMAL_EROSION_PARAMS' own comment on why: a
// smoothstep-falloff summit is close to flat right at its own center by
// construction, and a divide/peak's drainage area is always minimal).
// Deliberately differential (see PeakWeatheringParams.noiseMinFactor)
// rather than a flat per-cell rate, specifically so repeated rounds
// carve grooves into a cap — and once fillDepressionsAndRouteFlow
// re-derives the network from that grooved shape next round, those
// grooves can start attracting real fluvial erosion of their own,
// compounding into sharper ridge definition over successive rounds
// rather than staying a fixed, one-off texture.
export async function runPeakWeathering(elevations: Float32Array, isLand: Uint8Array, width: number, height: number, warpSeed: number, params: PeakWeatheringParams, onProgress?: (fraction: number) => void): Promise<void> {
  for (let iteration = 0; iteration < params.iterations; iteration++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const cell = y * width + x
        if (!isLand[cell]) continue
        const elevation = elevations[cell]
        if (elevation <= params.thresholdElevation) continue
        const rampT = Math.min(1, (elevation - params.thresholdElevation) / (params.fullStrengthElevation - params.thresholdElevation))
        const excess = elevation - params.thresholdElevation
        const noise = ridgeNoise01(x, y, width, height, warpSeed, params.noiseCellsX, params.noiseCellsY)
        const modulation = params.noiseMinFactor + (1 - params.noiseMinFactor) * noise
        elevations[cell] -= excess * params.baseRate * rampT * modulation
      }
    }
    onProgress?.((iteration + 1) / params.iterations)
    await maybeYield()
  }
}

export type ErosionPhase = 'flooding' | 'accumulating' | 'streamPower' | 'thermal' | 'peakWeathering'

export interface ErosionPassParams {
  // How many times to redo the whole flooding -> accumulation ->
  // fluvial -> thermal cycle, each round starting from the previous
  // round's own output. See runErosionPass's own comment for why this
  // — not just larger iteration counts within a single round — is what
  // actually gets valley-widening to happen in one call: a channel's
  // banks only get steep enough for thermal erosion to act on *after*
  // fluvial erosion has cut down, and the drainage network itself needs
  // to be re-derived from that new shape before the next fluvial
  // increment reads it, or it just keeps deepening the same channel
  // forever against a stale network instead of ever letting it widen or
  // shift.
  rounds: number
  // Coupled tectonic uplift, per round: each land cell is nudged back
  // toward its original tectonic height (the "envelope") by this fraction
  // of its own tectonic relief, before that round erodes. This is what
  // turns the pass from pure denudation into a forcing/response balance
  // (uplift feeding the mountains, erosion carving them) — the competing
  // terms are what let incised, near-equilibrium valley networks develop
  // instead of a fixed shape just rounding down (per Cordonnier et al.,
  // the model this whole system takes its cue from). 0 recovers the old
  // pure-denudation behavior exactly. See runErosionPass for why it's
  // capped at the envelope rather than an unbounded uplift term.
  upliftRate: number
  // Applied identically every round, not divided across them — e.g.
  // streamPower.iterations is iterations *per round*, so total fluvial
  // work scales with rounds * streamPower.iterations.
  streamPower: StreamPowerParams
  thermal: ThermalErosionParams
  peakWeathering: PeakWeatheringParams
}

// rounds=5 chosen to fold what manual testing showed needed ~5 repeated
// button clicks into a single one — see the module-level history in
// DEFAULT_STREAM_POWER_PARAMS/DEFAULT_THERMAL_EROSION_PARAMS' own
// comments for how the per-round values themselves were calibrated;
// this is a coarser, separately-tuned multiplier on top of those, not a
// re-derivation of them.
export const DEFAULT_EROSION_PASS_PARAMS: ErosionPassParams = {
  rounds: 5,
  // Per-round fraction of a cell's tectonic relief re-applied as uplift
  // (see ErosionPassParams.upliftRate). A moderate starting value —
  // enough that valleys stay incised against the uplift rather than being
  // refilled flat, without the uplift overpowering erosion — meant to be
  // retuned by eye alongside `rounds`, like the rest of this file's
  // visual-tuning constants. 0 would restore pure denudation.
  upliftRate: 0.15,
  streamPower: DEFAULT_STREAM_POWER_PARAMS,
  thermal: DEFAULT_THERMAL_EROSION_PARAMS,
  peakWeathering: DEFAULT_PEAK_WEATHERING_PARAMS,
}

// The one function callers actually need — chains flow-routing through
// accumulation and the stream-power + thermal loops, repeated for
// params.rounds (see ErosionPassParams' own comment for why a single
// routing-then-erode pass alone doesn't produce real valley widening).
// Takes the raw elevation field directly (unlike the sphere version's
// runErosionPass, which sampled it from a PlateWorld/CrustState itself)
// since this map's tectonics worker already has that array on hand from
// its own last render (see SimulationRenderResult.rawElevations in
// elevationMapImage.ts) — no need for this module to know how to
// produce it.
//
// Uplift IS modeled here, but as a forcing derived from that same input
// field rather than a separately-supplied rate: `rawElevations` is the
// finished tectonic surface, so its own positive relief doubles as both
// the uplift pattern (where, and how strongly, to push crust up) and the
// envelope (how high — the tectonic height this pass won't exceed). Each
// round re-applies params.upliftRate of that relief before eroding (see
// the round loop), so mountains are held up while valleys incise into
// them — a coupled uplift/erosion balance, not pure denudation of a fixed
// shape. Capping at the envelope (rather than an unbounded Cordonnier-style
// uplift term that would set equilibrium height purely from the uplift/
// erodibility ratio) keeps the already-tuned tectonic heights as the
// ceiling and makes the pass unconditionally non-inflating: uplift can
// only ever resist erosion up to the original surface, never grow past it.
export async function runErosionPass(
  rawElevations: Float32Array,
  width: number,
  height: number,
  warpSeed: number,
  params: ErosionPassParams = DEFAULT_EROSION_PASS_PARAMS,
  onProgress?: (phase: ErosionPhase, fraction: number) => void,
  // Awaited after every round, given a *copy* of that round's own
  // elevations — lets a caller (plateSimulationWorker.ts) redraw the map
  // once per round instead of only once at the very end, without this
  // module needing to know anything about rendering. Awaited (not fired
  // and forgotten) deliberately, so a slow redraw can't overlap with the
  // next round's computation touching the same underlying arrays.
  onRoundComplete?: (elevations: Float32Array, round: number) => void | Promise<void>,
): Promise<{ elevations: Float32Array; routing: FlowRouting; accumulation: Float32Array }> {
  const cellCount = width * height
  // Copied rather than aliased — runPeakWeathering below now mutates
  // `elevations` before the first routing pass even runs, and
  // rawElevations may be a caller-retained array (the tectonics worker's
  // own cached "last raw elevations") that shouldn't be silently
  // reshaped as a side effect of eroding it once.
  let elevations = rawElevations.slice()
  let routing: FlowRouting | undefined
  let accumulation: Float32Array | undefined

  // Each phase's own onProgress reports 0->1 for *itself* — without
  // weighting, naively scaling every phase's fraction by 1/rounds would
  // have the overall progress climb to the round's ceiling and then drop
  // back down at every one of the 5 phase boundaries within that same
  // round, instead of climbing smoothly across the whole call. Weighted
  // by iteration count (a reasonable proxy for relative cost — the two
  // single-pass O(cells) steps that don't have their own iteration count
  // get small fixed shares instead), so a phase with more iterations
  // — and therefore more onProgress calls, i.e. more visible granularity
  // — also claims a proportionally bigger slice of the overall bar.
  const FLOODING_WEIGHT = 15
  const ACCUMULATING_WEIGHT = 5
  const phaseOrder: ErosionPhase[] = ['peakWeathering', 'flooding', 'accumulating', 'streamPower', 'thermal']
  const phaseWeight: Record<ErosionPhase, number> = {
    peakWeathering: params.peakWeathering.iterations,
    flooding: FLOODING_WEIGHT,
    accumulating: ACCUMULATING_WEIGHT,
    streamPower: params.streamPower.iterations,
    thermal: params.thermal.iterations,
  }
  const roundWeightTotal = phaseOrder.reduce((sum, phase) => sum + phaseWeight[phase], 0)
  const phaseStartFraction: Record<ErosionPhase, number> = {} as Record<ErosionPhase, number>
  let cumulativeWeight = 0
  for (const phase of phaseOrder) {
    phaseStartFraction[phase] = cumulativeWeight / roundWeightTotal
    cumulativeWeight += phaseWeight[phase]
  }

  for (let round = 0; round < params.rounds; round++) {
    const roundProgress = (phase: ErosionPhase, fraction: number): void => {
      const withinRound = phaseStartFraction[phase] + (fraction * phaseWeight[phase]) / roundWeightTotal
      onProgress?.(phase, (round + withinRound) / params.rounds)
    }

    // Coupled uplift: before this round erodes, push every land cell back
    // toward its tectonic height by params.upliftRate of that cell's own
    // tectonic relief, capped at the tectonic envelope (rawElevations) so
    // peaks are held up against erosion but never inflated past their
    // tuned height. This is the forcing term that competes with the
    // round's erosion below — see runErosionPass's and
    // ErosionPassParams.upliftRate's own comments. Runs before isLand so a
    // valley refilled back above sea level counts as land again this round.
    if (params.upliftRate > 0) {
      for (let i = 0; i < cellCount; i++) {
        const envelope = rawElevations[i]
        if (envelope <= SEA_LEVEL) continue
        const restored = elevations[i] + envelope * params.upliftRate
        elevations[i] = restored < envelope ? restored : envelope
      }
    }

    // Re-derived every round from that round's own starting elevations
    // (not fixed once from the very first raw field) — a cell fluvial
    // erosion pushes below sea level in an earlier round should stop
    // taking further land-only erosion in later ones, the same way it
    // already would if that round were a separate manual click.
    const isLand = new Uint8Array(cellCount)
    for (let i = 0; i < cellCount; i++) isLand[i] = elevations[i] > SEA_LEVEL ? 1 : 0

    // Runs first, before this round's own routing — so whatever grooves
    // it just carved into a peak cap are visible to *this* round's
    // fillDepressionsAndRouteFlow, not just the next one (see
    // runPeakWeathering's own comment).
    await runPeakWeathering(elevations, isLand, width, height, warpSeed, params.peakWeathering, (fraction) => roundProgress('peakWeathering', fraction))

    routing = await fillDepressionsAndRouteFlow(elevations, width, height, SEA_LEVEL, (fraction) => roundProgress('flooding', fraction))

    roundProgress('accumulating', 0)
    accumulation = accumulateFlow(routing)
    roundProgress('accumulating', 1)
    await maybeYield()

    elevations = routing.filled.slice()
    await runStreamPowerIterations(elevations, routing, accumulation, isLand, width, height, params.streamPower, (fraction) => roundProgress('streamPower', fraction))
    // Order matters only a little here (both passes reread whatever the
    // other just wrote next round, since routing gets rederived from
    // the combined result either way) — runs second so a talus slide's
    // own runoff isn't immediately re-carved by this same round's
    // stream-power step, which read accumulation computed before either
    // pass touched elevations.
    await runThermalErosion(elevations, isLand, width, height, params.thermal, (fraction) => roundProgress('thermal', fraction))

    await onRoundComplete?.(elevations.slice(), round)
  }

  return { elevations, routing: routing!, accumulation: accumulation! }
}

// Rivers/lakes seam (not implemented here): `routing.filled` differing
// from the raw sampled elevation at a cell already identifies lake
// bodies, and the point where routing.flowTarget first crosses back to a
// cell where filled==raw is that lake's outlet — exactly
// docs/vision.md Phase 4's "a lake should have at least an outlet".
// `accumulation` thresholded and traced along flowTarget is exactly what
// river polylines need. A future rivers/lakes pass can consume this
// module's exports directly with no recomputation, given the same
// FlowRouting/accumulation this file already produces.
