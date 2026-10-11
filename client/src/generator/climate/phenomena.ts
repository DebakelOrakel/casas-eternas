import { CLIMATE_TUNING } from './climateTuneParams'
import { distanceToSea, type ClimateTerrain } from './climateMesh'
import type { CellVectors } from './wind'
import { ELEVATION_METERS } from '../elevation/elevationScale'
import { detHypot } from '../core/detMath'

// WEATHER PHENOMENA of the climate step's refinement (build step 6 of
// docs/design/climate-refinement.md): fields derived from its months, winds
// and sea, not simulated. Each is a share of the year (0..1) per cell of
// the climate's field mesh (DEC-0036 phase 5: both shapes, one path, the
// lengths in metres), and each changes the months it happens in, so the
// Köppen classes and the biomes see it.

export interface Phenomena {
  // Coastal fog: warm air carried over a cold sea condenses, and the marine
  // layer rolls onto the coast (Namib, Atacama, California).
  fog: Float64Array
  // Föhn: air that lost its water on the windward side of a high range comes
  // down the lee warmed by the fall (Alps, Chinook, Zonda).
  foehn: Float64Array
}

// The highest ground `reachM` upwind of cell `i` along `(u, v)` (its unit
// direction, the cell's frame): the cells under the points every
// `climateTrackStepM` along the great circle (Domain.advance), their
// highest texel (`peak`, metres) — the barrier a wind has crossed. 0 when
// none is higher.
export function upwindPeak(terrain: ClimateTerrain, peak: ArrayLike<number>, i: number, u: number, v: number, reachM: number, at: { x: number; y: number }): number {
  const { cm, domain } = terrain
  const { mesh, sampler } = cm
  const steps = Math.max(1, Math.round(reachM / CLIMATE_TUNING.climateTrackStepM))
  let barrier = 0
  for (let k = 1; k <= steps; k++) {
    const d = (k * CLIMATE_TUNING.climateTrackStepM) / mesh.unitM
    domain.advance(mesh.x[i], mesh.y[i], -u * d, -v * d, at)
    const j = sampler.nearestCell(domain.wrapX(at.x), domain.wrapY(at.y))
    barrier = Math.max(barrier, peak[j])
  }
  return barrier
}

// `monthsT` °C per cell, months × cells (month-major), CHANGED in place: fog
// cools a coast's month toward the sea beside it, föhn warms the lee.
// `winds` the months' winds per cell (east, south in the cell's frame),
// `anomaly` the sea surface's departure from its latitude's base (the
// currents and the upwelling), 0 on land.
export function applyPhenomena(terrain: ClimateTerrain, monthsT: Float64Array, months: number, winds: readonly CellVectors[], anomaly: ArrayLike<number>): Phenomena {
  const { cm, domain, land } = terrain
  const { mesh } = cm
  const n = mesh.count
  const T = CLIMATE_TUNING
  const fog = new Float64Array(n)
  const foehn = new Float64Array(n)

  // The coast's reach: each land cell's nearest sea cell along the mesh's
  // links (climateMesh.distanceToSea), and the straight distance between
  // the two centres in metres; full up to `fogFullWithinM`, thinning by
  // the reach beyond it, none past `fogReachM`.
  const { nearest } = distanceToSea(mesh, land)
  const seaOf = new Int32Array(n).fill(-1)
  const reach = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const sea = nearest[i]
    if (!land[i] || sea < 0) continue
    const d = Math.sqrt(domain.distanceSq(mesh.x[sea], mesh.y[sea], mesh.x[i], mesh.y[i])) * mesh.unitM
    if (d > T.fogReachM) continue
    seaOf[i] = sea
    reach[i] = Math.min(1, 1 - (d - T.fogFullWithinM) / T.fogReachM)
  }

  // The relief the wind crosses: the highest ground in each cell, the mean
  // ground here, metres (ClimateTerrain.peakElevation, .meanElevation).
  const peakZ = terrain.peakElevation()
  const meanZ = terrain.meanElevation()
  const peak = new Float64Array(n)
  const ground = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    peak[i] = Math.max(0, peakZ[i] * ELEVATION_METERS)
    ground[i] = Math.max(0, meanZ[i] * ELEVATION_METERS)
  }

  const offset = { x: 0, y: 0 }
  const at = { x: 0, y: 0 }
  for (let m = 0; m < months; m++) {
    const base = m * n
    const wind = winds[m]
    for (let i = 0; i < n; i++) {
      if (!land[i]) continue
      const u = wind.e[i]
      const v = wind.s[i]
      const speed = detHypot(u, v)

      // Fog: a cold sea, a wind from it, air warmer than it.
      const sea = seaOf[i]
      if (sea >= 0 && speed > 0) {
        // Toward the land from the sea cell, in the land cell's frame (its
        // wind's): the offset to the sea turned round.
        domain.delta(mesh.x[sea], mesh.y[sea], mesh.x[i], mesh.y[i], offset)
        const dx = -offset.x
        const dy = -offset.y
        const onshore = (u * dx + v * dy) / (speed * detHypot(dx, dy))
        const cold = Math.min(1, Math.max(0, -anomaly[sea] / T.fogFullColdC))
        const lift = Math.min(1, Math.max(0, (monthsT[base + i] - monthsT[base + sea]) / T.fogFullContrastC))
        const f = cold * Math.min(1, Math.max(0, onshore) / T.fogFullOnshore) * lift * reach[i]
        if (f > 0) {
          monthsT[base + i] -= f * T.fogCooling * (monthsT[base + i] - monthsT[base + sea])
          fog[i] += f / months
        }
      }

      // Föhn: the highest ground upwind over the ground here.
      if (speed > 0) {
        const barrier = Math.max(0, upwindPeak(terrain, peak, i, u / speed, v / speed, T.foehnReachM, at) - ground[i])
        const f = Math.min(1, Math.max(0, (barrier - T.foehnMinBarrierM) / T.foehnFullBarrierM))
          * Math.min(1, speed / T.foehnFullWind)
        if (f > 0) {
          monthsT[base + i] += f * T.foehnWarmingC
          foehn[i] += f / months
        }
      }
    }
  }
  return { fog, foehn }
}
