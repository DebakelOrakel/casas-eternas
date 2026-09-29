import { CLIMATE_RES_X, CLIMATE_RES_Y, latitudeAt } from './climateField'
import { CLIMATE_TUNING } from './climateTuneParams'
import { bandFactor, evaporation } from './precipitation'
import { sampleBilinearGrid, wrapIndex2 } from '../core/field'

const RX = CLIMATE_RES_X
const RY = CLIMATE_RES_Y
const wrapIndex = (x: number, y: number): number => wrapIndex2(x, y, RX, RY)
const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const

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

export interface Salinity {
  // Sea surface salinity, psu (g/kg), per sea cell; 0 on land.
  salinity: Float32Array
  // Where the surface water sinks, 0..1; land 0.
  deepWater: Float32Array
}

// `seaTemperature` °C (the year's mean; the sea's cells are what count),
// `landRain` mm/yr (the year's; only land cells are read), `currents`
// [u, v] normalised, `land` 1 on land, `humidity` step 0's moisture lever.
//
// The rain over the sea is estimated here, not taken from the rain model,
// which rains out over land only (the sea is where its moisture comes from):
// the same zonal profile the model rains by, times the evaporation of the
// sea there — wet at the equator, dry in the subtropics, moderate at mid
// latitudes, little at the poles, as Earth's oceans are.
export function computeSalinity(seaTemperature: Float32Array, landRain: Float32Array, currents: Float32Array, land: Uint8Array, equatorOffset: number, humidity: number): Salinity {
  const n = RX * RY
  const T = CLIMATE_TUNING
  const seaRain = new Float32Array(n)
  for (let gy = 0; gy < RY; gy++) {
    const band = bandFactor(latitudeAt(gy, equatorOffset))
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      if (!land[i]) seaRain[i] = T.salinitySeaRainMm * band * evaporation(seaTemperature[i]) * humidity
    }
  }

  // The rivers: each land cell's surplus (rain over what evaporates there)
  // reaches the sea at the nearest sea cell — the drainage without its
  // routing, which runs after the climate.
  const nearestSea = new Int32Array(n).fill(-1)
  const queue: number[] = []
  for (let i = 0; i < n; i++) if (!land[i]) { nearestSea[i] = i; queue.push(i) }
  for (let h = 0; h < queue.length; h++) {
    const i = queue[h]
    const x = i % RX
    const y = (i - x) / RX
    for (const [dx, dy] of NEIGHBOURS) {
      const j = wrapIndex(x + dx, y + dy)
      if (nearestSea[j] >= 0) continue
      nearestSea[j] = nearestSea[i]
      queue.push(j)
    }
  }
  const riverIn = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    if (!land[i] || landRain[i] < 0 || nearestSea[i] < 0) continue
    const surplus = landRain[i] - T.salinityEvapMm * T.salinityLandEvapShare * evaporation(seaTemperature[i])
    if (surplus > 0) riverIn[nearestSea[i]] += surplus
  }

  // The budget per sea cell, psu per pass: evaporation up, rain and rivers
  // down, freezing up.
  const budget = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    if (land[i]) continue
    const fresh = seaRain[i] + riverIn[i] - T.salinityEvapMm * evaporation(seaTemperature[i])
    budget[i] = -fresh * T.salinityPsuPerMm
    if (seaTemperature[i] < T.ebmSeaIceBelowC) budget[i] += T.salinityBrinePsu
  }

  // Carried by the currents, relaxed toward the ocean's mean.
  let salinity = new Float32Array(n).fill(T.salinityMeanPsu)
  for (let iter = 0; iter < T.salinityIters; iter++) {
    const next = salinity.slice()
    for (let gy = 0; gy < RY; gy++) {
      for (let gx = 0; gx < RX; gx++) {
        const i = gy * RX + gx
        if (land[i]) continue
        const u = currents[i * 2]
        const v = currents[i * 2 + 1]
        const upstream = sampleBilinearGrid(salinity, RX, RY, gx - u * T.currentsAdvectStep, gy - v * T.currentsAdvectStep)
        next[i] = upstream * (1 - T.salinityRelax) + T.salinityMeanPsu * T.salinityRelax + budget[i]
      }
    }
    // Land keeps the mean, so a sample at the coast blends in a sane value.
    for (let i = 0; i < n; i++) if (land[i]) next[i] = T.salinityMeanPsu
    salinity = next
  }
  for (let i = 0; i < n; i++) salinity[i] = land[i] ? 0 : Math.max(T.salinityMinPsu, Math.min(T.salinityMaxPsu, salinity[i]))

  // Sinking: where the sea is near freezing and saltier than the rest of
  // its latitude, poleward of `deepWaterMinLatDeg`. Near freezing the salt
  // decides the density (the water barely expands with warmth there), so
  // the question is where the saltiest cold water is: fresh polar water
  // floats, the salty water the currents carry north sinks. A threshold on
  // an absolute density could not ask it: the first cut, with a fixed
  // expansion, sank every polar sea (Astrakan: 8300 cells), the second,
  // with the expansion shrinking toward freezing, none — the polar seas all
  // come out within a tenth of a psu of each other, as this model moves no
  // moisture between oceans. Full at `deepWaterFullAnomalyPsu` over the
  // latitude's mean, so a world with no salty polar sea gets a weak
  // overturning. The sea surface freezes at −1.8 °C, whatever the air does.
  const deepWater = new Float32Array(n)
  for (let gy = 0; gy < RY; gy++) {
    if (latitudeAt(gy, equatorOffset) * 90 < T.deepWaterMinLatDeg) continue
    let mean = 0
    let count = 0
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      if (land[i]) continue
      mean += salinity[i]
      count++
    }
    if (count === 0) continue
    mean /= count
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      if (land[i]) continue
      const surface = Math.max(T.seaFreezesC, seaTemperature[i])
      const cold = Math.min(1, Math.max(0, (T.deepWaterBelowC - surface) / (T.deepWaterBelowC - T.seaFreezesC)))
      const salty = Math.min(1, Math.max(0, (salinity[i] - mean) / T.deepWaterFullAnomalyPsu))
      deepWater[i] = cold * salty
    }
  }

  return { salinity, deepWater }
}

// A sea field onto the coasts beside it, thinning inland as the currents'
// own mark does (oceanCurrents.applyOceanSST): each land cell takes its
// strongest neighbour's value, decayed, over a few cells. The sea cells
// keep theirs; land cells start at 0.
export function spreadToCoasts(field: Float32Array, land: Uint8Array): Float32Array {
  const n = RX * RY
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) if (!land[i]) out[i] = field[i]
  for (let step = 0; step < CLIMATE_TUNING.currentsCoastalSteps; step++) {
    const next = out.slice()
    for (let gy = 0; gy < RY; gy++) {
      for (let gx = 0; gx < RX; gx++) {
        const i = gy * RX + gx
        if (!land[i]) continue
        let best = 0
        for (const [dx, dy] of NEIGHBOURS) {
          const v = out[wrapIndex(gx + dx, gy + dy)]
          if (Math.abs(v) > Math.abs(best)) best = v
        }
        next[i] = best * CLIMATE_TUNING.currentsCoastalDecay
      }
    }
    out.set(next)
  }
  return out
}
