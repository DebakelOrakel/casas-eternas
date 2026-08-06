import { CLIMATE_RES_X, CLIMATE_RES_Y, sampleDryLandAtCell, sampleElevationAtCell, shiftedYNorm } from './climateField'
import { SEA_LEVEL, SLOPE_RECALIBRATION } from '../elevation/elevationScale'
import { sampleBilinearGrid } from '../core/field'
import { wrapValue } from '../core/field'

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
// Scaled by SLOPE_RECALIBRATION: land slopes halved when the continental
// interior stopped being a flat plateau, so the same terrain now produces half
// the measured upslope. Without this, orographic rain and its rain shadows both
// collapse toward the BASE_RAINOUT floor.
const OROGRAPHIC_RATE = 0.9 * SLOPE_RECALIBRATION
// Land moisture recycling (evapotranspiration): the fraction of rained-out water that
// re-evaporates from soil/vegetation back into the airborne pool, feeding downwind rain.
// This is a MAJOR real process — ~a third to a half of continental precipitation is
// recycled from land ET, which is what keeps deep interiors (Amazon, Congo, monsoon
// Asia) wet far from any coast rather than the near-zero our pure-depletion advection
// gave. It sustains ALREADY-fed interiors (so rainforests/forests reach inland) without
// rescuing genuine rain-shadow deserts (nothing rains → nothing recycles), so aridity
// stays where it belongs. Net land depletion per step becomes rain·(1 − this).
const LAND_RECYCLE_FRAC = 0.5
// World px upwind to sample for the along-wind slope (needs the fine elevation,
// not the coarse climate grid — the point of sampling full-res here).
const OROG_SAMPLE_PX = 40
// Raw rainout → mm/yr. Tunes overall wetness; a wet windward mountain lands
// around a few thousand mm, deserts/rain-shadow near zero.
//
// Known deviation, measured 2026-07-31 and deliberately left alone: the wettest
// cells reach ~22500 mm/yr and ~1.3% of land exceeds Earth's all-time record of
// 11900 — unphysical as a DISTRIBUTION (our cells are 62 km means, which should
// sit below a point record, not above it). Do not reach for this constant to fix
// it: the median is 813 mm/yr against Earth's ~700, so the overall calibration is
// right and lowering it would drag the sound body down with the tail.
//
// The cause is the shape of the model, not a constant. `rainFrac` is a fraction
// per iteration with no saturation, and one iteration advects 62 km — so at a p99
// upslope roughly half the moisture column may rain out over that single step.
// The 0.85 clamp below binds far too late to stop it (it needs a 4100 m rise over
// the 312 km sample, and catches only 0.04-1.4% of land cells). The physical fix
// is a soft saturation on rainFrac, not a lower ceiling here.
//
// Left as is because it costs nothing downstream: capping precipitation at 4000
// changed ZERO biome cells on both test seeds (Whittaker's thresholds stop at
// 1500 mm, and ecology's productivity is 1 − exp(−0.000664·P), already 0.98 at
// 6000). It survives only into hydrology, which is linear in precip: mean runoff
// +29% and maxDischarge +72%, i.e. rivers drawn about a quarter narrower. Those
// are aesthetic knobs. A saturation would shift mean runoff ~30%, so it would cost
// a re-tuned river-density default and a golden re-record — not worth it for a
// number nothing reads. Three other suspects were ruled out first: the scale
// (median is right), erosion's missing deposition (pre/post distributions are
// identical), and ridged noise in the slope sample (the tail survives without
// noise, and the wettest cells cluster 70-93%, so it is real orography).
const PRECIP_SCALE = 60000
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
// Floor for the zonal band multiplier — the subtropical-high / polar dry minimum. At
// 0.1 the subtropics got a 15× dry penalty vs the equator, which (with interior
// depletion) turned nearly all subtropical land into extreme desert. A higher floor
// keeps those belts the driest zones without erasing all vegetation there (semi-arid
// grassland/savanna rather than bare desert).
const BAND_FLOOR = 0.13
function bandFactor(phi: number): number {
  const f = 0.8 + 0.7 * Math.cos(3 * Math.PI * phi)
  return f < BAND_FLOOR ? BAND_FLOOR : f
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
      const e = sampleElevationAtCell(elevation, gx, gy, worldW, worldH)
      ocean[i] = e <= SEA_LEVEL && !sampleDryLandAtCell(dryLand, gx, gy, worldW, worldH) ? 1 : 0
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
        const advected = sampleBilinearGrid(moisture, RX, RY, gx - u * ADVECT_STEP, gy - v * ADVECT_MERIDIONAL_SCALE * ADVECT_STEP)
        if (ocean[i]) {
          next[i] = evap[i] // ocean is a fixed moisture source
          continue
        }
        const rain = advected * rainFrac[i]
        rainedOut[i] = rain // steady-state rainout — the last iteration wins
        // Depletes by the rain that stays on the ground; the recycled fraction re-enters
        // the pool so downwind interiors keep getting fed (see LAND_RECYCLE_FRAC).
        next[i] = advected - rain * (1 - LAND_RECYCLE_FRAC)
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
      precip[i] = ocean[i] ? OCEAN_PRECIP : rainedOut[i] * band * PRECIP_SCALE * humidity
    }
  }
  return precip
}
