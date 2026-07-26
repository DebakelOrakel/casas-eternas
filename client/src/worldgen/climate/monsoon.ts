import { CLIMATE_RES_X, CLIMATE_RES_Y, shiftedYNorm } from './climateField'
import { computePrecipitation, OCEAN_PRECIP } from './precipitation'

// Seasonal precipitation + monsoons (see docs/decisions/climate-biomes.md). The base
// precipitation model is an annual mean; here we run it for two opposite seasons and
// derive the wet-/dry-season split + a monsoon (precipitation-seasonality) index. Two
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

// How far (fraction of map height) the ITCZ belt migrates toward the summer hemisphere.
// Real seasonal swing is ~10-15° of latitude (bigger over monsoon land); 0.12 of the
// map's pole-to-pole span is in that range on this 2:1 torus.
const ITCZ_SEASONAL_SHIFT = 0.07
// Strength of the monsoon surface wind — a component up the seasonal-temperature
// gradient (∇T points from cool sea toward hot summer land), added to the prescribed
// zonal wind. Tuned so it reshapes moisture advection near coasts without swamping the
// base three-cell circulation (base zonal strength ~1). See computeMonsoonWind.
const MONSOON_WIND_STRENGTH = 0.05
// Wetness floor (mm/yr) added to the monsoon-index denominator so ARID cells don't read
// as monsoonal: a desert with 50 mm wet / 5 mm dry is dry, not seasonal, yet a raw
// (wet−dry)/(wet+dry) would call it 0.82. The floor damps the index where absolute
// precipitation is small, so a high index means genuinely wet-in-one-season-dry-in-the-
// other (a real monsoon), not just marginal noise. ~ a semi-arid annual total.
const SEASONALITY_FLOOR = 500

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
      out[i] = annual[i] + sign * amplitude[i]
    }
  }
  return out
}

// Monsoon surface wind = base zonal wind + k·∇T(seasonal). ∇T points toward the warm
// anomaly, so near a coast it points from cool ocean to hot summer land (onshore, wet)
// and reverses in winter (offshore, dry). Interleaved [u, v] like computeWind.
function computeMonsoonWind(base: Float32Array, seasonalTemp: Float32Array): Float32Array {
  const out = new Float32Array(base.length)
  const wrap = (x: number, y: number): number => (((y % RY) + RY) % RY) * RX + (((x % RX) + RX) % RX)
  for (let gy = 0; gy < RY; gy++) {
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      const dTdx = (seasonalTemp[wrap(gx + 1, gy)] - seasonalTemp[wrap(gx - 1, gy)]) / 2
      const dTdy = (seasonalTemp[wrap(gx, gy + 1)] - seasonalTemp[wrap(gx, gy - 1)]) / 2
      out[i * 2] = base[i * 2] + MONSOON_WIND_STRENGTH * dTdx
      out[i * 2 + 1] = base[i * 2 + 1] + MONSOON_WIND_STRENGTH * dTdy
    }
  }
  return out
}

export interface SeasonalPrecipitation {
  // Annual mean precip (mm/yr on land, OCEAN_PRECIP on ocean) — the mean of the two
  // seasons, so it stays comparable to the old single-field precipitation.
  annual: Float32Array
  wet: Float32Array // wetter season's precip (land; OCEAN_PRECIP on ocean)
  dry: Float32Array // drier season's precip
  // Monsoon / precipitation-seasonality index: (wet − dry) / (wet + dry). 0 = even
  // year-round, →1 = strongly seasonal (monsoonal). OCEAN_PRECIP on ocean.
  index: Float32Array
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
): SeasonalPrecipitation {
  const tempN = seasonalTemperature(annualTemp, amplitude, equatorOffset, true) // top hemisphere summer
  const tempS = seasonalTemperature(annualTemp, amplitude, equatorOffset, false)
  const windN = computeMonsoonWind(baseWind, tempN)
  const windS = computeMonsoonWind(baseWind, tempS)
  // ITCZ migrates toward the summer hemisphere. +equatorOffset moves the equator toward
  // the bottom, so a top-hemisphere summer (belt shifts up) uses a SMALLER offset.
  const precipN = computePrecipitation(elevation, tempN, windN, worldW, worldH, humidity, equatorOffset - ITCZ_SEASONAL_SHIFT)
  const precipS = computePrecipitation(elevation, tempS, windS, worldW, worldH, humidity, equatorOffset + ITCZ_SEASONAL_SHIFT)

  const n = precipN.length
  const annual = new Float32Array(n)
  const wet = new Float32Array(n)
  const dry = new Float32Array(n)
  const index = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    if (precipN[i] === OCEAN_PRECIP || precipS[i] === OCEAN_PRECIP) {
      annual[i] = OCEAN_PRECIP
      wet[i] = OCEAN_PRECIP
      dry[i] = OCEAN_PRECIP
      index[i] = OCEAN_PRECIP
      continue
    }
    const a = precipN[i]
    const b = precipS[i]
    annual[i] = (a + b) / 2
    wet[i] = Math.max(a, b)
    dry[i] = Math.min(a, b)
    index[i] = (wet[i] - dry[i]) / (wet[i] + dry[i] + SEASONALITY_FLOOR)
  }
  return { annual, wet, dry, index }
}
