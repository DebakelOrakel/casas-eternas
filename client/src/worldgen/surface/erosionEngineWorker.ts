import {
  createEngineViews,
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
  createFloodScratch,
  kernelFloodPhase1,
  kernelFloodPhase2,
  kernelLtdScan,
  kernelMfd,
  kernelUplift,
  kernelHillMoves,
  kernelHillApply,
  kernelMarineMoves,
  kernelMarineApply,
  type FloodScratch,
  type KernelParams,
} from './erosionEngine'

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
// the nested-worker rule, see worldgen/CLAUDE.md). The only difference is
// where the init message arrives from.

interface InitMessage {
  buffer: SharedArrayBuffer
  ctrl: SharedArrayBuffer
  done: SharedArrayBuffer
  width: number
  height: number
  workerId: number
  workerCount: number
  kernelParams: KernelParams
}

function runLoop(init: InitMessage, ready: () => void): void {
  const { width, height, workerId, workerCount, kernelParams } = init
  const views: EngineViews = createEngineViews(width, height, init.buffer)
  const ctrl = new Int32Array(init.ctrl)
  const done = new Int32Array(init.done)
  const scratch: FloodScratch = createFloodScratch(width, height)
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
