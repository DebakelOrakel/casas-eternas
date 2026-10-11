import { beltYNorm, shiftedNorm } from './climateField'
import { CLIMATE_TUNING } from './climateTuneParams'
import { SEA_LEVEL } from '../elevation/elevationScale'
import { detCos, detExp, detHypot } from '../core/detMath'
import type { ClimateTerrain } from './climateMesh'
import type { CellVectors } from './wind'

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
  const f = CLIMATE_TUNING.precipBandBase + CLIMATE_TUNING.precipBandSwing * detCos(3 * Math.PI * phi)
  return f < CLIMATE_TUNING.precipBandFloor ? CLIMATE_TUNING.precipBandFloor : f
}

// Annual precipitation (mm/yr) on the climate's field mesh, land only (ocean
// cells = OCEAN_PRECIP). Model: moisture evaporates over the ocean (∝ temperature),
// is advected downwind (the prevailing wind field), and rains out — a base
// fraction everywhere plus an orographic bonus on windward slopes, which also
// depletes it for the lee (rain shadow). A zonal band factor then imposes the
// wet-equator / dry-subtropics / wet-subpolar / dry-pole structure. See
// docs/decisions/climate-biomes.md. Elevation is the terrain's raster (the
// full-res field in the climate step); temperature and wind per cell.
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
  seaTemperature: ArrayLike<number>
  seaAnomaly: ArrayLike<number>
  highHpa: ArrayLike<number>
}

// Per cell of the climate's field mesh (DEC-0036 phase 3): `temperature`
// and `wind` per cell; the orography reads the terrain's raster along the
// wind (ClimateTerrain.elevationAt); `refined`'s fields per cell.
export function computePrecipitation(terrain: ClimateTerrain, temperature: ArrayLike<number>, wind: CellVectors, humidity = 1, equatorOffset = 0, beltShift = 0, refined?: RefinedRain): Float64Array {
  const { cm, domain, land } = terrain
  const { mesh, sampler } = cm
  const n = mesh.count
  const unitM = mesh.unitM
  const point = { x: 0, y: 0 }
  const evap = new Float64Array(n)
  const rainFrac = new Float64Array(n)
  // The orography's span about a cell's centre and its lever, in domain
  // units and as their ratio.
  const half = CLIMATE_TUNING.precipOrogHalfSpanM / unitM
  const lever = CLIMATE_TUNING.precipOrogLeverM / (2 * CLIMATE_TUNING.precipOrogHalfSpanM)
  for (let i = 0; i < n; i++) {
    const ocean = land[i] === 0
    evap[i] = evaporation(ocean && refined ? refined.seaTemperature[i] : temperature[i])
    if (ocean) {
      rainFrac[i] = CLIMATE_TUNING.precipBaseRainout
      continue
    }
    // Orographic: land-elevation RISE along the wind (windward slope) → more
    // rain. Only counted between two LAND points — the ocean→coast step is a
    // huge elevation jump but not a mountain, and must not wring out the
    // incoming moisture right at the shoreline (that left interiors bone-dry).
    // The rise is read across this cell, from `precipOrogHalfSpanM` upwind
    // of its centre to as far downwind (each the mean of three points across
    // the wind, the outer two that far to either side), on the fine raster,
    // and scaled to a rise over `precipOrogLeverM` at the wind's speed: the
    // rain falls on the cell the slope is in. It used to be read from 40 px
    // upwind to the cell's centre, which put a range's rain on the plateau
    // behind its rim, up to 300 km in (on Earth's relief, 2026-09-29:
    // Nairobi 6200 mm, Bogotá 5400, both ~1000).
    const u = wind.e[i]
    const v = wind.s[i]
    const speed = detHypot(u, v)
    let upslope = 0
    if (speed > 0) {
      const ax = (u / speed) * half
      const ay = (v / speed) * half
      let up = 0
      let down = 0
      let upLand = true
      for (const k of [-0.5, 0, 0.5]) {
        const px = -ay * k * 2
        const py = ax * k * 2
        // Two offsets in turn (Domain.displace, then advance): on the
        // sphere along the globe from the cell's centre.
        domain.displace(mesh.x[i], mesh.y[i], -ax, -ay, point)
        domain.advance(point.x, point.y, px, py, point)
        const eUp = terrain.elevationAt(point.x, point.y)
        if (eUp <= SEA_LEVEL) upLand = false
        up += eUp / 3
        domain.displace(mesh.x[i], mesh.y[i], ax, ay, point)
        domain.advance(point.x, point.y, px, py, point)
        down += terrain.elevationAt(point.x, point.y) / 3
      }
      if (upLand) upslope = Math.max(0, down - up) * speed * lever
    }
    rainFrac[i] = Math.min(CLIMATE_TUNING.precipRainoutMax, CLIMATE_TUNING.precipBaseRainout + CLIMATE_TUNING.precipOrographicRate * upslope)
  }

  let moisture = new Float64Array(n)
  for (let i = 0; i < n; i++) moisture[i] = land[i] ? 0 : evap[i]
  const rainedOut = new Float64Array(n)
  // The refinement's sinking air, 0..1 per cell (subsidence), and the share
  // of the moisture it mixes away per iteration over land.
  const sinking = refined ? subsidence(terrain, refined.highHpa, equatorOffset, beltShift) : null
  // The refinement's second tracer: moisture × its source's sea anomaly,
  // carried and depleted with the moisture, so carried / moisture is the
  // anomaly of the sea the air came from.
  let carried = new Float64Array(n)
  const sourceAnomaly = new Float64Array(n)
  if (refined) for (let i = 0; i < n; i++) carried[i] = land[i] ? 0 : evap[i] * refined.seaAnomaly[i]
  // The departure point of every land cell, upwind along the great circle
  // (Domain.advance) by the cell's own wind, `precipAdvectStepM` per unit
  // (the meridional part damped), and its triangle's corners and weights,
  // once: the wind does not change between the iterations. Linear in the
  // triangle — monotone, as the raster's bilinear taps were. A sea cell's
  // moisture is its fixed source and reads none.
  const corners = new Int32Array(3 * n)
  const weights = new Float64Array(3 * n)
  const tapC = new Int32Array(3)
  const tapW = new Float64Array(3)
  const step = CLIMATE_TUNING.precipAdvectStepM / unitM
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue
    domain.advance(mesh.x[i], mesh.y[i], -wind.e[i] * step, -wind.s[i] * CLIMATE_TUNING.precipAdvectMeridionalScale * step, point)
    sampler.taps(point.x, point.y, tapC, tapW)
    for (let k = 0; k < 3; k++) {
      corners[3 * i + k] = tapC[k]
      weights[3 * i + k] = tapW[k]
    }
  }
  const at = (field: Float64Array, i: number): number =>
    weights[3 * i] * field[corners[3 * i]] + weights[3 * i + 1] * field[corners[3 * i + 1]] + weights[3 * i + 2] * field[corners[3 * i + 2]]
  for (let iter = 0; iter < CLIMATE_TUNING.precipIters; iter++) {
    const next = new Float64Array(n)
    const nextCarried = refined ? new Float64Array(n) : carried
    for (let i = 0; i < n; i++) {
      if (!land[i]) {
        next[i] = evap[i] // ocean is a fixed moisture source
        if (refined) nextCarried[i] = carried[i]
        continue
      }
      const advected = at(moisture, i)
      const rain = advected * rainFrac[i]
      rainedOut[i] = rain // steady-state rainout — the last iteration wins
      // Depletes by the rain that stays on the ground; the recycled fraction re-enters
      // the pool so downwind interiors keep getting fed (see CLIMATE_TUNING.precipLandRecycleFrac).
      next[i] = advected - rain * (1 - CLIMATE_TUNING.precipLandRecycleFrac)
      if (sinking) next[i] *= 1 - CLIMATE_TUNING.rainSubsidenceMix * sinking[i]
      if (refined && advected > 0) {
        const anomaly = at(carried, i) / advected
        sourceAnomaly[i] = anomaly
        nextCarried[i] = next[i] * anomaly
      }
    }
    moisture = next
    carried = nextCarried
  }

  const precip = new Float64Array(n)
  const shape = domain.kind
  for (let i = 0; i < n; i++) {
    if (!land[i]) {
      precip[i] = OCEAN_PRECIP
      continue
    }
    const band = bandFactor(Math.abs(beltYNorm(shiftedNorm(cm.yNorm[i], equatorOffset), beltShift, shape) - 0.5) * 2)
    const factor = refined ? flankRelief(band, refined.highHpa[i]) * sourceStability(sourceAnomaly[i]) : band
    precip[i] = rainedOut[i] * factor * CLIMATE_TUNING.precipScale * humidity
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
function subsidence(terrain: ClimateTerrain, highHpa: ArrayLike<number>, equatorOffset: number, beltShift: number): Float64Array {
  const T = CLIMATE_TUNING
  const { cm, domain } = terrain
  const n = cm.mesh.count
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const band = bandFactor(Math.abs(beltYNorm(shiftedNorm(cm.yNorm[i], equatorOffset), beltShift, domain.kind) - 0.5) * 2)
    const fromBand = Math.min(1, Math.max(0, (T.rainSubsidenceBand - band) / (T.rainSubsidenceBand - T.precipBandFloor)))
    const h = highHpa[i]
    out[i] = h < 0 ? fromBand * (1 - Math.min(1, -h / T.rainFlankFullHpa)) : Math.max(fromBand, Math.min(1, h / T.oceanHighFlankHpa))
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
  const f = detExp(CLIMATE_TUNING.rainSourcePerC * anomaly)
  return f < CLIMATE_TUNING.rainSourceMin ? CLIMATE_TUNING.rainSourceMin : f > CLIMATE_TUNING.rainSourceMax ? CLIMATE_TUNING.rainSourceMax : f
}
