import type { Raft } from '../crust/raftTypes'
import type { TerrainFeature } from '../tectonics/terrainFeatures'
import { SEA_LEVEL } from '../elevation/elevationScale'
import { buildFeatureBuckets, computeElevation, raftBaselineAt, warpedSamplePoint } from '../elevation/elevationField'
import { fineDetailNoise, ridgedMultifractal } from '../elevation/ridgedNoise'
import { wrapValue } from '../core/field'
import { accumulateFlow, fillDepressionsAndRouteFlow } from './flowRouting'
import type { FlowRouting } from './flowRouting'
import { buildErosionMask, runStreamPowerIterations, runThermalErosion } from './erosion'
import type { ErosionPassParams, StreamPowerParams, ThermalErosionParams } from './erosion'

// Micro-tile erosion — the PROTOTYPE for docs/design/resolution-strategy.md's
// on-demand fine tier, built 2026-08-06 to answer one question empirically:
// does re-simulating a small region at genuinely finer resolution, with
// boundary conditions inherited from the macro world, produce the local
// erosion structure (distributary deltas, resolved valley floors) that the
// 7.8 km/cell macro grid structurally cannot?
//
// Principles, matching the macro/micro contract in the resolution decision:
// - The MACRO world stays authoritative. A tile is derived display/gameplay
//   detail, deterministic from (world, tile placement), never written back —
//   discard and recompute at will, nothing enters the save.
// - The tile's INITIAL terrain is not an upscaled raster: everything before
//   erosion is analytic (rafts, features, ridged noise all take fractional
//   world coordinates), so the tile samples the same functions the macro grid
//   samples, just at sub-cell spacing — genuinely finer tectonics for free.
//   Only erosion is raster-bound, and that is exactly the part re-run here.
// - The tile is a BOUNDED rectangle cut out of the torus (flowRouting's
//   `bounded` mode): its rim is seeded as a drain, and the macro river
//   entering the window is injected as base drainage area so a mouth tile
//   sees its whole upstream catchment, not just in-window rain.

export interface TileSpec {
  // Top-left corner in world (macro-pixel) coordinates; fractional is fine,
  // and a window crossing the wrap seam is fine too (coords wrap per sample).
  x0: number
  y0: number
  // Window extent in macro cells (square), and the refinement factor: the
  // tile grid is (extent*factor)² cells at 1/factor macro-cell spacing.
  extentMacro: number
  factor: number
}

// What the tile needs to know about the world — deliberately the same shape
// the renderer reads (see elevationMapImage.RenderableWorld) minus the
// plate-seed fields the elevation query doesn't use.
export interface TileWorld {
  width: number
  height: number
  rafts: Raft[]
  features: TerrainFeature[]
  oceanAge: Float32Array
  warpSeed: number
  seaLevelOffset: number
}

// Sub-macro-cell starting roughness, in elevation units at amplitude 1 —
// the analytic field is smooth below the ridged noise's finest octave
// (~8 macro px), so a freshly-sampled tile is glass at fine scale and the
// priority flood would route its rivers on numerical noise. The same
// reasoning as EROSION_PLAIN_FACTOR's "not zero": drainage needs texture to
// pick a side. fineDetailNoise is torus-periodic and world-anchored, so the
// same tile always regenerates the same roughness, and adjacent tiles agree.
//
// HEIGHT-SCALED, fading out toward sea level (prototype run 6's lesson): on a
// low coastal plain everything that should guide the trunk river — the
// inherited macro valley (only metres deep there, EROSION_PLAIN_FACTOR damps
// plain incision on purpose) and the stream-burnt groove (scaled to the same
// small headroom) — is smaller than a full ±30 m of noise, so the noise won,
// the river wandered off its macro course and shattered below the delta gate.
// Full roughness stays in the highlands, where competing micro-valleys are
// exactly what we want. Ocean cells get none (nothing routes on the seabed
// and deltas read cleaner against a smooth floor).
const TILE_SEED_ROUGHNESS = 30 / 9000 // ~30 m peak amplitude
function tileSeedRoughnessAmplitude(elevation: number): number {
  if (elevation <= SEA_LEVEL) return 0
  return Math.min(TILE_SEED_ROUGHNESS, elevation * 0.5)
}

// The macro EROSION's own result, inherited as a low-frequency correction:
// (macro eroded − macro tectonic) at macro resolution, sampled bilinear.
// Without this the tile starts from the raw tectonic field — and the first
// prototype run showed exactly why that fails: the valley that leads the
// macro river to its mouth was carved by MACRO EROSION and does not exist in
// the tectonic field at all, so the injected catchment entered the window,
// found no valley, and drained straight back off the rim. The tile must
// inherit the macro world's large-scale erosion (it is authoritative,
// including its carving) and only REFINE it — analytic fine detail on top of
// the macro-eroded shape, not a from-scratch alternative history.
export interface MacroErosionDelta {
  // eroded − tectonic, per macro cell, full macro resolution
  field: Float32Array
  width: number
  height: number
}

function sampleBilinearWrapped(field: Float32Array, w: number, h: number, x: number, y: number): number {
  const x0 = Math.floor(x - 0.5)
  const y0 = Math.floor(y - 0.5)
  const fx = x - 0.5 - x0
  const fy = y - 0.5 - y0
  const x0m = ((x0 % w) + w) % w
  const y0m = ((y0 % h) + h) % h
  const x1m = (x0m + 1) % w
  const y1m = (y0m + 1) % h
  const v00 = field[y0m * w + x0m]
  const v10 = field[y0m * w + x1m]
  const v01 = field[y1m * w + x0m]
  const v11 = field[y1m * w + x1m]
  return (v00 + (v10 - v00) * fx) * (1 - fy) + (v01 + (v11 - v01) * fx) * fy
}

export function buildTileElevation(world: TileWorld, spec: TileSpec, macroDelta?: MacroErosionDelta): Float32Array {
  const n = spec.extentMacro * spec.factor
  const out = new Float32Array(n * n)
  const buckets = buildFeatureBuckets(world.features, world.width, world.height)
  const noiseSeed = (world.warpSeed ^ 0x51ed270b) >>> 0
  for (let j = 0; j < n; j++) {
    const worldY = wrapValue(spec.y0 + (j + 0.5) / spec.factor, world.height)
    for (let i = 0; i < n; i++) {
      const worldX = wrapValue(spec.x0 + (i + 0.5) / spec.factor, world.width)
      const s = warpedSamplePoint(worldX, worldY, world.width, world.height, world.warpSeed)
      const base = raftBaselineAt(worldX, worldY, world.rafts, world.oceanAge, world.width, world.height, world.warpSeed, world.seaLevelOffset)
      let e = computeElevation(s.wx, s.wy, base, buckets, world.width, world.height, ridgedMultifractal(s.wx, s.wy, world.width, world.height, world.warpSeed))
      if (macroDelta) e += sampleBilinearWrapped(macroDelta.field, macroDelta.width, macroDelta.height, worldX, worldY)
      out[j * n + i] = e + fineDetailNoise(s.wx, s.wy, world.width, world.height, noiseSeed) * tileSeedRoughnessAmplitude(e)
    }
  }
  return out
}

// Macro erosion params rescaled for a tile refined by `factor`. The
// reasoning, term by term (code slope S halves per doubling of resolution
// for the same physical terrain, drainage area A in cells grows as factor²):
// - erodibilityK: dh = -K·√A·S is scale-free at the default m=0.5, n=1
//   (√(factor²)·(1/factor) = 1) — kept as-is.
// - transportCapacityKt: capacity Kt·A·S picks up one net power of factor
//   (factor²·(1/factor)); divided by factor to keep delta volumes in the
//   same regime. A starting estimate, not a calibration.
// - deltaMinDrainageCells: an area threshold — scaled by factor², then
//   divided by 4: MFD routing deliberately splits a trunk into several
//   distributary strands near a flat mouth (3-5 in practice), and the gate's
//   job — "no deltas from coastal trickles" — is a judgment about the river
//   SYSTEM, which already passed it at macro scale. Without the allowance,
//   every individual strand of a fully qualified river fails the per-cell
//   test and the tile builds no delta at all (prototype run 6, measured:
//   best strand 39k fine units against a raw factor²-gate of 128k).
// - talusSlope: a physical angle expressed as code slope — divided by factor.
// - Iteration/round counts kept: the tile is far smaller than the world, so
//   generous iterations are cheap where it matters.
export function scaleErosionParamsForTile(macro: ErosionPassParams, factor: number): ErosionPassParams {
  const streamPower: StreamPowerParams = {
    ...macro.streamPower,
    transportCapacityKt: macro.streamPower.transportCapacityKt / factor,
    deltaMinDrainageCells: (macro.streamPower.deltaMinDrainageCells * factor * factor) / 4,
  }
  const thermal: ThermalErosionParams = {
    ...macro.thermal,
    talusSlope: macro.thermal.talusSlope / factor,
  }
  return { ...macro, streamPower, thermal }
}

export interface TileErosionResult {
  elevations: Float32Array
  routing: FlowRouting
  accumulation: Float32Array
}

// The tile-sized sibling of runErosionPass's round loop: uplift toward the
// tile's own tectonic envelope, bounded flood/route, fluvial with network
// refreshes, thermal — same phases, same order, same reuse of the actual
// erosion functions. Deliberately NOT runErosionPass itself: that one is
// wired for the full torus (progress phases, cancellation, pre-fill capture
// for global hydrology) and its routing calls must stay torus-mode; a thin
// bounded copy of the ~30-line loop reads better than threading a `bounded`
// flag through every consumer of the global pass.
//
// `inflow`, if given, must be a full base-accumulation array (per-cell rain
// weight of 1 plus the macro catchment injected at the entry cells) — see
// accumulateFlow's baseAccumulation parameter.
export async function runTileErosion(envelope: Float32Array, n: number, params: ErosionPassParams, inflow?: Float32Array): Promise<TileErosionResult> {
  const elevations0 = envelope.slice()
  const erosionMask = buildErosionMask(envelope)
  let elevations = elevations0
  let routing: FlowRouting | undefined
  let accumulation: Float32Array | undefined

  for (let round = 0; round < params.rounds; round++) {
    if (params.upliftRate > 0) {
      for (let i = 0; i < elevations.length; i++) {
        const env = envelope[i]
        if (env <= SEA_LEVEL) continue
        const restored = elevations[i] + env * params.upliftRate
        elevations[i] = restored < env ? restored : env
      }
    }
    const isLand = new Uint8Array(elevations.length)
    for (let i = 0; i < elevations.length; i++) isLand[i] = elevations[i] > SEA_LEVEL ? 1 : 0

    routing = await fillDepressionsAndRouteFlow(elevations, n, n, SEA_LEVEL, undefined, true)
    accumulation = accumulateFlow(routing, inflow)

    const refreshes = Math.max(1, params.networkRefreshes)
    const itersPerRefresh = Math.max(1, Math.round(params.streamPower.iterations / refreshes))
    const refreshParams: StreamPowerParams = { ...params.streamPower, iterations: itersPerRefresh }
    for (let r = 0; r < refreshes; r++) {
      if (r > 0) {
        routing = await fillDepressionsAndRouteFlow(elevations, n, n, SEA_LEVEL, undefined, true)
        accumulation = accumulateFlow(routing, inflow)
      }
      elevations = routing.filled.slice()
      await runStreamPowerIterations(elevations, routing, accumulation, isLand, n, n, refreshParams, erosionMask, envelope)
    }
    await runThermalErosion(elevations, isLand, n, n, params.thermal)
  }

  return { elevations, routing: routing!, accumulation: accumulation! }
}
