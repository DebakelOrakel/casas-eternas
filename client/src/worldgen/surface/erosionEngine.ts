import { MinHeap } from '../core/minHeap'

// EROSION V2 — the engine core (docs/design/erosion-v2.md, phase P2).
//
// A mass-conserving transient landscape engine: implicit stream power
// (Braun & Willett 2013, n=1, receiver-ordered), ξ–q sediment routing with
// discharge-dependent settling (Davy & Lague), Roering nonlinear hillslope
// diffusion, marine diffusion, and uplift toward a caller-supplied forcing
// field. Iterated for a FINITE number of steps — the landscape-age axis is
// the product (P0's central finding: a full equilibrium erases its initial
// condition; the transient from the real tectonic terrain is what keeps
// inherited relief). Verified at P2 kickoff: age 25 at 2048 keeps 39-km
// relief at 541 m median with dendritic texture, age 400 is the blob
// equilibrium.
//
// EXPERIMENT STATUS: not yet wired into the pipeline. v1 (erosion.ts) stays
// authoritative until the P2 switchover commit; scripts/erosion-v2-engine-check.mts
// gates this port byte-for-byte against the measured threading spike
// (scripts/erosion-v2-spike.mjs).
//
// Structure, deliberately split for the P1 threading design:
//   refreshRouting()  reads z, writes the routing state (filled, receivers,
//                     MFD edges, accumulation, topological order) — nothing
//                     the physics step writes.
//   stepPhysics()     reads the routing state, writes z (and its own
//                     scratch) — nothing the routing refresh writes.
// That one-way split is what lets a refresh run CONCURRENTLY with physics
// iterations later (the pipelined refresh, the P2 answer to the measured
// serial wall); stale routing between refreshes is validated physics — at
// K ≤ 8 the field moves only within the capture-flicker class.
//
// The depression fill is the Barnes-style two-phase strip flood even when
// run single-threaded: per-strip floods + a border spill graph + min-max
// Dijkstra + one corrected re-flood. Slower serially than one global heap
// flood (~2×), chosen anyway because it is the SAME algorithm the worker
// pool runs — output is byte-identical whatever the thread count, so
// single-threaded runs, tests and bakes all agree exactly. STRIPS is part
// of the result (epsilon chains are path-dependent) and must never depend
// on the worker count.

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

// The forcing is assembled by the CALLER (eventually: exported by the
// tectonics stage — the U fork). The engine is a pure solver; it does not
// know which world is meant.
export interface ErosionForcing {
  // Uplift pattern, one value per cell, multiplied by params.upliftDt.
  uplift: Float32Array
  // Erodibility multiplier per cell (lognormal K-contrast; 1 = neutral).
  erodibility: Float32Array
  // Cells allowed to receive uplift — the coastline pin. Without it a free
  // transient grows land (measured 28.0 → 29.5 % over age 25 → 400): fresh
  // marine deposits become "land", start receiving uplift, and the coast
  // walks seaward. Pass the INITIAL land mask so uplift never reaches
  // ground the macro called sea; deltas still grow by deposition alone,
  // which is the sanctioned mechanism. Omit to reproduce the unpinned
  // prototype exactly (the engine-check harness does).
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
// Fixed strip count for the two-phase flood — part of the RESULT, never a
// function of the worker count (see the module comment).
const STRIPS = 16

export class ErosionEngine {
  readonly width: number
  readonly height: number
  readonly params: ErosionEngineParams
  // The evolving terrain, normalized z (1.0 = 9000 m). Mutated in place by
  // stepPhysics; callers snapshot what they need.
  readonly z: Float32Array
  // Routing state (all owned by refreshRouting).
  readonly filled: Float32Array
  readonly flowTarget: Int32Array
  readonly accumulation: Float32Array
  readonly popOrder: Int32Array
  poppedCount = 0

  private readonly forcing: ErosionForcing
  private readonly cellM: number
  private readonly cellKm2: number
  private readonly n: number

  // --- routing scratch
  private readonly seedMask: Uint8Array
  private readonly componentLabel: Int32Array
  private readonly componentStack: Int32Array
  private readonly stripPopOrder: Int32Array
  private readonly stripPopped = new Int32Array(STRIPS)
  private readonly borderFill: Float32Array
  private readonly nodeDist: Float64Array
  private readonly nodeDeg: Int32Array
  private readonly lambda: Float32Array
  private readonly contrib: Uint32Array
  private readonly bestInflow: Uint32Array
  private readonly ltdCardinal: Int32Array
  private readonly ltdDiagonal: Int32Array
  private readonly ltdDeltaC: Float32Array
  private readonly ltdDeltaD: Float32Array
  private readonly ltdFallback: Int32Array
  private readonly ltdMode: Uint8Array
  // MFD in fixed stride-8 layout: no prefix sum, and the parallel port
  // writes it without coordination.
  private readonly mfdDegree: Uint8Array
  private readonly mfdDirection: Uint8Array
  private readonly mfdWeight: Float32Array
  // Per-strip flood scratch, sized for one strip + two ghost rows.
  private readonly stripVisited: Uint8Array
  private readonly stripLabel: Int32Array
  private readonly stripFilled: Float32Array
  private readonly stripHeap: MinHeap
  private readonly graphHeap: MinHeap

  // --- physics scratch
  private readonly erosionVolume: Float32Array
  private readonly flux: Float32Array
  private readonly donorMin: Float32Array
  private readonly moveEast: Float32Array
  private readonly moveSouth: Float32Array

  constructor(
    width: number,
    height: number,
    initial: Float32Array,
    forcing: ErosionForcing,
    params: ErosionEngineParams = DEFAULT_ENGINE_PARAMS,
  ) {
    if (height % STRIPS !== 0) throw new Error(`height ${height} not divisible by ${STRIPS} strips`)
    const n = width * height
    if (initial.length !== n || forcing.uplift.length !== n || forcing.erodibility.length !== n) {
      throw new Error('field size mismatch')
    }
    this.width = width
    this.height = height
    this.n = n
    this.params = params
    this.forcing = forcing
    this.cellM = WORLD_WIDTH_METERS / width
    this.cellKm2 = (this.cellM / 1000) * (this.cellM / 1000)
    // Copied, not aliased — same contract as runErosionPass: the caller's
    // array must not be reshaped as a side effect.
    this.z = initial.slice()
    this.filled = new Float32Array(n)
    this.flowTarget = new Int32Array(n)
    this.accumulation = new Float32Array(n)
    this.popOrder = new Int32Array(n)
    this.seedMask = new Uint8Array(n)
    this.componentLabel = new Int32Array(n)
    this.componentStack = new Int32Array(n)
    this.stripPopOrder = new Int32Array(n)
    this.borderFill = new Float32Array(2 * width * STRIPS)
    this.nodeDist = new Float64Array(2 * width * STRIPS)
    this.nodeDeg = new Int32Array(2 * width * STRIPS + 1)
    this.lambda = new Float32Array(n)
    this.contrib = new Uint32Array(n)
    this.bestInflow = new Uint32Array(n)
    this.ltdCardinal = new Int32Array(n)
    this.ltdDiagonal = new Int32Array(n)
    this.ltdDeltaC = new Float32Array(n)
    this.ltdDeltaD = new Float32Array(n)
    this.ltdFallback = new Int32Array(n)
    this.ltdMode = new Uint8Array(n)
    this.mfdDegree = new Uint8Array(n)
    this.mfdDirection = new Uint8Array(8 * n)
    this.mfdWeight = new Float32Array(8 * n)
    const stripCap = (height / STRIPS + 2) * width
    this.stripVisited = new Uint8Array(stripCap)
    this.stripLabel = new Int32Array(stripCap)
    this.stripFilled = new Float32Array(stripCap)
    this.stripHeap = new MinHeap(stripCap)
    this.graphHeap = new MinHeap(2 * width * STRIPS)
    this.erosionVolume = new Float32Array(n)
    this.flux = new Float32Array(n)
    this.donorMin = new Float32Array(n)
    this.moveEast = new Float32Array(n)
    this.moveSouth = new Float32Array(n)
  }

  // ------------------------------------------------------------------ routing

  // Mask of the largest 4-connected ≤0 component — the world ocean, the
  // flood's only seed (an enclosed basin is a depression, not a sea; same
  // rule as flowRouting's largestWaterComponent, 2026-08-06).
  private computeOceanSeed(): boolean {
    const { z, width: w, height: h, n, componentLabel: label, componentStack: stack, seedMask } = this
    label.fill(-1)
    seedMask.fill(0)
    const sizes: number[] = []
    let sp = 0
    for (let s = 0; s < n; s++) {
      if (z[s] > 0 || label[s] !== -1) continue
      const id = sizes.length
      let size = 0
      stack[sp++] = s
      label[s] = id
      while (sp > 0) {
        const i = stack[--sp]
        size++
        const y = (i / w) | 0
        const x = i - y * w
        const neighbors = [
          y * w + ((x + 1) % w),
          y * w + ((x + w - 1) % w),
          ((y + 1) % h) * w + x,
          ((y + h - 1) % h) * w + x,
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

  // Phase 1: flood one strip from its ocean cells and its two border rows at
  // raw z (open boundary), each border cell its own label; record the min
  // spill between differently-labelled regions.
  private floodPhase1(strip: number, edges: Map<number, number>): void {
    const { z, seedMask, width: w, height: h } = this
    const stripRows = h / STRIPS
    const gr0 = strip * stripRows
    const cap = stripRows * w
    const vis = this.stripVisited
    vis.fill(0, 0, cap)
    const lab = this.stripLabel
    const lf = this.stripFilled
    const heap = this.stripHeap
    const keyBase = 2 * w + 1
    edges.clear()
    for (let l = 0; l < stripRows; l++) {
      const g0 = (gr0 + l) * w
      const isBorder = l === 0 || l === stripRows - 1
      for (let x = 0; x < w; x++) {
        const local = l * w + x
        const g = g0 + x
        if (seedMask[g]) {
          lf[local] = z[g]
          lab[local] = -1 // ocean
          vis[local] = 1
          heap.push(lf[local], local)
        } else if (isBorder) {
          lf[local] = z[g]
          lab[local] = l === 0 ? x : w + x
          vis[local] = 1
          heap.push(lf[local], local)
        }
      }
    }
    while (heap.length > 0) {
      heap.pop()
      const current = heap.poppedIndex
      const ly = (current / w) | 0
      const lx = current - ly * w
      const myLabel = lab[current]
      for (const [dx, dy] of D8) {
        const ny = ly + dy
        if (ny < 0 || ny >= stripRows) continue
        const nx = (lx + dx + w) % w
        const local = ny * w + nx
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
        const g = (gr0 + ny) * w + nx
        const stepDistance = dx !== 0 && dy !== 0 ? SQRT2 : 1
        lf[local] = Math.max(z[g], lf[current]) + EPSILON_FLOOD_STEP * stepDistance
        heap.push(lf[local], local)
      }
    }
  }

  // The global step: min-max Dijkstra from the ocean over the border-cell
  // graph (collected spill edges + the structural adjacency between each
  // strip's bottom row and the next strip's top row).
  private solveBorderGraph(stripEdges: Map<number, number>[]): void {
    const { z, seedMask, width: w, height: h, nodeDist: dist, nodeDeg, borderFill } = this
    const stripRows = h / STRIPS
    const NN = STRIPS * 2 * w
    const keyBase = 2 * w + 1
    // Degrees (ocean edges — label -1 — become Dijkstra seeds, not edges).
    nodeDeg.fill(0)
    let realEdges = 0
    for (let s = 0; s < STRIPS; s++) {
      for (const key of stripEdges[s].keys()) {
        const a = Math.floor(key / keyBase) - 1
        if (a < 0) continue
        const b = (key % keyBase) - 1
        nodeDeg[s * 2 * w + a + 1]++
        nodeDeg[s * 2 * w + b + 1]++
        realEdges++
      }
      for (let x = 0; x < w; x++) {
        const a = s * 2 * w + w + x
        const t = (s + 1) % STRIPS
        for (let dx = -1; dx <= 1; dx++) {
          nodeDeg[a + 1]++
          nodeDeg[t * 2 * w + ((x + dx + w) % w) + 1]++
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
    const heap = this.graphHeap
    while (heap.length > 0) heap.pop() // defensive; always drained below
    for (let s = 0; s < STRIPS; s++) {
      for (const [key, weight] of stripEdges[s]) {
        const a = Math.floor(key / keyBase) - 1
        const b = (key % keyBase) - 1
        if (a < 0) {
          const node = s * 2 * w + b
          if (weight < dist[node]) { dist[node] = weight; heap.push(weight, node) }
        } else {
          addEdge(s * 2 * w + a, s * 2 * w + b, weight)
        }
      }
      const rowA = ((s + 1) * stripRows - 1) * w
      const t = (s + 1) % STRIPS
      const rowB = t * stripRows * w
      for (let x = 0; x < w; x++) {
        const a = s * 2 * w + w + x
        const za = z[rowA + x]
        for (let dx = -1; dx <= 1; dx++) {
          const xb = (x + dx + w) % w
          addEdge(a, t * 2 * w + xb, Math.max(za, z[rowB + xb]))
        }
      }
      // Border cells that are ocean sit at the drain itself.
      const topRow = s * stripRows * w
      for (let x = 0; x < w; x++) {
        if (seedMask[topRow + x]) {
          const node = s * 2 * w + x
          const zv = z[topRow + x]
          if (zv < dist[node]) { dist[node] = zv; heap.push(zv, node) }
        }
        if (seedMask[rowA + x]) {
          const node = s * 2 * w + w + x
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
        const v = adjacencyTo[e]
        const candidate = Math.max(key, adjacencyW[e])
        if (candidate < dist[v]) { dist[v] = candidate; heap.push(candidate, v) }
      }
    }
    for (let s = 0; s < STRIPS; s++) {
      const topRow = s * stripRows * w
      const bottomRow = ((s + 1) * stripRows - 1) * w
      for (let x = 0; x < w; x++) {
        const a = s * 2 * w + x
        const b = s * 2 * w + w + x
        borderFill[a] = dist[a] === Infinity ? Infinity : Math.max(z[topRow + x], dist[a])
        borderFill[b] = dist[b] === Infinity ? Infinity : Math.max(z[bottomRow + x], dist[b])
      }
    }
  }

  // Phase 2: flood one strip with its own borders and both ghost rows pinned
  // to their true levels — one pass, exact. Writes filled + the strip's pop
  // segment.
  private floodPhase2(strip: number): void {
    const { z, seedMask, filled, width: w, height: h, borderFill, stripPopOrder } = this
    const stripRows = h / STRIPS
    const gr0 = strip * stripRows
    const gTop = (gr0 - 1 + h) % h
    const gBot = (gr0 + stripRows) % h
    const rowsL = stripRows + 2
    const globalRow = (l: number): number => (l === 0 ? gTop : l === rowsL - 1 ? gBot : gr0 + l - 1)
    const cap = rowsL * w
    const vis = this.stripVisited
    vis.fill(0, 0, cap)
    const lf = this.stripFilled
    const heap = this.stripHeap
    const stripPrev = (strip - 1 + STRIPS) % STRIPS
    const stripNext = (strip + 1) % STRIPS
    for (const [l, nodeBase] of [[0, stripPrev * 2 * w + w], [rowsL - 1, stripNext * 2 * w]] as const) {
      for (let x = 0; x < w; x++) {
        const local = l * w + x
        vis[local] = 1 // ghosts: seeds only, never written
        const level = borderFill[nodeBase + x]
        if (level < Infinity) {
          lf[local] = level
          heap.push(level, local)
        }
      }
    }
    for (let l = 1; l < rowsL - 1; l++) {
      const g0 = globalRow(l) * w
      const isTop = l === 1
      const isBottom = l === rowsL - 2
      for (let x = 0; x < w; x++) {
        const local = l * w + x
        if (isTop || isBottom) {
          const level = borderFill[strip * 2 * w + (isTop ? x : w + x)]
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
    const segBase = gr0 * w
    while (heap.length > 0) {
      heap.pop()
      const current = heap.poppedIndex
      const ly = (current / w) | 0
      const lx = current - ly * w
      if (ly > 0 && ly < rowsL - 1) {
        const g = globalRow(ly) * w + lx
        filled[g] = lf[current]
        stripPopOrder[segBase + popped++] = g
      }
      for (const [dx, dy] of D8) {
        const ny = ly + dy
        if (ny < 0 || ny >= rowsL) continue
        const nx = (lx + dx + w) % w
        const local = ny * w + nx
        if (vis[local]) continue
        vis[local] = 1
        const g = globalRow(ny) * w + nx
        const stepDistance = dx !== 0 && dy !== 0 ? SQRT2 : 1
        lf[local] = Math.max(z[g], lf[current]) + EPSILON_FLOOD_STEP * stepDistance
        heap.push(lf[local], local)
      }
    }
    for (let l = 1; l < rowsL - 1; l++) {
      const g0 = globalRow(l) * w
      for (let x = 0; x < w; x++) {
        if (!vis[l * w + x]) filled[g0 + x] = Infinity
      }
    }
    this.stripPopped[strip] = popped
  }

  // Merge the per-strip pop segments (each sorted by filled) into one global
  // topological order. Any filled-ascending order is valid for every walk:
  // receivers are STRICTLY lower in filled.
  private mergePopOrder(): void {
    const { filled, popOrder, stripPopOrder, stripPopped, width: w, height: h } = this
    const stripRows = h / STRIPS
    const heads = new Int32Array(STRIPS)
    let total = 0
    for (let s = 0; s < STRIPS; s++) total += stripPopped[s]
    for (let k = 0; k < total; k++) {
      let best = -1
      let bestKey = Infinity
      for (let s = 0; s < STRIPS; s++) {
        const head = heads[s]
        if (head >= stripPopped[s]) continue
        const key = filled[stripPopOrder[s * stripRows * w + head]]
        if (key < bestKey) { bestKey = key; best = s }
      }
      popOrder[k] = stripPopOrder[best * stripRows * w + heads[best]++]
    }
    this.poppedCount = total
  }

  // Per-cell LTD facet scan (Orlandini 2003, D8-LTD — same method as
  // flowRouting.computeLtdFlowTargets, split scan/walk so the scan can run
  // per-cell parallel). Fully independent per cell.
  private ltdScan(): void {
    const { filled, width: w, height: h } = this
    const { ltdCardinal, ltdDiagonal, ltdDeltaC, ltdDeltaD, ltdFallback, ltdMode } = this
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const cell = y * w + x
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
          const nc = ((y + co[1] + h) % h) * w + ((x + co[0] + w) % w)
          const g1 = own - filled[nc]
          if (g1 > bestGradient) { bestGradient = g1; fallback = nc }
          const nd = ((y + dd[1] + h) % h) * w + ((x + dd[0] + w) % w)
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

  // The λ-walk: choose each cell's receiver to minimise the accumulated
  // transverse deviation, inheriting λ from the largest contributor at
  // confluences. Serial by nature (popOrder backward).
  private lambdaWalk(): void {
    const { popOrder, poppedCount, flowTarget, lambda, contrib, bestInflow } = this
    const { ltdCardinal, ltdDiagonal, ltdDeltaC, ltdDeltaD, ltdFallback, ltdMode } = this
    flowTarget.fill(-1)
    lambda.fill(0)
    contrib.fill(0)
    bestInflow.fill(0)
    for (let i = poppedCount - 1; i >= 0; i--) {
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

  // MFD edges (Freeman/Quinn linear weighting), fixed stride-8. Per-cell
  // independent.
  private computeMfd(): void {
    const { filled, width: w, height: h, mfdDegree, mfdDirection, mfdWeight } = this
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const cell = y * w + x
        const own = filled[cell]
        const base = cell * 8
        let count = 0
        let weightSum = 0
        for (let dir = 0; dir < 8; dir++) {
          const offset = D8[dir]
          const neighbor = ((y + offset[1] + h) % h) * w + ((x + offset[0] + w) % w)
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

  // Drainage-area accumulation over the MFD edges, popOrder backward.
  private accumulate(): void {
    const { popOrder, poppedCount, accumulation, mfdDegree, mfdDirection, mfdWeight, width: w, height: h } = this
    accumulation.fill(1)
    for (let i = poppedCount - 1; i >= 0; i--) {
      const cell = popOrder[i]
      const amount = accumulation[cell]
      const x = cell % w
      const y = (cell - x) / w
      const base = cell * 8
      const degree = mfdDegree[cell]
      for (let e = 0; e < degree; e++) {
        const offset = D8[mfdDirection[base + e]]
        accumulation[((y + offset[1] + h) % h) * w + ((x + offset[0] + w) % w)] += amount * mfdWeight[base + e]
      }
    }
  }

  // Recompute the whole routing state from the current z. Reads z only;
  // writes only routing state — the one-way split the pipelined refresh
  // depends on.
  refreshRouting(): void {
    if (!this.computeOceanSeed()) {
      // A fully continental world: no drain, no routing — the same graceful
      // degradation as flowRouting.
      this.poppedCount = 0
      this.flowTarget.fill(-1)
      this.accumulation.fill(1)
      return
    }
    const stripEdges: Map<number, number>[] = []
    for (let s = 0; s < STRIPS; s++) {
      const edges = new Map<number, number>()
      this.floodPhase1(s, edges)
      stripEdges.push(edges)
    }
    this.solveBorderGraph(stripEdges)
    for (let s = 0; s < STRIPS; s++) this.floodPhase2(s)
    this.mergePopOrder()
    this.ltdScan()
    this.lambdaWalk()
    this.computeMfd()
    this.accumulate()
  }

  // ------------------------------------------------------------------ physics

  // One physics iteration on the current routing. Returns the residual: the
  // largest land elevation change, in metres.
  stepPhysics(): number {
    const p = this.params
    const { z, n, popOrder, poppedCount, flowTarget, accumulation, width: w, height: h } = this
    const { uplift, erodibility, coastMask } = this.forcing
    const { cellM, cellKm2 } = this
    const erosionVolume = this.erosionVolume
    let maxStep = 0

    // 1a. Uplift — the forcing half of the balance. No envelope cap: at any
    // age, erosion is what bounds height. Pinned to the initial coast when a
    // mask is given (see ErosionForcing.coastMask).
    for (let i = 0; i < n; i++) {
      if (z[i] > 0 && (!coastMask || coastMask[i])) z[i] += p.upliftDt * uplift[i]
    }

    // 1b. Implicit stream power, receiver-first (popOrder forward):
    // z' = (z + F·z'_receiver)/(1 + F), only where the receiver is LOWER in
    // raw z — inside a filled depression routing runs uphill over the fill,
    // and the implicit form would PULL the cell up: a lake bed does not
    // erode.
    for (let i = 0; i < poppedCount; i++) {
      const cell = popOrder[i]
      erosionVolume[cell] = 0
      const old = z[cell]
      if (old <= 0) continue
      const target = flowTarget[cell]
      if (target < 0) continue
      const zr = z[target]
      if (zr >= old) continue
      const x = cell % w
      const tx = target % w
      let ddx = Math.abs(tx - x)
      if (ddx > 1) ddx = 1
      let ddy = Math.abs((target - tx) / w - (cell - x) / w)
      if (ddy > 1) ddy = 1
      const distKm = (cellM / 1000) * (ddx && ddy ? SQRT2 : 1)
      const dischargeKm2 = accumulation[cell] * cellKm2 + p.baseAreaKm2
      const F = (p.kappaDt * erodibility[cell] * Math.pow(dischargeKm2, p.m)) / distKm
      const znew = (old + F * zr) / (1 + F)
      const cut = old - znew
      z[cell] = znew
      erosionVolume[cell] = cut * ELEVATION_METERS * cellKm2 * 1e6
      if (cut > maxStep) maxStep = cut
    }

    // 2. ξ–q sediment routing, donor-first (popOrder backward): flux hands
    // downstream, a reach-integrated fraction settles, capped by the donor
    // floor (no deposit may dam the valley that feeds it) and, under water,
    // by the freeboard (a delta aggrades to the surface, then progrades).
    const { flux, donorMin } = this
    flux.fill(0)
    donorMin.fill(Infinity)
    for (let i = poppedCount - 1; i >= 0; i--) {
      const cell = popOrder[i]
      const target = flowTarget[cell]
      let carrying = flux[cell] + erosionVolume[cell]
      if (carrying > 0) {
        const land = z[cell] > 0
        const settle = land
          ? Math.max(p.settleFloorKm, p.settleXiKm * Math.sqrt(accumulation[cell] * cellKm2 + p.baseAreaKm2))
          : p.settleMarineKm
        // Exact exponential integration over the reach — scale-consistent
        // for any dx/L, where a clamped linear fraction was not.
        const dropFraction = 1 - Math.exp(-(cellM / 1000) / settle)
        let deposit = carrying * dropFraction
        const donorCap = donorMin[cell] - 1e-5
        const cap = land ? donorCap : Math.min(donorCap, p.marineFreeboardM / ELEVATION_METERS)
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

    // 3. Roering hillslope diffusion (land): nonlinear flux diverging near
    // the critical slope. Two per-cell passes (own east/south moves, then a
    // combine) rather than one accumulation sweep — the form the worker
    // port runs without write conflicts.
    const { moveEast, moveSouth } = this
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const cell = y * w + x
        let east = 0
        let south = 0
        if (z[cell] > 0) {
          const eastCell = y * w + ((x + 1) % w)
          const southCell = ((y + 1) % h) * w + x
          for (const [nb, isEast] of [[eastCell, 1], [southCell, 0]] as const) {
            const dz = z[cell] - z[nb]
            if (dz === 0) continue
            const slope = (Math.abs(dz) * ELEVATION_METERS) / cellM
            const ratio = Math.min(0.95, slope / p.criticalSlope)
            const boost = 1 / (1 - ratio * ratio)
            const fraction = Math.min(0.2, (p.hillDiffKm2 / cellKm2) * Math.min(boost, 12))
            const move = fraction * dz
            if (isEast) east = move
            else south = move
          }
        }
        moveEast[cell] = east
        moveSouth[cell] = south
      }
    }
    for (let y = 0; y < h; y++) {
      const north = (y - 1 + h) % h
      for (let x = 0; x < w; x++) {
        const cell = y * w + x
        const west = y * w + ((x - 1 + w) % w)
        const delta = -(moveEast[cell] + moveSouth[cell]) + moveEast[west] + moveSouth[north * w + x]
        if (delta !== 0) {
          z[cell] += delta
          const step = Math.abs(delta)
          if (z[cell] > 0 && step > maxStep) maxStep = step
        }
      }
    }

    // 4. Marine diffusion: fresh submarine deposits relax seaward.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const cell = y * w + x
        let east = 0
        let south = 0
        if (z[cell] <= 0) {
          const eastCell = y * w + ((x + 1) % w)
          const southCell = ((y + 1) % h) * w + x
          if (z[eastCell] <= 0) east = p.marineDiffDt * (z[cell] - z[eastCell]) * 0.1
          if (z[southCell] <= 0) south = p.marineDiffDt * (z[cell] - z[southCell]) * 0.1
        }
        moveEast[cell] = east
        moveSouth[cell] = south
      }
    }
    for (let y = 0; y < h; y++) {
      const north = (y - 1 + h) % h
      for (let x = 0; x < w; x++) {
        const cell = y * w + x
        const west = y * w + ((x - 1 + w) % w)
        z[cell] += -(moveEast[cell] + moveSouth[cell]) + moveEast[west] + moveSouth[north * w + x]
      }
    }

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
