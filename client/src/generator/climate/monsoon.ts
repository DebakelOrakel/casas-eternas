import { wrapIndex2 } from '../core/field'
import { OCEAN_AMPLITUDE } from './seasonality'
import { CLIMATE_TUNING } from './climateTuneParams'
import { CLIMATE_RES_X, CLIMATE_RES_Y, shiftedYNorm } from './climateField'
import { computePrecipitation, OCEAN_PRECIP } from './precipitation'

// Seasonal precipitation + monsoons (see docs/decisions/climate-biomes.md). The base
// precipitation model is an annual mean; here we run it for two opposite seasons and
// derive a SIGNED monsoon (precipitation-seasonality) index from the difference — how
// uneven the year is, and which half of it is the wet one. Two
// physical drivers make a season differ from the annual mean:
//   1. The ITCZ rain belt migrates toward the summer hemisphere (a seasonal shift of
//      the same latitude band the annual model already uses).
//   2. Land heats/cools far more than ocean each season (continentality → a big
//      seasonal-temperature amplitude over interiors, small over sea). That land-sea
//      thermal contrast drives a monsoon surface wind: onshore over hot summer land
//      (wet), offshore in winter (dry).
// We model season "N" = northern (top) hemisphere in summer, and "S" = its opposite.

const RX = CLIMATE_RES_X
const RY = CLIMATE_RES_Y

// Seasonal air temperature = annual mean ± half the seasonal amplitude, signed so the
// summer hemisphere warms and the winter one cools. Amplitude is large over continental
// interiors and small over ocean (computeSeasonalAmplitude), so this automatically
// carries the land-sea thermal contrast that powers monsoons. `warmNorth` picks the
// season where the top hemisphere is in summer.
function seasonalTemperature(annual: Float32Array, amplitude: Float32Array, equatorOffset: number, warmNorth: boolean): Float32Array {
  const out = new Float32Array(annual.length)
  for (let gy = 0; gy < RY; gy++) {
    const north = shiftedYNorm(gy, RY, equatorOffset) < 0.5
    const sign = north === warmNorth ? 0.5 : -0.5 // this hemisphere in summer → warmer
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      // The ocean carries the OCEAN_AMPLITUDE sentinel, not a swing: read it
      // as the near-nil swing it stands for (BUG_BOUNTY 2 — it used to enter
      // as −1 and put a wrong-sign half-degree on every sea cell, which
      // bent the monsoon's ∇T on every coast).
      const swing = amplitude[i] === OCEAN_AMPLITUDE ? 0 : amplitude[i]
      out[i] = annual[i] + sign * swing
    }
  }
  return out
}

// Monsoon surface wind = base zonal wind + k·∇T(seasonal). ∇T points toward the warm
// anomaly, so near a coast it points from cool ocean to hot summer land (onshore, wet)
// and reverses in winter (offshore, dry). Interleaved [u, v] like computeWind.
function computeMonsoonWind(base: Float32Array, seasonalTemp: Float32Array): Float32Array {
  const out = new Float32Array(base.length)
  const wrap = (x: number, y: number): number => wrapIndex2(x, y, RX, RY)
  for (let gy = 0; gy < RY; gy++) {
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      const dTdx = (seasonalTemp[wrap(gx + 1, gy)] - seasonalTemp[wrap(gx - 1, gy)]) / 2
      const dTdy = (seasonalTemp[wrap(gx, gy + 1)] - seasonalTemp[wrap(gx, gy - 1)]) / 2
      out[i * 2] = base[i * 2] + CLIMATE_TUNING.monsoonWindStrength * dTdx
      out[i * 2 + 1] = base[i * 2 + 1] + CLIMATE_TUNING.monsoonWindStrength * dTdy
    }
  }
  return out
}

export interface SeasonalPrecipitation {
  // Annual mean precip (mm/yr on land, OCEAN_PRECIP on ocean) — the mean of the two
  // seasons, so it stays comparable to the old single-field precipitation.
  annual: Float32Array
  // Monsoon / precipitation-seasonality index, SIGNED:
  //   (precipN − precipS) / (precipN + precipS + monsoonSeasonalityFloor).
  // Its MAGNITUDE is the seasonality — 0 = even year-round, →1 = strongly wet-dry
  // (monsoonal) — and that is all a consumer asking "how seasonal is this place"
  // wants; classify() in biomes.ts takes the absolute value once, for all of them.
  // Its SIGN is the PHASE: + = the wet season falls while the TOP hemisphere is in
  // summer, − = while the bottom one is. This field used to sort the two seasons
  // into wet = max / dry = min, which kept the amplitude and threw the phase away,
  // so a Mediterranean winter-rain climate was indistinguishable from a monsoon.
  // The floor in the denominator keeps |index| < 1 STRICTLY, which is what leaves
  // the OCEAN_PRECIP (−1) sentinel unreachable by a real value. OCEAN_PRECIP on ocean.
  index: Float32Array
}

// The seasonality field's MAGNITUDE — how uneven the year is, with the ocean
// sentinel passed through. `index` is signed because the sign is the phase, and
// everything that classifies vegetation asks only about the unevenness.
//
// This converts the WHOLE FIELD rather than each value where it is read, and that
// is not a convenience: the consumers INTERPOLATE it. Two neighbouring cells on
// opposite sides of the ITCZ carry opposite signs, so blending them first would
// report an even year exactly in the belt where the wet-dry savanna lives. It also
// keeps the `v >= 0` land test in biomes.ts's sampleLandBilinear able to tell a
// dry-summer land cell from ocean.
export function seasonalityMagnitude(index: Float32Array): Float32Array {
  const out = new Float32Array(index.length)
  for (let i = 0; i < index.length; i++) out[i] = index[i] === OCEAN_PRECIP ? OCEAN_PRECIP : Math.abs(index[i])
  return out
}

// Runs the base precipitation model for the two opposite seasons (each with its shifted
// ITCZ + monsoon-modulated wind) and combines them. Roughly doubles the (heavy)
// precipitation cost — acceptable for the on-demand climate compute.
export function computeSeasonalPrecipitation(
  elevation: Float32Array,
  annualTemp: Float32Array,
  amplitude: Float32Array,
  baseWind: Float32Array,
  worldW: number,
  worldH: number,
  humidity: number,
  equatorOffset: number,
  dryLand?: Uint8Array,
): SeasonalPrecipitation {
  const tempN = seasonalTemperature(annualTemp, amplitude, equatorOffset, true) // top hemisphere summer
  const tempS = seasonalTemperature(annualTemp, amplitude, equatorOffset, false)
  const windN = computeMonsoonWind(baseWind, tempN)
  const windS = computeMonsoonWind(baseWind, tempS)
  // ITCZ migrates toward the summer hemisphere. +equatorOffset moves the equator toward
  // the bottom, so a top-hemisphere summer (belt shifts up) uses a SMALLER offset.
  const precipN = computePrecipitation(elevation, tempN, windN, worldW, worldH, humidity, equatorOffset, dryLand, CLIMATE_TUNING.monsoonItczSeasonalShift)
  const precipS = computePrecipitation(elevation, tempS, windS, worldW, worldH, humidity, equatorOffset, dryLand, -CLIMATE_TUNING.monsoonItczSeasonalShift)

  const n = precipN.length
  const annual = new Float32Array(n)
  const index = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    if (precipN[i] === OCEAN_PRECIP || precipS[i] === OCEAN_PRECIP) {
      annual[i] = OCEAN_PRECIP
      index[i] = OCEAN_PRECIP
      continue
    }
    const a = precipN[i]
    const b = precipS[i]
    annual[i] = (a + b) / 2
    index[i] = (a - b) / (a + b + CLIMATE_TUNING.monsoonSeasonalityFloor)
  }
  return { annual, index }
}
