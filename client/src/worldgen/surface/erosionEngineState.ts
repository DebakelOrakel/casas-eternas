// EROSION V2 — the engine's shared state layout (docs/design/erosion-v2.md, P2).
//
// The state is TWO sections with different lifetimes:
//
//   TERRAIN — z, the forcing, stencil scratch: one copy, mutated by the
//   physics iterations.
//   ROUTING — everything a routing refresh produces (filled, receivers,
//   MFD, accumulation, the merged pop order) plus the z-SNAPSHOT it was
//   computed from: the pipelined refresh keeps TWO of these and swaps on a
//   fixed schedule, so physics never waits for routing.
//
// Views are laid out identically whether the backing is a plain
// ArrayBuffer (single-threaded) or SharedArrayBuffers (the worker pool) —
// workers reconstruct the same views from the same bytes, so the kernels
// cannot tell the difference and the modes are byte-identical by
// construction. The stencil kernels never read the routing section at all,
// which is what makes the double-buffer swap a coordinator-only concern.
//
// Sizing note for later: the stride-8 MFD arrays (mfdDirection/mfdWeight)
// are the memory hog — 40 bytes/cell per routing buffer, fine at the
// generator's 2048 grid, NOT fine at bake grids (16K would need ~5 GB for
// MFD alone, twice that pipelined). The bake-scale layout (CSR, or capping
// MFD fan-out) is P3 work, recorded here so nobody scales this file
// naively.

// Fixed strip count for the two-phase parallel flood — part of the RESULT
// (epsilon chains are path-dependent), never a function of the worker
// count. See erosionEngine.ts's flood kernels.
export const ENGINE_STRIPS = 16

// Edge buffer per strip for the flood's spill graph, entries. Far above the
// planar-graph reality of region adjacency; overflow is guarded anyway.
export const EDGES_PER_STRIP_FACTOR = 16

export interface TerrainViews {
  // Terrain (physics writes), normalized z, 1.0 = 9000 m.
  z: Float32Array
  // Forcing (read-only after init).
  uplift: Float32Array
  erodibility: Float32Array
  // Coast pin: 1 = may receive uplift. Flag FLAG_HAS_COAST_MASK 0 → ignored.
  coastMask: Uint8Array
  // Stencil scratch (hillslope/marine two-pass form).
  moveEast: Float32Array
  moveSouth: Float32Array
  // Fluvial cut volumes for the sediment walk.
  erosionVolume: Float32Array
  // Per-cell base contribution for drainage accumulation (the climate-Q
  // coupling: upsampled provisional precipitation). Read only when
  // FLAG_HAS_ACCUM_WEIGHTS is set; uniform 1 otherwise.
  accumulationWeights: Float32Array
  // Per-worker residual reduction slots.
  maxStepW: Float64Array
  // Scalar flags: [0] = hasCoastMask.
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
  flowTarget: Int32Array
  accumulation: Float32Array
  // Per-strip pop segments (strip s owns [s·stripRows·W, …)), and the
  // MERGED global order the serial walks consume.
  stripPopOrder: Int32Array
  stripPopped: Int32Array
  popOrder: Int32Array
  // LTD facet-scan outputs (per-cell, parallel) for the serial λ-walk.
  ltdCardinal: Int32Array
  ltdDiagonal: Int32Array
  ltdDeltaC: Float32Array
  ltdDeltaD: Float32Array
  ltdFallback: Int32Array
  ltdMode: Uint8Array
  // MFD edges, fixed stride 8 per cell.
  mfdDegree: Uint8Array
  mfdDirection: Uint8Array
  mfdWeight: Float32Array
  // Flood plumbing: ocean seeds, border levels, spill-edge buffers.
  seedMask: Uint8Array
  borderFill: Float32Array
  edgeA: Int32Array
  edgeB: Int32Array
  edgeW: Float32Array
  edgeCount: Int32Array
  buffer: ArrayBufferLike
}

// What every kernel and walk takes: one terrain section + one routing
// section, flattened. `z` is the ROUTING INPUT — assembleViews picks the
// live terrain z (synchronous mode) or the routing buffer's snapshot (the
// pipelined refresh); physics kernels always receive the live-z assembly.
export interface EngineViews extends Omit<TerrainViews, 'buffer'>, Omit<RoutingViews, 'buffer'> {}

const align = (offset: number): number => (offset + 7) & ~7

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

export function terrainBufferBytes(width: number, height: number): number {
  const n = width * height
  // f32: z, uplift, erodibility, moveE/S, erosionVolume, accumulationWeights (7n)
  // u8:  coastMask; i32 flags(16); f64 maxStepW(64)
  return 7 * 4 * n + n + 16 * 4 + 64 * 8 + 1024
}

export function routingBufferBytes(width: number, height: number): number {
  const n = width * height
  const edges = EDGES_PER_STRIP_FACTOR * width * ENGINE_STRIPS
  // f32: zSnapshot, filled, accumulation, ltdDeltaC/D (5n) + mfdWeight (8n)
  // i32: flowTarget, stripPopOrder, popOrder, ltdCardinal/Diagonal/Fallback (6n)
  // u8:  ltdMode, mfdDegree, seedMask (3n) + mfdDirection (8n)
  return (
    (5 + 8) * 4 * n +
    6 * 4 * n +
    (3 + 8) * n +
    2 * width * ENGINE_STRIPS * 4 + // borderFill
    edges * 12 + // edgeA/B/W
    (64 + 64) * 4 + // stripPopped, edgeCount
    4096
  )
}

export function createTerrainViews(width: number, height: number, buffer?: ArrayBufferLike): TerrainViews {
  const n = width * height
  const bytes = terrainBufferBytes(width, height)
  const backing = buffer ?? new ArrayBuffer(bytes)
  if (backing.byteLength < bytes) throw new Error(`terrain buffer too small: ${backing.byteLength} < ${bytes}`)
  const { take } = makeTaker(backing)
  return {
    z: take(Float32Array, n),
    uplift: take(Float32Array, n),
    erodibility: take(Float32Array, n),
    moveEast: take(Float32Array, n),
    moveSouth: take(Float32Array, n),
    erosionVolume: take(Float32Array, n),
    accumulationWeights: take(Float32Array, n),
    maxStepW: take(Float64Array, 64),
    flags: take(Int32Array, 16),
    coastMask: take(Uint8Array, n),
    buffer: backing,
  }
}

export function createRoutingViews(width: number, height: number, buffer?: ArrayBufferLike): RoutingViews {
  const n = width * height
  const edges = EDGES_PER_STRIP_FACTOR * width * ENGINE_STRIPS
  const bytes = routingBufferBytes(width, height)
  const backing = buffer ?? new ArrayBuffer(bytes)
  if (backing.byteLength < bytes) throw new Error(`routing buffer too small: ${backing.byteLength} < ${bytes}`)
  const { take } = makeTaker(backing)
  return {
    zSnapshot: take(Float32Array, n),
    filled: take(Float32Array, n),
    accumulation: take(Float32Array, n),
    ltdDeltaC: take(Float32Array, n),
    ltdDeltaD: take(Float32Array, n),
    mfdWeight: take(Float32Array, 8 * n),
    borderFill: take(Float32Array, 2 * width * ENGINE_STRIPS),
    edgeW: take(Float32Array, edges),
    flowTarget: take(Int32Array, n),
    stripPopOrder: take(Int32Array, n),
    popOrder: take(Int32Array, n),
    ltdCardinal: take(Int32Array, n),
    ltdDiagonal: take(Int32Array, n),
    ltdFallback: take(Int32Array, n),
    edgeA: take(Int32Array, edges),
    edgeB: take(Int32Array, edges),
    stripPopped: take(Int32Array, 64),
    edgeCount: take(Int32Array, 64),
    ltdMode: take(Uint8Array, n),
    mfdDegree: take(Uint8Array, n),
    seedMask: take(Uint8Array, n),
    mfdDirection: take(Uint8Array, 8 * n),
    buffer: backing,
  }
}

// One flat kernel view over a terrain and a routing section. When
// `zFromSnapshot` is set, `z` points at the routing buffer's snapshot —
// the assembly the refresh side runs on, so its kernels read frozen
// terrain while physics mutates the live one.
export function assembleViews(terrain: TerrainViews, routing: RoutingViews, zFromSnapshot = false): EngineViews {
  return {
    z: zFromSnapshot ? routing.zSnapshot : terrain.z,
    uplift: terrain.uplift,
    erodibility: terrain.erodibility,
    coastMask: terrain.coastMask,
    moveEast: terrain.moveEast,
    moveSouth: terrain.moveSouth,
    erosionVolume: terrain.erosionVolume,
    accumulationWeights: terrain.accumulationWeights,
    maxStepW: terrain.maxStepW,
    flags: terrain.flags,
    zSnapshot: routing.zSnapshot,
    filled: routing.filled,
    flowTarget: routing.flowTarget,
    accumulation: routing.accumulation,
    stripPopOrder: routing.stripPopOrder,
    stripPopped: routing.stripPopped,
    popOrder: routing.popOrder,
    ltdCardinal: routing.ltdCardinal,
    ltdDiagonal: routing.ltdDiagonal,
    ltdDeltaC: routing.ltdDeltaC,
    ltdDeltaD: routing.ltdDeltaD,
    ltdFallback: routing.ltdFallback,
    ltdMode: routing.ltdMode,
    mfdDegree: routing.mfdDegree,
    mfdDirection: routing.mfdDirection,
    mfdWeight: routing.mfdWeight,
    seedMask: routing.seedMask,
    borderFill: routing.borderFill,
    edgeA: routing.edgeA,
    edgeB: routing.edgeB,
    edgeW: routing.edgeW,
    edgeCount: routing.edgeCount,
  }
}

// Back-compat single-allocation form: one plain buffer holding both
// sections — what the single-threaded engine uses.
export function createEngineViews(width: number, height: number): EngineViews {
  return assembleViews(createTerrainViews(width, height), createRoutingViews(width, height))
}

// Job ids for the worker protocol (erosionEnginePool.ts ↔
// erosionEngineWorker.ts). ctrl[0] = job sequence number (bumped per
// dispatch), ctrl[1] = job id; done[0] counts finished workers.
export const JOB_EXIT = 0
export const JOB_UPLIFT = 1
export const JOB_LTD_SCAN = 2
export const JOB_MFD = 3
export const JOB_HILL_MOVES = 4
export const JOB_HILL_APPLY = 5
export const JOB_MARINE_MOVES = 6
export const JOB_MARINE_APPLY = 7
export const JOB_FLOOD_P1 = 8
export const JOB_FLOOD_P2 = 9

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
