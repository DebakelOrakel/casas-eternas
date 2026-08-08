import { AMPLIFICATION_EROSION_OVERRIDES, amplifyElevation } from './amplify'
import { DEFAULT_EROSION_PASS_PARAMS, erosionParamsWithControls, runErosionPass, scaleErosionParamsForCellSize } from './erosion'
import { fillDepressionsAndRouteFlow } from './flowRouting'
import { slopeFromAngle } from '../elevation/elevationScale'
import { accumulateDischarge, channelThreshold, densityToCriticalArea, extractRiverPolylines, maxDischargeOverLand, meanLandRunoff } from './hydrology'
import type { RiverPolylines } from './hydrology'

// The amplification bake itself: upsample, seed roughness, erode, re-run
// hydrology (docs/decisions/worldmap-amplification.md).
//
// Lifted out of amplificationWorker when the SERVER learned to bake. The
// worker is now a thin postMessage wrapper around this, and the Node baker
// calls it directly — which is the point: an artifact carries a key derived
// from its inputs, so a browser bake and a server bake of the same world MUST
// produce the same bytes. Two copies of this function would be two pipelines
// that agree only until someone edits one.
//
// No DOM, no worker globals, no Babylon — that is what lets it run in both
// places, and it is a rule worth keeping rather than a coincidence.

export type AmplifyPhase = 'seed' | 'erosion' | 'hydrology'

export interface AmplifyRequest {
  // The authoritative macro elevation raster — the only terrain a save carries.
  elevation: Float32Array
  macroWidth: number
  macroHeight: number
  // Linear refinement factor: 2 → 4096x2048, 4 → 8192x4096.
  factor: number
  // Derived from the world so a given world always bakes identically.
  seed: number
  // Erosion rounds on the amplified field. 0 skips erosion, which is still
  // useful for isolating the seed layer.
  erosionRounds: number
  // The WORLD'S OWN erosion settings, as recorded in its save. A world tuned
  // for gentle incision must not come back carved like an aggressive one.
  // Undefined falls back to the defaults (older saves).
  erosionStrength?: number
  drainageRefresh?: number
  // Climate for the hydrology re-run. Coarse by nature and simply sampled
  // onto the fine grid — precipitation is a regional quantity. Absent for a
  // world saved before climate was computed; the bake then stops after erosion.
  precipitation?: Float32Array
  climateResX?: number
  climateResY?: number
  riverDensity?: number
}

export interface AmplifyResult {
  elevation: Float32Array
  width: number
  height: number
  rivers: RiverPolylines
}

export async function runAmplification(
  request: AmplifyRequest,
  onProgress: (phase: AmplifyPhase, fraction: number) => void = () => {},
): Promise<AmplifyResult> {
  const result = amplifyElevation(
    request.elevation, request.macroWidth, request.macroHeight,
    request.factor, request.seed,
    (fraction) => onProgress('seed', fraction),
  )

  let field = result.data
  if (request.erosionRounds > 0) {
    // The seeded field IS the tectonic surface as far as this pass is
    // concerned: runErosionPass reads its input both as the terrain to erode
    // and as the uplift envelope it may not exceed, which is exactly the
    // contract wanted here — the macro world (refined) stays the ceiling, so
    // amplification carves INTO the authoritative shape but never past it.
    //
    // Order matters only for readability, not arithmetic: the world's own
    // slider settings first (what this world's erosion MEANS), then the
    // per-cell rescaling (what the finer grid needs), then the round budget.
    const withControls = erosionParamsWithControls(DEFAULT_EROSION_PASS_PARAMS, {
      strength: request.erosionStrength,
      networkRefreshes: request.drainageRefresh,
    })
    const scaled = scaleErosionParamsForCellSize(withControls, 1 / request.factor)
    const params = {
      ...scaled,
      rounds: request.erosionRounds,
      // Amplification is not landscape evolution; the three overrides and
      // their reasoning live in amplify.AMPLIFICATION_EROSION_OVERRIDES,
      // beside the rest of the bake's policy (and where the cache key hashes
      // them).
      upliftRate: AMPLIFICATION_EROSION_OVERRIDES.upliftRate,
      plainFactor: AMPLIFICATION_EROSION_OVERRIDES.plainFactor,
      thermal: {
        ...scaled.thermal,
        talusSlope: slopeFromAngle(AMPLIFICATION_EROSION_OVERRIDES.talusAngleDeg) * (1 / request.factor),
      },
    }
    const eroded = await runErosionPass(field, result.width, result.height, params, (_phase, fraction) => onProgress('erosion', fraction))
    field = eroded.elevations
  }

  // Hydrology RE-RUN on the amplified field: the save's rivers were routed on
  // the macro raster and would now lie beside the fine valleys this bake just
  // carved, so they are re-derived rather than carried over.
  let rivers: RiverPolylines = { points: new Float32Array(0), lengths: new Uint32Array(0) }
  if (request.precipitation && request.climateResX && request.climateResY) {
    onProgress('hydrology', 0)
    const routing = await fillDepressionsAndRouteFlow(field, result.width, result.height, 0)
    onProgress('hydrology', 0.6)
    const discharge = accumulateDischarge(routing, field, request.precipitation, request.climateResX, request.climateResY)
    const maxDischarge = maxDischargeOverLand(discharge, field)
    const meanRunoff = meanLandRunoff(request.precipitation, field, result.width, result.height, request.climateResX, request.climateResY)
    // The channel criterion is a cell COUNT and is used as one, at every
    // stage — NOT rescaled to a constant physical catchment the way the
    // erosion constants are. That is what makes a finer bake produce a richer
    // river network rather than the same one with more vertices; amplify.ts
    // carries the measurements behind the decision.
    const criticalArea = densityToCriticalArea(request.riverDensity ?? 55)
    rivers = extractRiverPolylines(routing, discharge, field, channelThreshold(criticalArea, meanRunoff), maxDischarge)
    onProgress('hydrology', 1)
  }

  return { elevation: field, width: result.width, height: result.height, rivers }
}
