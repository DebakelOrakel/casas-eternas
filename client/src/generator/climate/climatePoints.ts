import type { Domain } from '../core/domain'
import { SEA_LEVEL } from '../elevation/elevationScale'
import { CLIMATE_TUNING } from './climateTuneParams'
import { climateMesh, zonalMean, type ClimateMesh, type ClimateTerrain } from './climateMesh'
import { OCEAN_PRECIP } from './precipitation'
import { OCEAN_AMPLITUDE } from './seasonality'
import { annualFromMonths, refinedAnnualWind, type RefinedClimate } from './refinement'
import type { Weather } from './weather'

// THE CLIMATE AT A POINT (DEC-0036 phase 7, docs/decisions/fields-on-
// meshes.md): what every stage outside the climate reads of it — the
// biomes, the ecology, the hydrology, the hydrogeology, the ice, the coast,
// the column's ledger, the bakes — as values at its own points (the
// terrain mesh's nodes, a bake level's nodes, the climate mesh's own
// cells), sampled once from the climate's field mesh. No stage reads a
// climate raster.
//
// The climate as its readers need it, per cell of the climate's field mesh
// (`ClimateCells`, Float32 — the values the save holds, world/save/
// climateFields.ts, so a bake samples what the generator sampled): the
// air temperature REDUCED TO SEA LEVEL (the lapse of the ground under the
// cell's centre taken off, by the rule computeTemperature applied: a dry
// floor unclamped, everything else clamped at the sea), so a point takes
// its own lapse back and a summit's cold does not bleed into the valley
// beside it; the rain, the seasonal range and the signed monsoon index
// with their sea marks (OCEAN_PRECIP, OCEAN_AMPLITUDE, OCEAN_PRECIP) — the
// marks ARE the cells' land mask; the refinement's months, its upwelling
// and its rain's reliability when the climate is refined; the year's wind.
//
// At a point (`climateAtPoints`): the corners of the climate mesh's
// triangle under it, linearly. A land field reads the LAND corners only,
// their weights renormalised — never a blend with a sea mark — and a land
// point with no land corner (an island smaller than a cell) its latitude's
// land mean (climateMesh.zonalMean at the nearest cell), the island rule
// of the former climate grid. The monsoon index is blended as a magnitude
// (neighbours across the rain belt carry opposite signs, and their mean
// would read an even year where the wet-dry savanna lives); its sign, the
// rain's phase, is the heaviest land corner's. The sea fields (the
// upwelling, the sea's temperature) read the sea corners the same way.

export interface ClimateMonthCells {
  count: number
  // °C reduced to sea level and mm/yr at the month's rate (OCEAN_PRECIP on
  // the sea), months × cells, month-major.
  seaLevelTemperature: Float32Array
  precipitation: Float32Array
}

export interface ClimateCells {
  cm: ClimateMesh
  seaLevelTemperature: Float32Array
  precipitation: Float32Array
  seasonalAmplitude: Float32Array
  monsoonIndex: Float32Array
  months: ClimateMonthCells | null
  // The refinement's Ekman upwelling (0 on land) and its rain's year-to-year
  // coefficient of variation (0 on the sea); null for a climate that was
  // not refined.
  upwelling: Float32Array | null
  rainVariability: Float32Array | null
  // The year's wind, east and south in each cell's own frame (wind.ts's
  // units).
  windE: Float32Array
  windS: Float32Array
}

// The lapse a height carries, °C (computeTemperature's rule).
export function lapseAt(height: number, dry: boolean): number {
  return CLIMATE_TUNING.lapseCPerElevation * (dry ? height - SEA_LEVEL : Math.max(0, height - SEA_LEVEL))
}

// The static climate's (weather.computeWeather) cells.
export function climateCellsFromWeather(weather: Weather): ClimateCells {
  const { terrain, mesh } = weather
  const n = terrain.cm.mesh.count
  const seaLevelTemperature = new Float32Array(n)
  const precipitation = new Float32Array(n)
  const seasonalAmplitude = new Float32Array(n)
  const monsoonIndex = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    seaLevelTemperature[i] = mesh.temperature[i] + lapseAt(terrain.z[i], terrain.dry[i] === 1)
    const land = terrain.land[i] === 1 && mesh.seasonal.annual[i] !== OCEAN_PRECIP
    precipitation[i] = land ? mesh.seasonal.annual[i] : OCEAN_PRECIP
    seasonalAmplitude[i] = land ? mesh.seasonalAmplitude[i] : OCEAN_AMPLITUDE
    monsoonIndex[i] = land ? mesh.seasonal.index[i] : OCEAN_PRECIP
  }
  return {
    cm: terrain.cm, seaLevelTemperature, precipitation, seasonalAmplitude, monsoonIndex,
    months: null, upwelling: null, rainVariability: null,
    windE: Float32Array.from(mesh.wind.e), windS: Float32Array.from(mesh.wind.s),
  }
}

// The refinement's cells (refinement.refineClimate), on the terrain it was
// computed on: the annual fields from its months (annualFromMonths), the
// months themselves, its upwelling, its rain's reliability, its year's wind.
export function climateCellsFromRefined(r: RefinedClimate, terrain: ClimateTerrain): ClimateCells {
  const n = r.cells
  const annual = annualFromMonths(r, n)
  const lapse = new Float32Array(n)
  for (let i = 0; i < n; i++) lapse[i] = lapseAt(terrain.z[i], terrain.dry[i] === 1)
  const seaLevelTemperature = new Float32Array(n)
  for (let i = 0; i < n; i++) seaLevelTemperature[i] = annual.temperature[i] + lapse[i]
  const monthsT = new Float32Array(r.months * n)
  for (let m = 0; m < r.months; m++) for (let i = 0; i < n; i++) monthsT[m * n + i] = r.temperature[m * n + i] + lapse[i]
  const wind = refinedAnnualWind(r)
  return {
    cm: terrain.cm,
    seaLevelTemperature,
    precipitation: annual.precipitation,
    seasonalAmplitude: annual.seasonalAmplitude,
    monsoonIndex: annual.monsoonIndex,
    months: { count: r.months, seaLevelTemperature: monthsT, precipitation: r.precipitation },
    upwelling: r.upwelling,
    rainVariability: r.reliability.rainVariability,
    windE: Float32Array.from(wind.e),
    windS: Float32Array.from(wind.s),
  }
}

// The annual cells as values with the mesh they belong to — the save's
// form (world/save/climateFields.ts) and the bakes' input.
export interface ClimateCellValues {
  cells: number
  spacingM: number
  seaLevelTemperature: Float32Array
  precipitation: Float32Array
  seasonalAmplitude: Float32Array
  monsoonIndex: Float32Array
}

export function climateCellValues(cells: ClimateCells): ClimateCellValues {
  return {
    cells: cells.cm.mesh.count,
    spacingM: cells.cm.cellM,
    seaLevelTemperature: cells.seaLevelTemperature,
    precipitation: cells.precipitation,
    seasonalAmplitude: cells.seasonalAmplitude,
    monsoonIndex: cells.monsoonIndex,
  }
}

// The cells back from their values: the annual fields only, on the climate
// mesh of `domain` — refused when the values belong to another.
export function climateCellsFromSaved(domain: Domain, saved: ClimateCellValues): ClimateCells {
  const cm = climateMesh(domain)
  if (saved.cells !== cm.mesh.count || saved.spacingM !== cm.cellM) throw new Error(`the climate's values belong to a mesh of ${saved.cells} cells at ${saved.spacingM} m, this world's has ${cm.mesh.count} at ${cm.cellM} m`)
  const zero = new Float32Array(cm.mesh.count)
  return {
    cm, seaLevelTemperature: saved.seaLevelTemperature, precipitation: saved.precipitation, seasonalAmplitude: saved.seasonalAmplitude, monsoonIndex: saved.monsoonIndex,
    months: null, upwelling: null, rainVariability: null, windE: zero, windS: zero,
  }
}

// The mean rain over the land, mm/yr, by area: the reference the channel
// criterion multiplies against (hydrology.channelThreshold). Over the
// climate mesh's land cells — one figure for the generator, the level bake
// and the tile bake, which read the same cells.
export function meanLandRunoff(cells: ClimateCells): number {
  const { area } = cells.cm.mesh
  let sum = 0
  let total = 0
  for (let i = 0; i < cells.precipitation.length; i++) {
    const p = cells.precipitation[i]
    if (p === OCEAN_PRECIP) continue
    sum += Math.max(0, p) * area[i]
    total += area[i]
  }
  return total > 0 ? sum / total : 0
}

// Where a stage reads the climate: points of the domain with their height
// (elevation units), land (1, a dry floor included) or sea (0), dry floor
// (1: the lapse unclamped below the sea), and whether a slot is a point at
// all (a mesh's dead slots; null: every one).
export interface ClimatePoints {
  count: number
  x: ArrayLike<number>
  y: ArrayLike<number>
  height: ArrayLike<number>
  land: Uint8Array
  dry: Uint8Array | null
  alive: Uint8Array | null
}

// A terrain mesh's nodes as points: land where z stands above the sea or
// the node is a dry floor (`dry`, the hydrology's terminal basins).
export function meshPoints(mesh: { vx: Float64Array; vy: Float64Array; vAlive: Uint8Array; vertexSlots: number }, z: Float32Array, dry: Uint8Array | null = null): ClimatePoints {
  const n = mesh.vertexSlots
  const land = new Uint8Array(n)
  for (let v = 0; v < n; v++) if (mesh.vAlive[v] && (z[v] > SEA_LEVEL || (dry !== null && dry[v] === 1))) land[v] = 1
  return { count: n, x: mesh.vx, y: mesh.vy, height: z, land, dry, alive: mesh.vAlive }
}

export interface PointClimate {
  count: number
  // °C: reduced to sea level (land points; the sea's own on the sea), and at
  // the point's height (land: the sea-level value less its own lapse; sea:
  // the sea corners' temperature, the sea surface's).
  seaLevelTemperature: Float32Array
  temperature: Float32Array
  // The land fields, with their sea marks on sea points.
  precipitation: Float32Array
  seasonalAmplitude: Float32Array
  monsoonIndex: Float32Array
  // The months at the point's height (°C, mm/yr at the month's rate,
  // OCEAN_PRECIP on sea points; the sea's temperature on sea points),
  // months × points, month-major; null for a climate without months.
  months: { count: number; temperature: Float32Array; precipitation: Float32Array } | null
  upwelling: Float32Array | null
  rainVariability: Float32Array | null
  // The year's wind in the point's own frame; null unless asked for.
  windE: Float32Array | null
  windS: Float32Array | null
}

export function climateAtPoints(cells: ClimateCells, points: ClimatePoints, options: { wind?: boolean } = {}): PointClimate {
  const { cm } = cells
  const { sampler } = cm
  const n = points.count
  const nc = cm.mesh.count
  const isLandCell = (i: number): boolean => cells.precipitation[i] !== OCEAN_PRECIP
  const months = cells.months
  const out: PointClimate = {
    count: n,
    seaLevelTemperature: new Float32Array(n),
    temperature: new Float32Array(n),
    precipitation: new Float32Array(n),
    seasonalAmplitude: new Float32Array(n),
    monsoonIndex: new Float32Array(n),
    months: months ? { count: months.count, temperature: new Float32Array(months.count * n), precipitation: new Float32Array(months.count * n) } : null,
    upwelling: cells.upwelling ? new Float32Array(n) : null,
    rainVariability: cells.rainVariability ? new Float32Array(n) : null,
    windE: options.wind ? new Float32Array(n) : null,
    windS: options.wind ? new Float32Array(n) : null,
  }
  // The islands' climate, per cell (their latitude's land mean), made the
  // first time a land point finds no land corner.
  let islands: { precipitation: Float64Array; amplitude: Float64Array; season: Float64Array; sign: Float64Array; variability: Float64Array | null; months: Float64Array[] } | null = null
  const islandsOf = (): NonNullable<typeof islands> => {
    if (islands) return islands
    const season = new Float32Array(nc)
    for (let i = 0; i < nc; i++) season[i] = Math.abs(cells.monsoonIndex[i])
    islands = {
      precipitation: zonalMean(cm, cells.precipitation, isLandCell),
      amplitude: zonalMean(cm, cells.seasonalAmplitude, isLandCell),
      season: zonalMean(cm, season, isLandCell),
      sign: zonalMean(cm, cells.monsoonIndex, isLandCell),
      variability: cells.rainVariability ? zonalMean(cm, cells.rainVariability, isLandCell) : null,
      months: months ? Array.from({ length: months.count }, (_, m) => zonalMean(cm, months.precipitation.subarray(m * nc, (m + 1) * nc), isLandCell)) : [],
    }
    return islands
  }
  const corners = new Int32Array(3)
  const weights = new Float64Array(3)
  const wind = { x: 0, y: 0 }
  for (let p = 0; p < n; p++) {
    if (points.alive && !points.alive[p]) continue
    const x = points.x[p]
    const y = points.y[p]
    sampler.taps(x, y, corners, weights)
    const c0 = corners[0]
    const c1 = corners[1]
    const c2 = corners[2]
    const w0 = weights[0]
    const w1 = weights[1]
    const w2 = weights[2]
    if (out.windE && out.windS) {
      sampler.sampleVector(cells.windE, cells.windS, x, y, -1, wind)
      out.windE[p] = wind.x
      out.windS[p] = wind.y
    }
    const l0 = isLandCell(c0) ? w0 : 0
    const l1 = isLandCell(c1) ? w1 : 0
    const l2 = isLandCell(c2) ? w2 : 0
    const landW = l0 + l1 + l2
    const seaW = w0 + w1 + w2 - landW
    if (!points.land[p]) {
      // The sea: the sea corners' temperature (all corners where none is
      // sea), the land fields' marks, the sea's upwelling.
      const s0 = w0 - l0
      const s1 = w1 - l1
      const s2 = w2 - l2
      const t = cells.seaLevelTemperature
      const sst = seaW > 0 ? (s0 * t[c0] + s1 * t[c1] + s2 * t[c2]) / seaW : w0 * t[c0] + w1 * t[c1] + w2 * t[c2]
      out.seaLevelTemperature[p] = sst
      out.temperature[p] = sst
      out.precipitation[p] = OCEAN_PRECIP
      out.seasonalAmplitude[p] = OCEAN_AMPLITUDE
      out.monsoonIndex[p] = OCEAN_PRECIP
      if (out.upwelling && cells.upwelling) {
        const u = cells.upwelling
        out.upwelling[p] = seaW > 0 ? (s0 * u[c0] + s1 * u[c1] + s2 * u[c2]) / seaW : 0
      }
      if (out.months && months) {
        const mt = months.seaLevelTemperature
        for (let m = 0; m < months.count; m++) {
          const o = m * nc
          out.months.temperature[m * n + p] = seaW > 0 ? (s0 * mt[o + c0] + s1 * mt[o + c1] + s2 * mt[o + c2]) / seaW : w0 * mt[o + c0] + w1 * mt[o + c1] + w2 * mt[o + c2]
          out.months.precipitation[m * n + p] = OCEAN_PRECIP
        }
      }
      continue
    }
    // The land: the sea-level temperature over every corner, then the
    // point's own lapse; the land fields over the land corners.
    const t = cells.seaLevelTemperature
    const seaT = w0 * t[c0] + w1 * t[c1] + w2 * t[c2]
    const lapse = lapseAt(points.height[p], points.dry !== null && points.dry[p] === 1)
    out.seaLevelTemperature[p] = seaT
    out.temperature[p] = seaT - lapse
    const island = landW > 0 ? -1 : sampler.nearestCell(x, y)
    const land = (f: Float32Array, isl: (k: number) => number): number =>
      landW > 0 ? (l0 * f[c0] + l1 * f[c1] + l2 * f[c2]) / landW : isl(island)
    out.precipitation[p] = land(cells.precipitation, (k) => islandsOf().precipitation[k])
    out.seasonalAmplitude[p] = land(cells.seasonalAmplitude, (k) => islandsOf().amplitude[k])
    const idx = cells.monsoonIndex
    let season: number
    let negative: boolean
    if (landW > 0) {
      season = (l0 * Math.abs(idx[c0]) + l1 * Math.abs(idx[c1]) + l2 * Math.abs(idx[c2])) / landW
      // The heaviest land corner's sign.
      const heaviest = l0 >= l1 && l0 >= l2 ? c0 : l1 >= l2 ? c1 : c2
      negative = idx[heaviest] < 0
    } else {
      season = islandsOf().season[island]
      negative = islandsOf().sign[island] < 0
    }
    out.monsoonIndex[p] = negative ? -season : season
    if (out.rainVariability && cells.rainVariability) out.rainVariability[p] = land(cells.rainVariability, (k) => islandsOf().variability?.[k] ?? 0)
    if (out.months && months) {
      const mt = months.seaLevelTemperature
      const mp = months.precipitation
      for (let m = 0; m < months.count; m++) {
        const o = m * nc
        out.months.temperature[m * n + p] = w0 * mt[o + c0] + w1 * mt[o + c1] + w2 * mt[o + c2] - lapse
        out.months.precipitation[m * n + p] = landW > 0 ? (l0 * mp[o + c0] + l1 * mp[o + c1] + l2 * mp[o + c2]) / landW : islandsOf().months[m][island]
      }
    }
  }
  return out
}
