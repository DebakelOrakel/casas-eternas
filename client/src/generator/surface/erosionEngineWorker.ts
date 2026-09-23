import {
  createTerrainViews,
  createRoutingViews,
  assembleViews,
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
  REFRESH_DONE,
  REFRESH_POPPED,
  REFRESH_SEQ,
  REFRESH_TARGET,
  type EngineViews,
} from './erosionEngineState'
import {
  createCoordinatorScratch,
  refreshRoutingOn,
  kernelLtdScan,
  kernelMfd,
  kernelUplift,
  kernelHillMoves,
  kernelHillApply,
  kernelMarineMoves,
  kernelMarineApply,
  kernelStatusClamp,
  kernelFluvialLeaf,
  kernelSedimentLeaf,
} from './erosionEngine'
import type { WorkerInit } from './erosionEnginePool'

// EROSION V2 — the pool worker (docs/design/erosion-v2.md, P2 threading).
//
// One init message carries the shared buffers plus this worker's identity;
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

function runLoop(init: WorkerInit, ready: () => void): void {
  const { activeCount, edgeCount, workerId, workerCount, kernelParams, params } = init
  const terrain = createTerrainViews(activeCount, edgeCount, init.terrain)
  const routingA = createRoutingViews(activeCount, edgeCount, init.routingA)
  const routingB = createRoutingViews(activeCount, edgeCount, init.routingB)
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

  if (init.role === 'refreshCoordinator') {
    runRefreshCoordinator(init, snapshotViews, ctrl, done, refreshCtrl!, ready)
    return
  }

  // The walks' leaf jobs read the routing the main coordinator iterates on
  // (live z, the active buffer — ctrl[CTRL_ACTIVE_ROUTING] names it).
  const liveByBuffer: readonly [EngineViews, EngineViews] = [liveViews, assembleViews(terrain, routingB)]
  const walkViews = (): EngineViews => liveByBuffer[Atomics.load(ctrl, CTRL_ACTIVE_ROUTING)]
  // Even partition of the active range for the per-cell jobs.
  const per = Math.ceil(activeCount / workerCount)
  const a0 = Math.min(activeCount, workerId * per)
  const a1 = Math.min(activeCount, (workerId + 1) * per)
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
        kernelUplift(views, a0, a1, kernelParams)
        break
      case JOB_LTD_SCAN:
        kernelLtdScan(views, a0, a1)
        break
      case JOB_MFD:
        kernelMfd(views, a0, a1)
        break
      case JOB_HILL_MOVES:
        kernelHillMoves(views, a0, a1, kernelParams)
        break
      case JOB_HILL_APPLY:
        kernelHillApply(views, a0, a1, kernelParams, workerId)
        break
      case JOB_MARINE_MOVES:
        kernelMarineMoves(views, a0, a1, kernelParams)
        break
      case JOB_MARINE_APPLY:
        kernelMarineApply(views, a0, a1, kernelParams)
        break
      case JOB_STATUS_CLAMP:
        kernelStatusClamp(views, a0, a1)
        break
      case JOB_FLUVIAL_LEAF:
        kernelFluvialLeaf(walkViews(), workerId, workerCount, params, kernelParams.cellM)
        break
      case JOB_SEDIMENT_LEAF:
        kernelSedimentLeaf(walkViews(), workerId, workerCount, params, kernelParams.cellM)
        break
    }
    Atomics.add(done, 0, 1)
    Atomics.notify(done, 0)
  }
}

// The refresh coordinator: parks on refreshCtrl, and per RUN command
// recomputes the target buffer's routing from its z-SNAPSHOT — the two
// scans dispatched to the refresh group over ctrl/done, the serial parts
// (seeds, flood, λ, accumulation) right here, OFF the main coordinator's
// iteration path. Sets the done flag when the buffer is complete; the main
// coordinator swaps it in at its fixed boundary.
function runRefreshCoordinator(
  init: WorkerInit,
  snapshotViews: readonly [EngineViews, EngineViews],
  ctrl: Int32Array,
  done: Int32Array,
  refreshCtrl: Int32Array,
  ready: () => void,
): void {
  const { activeCount, workerCount } = init
  const scratch = createCoordinatorScratch(activeCount)
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
    const popped = refreshRoutingOn(views, scratch, () => dispatch(JOB_LTD_SCAN), () => dispatch(JOB_MFD))
    Atomics.store(refreshCtrl, REFRESH_POPPED, popped)
    Atomics.store(refreshCtrl, REFRESH_DONE, 1)
    Atomics.notify(refreshCtrl, REFRESH_DONE)
  }
}

// Substrate detection: worker_threads' parentPort exists only under Node;
// a browser dedicated worker has postMessage on its global scope.
declare const self: { onmessage: ((e: { data: WorkerInit }) => void) | null; postMessage: (m: unknown) => void } | undefined

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
  parentPort.once('message', (init: WorkerInit) => {
    runLoop(init, () => parentPort.postMessage('ready'))
    parentPort.close()
  })
}

void boot()
