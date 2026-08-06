import type { CrustState } from './crust'
import { generateElevationField } from './elevationField'
import { D8_OFFSETS, SEA_LEVEL, buildRowHorizontalScale, cellAreaWeight, d8Neighbor } from './grid'
import type { PlateWorld } from './plates'

// Pure, Babylon/worker-scope-free functions (importable from a plain Node
// script for headless tuning/verification — same rationale texture.ts
// documents for its own split from the worker). Implements the
// stream-power/D8 erosion model this project's tectonics system has cited
// Cordonnier et al. (2016) for since docs/decisions/plate-tectonics-simulation.md.

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
  flowTarget: Int32Array
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
// map edge — this grid is a closed sphere with no edge to drain off of,
// so the ocean itself plays the role a map's border plays in the classic
// (bounded-tile) priority-flood algorithm (Barnes, Lehman & Mulla 2014).
// Uses the "epsilon-flood" variant (each newly-flooded cell gets
// max(raw, filled[source]) + a tiny epsilon) so flow direction is
// well-defined *everywhere*, including across a filled lake surface,
// without a separate flat-drainage resolution pass — the tradeoff is
// that flow across a lake reads as "radiate outward from wherever the
// flood first touched it" rather than a single true outlet fan; the
// outlet point/elevation itself (what a later lakes pass actually needs)
// is unaffected by that simplification.
//
// If there are zero cells at or below seaLevel (a fully continental
// world — possible with an extreme land/ocean ratio, not expected in
// practice), nothing gets seeded, poppedCount stays 0, and every
// flowTarget stays -1 — a graceful no-routing degradation rather than a
// crash.
export function fillDepressionsAndRouteFlow(
  raw: Float32Array,
  width: number,
  height: number,
  seaLevel: number,
  onProgress?: (fraction: number) => void,
): FlowRouting {
  const cellCount = width * height
  const filled = new Float32Array(cellCount)
  const flowTarget = new Int32Array(cellCount).fill(-1)
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
    if (onProgress && poppedCount % progressStep === 0) onProgress(poppedCount / cellCount)

    const y = (current / width) | 0
    const x = current - y * width
    for (const [dx, dy] of D8_OFFSETS) {
      const neighbor = d8Neighbor(x, y, dx, dy, width, height)
      if (neighbor === -1 || visited[neighbor]) continue
      visited[neighbor] = 1
      filled[neighbor] = Math.max(raw[neighbor], filled[current]) + EPSILON_FLOOD_STEP
      flowTarget[neighbor] = current
      heap.push(filled[neighbor], neighbor)
    }
  }

  onProgress?.(1)
  return { width, height, filled, flowTarget, popOrder, poppedCount }
}

// Drainage-area accumulation, area-weighted by cellAreaWeight (rows near
// the poles have the same column count as the equator but far less real
// surface area — unweighted accumulation would inflate polar drainage
// area from that projection artifact alone). Single O(cells) pass, no
// heap: walking popOrder in reverse visits every cell only after all of
// its own upstream contributors already have (see FlowRouting.popOrder).
export function accumulateFlow(routing: FlowRouting): Float32Array {
  const { width, height, flowTarget, popOrder, poppedCount } = routing
  const accumulation = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    const weight = cellAreaWeight(y, height)
    const rowBase = y * width
    for (let x = 0; x < width; x++) accumulation[rowBase + x] = weight
  }
  for (let i = poppedCount - 1; i >= 0; i--) {
    const cell = popOrder[i]
    const target = flowTarget[cell]
    if (target !== -1) accumulation[target] += accumulation[cell]
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

// erodibilityK calibrated via a headless dump script (dumping min/max/mean
// of the eroded field and its delta from the pre-stream-power filled
// surface) — an initial guess of 0.01 turned out to be roughly 300x too
// aggressive at this system's actual elevation/grid-spacing units (max
// relief collapsed from ~0.41 to ~0.001 within 100 iterations); 0.00003
// preserves the great majority of relief (mean |delta| ~0.003) while still
// visibly concentrating erosion at high-accumulation cells (max |delta|
// noticeably larger than the mean — river-mouth-like carving, not uniform
// sanding), which is the qualitative signature real stream-power erosion
// should have. Literature-typical exponents (m~0.5, n~1); iterations/
// timeStep are otherwise still starting points, not fully calibrated.
export const DEFAULT_STREAM_POWER_PARAMS: StreamPowerParams = {
  iterations: 100,
  erodibilityK: 0.00003,
  areaExponentM: 0.5,
  slopeExponentN: 1,
  timeStep: 1,
}

// Guards against rowHorizontalScale collapsing toward 0 near the poles
// (longitude lines converge there) and spiking slope for any nonzero
// elevation delta between adjacent-longitude cells at high latitude —
// without this floor, dh can blow up right at the poles regardless of
// how reasonable K/timeStep are elsewhere. Value is a starting guess, to
// be checked visually once real output exists, per the plan's own flag.
const MIN_HORIZONTAL_SCALE = 1e-3

// Mutates `elevations` in place, starting from FlowRouting.filled.
// flowTarget/accumulation are held fixed for the whole loop — recomputing
// full priority-flood every iteration is not viable at this grid size
// (see the perf notes in the implementation plan); only slope (and
// therefore dh) changes iteration to iteration. Ocean cells are excluded
// via isLand (derived from *raw*, not filled, elevation) so a river mouth
// doesn't carve an unphysical trench where accumulation peaks.
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
export function runStreamPowerIterations(
  elevations: Float32Array,
  routing: FlowRouting,
  accumulation: Float32Array,
  isLand: Uint8Array,
  rowHorizontalScale: Float32Array,
  width: number,
  height: number,
  params: StreamPowerParams,
  onProgress?: (fraction: number) => void,
): void {
  const { flowTarget, popOrder, poppedCount } = routing
  const verticalStep = Math.PI / height
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

      let dx = tx - x
      if (dx > width / 2) dx -= width
      else if (dx < -width / 2) dx += width
      const dy = ty - y

      const horizontalScale = Math.max(MIN_HORIZONTAL_SCALE, rowHorizontalScale[y])
      const horizontal = dx * horizontalScale
      const vertical = dy * verticalStep
      const distance = Math.max(1e-6, Math.sqrt(horizontal * horizontal + vertical * vertical))

      const slope = Math.max(0, (elevations[cell] - elevations[target]) / distance)
      const area = useSqrtForArea ? Math.sqrt(accumulation[cell]) : Math.pow(accumulation[cell], params.areaExponentM)
      const slopeTerm = slopeExponentIsOne ? slope : Math.pow(slope, params.slopeExponentN)

      const dh = -params.erodibilityK * area * slopeTerm
      elevations[cell] = Math.max(elevations[target], elevations[cell] + dh * params.timeStep)
    }
    onProgress?.((iteration + 1) / params.iterations)
  }
}

export type ErosionPhase = 'sampling' | 'flooding' | 'accumulating' | 'streamPower'

// The one function callers (the worker) actually need — chains elevation
// sampling through depression-filling/flow-routing, accumulation, and the
// stream-power loop. U (uplift) is not modeled here: the mountain-building
// already happened via crust.ts during the tectonic epochs, so this pass
// is pure denudation of that shape, not a coupled uplift/erosion balance.
export function runErosionPass(
  world: PlateWorld,
  crust: CrustState,
  width: number,
  height: number,
  params: StreamPowerParams = DEFAULT_STREAM_POWER_PARAMS,
  onProgress?: (phase: ErosionPhase, fraction: number) => void,
): { elevations: Float32Array; routing: FlowRouting; accumulation: Float32Array } {
  onProgress?.('sampling', 0)
  const field = generateElevationField(world, crust, width, height)
  onProgress?.('sampling', 1)

  const routing = fillDepressionsAndRouteFlow(field.elevations, width, height, SEA_LEVEL, (fraction) => onProgress?.('flooding', fraction))

  onProgress?.('accumulating', 0)
  const accumulation = accumulateFlow(routing)
  onProgress?.('accumulating', 1)

  const cellCount = width * height
  const isLand = new Uint8Array(cellCount)
  for (let i = 0; i < cellCount; i++) isLand[i] = field.elevations[i] > SEA_LEVEL ? 1 : 0

  const elevations = routing.filled.slice()
  const rowHorizontalScale = buildRowHorizontalScale(width, height)
  runStreamPowerIterations(elevations, routing, accumulation, isLand, rowHorizontalScale, width, height, params, (fraction) =>
    onProgress?.('streamPower', fraction),
  )

  return { elevations, routing, accumulation }
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
