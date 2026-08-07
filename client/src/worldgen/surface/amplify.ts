import { upscaleBilinearToroidal } from '../core/field'
import { SEA_LEVEL, metersToElevation } from '../elevation/elevationScale'
import { fineDetailNoise } from '../elevation/ridgedNoise'
import type { ErosionPassParams } from './erosion'

// Terrain AMPLIFICATION — the derived fine tier of
// docs/decisions/worldmap-amplification.md. Takes the authoritative macro
// elevation raster (2048x1024, the only thing a save carries) and produces a
// finer raster for the worldmap to present: upsample, then inject seed
// roughness. Erosion (phase 2) then runs on that result; this module is
// deliberately only the PREPARATION, because the two halves fail differently
// and are worth verifying apart.
//
// Why seed roughness at all: bilinear upsampling adds no information, so an
// upscaled raster is glass below the macro cell — and erosion on glass does
// nothing interesting, because the priority flood has no texture to pick a
// drainage side with and every micro-catchment is a tie. The micro-tile
// prototype learned this first (tileErosion.ts's TILE_SEED_ROUGHNESS): fine
// erosion needs something to bite into. This is the same idea at global
// scale.
//
// Everything here is deterministic in (macro raster, factor, seed): the same
// world always amplifies to the identical field, which is what lets the bake
// be a per-load recomputation rather than something the save must carry.

// Peak seed amplitude, in metres. The micro tile's 30 m was the starting
// point, but measurement (2026-08-07, esbuild transect over a synthetic
// world) showed why this case needs more: the noise rarely reaches its
// nominal peak, so 30 m produced only ~5 m RMS and ~2 m between neighbouring
// cells — far below the tens of metres a stream-power pass carves, i.e. no
// tiebreaker at all. The micro tile could afford that because it ALSO
// resamples the analytic tectonic field at sub-cell spacing; a save carries
// no rafts or features, so here this layer is the only sub-macro-cell
// content that exists. 60 m peak lands near ~10 m RMS while the height fade
// below still protects the coasts.
const SEED_ROUGHNESS_M = 60

// Height-scaled fade toward sea level, straight from the micro tile's
// lesson: on a low coastal plain, the macro valley that should steer the
// trunk river is only metres deep (plain incision is damped on purpose), so
// full-amplitude noise would out-shout it and the river would wander off its
// inherited course. Full roughness stays in the highlands, where competing
// micro-valleys are exactly what we want. Ocean cells get none — nothing
// routes on the seabed.
export function seedRoughnessAmplitude(elevation: number): number {
  if (elevation <= SEA_LEVEL) return 0
  return Math.min(metersToElevation(SEED_ROUGHNESS_M), elevation * 0.5)
}

// The noise cascade for the seed layer. fineDetailNoise's own octave table
// bottoms out at width/1024 — i.e. ~8 macro px, ~16 fine px at factor 2 —
// which is far too coarse to seed fine drainage, so the field is summed over
// several DOMAIN DIVISORS: passing width/s makes every octave s times finer
// while staying torus-periodic (the world period must stay an integer
// multiple of the noise period, which it does for integer s that divide the
// resolution). The cascade is cut off where the finest octave would approach
// the fine grid's own Nyquist limit — noise below ~3 px is aliasing, not
// detail, and erosion cannot act on it either.
const MIN_OCTAVE_PIXELS = 3
const CASCADE_FALLOFF = 0.55

export function seedCascadeScales(resX: number): number[] {
  const scales: number[] = []
  // Doubling (not quadrupling) so the spectrum keeps filling in as the
  // resolution rises: at 4096 this yields [1] (one call = 8 px and 4 px
  // octaves = 8 and 4 cells, exactly the band erosion needs), at the decided
  // 8192 target [1, 2] — the second call restoring that same few-cells band
  // at the finer spacing rather than leaving it at 16/8 cells.
  for (let s = 1; s <= 64; s *= 2) {
    // fineDetailNoise's finest octave is 1024 cells across the domain it is
    // given (resX / s), so its wavelength in fine pixels is resX / (s * 1024).
    // Below ~3 px there is nothing left to resolve and erosion cannot act on
    // it either — that is the cutoff, not an aesthetic choice.
    if (resX / (s * 1024) < MIN_OCTAVE_PIXELS) break
    scales.push(s)
  }
  return scales.length > 0 ? scales : [1]
}

// Erosion constants are argued per 7.8 km cell (see erosion.ts) and several
// of them are expressed in units that hide a cell size, so running the same
// params on a finer grid would quietly change the physics. This is the
// rescaling, derived rather than guessed — `cellSizeRatio` is
// fineCellMetres / macroCellMetres (1/2 at factor 2, 1/4 at factor 4).
//
// Under refinement by 1/r, for the SAME physical terrain:
//   • a slope between neighbours (elevation units per cell) scales by r —
//     the same gradient over a shorter run is a smaller rise;
//   • a drainage area counted in CELLS scales by 1/r².
//
// Term by term:
//
//   • talusSlope — a real ANGLE converted through the cell size
//     (slopeFromAngle multiplies by METERS_PER_CELL). Multiplying by r
//     re-converts the same physical angle for the finer cell, so the step
//     keeps targeting the same real-world steepness. Worth stating because
//     it is NOT a free choice: leaving it alone would declare everything
//     above a quarter of the old angle unstable and plane the mountains
//     flat — the exact failure erosion.ts's own talus comment documents.
//
//   • stream power dh = K·Aᵐ·Sⁿ with m = 0.5, n = 1 is SCALE-INVARIANT here:
//     Aᵐ scales by (1/r²)^0.5 = 1/r and Sⁿ by r, so the product is
//     unchanged. Nothing to do — but only because of those exponents; if
//     m or n is ever retuned this stops holding.
//
//   • transportCapacityKt — capacity Kt·A·S scales by (1/r²)·r = 1/r, so
//     deposition would grow as the grid refines (deltas swallowing coasts).
//     Multiplying Kt by r cancels it.
//
//   • iterations / rounds / upliftRate / plainFactor and the metre-denominated
//     thresholds are counts or physical heights — scale-free by construction.
export function erosionParamsForCellSize(base: ErosionPassParams, cellSizeRatio: number): ErosionPassParams {
  return {
    ...base,
    thermal: { ...base.thermal, talusSlope: base.thermal.talusSlope * cellSizeRatio },
    streamPower: { ...base.streamPower, transportCapacityKt: base.streamPower.transportCapacityKt * cellSizeRatio },
  }
}

// The river threshold's counterpart to erosionParamsForCellSize. The channel
// criterion is a critical drainage area counted in CELLS (see
// hydrology.densityToCriticalArea), so on a grid refined by 1/r the same
// PHYSICAL catchment covers 1/r² times as many cells — leave the number
// alone and every minor gully clears the bar, turning the map into a mesh of
// parallel lines. Multiplying by 1/r² keeps "a river is a river" meaning the
// same real thing at any resolution.
//
// The same conclusion arrives from the discharge side: accumulateDischarge
// sums a per-cell runoff over upstream cells, so discharge for a fixed
// physical catchment also grows by 1/r² — threshold and signal scale
// together, as they must.
export function criticalAreaForCellSize(criticalAreaCells: number, cellSizeRatio: number): number {
  return criticalAreaCells / (cellSizeRatio * cellSizeRatio)
}

export interface AmplifiedField {
  data: Float32Array
  width: number
  height: number
}

// Upsample + seed roughness. `factor` is the linear refinement (2 → 4096x2048,
// 4 → 8192x4096); `seed` should derive from the world so a given world always
// amplifies identically. `onProgress` reports 0..1 over the roughness pass,
// which is the part long enough to be worth reporting.
export function amplifyElevation(
  macro: Float32Array,
  macroWidth: number,
  macroHeight: number,
  factor: number,
  seed: number,
  onProgress?: (fraction: number) => void,
): AmplifiedField {
  const width = macroWidth * factor
  const height = macroHeight * factor
  const data = upscaleBilinearToroidal(macro, macroWidth, macroHeight, width, height)
  if (factor <= 1) return { data, width, height }

  const scales = seedCascadeScales(width)
  const amplitudes = scales.map((_, i) => Math.pow(CASCADE_FALLOFF, i))
  const norm = amplitudes.reduce((a, b) => a + b, 0)
  const reportEvery = Math.max(1, Math.floor(height / 50))
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      const base = data[row + x]
      const amplitude = seedRoughnessAmplitude(base)
      if (amplitude === 0) continue
      let noise = 0
      for (let i = 0; i < scales.length; i++) {
        const s = scales[i]
        noise += fineDetailNoise(x, y, width / s, height / s, (seed + i * 0x9e3779b9) >>> 0) * amplitudes[i]
      }
      data[row + x] = base + (noise / norm) * amplitude
    }
    if (onProgress && y % reportEvery === 0) onProgress(y / height)
  }
  onProgress?.(1)
  return { data, width, height }
}
