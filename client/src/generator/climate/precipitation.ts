import { CLIMATE_RES_X, CLIMATE_RES_Y, isLandAtCell, shiftedYNorm } from './climateField'
import { CLIMATE_TUNING } from './climateTuneParams'
import { SEA_LEVEL } from '../elevation/elevationScale'
import { sampleBilinearGrid } from '../core/field'
import { wrapValue } from '../core/field'

const RX = CLIMATE_RES_X
const RY = CLIMATE_RES_Y

// Ocean cells carry this sentinel instead of a precip value — the overlay and
// the (later) biome step treat precipitation as a land-only field.
export const OCEAN_PRECIP = -1

// Warmer air/ocean evaporates and holds more moisture (a Clausius-Clapeyron-ish
// increase) — this is what keeps the tropics humid and the cold poles dry, and
// couples precipitation to the temperature slider (a warmer world is wetter).
function evaporation(tempC: number): number {
  const e = (tempC - CLIMATE_TUNING.precipEvapZeroC) / CLIMATE_TUNING.precipEvapSpanC
  return e < CLIMATE_TUNING.precipEvapMin ? CLIMATE_TUNING.precipEvapMin : e > CLIMATE_TUNING.precipEvapMax ? CLIMATE_TUNING.precipEvapMax : e
}

function bandFactor(phi: number): number {
  const f = CLIMATE_TUNING.precipBandBase + CLIMATE_TUNING.precipBandSwing * Math.cos(3 * Math.PI * phi)
  return f < CLIMATE_TUNING.precipBandFloor ? CLIMATE_TUNING.precipBandFloor : f
}

// Nearest-texel read of the FULL-RES elevation raster at a world point. Kept
// local rather than folded into field.ts: that module samples coarse fields, and
// this is the opposite — the orographic term needs the fine gradient, which is
// the entire reason it reads full-res here instead of off the climate grid.
function elevationAtWorld(elevation: Float32Array, wx: number, wy: number, worldW: number, worldH: number): number {
  const x = Math.floor(wrapValue(wx, worldW))
  const y = Math.floor(wrapValue(wy, worldH))
  return elevation[y * worldW + x]
}

// Annual precipitation (mm/yr) on the climate grid, land only (ocean cells =
// OCEAN_PRECIP). Model: moisture evaporates over the ocean (∝ temperature),
// is advected downwind (the prevailing wind field), and rains out — a base
// fraction everywhere plus an orographic bonus on windward slopes, which also
// depletes it for the lee (rain shadow). A zonal band factor then imposes the
// wet-equator / dry-subtropics / wet-subpolar / dry-pole structure. See
// docs/decisions/climate-biomes.md. Elevation is the full-res post-erosion
// field; temperature/wind are the coarse climate grids.
// `humidity` is a global wetness multiplier on the final land precipitation (1 =
// default; <1 = a drier world with expanding deserts, >1 = a wetter, greener
// one — the user's humidity slider). It scales the mm/yr directly, sliding every
// cell along the Whittaker precipitation axis; ocean sentinels are untouched.
export function computePrecipitation(elevation: Float32Array, temperature: Float32Array, wind: Float32Array, worldW: number, worldH: number, humidity = 1, equatorOffset = 0, dryLand?: Uint8Array): Float32Array {
  const n = RX * RY
  const ocean = new Uint8Array(n)
  const evap = new Float32Array(n)
  const rainFrac = new Float32Array(n)
  for (let gy = 0; gy < RY; gy++) {
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      ocean[i] = isLandAtCell(elevation, dryLand, gx, gy, worldW, worldH) ? 0 : 1
      evap[i] = evaporation(temperature[i])
      if (ocean[i]) {
        rainFrac[i] = CLIMATE_TUNING.precipBaseRainout
        continue
      }
      // Orographic: land-elevation RISE along the wind (windward slope) → more
      // rain. Only counted between two LAND points — the ocean→coast step is a
      // huge elevation jump but not a mountain, and must not wring out the
      // incoming moisture right at the shoreline (that left interiors bone-dry).
      const u = wind[i * 2]
      const v = wind[i * 2 + 1]
      const wx = ((gx + 0.5) / RX) * worldW
      const wy = ((gy + 0.5) / RY) * worldH
      const eHere = elevationAtWorld(elevation, wx, wy, worldW, worldH)
      const eUp = elevationAtWorld(elevation, wx - u * CLIMATE_TUNING.precipOrogSamplePx, wy - v * CLIMATE_TUNING.precipOrogSamplePx, worldW, worldH)
      const upslope = eUp > SEA_LEVEL ? Math.max(0, eHere - eUp) : 0
      rainFrac[i] = Math.min(CLIMATE_TUNING.precipRainoutMax, CLIMATE_TUNING.precipBaseRainout + CLIMATE_TUNING.precipOrographicRate * upslope)
    }
  }

  let moisture = new Float32Array(n)
  for (let i = 0; i < n; i++) moisture[i] = ocean[i] ? evap[i] : 0
  const rainedOut = new Float32Array(n)
  for (let iter = 0; iter < CLIMATE_TUNING.precipIters; iter++) {
    const next = new Float32Array(n)
    for (let gy = 0; gy < RY; gy++) {
      for (let gx = 0; gx < RX; gx++) {
        const i = gy * RX + gx
        const u = wind[i * 2]
        const v = wind[i * 2 + 1]
        const advected = sampleBilinearGrid(moisture, RX, RY, gx - u * CLIMATE_TUNING.precipAdvectStep, gy - v * CLIMATE_TUNING.precipAdvectMeridionalScale * CLIMATE_TUNING.precipAdvectStep)
        if (ocean[i]) {
          next[i] = evap[i] // ocean is a fixed moisture source
          continue
        }
        const rain = advected * rainFrac[i]
        rainedOut[i] = rain // steady-state rainout — the last iteration wins
        // Depletes by the rain that stays on the ground; the recycled fraction re-enters
        // the pool so downwind interiors keep getting fed (see CLIMATE_TUNING.precipLandRecycleFrac).
        next[i] = advected - rain * (1 - CLIMATE_TUNING.precipLandRecycleFrac)
      }
    }
    moisture = next
  }

  const precip = new Float32Array(n)
  for (let gy = 0; gy < RY; gy++) {
    const yNorm = shiftedYNorm(gy, RY, equatorOffset)
    const band = bandFactor(Math.abs(yNorm - 0.5) * 2)
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      precip[i] = ocean[i] ? OCEAN_PRECIP : rainedOut[i] * band * CLIMATE_TUNING.precipScale * humidity
    }
  }
  return precip
}
