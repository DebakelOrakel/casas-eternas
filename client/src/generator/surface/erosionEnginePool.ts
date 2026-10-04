import {
  createTerrainViews,
  createRoutingViews,
  assembleViews,
  expandActive,
  terrainBufferBytes,
  routingBufferBytes,
  JOB_EXIT,
  JOB_UPLIFT,
  JOB_LTD_SCAN,
  JOB_MFD,
  JOB_HILL_MOVES,
  JOB_HILL_APPLY,
  JOB_MARINE_MOVES,
  JOB_MARINE_APPLY,
  JOB_STATUS_CLAMP,
  JOB_FLUVIAL_LEAF,
  JOB_SEDIMENT_LEAF,
  CTRL_ACTIVE_ROUTING,
  REFRESH_CMD,
  REFRESH_CMD_EXIT,
  REFRESH_CMD_RUN,
  REFRESH_DONE,
  REFRESH_POPPED,
  REFRESH_SEQ,
  REFRESH_TARGET,
  type EngineIndex,
  type EngineViews,
  type RoutingViews,
  type TerrainViews,
} from './erosionEngineState'
import { ELEVATION_METERS } from '../elevation/elevationScale'
import {
  DEFAULT_ENGINE_PARAMS,
  FLAG_HAS_STATUS_MASK,
  kernelParamsFor,
  buildRasterIndex,
  loadTerrain,
  createCoordinatorScratch,
  refreshRoutingOn,
  fluvialSerial,
  sedimentSerial,
  collectWalkTallies,
  type CoordinatorScratch,
  type ErosionEngineParams,
  type ErosionForcing,
  type KernelParams,
} from './erosionEngine'

// EROSION V2 — the worker-pool drivers (docs/design/erosion-v2.md, P2
// threading). Same phases as the single-threaded ErosionEngine, with the
// per-cell kernels dispatched to workers over one SharedArrayBuffer and
// the serial walks (flood, λ, accumulation, fluvial, sediment) on the
// coordinator. Because every parallel kernel is per-cell deterministic and
// the flood is one serial pass, pooled output is BYTE-IDENTICAL to the
// single-threaded engine for any worker count —
// scripts/erosion-v2-engine-check.mts gates exactly that.
//
// The coordinator waits BLOCKING (Atomics.wait): its intended home is the
// worldgen worker (itself a worker, allowed to block), and each wait spans
// one kernel dispatch — milliseconds.
//
// The caller supplies the worker factory, because spawning is
// substrate-specific: the browser uses the `?worker` import form (nested
// workers — see generator/CLAUDE.md), Node uses worker_threads pointed at
// erosionEngineWorker.ts. The pool only needs postMessage/terminate and a
// one-time 'ready' message back.

export interface WorkerLike {
  postMessage(message: unknown): void
  terminate(): unknown
  // worker_threads style …
  on?(event: 'message', listener: (value: unknown) => void): unknown
  off?(event: 'message', listener: (value: unknown) => void): unknown
  // … or browser style.
  addEventListener?(event: 'message', listener: (event: { data: unknown }) => void): void
  removeEventListener?(event: 'message', listener: (event: { data: unknown }) => void): void
}

// Workers kept for the next engine instead of terminated: a coupled
// history builds a pipelined engine every epoch (the mesh changes), and a
// thread started for each — loading its modules again — was part of
// every epoch (profiled 2026-10-04, level 1 on 2048×1024: 7 threads per
// epoch). The engine worker takes one init after another
// (erosionEngineWorker.ts), so a kept thread is a fresh engine; nothing of
// the last run survives in it but the loaded code.
export interface ReusableWorkers {
  createWorker: () => WorkerLike
  releaseWorker: (worker: WorkerLike) => void
  // Terminates the kept workers.
  close: () => Promise<void>
}

// `alive` tells a kept worker that has died since (it is dropped): one
// handed to an engine would never answer its init.
export function reusableWorkers(createWorker: () => WorkerLike, alive: (worker: WorkerLike) => boolean = () => true): ReusableWorkers {
  const idle: WorkerLike[] = []
  return {
    createWorker: () => {
      for (let worker = idle.pop(); worker; worker = idle.pop()) if (alive(worker)) return worker
      return createWorker()
    },
    releaseWorker: (worker) => {
      idle.push(worker)
    },
    close: async () => {
      await Promise.all(idle.splice(0).map((worker) => worker.terminate()))
    },
  }
}

// The listener goes once it has heard: a kept worker hears one 'ready'
// per engine, and every engine adds its own.
function onceReady(worker: WorkerLike): Promise<void> {
  return new Promise((resolve) => {
    if (worker.on) {
      const listener = (value: unknown): void => {
        if (value !== 'ready') return
        worker.off?.('message', listener)
        resolve()
      }
      worker.on('message', listener)
    } else if (worker.addEventListener) {
      const listener = (event: { data: unknown }): void => {
        if (event.data !== 'ready') return
        worker.removeEventListener?.('message', listener)
        resolve()
      }
      worker.addEventListener('message', listener)
    } else {
      throw new Error('worker exposes neither on() nor addEventListener()')
    }
  })
}

// What every worker is told once (erosionEngineWorker.ts reads it).
export interface WorkerInit {
  terrain: SharedArrayBuffer
  routingA: SharedArrayBuffer
  routingB: SharedArrayBuffer
  ctrl: SharedArrayBuffer
  done: SharedArrayBuffer
  activeCount: number
  edgeCount: number
  // 'stencil' runs the physics kernels on ctrl/done; 'refresh' runs the
  // routing kernels on the same pair but reads the TARGET routing buffer
  // (and its z-snapshot) selected in refreshCtrl; 'refreshCoordinator'
  // drives the refresh group and runs the refresh's serial parts, waking
  // on refreshCtrl. Synchronous pools spawn only 'stencil' workers with
  // routingA === routingB.
  role: 'stencil' | 'refresh' | 'refreshCoordinator'
  refreshCtrl?: SharedArrayBuffer
  workerId: number
  workerCount: number
  kernelParams: KernelParams
  params: ErosionEngineParams
}

// The shared terrain section, built once by whichever driver creates it —
// over a raster (the index built here) or over a prepared index (a mesh).
function createSharedTerrain(width: number, height: number, initial: Float32Array, forcing: ErosionForcing, params: ErosionEngineParams, prepared?: EngineIndex): { index: EngineIndex; buffer: SharedArrayBuffer; terrain: TerrainViews } {
  const index = prepared ?? buildRasterIndex(width, height, initial, forcing, params)
  if (initial.length < index.cellCount || forcing.uplift.length < index.cellCount || forcing.erodibility.length < index.cellCount) {
    throw new Error('field size mismatch')
  }
  const buffer = new SharedArrayBuffer(terrainBufferBytes(index.activeCount, index.edgeCount))
  const terrain = createTerrainViews(index.activeCount, index.edgeCount, buffer, index)
  loadTerrain(index, terrain, initial, forcing)
  return { index, buffer, terrain }
}

// A wait that sees no change for this long is a worker that died — a
// worker thread out of memory ends without a word, and the coordinator
// would wait for it forever with its event loop blocked: no heartbeat, no
// signal handler (2026-10-02: both job workers of a server, for twenty
// minutes, until SIGKILL). Each wait spans one kernel dispatch, so ten
// minutes without a change is never a slow kernel.
const STALL_MS = 10 * 60_000
const WAIT_SLICE_MS = 30_000

export class EngineStalledError extends Error {
  constructor(what: string) {
    super(`the erosion engine's ${what} made no progress for ${STALL_MS / 60_000} minutes — a worker thread has died`)
    this.name = 'EngineStalledError'
  }
}

// Atomics.wait until `cell` is no longer `value`, in slices, throwing once
// no change has come for STALL_MS.
function waitWhile(cells: Int32Array, cell: number, value: number, what: string): void {
  const since = Date.now()
  while (Atomics.load(cells, cell) === value) {
    if (Atomics.wait(cells, cell, value, WAIT_SLICE_MS) === 'timed-out' && Date.now() - since > STALL_MS) throw new EngineStalledError(what)
  }
}

function waitAll(done: Int32Array, count: number): void {
  let finished
  while ((finished = Atomics.load(done, 0)) < count) waitWhile(done, 0, finished, 'workers')
}

export class PooledErosionEngine {
  readonly width: number
  readonly height: number
  readonly params: ErosionEngineParams
  readonly index: EngineIndex
  readonly views: EngineViews
  readonly workerCount: number
  poppedCount = 0

  private readonly scratch: CoordinatorScratch
  private readonly workers: WorkerLike[]
  private readonly ctrl: Int32Array
  private readonly done: Int32Array
  private readonly kernelParams: KernelParams
  private cursor = 0

  private constructor(
    width: number,
    height: number,
    params: ErosionEngineParams,
    index: EngineIndex,
    views: EngineViews,
    workers: WorkerLike[],
    ctrl: Int32Array,
    done: Int32Array,
  ) {
    this.width = width
    this.height = height
    this.params = params
    this.index = index
    this.views = views
    this.workers = workers
    this.workerCount = workers.length
    this.ctrl = ctrl
    this.done = done
    this.scratch = createCoordinatorScratch(index.activeCount)
    this.kernelParams = kernelParamsFor(index.refM, params)
  }

  // `prepared` runs the pool over a ready index (a mesh) instead of
  // building the raster's.
  static async create(
    width: number,
    height: number,
    initial: Float32Array,
    forcing: ErosionForcing,
    createWorker: () => WorkerLike,
    workerCount: number,
    params: ErosionEngineParams = DEFAULT_ENGINE_PARAMS,
    prepared?: EngineIndex,
  ): Promise<PooledErosionEngine> {
    if (workerCount < 1) throw new Error('workerCount must be >= 1')
    const { index, buffer: terrainBuffer, terrain } = createSharedTerrain(width, height, initial, forcing, params, prepared)
    const routingBuffer = new SharedArrayBuffer(routingBufferBytes(index.activeCount, index.edgeCount))
    const views = assembleViews(terrain, createRoutingViews(index.activeCount, index.edgeCount, routingBuffer))
    const ctrlBuffer = new SharedArrayBuffer(64)
    const doneBuffer = new SharedArrayBuffer(64)
    const kernelParams = kernelParamsFor(index.refM, params)
    const workers: WorkerLike[] = []
    const readies: Promise<void>[] = []
    for (let workerId = 0; workerId < workerCount; workerId++) {
      const worker = createWorker()
      workers.push(worker)
      readies.push(onceReady(worker))
      const init: WorkerInit = {
        terrain: terrainBuffer,
        routingA: routingBuffer,
        routingB: routingBuffer,
        ctrl: ctrlBuffer,
        done: doneBuffer,
        activeCount: index.activeCount,
        edgeCount: index.edgeCount,
        role: 'stencil',
        workerId,
        workerCount,
        kernelParams,
        params,
      }
      worker.postMessage(init)
    }
    await Promise.all(readies)
    return new PooledErosionEngine(width, height, params, index, views, workers, new Int32Array(ctrlBuffer), new Int32Array(doneBuffer))
  }

  get z(): Float32Array {
    return this.views.z
  }

  get erodedFluxM3(): number {
    return this.scratch.erodedFlux[0]
  }

  get exportedFluxM3(): number {
    return this.scratch.exportedFlux[0]
  }

  expandZ(frozenFrom: Float32Array): Float32Array {
    return expandActive(this.index, this.views.z, frozenFrom)
  }

  private dispatch(job: number): void {
    Atomics.store(this.done, 0, 0)
    Atomics.store(this.ctrl, 1, job)
    Atomics.add(this.ctrl, 0, 1)
    Atomics.notify(this.ctrl, 0)
    waitAll(this.done, this.workerCount)
  }

  refreshRouting(): void {
    this.poppedCount = refreshRoutingOn(this.views, this.scratch, () => this.dispatch(JOB_LTD_SCAN), () => this.dispatch(JOB_MFD))
  }

  // The fluvial and sediment walks: serial stages here, leaf stages on the
  // workers. Returns the residual (normalized units).
  private walks(v: EngineViews): number {
    const cellM = this.kernelParams.cellM
    let maxStep = fluvialSerial(v, this.poppedCount, this.params, cellM)
    this.dispatch(JOB_FLUVIAL_LEAF)
    for (let w = 0; w < this.workerCount; w++) maxStep = Math.max(maxStep, v.maxStepW[w])
    this.dispatch(JOB_SEDIMENT_LEAF)
    for (let w = 0; w < this.workerCount; w++) maxStep = Math.max(maxStep, v.maxStepW[w])
    collectWalkTallies(v, this.workerCount, this.scratch)
    return Math.max(maxStep, sedimentSerial(v, this.poppedCount, this.params, cellM, this.scratch))
  }

  stepPhysics(): number {
    let maxStep = 0
    this.dispatch(JOB_UPLIFT)
    maxStep = Math.max(maxStep, this.walks(this.views))
    this.views.maxStepW.fill(0, 0, this.workerCount)
    this.dispatch(JOB_HILL_MOVES)
    this.dispatch(JOB_HILL_APPLY)
    for (let workerId = 0; workerId < this.workerCount; workerId++) {
      maxStep = Math.max(maxStep, this.views.maxStepW[workerId])
    }
    this.dispatch(JOB_MARINE_MOVES)
    this.dispatch(JOB_MARINE_APPLY)
    if (this.views.flags[FLAG_HAS_STATUS_MASK] !== 0) this.dispatch(JOB_STATUS_CLAMP)
    return maxStep * ELEVATION_METERS
  }

  run(iterations: number, routingEvery = 4, onIteration?: (iteration: number, residualM: number) => void): number {
    let residual = Infinity
    let calmStreak = 0
    for (let i = 0; i < iterations; i++) {
      if (this.cursor % routingEvery === 0) this.refreshRouting()
      this.cursor++
      residual = this.stepPhysics()
      calmStreak = residual < this.params.epsM ? calmStreak + 1 : 0
      onIteration?.(i, residual)
      if (calmStreak >= 3) break
    }
    return residual
  }

  async close(): Promise<void> {
    Atomics.store(this.ctrl, 1, JOB_EXIT)
    Atomics.add(this.ctrl, 0, 1)
    Atomics.notify(this.ctrl, 0)
    await Promise.all(this.workers.map((worker) => worker.terminate()))
  }
}

// ---------------------------------------------------------------------------
// The PIPELINED engine: physics never waits for routing. Two routing
// buffers; a dedicated refresh coordinator worker (plus its own small
// worker group) recomputes routing from a z-SNAPSHOT while the stencil
// group and the main coordinator keep iterating on the previous routing.
//
// Determinism is scheduling-free by design:
//   - the snapshot is copied by the MAIN coordinator at a fixed iteration
//     boundary (never while physics mutates z mid-copy),
//   - the swap happens at the NEXT fixed boundary, whether the refresh
//     finished long before it or the coordinator has to wait for it,
//   - so the routing active during [kD, (k+1)D) is always routing(z_{(k-1)D}):
//     staleness D..2D, identical for every worker split and every timing.
// Physics tolerance for that staleness is the measured K-study (K ≤ 8
// statistically equivalent; D defaults to 8 → staleness 8..16, validated
// by the engine-check's stats gate).
//
// The pipelined engine and the single-threaded one are TWO SCHEMES: the
// single one routes afresh every routingEvery iterations, this one on its
// stale cadence. A run of more iterations than either cadence differs in
// the last bits between them (2026-10-02: a level-3 tile, 12 rounds, baked
// with and without a pool) — so every job worker bakes on a pool
// (scripts/jobWorker.ts), and a history epoch stays within both cadences,
// where the two agree bit for bit (harness:mesh checks it).
export const BAKE_PIPELINE_DEPTH = 8

export interface PipelineOptions {
  stencilWorkers: number
  refreshWorkers: number
  // The fixed swap cadence D, iterations. Also the refresh budget: a
  // refresh slower than D iterations of physics stalls the boundary.
  pipelineDepth: number
}

export class PipelinedErosionEngine {
  readonly width: number
  readonly height: number
  readonly params: ErosionEngineParams
  readonly options: PipelineOptions
  readonly index: EngineIndex
  poppedCount = 0

  private readonly terrain: TerrainViews
  private readonly routing: readonly [RoutingViews, RoutingViews]
  private readonly liveViews: readonly [EngineViews, EngineViews]
  private readonly scratch: CoordinatorScratch
  private readonly workers: WorkerLike[]
  private readonly ctrlA: Int32Array
  private readonly doneA: Int32Array
  private readonly ctrlB: Int32Array
  private readonly refreshCtrl: Int32Array
  private readonly kernelParams: KernelParams
  // Where the workers go at close (reusableWorkers); null: terminated.
  private releaseWorker: ((worker: WorkerLike) => void) | null = null
  private activeIndex = -1
  private inFlight = false
  // Global iteration cursor — chunked run() calls must not reset the
  // boundary schedule (determinism holds for a FIXED chunking either way,
  // but the staleness cadence should be uniform across chunk seams).
  private cursor = 0

  private constructor(
    width: number,
    height: number,
    params: ErosionEngineParams,
    options: PipelineOptions,
    index: EngineIndex,
    terrain: TerrainViews,
    routing: readonly [RoutingViews, RoutingViews],
    workers: WorkerLike[],
    ctrlA: Int32Array,
    doneA: Int32Array,
    ctrlB: Int32Array,
    refreshCtrl: Int32Array,
  ) {
    this.width = width
    this.height = height
    this.params = params
    this.options = options
    this.index = index
    this.terrain = terrain
    this.routing = routing
    this.liveViews = [assembleViews(terrain, routing[0]), assembleViews(terrain, routing[1])]
    this.workers = workers
    this.ctrlA = ctrlA
    this.doneA = doneA
    this.ctrlB = ctrlB
    this.refreshCtrl = refreshCtrl
    this.scratch = createCoordinatorScratch(index.activeCount)
    this.kernelParams = kernelParamsFor(index.refM, params)
  }

  // `prepared` runs the pipeline over a ready index (a mesh) instead of
  // building the raster's. `releaseWorker` takes the workers back at close
  // instead of terminating them (reusableWorkers).
  static async create(
    width: number,
    height: number,
    initial: Float32Array,
    forcing: ErosionForcing,
    createWorker: () => WorkerLike,
    options: PipelineOptions,
    params: ErosionEngineParams = DEFAULT_ENGINE_PARAMS,
    prepared?: EngineIndex,
    releaseWorker?: (worker: WorkerLike) => void,
  ): Promise<PipelinedErosionEngine> {
    if (options.stencilWorkers < 1 || options.refreshWorkers < 1 || options.pipelineDepth < 1) {
      throw new Error('pipeline options must all be >= 1')
    }
    const { index, buffer: terrainBuffer, terrain } = createSharedTerrain(width, height, initial, forcing, params, prepared)
    const a = index.activeCount
    const e = index.edgeCount
    const routingBufferA = new SharedArrayBuffer(routingBufferBytes(a, e))
    const routingBufferB = new SharedArrayBuffer(routingBufferBytes(a, e))
    const routing: [RoutingViews, RoutingViews] = [
      createRoutingViews(a, e, routingBufferA),
      createRoutingViews(a, e, routingBufferB),
    ]
    const ctrlABuffer = new SharedArrayBuffer(64)
    const doneABuffer = new SharedArrayBuffer(64)
    const ctrlBBuffer = new SharedArrayBuffer(64)
    const doneBBuffer = new SharedArrayBuffer(64)
    const refreshCtrlBuffer = new SharedArrayBuffer(64)
    const kernelParams = kernelParamsFor(index.refM, params)
    const workers: WorkerLike[] = []
    const readies: Promise<void>[] = []
    const spawn = (message: Omit<WorkerInit, 'terrain' | 'routingA' | 'routingB' | 'activeCount' | 'edgeCount' | 'kernelParams' | 'params'>): void => {
      const worker = createWorker()
      workers.push(worker)
      readies.push(onceReady(worker))
      const init: WorkerInit = {
        terrain: terrainBuffer,
        routingA: routingBufferA,
        routingB: routingBufferB,
        activeCount: a,
        edgeCount: e,
        kernelParams,
        params,
        ...message,
      }
      worker.postMessage(init)
    }
    for (let workerId = 0; workerId < options.stencilWorkers; workerId++) {
      spawn({ role: 'stencil', ctrl: ctrlABuffer, done: doneABuffer, workerId, workerCount: options.stencilWorkers })
    }
    for (let workerId = 0; workerId < options.refreshWorkers; workerId++) {
      spawn({ role: 'refresh', ctrl: ctrlBBuffer, done: doneBBuffer, refreshCtrl: refreshCtrlBuffer, workerId, workerCount: options.refreshWorkers })
    }
    spawn({ role: 'refreshCoordinator', ctrl: ctrlBBuffer, done: doneBBuffer, refreshCtrl: refreshCtrlBuffer, workerId: 0, workerCount: options.refreshWorkers })
    await Promise.all(readies)
    const engine = new PipelinedErosionEngine(
      width, height, params, options, index, terrain, routing, workers,
      new Int32Array(ctrlABuffer), new Int32Array(doneABuffer), new Int32Array(ctrlBBuffer), new Int32Array(refreshCtrlBuffer))
    engine.releaseWorker = releaseWorker ?? null
    return engine
  }

  get z(): Float32Array {
    return this.terrain.z
  }

  get erodedFluxM3(): number {
    return this.scratch.erodedFlux[0]
  }

  get exportedFluxM3(): number {
    return this.scratch.exportedFlux[0]
  }

  expandZ(frozenFrom: Float32Array): Float32Array {
    return expandActive(this.index, this.terrain.z, frozenFrom)
  }

  // The live-z assembly of the currently active routing buffer — what the
  // pass adapter hands to the hydrology bridge after finalizeRouting.
  get activeEngineViews(): EngineViews {
    return this.liveViews[this.activeIndex]
  }

  private get activeViews(): EngineViews {
    return this.liveViews[this.activeIndex]
  }

  // One SYNCHRONOUS refresh of the current terrain, adopted immediately —
  // the pass adapter calls this once after the run so the routing handed
  // to hydrology matches the finished z exactly (in-loop routing is up to
  // a pipeline depth stale by design). Returns the popped count.
  finalizeRouting(): number {
    if (this.inFlight) this.waitAndAdopt()
    this.startRefresh(this.activeIndex === -1 ? 0 : 1 - this.activeIndex)
    this.waitAndAdopt()
    return this.poppedCount
  }

  // The fluvial and sediment walks: serial stages here, leaf stages on the
  // stencil workers, which read the ACTIVE routing buffer for them
  // (refreshCtrl names it). Returns the residual (normalized units).
  private walks(v: EngineViews): number {
    const cellM = this.kernelParams.cellM
    const workers = this.options.stencilWorkers
    let maxStep = fluvialSerial(v, this.poppedCount, this.params, cellM)
    this.dispatchStencil(JOB_FLUVIAL_LEAF)
    for (let w = 0; w < workers; w++) maxStep = Math.max(maxStep, v.maxStepW[w])
    this.dispatchStencil(JOB_SEDIMENT_LEAF)
    for (let w = 0; w < workers; w++) maxStep = Math.max(maxStep, v.maxStepW[w])
    collectWalkTallies(v, workers, this.scratch)
    return Math.max(maxStep, sedimentSerial(v, this.poppedCount, this.params, cellM, this.scratch))
  }

  private dispatchStencil(job: number): void {
    Atomics.store(this.doneA, 0, 0)
    Atomics.store(this.ctrlA, 1, job)
    Atomics.add(this.ctrlA, 0, 1)
    Atomics.notify(this.ctrlA, 0)
    waitAll(this.doneA, this.options.stencilWorkers)
  }

  private startRefresh(target: number): void {
    // The deterministic snapshot: copied HERE, at the boundary, before any
    // further physics mutates z.
    this.routing[target].zSnapshot.set(this.terrain.z)
    Atomics.store(this.refreshCtrl, REFRESH_DONE, 0)
    Atomics.store(this.refreshCtrl, REFRESH_TARGET, target)
    Atomics.store(this.refreshCtrl, REFRESH_CMD, REFRESH_CMD_RUN)
    Atomics.add(this.refreshCtrl, REFRESH_SEQ, 1)
    Atomics.notify(this.refreshCtrl, REFRESH_SEQ)
    this.inFlight = true
  }

  private waitAndAdopt(): void {
    waitWhile(this.refreshCtrl, REFRESH_DONE, 0, 'routing refresh')
    this.activeIndex = Atomics.load(this.refreshCtrl, REFRESH_TARGET)
    this.poppedCount = Atomics.load(this.refreshCtrl, REFRESH_POPPED)
    this.inFlight = false
    // The stencil group's walk jobs follow the adopted buffer.
    Atomics.store(this.ctrlA, CTRL_ACTIVE_ROUTING, this.activeIndex)
  }

  private boundary(): void {
    if (this.activeIndex === -1) {
      // Bootstrap: physics cannot start without routing — one synchronous
      // refresh, then immediately launch the overlapped one (same z, the
      // schedule's k=0 entry).
      this.startRefresh(0)
      this.waitAndAdopt()
      this.startRefresh(1)
      return
    }
    this.waitAndAdopt()
    this.startRefresh(1 - this.activeIndex)
  }

  stepPhysics(): number {
    let maxStep = 0
    this.dispatchStencil(JOB_UPLIFT)
    maxStep = Math.max(maxStep, this.walks(this.activeViews))
    this.terrain.maxStepW.fill(0, 0, this.options.stencilWorkers)
    this.dispatchStencil(JOB_HILL_MOVES)
    this.dispatchStencil(JOB_HILL_APPLY)
    for (let workerId = 0; workerId < this.options.stencilWorkers; workerId++) {
      maxStep = Math.max(maxStep, this.terrain.maxStepW[workerId])
    }
    this.dispatchStencil(JOB_MARINE_MOVES)
    this.dispatchStencil(JOB_MARINE_APPLY)
    if (this.terrain.flags[FLAG_HAS_STATUS_MASK] !== 0) this.dispatchStencil(JOB_STATUS_CLAMP)
    return maxStep * ELEVATION_METERS
  }

  run(iterations: number, onIteration?: (iteration: number, residualM: number) => void): number {
    let residual = Infinity
    let calmStreak = 0
    for (let i = 0; i < iterations; i++) {
      if (this.cursor % this.options.pipelineDepth === 0) this.boundary()
      this.cursor++
      residual = this.stepPhysics()
      calmStreak = residual < this.params.epsM ? calmStreak + 1 : 0
      onIteration?.(i, residual)
      if (calmStreak >= 3) break
    }
    return residual
  }

  async close(): Promise<void> {
    // Never tear down under a refresh in flight — its coordinator is
    // mid-dispatch on ctrlB and would race the exit bump.
    if (this.inFlight) this.waitAndAdopt()
    Atomics.store(this.refreshCtrl, REFRESH_CMD, REFRESH_CMD_EXIT)
    Atomics.add(this.refreshCtrl, REFRESH_SEQ, 1)
    Atomics.notify(this.refreshCtrl, REFRESH_SEQ)
    Atomics.store(this.ctrlA, 1, JOB_EXIT)
    Atomics.add(this.ctrlA, 0, 1)
    Atomics.notify(this.ctrlA, 0)
    Atomics.store(this.ctrlB, 1, JOB_EXIT)
    Atomics.add(this.ctrlB, 0, 1)
    Atomics.notify(this.ctrlB, 0)
    // A kept worker leaves its loop on the exit above and takes the next
    // engine's init after it, in order.
    const release = this.releaseWorker
    if (release) this.workers.forEach((worker) => release(worker))
    else await Promise.all(this.workers.map((worker) => worker.terminate()))
  }
}
