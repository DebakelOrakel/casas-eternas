import { smoothstep } from '../core/interpolation'
import { wrapValue } from '../core/field'
import { ELEVATION_TUNING } from './elevationTuneParams'
import { metersToElevation } from './elevationScale'

// Relief across the continental interior — the thing the margin profile does not have.
//
// marginProfile returns a flat LAND_BASE (360 m) for every point with t >= 1, so the
// inside of a continent was a plateau at one single height. Two visible problems came
// out of that, and they turned out to be the same problem:
//
//   - The water control had no usable range. Land fraction fell gently to +200 m of
//     extra water (8.4%) and then hit ZERO by +360 m, because at that point the whole
//     interior crosses sea level at once. Not a slider, a switch.
//   - "More lowland" produced a plateau with erosion grooves cut into it rather than a
//     plain with gentle variation, and a flat interior has no basins, so no lakes
//     inland either.
//
// Real continents have hypsometry: a distribution of heights, most of it low with a
// long tail upward. With one, a rising sea drowns the lowest ground first and the
// coastline moves gradually, which is what makes the control continuous.
//
// This is layered UNDER the tectonic features, not instead of them: mountains are
// still raised by orogeny. This is the ground they stand on.

function hashLatticePoint(ix: number, iy: number, seed: number): number {
  let h = (ix * 2654435761 + iy * 40503 + seed * 1013904223) >>> 0
  h = Math.imul(h ^ (h >>> 15), 2246822519)
  h = (h ^ (h >>> 13)) >>> 0
  return h / 4294967296
}

// Periodic so the field tiles at the map's wrap period — same requirement, and the
// same construction, as ridgedNoise and domainWarp. Kept as its own small copy for
// the reason ridgedNoise.ts already records: these three shape different things at
// different scales, and one parameterised helper would read worse than three short ones.
function periodicValueNoise(x: number, y: number, cellsX: number, cellsY: number, seed: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = smoothstep(x - x0)
  const fy = smoothstep(y - y0)
  const x0w = wrapValue(x0, cellsX), x1w = wrapValue(x0 + 1, cellsX)
  const y0w = wrapValue(y0, cellsY), y1w = wrapValue(y0 + 1, cellsY)
  const n00 = hashLatticePoint(x0w, y0w, seed)
  const n10 = hashLatticePoint(x1w, y0w, seed)
  const n01 = hashLatticePoint(x0w, y1w, seed)
  const n11 = hashLatticePoint(x1w, y1w, seed)
  const top = n00 + (n10 - n00) * fx
  const bottom = n01 + (n11 - n01) * fx
  return top + (bottom - top) * fy
}

// Continental scale, deliberately coarse: this is the shape of a landmass's interior,
// not its texture. Ridged noise already supplies the fine structure, and putting
// small-scale variation here would just fight the erosion pass for the same ground.
const HYPSOMETRY_OCTAVES: readonly (readonly [cellsX: number, cellsY: number, amplitude: number])[] = [
  [5, 3, 1],
  [11, 6, 0.45],
  [23, 12, 0.2],
]

// Signed elevation offset to add to the margin profile at a warped world point.
// `t` is marginParameter's output: 0 = open ocean, 1 = continental interior.
export function continentalHypsometry(wx: number, wy: number, t: number, worldWidth: number, worldHeight: number, seed: number): number {
  if (t <= ELEVATION_TUNING.hypsometryTIn) return 0
  const weight = smoothstep(Math.min(1, (t - ELEVATION_TUNING.hypsometryTIn) / (ELEVATION_TUNING.hypsometryTFull - ELEVATION_TUNING.hypsometryTIn)))
  let sum = 0
  let amplitudeSum = 0
  let octaveSeed = seed ^ 0x5f3759df // salted off warpSeed so it does not echo the warp
  for (const [cellsX, cellsY, amplitude] of HYPSOMETRY_OCTAVES) {
    const n = periodicValueNoise((wx / worldWidth) * cellsX, (wy / worldHeight) * cellsY, cellsX, cellsY, octaveSeed)
    sum += (n - 0.5) * 2 * amplitude
    amplitudeSum += amplitude
    octaveSeed = (octaveSeed * 1664525 + 1013904223) >>> 0
  }
  return metersToElevation((sum / amplitudeSum) * (ELEVATION_TUNING.hypsometryRangeM / 2)) * weight
}
