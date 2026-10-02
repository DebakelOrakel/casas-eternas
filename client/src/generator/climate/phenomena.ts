import { CLIMATE_RES_X, CLIMATE_RES_Y } from './climateField'
import { CLIMATE_TUNING } from './climateTuneParams'
import { downsampleBox, downsampleMax, wrapIndex2 } from '../core/field'
import { ELEVATION_METERS } from '../elevation/elevationScale'
import { detHypot } from '../core/detMath'

const RX = CLIMATE_RES_X
const RY = CLIMATE_RES_Y
const wrapIndex = (x: number, y: number): number => wrapIndex2(x, y, RX, RY)

// WEATHER PHENOMENA of the climate step's refinement (build step 6 of
// docs/design/climate-refinement.md): fields derived from its months, winds
// and sea, not simulated. Each is a share of the year (0..1) per climate
// cell, and each changes the months it happens in, so the Köppen classes and
// the biomes see it.

export interface Phenomena {
  // Coastal fog: warm air carried over a cold sea condenses, and the marine
  // layer rolls onto the coast (Namib, Atacama, California).
  fog: Float32Array
  // Föhn: air that lost its water on the windward side of a high range comes
  // down the lee warmed by the fall (Alps, Chinook, Zonda).
  foehn: Float32Array
}

// `monthsT` °C, month-major, CHANGED in place: fog cools a coast's month
// toward the sea beside it, föhn warms the lee. `wind` is the months' [u, v]
// (v toward +y), `anomaly` the sea surface's departure from its latitude's
// base (the currents and the upwelling), `land` 1 on land.
export function applyPhenomena(monthsT: Float32Array, months: number, wind: Float32Array, anomaly: Float32Array, land: Uint8Array, elevation: Float32Array, worldWidth: number, worldHeight: number): Phenomena {
  const n = RX * RY
  const T = CLIMATE_TUNING
  const fog = new Float32Array(n)
  const foehn = new Float32Array(n)

  // The coast's reach: each land cell's nearest sea cell within
  // `fogReachCells`, by rings; the fog thins with each cell inland.
  const seaOf = new Int32Array(n).fill(-1)
  const reach = new Float32Array(n)
  for (let gy = 0; gy < RY; gy++) {
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      if (!land[i]) continue
      let best = -1
      let bestD = Infinity
      for (let dy = -T.fogReachCells; dy <= T.fogReachCells; dy++) {
        for (let dx = -T.fogReachCells; dx <= T.fogReachCells; dx++) {
          const j = wrapIndex(gx + dx, gy + dy)
          if (land[j]) continue
          const d = detHypot(dx, dy)
          if (d < bestD) { bestD = d; best = j }
        }
      }
      if (best < 0 || bestD > T.fogReachCells) continue
      seaOf[i] = best
      reach[i] = 1 - (bestD - 1) / T.fogReachCells
    }
  }

  // The relief the wind crosses: the highest ground per cell upwind, the
  // mean ground here, metres.
  const peak = downsampleMax(elevation, worldWidth, worldHeight, RX, RY)
  const ground = downsampleBox(elevation, worldWidth, worldHeight, RX, RY)
  for (let i = 0; i < n; i++) {
    peak[i] = Math.max(0, peak[i] * ELEVATION_METERS)
    ground[i] = Math.max(0, ground[i] * ELEVATION_METERS)
  }

  for (let m = 0; m < months; m++) {
    const at = m * n
    for (let gy = 0; gy < RY; gy++) {
      for (let gx = 0; gx < RX; gx++) {
        const i = gy * RX + gx
        if (!land[i]) continue
        const u = wind[(at + i) * 2]
        const v = wind[(at + i) * 2 + 1]
        const speed = detHypot(u, v)

        // Fog: a cold sea, a wind from it, air warmer than it.
        const sea = seaOf[i]
        if (sea >= 0 && speed > 0) {
          const sx = sea % RX
          const sy = (sea - sx) / RX
          // Toward the land from the sea cell, on the torus.
          let dx = gx - sx
          let dy = gy - sy
          if (dx > RX / 2) dx -= RX
          if (dx < -RX / 2) dx += RX
          if (dy > RY / 2) dy -= RY
          if (dy < -RY / 2) dy += RY
          const onshore = (u * dx + v * dy) / (speed * detHypot(dx, dy))
          const cold = Math.min(1, Math.max(0, -anomaly[sea] / T.fogFullColdC))
          const lift = Math.min(1, Math.max(0, (monthsT[at + i] - monthsT[at + sea]) / T.fogFullContrastC))
          const f = cold * Math.min(1, Math.max(0, onshore) / T.fogFullOnshore) * lift * reach[i]
          if (f > 0) {
            monthsT[at + i] -= f * T.fogCooling * (monthsT[at + i] - monthsT[at + sea])
            fog[i] += f / months
          }
        }

        // Föhn: the highest ground upwind over the ground here.
        if (speed > 0) {
          let barrier = 0
          for (let k = 1; k <= T.foehnReachCells; k++) {
            const j = wrapIndex(Math.round(gx - (u / speed) * k), Math.round(gy - (v / speed) * k))
            barrier = Math.max(barrier, peak[j] - ground[i])
          }
          const f = Math.min(1, Math.max(0, (barrier - T.foehnMinBarrierM) / T.foehnFullBarrierM))
            * Math.min(1, speed / T.foehnFullWind)
          if (f > 0) {
            monthsT[at + i] += f * T.foehnWarmingC
            foehn[i] += f / months
          }
        }
      }
    }
  }
  return { fog, foehn }
}
