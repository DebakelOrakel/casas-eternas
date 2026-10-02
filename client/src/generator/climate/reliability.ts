import { CLIMATE_RES_X, CLIMATE_RES_Y, latitudeAt } from './climateField'
import { CLIMATE_TUNING } from './climateTuneParams'
import { OCEAN_PRECIP } from './precipitation'
import { detExp, detHypot, sq } from '../core/detMath'

const RX = CLIMATE_RES_X
const RY = CLIMATE_RES_Y

// THE RAIN'S RELIABILITY (build step 7 of docs/design/climate-refinement.md):
// how much one year's rain differs from the next, derived rather than
// simulated. The climate the step computes is a mean over decades; a game
// that has bad harvests needs the spread around it too.
//
// Two parts. The rain's own year-to-year spread, which grows as a climate
// gets drier (deserts vary by 40–50 %, wet coasts by 10–15 %) and at the
// margins of a monsoon. And an ENSO-like see-saw: an equatorial basin with a
// shore on both sides and trade winds piles warm water in its west and lifts
// cold water in its east; now and then the trades weaken and the warm water
// sloshes back. Then the basin's eastern shore (the west coast of the land
// beyond it: Peru) gets rain it does not usually get, and its western shore
// (the east coast of the land before it: Indonesia, Australia) goes dry. An
// open equatorial band has no shores to pile water against, and no see-saw.

export interface Reliability {
  // The annual rain's coefficient of variation per land cell (0.3 = one
  // year in three off by 30 %); 0 on the sea.
  rainVariability: Float32Array
  // The see-saw's mark per land cell, −1..1: + wetter in the warm phase
  // (El Niño), − drier; 0 where it does not reach, and on the sea.
  ensoPattern: Float32Array
  // Its period in years, and its strength (0..1) — the world's strongest
  // basin; 0 and 0 where no basin can hold one.
  ensoPeriodYears: number
  ensoStrength: number
}

// `precipitation` is the annual rain (mm/yr, OCEAN_PRECIP on the sea),
// `monsoonIndex` its signed seasonality, `anomaly` the sea surface's
// departure from its latitude (the currents and the upwelling), `land` 1 on
// land.
export function computeReliability(precipitation: Float32Array, monsoonIndex: Float32Array, anomaly: Float32Array, land: Uint8Array, equatorOffset: number): Reliability {
  const n = RX * RY
  const T = CLIMATE_TUNING

  // The basins on the equator: runs of sea along the rows within
  // `ensoRowsDeg` of it, shore to shore. A run's strength is its west-to-east
  // warmth, full at `ensoFullGradientC`, times its width past
  // `ensoMinWidthDeg`, full at `ensoFullWidthDeg`. The same basin found on
  // several rows counts once, at its best row.
  type Basin = { west: number; east: number; strength: number; widthDeg: number }
  const basins: Basin[] = []
  for (let gy = 0; gy < RY; gy++) {
    if (latitudeAt(gy, equatorOffset) * 90 > T.ensoRowsDeg) continue
    for (let x0 = 0; x0 < RX; x0++) {
      // A run of sea starts after a land cell.
      if (!land[gy * RX + x0] || land[gy * RX + (x0 + 1) % RX]) continue
      let len = 0
      while (len < RX && !land[gy * RX + (x0 + 1 + len) % RX]) len++
      if (len >= RX) continue
      const third = Math.max(1, Math.floor(len / 3))
      let warm = 0
      let cold = 0
      for (let k = 0; k < third; k++) {
        warm += anomaly[gy * RX + (x0 + 1 + k) % RX] / third
        cold += anomaly[gy * RX + (x0 + len - k) % RX] / third
      }
      const widthDeg = (len * 360) / RX
      const strength = Math.min(1, Math.max(0, (warm - cold) / T.ensoFullGradientC))
        * Math.min(1, Math.max(0, (widthDeg - T.ensoMinWidthDeg) / (T.ensoFullWidthDeg - T.ensoMinWidthDeg)))
      if (strength <= 0) continue
      const west = (x0 + 1) % RX
      const east = (x0 + len) % RX
      const same = basins.find((b) => Math.abs(b.west - west) <= 3 && Math.abs(b.east - east) <= 3)
      if (same) {
        if (strength > same.strength) Object.assign(same, { west, east, strength, widthDeg })
      } else {
        basins.push({ west, east, strength, widthDeg })
      }
    }
  }

  // The see-saw's reach on land: near the basin's shores, near the equator.
  const ensoPattern = new Float32Array(n)
  const zonal = (a: number, b: number): number => {
    let d = Math.abs(a - b)
    if (d > RX / 2) d = RX - d
    return d
  }
  for (let gy = 0; gy < RY; gy++) {
    const lat = latitudeAt(gy, equatorOffset) * 90
    const byLat = detExp(-sq(lat / T.ensoReachLatDeg))
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      if (!land[i]) continue
      let mark = 0
      for (const b of basins) {
        // The land past the basin's east end is wetter in the warm phase,
        // the land before its west end drier.
        const wet = detExp(-sq(zonal(gx, b.east) / T.ensoReachCells))
        const dry = detExp(-sq(zonal(gx, b.west) / T.ensoReachCells))
        mark += b.strength * byLat * (wet - dry)
      }
      ensoPattern[i] = Math.max(-1, Math.min(1, mark))
    }
  }

  // The spread: the rain's own, from its dryness and its season, and the
  // see-saw's on top, as independent parts add (in quadrature).
  const rainVariability = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    if (!land[i] || precipitation[i] === OCEAN_PRECIP) continue
    const own = Math.min(T.rainVariabilityMax, T.rainVariabilityScale / Math.sqrt(Math.max(precipitation[i], T.rainVariabilityFloorMm)))
      * (1 + T.rainVariabilitySeason * Math.abs(monsoonIndex[i]))
    const enso = T.ensoVariability * Math.abs(ensoPattern[i])
    rainVariability[i] = Math.min(T.rainVariabilityMax, detHypot(own, enso))
  }

  let best: Basin | null = null
  for (const b of basins) if (!best || b.strength > best.strength) best = b
  const ensoPeriodYears = best
    ? T.ensoPeriodMinYears + (T.ensoPeriodMaxYears - T.ensoPeriodMinYears) * Math.min(1, best.widthDeg / 180)
    : 0
  return { rainVariability, ensoPattern, ensoPeriodYears, ensoStrength: best?.strength ?? 0 }
}
