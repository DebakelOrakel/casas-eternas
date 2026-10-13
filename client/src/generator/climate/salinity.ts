import { latitudeOfNorm, shiftedNorm } from './climateField'
import { CLIMATE_TUNING } from './climateTuneParams'
import { bandFactor, evaporation } from './precipitation'
import { distanceToSea, zonalMean, type ClimateTerrain } from './climateMesh'
import type { CellVectors } from './wind'
import { currentDepartures } from './oceanCurrents'
import { transportScalar } from '../fields/fieldOperators'

// SALINITY AND THE CONVEYOR (build step 9 of
// docs/design/climate-refinement.md). The sea surface's salt from its fresh-
// water budget — evaporation takes water and leaves the salt, rain and the
// rivers add water, freezing leaves its salt behind — carried by the
// currents the way the sea surface temperature is (oceanCurrents.
// applyOceanSST): each pass takes the value upstream, relaxes toward the
// mean ocean and adds the cell's budget. Then where the water is cold and
// salty enough at high latitude it is dense enough to sink. What that
// draws after it is oceanCurrents.computeSinkInflow, and refinement.ts puts
// the two together. There is no depth model: the sinking is read off the
// surface.
//
// On the climate's field mesh since DEC-0036 phase 4 (climateMesh.ts): per
// cell, the land the terrain's, the transport the SST's departures.

export interface Salinity {
  // Sea surface salinity, psu (g/kg), per sea cell; 0 on land.
  salinity: Float64Array
  // Where the surface water sinks, 0..1; land 0.
  deepWater: Float64Array
}

// `seaTemperature` °C (the year's mean; the sea's cells are what count),
// `landRain` mm/yr (the year's; only land cells are read, a negative one
// is none), `currents` normalised, `humidity` step 0's moisture lever.
//
// The rain over the sea is estimated here, not taken from the rain model,
// which rains out over land only (the sea is where its moisture comes from):
// the same zonal profile the model rains by, times the evaporation of the
// sea there — wet at the equator, dry in the subtropics, moderate at mid
// latitudes, little at the poles, as Earth's oceans are.
// `edge`: the Hadley cell's edge the rain's bands follow (precipitation.bandFactor).
export function computeSalinity(terrain: ClimateTerrain, seaTemperature: ArrayLike<number>, landRain: ArrayLike<number>, currents: CellVectors, equatorOffset: number, humidity: number, edge: number): Salinity {
  const { cm, land } = terrain
  const fm = cm.mesh
  const n = fm.count
  const T = CLIMATE_TUNING
  const lat = new Float64Array(n)
  for (let i = 0; i < n; i++) lat[i] = latitudeOfNorm(shiftedNorm(cm.yNorm[i], equatorOffset))
  const seaRain = new Float64Array(n)
  for (let i = 0; i < n; i++) if (!land[i]) seaRain[i] = T.salinitySeaRainMm * bandFactor(lat[i], edge) * evaporation(seaTemperature[i]) * humidity

  // The rivers: each land cell's surplus (rain over what evaporates there)
  // reaches the sea at the nearest sea cell along the mesh's links
  // (climateMesh.distanceToSea) — the drainage without its routing, which
  // runs after the climate. The surplus is a depth over the land cell: on
  // the sea cell it is that depth times the two cells' area ratio.
  const { nearest } = distanceToSea(fm, land)
  const riverIn = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    if (!land[i] || landRain[i] < 0 || nearest[i] < 0) continue
    const surplus = landRain[i] - T.salinityEvapMm * T.salinityLandEvapShare * evaporation(seaTemperature[i])
    if (surplus > 0) riverIn[nearest[i]] += (surplus * fm.area[i]) / fm.area[nearest[i]]
  }

  // The budget per sea cell, psu per pass: evaporation up, rain and rivers
  // down, freezing up.
  const budget = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    if (land[i]) continue
    const fresh = seaRain[i] + riverIn[i] - T.salinityEvapMm * evaporation(seaTemperature[i])
    budget[i] = -fresh * T.salinityPsuPerMm
    if (seaTemperature[i] < T.ebmSeaIceBelowC) budget[i] += T.salinityBrinePsu
  }

  // Carried by the currents, relaxed toward the ocean's mean; land keeps
  // the mean, so a departure by the coast blends in a sane value.
  const dep = currentDepartures(terrain, currents)
  let salinity = new Float64Array(n).fill(T.salinityMeanPsu)
  let next = new Float64Array(n)
  for (let iter = 0; iter < T.salinityIters; iter++) {
    transportScalar(fm, dep, salinity, next)
    for (let i = 0; i < n; i++) next[i] = land[i] ? T.salinityMeanPsu : next[i] * (1 - T.salinityRelax) + T.salinityMeanPsu * T.salinityRelax + budget[i]
    const t = salinity
    salinity = next
    next = t
  }
  for (let i = 0; i < n; i++) salinity[i] = land[i] ? 0 : Math.max(T.salinityMinPsu, Math.min(T.salinityMaxPsu, salinity[i]))

  // Sinking: where the sea is near freezing and saltier than the rest of
  // its latitude (the sea's zonal mean, climateMesh.zonalMean), poleward of
  // `deepWaterMinLatDeg`. Near freezing the salt decides the density (the
  // water barely expands with warmth there), so the question is where the
  // saltiest cold water is: fresh polar water floats, the salty water the
  // currents carry north sinks. A threshold on an absolute density could not
  // ask it: the first cut, with a fixed expansion, sank every polar sea
  // (Astrakan: 8300 cells), the second, with the expansion shrinking toward
  // freezing, none — the polar seas all come out within a tenth of a psu of
  // each other, as this model moves no moisture between oceans. Full at
  // `deepWaterFullAnomalyPsu` over the latitude's mean, so a world with no
  // salty polar sea gets a weak overturning. The sea surface freezes at
  // −1.8 °C, whatever the air does.
  const mean = zonalMean(cm, salinity, (i) => !land[i])
  const deepWater = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    if (land[i] || lat[i] * 90 < T.deepWaterMinLatDeg) continue
    const surface = Math.max(T.seaFreezesC, seaTemperature[i])
    const cold = Math.min(1, Math.max(0, (T.deepWaterBelowC - surface) / (T.deepWaterBelowC - T.seaFreezesC)))
    const salty = Math.min(1, Math.max(0, (salinity[i] - mean[i]) / T.deepWaterFullAnomalyPsu))
    deepWater[i] = cold * salty
  }
  return { salinity, deepWater }
}
