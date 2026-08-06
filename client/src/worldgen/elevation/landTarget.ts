import type { Raft } from '../crust/raftTypes'
import { buildFeatureBuckets, computeElevation, computeRaftBaseline, warpedSamplePoint } from './elevationField'
import { ridgedMultifractal } from './ridgedNoise'
import { SEA_LEVEL, metersToElevation } from './elevationScale'

// The water control, as a TARGET rather than a displacement.
//
// It used to be a straight metre shift of the elevation anchors: slider 0-100 mapped
// linearly onto ±1350 m. That is honest physics — more water loads the basins and the
// freeboard drops — but it made a poor control, because the same setting meant
// something different in every world. Measured at the neutral setting, one seed came
// out at 11.5% land and another at 2.8%: a factor of four from the seed alone, which
// is far more than the whole slider's range could compensate (15% down to 5% across
// its full sweep). Pushing the slider up on a land-poor world just drowned what little
// there was, which is exactly what it looked like.
//
// So the slider now says how much land the world should START with, and the offset
// that produces it is solved for. A setting then means the same thing everywhere.
//
// What it deliberately does NOT do is hold the fraction there. Land is conserved by
// the crust sink and rafts genuinely cycle, so the share drifts as tectonics runs —
// that is a built behaviour, not drift to be corrected, and pinning it would quietly
// disable it. This sets the starting point and then lets go.

// The search range for the offset, which is wider than the old slider's ±1350 m and
// deliberately lopsided. Downward (less water, more land) there is room to spare —
// ABYSSAL_FLOOR sits at −0.633 against the −1 clamp, some 3300 m of headroom. Upward
// there is very little, because it is the land's own height that runs out: the
// continental interior anchor is only 360 m, so a few hundred metres of extra water
// already reaches it. The old symmetric range was sized against the wrong end.
const OFFSET_SEARCH_MIN_M = -3000
const OFFSET_SEARCH_MAX_M = 1350

// The slider's ends, as land fractions of the whole map. Earth is ~29%; these worlds
// run leaner because the map is a quarter-Earth and the Archean makes its own crust.
export const LAND_TARGET_MIN = 0.03
export const LAND_TARGET_MAX = 0.30

export function waterSliderToLandTarget(slider: number): number {
  const s = Math.min(100, Math.max(0, slider)) / 100
  // Inverted: slider up = more water = less land, which is the direction the control
  // had before and the one the label describes.
  return LAND_TARGET_MAX + (LAND_TARGET_MIN - LAND_TARGET_MAX) * s
}

// Coarse grid for the search. An eighth was tried first and is NOT good enough: at low
// land fractions the coastline breaks into fragments that 62-km point sampling walks
// straight past, so the search stopped at a measured 3% that was really 6.15%. A
// quarter costs four times as much per step and tracks full resolution closely.
const SOLVE_DIVISOR = 4

function landFractionAt(
  rafts: Raft[],
  oceanAge: Float32Array,
  warpSeed: number,
  offset: number,
  worldWidth: number,
  worldHeight: number,
): number {
  const w = Math.max(1, Math.floor(worldWidth / SOLVE_DIVISOR))
  const h = Math.max(1, Math.floor(worldHeight / SOLVE_DIVISOR))
  const baseline = computeRaftBaseline(rafts, oceanAge, w, h, worldWidth, worldHeight, warpSeed, offset)
  // No terrain features yet at the hand-over — mountains are raised by tectonics from
  // here on, and they only ever ADD land, so this measures the floor the world starts
  // from rather than where it will settle.
  const buckets = buildFeatureBuckets([], worldWidth, worldHeight)
  const scaleX = worldWidth / w
  const scaleY = worldHeight / h
  let land = 0
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const s = warpedSamplePoint(px * scaleX, py * scaleY, worldWidth, worldHeight, warpSeed)
      const e = computeElevation(s.wx, s.wy, baseline[py * w + px], buckets, worldWidth, worldHeight, ridgedMultifractal(s.wx, s.wy, worldWidth, worldHeight, warpSeed))
      if (e > SEA_LEVEL) land++
    }
  }
  return land / (w * h)
}

export interface LandTargetSolution {
  offset: number // elevation units, for PlateSimulation.seaLevelOffset
  achieved: number // the land fraction actually reached — may fall short of the target
}

// Bisection on the offset. Land fraction falls monotonically as the offset rises (more
// water), so the bracket is well behaved and ~18 steps pin it to under a metre.
//
// The target can be out of reach: a seed whose Archean produced little crust cannot be
// made into a 30%-land world by lowering the sea alone, and the search stops at its
// bracket instead of pretending. `achieved` is what the caller should display — a
// control that silently misses its setting is worse than one that shows the miss.
export function solveSeaLevelOffset(
  rafts: Raft[],
  oceanAge: Float32Array,
  warpSeed: number,
  targetLandFraction: number,
  worldWidth: number,
  worldHeight: number,
): LandTargetSolution {
  const measure = (offset: number): number => landFractionAt(rafts, oceanAge, warpSeed, offset, worldWidth, worldHeight)
  let lo = metersToElevation(OFFSET_SEARCH_MIN_M) // least water → most land
  let hi = metersToElevation(OFFSET_SEARCH_MAX_M) // most water → least land
  const most = measure(lo)
  if (most <= targetLandFraction) return { offset: lo, achieved: most }
  const least = measure(hi)
  if (least >= targetLandFraction) return { offset: hi, achieved: least }

  let achieved = most
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2
    achieved = measure(mid)
    if (achieved > targetLandFraction) lo = mid
    else hi = mid
  }
  const offset = (lo + hi) / 2
  return { offset, achieved }
}
