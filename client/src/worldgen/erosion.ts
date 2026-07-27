import { wrappedDelta } from './toroidal'
import { SEA_LEVEL, slopeFromAngle } from './elevationScale'

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

// Called at every progress-reporting checkpoint across this module's
// long loops (fillDepressions' pop count, and one per outer iteration in
// runStreamPowerIterations/runThermalErosion) — always
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

// The critical slope is stated as a real ANGLE, not a bare number. It used to be
// 0.006, set at the 90th percentile of the then-measured slope distribution — a
// sound-looking calibration that turned out to describe the wrong thing, and the
// metre anchor (elevationScale.ts) is what made that visible. In real units 0.006
// is 0.40°, so the model was declaring anything steeper than a fifth of a degree
// to be unstable scree.
//
// A talus threshold is an ATTRACTOR, not a filter: whatever starts above it is
// ground down toward it, and with 50 iterations a round over 5 rounds the whole
// map converges on it. At 0.40° that planed the mountains. Measured over a full
// pass, mean local relief above 2 km: 693 m on the tectonic surface, 365 m after
// erosion — the stream-power step carved it up to 748 m and this step then took
// more than half of that back off. Which is exactly the "valleys everywhere on
// the plains, none in the mountains" the terrain was showing.
//
// So the question is what the steepest SUSTAINABLE slope is at this grid's scale,
// and the answer is not the angle of repose. Repose is ~33°, but at 7.8 km per
// cell no such slope can exist — averaged over 8 km, even the Himalayan front is
// only ~5.7°, and this world's tectonic surface measures p99 = 2.25° with an
// absolute maximum of 7.97°. 3° sits just above the p99.9 of 4.13°... deliberately
// below it: it fires on the steepest ~0.5% of downhill pairs, which are real range
// fronts and freshly-incised channel banks, and leaves ordinary mountain slope
// alone.
//
// Swept against the alternatives (mean local relief above 2 km after a full pass):
//   0.40° (old) 365 m, fires on 10.1% of pairs
//   1°          542 m,  3.7%
//   2°          731 m,  1.3%
//   3°          831 m,  0.5%   <- chosen
//   5°          901 m,  0.03%  — effectively disabled
//   8°+         915 m,  0%     — fully disabled, the no-thermal-erosion value
// Above ~5° the step stops doing anything at all, which would leave the
// valley-widening it exists for unimplemented; 3° keeps it working on the terrain
// it was meant for while erosion now ADDS relief in the mountains (831 m against
// the tectonic surface's 693 m) instead of removing it.
//
// transportRate = 0.3 and iterations = 50 are unchanged, but note they now apply
// to a far smaller set of pairs, which is the point.
const TALUS_ANGLE_DEGREES = 3

export const DEFAULT_THERMAL_EROSION_PARAMS: ThermalErosionParams = {
  iterations: 50,
  talusSlope: slopeFromAngle(TALUS_ANGLE_DEGREES),
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

export type ErosionPhase = 'flooding' | 'accumulating' | 'streamPower' | 'thermal'

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
  // How many times to RE-DERIVE the drainage network (priority-flood + flow
  // accumulation) WITHIN a single round's fluvial phase, splitting streamPower.iterations
  // evenly across them. 1 = the original behaviour (network frozen for the whole 100-iter
  // phase). >1 lets rivers migrate and capture each other as the terrain incises — the
  // real realism gain, only affordable because Braun-Willett is O(n) and unconditionally
  // stable (the explicit scheme would risk oscillating between re-routings). Total cost
  // adds (rounds · (networkRefreshes − 1)) extra priority-floods, so keep it modest.
  networkRefreshes: number
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
  networkRefreshes: 1,
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
  params: ErosionPassParams = DEFAULT_EROSION_PASS_PARAMS,
  onProgress?: (phase: ErosionPhase, fraction: number) => void,
  // Awaited after every round, given a *copy* of that round's own
  // elevations — lets a caller (plateSimulationWorker.ts) redraw the map
  // once per round instead of only once at the very end, without this
  // module needing to know anything about rendering. Awaited (not fired
  // and forgotten) deliberately, so a slow redraw can't overlap with the
  // next round's computation touching the same underlying arrays.
  onRoundComplete?: (elevations: Float32Array, round: number) => void | Promise<void>,
  // Checked at each round boundary — return true to stop early (the user hit stop). The
  // partial result (rounds done so far) is returned as-is, so the caller can keep it and
  // a later erode continues from there. Round 0 always completes so routing is valid.
  shouldCancel?: () => boolean,
): Promise<{ elevations: Float32Array; routing: FlowRouting; accumulation: Float32Array; preFillElevations: Float32Array }> {
  const cellCount = width * height
  // Copied rather than aliased — the round loop mutates `elevations` in
  // place, and rawElevations may be a caller-retained array (the tectonics
  // worker's own cached "last raw elevations") that shouldn't be silently
  // reshaped as a side effect of eroding it once. rawElevations is still
  // read directly as the uplift envelope, so it must stay intact.
  let elevations = rawElevations.slice()
  let routing: FlowRouting | undefined
  let accumulation: Float32Array | undefined
  // The last round's elevations *before* its depression fill — i.e. the eroded
  // terrain with its closed basins still intact (the final `elevations` has them
  // filled for drainage, so no basins survive there). This is what a rivers/lakes
  // pass needs to place lakes: the filled terrain is basin-free by construction.
  let preFillElevations: Float32Array | undefined

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
  const phaseOrder: ErosionPhase[] = ['flooding', 'accumulating', 'streamPower', 'thermal']
  const phaseWeight: Record<ErosionPhase, number> = {
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
    // Stop early if the user cancelled — but only after round 0, so `routing`/
    // `accumulation` are always set for the return.
    if (round > 0 && shouldCancel?.()) break
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

    routing = await fillDepressionsAndRouteFlow(elevations, width, height, SEA_LEVEL, (fraction) => roundProgress('flooding', fraction))

    roundProgress('accumulating', 0)
    accumulation = accumulateFlow(routing)
    roundProgress('accumulating', 1)
    await maybeYield()

    // Capture the last round's basins before the fill flattens them (for lakes).
    if (round === params.rounds - 1) preFillElevations = elevations.slice()

    // Fluvial phase, with the drainage network re-derived params.networkRefreshes times
    // across it (not frozen for the whole phase) — rivers can migrate/capture as they
    // incise. The first sub-pass reuses the network already routed above; each later one
    // re-runs priority-flood + accumulation on the partially-incised terrain (isLand is
    // held for the round, so only the drainage geometry updates). streamPower.iterations
    // is split evenly across the sub-passes so total fluvial work is unchanged.
    const refreshes = Math.max(1, params.networkRefreshes)
    const itersPerRefresh = Math.max(1, Math.round(params.streamPower.iterations / refreshes))
    const refreshParams: StreamPowerParams = { ...params.streamPower, iterations: itersPerRefresh }
    for (let r = 0; r < refreshes; r++) {
      if (r > 0) {
        routing = await fillDepressionsAndRouteFlow(elevations, width, height, SEA_LEVEL)
        accumulation = accumulateFlow(routing)
      }
      elevations = routing.filled.slice()
      await runStreamPowerIterations(elevations, routing, accumulation, isLand, width, height, refreshParams, (fraction) => roundProgress('streamPower', (r + fraction) / refreshes))
    }
    // Order matters only a little here (both passes reread whatever the
    // other just wrote next round, since routing gets rederived from
    // the combined result either way) — runs second so a talus slide's
    // own runoff isn't immediately re-carved by this same round's
    // stream-power step, which read accumulation computed before either
    // pass touched elevations.
    await runThermalErosion(elevations, isLand, width, height, params.thermal, (fraction) => roundProgress('thermal', fraction))

    await onRoundComplete?.(elevations.slice(), round)
  }

  return { elevations, routing: routing!, accumulation: accumulation!, preFillElevations: preFillElevations ?? elevations }
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
