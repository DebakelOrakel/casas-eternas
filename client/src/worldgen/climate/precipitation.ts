import { CLIMATE_RES_X, CLIMATE_RES_Y, sampleElevationAtCell } from './climateField'
import { SEA_LEVEL } from '../erosion'

const RX = CLIMATE_RES_X
const RY = CLIMATE_RES_Y

// Iterations of moisture transport, and how far (in grid cells, per unit wind)
// moisture advects each one. Needs enough to reach a steady state deep inland
// — the flow is diagonal (zonal + meridional), so the path in is longer than
// the straight-line distance; too few left continental interiors stuck at
// their transient (empty) starting value.
const ITERS = 120
const ADVECT_STEP = 2
// Moisture is advected mostly ZONALLY (it penetrates inland from the nearest
// east/west coast). The meridional wind is damped for transport, because at
// full strength a backward streamline from a deep mid-latitude interior curves
// down into the neighbouring cell where the zonal wind REVERSES (Hadley vs
// Ferrel) — it then never traces back to an ocean, starving that cell to a
// hard zero. A gentle meridional tilt keeps streamlines within their own band.
const ADVECT_MERIDIONAL_SCALE = 0.3
// Fraction of airborne moisture that rains out per iteration on flat land, and
// the extra fraction per unit of upslope elevation along the wind (orographic
// lift). The orographic term also creates rain shadows: moisture rains out
// climbing the windward slope, so little is left for the lee side downwind.
const BASE_RAINOUT = 0.03
const OROGRAPHIC_RATE = 0.9
// World px upwind to sample for the along-wind slope (needs the fine elevation,
// not the coarse climate grid — the point of sampling full-res here).
const OROG_SAMPLE_PX = 40
// Raw rainout → mm/yr. Tunes overall wetness; a wet windward mountain lands
// around a few thousand mm, deserts/rain-shadow near zero.
const PRECIP_SCALE = 42000
// Ocean cells carry this sentinel instead of a precip value — the overlay and
// the (later) biome step treat precipitation as a land-only field.
export const OCEAN_PRECIP = -1

// Warmer air/ocean evaporates and holds more moisture (a Clausius-Clapeyron-ish
// increase) — this is what keeps the tropics humid and the cold poles dry, and
// couples precipitation to the temperature slider (a warmer world is wetter).
function evaporation(tempC: number): number {
  const e = (tempC + 10) / 40
  return e < 0.05 ? 0.05 : e > 1.2 ? 1.2 : e
}

// Zonal wet/dry from the general circulation: rising (wet) air at the equator
// ITCZ (φ=0) and the subpolar front (φ≈2/3), sinking (dry) air at the
// subtropical highs (φ≈1/3 — the great deserts) and the poles (φ=1).
function bandFactor(phi: number): number {
  const f = 0.8 + 0.7 * Math.cos(3 * Math.PI * phi)
  return f < 0.1 ? 0.1 : f
}

function sampleGridWrapped(field: Float32Array, fx: number, fy: number): number {
  const x = ((fx % RX) + RX) % RX
  const y = ((fy % RY) + RY) % RY
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = (x0 + 1) % RX
  const y1 = (y0 + 1) % RY
  const tx = x - x0
  const ty = y - y0
  const top = field[y0 * RX + x0] * (1 - tx) + field[y0 * RX + x1] * tx
  const bottom = field[y1 * RX + x0] * (1 - tx) + field[y1 * RX + x1] * tx
  return top * (1 - ty) + bottom * ty
}

function elevationAtWorld(elevation: Float32Array, wx: number, wy: number, worldW: number, worldH: number): number {
  const x = Math.floor(((wx % worldW) + worldW) % worldW)
  const y = Math.floor(((wy % worldH) + worldH) % worldH)
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
export function computePrecipitation(elevation: Float32Array, temperature: Float32Array, wind: Float32Array, worldW: number, worldH: number, humidity = 1): Float32Array {
  const n = RX * RY
  const ocean = new Uint8Array(n)
  const evap = new Float32Array(n)
  const rainFrac = new Float32Array(n)
  for (let gy = 0; gy < RY; gy++) {
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      const e = sampleElevationAtCell(elevation, gx, gy, worldW, worldH)
      ocean[i] = e <= SEA_LEVEL ? 1 : 0
      evap[i] = evaporation(temperature[i])
      if (ocean[i]) {
        rainFrac[i] = BASE_RAINOUT
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
      const eUp = elevationAtWorld(elevation, wx - u * OROG_SAMPLE_PX, wy - v * OROG_SAMPLE_PX, worldW, worldH)
      const upslope = eUp > SEA_LEVEL ? Math.max(0, eHere - eUp) : 0
      rainFrac[i] = Math.min(0.85, BASE_RAINOUT + OROGRAPHIC_RATE * upslope)
    }
  }

  let moisture = new Float32Array(n)
  for (let i = 0; i < n; i++) moisture[i] = ocean[i] ? evap[i] : 0
  const rainedOut = new Float32Array(n)
  for (let iter = 0; iter < ITERS; iter++) {
    const next = new Float32Array(n)
    for (let gy = 0; gy < RY; gy++) {
      for (let gx = 0; gx < RX; gx++) {
        const i = gy * RX + gx
        const u = wind[i * 2]
        const v = wind[i * 2 + 1]
        const advected = sampleGridWrapped(moisture, gx - u * ADVECT_STEP, gy - v * ADVECT_MERIDIONAL_SCALE * ADVECT_STEP)
        if (ocean[i]) {
          next[i] = evap[i] // ocean is a fixed moisture source
          continue
        }
        const rain = advected * rainFrac[i]
        rainedOut[i] = rain // steady-state rainout — the last iteration wins
        next[i] = advected - rain
      }
    }
    moisture = next
  }

  const precip = new Float32Array(n)
  for (let gy = 0; gy < RY; gy++) {
    const yNorm = (gy + 0.5) / RY
    const band = bandFactor(Math.abs(yNorm - 0.5) * 2)
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      precip[i] = ocean[i] ? OCEAN_PRECIP : rainedOut[i] * band * PRECIP_SCALE * humidity
    }
  }
  return precip
}
