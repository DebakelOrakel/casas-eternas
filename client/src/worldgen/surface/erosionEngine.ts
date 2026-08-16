import { MinHeap } from '../core/minHeap'
import {
  createEngineViews,
  ENGINE_STRIPS,
  EDGES_PER_STRIP_FACTOR,
  type EngineViews,
} from './erosionEngineState'

// EROSION V2 — the engine core (docs/design/erosion-v2.md, phase P2).
//
// A mass-conserving transient landscape engine: implicit stream power
// (Braun & Willett 2013, n=1, receiver-ordered), ξ–q sediment routing with
// discharge-dependent settling (Davy & Lague), Roering nonlinear hillslope
// diffusion, marine diffusion, and uplift toward a caller-supplied forcing
// field. Iterated for a FINITE number of steps — the landscape-age axis is
// the product (P0's central finding: a full equilibrium erases its initial
// condition; the transient from the real tectonic terrain is what keeps
// inherited relief).
//
// EXPERIMENT STATUS: not yet wired into the pipeline. v1 (erosion.ts) stays
// authoritative until the P2 switchover commit; scripts/erosion-v2-engine-check.mts
// gates this port byte-for-byte against the measured threading spike
// (scripts/erosion-v2-spike.mjs).
//
// SHAPE: every parallelisable phase is an exported KERNEL over an
// EngineViews state (erosionEngineState.ts) and an explicit row range or
// strip index — per-cell deterministic, no cross-range accumulation, so
// output is byte-identical for ANY worker count including one. The
// ErosionEngine class below is the single-threaded driver over the same
// kernels; erosionEnginePool.ts drives them across workers. The serial
// walks (border graph, λ, accumulation, fluvial, sediment) run on the
// coordinator in both modes — they are the measured wall the pipelined
// refresh will move OFF the iteration path, which is why refreshRouting
// reads only z and stepPhysics never touches what the refresh writes.
//
// The depression fill is the Barnes-style two-phase strip flood even when
// run single-threaded (per-strip floods + border spill graph + min-max
// Dijkstra + one corrected re-flood): the SAME algorithm at every worker
// count, so runs agree exactly. ENGINE_STRIPS is part of the result
// (epsilon chains are path-dependent) and never a function of the worker
// count.

export interface ErosionEngineParams {
  // Stream-power area exponent (with n=1: a scale-invariant pair).
  m: number
  // Fluvial coefficient per iteration ("dt·K" folded — time is arbitrary,
  // the age axis is iterations). Units: (km²)^-m per km of reach.
  kappaDt: number
  // Sub-grid drainage closure: every cell is fed by this much unresolved
  // catchment, so headwater slopes stop depending on the cell size
  // (P0: without it the fine grid stood +156 m systematically higher).
  baseAreaKm2: number
  // Uplift per iteration at forcing = 1, in normalized-z units.
  upliftDt: number
  // Settling: L = max(floor, xi·√Q[km²]) km on land, a short constant under
  // water. Q-dependence is not optional — a constant length shorter than a
  // couple of cells makes everything transport-limited (measured: blobs).
  settleXiKm: number
  settleFloorKm: number
  settleMarineKm: number
  // A delta plain aggrades to just above the waterline, then progrades.
  marineFreeboardM: number
  // Roering hillslope: physical diffusivity (km²/iteration) — the per-pair
  // exchange fraction is D/dx², so the term is scale-invariant.
  hillDiffKm2: number
  criticalSlope: number
  // Marine smoothing of fresh deposits, per iteration.
  marineDiffDt: number
  // Convergence: quasi-steady when the largest per-iteration change stays
  // under this (metres) for 3 consecutive iterations. The transient runs
  // to its AGE, not to convergence; this is the far end of the axis.
  epsM: number
}

// Function-argument defaults, like surface/'s other DEFAULT_*_PARAMS — not a
// tuning object yet; the slider mapping comes with the P2 switchover.
export const DEFAULT_ENGINE_PARAMS: ErosionEngineParams = {
  m: 0.5,
  kappaDt: 0.009,
  baseAreaKm2: 500,
  upliftDt: 2.2e-3,
  settleXiKm: 1.0,
  settleFloorKm: 20,
  settleMarineKm: 8,
  marineFreeboardM: 2,
  hillDiffKm2: 0.5,
  criticalSlope: 0.65,
  marineDiffDt: 0.25,
  epsM: 0.35,
}

// The forcing is assembled by the CALLER (the tectonics exports — see
// elevation/upliftField.ts and elevation/erodibilityField.ts). The engine
// is a pure solver; it does not know which world is meant.
export interface ErosionForcing {
  // Uplift pattern, one value per cell, multiplied by params.upliftDt.
  uplift: Float32Array
  // Erodibility multiplier per cell (lognormal K-contrast × the smooth
  // crust-history factor; 1 = neutral).
  erodibility: Float32Array
  // Cells allowed to receive uplift — the coastline pin (the initial land
  // mask). Omit to run unpinned, which the engine-check harness does.
  coastMask?: Uint8Array
}

const ELEVATION_METERS = 9000 // the repo's metre anchor: z 1.0 = 9000 m
const WORLD_WIDTH_METERS = 2048 * 7800
const EPSILON_FLOOD_STEP = 1e-7
const SQRT2 = Math.SQRT2
const QUARTER_TURN = Math.PI / 4
const D8: ReadonlyArray<readonly [number, number]> = [
  [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1],
]
const LTD_FACETS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 1, +1], [2, 1, -1], [2, 3, +1], [4, 3, -1],
  [4, 5, +1], [6, 5, -1], [6, 7, +1], [0, 7, -1],
]

export const FLAG_HAS_COAST_MASK = 0

// The subset of params the parallel kernels need (a plain object so the
// pool can structured-clone it to workers once).
export interface KernelParams {
  upliftDt: number
  hillDiffKm2: number
  criticalSlope: number
  marineDiffDt: number
  cellM: number
}

export function kernelParamsFor(width: number, params: ErosionEngineParams): KernelParams {
  return {
    upliftDt: params.upliftDt,
    hillDiffKm2: params.hillDiffKm2,
    criticalSlope: params.criticalSlope,
    marineDiffDt: params.marineDiffDt,
    cellM: WORLD_WIDTH_METERS / width,
  }
}

// Worker-local scratch for the strip floods — reused across strips and
// iterations, never shared.
export interface FloodScratch {
  visited: Uint8Array
  labels: Int32Array
  localFilled: Float32Array
  heap: MinHeap
}

export function createFloodScratch(width: number, height: number): FloodScratch {
  const capacity = (height / ENGINE_STRIPS + 2) * width
  return {
    visited: new Uint8Array(capacity),
    labels: new Int32Array(capacity),
    localFilled: new Float32Array(capacity),
    heap: new MinHeap(capacity),
  }
}

// ---------------------------------------------------------------------- flood

// Phase 1: flood one strip from its ocean cells and its two border rows at
// raw z (open boundary), each border cell its own label; record the min
// spill between differently-labelled regions into the strip's edge-buffer
// segment.
export function kernelFloodPhase1(v: EngineViews, width: number, height: number, strip: number, scratch: FloodScratch): void {
  const { z, seedMask, edgeA, edgeB, edgeW, edgeCount } = v
  const stripRows = height / ENGINE_STRIPS
  const gr0 = strip * stripRows
  const cap = stripRows * width
  const vis = scratch.visited
  vis.fill(0, 0, cap)
  const lab = scratch.labels
  const lf = scratch.localFilled
  const heap = scratch.heap
  const keyBase = 2 * width + 1
  for (let l = 0; l < stripRows; l++) {
    const g0 = (gr0 + l) * width
    const isBorder = l === 0 || l === stripRows - 1
    for (let x = 0; x < width; x++) {
      const local = l * width + x
      const g = g0 + x
      if (seedMask[g]) {
        lf[local] = z[g]
        lab[local] = -1 // ocean
        vis[local] = 1
        heap.push(lf[local], local)
      } else if (isBorder) {
        lf[local] = z[g]
        lab[local] = l === 0 ? x : width + x
        vis[local] = 1
        heap.push(lf[local], local)
      }
    }
  }
  const edges = new Map<number, number>()
  while (heap.length > 0) {
    heap.pop()
    const current = heap.poppedIndex
    const ly = (current / width) | 0
    const lx = current - ly * width
    const myLabel = lab[current]
    for (const [dx, dy] of D8) {
      const ny = ly + dy
      if (ny < 0 || ny >= stripRows) continue
      const nx = (lx + dx + width) % width
      const local = ny * width + nx
      if (vis[local]) {
        const otherLabel = lab[local]
        if (otherLabel !== myLabel) {
          const spill = Math.max(lf[current], lf[local])
          let a = myLabel
          let b = otherLabel
          if (a > b) { const t = a; a = b; b = t }
          const key = (a + 1) * keyBase + (b + 1)
          const prev = edges.get(key)
          if (prev === undefined || spill < prev) edges.set(key, spill)
        }
        continue
      }
      vis[local] = 1
      lab[local] = myLabel
      const g = (gr0 + ny) * width + nx
      const stepDistance = dx !== 0 && dy !== 0 ? SQRT2 : 1
      lf[local] = Math.max(z[g], lf[current]) + EPSILON_FLOOD_STEP * stepDistance
      heap.push(lf[local], local)
    }
  }
  const base = strip * EDGES_PER_STRIP_FACTOR * width
  const capEdges = EDGES_PER_STRIP_FACTOR * width
  let count = 0
  for (const [key, spill] of edges) {
    if (count >= capEdges) break // guard; far above planar reality
    const a = Math.floor(key / keyBase) - 1
    const b = (key % keyBase) - 1
    edgeA[base + count] = a < 0 ? -1 : strip * 2 * width + a
    edgeB[base + count] = strip * 2 * width + b
    edgeW[base + count] = spill
    count++
  }
  edgeCount[strip] = count
}

// Phase 2: flood one strip with its own borders and both ghost rows pinned
// to their true (Dijkstra) levels — one pass, exact. Writes filled + the
// strip's pop segment.
export function kernelFloodPhase2(v: EngineViews, width: number, height: number, strip: number, scratch: FloodScratch): void {
  const { z, seedMask, filled, borderFill, stripPopOrder, stripPopped } = v
  const stripRows = height / ENGINE_STRIPS
  const gr0 = strip * stripRows
  const gTop = (gr0 - 1 + height) % height
  const gBot = (gr0 + stripRows) % height
  const rowsL = stripRows + 2
  const globalRow = (l: number): number => (l === 0 ? gTop : l === rowsL - 1 ? gBot : gr0 + l - 1)
  const cap = rowsL * width
  const vis = scratch.visited
  vis.fill(0, 0, cap)
  const lf = scratch.localFilled
  const heap = scratch.heap
  const stripPrev = (strip - 1 + ENGINE_STRIPS) % ENGINE_STRIPS
  const stripNext = (strip + 1) % ENGINE_STRIPS
  for (const [l, nodeBase] of [[0, stripPrev * 2 * width + width], [rowsL - 1, stripNext * 2 * width]] as const) {
    for (let x = 0; x < width; x++) {
      const local = l * width + x
      vis[local] = 1 // ghosts: seeds only, never written
      const level = borderFill[nodeBase + x]
      if (level < Infinity) {
        lf[local] = level
        heap.push(level, local)
      }
    }
  }
  for (let l = 1; l < rowsL - 1; l++) {
    const g0 = globalRow(l) * width
    const isTop = l === 1
    const isBottom = l === rowsL - 2
    for (let x = 0; x < width; x++) {
      const local = l * width + x
      if (isTop || isBottom) {
        const level = borderFill[strip * 2 * width + (isTop ? x : width + x)]
        if (level < Infinity) {
          lf[local] = level
          vis[local] = 1
          heap.push(level, local)
        }
      } else if (seedMask[g0 + x]) {
        lf[local] = z[g0 + x]
        vis[local] = 1
        heap.push(lf[local], local)
      }
    }
  }
  let popped = 0
  const segBase = gr0 * width
  while (heap.length > 0) {
    heap.pop()
    const current = heap.poppedIndex
    const ly = (current / width) | 0
    const lx = current - ly * width
    if (ly > 0 && ly < rowsL - 1) {
      const g = globalRow(ly) * width + lx
      filled[g] = lf[current]
      stripPopOrder[segBase + popped++] = g
    }
    for (const [dx, dy] of D8) {
      const ny = ly + dy
      if (ny < 0 || ny >= rowsL) continue
      const nx = (lx + dx + width) % width
      const local = ny * width + nx
      if (vis[local]) continue
      vis[local] = 1
      const g = globalRow(ny) * width + nx
      const stepDistance = dx !== 0 && dy !== 0 ? SQRT2 : 1
      lf[local] = Math.max(z[g], lf[current]) + EPSILON_FLOOD_STEP * stepDistance
      heap.push(lf[local], local)
    }
  }
  for (let l = 1; l < rowsL - 1; l++) {
    const g0 = globalRow(l) * width
    for (let x = 0; x < width; x++) {
      if (!vis[l * width + x]) filled[g0 + x] = Infinity
    }
  }
  stripPopped[strip] = popped
}

// ------------------------------------------------------------------- scans

// Per-cell LTD facet scan (Orlandini 2003, D8-LTD — same method as
// flowRouting.computeLtdFlowTargets, split scan/walk so the scan runs
// per-cell parallel). Rows [r0, r1).
export function kernelLtdScan(v: EngineViews, width: number, height: number, r0: number, r1: number): void {
  const { filled, ltdCardinal, ltdDiagonal, ltdDeltaC, ltdDeltaD, ltdFallback, ltdMode } = v
  for (let y = r0; y < r1; y++) {
    for (let x = 0; x < width; x++) {
      const cell = y * width + x
      const own = filled[cell]
      let bestSlope = 0
      let bestFacet = -1
      let bestS1 = 0
      let bestS2 = 0
      let bestGradient = 0
      let fallback = -1
      let bestNc = -1
      let bestNd = -1
      for (let f = 0; f < 8; f++) {
        const facet = LTD_FACETS[f]
        const co = D8[facet[0]]
        const dd = D8[facet[1]]
        const nc = ((y + co[1] + height) % height) * width + ((x + co[0] + width) % width)
        const g1 = own - filled[nc]
        if (g1 > bestGradient) { bestGradient = g1; fallback = nc }
        const nd = ((y + dd[1] + height) % height) * width + ((x + dd[0] + width) % width)
        if (f % 2 === 0) {
          const g2 = (own - filled[nd]) / SQRT2
          if (g2 > bestGradient) { bestGradient = g2; fallback = nd }
        }
        const s1 = own - filled[nc]
        const s2 = filled[nc] - filled[nd]
        let slope: number
        if (s2 <= 0) slope = s1
        else if (s2 >= s1) slope = (own - filled[nd]) / SQRT2
        else slope = Math.hypot(s1, s2)
        if (slope > bestSlope) { bestSlope = slope; bestFacet = f; bestS1 = s1; bestS2 = s2; bestNc = nc; bestNd = nd }
      }
      ltdFallback[cell] = fallback
      if (bestFacet >= 0) {
        const orient = LTD_FACETS[bestFacet][2]
        const alpha = bestS2 <= 0 ? 0 : bestS2 >= bestS1 ? QUARTER_TURN : Math.atan2(bestS2, bestS1)
        ltdCardinal[cell] = bestNc
        ltdDiagonal[cell] = bestNd
        ltdDeltaC[cell] = -orient * Math.sin(alpha)
        ltdDeltaD[cell] = orient * SQRT2 * Math.sin(QUARTER_TURN - alpha)
        ltdMode[cell] = 4 | (filled[bestNc] < own ? 1 : 0) | (filled[bestNd] < own ? 2 : 0)
      } else {
        ltdMode[cell] = 0
      }
    }
  }
}

// MFD edges (Freeman/Quinn linear weighting), fixed stride-8. Rows [r0, r1).
export function kernelMfd(v: EngineViews, width: number, height: number, r0: number, r1: number): void {
  const { filled, mfdDegree, mfdDirection, mfdWeight } = v
  for (let y = r0; y < r1; y++) {
    for (let x = 0; x < width; x++) {
      const cell = y * width + x
      const own = filled[cell]
      const base = cell * 8
      let count = 0
      let weightSum = 0
      for (let dir = 0; dir < 8; dir++) {
        const offset = D8[dir]
        const neighbor = ((y + offset[1] + height) % height) * width + ((x + offset[0] + width) % width)
        const drop = own - filled[neighbor]
        if (drop <= 0) continue
        const weight = drop / (offset[0] !== 0 && offset[1] !== 0 ? SQRT2 : 1)
        mfdDirection[base + count] = dir
        mfdWeight[base + count] = weight
        weightSum += weight
        count++
      }
      for (let i = 0; i < count; i++) mfdWeight[base + i] /= weightSum
      mfdDegree[cell] = count
    }
  }
}

// ----------------------------------------------------------------- physics

// Uplift — the forcing half of the balance, pinned to the initial coast
// when the mask flag is set. Rows [r0, r1).
export function kernelUplift(v: EngineViews, width: number, r0: number, r1: number, kp: KernelParams): void {
  const { z, uplift, coastMask, flags } = v
  const hasMask = flags[FLAG_HAS_COAST_MASK] !== 0
  for (let i = r0 * width; i < r1 * width; i++) {
    if (z[i] > 0 && (!hasMask || coastMask[i])) z[i] += kp.upliftDt * uplift[i]
  }
}

// Roering hillslope diffusion, pass 1: each land cell's east/south moves.
export function kernelHillMoves(v: EngineViews, width: number, height: number, r0: number, r1: number, kp: KernelParams): void {
  const { z, moveEast, moveSouth } = v
  const cellKm2 = (kp.cellM / 1000) * (kp.cellM / 1000)
  for (let y = r0; y < r1; y++) {
    for (let x = 0; x < width; x++) {
      const cell = y * width + x
      let east = 0
      let south = 0
      if (z[cell] > 0) {
        const eastCell = y * width + ((x + 1) % width)
        const southCell = ((y + 1) % height) * width + x
        for (const [nb, isEast] of [[eastCell, 1], [southCell, 0]] as const) {
          const dz = z[cell] - z[nb]
          if (dz === 0) continue
          const slope = (Math.abs(dz) * ELEVATION_METERS) / kp.cellM
          const ratio = Math.min(0.95, slope / kp.criticalSlope)
          const boost = 1 / (1 - ratio * ratio)
          const fraction = Math.min(0.2, (kp.hillDiffKm2 / cellKm2) * Math.min(boost, 12))
          const move = fraction * dz
          if (isEast) east = move
          else south = move
        }
      }
      moveEast[cell] = east
      moveSouth[cell] = south
    }
  }
}

// Hillslope pass 2: combine own and incoming moves; track the residual in
// the caller's maxStepW slot.
export function kernelHillApply(v: EngineViews, width: number, height: number, r0: number, r1: number, workerId: number): void {
  const { z, moveEast, moveSouth, maxStepW } = v
  let maxStep = 0
  for (let y = r0; y < r1; y++) {
    const north = (y - 1 + height) % height
    for (let x = 0; x < width; x++) {
      const cell = y * width + x
      const west = y * width + ((x - 1 + width) % width)
      const delta = -(moveEast[cell] + moveSouth[cell]) + moveEast[west] + moveSouth[north * width + x]
      if (delta !== 0) {
        z[cell] += delta
        const step = Math.abs(delta)
        if (z[cell] > 0 && step > maxStep) maxStep = step
      }
    }
  }
  maxStepW[workerId] = maxStep
}

// Marine diffusion, pass 1: water-to-water east/south moves.
export function kernelMarineMoves(v: EngineViews, width: number, height: number, r0: number, r1: number, kp: KernelParams): void {
  const { z, moveEast, moveSouth } = v
  for (let y = r0; y < r1; y++) {
    for (let x = 0; x < width; x++) {
      const cell = y * width + x
      let east = 0
      let south = 0
      if (z[cell] <= 0) {
        const eastCell = y * width + ((x + 1) % width)
        const southCell = ((y + 1) % height) * width + x
        if (z[eastCell] <= 0) east = kp.marineDiffDt * (z[cell] - z[eastCell]) * 0.1
        if (z[southCell] <= 0) south = kp.marineDiffDt * (z[cell] - z[southCell]) * 0.1
      }
      moveEast[cell] = east
      moveSouth[cell] = south
    }
  }
}

// Marine pass 2: combine (no residual tracking — matches the P0 physics).
export function kernelMarineApply(v: EngineViews, width: number, height: number, r0: number, r1: number): void {
  const { z, moveEast, moveSouth } = v
  for (let y = r0; y < r1; y++) {
    const north = (y - 1 + height) % height
    for (let x = 0; x < width; x++) {
      const cell = y * width + x
      const west = y * width + ((x - 1 + width) % width)
      z[cell] += -(moveEast[cell] + moveSouth[cell]) + moveEast[west] + moveSouth[north * width + x]
    }
  }
}

// ------------------------------------------------- serial (coordinator) parts

// Scratch for everything that runs on the coordinator regardless of mode.
export interface CoordinatorScratch {
  componentLabel: Int32Array
  componentStack: Int32Array
  nodeDist: Float64Array
  nodeDeg: Int32Array
  graphHeap: MinHeap
  lambda: Float32Array
  contrib: Uint32Array
  bestInflow: Uint32Array
  flux: Float32Array
  donorMin: Float32Array
}

export function createCoordinatorScratch(width: number, height: number): CoordinatorScratch {
  const n = width * height
  return {
    componentLabel: new Int32Array(n),
    componentStack: new Int32Array(n),
    nodeDist: new Float64Array(2 * width * ENGINE_STRIPS),
    nodeDeg: new Int32Array(2 * width * ENGINE_STRIPS + 1),
    graphHeap: new MinHeap(2 * width * ENGINE_STRIPS),
    lambda: new Float32Array(n),
    contrib: new Uint32Array(n),
    bestInflow: new Uint32Array(n),
    flux: new Float32Array(n),
    donorMin: new Float32Array(n),
  }
}

// Mask of the largest 4-connected ≤0 component — the world ocean, the
// flood's only seed (an enclosed basin is a depression, not a sea; same
// rule as flowRouting's largestWaterComponent, 2026-08-06).
export function computeOceanSeed(v: EngineViews, width: number, height: number, s: CoordinatorScratch): boolean {
  const { z, seedMask } = v
  const n = width * height
  const label = s.componentLabel
  const stack = s.componentStack
  label.fill(-1)
  seedMask.fill(0)
  const sizes: number[] = []
  let sp = 0
  for (let start = 0; start < n; start++) {
    if (z[start] > 0 || label[start] !== -1) continue
    const id = sizes.length
    let size = 0
    stack[sp++] = start
    label[start] = id
    while (sp > 0) {
      const i = stack[--sp]
      size++
      const y = (i / width) | 0
      const x = i - y * width
      const neighbors = [
        y * width + ((x + 1) % width),
        y * width + ((x + width - 1) % width),
        ((y + 1) % height) * width + x,
        ((y + height - 1) % height) * width + x,
      ]
      for (const nb of neighbors) {
        if (z[nb] <= 0 && label[nb] === -1) {
          label[nb] = id
          stack[sp++] = nb
        }
      }
    }
    sizes.push(size)
  }
  if (sizes.length === 0) return false
  let best = 0
  for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[best]) best = i
  for (let i = 0; i < n; i++) if (label[i] === best) seedMask[i] = 1
  return true
}

// The global flood step: min-max Dijkstra from the ocean over the
// border-cell graph (collected spill edges + the structural adjacency
// between each strip's bottom row and the next strip's top row).
export function solveBorderGraph(v: EngineViews, width: number, height: number, s: CoordinatorScratch): void {
  const { z, seedMask, borderFill, edgeA, edgeB, edgeW, edgeCount } = v
  const stripRows = height / ENGINE_STRIPS
  const NN = ENGINE_STRIPS * 2 * width
  const dist = s.nodeDist
  const nodeDeg = s.nodeDeg
  const EC = EDGES_PER_STRIP_FACTOR * width
  nodeDeg.fill(0)
  let realEdges = 0
  for (let strip = 0; strip < ENGINE_STRIPS; strip++) {
    const base = strip * EC
    for (let e = 0; e < edgeCount[strip]; e++) {
      const a = edgeA[base + e]
      if (a < 0) continue
      nodeDeg[a + 1]++
      nodeDeg[edgeB[base + e] + 1]++
      realEdges++
    }
    for (let x = 0; x < width; x++) {
      const a = strip * 2 * width + width + x
      const t = (strip + 1) % ENGINE_STRIPS
      for (let dx = -1; dx <= 1; dx++) {
        nodeDeg[a + 1]++
        nodeDeg[t * 2 * width + ((x + dx + width) % width) + 1]++
        realEdges++
      }
    }
  }
  for (let i = 0; i < NN; i++) nodeDeg[i + 1] += nodeDeg[i]
  const adjacencyTo = new Int32Array(2 * realEdges)
  const adjacencyW = new Float64Array(2 * realEdges)
  const fill = nodeDeg.slice(0, NN)
  const addEdge = (a: number, b: number, weight: number): void => {
    adjacencyTo[fill[a]] = b
    adjacencyW[fill[a]++] = weight
    adjacencyTo[fill[b]] = a
    adjacencyW[fill[b]++] = weight
  }
  dist.fill(Infinity)
  const heap = s.graphHeap
  while (heap.length > 0) heap.pop() // defensive; always drained below
  for (let strip = 0; strip < ENGINE_STRIPS; strip++) {
    const base = strip * EC
    for (let e = 0; e < edgeCount[strip]; e++) {
      const a = edgeA[base + e]
      const b = edgeB[base + e]
      const weight = edgeW[base + e]
      if (a < 0) {
        if (weight < dist[b]) { dist[b] = weight; heap.push(weight, b) }
      } else {
        addEdge(a, b, weight)
      }
    }
    const rowA = ((strip + 1) * stripRows - 1) * width
    const t = (strip + 1) % ENGINE_STRIPS
    const rowB = t * stripRows * width
    for (let x = 0; x < width; x++) {
      const a = strip * 2 * width + width + x
      const za = z[rowA + x]
      for (let dx = -1; dx <= 1; dx++) {
        const xb = (x + dx + width) % width
        addEdge(a, t * 2 * width + xb, Math.max(za, z[rowB + xb]))
      }
    }
    const topRow = strip * stripRows * width
    for (let x = 0; x < width; x++) {
      if (seedMask[topRow + x]) {
        const node = strip * 2 * width + x
        const zv = z[topRow + x]
        if (zv < dist[node]) { dist[node] = zv; heap.push(zv, node) }
      }
      if (seedMask[rowA + x]) {
        const node = strip * 2 * width + width + x
        const zv = z[rowA + x]
        if (zv < dist[node]) { dist[node] = zv; heap.push(zv, node) }
      }
    }
  }
  while (heap.length > 0) {
    heap.pop()
    const key = heap.poppedKey
    const u = heap.poppedIndex
    if (key > dist[u]) continue
    for (let e = nodeDeg[u]; e < fill[u]; e++) {
      const target = adjacencyTo[e]
      const candidate = Math.max(key, adjacencyW[e])
      if (candidate < dist[target]) { dist[target] = candidate; heap.push(candidate, target) }
    }
  }
  for (let strip = 0; strip < ENGINE_STRIPS; strip++) {
    const topRow = strip * stripRows * width
    const bottomRow = ((strip + 1) * stripRows - 1) * width
    for (let x = 0; x < width; x++) {
      const a = strip * 2 * width + x
      const b = strip * 2 * width + width + x
      borderFill[a] = dist[a] === Infinity ? Infinity : Math.max(z[topRow + x], dist[a])
      borderFill[b] = dist[b] === Infinity ? Infinity : Math.max(z[bottomRow + x], dist[b])
    }
  }
}

// Merge the per-strip pop segments (each sorted by filled) into the global
// topological order (views.popOrder). Any filled-ascending order is valid
// for every walk: receivers are STRICTLY lower in filled.
export function mergePopOrder(v: EngineViews, width: number, height: number): number {
  const { filled, stripPopOrder, stripPopped } = v
  const stripRows = height / ENGINE_STRIPS
  const heads = new Int32Array(ENGINE_STRIPS)
  let total = 0
  for (let strip = 0; strip < ENGINE_STRIPS; strip++) total += stripPopped[strip]
  const out = v.popOrder
  for (let k = 0; k < total; k++) {
    let best = -1
    let bestKey = Infinity
    for (let strip = 0; strip < ENGINE_STRIPS; strip++) {
      const head = heads[strip]
      if (head >= stripPopped[strip]) continue
      const key = filled[stripPopOrder[strip * stripRows * width + head]]
      if (key < bestKey) { bestKey = key; best = strip }
    }
    out[k] = stripPopOrder[best * stripRows * width + heads[best]++]
  }
  return total
}

// The λ-walk: choose each cell's receiver to minimise the accumulated
// transverse deviation, inheriting λ from the largest contributor at
// confluences. Serial by nature (popOrder backward).
export function lambdaWalk(v: EngineViews, popped: number, s: CoordinatorScratch): void {
  const { flowTarget, ltdCardinal, ltdDiagonal, ltdDeltaC, ltdDeltaD, ltdFallback, ltdMode, popOrder } = v
  const { lambda, contrib, bestInflow } = s
  flowTarget.fill(-1)
  lambda.fill(0)
  contrib.fill(0)
  bestInflow.fill(0)
  for (let i = popped - 1; i >= 0; i--) {
    const cell = popOrder[i]
    let target = ltdFallback[cell]
    let delta = 0
    const mode = ltdMode[cell]
    if (mode & 4) {
      const cardinalDown = (mode & 1) !== 0
      const diagonalDown = (mode & 2) !== 0
      if (cardinalDown && diagonalDown) {
        const lam = lambda[cell]
        if (Math.abs(lam + ltdDeltaC[cell]) <= Math.abs(lam + ltdDeltaD[cell])) {
          target = ltdCardinal[cell]
          delta = ltdDeltaC[cell]
        } else {
          target = ltdDiagonal[cell]
          delta = ltdDeltaD[cell]
        }
      } else if (cardinalDown) { target = ltdCardinal[cell]; delta = ltdDeltaC[cell] }
      else if (diagonalDown) { target = ltdDiagonal[cell]; delta = ltdDeltaD[cell] }
    }
    flowTarget[cell] = target
    if (target < 0) continue
    const area = contrib[cell] + 1
    contrib[target] += area
    if (area > bestInflow[target]) {
      bestInflow[target] = area
      lambda[target] = lambda[cell] + delta
    }
  }
}

// Drainage-area accumulation over the MFD edges, popOrder backward.
export function accumulateFlowV2(v: EngineViews, width: number, height: number, popped: number): void {
  const { accumulation, mfdDegree, mfdDirection, mfdWeight, popOrder } = v
  accumulation.fill(1)
  for (let i = popped - 1; i >= 0; i--) {
    const cell = popOrder[i]
    const amount = accumulation[cell]
    const x = cell % width
    const y = (cell - x) / width
    const base = cell * 8
    const degree = mfdDegree[cell]
    for (let e = 0; e < degree; e++) {
      const offset = D8[mfdDirection[base + e]]
      accumulation[((y + offset[1] + height) % height) * width + ((x + offset[0] + width) % width)] += amount * mfdWeight[base + e]
    }
  }
}

// Implicit stream power, receiver-first (popOrder forward): z' = (z +
// F·z'_receiver)/(1 + F), only where the receiver is LOWER in raw z —
// inside a filled depression routing runs uphill over the fill, and the
// implicit form would PULL the cell up: a lake bed does not erode. Returns
// the phase residual (normalized units).
export function fluvialWalk(v: EngineViews, width: number, popped: number, params: ErosionEngineParams): number {
  const { z, flowTarget, accumulation, erodibility, erosionVolume, popOrder } = v
  const cellM = WORLD_WIDTH_METERS / width
  const cellKm2 = (cellM / 1000) * (cellM / 1000)
  let maxStep = 0
  for (let i = 0; i < popped; i++) {
    const cell = popOrder[i]
    erosionVolume[cell] = 0
    const old = z[cell]
    if (old <= 0) continue
    const target = flowTarget[cell]
    if (target < 0) continue
    const zr = z[target]
    if (zr >= old) continue
    const x = cell % width
    const tx = target % width
    let ddx = Math.abs(tx - x)
    if (ddx > 1) ddx = 1
    let ddy = Math.abs((target - tx) / width - (cell - x) / width)
    if (ddy > 1) ddy = 1
    const distKm = (cellM / 1000) * (ddx && ddy ? SQRT2 : 1)
    const dischargeKm2 = accumulation[cell] * cellKm2 + params.baseAreaKm2
    const F = (params.kappaDt * erodibility[cell] * Math.pow(dischargeKm2, params.m)) / distKm
    const znew = (old + F * zr) / (1 + F)
    const cut = old - znew
    z[cell] = znew
    erosionVolume[cell] = cut * ELEVATION_METERS * cellKm2 * 1e6
    if (cut > maxStep) maxStep = cut
  }
  return maxStep
}

// ξ–q sediment routing, donor-first (popOrder backward): flux hands
// downstream, a reach-integrated fraction settles, capped by the donor
// floor (no deposit may dam the valley that feeds it) and, under water, by
// the freeboard (a delta aggrades to the surface, then progrades). Returns
// the phase residual (normalized units).
export function sedimentWalk(v: EngineViews, width: number, popped: number, params: ErosionEngineParams, s: CoordinatorScratch): number {
  const { z, flowTarget, accumulation, erosionVolume, popOrder } = v
  const { flux, donorMin } = s
  const cellM = WORLD_WIDTH_METERS / width
  const cellKm2 = (cellM / 1000) * (cellM / 1000)
  let maxStep = 0
  flux.fill(0)
  donorMin.fill(Infinity)
  for (let i = popped - 1; i >= 0; i--) {
    const cell = popOrder[i]
    const target = flowTarget[cell]
    let carrying = flux[cell] + erosionVolume[cell]
    if (carrying > 0) {
      const land = z[cell] > 0
      const settle = land
        ? Math.max(params.settleFloorKm, params.settleXiKm * Math.sqrt(accumulation[cell] * cellKm2 + params.baseAreaKm2))
        : params.settleMarineKm
      // Exact exponential integration over the reach — scale-consistent
      // for any dx/L, where a clamped linear fraction was not.
      const dropFraction = 1 - Math.exp(-(cellM / 1000) / settle)
      let deposit = carrying * dropFraction
      const donorCap = donorMin[cell] - 1e-5
      const cap = land ? donorCap : Math.min(donorCap, params.marineFreeboardM / ELEVATION_METERS)
      const room = (cap - z[cell]) * ELEVATION_METERS * cellKm2 * 1e6
      if (deposit > room) deposit = Math.max(0, room)
      // Per-iteration cap: numerics, not physics — a prograding delta
      // front otherwise advances one violent cell per iteration.
      const capM3 = (land ? 10 : 30) * cellKm2 * 1e6
      if (deposit > capM3) deposit = capM3
      if (deposit > 0) {
        const dz = deposit / (ELEVATION_METERS * cellKm2 * 1e6)
        z[cell] += dz
        carrying -= deposit
        if (land && dz > maxStep) maxStep = dz
      }
    }
    if (target >= 0) {
      flux[target] += carrying
      if (z[cell] < donorMin[target]) donorMin[target] = z[cell]
    }
  }
  return maxStep
}

// ------------------------------------------------------------------ driver

// The single-threaded engine: the same kernels the pool runs, called in
// sequence over full ranges. Byte-identical to any pooled run.
export class ErosionEngine {
  readonly width: number
  readonly height: number
  readonly params: ErosionEngineParams
  readonly views: EngineViews
  poppedCount = 0

  private readonly scratch: CoordinatorScratch
  private readonly floodScratch: FloodScratch
  private readonly kernelParams: KernelParams

  constructor(
    width: number,
    height: number,
    initial: Float32Array,
    forcing: ErosionForcing,
    params: ErosionEngineParams = DEFAULT_ENGINE_PARAMS,
  ) {
    if (height % ENGINE_STRIPS !== 0) throw new Error(`height ${height} not divisible by ${ENGINE_STRIPS} strips`)
    const n = width * height
    if (initial.length !== n || forcing.uplift.length !== n || forcing.erodibility.length !== n) {
      throw new Error('field size mismatch')
    }
    this.width = width
    this.height = height
    this.params = params
    this.views = createEngineViews(width, height)
    // Copied, not aliased — same contract as runErosionPass: the caller's
    // arrays must not be reshaped as a side effect.
    this.views.z.set(initial)
    this.views.uplift.set(forcing.uplift)
    this.views.erodibility.set(forcing.erodibility)
    if (forcing.coastMask) {
      this.views.coastMask.set(forcing.coastMask)
      this.views.flags[FLAG_HAS_COAST_MASK] = 1
    }
    this.scratch = createCoordinatorScratch(width, height)
    this.floodScratch = createFloodScratch(width, height)
    this.kernelParams = kernelParamsFor(width, params)
  }

  // The evolving terrain (normalized z, mutated in place by stepPhysics).
  get z(): Float32Array {
    return this.views.z
  }

  get filled(): Float32Array {
    return this.views.filled
  }

  get flowTarget(): Int32Array {
    return this.views.flowTarget
  }

  get accumulation(): Float32Array {
    return this.views.accumulation
  }

  get popOrder(): Int32Array {
    return this.views.popOrder
  }

  // Recompute the whole routing state from the current z. Reads z only;
  // writes only routing state — the one-way split the pipelined refresh
  // depends on.
  refreshRouting(): void {
    if (!computeOceanSeed(this.views, this.width, this.height, this.scratch)) {
      // A fully continental world: no drain, no routing — the same graceful
      // degradation as flowRouting.
      this.poppedCount = 0
      this.views.flowTarget.fill(-1)
      this.views.accumulation.fill(1)
      return
    }
    for (let strip = 0; strip < ENGINE_STRIPS; strip++) kernelFloodPhase1(this.views, this.width, this.height, strip, this.floodScratch)
    solveBorderGraph(this.views, this.width, this.height, this.scratch)
    for (let strip = 0; strip < ENGINE_STRIPS; strip++) kernelFloodPhase2(this.views, this.width, this.height, strip, this.floodScratch)
    this.poppedCount = mergePopOrder(this.views, this.width, this.height)
    kernelLtdScan(this.views, this.width, this.height, 0, this.height)
    lambdaWalk(this.views, this.poppedCount, this.scratch)
    kernelMfd(this.views, this.width, this.height, 0, this.height)
    accumulateFlowV2(this.views, this.width, this.height, this.poppedCount)
  }

  // One physics iteration on the current routing. Returns the residual: the
  // largest land elevation change, in metres.
  stepPhysics(): number {
    let maxStep = 0
    kernelUplift(this.views, this.width, 0, this.height, this.kernelParams)
    maxStep = Math.max(maxStep, fluvialWalk(this.views, this.width, this.poppedCount, this.params))
    maxStep = Math.max(maxStep, sedimentWalk(this.views, this.width, this.poppedCount, this.params, this.scratch))
    kernelHillMoves(this.views, this.width, this.height, 0, this.height, this.kernelParams)
    kernelHillApply(this.views, this.width, this.height, 0, this.height, 0)
    maxStep = Math.max(maxStep, this.views.maxStepW[0])
    kernelMarineMoves(this.views, this.width, this.height, 0, this.height, this.kernelParams)
    kernelMarineApply(this.views, this.width, this.height, 0, this.height)
    return maxStep * ELEVATION_METERS
  }

  // Run the transient: `iterations` IS the landscape age. Routing refreshes
  // every `routingEvery` iterations (K ≤ 8 validated). Stops early only at
  // quasi-steady state (3 consecutive residuals under epsM) — the far end
  // of the age axis, not the goal.
  run(iterations: number, routingEvery = 4, onIteration?: (iteration: number, residualM: number) => void): number {
    let residual = Infinity
    let calmStreak = 0
    for (let i = 0; i < iterations; i++) {
      if (i % routingEvery === 0) this.refreshRouting()
      residual = this.stepPhysics()
      calmStreak = residual < this.params.epsM ? calmStreak + 1 : 0
      onIteration?.(i, residual)
      if (calmStreak >= 3) break
    }
    return residual
  }
}
