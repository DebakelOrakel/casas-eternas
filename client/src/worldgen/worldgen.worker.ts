import { advanceCrustState, advanceTerrainFeatures, applyRiftAndMergeEvents, createCrustState, type CrustState } from './crust'
import { EROSION_GRID_HEIGHT, EROSION_GRID_WIDTH } from './erosionConfig'
import { runErosionPass, type ErosionPhase, type FlowRouting } from './erosion'
import { sampleElevationBilinear } from './meshDisplacement'
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

// One-shot, unlike stepEpoch — see the module comment near
// erodedElevations below for why this doesn't run automatically.
export interface RunErosionRequest {
  type: 'runErosion'
}

export type WorkerRequest = InitRequest | StepEpochRequest | RunErosionRequest

export interface StateResponse {
  type: 'state'
  pixels: Uint8Array
  totalCount: number
  continentalCount: number
  oceanicCount: number
  epochCount: number
  oldestPlateAge: number
}

export interface ErosionProgressResponse {
  type: 'erosionProgress'
  phase: ErosionPhase
  fraction: number
}

export interface ErosionResponse {
  type: 'erosion'
  width: number
  height: number
  elevations: Float32Array
  // The color texture, regenerated from the *eroded* heightmap rather
  // than the original pre-erosion field — coloring from the original
  // field would show a coastline/relief pattern that no longer matches
  // the now-displaced geometry.
  pixels: Uint8Array
}

export type WorkerResponse = StateResponse | ErosionProgressResponse | ErosionResponse

const workerScope = self as unknown as WorkerScope

let world: PlateWorld | undefined
let crust: CrustState | undefined
let epochCount = 0

// Retained specifically so a future rivers/lakes request can reuse this
// worker's last flow-routing/accumulation result with zero recomputation
// (see the "Rivers/lakes seam" comment at the bottom of erosion.ts) —
// reset to undefined below whenever world/crust changes, since a stale
// routing graph from a superseded world would be actively wrong to reuse.
let erodedElevations: Float32Array | undefined
let lastRouting: FlowRouting | undefined
let lastAccumulation: Float32Array | undefined

function invalidateErosionState(): void {
  erodedElevations = undefined
  lastRouting = undefined
  lastAccumulation = undefined
}

// The actual seam a future 'generateRivers' request handler would call —
// not built yet (see the "Rivers/lakes seam" comment at the bottom of
// erosion.ts), but this is the real access point for it, not a stub.
export function getRetainedErosionState(): { elevations: Float32Array; routing: FlowRouting; accumulation: Float32Array } | undefined {
  if (!erodedElevations || !lastRouting || !lastAccumulation) return undefined
  return { elevations: erodedElevations, routing: lastRouting, accumulation: lastAccumulation }
}

// Downsamples the (higher-resolution) eroded elevation grid onto the
// (lower-resolution) color texture's own grid via the same bilinear
// sampler meshDisplacement.ts uses for mesh vertices — a texture texel
// and a mesh vertex are both just "a point to sample the field at", so
// the same sampling primitive serves both.
function resampleElevationGrid(source: Float32Array, sourceWidth: number, sourceHeight: number, targetWidth: number, targetHeight: number): Float32Array {
  const target = new Float32Array(targetWidth * targetHeight)
  for (let y = 0; y < targetHeight; y++) {
    const v = (y + 0.5) / targetHeight
    const rowBase = y * targetWidth
    for (let x = 0; x < targetWidth; x++) {
      const u = (x + 0.5) / targetWidth
      target[rowBase + x] = sampleElevationBilinear(source, sourceWidth, sourceHeight, u, v)
    }
  }
  return target
}

function postState(): void {
  if (!world || !crust) return
  const pixels = generateWorldTexture(world, crust, TEXTURE_WIDTH, TEXTURE_HEIGHT)
  const response: StateResponse = {
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
    invalidateErosionState()
    postState()
    return
  }

  if (!world || !crust) return

  if (message.type === 'runErosion') {
    const result = runErosionPass(world, crust, EROSION_GRID_WIDTH, EROSION_GRID_HEIGHT, undefined, (phase, fraction) => {
      const progress: ErosionProgressResponse = { type: 'erosionProgress', phase, fraction }
      workerScope.postMessage(progress, [])
    })
    erodedElevations = result.elevations
    lastRouting = result.routing
    lastAccumulation = result.accumulation

    const textureElevations = resampleElevationGrid(erodedElevations, EROSION_GRID_WIDTH, EROSION_GRID_HEIGHT, TEXTURE_WIDTH, TEXTURE_HEIGHT)
    const pixels = generateWorldTexture(world, crust, TEXTURE_WIDTH, TEXTURE_HEIGHT, textureElevations)

    // The response buffer is transferred (detached from this worker), so
    // a copy is sent while the original stays retained above — unlike
    // `pixels` in postState, this data needs to keep living here for the
    // future rivers/lakes reuse noted above.
    const outgoing = erodedElevations.slice()
    const response: ErosionResponse = { type: 'erosion', width: EROSION_GRID_WIDTH, height: EROSION_GRID_HEIGHT, elevations: outgoing, pixels }
    workerScope.postMessage(response, [outgoing.buffer, pixels.buffer])
    return
  }

  stepPlateEpoch(world)
  advanceTerrainFeatures(crust, world)
  advanceCrustState(crust, world)
  applyRiftAndMergeEvents(crust, world)
  epochCount += 1
  invalidateErosionState()
  postState()
}
