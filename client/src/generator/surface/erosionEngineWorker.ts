import {
  createTerrainViews,
  createRoutingViews,
  assembleViews,
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
  JOB_STATUS_CLAMP,
  type EngineViews,
} from './erosionEngineState'
import {
  createFloodScratch,
  createCoordinatorScratch,
  computeOceanSeed,
  solveBorderGraph,
  mergePopOrder,
  lambdaWalk,
  accumulateFlowV2,
  kernelFloodPhase1,
  kernelFloodPhase2,
  kernelLtdScan,
  kernelMfd,
  kernelUplift,
  kernelHillMoves,
  kernelHillApply,
  kernelMarineMoves,
  kernelMarineApply,
  kernelStatusClamp,
  type FloodScratch,
  type KernelParams,
} from './erosionEngine'
import {
  REFRESH_CMD,
  REFRESH_CMD_EXIT,
  REFRESH_DONE,
  REFRESH_POPPED,
  REFRESH_SEQ,
  REFRESH_TARGET,
} from './erosionEngineState'

// EROSION V2 — the pool worker (docs/design/erosion-v2.md, P2 threading).
//
// One init message carries the shared buffer plus this worker's identity;
// after that, ALL control flows through Atomics on the ctrl/done arrays —
// the worker parks in a blocking Atomics.wait (legal here: this is a
// dedicated worker, not a main thread) and never touches the message loop
// again until JOB_EXIT. The kernels it runs are the same functions the
// single-threaded ErosionEngine calls; determinism across worker counts is
// the state layout's job, not this file's.
//
// Runs under BOTH substrates: worker_threads (the Node harness/baker) and
// a browser Worker (the generator; spawned via the `?worker` import form —
// the nested-worker rule, see generator/CLAUDE.md). The only difference is
// where the init message arrives from.

interface InitMessage {
  terrain: SharedArrayBuffer
  routingA: SharedArrayBuffer
  routingB: SharedArrayBuffer
  ctrl: SharedArrayBuffer
  done: SharedArrayBuffer
  width: number
  height: number
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
}

function runLoop(init: InitMessage, ready: () => void): void {
  const { width, height, workerId, workerCount, kernelParams } = init
  const terrain = createTerrainViews(width, height, init.terrain)
  const routingA = createRoutingViews(width, height, init.routingA)
  const routingB = createRoutingViews(width, height, init.routingB)
  // Stencil kernels never read routing state, so their assembly's routing
  // half is arbitrary; the refresh group reads the snapshot-z assembly of
  // whichever buffer refreshCtrl names.
  const liveViews: EngineViews = assembleViews(terrain, routingA)
  const snapshotViews: readonly [EngineViews, EngineViews] = [
    assembleViews(terrain, routingA, true),
    assembleViews(terrain, routingB, true),
  ]
  const ctrl = new Int32Array(init.ctrl)
  const done = new Int32Array(init.done)
  const refreshCtrl = init.refreshCtrl ? new Int32Array(init.refreshCtrl) : null
  const scratch: FloodScratch = createFloodScratch(width, height)

  if (init.role === 'refreshCoordinator') {
    runRefreshCoordinator(init, snapshotViews, ctrl, done, refreshCtrl!, ready)
    return
  }

  // Even row partition for the per-cell jobs.
  const rowsPer = Math.ceil(height / workerCount)
  const r0 = Math.min(height, workerId * rowsPer)
  const r1 = Math.min(height, (workerId + 1) * rowsPer)
  ready()
  let seen = 0
  for (;;) {
    Atomics.wait(ctrl, 0, seen)
    seen = Atomics.load(ctrl, 0)
    const job = Atomics.load(ctrl, 1)
    if (job === JOB_EXIT) break
    const views = init.role === 'refresh' && refreshCtrl
      ? snapshotViews[Atomics.load(refreshCtrl, REFRESH_TARGET)]
      : liveViews
    switch (job) {
      case JOB_UPLIFT:
        kernelUplift(views, width, r0, r1, kernelParams)
        break
      case JOB_LTD_SCAN:
        kernelLtdScan(views, width, height, r0, r1)
        break
      case JOB_MFD:
        kernelMfd(views, width, height, r0, r1)
        break
      case JOB_HILL_MOVES:
        kernelHillMoves(views, width, height, r0, r1, kernelParams)
        break
      case JOB_HILL_APPLY:
        kernelHillApply(views, width, height, r0, r1, workerId)
        break
      case JOB_MARINE_MOVES:
        kernelMarineMoves(views, width, height, r0, r1, kernelParams)
        break
      case JOB_MARINE_APPLY:
        kernelMarineApply(views, width, height, r0, r1)
        break
      case JOB_STATUS_CLAMP:
        kernelStatusClamp(views, width, r0, r1)
        break
      case JOB_FLOOD_P1:
        for (let strip = workerId; strip < ENGINE_STRIPS; strip += workerCount) {
          kernelFloodPhase1(views, width, height, strip, scratch)
        }
        break
      case JOB_FLOOD_P2:
        for (let strip = workerId; strip < ENGINE_STRIPS; strip += workerCount) {
          kernelFloodPhase2(views, width, height, strip, scratch)
        }
        break
    }
    Atomics.add(done, 0, 1)
    Atomics.notify(done, 0)
  }
}

// The refresh coordinator: parks on refreshCtrl, and per RUN command
// recomputes the target buffer's routing from its z-SNAPSHOT — kernels
// dispatched to the refresh group over ctrl/done, serial parts (ocean,
// border graph, merge, λ, accumulation) right here, OFF the main
// coordinator's iteration path. Sets the done flag when the buffer is
// complete; the main coordinator swaps it in at its fixed boundary.
function runRefreshCoordinator(
  init: InitMessage,
  snapshotViews: readonly [EngineViews, EngineViews],
  ctrl: Int32Array,
  done: Int32Array,
  refreshCtrl: Int32Array,
  ready: () => void,
): void {
  const { width, height, workerCount } = init
  const scratch = createCoordinatorScratch(width, height)
  const dispatch = (job: number): void => {
    Atomics.store(done, 0, 0)
    Atomics.store(ctrl, 1, job)
    Atomics.add(ctrl, 0, 1)
    Atomics.notify(ctrl, 0)
    let finished
    while ((finished = Atomics.load(done, 0)) < workerCount) {
      Atomics.wait(done, 0, finished)
    }
  }
  ready()
  let seen = 0
  for (;;) {
    Atomics.wait(refreshCtrl, REFRESH_SEQ, seen)
    seen = Atomics.load(refreshCtrl, REFRESH_SEQ)
    if (Atomics.load(refreshCtrl, REFRESH_CMD) === REFRESH_CMD_EXIT) break
    const views = snapshotViews[Atomics.load(refreshCtrl, REFRESH_TARGET)]
    let popped = 0
    if (computeOceanSeed(views, width, height, scratch)) {
      dispatch(JOB_FLOOD_P1)
      solveBorderGraph(views, width, height, scratch)
      dispatch(JOB_FLOOD_P2)
      popped = mergePopOrder(views, width, height)
      dispatch(JOB_LTD_SCAN)
      lambdaWalk(views, popped, scratch)
      dispatch(JOB_MFD)
      accumulateFlowV2(views, width, height, popped)
    } else {
      views.flowTarget.fill(-1)
      views.accumulation.fill(1)
    }
    Atomics.store(refreshCtrl, REFRESH_POPPED, popped)
    Atomics.store(refreshCtrl, REFRESH_DONE, 1)
    Atomics.notify(refreshCtrl, REFRESH_DONE)
  }
}

// Substrate detection: worker_threads' parentPort exists only under Node;
// a browser dedicated worker has postMessage on its global scope.
declare const self: { onmessage: ((e: { data: InitMessage }) => void) | null; postMessage: (m: unknown) => void } | undefined

async function boot(): Promise<void> {
  if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
    const scope = self
    scope.onmessage = (event) => {
      scope.onmessage = null
      runLoop(event.data, () => scope.postMessage('ready'))
    }
    return
  }
  const { parentPort } = await import('node:worker_threads')
  if (!parentPort) throw new Error('erosionEngineWorker: no worker substrate')
  parentPort.once('message', (init: InitMessage) => {
    runLoop(init, () => parentPort.postMessage('ready'))
    parentPort.close()
  })
}

void boot()
