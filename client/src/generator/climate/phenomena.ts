import { CLIMATE_RES_X, CLIMATE_RES_Y } from './climateField'
import { CLIMATE_TUNING } from './climateTuneParams'
import { downsampleBox, downsampleMax } from '../core/field'
import type { Domain } from '../core/domain'
import { ELEVATION_METERS } from '../elevation/elevationScale'
import { detHypot } from '../core/detMath'

const RX = CLIMATE_RES_X
const RY = CLIMATE_RES_Y

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
// base (the currents and the upwelling), `land` 1 on land, `domain` what
// the elevation raster covers, one cell per unit.
export function applyPhenomena(monthsT: Float32Array, months: number, wind: Float32Array, anomaly: Float32Array, land: Uint8Array, elevation: Float32Array, domain: Domain): Phenomena {
  const { width: worldWidth, height: worldHeight } = domain
  const grid = domain.grid(RX, RY)
  const n = RX * RY
  const T = CLIMATE_TUNING
  const fog = new Float32Array(n)
  const foehn = new Float32Array(n)

  // The coast's reach: each land cell's nearest sea cell within
  // `fogReachCells`, by rings; the fog thins with each cell inland. The
  // distance is a length (step 4e): the offset between the two cells'
  // centres on the climate grid's own domain (`cells`, one unit a cell) —
  // on the torus the integers dx, dy themselves; on the sphere the arc, and
  // a row reaches as many of its cells east-west as span the reach.
  const cells = domain.scaledTo(RX, RY)
  const offset = { x: 0, y: 0 }
  const seaOf = new Int32Array(n).fill(-1)
  const reach = new Float32Array(n)
  for (let gy = 0; gy < RY; gy++) {
    const rx = Math.min(RX >> 1, Math.ceil(T.fogReachCells / grid.rowScale(gy)))
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      if (!land[i]) continue
      let best = -1
      let bestD = Infinity
      for (let dy = -T.fogReachCells; dy <= T.fogReachCells; dy++) {
        for (let dx = -rx; dx <= rx; dx++) {
          const j = grid.index(gx + dx, gy + dy)
          if (land[j]) continue
          const jx = j % RX
          cells.delta(jx + 0.5, (j - jx) / RX + 0.5, gx + 0.5, gy + 0.5, offset)
          const d = detHypot(offset.x, offset.y)
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
          // Toward the land from the sea cell, in the land cell's frame
          // (its wind's): the offset to the sea turned round. On the torus
          // the minimum image, as it was.
          cells.delta(sx + 0.5, sy + 0.5, gx + 0.5, gy + 0.5, offset)
          const dx = -offset.x
          const dy = -offset.y
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
            // Upwind along the globe on the sphere (DomainGrid.cellDisplaced;
            // the torus rounds the chart's step, as it did).
            const j = grid.cellDisplaced(gx, gy, -(u / speed) * k, -(v / speed) * k)
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
  // A pole row is one point: its land one value (a no-op on the torus).
  grid.averagePoleRows(fog, land)
  grid.averagePoleRows(foehn, land)
  return { fog, foehn }
}
