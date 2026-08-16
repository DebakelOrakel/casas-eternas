// EROSION V2 — the engine's shared state layout (docs/design/erosion-v2.md, P2).
//
// Every field the engine's kernels touch lives in ONE buffer, laid out
// identically whether that buffer is a plain ArrayBuffer (single-threaded)
// or a SharedArrayBuffer (the worker pool) — workers reconstruct the same
// views from the same bytes, so the kernels cannot tell the difference and
// the two modes are byte-identical by construction.
//
// Sizing note for later: the stride-8 MFD arrays (mfdDirection/mfdWeight)
// are the memory hog — 40 bytes/cell, fine at the generator's 2048 grid
// (~84 MB total state), NOT fine at bake grids (16K would need ~5 GB for
// MFD alone). The bake-scale layout (CSR, or capping MFD fan-out) is P3
// work, recorded here so nobody scales this file naively.

// Fixed strip count for the two-phase parallel flood — part of the RESULT
// (epsilon chains are path-dependent), never a function of the worker
// count. See erosionEngine.ts's flood kernels.
export const ENGINE_STRIPS = 16

// Edge buffer per strip for the flood's spill graph, entries. Far above the
// planar-graph reality of region adjacency; overflow is guarded anyway.
export const EDGES_PER_STRIP_FACTOR = 16

export interface EngineViews {
  // Terrain (physics writes), normalized z, 1.0 = 9000 m.
  z: Float32Array
  // Forcing (read-only after init).
  uplift: Float32Array
  erodibility: Float32Array
  // Coast pin: 1 = may receive uplift. hasCoastMask 0 → ignored.
  coastMask: Uint8Array
  // Routing state (the refresh writes, physics reads).
  filled: Float32Array
  flowTarget: Int32Array
  accumulation: Float32Array
  // Per-strip pop segments (strip s owns [s·stripRows·W, …)); the MERGED
  // global order lives coordinator-side only (serial walks are the only
  // readers).
  stripPopOrder: Int32Array
  stripPopped: Int32Array
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
  // Stencil scratch (hillslope/marine two-pass form).
  moveEast: Float32Array
  moveSouth: Float32Array
  // Physics scratch shared across the serial walks.
  erosionVolume: Float32Array
  // Per-worker residual reduction slots.
  maxStepW: Float64Array
  // Scalar flags/config the workers need: [0] = hasCoastMask.
  flags: Int32Array
  buffer: ArrayBufferLike
}

function bytesNeeded(width: number, height: number): number {
  const n = width * height
  const edges = EDGES_PER_STRIP_FACTOR * width * ENGINE_STRIPS
  // f32: z, uplift, erodibility, filled, accumulation, ltdDeltaC/D,
  //      moveE/S, erosionVolume (10n), mfdWeight (8n); plus borderFill, edgeW
  // i32: flowTarget, stripPopOrder, ltdCardinal/Diagonal/Fallback,
  //      edgeA/B, stripPopped(64), edgeCount(64), flags(16)
  // u8:  coastMask, ltdMode, mfdDegree, seedMask (4n), mfdDirection (8n)
  return (
    (10 + 8) * 4 * n + // f32 per-cell incl. stride-8 weights
    5 * 4 * n + // i32 per-cell
    (4 + 8) * n + // u8 per-cell incl. stride-8 directions
    2 * width * ENGINE_STRIPS * 4 + // borderFill
    edges * (4 + 4 + 4) + // edgeA/B/W
    (64 + 64 + 16) * 4 + // stripPopped, edgeCount, flags
    64 * 8 + // maxStepW
    4096 // alignment slack
  )
}

// Build the views over a caller-supplied buffer, or allocate one. The
// worker pool passes the same SharedArrayBuffer to every worker; the
// single-threaded engine allocates a plain ArrayBuffer.
export function createEngineViews(width: number, height: number, buffer?: ArrayBufferLike): EngineViews {
  const n = width * height
  const edges = EDGES_PER_STRIP_FACTOR * width * ENGINE_STRIPS
  const bytes = bytesNeeded(width, height)
  const backing = buffer ?? new ArrayBuffer(bytes)
  if (backing.byteLength < bytes) throw new Error(`engine buffer too small: ${backing.byteLength} < ${bytes}`)
  let offset = 0
  const take = <T>(Type: { new (b: ArrayBufferLike, o: number, c: number): T; BYTES_PER_ELEMENT: number }, count: number): T => {
    const view = new Type(backing, offset, count)
    offset += count * Type.BYTES_PER_ELEMENT
    offset = (offset + 7) & ~7
    return view
  }
  return {
    z: take(Float32Array, n),
    uplift: take(Float32Array, n),
    erodibility: take(Float32Array, n),
    filled: take(Float32Array, n),
    accumulation: take(Float32Array, n),
    ltdDeltaC: take(Float32Array, n),
    ltdDeltaD: take(Float32Array, n),
    mfdWeight: take(Float32Array, 8 * n),
    moveEast: take(Float32Array, n),
    moveSouth: take(Float32Array, n),
    erosionVolume: take(Float32Array, n),
    borderFill: take(Float32Array, 2 * width * ENGINE_STRIPS),
    edgeW: take(Float32Array, edges),
    flowTarget: take(Int32Array, n),
    stripPopOrder: take(Int32Array, n),
    ltdCardinal: take(Int32Array, n),
    ltdDiagonal: take(Int32Array, n),
    ltdFallback: take(Int32Array, n),
    edgeA: take(Int32Array, edges),
    edgeB: take(Int32Array, edges),
    stripPopped: take(Int32Array, 64),
    edgeCount: take(Int32Array, 64),
    flags: take(Int32Array, 16),
    maxStepW: take(Float64Array, 64),
    coastMask: take(Uint8Array, n),
    ltdMode: take(Uint8Array, n),
    mfdDegree: take(Uint8Array, n),
    mfdDirection: take(Uint8Array, 8 * n),
    seedMask: take(Uint8Array, n),
    buffer: backing,
  }
}

export function engineBufferBytes(width: number, height: number): number {
  return bytesNeeded(width, height)
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
