import { advanceCrustState, advanceTerrainFeatures, applyRiftAndMergeEvents, createCrustState, type CrustState } from './crust'
import { generatePlateWorld, stepPlateEpoch, type PlateWorld } from './plates'
import { generateWorldTexture } from './texture'
import { TEXTURE_HEIGHT, TEXTURE_WIDTH } from './textureConfig'

// Runs the whole simulation + texture-generation pipeline off the main
// thread. Both used to run inline in WorldGenScreen.ts, which meant every
// "run epoch" step blocked the main thread for as long as texture
// generation took (~600ms+ at 1024x512) — long enough that dragging the
// planet mid-run felt frozen, since pointer events and rendering share
// that same thread. The fix moves the *state* in here entirely (not just
// the texture pass): the main thread never touches PlateWorld/CrustState
// at all, it only ever sends a command and gets a finished pixel buffer
// back, so there's nothing left on the main thread that can block on
// simulation cost.
//
// Cast rather than `/// <reference lib="webworker" />`: this project has
// one tsconfig with lib: ["ES2023", "DOM"] shared by every file
// (including this one), and layering the "webworker" lib on top for just
// this file conflicts with DOM's own declarations of the same globals
// (self, postMessage, ...). `self`, `MessageEvent`, and `Transferable`
// are already declared by the DOM lib (window.postMessage uses them
// too), so casting past DOM's `self: Window` typing to this file's own
// minimal shape avoids the conflict without a second tsconfig/build step
// for one file.
interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
  postMessage(message: WorkerResponse, transfer: Transferable[]): void
}

export interface InitRequest {
  type: 'init'
  seedText: string
  continentCount: number
  ratio: number
}

export interface StepEpochRequest {
  type: 'stepEpoch'
}

export type WorkerRequest = InitRequest | StepEpochRequest

export interface WorkerResponse {
  type: 'state'
  pixels: Uint8Array
  totalCount: number
  continentalCount: number
  oceanicCount: number
  epochCount: number
  oldestPlateAge: number
}

const workerScope = self as unknown as WorkerScope

let world: PlateWorld | undefined
let crust: CrustState | undefined
let epochCount = 0

function postState(): void {
  if (!world || !crust) return
  const pixels = generateWorldTexture(world, crust, TEXTURE_WIDTH, TEXTURE_HEIGHT)
  const response: WorkerResponse = {
    type: 'state',
    pixels,
    totalCount: world.totalCount,
    continentalCount: world.totalCount - world.oceanicCount,
    oceanicCount: world.oceanicCount,
    epochCount,
    oldestPlateAge: Math.max(...world.ages),
  }
  // Transfers the pixel buffer instead of structure-cloning it — a 2MB
  // copy every epoch step would add its own avoidable cost on top of the
  // work this worker exists to move off the main thread.
  workerScope.postMessage(response, [pixels.buffer])
}

workerScope.onmessage = (event) => {
  const message = event.data
  if (message.type === 'init') {
    world = generatePlateWorld(message.seedText, message.continentCount, message.ratio)
    crust = createCrustState(message.seedText, message.continentCount, message.ratio, world.totalCount)
    epochCount = 0
    postState()
    return
  }

  if (!world || !crust) return
  stepPlateEpoch(world)
  advanceTerrainFeatures(crust, world)
  advanceCrustState(crust, world)
  applyRiftAndMergeEvents(crust, world)
  epochCount += 1
  postState()
}
