import { CLIMATE_RES_X, CLIMATE_RES_Y, latitudeAt } from './climateField'
import { CLIMATE_TUNING } from './climateTuneParams'
import { downsampleBox, downsampleMax, wrapIndex2 } from '../core/field'
import { ELEVATION_METERS } from '../elevation/elevationScale'
import { detHypot } from '../core/detMath'

const RX = CLIMATE_RES_X
const RY = CLIMATE_RES_Y
const wrapIndex = (x: number, y: number): number => wrapIndex2(x, y, RX, RY)

// STORMS of the climate step's refinement (build step 8 of
// docs/design/climate-refinement.md): where the months' heat, water and
// wind make the weather a game has to reckon with. Derived fields, not
// simulated weather; each is 0..1 per climate cell.

export interface Storms {
  // Tropical cyclone tracks: formed over warm tropical sea, carried by the
  // month's wind with a drift west and poleward, fading over land and cold
  // water. The track density relative to the world's busiest (land and sea).
  cyclone: Float32Array
  // Tornado alleys: warm moist air under dry air off high ground upwind, a
  // strong wind, a plain. The mean of the months' readiness (land).
  tornado: Float32Array
  // Blizzards: the share of the year that is cold, snowy and windy (land).
  blizzard: Float32Array
  // Dust: lifted from dry land by the wind and carried downwind, relative
  // to the dustiest cell (land and sea).
  dust: Float32Array
  // Thunderstorms: the heat and the water of the months that build them,
  // relative to the stormiest cell (land and sea, land the stronger).
  thunder: Float32Array
}

// `monthsT` °C and `monthsP` mm/yr rates (OCEAN_PRECIP on the sea), month-
// major; `wind` the months' [u, v]; `land` 1 on land.
export function computeStorms(monthsT: Float32Array, monthsP: Float32Array, months: number, wind: Float32Array, land: Uint8Array, elevation: Float32Array, worldWidth: number, worldHeight: number, equatorOffset: number): Storms {
  const n = RX * RY
  const T = CLIMATE_TUNING
  const cyclone = new Float32Array(n)
  const tornado = new Float32Array(n)
  const blizzard = new Float32Array(n)
  const dustSource = new Float32Array(n)
  const dust = new Float32Array(n)
  const thunder = new Float32Array(n)

  const peak = downsampleMax(elevation, worldWidth, worldHeight, RX, RY)
  const ground = downsampleBox(elevation, worldWidth, worldHeight, RX, RY)
  for (let i = 0; i < n; i++) {
    peak[i] = Math.max(0, peak[i] * ELEVATION_METERS)
    ground[i] = Math.max(0, ground[i] * ELEVATION_METERS)
  }
  const latDeg = new Float32Array(RY)
  const north = new Int8Array(RY)
  for (let gy = 0; gy < RY; gy++) {
    latDeg[gy] = latitudeAt(gy, equatorOffset) * 90
    north[gy] = gy < RY / 2 ? 1 : -1
  }
  const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

  for (let m = 0; m < months; m++) {
    const at = m * n
    for (let gy = 0; gy < RY; gy++) {
      for (let gx = 0; gx < RX; gx++) {
        const i = gy * RX + gx
        const t = monthsT[at + i]
        const u = wind[(at + i) * 2]
        const v = wind[(at + i) * 2 + 1]
        const speed = detHypot(u, v)
        const rainMonth = land[i] ? monthsP[at + i] / months : 0

        // Thunder: heat and water; the sea builds fewer (it heats slowly).
        const water = land[i] ? clamp01(rainMonth / T.thunderFullRainMm) : 0.6
        thunder[i] += (clamp01((t - T.thunderFromC) / T.thunderSpanC) * water * (land[i] ? 1 : T.thunderSeaShare)) / months

        if (!land[i]) continue

        // Blizzard: cold, snow, wind.
        if (t < T.blizzardBelowC && rainMonth > T.blizzardMinSnowMm && speed > T.blizzardMinWind) blizzard[i] += 1 / months

        // Dust: a dry month above freezing (frozen or snow-covered ground
        // lifts nothing) and a wind to lift it.
        if (t > 0) dustSource[i] += (clamp01(1 - rainMonth / T.dustDryBelowMm) * clamp01(speed / T.dustFullWind)) / months

        // Tornado: warm and moist here, high ground upwind, a westerly to
        // carry the dry air off it over the moist (the trades bring none),
        // a plain.
        if (u > 0 && ground[i] < T.tornadoPlainBelowM) {
          let barrier = 0
          for (let k = 1; k <= T.tornadoReachCells; k++) {
            const j = wrapIndex(Math.round(gx - (u / speed) * k), Math.round(gy - (v / speed) * k))
            barrier = Math.max(barrier, peak[j])
          }
          const moist = clamp01((t - T.tornadoFromC) / T.tornadoSpanC) * clamp01(rainMonth / T.tornadoFullRainMm)
          const lee = clamp01((barrier - T.tornadoMinBarrierM) / T.tornadoFullBarrierM)
          tornado[i] += (moist * lee * clamp01(u / T.tornadoFullWind)) / months
        }
      }
    }

    // Cyclones: launched from every other warm tropical sea cell, carried by
    // the month's wind plus a drift west and poleward (the beta drift),
    // weakening over land and cold water.
    for (let gy = 0; gy < RY; gy++) {
      const lat = latDeg[gy]
      if (lat < T.cycloneMinLatDeg || lat > T.cycloneMaxLatDeg) continue
      for (let gx = gy % 2; gx < RX; gx += 2) {
        const i0 = gy * RX + gx
        if (land[i0]) continue
        let weight = clamp01((monthsT[at + i0] - T.cycloneWarmC) / T.cycloneSpanC)
        if (weight <= 0) continue
        let x = gx
        let y = gy
        for (let step = 0; step < T.cycloneSteps && weight > T.cycloneFadeBelow; step++) {
          const cx = ((Math.round(x) % RX) + RX) % RX
          const cy = ((Math.round(y) % RY) + RY) % RY
          const i = cy * RX + cx
          cyclone[i] += weight
          const pole = north[cy] // +1 top: poleward is −y
          const dx = wind[(at + i) * 2] - T.cycloneDriftWest
          const dy = wind[(at + i) * 2 + 1] - pole * T.cycloneDriftPole
          const d = detHypot(dx, dy) || 1
          x += dx / d
          y += dy / d
          if (land[i]) weight *= T.cycloneLandKeep
          else if (monthsT[at + i] < T.cycloneColdC) weight *= T.cycloneColdKeep
        }
      }
    }
  }

  // The dust downwind: each source cell's dust carried along the annual
  // mean wind, thinning each cell.
  const meanWind = new Float32Array(n * 2)
  for (let m = 0; m < months; m++) for (let i = 0; i < n * 2; i++) meanWind[i] += wind[m * n * 2 + i] / months
  for (let gy = 0; gy < RY; gy++) {
    for (let gx = 0; gx < RX; gx++) {
      let load = dustSource[gy * RX + gx]
      if (load <= 0) continue
      let x = gx
      let y = gy
      for (let step = 0; step < T.dustSteps && load > 0.01; step++) {
        const i = wrapIndex(Math.round(x), Math.round(y))
        dust[i] += load
        const u = meanWind[i * 2]
        const v = meanWind[i * 2 + 1]
        const s = detHypot(u, v)
        if (s < 0.05) break
        x += u / s
        y += v / s
        load *= T.dustKeep
      }
    }
  }

  normalise(cyclone)
  normalise(dust)
  normalise(thunder)
  normalise(tornado)
  return { cyclone, tornado, blizzard, dust, thunder }
}

// Scaled to the 99th percentile of its non-zero cells, capped at 1: one
// busy cell must not leave the rest pale.
function normalise(field: Float32Array): void {
  const values = Array.from(field).filter((v) => v > 0).sort((a, b) => a - b)
  if (values.length === 0) return
  const top = values[Math.floor(0.99 * (values.length - 1))]
  if (top <= 0) return
  for (let i = 0; i < field.length; i++) field[i] = Math.min(1, field[i] / top)
}
