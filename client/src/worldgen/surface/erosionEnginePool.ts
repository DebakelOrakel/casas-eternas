import {
  createEngineViews,
  engineBufferBytes,
  ENGINE_STRIPS,
  JOB_EXIT,
  JOB_UPLIFT,
  JOB_LTD_SCAN,
  JOB_MFD,
  JOB_HILL_MOVES,
  JOB_HILL_APPLY,
  JOB_MARINE_MOVES,
  JOB_MARINE_APPLY,
  JOB_FLOOD_P1,
  JOB_FLOOD_P2,
  type EngineViews,
} from './erosionEngineState'
import {
  DEFAULT_ENGINE_PARAMS,
  FLAG_HAS_COAST_MASK,
  kernelParamsFor,
  createCoordinatorScratch,
  computeOceanSeed,
  solveBorderGraph,
  mergePopOrder,
  lambdaWalk,
  accumulateFlowV2,
  fluvialWalk,
  sedimentWalk,
  type CoordinatorScratch,
  type ErosionEngineParams,
  type ErosionForcing,
} from './erosionEngine'

// EROSION V2 — the worker-pool driver (docs/design/erosion-v2.md, P2
// threading). Same phases as the single-threaded ErosionEngine, with the
// per-cell/per-strip kernels dispatched to workers over one
// SharedArrayBuffer and the serial walks (border graph, merge, λ,
// accumulation, fluvial, sediment) on the coordinator. Because every
// parallel kernel is per-cell deterministic and the flood's strip count is
// fixed, pooled output is BYTE-IDENTICAL to the single-threaded engine for
// any worker count — scripts/erosion-v2-engine-check.mts gates exactly
// that.
//
// The coordinator waits BLOCKING (Atomics.wait): its intended home is the
// worldgen worker (itself a worker, allowed to block), and each wait spans
// one kernel dispatch — milliseconds. The pipelined refresh (routing on
// background workers while physics iterates on the previous routing —
// the plan's answer to the measured serial wall) builds on this driver
// but is NOT in it yet; it needs the routing state double-buffered.
//
// The caller supplies the worker factory, because spawning is
// substrate-specific: the browser uses the `?worker` import form (nested
// workers — see worldgen/CLAUDE.md), Node uses worker_threads pointed at
// erosionEngineWorker.ts. The pool only needs postMessage/terminate and a
// one-time 'ready' message back.

export interface WorkerLike {
  postMessage(message: unknown): void
  terminate(): unknown
  // worker_threads style …
  on?(event: 'message', listener: (value: unknown) => void): unknown
  // … or browser style.
  addEventListener?(event: 'message', listener: (event: { data: unknown }) => void): void
}

function onceReady(worker: WorkerLike): Promise<void> {
  return new Promise((resolve) => {
    if (worker.on) {
      worker.on('message', (value) => {
        if (value === 'ready') resolve()
      })
    } else if (worker.addEventListener) {
      worker.addEventListener('message', (event) => {
        if (event.data === 'ready') resolve()
      })
    } else {
      throw new Error('worker exposes neither on() nor addEventListener()')
    }
  })
}

export class PooledErosionEngine {
  readonly width: number
  readonly height: number
  readonly params: ErosionEngineParams
  readonly views: EngineViews
  readonly workerCount: number
  poppedCount = 0

  private readonly scratch: CoordinatorScratch
  private readonly workers: WorkerLike[]
  private readonly ctrl: Int32Array
  private readonly done: Int32Array

  private constructor(
    width: number,
    height: number,
    params: ErosionEngineParams,
    views: EngineViews,
    workers: WorkerLike[],
    ctrl: Int32Array,
    done: Int32Array,
  ) {
    this.width = width
    this.height = height
    this.params = params
    this.views = views
    this.workers = workers
    this.workerCount = workers.length
    this.ctrl = ctrl
    this.done = done
    this.scratch = createCoordinatorScratch(width, height)
  }

  static async create(
    width: number,
    height: number,
    initial: Float32Array,
    forcing: ErosionForcing,
    createWorker: () => WorkerLike,
    workerCount: number,
    params: ErosionEngineParams = DEFAULT_ENGINE_PARAMS,
  ): Promise<PooledErosionEngine> {
    if (height % ENGINE_STRIPS !== 0) throw new Error(`height ${height} not divisible by ${ENGINE_STRIPS} strips`)
    if (workerCount < 1) throw new Error('workerCount must be >= 1')
    const n = width * height
    if (initial.length !== n || forcing.uplift.length !== n || forcing.erodibility.length !== n) {
      throw new Error('field size mismatch')
    }
    const buffer = new SharedArrayBuffer(engineBufferBytes(width, height))
    const views = createEngineViews(width, height, buffer)
    views.z.set(initial)
    views.uplift.set(forcing.uplift)
    views.erodibility.set(forcing.erodibility)
    if (forcing.coastMask) {
      views.coastMask.set(forcing.coastMask)
      views.flags[FLAG_HAS_COAST_MASK] = 1
    }
    const ctrlBuffer = new SharedArrayBuffer(64)
    const doneBuffer = new SharedArrayBuffer(64)
    const kernelParams = kernelParamsFor(width, params)
    const workers: WorkerLike[] = []
    const readies: Promise<void>[] = []
    for (let workerId = 0; workerId < workerCount; workerId++) {
      const worker = createWorker()
      workers.push(worker)
      readies.push(onceReady(worker))
      worker.postMessage({
        buffer,
        ctrl: ctrlBuffer,
        done: doneBuffer,
        width,
        height,
        workerId,
        workerCount,
        kernelParams,
      })
    }
    await Promise.all(readies)
    return new PooledErosionEngine(width, height, params, views, workers, new Int32Array(ctrlBuffer), new Int32Array(doneBuffer))
  }

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
    return this.scratch.popOrder
  }

  private dispatch(job: number): void {
    Atomics.store(this.done, 0, 0)
    Atomics.store(this.ctrl, 1, job)
    Atomics.add(this.ctrl, 0, 1)
    Atomics.notify(this.ctrl, 0)
    let finished
    while ((finished = Atomics.load(this.done, 0)) < this.workerCount) {
      Atomics.wait(this.done, 0, finished)
    }
  }

  refreshRouting(): void {
    if (!computeOceanSeed(this.views, this.width, this.height, this.scratch)) {
      this.poppedCount = 0
      this.views.flowTarget.fill(-1)
      this.views.accumulation.fill(1)
      return
    }
    this.dispatch(JOB_FLOOD_P1)
    solveBorderGraph(this.views, this.width, this.height, this.scratch)
    this.dispatch(JOB_FLOOD_P2)
    this.poppedCount = mergePopOrder(this.views, this.width, this.height, this.scratch)
    this.dispatch(JOB_LTD_SCAN)
    lambdaWalk(this.views, this.poppedCount, this.scratch)
    this.dispatch(JOB_MFD)
    accumulateFlowV2(this.views, this.width, this.height, this.poppedCount, this.scratch)
  }

  stepPhysics(): number {
    let maxStep = 0
    this.dispatch(JOB_UPLIFT)
    maxStep = Math.max(maxStep, fluvialWalk(this.views, this.width, this.poppedCount, this.params, this.scratch))
    maxStep = Math.max(maxStep, sedimentWalk(this.views, this.width, this.poppedCount, this.params, this.scratch))
    this.views.maxStepW.fill(0, 0, this.workerCount)
    this.dispatch(JOB_HILL_MOVES)
    this.dispatch(JOB_HILL_APPLY)
    for (let workerId = 0; workerId < this.workerCount; workerId++) {
      maxStep = Math.max(maxStep, this.views.maxStepW[workerId])
    }
    this.dispatch(JOB_MARINE_MOVES)
    this.dispatch(JOB_MARINE_APPLY)
    return maxStep * 9000
  }

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

  async close(): Promise<void> {
    Atomics.store(this.ctrl, 1, JOB_EXIT)
    Atomics.add(this.ctrl, 0, 1)
    Atomics.notify(this.ctrl, 0)
    await Promise.all(this.workers.map((worker) => worker.terminate()))
  }
}
