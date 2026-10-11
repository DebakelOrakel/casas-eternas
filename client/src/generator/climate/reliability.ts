import { latitudeOfNorm, shiftedNorm } from './climateField'
import { CLIMATE_TUNING } from './climateTuneParams'
import { OCEAN_PRECIP } from './precipitation'
import type { BasinRows, ClimateTerrain } from './climateMesh'
import { detExp, detHypot, sq } from '../core/detMath'

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
//
// Per cell of the climate's field mesh (DEC-0036 phase 5); the basins are
// the seas along the parallels (climateMesh.basinRows), the reach a length
// in metres along the parallel.

export interface Reliability {
  // The annual rain's coefficient of variation per land cell (0.3 = one
  // year in three off by 30 %); 0 on the sea.
  rainVariability: Float64Array
  // The see-saw's mark per land cell, −1..1: + wetter in the warm phase
  // (El Niño), − drier; 0 where it does not reach, and on the sea.
  ensoPattern: Float64Array
  // Its period in years, and its strength (0..1) — the world's strongest
  // basin; 0 and 0 where no basin can hold one.
  ensoPeriodYears: number
  ensoStrength: number
}

// `precipitation` is the annual rain per cell (mm/yr, OCEAN_PRECIP on the
// sea), `monsoonIndex` its signed seasonality, `anomaly` the sea surface's
// departure from its latitude (the currents and the upwelling), 0 on land.
export function computeReliability(terrain: ClimateTerrain, rows: BasinRows, precipitation: ArrayLike<number>, monsoonIndex: ArrayLike<number>, anomaly: ArrayLike<number>, equatorOffset: number): Reliability {
  const { cm, domain, land } = terrain
  const { mesh } = cm
  const n = mesh.count
  const T = CLIMATE_TUNING
  const W = domain.width

  // The basins on the equator: runs of sea along the parallels within
  // `ensoRowsDeg` of it, shore to shore (basinRows' rings). A run's strength
  // is its west-to-east warmth, full at `ensoFullGradientC`, times its width
  // past `ensoMinWidthDeg` of longitude, full at `ensoFullWidthDeg`. The same
  // basin found on several parallels counts once, at its best — two runs
  // whose ends lie within `ensoSameBasinM` of each other.
  type Basin = { west: number; east: number; strength: number; widthDeg: number }
  const basins: Basin[] = []
  const same = T.ensoSameBasinM / mesh.unitM
  const zonal = (a: number, b: number): number => {
    let d = Math.abs(a - b)
    if (d > W / 2) d = W - d
    return d
  }
  for (const ring of rows.rings) {
    if (latitudeOfNorm(shiftedNorm(ring.y / domain.height, equatorOffset)) * 90 > T.ensoRowsDeg) continue
    const N = ring.count
    for (let k0 = 0; k0 < N; k0++) {
      // A run of sea starts after a land point.
      if (!ring.land[k0] || ring.land[(k0 + 1) % N]) continue
      const len = ring.runLength[(k0 + 1) % N]
      if (len >= N) continue
      const third = Math.max(1, Math.floor(len / 3))
      let warm = 0
      let cold = 0
      for (let k = 0; k < third; k++) {
        warm += anomaly[ring.cell[(k0 + 1 + k) % N]] / third
        cold += anomaly[ring.cell[(k0 + len - k) % N]] / third
      }
      const widthDeg = (len * 360) / N
      const strength = Math.min(1, Math.max(0, (warm - cold) / T.ensoFullGradientC))
        * Math.min(1, Math.max(0, (widthDeg - T.ensoMinWidthDeg) / (T.ensoFullWidthDeg - T.ensoMinWidthDeg)))
      if (strength <= 0) continue
      const west = (((k0 + 1) % N) + 0.5) * (W / N)
      const east = (((k0 + len) % N) + 0.5) * (W / N)
      const known = basins.find((b) => zonal(b.west, west) <= same && zonal(b.east, east) <= same)
      if (known) {
        if (strength > known.strength) Object.assign(known, { west, east, strength, widthDeg })
      } else {
        basins.push({ west, east, strength, widthDeg })
      }
    }
  }

  // The see-saw's reach on land: near the basin's shores, along the
  // parallel (its length cos φ of the equator's on the sphere), near the
  // equator.
  const ensoPattern = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue
    const lat = latitudeOfNorm(shiftedNorm(cm.yNorm[i], equatorOffset)) * 90
    const byLat = detExp(-sq(lat / T.ensoReachLatDeg))
    const perUnit = mesh.unitM * rows.rings[cm.band[i]].scale
    let mark = 0
    for (const b of basins) {
      // The land past the basin's east end is wetter in the warm phase,
      // the land before its west end drier.
      const wet = detExp(-sq((zonal(mesh.x[i], b.east) * perUnit) / T.ensoReachM))
      const dry = detExp(-sq((zonal(mesh.x[i], b.west) * perUnit) / T.ensoReachM))
      mark += b.strength * byLat * (wet - dry)
    }
    ensoPattern[i] = Math.max(-1, Math.min(1, mark))
  }

  // The spread: the rain's own, from its dryness and its season, and the
  // see-saw's on top, as independent parts add (in quadrature).
  const rainVariability = new Float64Array(n)
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
