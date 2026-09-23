import { D8_OFFSETS, d8Neighbor, largestWaterComponent } from './flowRouting'

// EROSION V2 — the engine's state layout (docs/design/erosion-v2.md, P2;
// ADAPTIVE_MESH_PLAN.md phases 0 and 4.2).
//
// The engine runs on an ACTIVE SET of nodes, not on a raster: land, every
// enclosed sub-sea basin, and a shelf band of ocean around the land where
// deltas prograde and marine diffusion reaches. The deep ocean beyond the
// band is FROZEN — never read by a kernel, never written, absent from every
// state array. On a real world that is most of the substrate (phase 0 was
// measured on a world with 11 % land), so every per-node array here is
// sized to the active count A.
//
// THE SUBSTRATE IS A GRAPH (phase 4.2). Nodes are addressed by ACTIVE INDEX
// (0..A-1), and every node's neighbours are a run in a CSR table (`nbrStart`,
// `nbr`; -1 where the neighbour is frozen — a missing slot is simply no
// neighbour, which is what makes the frozen boundary a wall by
// construction). Per directed edge the index carries what a finite-volume
// kernel needs and nothing a coordinate would say: the reach length
// (`lenRel`, in units of the reference length `refM`), the Voronoi facet
// over the reach (`diffFactor` = facet/length, the geometric factor of a
// diffusive flux; 0 where two nodes share no facet), the MFD weight base
// (`mfdFactor`), and the reverse edge (`edgeRev`, for the two-pass
// stencils). Per node, its Voronoi area (`areaRel`, in refM²). No kernel
// does wrap arithmetic or knows a node's position: a kernel walks the table.
//
// The RASTER is one instance of this graph: eight neighbours per cell in
// D8_OFFSETS order (so `nbrStart[i] = 8 i`, and the D8-LTD scan can still
// read its facets by slot when FLAG_GRID8 is set), reach lengths 1 and √2,
// a facet only across the four cardinal edges (the cell is a square), area
// 1. The MESH (mesh/meshErosion.ts) is the other: a Delaunay star per node,
// facets from the circumcentres, areas from the Voronoi cells. Same
// kernels, same walks, same drivers — the raster's MFD keeps Freeman's
// weights (drop over length, diagonals included) for the transition, which
// is what `mfdFactor` exists to express separately from `diffFactor`.
//
// The state is TWO sections with different lifetimes:
//
//   TERRAIN — the graph tables, z, the forcing, stencil scratch: one copy,
//   mutated by the physics iterations.
//   ROUTING — everything a routing refresh produces (filled, receivers,
//   MFD, accumulation, the pop order) plus the z-SNAPSHOT it was computed
//   from: the pipelined refresh keeps TWO of these and swaps on a fixed
//   schedule, so physics never waits for routing.
//
// Views are laid out identically whether the backing is a plain ArrayBuffer
// (single-threaded) or SharedArrayBuffers (the worker pool) — workers
// reconstruct the same views from the same bytes, so the kernels cannot
// tell the difference and the modes are byte-identical by construction.
// The stencil kernels never read the routing section at all, which is what
// makes the double-buffer swap a coordinator-only concern.
//
// The depression fill is ONE serial priority flood over the active set
// (phase 0 retired the sixteen-strip Barnes flood and its spill graph: the
// strip count was part of the result, and the basin partition of phase 0's
// second half is the parallel unit that replaces it).

// Which nodes the engine computes on, and how they connect. Built once per
// run from the initial terrain (buildEngineIndex for a raster,
// mesh/meshErosion.buildMeshEngineIndex for a mesh); the frozen set never
// changes during a run.
export interface EngineIndex {
  kind: 'raster' | 'mesh'
  // The raster's dimensions; 0 for a mesh (the bridge to the raster
  // hydrology is raster-only).
  width: number
  height: number
  // How many cells (raster) or vertex slots (mesh) the FULL arrays the
  // caller hands in and gets back are laid out for.
  cellCount: number
  activeCount: number
  // Cell id (raster) or vertex id (mesh) of every active index, ascending.
  active: Int32Array
  // Active index of every cell / vertex, -1 when frozen or absent.
  // Coordinator-side only (expansion back to the caller's layout);
  // kernels never touch it.
  activeOf: Int32Array
  // How many cells are frozen. Zero means the world has no deep ocean and
  // the flood falls back to seeding from the largest water body.
  frozenCount: number
  // CSR neighbour table over active indices: node i's directed edges are
  // nbr[nbrStart[i] .. nbrStart[i+1]), each the neighbour's active index
  // or -1 when frozen. The order within a run is the substrate's (D8 slot
  // order on the raster, counter-clockwise on the mesh) and is part of the
  // result — every sum a kernel takes runs in it.
  nbrStart: Int32Array
  nbr: Int32Array
  edgeCount: number
  // Per directed edge: the index of the opposite directed edge (-1 when
  // the neighbour is frozen), the reach length over refM, the diffusive
  // geometric factor facet/length (0 = no shared facet), the MFD weight
  // base.
  edgeRev: Int32Array
  lenRel: Float32Array
  diffFactor: Float32Array
  mfdFactor: Float32Array
  // Per node: the Voronoi area over refM².
  areaRel: Float32Array
  // The reference length in metres: the cell size on a raster, the macro
  // cell (METERS_PER_CELL) on a mesh. Every length-bearing constant of the
  // engine is read against it.
  refM: number
}

// The raster's active set: everything that is not deep world ocean.
// `bandCells` is how many D8 steps of world ocean stay active around any
// non-ocean cell — the shelf band, measured in the engine's own units by the
// caller (params.shelfBandKm over the cell size). The world ocean is the
// largest 4-connected ≤ 0 component, the same rule the flood seeds by; an
// enclosed basin is not ocean and stays active whatever its depth.
export function buildEngineIndex(z: Float32Array, width: number, height: number, bandCells: number, cellM: number): EngineIndex {
  const n = width * height
  const ocean = largestWaterComponent(z, width, height, 0)
  const frozen = new Uint8Array(n)
  let frozenCount = 0
  if (ocean) {
    // Multi-source BFS from every non-ocean cell, D8 steps, depth ≤ bandCells:
    // what it reaches is the band; the rest of the ocean is frozen.
    const depth = new Int32Array(n).fill(-1)
    const queue = new Int32Array(n)
    let head = 0
    let tail = 0
    for (let i = 0; i < n; i++) {
      if (!ocean[i]) {
        depth[i] = 0
        queue[tail++] = i
      }
    }
    const limit = Math.max(1, Math.floor(bandCells))
    while (head < tail) {
      const cell = queue[head++]
      const d = depth[cell]
      if (d >= limit) continue
      const x = cell % width
      const y = (cell - x) / width
      for (const [dx, dy] of D8_OFFSETS) {
        const nb = d8Neighbor(x, y, dx, dy, width, height)
        if (depth[nb] === -1) {
          depth[nb] = d + 1
          queue[tail++] = nb
        }
      }
    }
    for (let i = 0; i < n; i++) {
      if (ocean[i] && depth[i] === -1) {
        frozen[i] = 1
        frozenCount++
      }
    }
  }
  const activeCount = n - frozenCount
  const active = new Int32Array(activeCount)
  const activeOf = new Int32Array(n).fill(-1)
  let a = 0
  for (let i = 0; i < n; i++) {
    if (frozen[i]) continue
    activeOf[i] = a
    active[a++] = i
  }
  const edgeCount = 8 * activeCount
  const nbrStart = new Int32Array(activeCount + 1)
  const nbr = new Int32Array(edgeCount)
  const edgeRev = new Int32Array(edgeCount)
  const lenRel = new Float32Array(edgeCount)
  const diffFactor = new Float32Array(edgeCount)
  const mfdFactor = new Float32Array(edgeCount)
  for (let k = 0; k < activeCount; k++) {
    nbrStart[k] = k * 8
    const cell = active[k]
    const x = cell % width
    const y = (cell - x) / width
    for (let slot = 0; slot < 8; slot++) {
      const [dx, dy] = D8_OFFSETS[slot]
      const e = k * 8 + slot
      const j = activeOf[d8Neighbor(x, y, dx, dy, width, height)]
      nbr[e] = j
      // The opposite slot of the same pair sits in the neighbour's run.
      edgeRev[e] = j >= 0 ? j * 8 + ((slot + 4) % 8) : -1
      const diagonal = (slot & 1) === 1
      lenRel[e] = diagonal ? Math.SQRT2 : 1
      diffFactor[e] = diagonal ? 0 : 1
      mfdFactor[e] = diagonal ? 1 / Math.SQRT2 : 1
    }
  }
  nbrStart[activeCount] = edgeCount
  const areaRel = new Float32Array(activeCount).fill(1)
  return { kind: 'raster', width, height, cellCount: n, activeCount, active, activeOf, frozenCount, nbrStart, nbr, edgeCount, edgeRev, lenRel, diffFactor, mfdFactor, areaRel, refM: cellM }
}

// Active-space array → the caller's full layout. Frozen entries take
// `fill`: an array to copy them from (the initial terrain, for z) or one
// constant. A caller's array may be longer than the layout (a MeshState
// field is over-allocated for growth); only the layout's entries count.
export function expandActive(index: EngineIndex, src: ArrayLike<number>, fill: Float32Array | number, out?: Float32Array): Float32Array {
  const n = index.cellCount
  const result = out ?? new Float32Array(n)
  if (typeof fill === 'number') result.fill(fill)
  else result.set(fill.length > n ? fill.subarray(0, n) : fill)
  const { active, activeCount } = index
  for (let a = 0; a < activeCount; a++) result[active[a]] = src[a]
  return result
}

// The caller's full layout → active-space array.
export function gatherActive<T extends Float32Array | Uint8Array>(index: EngineIndex, src: ArrayLike<number>, out: T): T {
  const { active, activeCount } = index
  for (let a = 0; a < activeCount; a++) out[a] = src[active[a]]
  return out
}

export interface TerrainViews {
  // The active-set size and the directed-edge count every view here is laid
  // out for.
  activeCount: number
  edgeCount: number
  // The graph tables (read-only after init) — see EngineIndex.
  nbrStart: Int32Array
  nbr: Int32Array
  edgeRev: Int32Array
  lenRel: Float32Array
  diffFactor: Float32Array
  mfdFactor: Float32Array
  areaRel: Float32Array
  // Terrain (physics writes), normalized z, 1.0 = ELEVATION_METERS.
  z: Float32Array
  // Forcing (read-only after init).
  uplift: Float32Array
  erodibility: Float32Array
  // Coast pin: 1 = may receive uplift. Flag FLAG_HAS_COAST_MASK 0 → ignored.
  coastMask: Uint8Array
  // Land/sea status rule (erosion-v2 P3 ②): 0 = free, 1 = must stay land,
  // 2 = must stay sea. Enforced by kernelStatusClamp when
  // FLAG_HAS_STATUS_MASK is set — the bake's macro-coastline authority; the
  // generator never sets it (its coasts are free by decision).
  statusMask: Uint8Array
  // Stencil scratch (hillslope/marine two-pass form): the volume moved
  // along each directed edge from the lower-indexed endpoint, written by
  // the moves pass at that endpoint's run and read by the apply pass
  // through edgeRev.
  edgeMove: Float32Array
  // Fluvial cut volumes for the sediment walk.
  erosionVolume: Float32Array
  // Per-node base contribution for drainage accumulation (the climate-Q
  // coupling: upsampled provisional precipitation). Read only when
  // FLAG_HAS_ACCUM_WEIGHTS is set; uniform 1 otherwise.
  accumulationWeights: Float32Array
  // Sediment-walk scratch: flux arriving at a node and the lowest donor
  // floor above it, both reset per iteration; and per SEGMENT (see
  // RoutingViews) what a leaf segment's root hands to its outlet — the
  // coast-split stage's mailbox between the parallel and the serial walk.
  flux: Float32Array
  donorMin: Float32Array
  mouthFlux: Float32Array
  mouthZ: Float32Array
  // Per-worker reduction slots: residual, eroded volume, exported volume.
  maxStepW: Float64Array
  erodedW: Float64Array
  exportedW: Float64Array
  // Scalar flags: FLAG_HAS_COAST_MASK, FLAG_HAS_ACCUM_WEIGHTS,
  // FLAG_HAS_STATUS_MASK, FLAG_GRID8.
  flags: Int32Array
  buffer: ArrayBufferLike
}

export interface RoutingViews {
  // The z this routing was computed from — the pipelined refresh reads
  // THIS, never the live z (the snapshot is copied at a fixed iteration
  // boundary, which is what keeps pipelining deterministic). Synchronous
  // mode ignores it and routes on live z.
  zSnapshot: Float32Array
  filled: Float32Array
  // Single-flow receiver: active index, or -1 (terminal — an unrouted node,
  // or one whose only way down is a frozen neighbour). `flowDir` is the
  // receiver's SLOT in the node's neighbour run (255 when none), which is
  // what the walks need for the reach length: no coordinates anywhere in
  // the engine.
  flowTarget: Int32Array
  flowDir: Uint8Array
  accumulation: Float32Array
  // Nodes in the order the flood popped them — a topological order of the
  // flow graph (only the first poppedCount entries are valid).
  popOrder: Int32Array
  // LTD facet-scan outputs (per-cell, parallel) for the serial λ-walk: the
  // best facet (index into LTD_FACETS, 255 = none), the steepest-descent
  // fallback SLOT (255 = none), the two transverse deviations, and the mode
  // bits (4 = facet valid, 1 = cardinal lower, 2 = diagonal lower). On a
  // mesh only the fallback is written (mode 0): a random star has no
  // direction bias to correct.
  ltdFacet: Uint8Array
  ltdFallback: Uint8Array
  ltdDeltaC: Float32Array
  ltdDeltaD: Float32Array
  ltdMode: Uint8Array
  // MFD edges in the node's neighbour run: degree, the target's SLOT, weight
  // — laid out per directed edge, the first `mfdDegree[i]` entries of
  // node i's run used.
  mfdDegree: Uint8Array
  mfdDirection: Uint8Array
  mfdWeight: Float32Array
  // Ocean seeds of the flood (recomputed every refresh).
  seedMask: Uint8Array
  // The receiver forest cut into SEGMENTS at every land→sea edge (of the z
  // this routing was computed from): a segment is a maximal receiver
  // subtree that crosses no such edge, so a river basin is one segment
  // whose root is its mouth. A LEAF segment receives no mouth from
  // another segment — the basins, and ocean trees no river feeds — and
  // its fluvial and sediment walks are independent of every other leaf,
  // which is what the pool runs in parallel; the rest (the fed ocean band,
  // enclosed basins and the land below their spills) is the serial stage.
  // `segOrder` lists every popped node grouped by segment, receiver-first
  // within the group (the root at segStart[seg]); `stage` is 0 for a leaf
  // node, 1 for a serial-stage node.
  segment: Int32Array
  segOrder: Int32Array
  segStart: Int32Array
  segLeaf: Uint8Array
  stage: Uint8Array
  // [0] = segment count, [1] = nodes in leaf segments.
  routingMeta: Int32Array
  buffer: ArrayBufferLike
}

// What every kernel and walk takes: one terrain section + one routing
// section, flattened. `z` is the ROUTING INPUT — assembleViews picks the
// live terrain z (synchronous mode) or the routing buffer's snapshot (the
// pipelined refresh); physics kernels always receive the live-z assembly.
export interface EngineViews extends Omit<TerrainViews, 'buffer'>, Omit<RoutingViews, 'buffer'> {}

// No bitwise trick here: `(offset + 7) & ~7` coerces to 32-bit signed, and
// the routing section crosses 2^31 bytes at the 8K bake grid — the offset
// came back NEGATIVE (found 2026-08-16 by the first threaded 8K bake).
const align = (offset: number): number => Math.ceil(offset / 8) * 8

type TypedArrayCtor<T> = { new (b: ArrayBufferLike, o: number, c: number): T; BYTES_PER_ELEMENT: number }

function makeTaker(backing: ArrayBufferLike): { take: <T>(Type: TypedArrayCtor<T>, count: number) => T; used: () => number } {
  let offset = 0
  return {
    take: <T>(Type: TypedArrayCtor<T>, count: number): T => {
      const view = new Type(backing, offset, count)
      offset = align(offset + count * Type.BYTES_PER_ELEMENT)
      return view
    },
    used: () => offset,
  }
}

export function terrainBufferBytes(activeCount: number, edgeCount: number): number {
  const a = activeCount
  const e = edgeCount
  // i32: nbrStart (a + 1), nbr, edgeRev (2e); f32: lenRel, diffFactor,
  // mfdFactor, edgeMove (4e), areaRel, z, uplift, erodibility,
  // erosionVolume, accumulationWeights, flux, donorMin, mouthFlux, mouthZ
  // (10a); u8: coastMask, statusMask (2a); i32 flags(16); f64 maxStepW,
  // erodedW, exportedW (3 × 64); alignment slack.
  return 4 * (a + 1) + 2 * 4 * e + 4 * 4 * e + 10 * 4 * a + 2 * a + 16 * 4 + 3 * 64 * 8 + 2048
}

export function routingBufferBytes(activeCount: number, edgeCount: number): number {
  const a = activeCount
  const e = edgeCount
  // f32: zSnapshot, filled, accumulation, ltdDeltaC/D (5a) + mfdWeight (e)
  // i32: flowTarget, popOrder, segment, segOrder (4a) + segStart (a + 1) + routingMeta (16)
  // u8:  flowDir, ltdFacet, ltdFallback, ltdMode, mfdDegree, seedMask, segLeaf, stage (8a) + mfdDirection (e)
  return 5 * 4 * a + 4 * e + 5 * 4 * a + 4 + 16 * 4 + 8 * a + e + 4096
}

// The terrain section. The graph tables are copied in when an index is
// given (the coordinator's construction); a worker passes none and reads
// the tables the coordinator wrote into the shared bytes.
export function createTerrainViews(activeCount: number, edgeCount: number, buffer?: ArrayBufferLike, index?: EngineIndex): TerrainViews {
  const a = activeCount
  const e = edgeCount
  const bytes = terrainBufferBytes(a, e)
  const backing = buffer ?? new ArrayBuffer(bytes)
  if (backing.byteLength < bytes) throw new Error(`terrain buffer too small: ${backing.byteLength} < ${bytes}`)
  const { take } = makeTaker(backing)
  const views: TerrainViews = {
    activeCount: a,
    edgeCount: e,
    nbrStart: take(Int32Array, a + 1),
    nbr: take(Int32Array, e),
    edgeRev: take(Int32Array, e),
    lenRel: take(Float32Array, e),
    diffFactor: take(Float32Array, e),
    mfdFactor: take(Float32Array, e),
    edgeMove: take(Float32Array, e),
    areaRel: take(Float32Array, a),
    z: take(Float32Array, a),
    uplift: take(Float32Array, a),
    erodibility: take(Float32Array, a),
    erosionVolume: take(Float32Array, a),
    accumulationWeights: take(Float32Array, a),
    flux: take(Float32Array, a),
    donorMin: take(Float32Array, a),
    mouthFlux: take(Float32Array, a),
    mouthZ: take(Float32Array, a),
    maxStepW: take(Float64Array, 64),
    erodedW: take(Float64Array, 64),
    exportedW: take(Float64Array, 64),
    flags: take(Int32Array, 16),
    coastMask: take(Uint8Array, a),
    statusMask: take(Uint8Array, a),
    buffer: backing,
  }
  if (index) {
    views.nbrStart.set(index.nbrStart)
    views.nbr.set(index.nbr)
    views.edgeRev.set(index.edgeRev)
    views.lenRel.set(index.lenRel)
    views.diffFactor.set(index.diffFactor)
    views.mfdFactor.set(index.mfdFactor)
    views.areaRel.set(index.areaRel)
    views.flags[FLAG_GRID8] = index.kind === 'raster' ? 1 : 0
  }
  return views
}

export function createRoutingViews(activeCount: number, edgeCount: number, buffer?: ArrayBufferLike): RoutingViews {
  const a = activeCount
  const e = edgeCount
  const bytes = routingBufferBytes(a, e)
  const backing = buffer ?? new ArrayBuffer(bytes)
  if (backing.byteLength < bytes) throw new Error(`routing buffer too small: ${backing.byteLength} < ${bytes}`)
  const { take } = makeTaker(backing)
  return {
    zSnapshot: take(Float32Array, a),
    filled: take(Float32Array, a),
    accumulation: take(Float32Array, a),
    ltdDeltaC: take(Float32Array, a),
    ltdDeltaD: take(Float32Array, a),
    mfdWeight: take(Float32Array, e),
    flowTarget: take(Int32Array, a),
    popOrder: take(Int32Array, a),
    segment: take(Int32Array, a),
    segOrder: take(Int32Array, a),
    segStart: take(Int32Array, a + 1),
    routingMeta: take(Int32Array, 16),
    flowDir: take(Uint8Array, a),
    ltdFacet: take(Uint8Array, a),
    ltdFallback: take(Uint8Array, a),
    ltdMode: take(Uint8Array, a),
    mfdDegree: take(Uint8Array, a),
    seedMask: take(Uint8Array, a),
    segLeaf: take(Uint8Array, a),
    stage: take(Uint8Array, a),
    mfdDirection: take(Uint8Array, e),
    buffer: backing,
  }
}

// One flat kernel view over a terrain and a routing section. When
// `zFromSnapshot` is set, `z` points at the routing buffer's snapshot —
// the assembly the refresh side runs on, so its kernels read frozen
// terrain while physics mutates the live one.
export function assembleViews(terrain: TerrainViews, routing: RoutingViews, zFromSnapshot = false): EngineViews {
  return {
    activeCount: terrain.activeCount,
    edgeCount: terrain.edgeCount,
    nbrStart: terrain.nbrStart,
    nbr: terrain.nbr,
    edgeRev: terrain.edgeRev,
    lenRel: terrain.lenRel,
    diffFactor: terrain.diffFactor,
    mfdFactor: terrain.mfdFactor,
    areaRel: terrain.areaRel,
    z: zFromSnapshot ? routing.zSnapshot : terrain.z,
    uplift: terrain.uplift,
    erodibility: terrain.erodibility,
    coastMask: terrain.coastMask,
    statusMask: terrain.statusMask,
    edgeMove: terrain.edgeMove,
    erosionVolume: terrain.erosionVolume,
    accumulationWeights: terrain.accumulationWeights,
    flux: terrain.flux,
    donorMin: terrain.donorMin,
    mouthFlux: terrain.mouthFlux,
    mouthZ: terrain.mouthZ,
    maxStepW: terrain.maxStepW,
    erodedW: terrain.erodedW,
    exportedW: terrain.exportedW,
    flags: terrain.flags,
    zSnapshot: routing.zSnapshot,
    filled: routing.filled,
    flowTarget: routing.flowTarget,
    flowDir: routing.flowDir,
    accumulation: routing.accumulation,
    popOrder: routing.popOrder,
    ltdFacet: routing.ltdFacet,
    ltdFallback: routing.ltdFallback,
    ltdDeltaC: routing.ltdDeltaC,
    ltdDeltaD: routing.ltdDeltaD,
    ltdMode: routing.ltdMode,
    mfdDegree: routing.mfdDegree,
    mfdDirection: routing.mfdDirection,
    mfdWeight: routing.mfdWeight,
    seedMask: routing.seedMask,
    segment: routing.segment,
    segOrder: routing.segOrder,
    segStart: routing.segStart,
    segLeaf: routing.segLeaf,
    stage: routing.stage,
    routingMeta: routing.routingMeta,
  }
}

// Single-allocation form: one plain buffer per section — what the
// single-threaded engine uses.
export function createEngineViews(index: EngineIndex): EngineViews {
  return assembleViews(createTerrainViews(index.activeCount, index.edgeCount, undefined, index), createRoutingViews(index.activeCount, index.edgeCount))
}

// Flag slots (the terrain section's `flags`). FLAG_GRID8 marks the raster
// substrate: eight neighbours per node in D8 slot order, which the LTD
// scan needs and nothing else may assume.
export const FLAG_HAS_COAST_MASK = 0
export const FLAG_HAS_ACCUM_WEIGHTS = 1
export const FLAG_HAS_STATUS_MASK = 2
export const FLAG_GRID8 = 3

// Job ids for the worker protocol (erosionEnginePool.ts ↔
// erosionEngineWorker.ts). ctrl[0] = job sequence number (bumped per
// dispatch), ctrl[1] = job id, ctrl[CTRL_ACTIVE_ROUTING] = which routing
// buffer the walks' leaf jobs read (the one the main coordinator iterates
// on; a synchronous pool has only buffer 0); done[0] counts finished
// workers.
export const CTRL_ACTIVE_ROUTING = 2
export const JOB_EXIT = 0
export const JOB_UPLIFT = 1
export const JOB_LTD_SCAN = 2
export const JOB_MFD = 3
export const JOB_HILL_MOVES = 4
export const JOB_HILL_APPLY = 5
export const JOB_MARINE_MOVES = 6
export const JOB_MARINE_APPLY = 7
export const JOB_STATUS_CLAMP = 8
export const JOB_FLUVIAL_LEAF = 9
export const JOB_SEDIMENT_LEAF = 10

// The refresh-coordinator protocol (refreshCtrl, Int32Array):
//   [0] command sequence (bumped to wake the refresh coordinator)
//   [1] command: REFRESH_CMD_RUN or REFRESH_CMD_EXIT
//   [2] target routing buffer index (0 = A, 1 = B)
//   [3] done flag for the CURRENT run (0 in flight, 1 complete)
//   [4] popped count of the completed refresh (written with the done flag)
export const REFRESH_CMD_EXIT = 0
export const REFRESH_CMD_RUN = 1
export const REFRESH_SEQ = 0
export const REFRESH_CMD = 1
export const REFRESH_TARGET = 2
export const REFRESH_DONE = 3
export const REFRESH_POPPED = 4
