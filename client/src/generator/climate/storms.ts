import { CLIMATE_TUNING } from './climateTuneParams'
import { latitudeOfNorm, shiftedNorm } from './climateField'
import type { ClimateTerrain } from './climateMesh'
import type { CellVectors } from './wind'
import { upwindPeak } from './phenomena'
import { ELEVATION_METERS } from '../elevation/elevationScale'
import { detHypot } from '../core/detMath'

// STORMS of the climate step's refinement (build step 8 of
// docs/design/climate-refinement.md): where the months' heat, water and
// wind make the weather a game has to reckon with. Derived fields, not
// simulated weather; each is 0..1 per cell of the climate's field mesh
// (DEC-0036 phase 5: both shapes, one path; the tracks step along great
// circles, `climateTrackStepM` a step).

export interface Storms {
  // Tropical cyclone tracks: formed over warm tropical sea, carried by the
  // month's wind with a drift west and poleward, fading over land and cold
  // water. The track density relative to the world's busiest (land and sea).
  cyclone: Float64Array
  // Tornado alleys: warm moist air under dry air off high ground upwind, a
  // strong wind, a plain. The mean of the months' readiness (land).
  tornado: Float64Array
  // Blizzards: the share of the year that is cold, snowy and windy (land).
  blizzard: Float64Array
  // Dust: lifted from dry land by the wind and carried downwind, relative
  // to the dustiest cell (land and sea).
  dust: Float64Array
  // Thunderstorms: the heat and the water of the months that build them,
  // relative to the stormiest cell (land and sea, land the stronger).
  thunder: Float64Array
}

// A track across the mesh: from a point, steps of `climateTrackStepM`
// along the great circle (Domain.advance), each reading the cell it has
// reached (its nearest centre) and its vector carried into the point's
// own frame (Domain.transport; the torus's frame is one). The reached cell
// is found by a greedy walk from the last one over the mesh's links, the
// distances measured in each visited cell's tangent plane — a step is
// about one spacing, so the walk is a move or two.
class Track {
  x = 0
  y = 0
  cell = 0
  private readonly terrain: ClimateTerrain
  private readonly at = { x: 0, y: 0 }
  constructor(terrain: ClimateTerrain) {
    this.terrain = terrain
  }
  start(cell: number): void {
    const { mesh } = this.terrain.cm
    this.x = mesh.x[cell]
    this.y = mesh.y[cell]
    this.cell = cell
  }
  // The field's vector at the reached cell, in the point's frame, into out.
  read(fe: ArrayLike<number>, fs: ArrayLike<number>, out: { x: number; y: number }): void {
    const { mesh } = this.terrain.cm
    const c = this.cell
    this.terrain.domain.transport(fe[c], fs[c], mesh.x[c], mesh.y[c], this.x, this.y, out)
  }
  // One step along the unit direction (dx, dy) of the point's frame.
  step(dx: number, dy: number): void {
    const { domain, cm } = this.terrain
    const { mesh } = cm
    const d = CLIMATE_TUNING.climateTrackStepM / mesh.unitM
    domain.advance(this.x, this.y, dx * d, dy * d, this.at)
    this.x = domain.wrapX(this.at.x)
    this.y = domain.wrapY(this.at.y)
    // The point seen from the cell's centre, in its tangent plane (metres),
    // against each neighbour's centre seen the same way (FieldMesh.offE,
    // .offS): the walk moves while a neighbour is nearer.
    let best = this.cell
    for (;;) {
      domain.delta(this.x, this.y, mesh.x[best], mesh.y[best], this.at)
      const pe = this.at.x * mesh.unitM
      const ps = this.at.y * mesh.unitM
      let bestD = pe * pe + ps * ps
      let next = -1
      for (let e = mesh.nbrStart[best]; e < mesh.nbrStart[best + 1]; e++) {
        const de = pe - mesh.offE[e]
        const ds = ps - mesh.offS[e]
        const dd = de * de + ds * ds
        if (dd < bestD) { bestD = dd; next = mesh.nbr[e] }
      }
      if (next < 0) break
      best = next
    }
    this.cell = best
  }
}

// `monthsT` °C and `monthsP` mm/yr rates (OCEAN_PRECIP on the sea) per
// cell, months × cells (month-major); `winds` the months' winds per cell.
export function computeStorms(terrain: ClimateTerrain, monthsT: ArrayLike<number>, monthsP: ArrayLike<number>, months: number, winds: readonly CellVectors[], equatorOffset: number): Storms {
  const { cm, domain, land } = terrain
  const { mesh } = cm
  const n = mesh.count
  const T = CLIMATE_TUNING
  const cyclone = new Float64Array(n)
  const tornado = new Float64Array(n)
  const blizzard = new Float64Array(n)
  const dustSource = new Float64Array(n)
  const dust = new Float64Array(n)
  const thunder = new Float64Array(n)

  const peakZ = terrain.peakElevation()
  const meanZ = terrain.meanElevation()
  const peak = new Float64Array(n)
  const ground = new Float64Array(n)
  const latDeg = new Float64Array(n)
  let meanArea = 0
  for (let i = 0; i < n; i++) {
    peak[i] = Math.max(0, peakZ[i] * ELEVATION_METERS)
    ground[i] = Math.max(0, meanZ[i] * ELEVATION_METERS)
    latDeg[i] = latitudeOfNorm(shiftedNorm(cm.yNorm[i], equatorOffset)) * 90
    meanArea += mesh.area[i] / n
  }
  const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
  const at = { x: 0, y: 0 }
  const v = { x: 0, y: 0 }
  const track = new Track(terrain)
  const cycloneSteps = Math.round(T.cycloneTrackM / T.climateTrackStepM)
  const dustSteps = Math.round(T.dustTrackM / T.climateTrackStepM)

  for (let m = 0; m < months; m++) {
    const base = m * n
    const wind = winds[m]
    for (let i = 0; i < n; i++) {
      const t = monthsT[base + i]
      const u = wind.e[i]
      const speed = detHypot(u, wind.s[i])
      const rainMonth = land[i] ? monthsP[base + i] / months : 0

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
        const barrier = upwindPeak(terrain, peak, i, u / speed, wind.s[i] / speed, T.tornadoReachM, at)
        const moist = clamp01((t - T.tornadoFromC) / T.tornadoSpanC) * clamp01(rainMonth / T.tornadoFullRainMm)
        const lee = clamp01((barrier - T.tornadoMinBarrierM) / T.tornadoFullBarrierM)
        tornado[i] += (moist * lee * clamp01(u / T.tornadoFullWind)) / months
      }
    }

    // Cyclones: launched from every other warm tropical sea cell (by id, as
    // the raster launched from every other cell), each weighted by its
    // area over the mean (a launch per area), carried by the month's wind
    // plus a drift west and poleward (the beta drift), weakening over land
    // and cold water.
    for (let i0 = m % 2; i0 < n; i0 += 2) {
      const lat = latDeg[i0]
      if (lat < T.cycloneMinLatDeg || lat > T.cycloneMaxLatDeg || land[i0]) continue
      let weight = clamp01((monthsT[base + i0] - T.cycloneWarmC) / T.cycloneSpanC) * (mesh.area[i0] / meanArea)
      if (weight <= 0) continue
      track.start(i0)
      for (let step = 0; step < cycloneSteps && weight > T.cycloneFadeBelow; step++) {
        const i = track.cell
        cyclone[i] += weight
        // +1 in the top hemisphere, where poleward is −y.
        const pole = track.y < domain.height / 2 ? 1 : -1
        track.read(wind.e, wind.s, v)
        const dx = v.x - T.cycloneDriftWest
        const dy = v.y - pole * T.cycloneDriftPole
        const d = detHypot(dx, dy) || 1
        track.step(dx / d, dy / d)
        if (land[i]) weight *= T.cycloneLandKeep
        else if (monthsT[base + i] < T.cycloneColdC) weight *= T.cycloneColdKeep
      }
    }
  }

  // The dust downwind: each source cell's dust carried along the annual
  // mean wind, thinning each step.
  const meanE = new Float64Array(n)
  const meanS = new Float64Array(n)
  for (let m = 0; m < months; m++) {
    for (let i = 0; i < n; i++) {
      meanE[i] += winds[m].e[i] / months
      meanS[i] += winds[m].s[i] / months
    }
  }
  for (let i0 = 0; i0 < n; i0++) {
    let load = dustSource[i0]
    if (load <= 0) continue
    track.start(i0)
    for (let step = 0; step < dustSteps && load > 0.01; step++) {
      dust[track.cell] += load
      track.read(meanE, meanS, v)
      const s = detHypot(v.x, v.y)
      if (s < 0.05) break
      track.step(v.x / s, v.y / s)
      load *= T.dustKeep
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
function normalise(field: Float64Array): void {
  const values = Array.from(field).filter((v) => v > 0).sort((a, b) => a - b)
  if (values.length === 0) return
  const top = values[Math.floor(0.99 * (values.length - 1))]
  if (top <= 0) return
  for (let i = 0; i < field.length; i++) field[i] = Math.min(1, field[i] / top)
}
