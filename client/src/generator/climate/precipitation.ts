import { CLIMATE_RES_X, CLIMATE_RES_Y, isLandAtCell, shiftedYNorm, beltYNorm } from './climateField'
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
// Exported for the sea's salt balance (salinity.ts), which needs the same
// evaporation the rain is made of.
export function evaporation(tempC: number): number {
  const e = (tempC - CLIMATE_TUNING.precipEvapZeroC) / CLIMATE_TUNING.precipEvapSpanC
  return e < CLIMATE_TUNING.precipEvapMin ? CLIMATE_TUNING.precipEvapMin : e > CLIMATE_TUNING.precipEvapMax ? CLIMATE_TUNING.precipEvapMax : e
}

// Exported for the sea's rain (salinity.ts): this model rains out over land
// only, and the sea's salt needs the zonal profile it rains by.
export function bandFactor(phi: number): number {
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
// `beltShift` moves the zonal rain bands with the season, as a fraction of
// the map's height (+ toward the top): in full at the equator, where the rain
// belt follows the sun far, down to `precipBeltShiftFloor` of it from
// `precipBeltTaperDeg` poleward, where the subtropical highs move only a few
// degrees (2026-09-28). One shift for all latitudes moved the dry belt over
// every mid-latitude coast in summer: Astrakan came out 15–17 % Mediterranean
// (Köppen Cs), Earth is about 2 %.
//
// `refined` is the climate step's refinement (refinement.ts): the sea
// evaporates at `seaTemperature` (the sea surface with its currents and
// upwelling) instead of at the air of `temperature`, and the air carries the
// anomaly of the sea it rose from (`seaAnomaly`, °C, the sea surface against
// its latitude): air off a warm current is unstable and rains readily, air
// off a cold current or an upwelling is stable under the warmer air above it
// and hardly rains — the dry west coasts of the subtropics. `highHpa` is the
// refinement's ocean highs (refinement.ts): under the western flank of a
// high (below 0 hPa) the air does not sink, and the band's dryness gives way
// toward `rainFlankFactor`, in full at −`rainFlankFullHpa`.
export interface RefinedRain {
  seaTemperature: Float32Array
  seaAnomaly: Float32Array
  highHpa: Float32Array
}

export function computePrecipitation(elevation: Float32Array, temperature: Float32Array, wind: Float32Array, worldW: number, worldH: number, humidity = 1, equatorOffset = 0, dryLand?: Uint8Array, beltShift = 0, refined?: RefinedRain): Float32Array {
  const n = RX * RY
  const ocean = new Uint8Array(n)
  const evap = new Float32Array(n)
  const rainFrac = new Float32Array(n)
  for (let gy = 0; gy < RY; gy++) {
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      ocean[i] = isLandAtCell(elevation, dryLand, gx, gy, worldW, worldH) ? 0 : 1
      evap[i] = evaporation(ocean[i] && refined ? refined.seaTemperature[i] : temperature[i])
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
  // The refinement's sinking air, 0..1 per cell (subsidence), and the share
  // of the moisture it mixes away per iteration over land.
  const sinking = refined ? subsidence(refined.highHpa, equatorOffset, beltShift) : null
  // The refinement's second tracer: moisture × its source's sea anomaly,
  // carried and depleted with the moisture, so carried / moisture is the
  // anomaly of the sea the air came from.
  let carried = new Float32Array(n)
  const sourceAnomaly = new Float32Array(n)
  if (refined) for (let i = 0; i < n; i++) carried[i] = ocean[i] ? evap[i] * refined.seaAnomaly[i] : 0
  for (let iter = 0; iter < CLIMATE_TUNING.precipIters; iter++) {
    const next = new Float32Array(n)
    const nextCarried = refined ? new Float32Array(n) : carried
    for (let gy = 0; gy < RY; gy++) {
      for (let gx = 0; gx < RX; gx++) {
        const i = gy * RX + gx
        const u = wind[i * 2]
        const v = wind[i * 2 + 1]
        const fx = gx - u * CLIMATE_TUNING.precipAdvectStep
        const fy = gy - v * CLIMATE_TUNING.precipAdvectMeridionalScale * CLIMATE_TUNING.precipAdvectStep
        const advected = sampleBilinearGrid(moisture, RX, RY, fx, fy)
        if (ocean[i]) {
          next[i] = evap[i] // ocean is a fixed moisture source
          if (refined) nextCarried[i] = carried[i]
          continue
        }
        const rain = advected * rainFrac[i]
        rainedOut[i] = rain // steady-state rainout — the last iteration wins
        // Depletes by the rain that stays on the ground; the recycled fraction re-enters
        // the pool so downwind interiors keep getting fed (see CLIMATE_TUNING.precipLandRecycleFrac).
        next[i] = advected - rain * (1 - CLIMATE_TUNING.precipLandRecycleFrac)
        if (sinking) next[i] *= 1 - CLIMATE_TUNING.rainSubsidenceMix * sinking[i]
        if (refined && advected > 0) {
          const anomaly = sampleBilinearGrid(carried, RX, RY, fx, fy) / advected
          sourceAnomaly[i] = anomaly
          nextCarried[i] = next[i] * anomaly
        }
      }
    }
    moisture = next
    carried = nextCarried
  }

  const precip = new Float32Array(n)
  for (let gy = 0; gy < RY; gy++) {
    const yNorm = beltYNorm(shiftedYNorm(gy, RY, equatorOffset), beltShift)
    const band = bandFactor(Math.abs(yNorm - 0.5) * 2)
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      const factor = refined ? flankRelief(band, refined.highHpa[i]) * sourceStability(sourceAnomaly[i]) : band
      precip[i] = ocean[i] ? OCEAN_PRECIP : rainedOut[i] * factor * CLIMATE_TUNING.precipScale * humidity
    }
  }
  return precip
}

// How strongly the air sinks, 0..1 per cell: the band's dry core (0 where
// the band factor is `rainSubsidenceBand` or more, 1 at its floor — the
// subtropical highs and the poles; the band's slopes toward the storm
// tracks are not sinking air), taken away under a high's western flank as flankRelief takes
// the dryness away, and at least the high's own share of its full strength
// (`oceanHighFlankHpa`) in its east. Where the air sinks, dry air from
// above mixes into the moist air below: Arabia and Australia stay dry
// beside a warm sea.
function subsidence(highHpa: Float32Array, equatorOffset: number, beltShift: number): Float32Array {
  const T = CLIMATE_TUNING
  const out = new Float32Array(RX * RY)
  for (let gy = 0; gy < RY; gy++) {
    const band = bandFactor(Math.abs(beltYNorm(shiftedYNorm(gy, RY, equatorOffset), beltShift) - 0.5) * 2)
    const fromBand = Math.min(1, Math.max(0, (T.rainSubsidenceBand - band) / (T.rainSubsidenceBand - T.precipBandFloor)))
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      const h = highHpa[i]
      const s = h < 0 ? fromBand * (1 - Math.min(1, -h / T.rainFlankFullHpa)) : Math.max(fromBand, Math.min(1, h / T.oceanHighFlankHpa))
      out[i] = s
    }
  }
  return out
}

// The band factor under a high's western flank: raised toward
// `rainFlankFactor` as the pressure there falls below 0 (never lowered).
function flankRelief(band: number, highHpa: number): number {
  if (highHpa >= 0 || band >= CLIMATE_TUNING.rainFlankFactor) return band
  const t = Math.min(1, -highHpa / CLIMATE_TUNING.rainFlankFullHpa)
  return band + (CLIMATE_TUNING.rainFlankFactor - band) * t
}

// The rain's multiplier from the anomaly of the sea the air rose from, °C:
// e^(k·anomaly), clamped.
function sourceStability(anomaly: number): number {
  const f = Math.exp(CLIMATE_TUNING.rainSourcePerC * anomaly)
  return f < CLIMATE_TUNING.rainSourceMin ? CLIMATE_TUNING.rainSourceMin : f > CLIMATE_TUNING.rainSourceMax ? CLIMATE_TUNING.rainSourceMax : f
}
