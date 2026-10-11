// The Ecology layer: turns the finished climate/topography into named resource /
// suitability fields (see docs/decisions/ecology.md). Follows hydrology in the
// pipeline; a function, not a simulation. The carrying-capacity aggregate is the
// saturating combination of the subsistence fields, run through the two
// top-level knobs (carrying capacity = level, concentration = spatial structure).
//
// A LOCAL RULE, evaluated per pixel of the world raster
// (docs/decisions/ecology-as-function.md): the coarse climate interpolated to
// the pixel (its temperature with the pixel's own lapse), the pixel's terrain,
// the water and the sea within a reach in metres, the tectonic features near
// it. Nothing here counts climate cells. The fields on the climate grid, which
// the save and the migration read, are the fine ones averaged over each cell's
// land.
//
// On both shapes (DEC-0035, fork 5; step 4f): a reach is a length — a row
// whose pixels are narrower (DomainGrid.rowScale, cos φ on the sphere)
// takes as many of its own as span it east-west, and the window steps
// across a pole as the grid does; a mean weighs a pixel by its area; a
// deposit's halo is a disc on the globe; the province and deposit noise is
// the globe's (Domain.noise); the fields' pole rows come out one value, the
// land's and the sea's apart. On the torus every weight is 1 and every step
// the old one: its bits are as they were.

import { CLIMATE_RES_X, CLIMATE_RES_Y, zonalLandMean } from '../climate/climateField'
import { CLIMATE_TUNING } from '../climate/climateTuneParams'
import { OCEAN_PRECIP } from '../climate/precipitation'
import { Biome, reduceTemperatureToSeaLevel } from '../climate/biomes'
import { clamp01, smoothstep } from '../core/interpolation'
import { globeFrame, type Domain, type DomainGrid } from '../core/domain'
import { SEA_LEVEL, metersToElevation } from '../elevation/elevationScale'
import { ECOLOGY_TUNING, PASTURE_BY_BIOME, TIMBER_BY_BIOME } from './ecologyTuneParams'
import type { Volcano } from '../tectonics/volcanoes'
import type { LandBiomeId } from './ecologyTuneParams'
import { detAsin, detExp, detHypot, detPow, detSin } from '../core/detMath'
import { globeOctave } from '../elevation/globeNoise'

// Ocean sentinel for the output fields (matches the climate fields' convention):
// a cell the ecology layer doesn't score (open water) reads -1.
export const ECOLOGY_OCEAN = -1

// The field ids the ecology step produces. Grows per sub-step; the worker sends
// every field, the screen's selector lists them (see ecologyColors' metadata).
//
// An array with the type derived from it, rather than a union with the names
// retyped wherever a list is needed. The save's field registry had the second
// copy, in the same order — and the order is the save's layer order, so the two
// had to agree without anything making them. Adding a field is one edit now.
export const ECOLOGY_FIELD_IDS = [
  'carryingCapacity',
  'arable', 'fish', 'game', 'pasture',
  'timber', 'salt', 'toolStone', 'copper', 'tin', 'iron',
  'gold', 'silver', 'gems',
] as const

export type EcologyFieldId = (typeof ECOLOGY_FIELD_IDS)[number]

// The fine fields travel to the screen as one byte per pixel: a value v
// (0..3, the save's range) as round(v / ECOLOGY_FINE_STEP), the sea as
// ECOLOGY_FINE_OCEAN. Fourteen fields at 2048×1024 are 29 MB so, 117 MB as
// floats.
export const ECOLOGY_FINE_OCEAN = 255
export const ECOLOGY_FINE_STEP = 3 / 254
export function encodeFineField(field: Float32Array): Uint8Array {
  const out = new Uint8Array(field.length)
  for (let i = 0; i < field.length; i++) out[i] = field[i] === ECOLOGY_OCEAN ? ECOLOGY_FINE_OCEAN : Math.min(254, Math.max(0, Math.round(field[i] / ECOLOGY_FINE_STEP)))
  return out
}
export const decodeFineValue = (code: number): number => (code === ECOLOGY_FINE_OCEAN ? ECOLOGY_OCEAN : code * ECOLOGY_FINE_STEP)

export interface EcologyParams {
  // Global carrying-capacity gain (%). 100 = neutral; scales the LEVEL only.
  carryingCapacity: number
  // Spatial structure, -100..100. 0 = physics as-is; +ve clumps, -ve evens.
  // Mean-preserving (shape only). See ecology.md Theme 1 (L1).
  concentration: number
  // L2 "province" strength (volcanic-soil fertility + light noise), 0..1. Mean-1
  // multiplicative. Fold-out knob (0 = off). Required: its default is the
  // input declaration's (ecologyInputParams.provinceStrength), which this
  // module does not read — a default here would be a second copy of it.
  provinceStrength: number
  // Per-field abundance multipliers (fold-out nudges), default 1. Applied to the
  // field itself; for subsistence + salt it also scales their carrying-capacity
  // contribution. Metals share one "ore richness" knob (set on copper/tin/iron).
  weights?: Partial<Record<EcologyFieldId, number>>
  // Tin rarity 0..1 (higher = rarer / more clustered) — shrinks the tin radius.
  tinRarity?: number
}

export interface EcologyFields {
  // The fields on the climate grid (the fine ones averaged over each cell's
  // land): what the save and the migration read.
  resX: number
  resY: number
  fields: Record<EcologyFieldId, Float32Array>
  // The fields per pixel of the world raster: what the map shows.
  fine: { resX: number; resY: number; fields: Record<EcologyFieldId, Float32Array> }
}

// Everything the ecology step reads. Climate fields are on the coarse grid;
// elevation/discharge/lakeDepth are full-res (one pixel per unit of `domain`). Hydrology
// (discharge/lakeDepth) is optional — without it, fish gets its marine component
// only (freshwater needs rivers/lakes).
export interface EcologyInputs {
  temperature: Float32Array // climate grid, °C (SST-adjusted on ocean)
  precipitation: Float32Array // climate grid, mm/yr (OCEAN_PRECIP on water = land mask)
  biomes: Uint8Array // climate grid
  // The map's biomes on the world raster (the riparian ones), or null (no
  // hydrology yet): timber, grazing and game's edges then read the coarse
  // `biomes`, each pixel its cell's.
  biomesFine: Uint8Array | null
  // The climate step's upwelling (refinement.ts, the cold-water part), climate
  // grid, 0 on land; null for a climate that was not refined (the
  // history's), where the fish lose that term.
  upwelling: Float32Array | null
  // The climate step's months (refinement.ts): temperature °C and rain at
  // the month's rate, mm/yr, month-major on the climate grid; and the rain's
  // year-to-year spread (reliability.ts, a coefficient of variation per land
  // cell). Both null for a climate that was not refined: arable then reads
  // the annual means and takes no risk.
  months: { temperature: Float32Array; precipitation: Float32Array; count: number } | null
  rainVariability: Float32Array | null
  elevation: Float32Array // full-res
  discharge: Float32Array | null // full-res river discharge, or null (no hydrology yet)
  maxDischarge: number // reference max discharge over land
  lakeDepth: Float32Array | null // full-res lake depth, or null
  // Full-res: 1 on a terminal basin's dry floor (hydrology's salt flat), or
  // null (no hydrology yet).
  saltFlat: Uint8Array | null
  // Full-res: 1 on every dry floor of a terminal basin, salt flats included
  // (hydrology's dryBasin), or null. Land, though at or below sea level.
  dryBasin: Uint8Array | null
  // Full-res: the water table's depth below the surface, metres, −1 under
  // water (hydrology's hydrogeology), or null. And its oases: the springs
  // in an arid climate, world px.
  waterTable: Float32Array | null
  oases: { x: number; y: number }[]
  volcanoes: Volcano[]
  // Collision-belt points — tin / lode-gold / gem provenance. Combines the
  // CURRENT fold-mountain features (on-crust, always where collision ranges are)
  // with the accumulated (advected) sutures for deep-time belts. Empty if the
  // world has had no continental collisions.
  orogenPoints: { x: number; y: number }[]
  // Coarse (climate grid) continental-crust oldness 0..1 (1 = ancient craton
  // core), -1 over ocean — see rafts.computeCratonOldnessField. Feeds iron.
  cratonAge: Float32Array
  warpSeed: number
  // What the full-res rasters cover, one pixel per unit.
  domain: Domain
}

// --- shared helpers ---------------------------------------------------------

// Terrestrial net primary productivity, Miami-model style (0..1): limited by
// whichever of temperature and precipitation is scarcer (Liebig's law of the
// minimum). The ecological backbone of both arable land and wild game.
function productivity(tempC: number, precipMm: number): number {
  const nppTemp = 1 / (1 + detExp(1.315 - 0.119 * tempC))
  const nppPrecip = 1 - detExp(-0.000664 * Math.max(0, precipMm))
  return Math.min(nppTemp, nppPrecip)
}

// How well a sea at this temperature (°C) mixes its nutrients up, 0..1: in
// full from `fishMixFullC` down to `fishMixIceC` (cool seas turn over in
// winter), gone at `fishMixWarmC` (a warm sea stays layered) and below the
// sea ice.
function seaMixing(tempC: number): number {
  const T = ECOLOGY_TUNING
  if (tempC < T.fishMixIceC) return clamp01(1 - (T.fishMixIceC - tempC) / T.fishMixIceSpanC)
  return clamp01((T.fishMixWarmC - tempC) / (T.fishMixWarmC - T.fishMixFullC))
}

// A reach in metres as a radius in pixels (at least one).
const reachPx = (metres: number, metresPerPx: number): number => Math.max(1, Math.round(metres / metresPerPx))

// A reach of `r` equator pixels in row y's own pixels: as many as span the
// length east-west (1 / rowScale of it), up to the whole row but one — a
// row near a pole is a small circle the reach spans many times. `r` on the
// torus.
const rowReach = (grid: DomainGrid, y: number, r: number): number => Math.min((grid.resX - 1) >> 1, Math.round(r / grid.rowScale(y)))

// The rows a window reaches north and south, for the hot loops: for every
// row y in [-margin, resY + margin), at [y + margin], the start index of
// the row it lands on and the column shift that goes with it — resX / 2
// beyond a pole of the sphere (the far meridian), 0 on the torus, where
// `start` is DomainGrid.rowTable. (The sphere's rowTable refuses a margin:
// it cannot say the shift.)
interface RowSteps {
  start: Int32Array
  shift: Int32Array
}
function rowSteps(grid: DomainGrid, margin: number): RowSteps {
  const { resX: w, resY: h } = grid
  const start = new Int32Array(h + 2 * margin)
  const shift = new Int32Array(h + 2 * margin)
  for (let k = 0; k < start.length; k++) {
    const i = grid.index(0, k - margin)
    const c = i % w
    start[k] = i - c
    shift[k] = c
  }
  return { start, shift }
}
// The cell of column x in the row at [k] of `steps`.
function stepCell(steps: RowSteps, k: number, x: number, w: number): number {
  const s = steps.shift[k]
  if (s === 0) return steps.start[k] + x
  return steps.start[k] + (x + s < w ? x + s : x + s - w)
}

// The largest value within `r` pixels (a square of 2r + 1 equator pixels,
// wrapped by the grid): "is there water / a rich sea within reach". Two
// passes, rows (each its own reach, rowReach) then columns (across a pole
// as the grid steps); the wrapped taps from the tables.
function maxWithin(src: Float32Array, grid: DomainGrid, r: number): Float32Array {
  const { resX: w, resY: h } = grid
  const reach = new Int32Array(h)
  let widest = 0
  for (let y = 0; y < h; y++) widest = Math.max(widest, (reach[y] = rowReach(grid, y, r)))
  const cols = grid.colTable(widest)
  const steps = rowSteps(grid, r)
  const rows = new Float32Array(src.length)
  for (let y = 0; y < h; y++) {
    const row = y * w
    const rr = reach[y]
    for (let x = 0; x < w; x++) {
      let m = src[row + x]
      for (let d = 1; d <= rr; d++) {
        const a = src[row + cols[x - d + widest]]
        const b = src[row + cols[x + d + widest]]
        if (a > m) m = a
        if (b > m) m = b
      }
      rows[row + x] = m
    }
  }
  const out = new Float32Array(src.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = rows[y * w + x]
      for (let d = 1; d <= r; d++) {
        const a = rows[stepCell(steps, y - d + r, x, w)]
        const b = rows[stepCell(steps, y + d + r, x, w)]
        if (a > m) m = a
        if (b > m) m = b
      }
      out[y * w + x] = m
    }
  }
  return out
}

// The mean within `r` pixels (a square of 2r + 1 equator pixels, wrapped by
// the grid): "how much of the land around is sea". Running sums, rows then
// columns, as maxWithin's windows. The column pass weighs each row's mean
// by the length its window covers, (2 rr + 1) · rowScale against 2r + 1:
// the window's rows are then its area's — 1 for every row but those whose
// whole circle is shorter than the reach (near a pole), and 1 on the torus,
// where the sums are the plain ones.
function meanWithin(src: Float32Array, grid: DomainGrid, r: number): Float32Array {
  const { resX: w, resY: h } = grid
  const reach = new Int32Array(h)
  const weight = new Float64Array(h)
  let widest = 0
  for (let y = 0; y < h; y++) {
    widest = Math.max(widest, (reach[y] = rowReach(grid, y, r)))
    weight[y] = ((2 * reach[y] + 1) * grid.rowScale(y)) / (2 * r + 1)
  }
  const m = widest + 1
  const cols = grid.colTable(m)
  const steps = rowSteps(grid, r + 1)
  const rows = new Float32Array(src.length)
  for (let y = 0; y < h; y++) {
    const row = y * w
    const rr = reach[y]
    const span = 2 * rr + 1
    let sum = 0
    for (let d = -rr; d <= rr; d++) sum += src[row + cols[d + m]]
    for (let x = 0; x < w; x++) {
      rows[row + x] = sum / span
      sum += src[row + cols[x + rr + 1 + m]] - src[row + cols[x - rr + m]]
    }
  }
  // The weight of the row at [k] of `steps` (the row it lands on).
  const weightAt = new Float64Array(steps.start.length)
  for (let k = 0; k < weightAt.length; k++) weightAt[k] = weight[steps.start[k] / w]
  const m2 = r + 1
  const out = new Float32Array(src.length)
  for (let x = 0; x < w; x++) {
    let sum = 0
    let total = 0
    for (let d = -r; d <= r; d++) {
      sum += rows[stepCell(steps, d + m2, x, w)] * weightAt[d + m2]
      total += weightAt[d + m2]
    }
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / total
      const kIn = y + r + 1 + m2
      const kOut = y - r + m2
      sum += rows[stepCell(steps, kIn, x, w)] * weightAt[kIn] - rows[stepCell(steps, kOut, x, w)] * weightAt[kOut]
      total += weightAt[kIn] - weightAt[kOut]
    }
  }
  return out
}

// A bilinear read of a climate-grid field at a world pixel's centre, over the
// corners `use` accepts only (the weights of the rest dropped and the others
// renormalised; with none, the mean of the accepted cells of the pixel's
// climate row — an island's climate, climateField.zonalLandMean). A land
// field's sea corners carry a sentinel, and a sea field's land corners the
// wrong thing.
// The corners and weights are set once per pixel (setPixel) and read for
// every field and month (read).
class ClimatePixel {
  // The climate grid over the pixels' domain.
  private readonly climate: DomainGrid
  private readonly idx = new Int32Array(4)
  private readonly wt = new Float64Array(4)
  private cell = 0
  // Row means per field, mask and month, made the first time a pixel needs
  // one.
  private readonly rowMeans = new Map<Float32Array, Map<Uint8Array, Map<number, Float32Array>>>()
  constructor(climate: DomainGrid) {
    this.climate = climate
  }
  setPixel(wx: number, wy: number): void {
    const { climate } = this
    const worldW = climate.domain.width
    const worldH = climate.domain.height
    const gx = ((wx + 0.5) / worldW) * CLIMATE_RES_X - 0.5
    const gy = ((wy + 0.5) / worldH) * CLIMATE_RES_Y - 0.5
    const x0 = Math.floor(gx)
    const y0 = Math.floor(gy)
    const fx = gx - x0
    const fy = gy - y0
    // The corners through the grid: across a pole the row beyond lies on
    // the far meridian (the torus: the wrapped row and column).
    this.idx[0] = climate.index(x0, y0)
    this.idx[1] = climate.index(x0 + 1, y0)
    this.idx[2] = climate.index(x0, y0 + 1)
    this.idx[3] = climate.index(x0 + 1, y0 + 1)
    this.wt[0] = (1 - fx) * (1 - fy)
    this.wt[1] = fx * (1 - fy)
    this.wt[2] = (1 - fx) * fy
    this.wt[3] = fx * fy
    this.cell = Math.min(CLIMATE_RES_Y - 1, Math.floor((wy / worldH) * CLIMATE_RES_Y)) * CLIMATE_RES_X + Math.min(CLIMATE_RES_X - 1, Math.floor((wx / worldW) * CLIMATE_RES_X))
  }
  // `offset` picks a month in a month-major field; `mask[i]` 1 marks the
  // corners to use (null: all).
  read(field: Float32Array, mask: Uint8Array | null, offset = 0): number {
    let sum = 0
    let weight = 0
    for (let k = 0; k < 4; k++) {
      const i = this.idx[k]
      if (mask && !mask[i]) continue
      sum += field[offset + i] * this.wt[k]
      weight += this.wt[k]
    }
    if (weight > 0) return sum / weight
    if (!mask) return field[offset + this.cell]
    let byMask = this.rowMeans.get(field)
    if (!byMask) this.rowMeans.set(field, (byMask = new Map()))
    let byOffset = byMask.get(mask)
    if (!byOffset) byMask.set(mask, (byOffset = new Map()))
    let means = byOffset.get(offset)
    if (!means) byOffset.set(offset, (means = zonalLandMean(field, (i) => mask[i] === 1, offset, (gy) => this.climate.cellArea(gy))))
    return means[Math.floor(this.cell / CLIMATE_RES_X)]
  }
  get coarseCell(): number {
    return this.cell
  }
}

// --- the fields ---------------------------------------------------------------

// The physics of the ecology, every field before the step's sliders: the
// expensive part (some 2 s at 2048×1024), which depends on the world alone.
// The worker keeps it while only the sliders move (applyEcology).
export interface EcologyBase {
  w: number
  h: number
  // The full-res raster's grid (w × h) and the climate grid, over one domain.
  grid: DomainGrid
  climate: DomainGrid
  land: Uint8Array
  // 1 where `land` is 0: the fish's sea, whose pole rows are averaged apart.
  sea: Uint8Array
  coarseLand: Uint8Array
  raw: Record<Exclude<EcologyFieldId, 'carryingCapacity' | 'tin' | 'gems'>, Float32Array>
  // Gems' two parts (the copper they weather from is scaled by the slider).
  gemBelt: Float32Array
  aridity: Float32Array
  // Tin's belt points, thinned (its radius is a slider: tinRarity).
  tinPoints: { x: number; y: number }[]
  // The province layer's deviation per land pixel (volcanic soil + noise),
  // before its mean is taken off.
  provinceDeviation: Float32Array
  // What a month's fields need (ecologyMonth); null for a climate without
  // months (not refined).
  seasonal: EcologySeasons | null
}

// The fields that change over the year, and what their months are made of:
// per pixel the parts that do not change with the month, and the climate's
// months to read the rest from.
export const SEASONAL_ECOLOGY_FIELDS = ['arable', 'fish', 'game', 'pasture', 'salt'] as const satisfies readonly EcologyFieldId[]
export type SeasonalEcologyFieldId = (typeof SEASONAL_ECOLOGY_FIELDS)[number]
export const isSeasonalEcologyField = (id: EcologyFieldId): id is SeasonalEcologyFieldId => (SEASONAL_ECOLOGY_FIELDS as readonly string[]).includes(id)

interface EcologySeasons {
  elevation: Float32Array
  months: NonNullable<EcologyInputs['months']>
  seaLevelMonths: Float32Array
  coarseLand: Uint8Array
  coarseSea: Uint8Array
  // Arable: flatness × the harvest's reliability, and the water on the fields.
  arableFactor: Float32Array
  fieldWater: Float32Array
  // Game: the edge bonus; pasture: the year's grazing and the year's mean
  // productivity it is set against.
  edgeFactor: Float32Array
  pastureYear: Float32Array
  nppYear: Float32Array
  // Salt: the coast's weight and the salt flats.
  saltCoast: Float32Array
  saltFlat: Uint8Array | null
  // Fish: a sea pixel's richness without its winter mixing, the land's
  // reach to the sea and its fresh water.
  seaRichStatic: Float32Array
  access: Float32Array
  freshwater: Float32Array
  coastR: number
}

export function computeEcology(inputs: EcologyInputs, params: EcologyParams): EcologyFields {
  return applyEcology(prepareEcology(inputs), params)
}

export function prepareEcology(inputs: EcologyInputs): EcologyBase {
  const { temperature, precipitation, biomes, biomesFine, upwelling, months, rainVariability, elevation, discharge, maxDischarge, lakeDepth, saltFlat, dryBasin, waterTable, oases, volcanoes, orogenPoints, cratonAge, warpSeed, domain } = inputs
  const { width: w, height: h } = domain
  const grid = domain.grid(w, h)
  const climate = domain.grid(CLIMATE_RES_X, CLIMATE_RES_Y)
  // A pixel's four neighbours, wrapped (colTable(1), and the rows across
  // a pole: rowSteps(1)).
  const cols1 = grid.colTable(1)
  const rows1 = rowSteps(grid, 1)
  const T = ECOLOGY_TUNING
  const n = w * h
  const nc = CLIMATE_RES_X * CLIMATE_RES_Y
  // Metres per pixel: the world is the shape's metresAround wide whatever
  // raster it is sampled on (at the equator on the sphere).
  const mPerPx = domain.metresAround / w
  // The slope's scale: flatness was measured on the rise across a climate
  // cell, and a pixel's rise is read against the same length.
  const pxPerCell = w / CLIMATE_RES_X

  const land = new Uint8Array(n)
  const sea = new Float32Array(n)
  // A terminal basin's dry floor is land below sea level: counted as sea,
  // every salt flat read as ocean and the salt-flat term never applied
  // (2026-10-01) — the hydrology only finds basins at or below the sea.
  for (let i = 0; i < n; i++) {
    if (elevation[i] > SEA_LEVEL || (dryBasin !== null && dryBasin[i] === 1)) land[i] = 1
    else sea[i] = 1
  }
  const coarseLand = new Uint8Array(nc)
  const coarseSea = new Uint8Array(nc)
  for (let i = 0; i < nc; i++) {
    if (precipitation[i] !== OCEAN_PRECIP) coarseLand[i] = 1
    else coarseSea[i] = 1
  }

  // The climate reduced to sea level per cell (the lapse of the cell's own
  // mean height taken off), so each pixel can take its own lapse back.
  const monthCount = months ? months.count : 1
  const seaLevelMonths = new Float32Array(monthCount * nc)
  for (let m = 0; m < monthCount; m++) {
    const air = months ? months.temperature.subarray(m * nc, (m + 1) * nc) : temperature
    seaLevelMonths.set(reduceTemperatureToSeaLevel(air, elevation, w, h), m * nc)
  }
  const monthRain = months ? months.precipitation : precipitation
  const seaLevelYear = reduceTemperatureToSeaLevel(temperature, elevation, w, h)
  const lapse = CLIMATE_TUNING.lapseCPerElevation

  // Every pixel's biome: the fine one, or its climate cell's.
  const biomeAt = new Uint8Array(n)
  for (let y = 0; y < h; y++) {
    const gy = Math.min(CLIMATE_RES_Y - 1, Math.floor((y / h) * CLIMATE_RES_Y))
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!land[i]) { biomeAt[i] = Biome.Ocean; continue }
      biomeAt[i] = biomesFine ? biomesFine[i] : biomes[gy * CLIMATE_RES_X + Math.min(CLIMATE_RES_X - 1, Math.floor((x / w) * CLIMATE_RES_X))]
    }
  }

  // --- water and sea within reach -------------------------------------------
  const px = new ClimatePixel(climate)
  const coastR = reachPx(T.coastReachM, mPerPx)
  const waterR = reachPx(T.waterReachM, mPerPx)

  // The sea's richness per sea pixel: a base, the share of shelf sea
  // within reach, the upwelling and the winter mixing (see the fish
  // constants).
  const shelfFloor = SEA_LEVEL - metersToElevation(T.fishShelfDepthM)
  const shallow = new Float32Array(n)
  for (let i = 0; i < n; i++) if (!land[i] && elevation[i] > shelfFloor) shallow[i] = 1
  const shelfShare = meanWithin(shallow, grid, coastR)
  const seaRich = new Float32Array(n)
  const seaRichStatic = new Float32Array(n)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (land[i]) continue
      px.setPixel(x, y)
      const rising = upwelling ? clamp01(px.read(upwelling, coarseSea) / T.fishUpwellingFull) : 0
      const cool = seaMixing(px.read(temperature, coarseSea))
      seaRichStatic[i] = T.fishSeaBase + T.fishShelfW * shelfShare[i] + T.fishUpwellingW * rising
      seaRich[i] = seaRichStatic[i] + T.fishMixingW * cool
    }
  }
  const richSeaNear = maxWithin(seaRich, grid, coastR)
  const seaShare = meanWithin(sea, grid, coastR)

  // A big river's water per land pixel (√ of the discharge against the
  // world's largest, doubled, capped), and what lies within reach of it.
  const hasHydrology = !!discharge && maxDischarge > 0
  const river = new Float32Array(n)
  const riverRoot = new Float32Array(n)
  const riverWet = new Float32Array(n)
  const lake = new Float32Array(n)
  if (discharge && maxDischarge > 0) {
    for (let i = 0; i < n; i++) {
      if (!land[i]) continue
      const share = Math.max(0, discharge[i]) / maxDischarge
      riverRoot[i] = Math.sqrt(share)
      // Below `riverFloor` (√ of the share) a stream is no fishing water
      // and waters no field: every pixel has some discharge.
      river[i] = Math.min(1, Math.max(0, riverRoot[i] - T.riverFloor) * 2)
      riverWet[i] = Math.min(1, share * 4)
    }
  }
  if (lakeDepth) for (let i = 0; i < n; i++) if (lakeDepth[i] > 0) lake[i] = 1
  const riverNear = maxWithin(river, grid, waterR)
  // Placer gold lies in a river's gravels and terraces, wider than its bed.
  const riverRootNear = maxWithin(riverRoot, grid, reachPx(T.placerReachM, mPerPx))
  const riverWetNear = maxWithin(riverWet, grid, waterR)
  const lakeNear = maxWithin(lake, grid, waterR)
  // A hand-dug well within a herd's reach.
  let wellNear: Float32Array | null = null
  if (waterTable) {
    const shallow = new Float32Array(n)
    for (let i = 0; i < n; i++) if (waterTable[i] >= 0 && waterTable[i] <= T.wellDepthM) shallow[i] = 1
    wellNear = maxWithin(shallow, grid, waterR)
  }
  // Waterlogged ground: the water table within `wetlandTableM` of the
  // surface (bog iron forms where ground water seeps out).
  const waterlogged = new Float32Array(n)
  if (waterTable) for (let i = 0; i < n; i++) if (waterTable[i] >= 0 && waterTable[i] <= T.wetlandTableM) waterlogged[i] = 1
  // The oases' gardens.
  const oasis = new Float32Array(n)
  for (const o of oases) {
    const cx = Math.floor(o.x)
    const cy = Math.floor(o.y)
    for (let dy = -waterR; dy <= waterR; dy++) {
      const rr = rowReach(grid, cy + dy, waterR)
      for (let dx = -rr; dx <= rr; dx++) oasis[grid.neighbour(cx, cy, dx, dy)] = 1
    }
  }

  // How much of the land around differs in biome (game's edges): per pixel
  // the share of its four neighbours of another biome, averaged within reach.
  // A boundary's length per area: the face to an east or west neighbour is
  // a pixel high and the pixel rowScale wide, so it counts 1 / rowScale (1
  // on the torus).
  const differs = new Float32Array(n)
  for (let y = 0; y < h; y++) {
    const across = 1 / grid.rowScale(y)
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!land[i]) continue
      const b = biomeAt[i]
      let d = 0
      if (biomeAt[y * w + cols1[x + 2]] !== b) d += across
      if (biomeAt[y * w + cols1[x]] !== b) d += across
      if (biomeAt[stepCell(rows1, y + 2, x, w)] !== b) d++
      if (biomeAt[stepCell(rows1, y, x, w)] !== b) d++
      differs[i] = d / 4
    }
  }
  const edges = meanWithin(differs, grid, reachPx(T.ecotoneReachM, mPerPx))

  // --- per pixel -------------------------------------------------------------
  const arable = new Float32Array(n)
  const fish = new Float32Array(n)
  const game = new Float32Array(n)
  const pasture = new Float32Array(n)
  const salt = new Float32Array(n)
  const timber = new Float32Array(n)
  const flatness = new Float32Array(n)
  const wetland = new Float32Array(n)
  const aridity = new Float32Array(n)
  const craton = new Float32Array(n)
  const cratonMask = new Uint8Array(nc)
  for (let i = 0; i < nc; i++) cratonMask[i] = cratonAge[i] >= 0 ? 1 : 0
  const variabilityMask = coarseLand
  const aridWarm = (tempC: number, precipMm: number): number => clamp01(1 - precipMm / T.saltAridPrecip) * clamp01(tempC / 25)
  const keep = months ? {
    arableFactor: new Float32Array(n), fieldWater: new Float32Array(n), edgeFactor: new Float32Array(n),
    nppYear: new Float32Array(n), saltCoast: new Float32Array(n), access: new Float32Array(n), freshwater: new Float32Array(n),
  } : null
  for (let y = 0; y < h; y++) {
    // The east-west neighbours are rowScale apart (1 on the torus).
    const across = grid.rowScale(y)
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!land[i]) continue
      px.setPixel(x, y)
      const height = Math.max(0, elevation[i] - SEA_LEVEL)

      // The pixel's slope, as a rise across a climate cell's length.
      const e = elevation
      const dx = (e[y * w + cols1[x + 2]] - e[y * w + cols1[x]]) / across
      const dy = e[stepCell(rows1, y + 2, x, w)] - e[stepCell(rows1, y, x, w)]
      const flat = 1 / (1 + T.slopeK * detHypot(dx, dy) * 0.5 * pxPerCell)
      flatness[i] = flat

      // The fields' water.
      const fieldWater = Math.max(riverNear[i], T.oasisW * oasis[i])
      const herdWater = hasHydrology || wellNear ? Math.max(riverNear[i], wellNear ? T.wellW * wellNear[i] : 0) : 1

      // The months: arable's growing year, game's productivity, salt's dry
      // warm season.
      let growing = 0
      let npp = 0
      let arid = 0
      for (let m = 0; m < monthCount; m++) {
        const t = px.read(seaLevelMonths, null, m * nc) - lapse * height
        const p = px.read(monthRain, coarseLand, months ? m * nc : 0)
        if (t >= T.arableFrostC || !months) growing += productivity(t, p + T.arableIrrigationMm * fieldWater) / monthCount
        npp += productivity(t, p) / monthCount
        arid += aridWarm(t, p) / monthCount
      }
      const yearT = px.read(seaLevelYear, null) - lapse * height
      const yearP = px.read(precipitation, coarseLand)

      // Arable (see the constants): the growing year × flatness × the
      // harvest's reliability, which a watered field does not need.
      const risk = rainVariability ? T.arableRiskW * px.read(rainVariability, variabilityMask) * (1 - fieldWater) : 0
      arable[i] = growing * flat * Math.max(0, 1 - risk)
      const edgeFactor = 1 + T.ecotoneBonus * clamp01(edges[i] / T.ecotoneFullShare)
      const saltCoast = T.saltInteriorW + (T.saltCoastW - T.saltInteriorW) * Math.min(1, seaShare[i] / T.fishFullSeaShare)

      // Fish: the richest sea within reach, as far as the sea is at hand
      // (a straight coast in full), plus the rivers and lakes near.
      const access = Math.min(1, seaShare[i] / T.fishFullSeaShare)
      const freshwater = Math.min(1, T.fishRiverW * riverNear[i] + T.fishLakeW * lakeNear[i])
      fish[i] = 1 - detExp(-(access * richSeaNear[i] + freshwater))

      // Game: productivity, more where biomes meet.
      game[i] = npp * edgeFactor

      // Pasture: the biome's grazing, in dry land only as far as a herd
      // finds water (without hydrology nothing is known of it: the biome
      // decides).
      const b = biomeAt[i] as LandBiomeId
      const dry = hasHydrology || wellNear ? clamp01((T.pastureDryMm - yearP) / (T.pastureDryMm - T.pastureDryFullMm)) : 0
      pasture[i] = (PASTURE_BY_BIOME[b] ?? 0.1) * (1 - dry * (1 - herdWater))
      timber[i] = TIMBER_BY_BIOME[b] ?? 0.05

      // Salt: a salt flat in full; else the dry warm season, strongest on
      // a coast.
      const flatSalt = saltFlat && saltFlat[i] ? T.saltFlatW : 0
      salt[i] = clamp01(Math.max(flatSalt, arid * saltCoast))
      if (keep) {
        keep.arableFactor[i] = flat * Math.max(0, 1 - risk)
        keep.fieldWater[i] = fieldWater
        keep.edgeFactor[i] = edgeFactor
        keep.nppYear[i] = npp
        keep.saltCoast[i] = saltCoast
        keep.access[i] = access
        keep.freshwater[i] = freshwater
      }

      // Wetland (bog iron): flat, wet, water-fed lowland.
      const water = lakeNear[i] > 0 ? 1 : Math.max(riverWetNear[i], T.wetlandTableW * waterlogged[i])
      wetland[i] = flat * water * clamp01(yearP / 600)
      aridity[i] = aridWarm(yearT, yearP)
      craton[i] = Math.max(0, px.read(cratonAge, cratonMask))
    }
  }

  // The fishing grounds: on the sea the fish field is the sea's own
  // richness, what a boat finds there.
  for (let i = 0; i < n; i++) if (!land[i]) fish[i] = 1 - detExp(-seaRich[i])

  // Material and prestige before the sliders. Copper = arc volcanoes; tin =
  // orogen belts (its radius a slider); iron = old cratons + bog iron.
  const arcVolcanoes = volcanoes.filter((v) => v.kind === 'arc')
  const obsidian = rasterisePointField(thinPoints(volcanoes, T.obsidianKeep, warpSeed ^ 0x0b51d1a2), T.obsidianRadiusFrac, grid)
  const toolStone = new Float32Array(n)
  for (let i = 0; i < n; i++) if (land[i]) toolStone[i] = Math.max(obsidian[i], T.flintBase * flatness[i])
  const copper = maskToLand(rasterisePointField(thinPoints(arcVolcanoes, T.copperKeep, warpSeed ^ 0xc0bbe401), T.copperRadiusFrac, grid), land)
  // Iron: the old-craton signal broken into deposits by a seeded noise (so it
  // fluctuates instead of reading as a flat 100%), plus bog iron in wetlands.
  const iron = new Float32Array(n)
  const ironSeed = (warpSeed ^ 0x51ed2701) | 0
  const ironNoise = noiseSampler(domain, T.ironDepositFreqX, T.ironDepositFreqY, ironSeed)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!land[i]) continue
      const noise01 = (ironNoise(x, y) + 1) / 2
      const deposit = T.ironDepositFloor + (1 - T.ironDepositFloor) * noise01
      iron[i] = clamp01(Math.max(T.ironCratonW * craton[i] * deposit, T.ironBogW * wetland[i]))
    }
  }
  // Prestige (separate channel — no carrying-capacity contribution). Gold:
  // placer (carried down rivers) + lode at orogenic belts. Silver:
  // hydrothermal, near volcanic arcs. Gems: metamorphic/orogenic belts + arid
  // weathering (turquoise near copper, in applyEcology).
  const lode = rasterisePointField(thinPoints(orogenPoints, T.goldLodeKeep, warpSeed ^ 0x601dfeed), T.goldLodeRadiusFrac, grid)
  const arc = rasterisePointField(thinPoints(arcVolcanoes, T.silverKeep, warpSeed ^ 0x5117e201), T.silverRadiusFrac, grid)
  const gemBelt = rasterisePointField(thinPoints(orogenPoints, T.gemKeep, warpSeed ^ 0x9e35c0de), T.gemRadiusFrac, grid)
  const gold = new Float32Array(n)
  const silver = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue
    const placer = Math.min(1, Math.max(0, riverRootNear[i] - T.goldPlacerSqrtFloor) * T.goldPlacerGain)
    gold[i] = clamp01(T.goldPlacerW * placer + T.goldLodeW * lode[i])
    silver[i] = clamp01(T.silverW * arc[i])
  }

  // The province layer (L2 of the concentration pipeline): volcanic soil and
  // a light seeded noise.
  const volcanic = rasterisePointField(volcanoes, T.volcanicProvinceRadiusFrac, grid)
  const provinceDeviation = new Float32Array(n)
  const provinceNoiseAt = noiseSampler(domain, T.provinceNoiseFreqX, T.provinceNoiseFreqY, warpSeed)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!land[i]) continue
      const noise = provinceNoiseAt(x, y)
      provinceDeviation[i] = T.volcanicWeight * volcanic[i] + T.noiseWeight * noise
    }
  }

  const seaMask = new Uint8Array(n)
  for (let i = 0; i < n; i++) seaMask[i] = land[i] ? 0 : 1
  return {
    w, h, grid, climate, land, sea: seaMask, coarseLand,
    raw: { arable, fish, game, pasture, timber, salt, toolStone, copper, iron, gold, silver },
    gemBelt, aridity,
    tinPoints: thinPoints(orogenPoints, T.tinKeep, warpSeed ^ 0x71b2a903),
    provinceDeviation,
    seasonal: months && keep ? {
      elevation, months, seaLevelMonths, coarseLand, coarseSea, ...keep,
      pastureYear: pasture, saltFlat, seaRichStatic, coastR,
    } : null,
  }
}

// One month of a field that changes over the year (SEASONAL_ECOLOGY_FIELDS),
// per pixel, `month` 1..12, with the field's abundance slider; null when the
// climate has no months. Each is what the land gives in that month on the
// field's own scale, so the twelve months average to its year:
// - arable: the month's growth (none below the frost) × flatness × reliability;
// - game: the month's productivity × the edge bonus;
// - pasture: the year's grazing × the month's productivity against the year's;
// - salt: a salt flat in full, else the month's warm dryness × the coast;
// - fish: the sea's richness with the month's mixing (on the sea and within
//   the land's reach), plus the fresh water.
export function ecologyMonth(eco: EcologyBase, field: SeasonalEcologyFieldId, month: number, weight = 1): Float32Array | null {
  const S = eco.seasonal
  if (!S) return null
  const T = ECOLOGY_TUNING
  const { w, h, land } = eco
  const n = w * h
  const nc = CLIMATE_RES_X * CLIMATE_RES_Y
  const m = Math.max(0, Math.min(S.months.count - 1, month - 1)) * nc
  const out = new Float32Array(n).fill(ECOLOGY_OCEAN)
  const px = new ClimatePixel(eco.climate)
  const lapse = CLIMATE_TUNING.lapseCPerElevation
  if (field === 'fish') {
    const rich = new Float32Array(n)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        if (land[i]) continue
        px.setPixel(x, y)
        rich[i] = S.seaRichStatic[i] + T.fishMixingW * seaMixing(px.read(S.months.temperature, S.coarseSea, m))
        out[i] = weight * (1 - detExp(-rich[i]))
      }
    }
    const near = maxWithin(rich, eco.grid, S.coastR)
    for (let i = 0; i < n; i++) if (land[i]) out[i] = weight * (1 - detExp(-(S.access[i] * near[i] + S.freshwater[i])))
    eco.grid.averagePoleRows(out, land)
    eco.grid.averagePoleRows(out, eco.sea)
    return out
  }
  const aridWarm = (tempC: number, precipMm: number): number => clamp01(1 - precipMm / T.saltAridPrecip) * clamp01(tempC / 25)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!land[i]) continue
      if (field === 'salt' && S.saltFlat && S.saltFlat[i]) { out[i] = weight * clamp01(T.saltFlatW); continue }
      px.setPixel(x, y)
      const t = px.read(S.seaLevelMonths, null, m) - lapse * Math.max(0, S.elevation[i] - SEA_LEVEL)
      const p = px.read(S.months.precipitation, S.coarseLand, m)
      let v: number
      if (field === 'arable') v = (t >= T.arableFrostC ? productivity(t, p + T.arableIrrigationMm * S.fieldWater[i]) : 0) * S.arableFactor[i]
      else if (field === 'game') v = productivity(t, p) * S.edgeFactor[i]
      else if (field === 'pasture') v = S.nppYear[i] > 0 ? S.pastureYear[i] * productivity(t, p) / S.nppYear[i] : 0
      else v = clamp01(aridWarm(t, p) * S.saltCoast[i])
      out[i] = weight * v
    }
  }
  eco.grid.averagePoleRows(out, land)
  return out
}

// The step's sliders on the physics: the per-field abundance, the carrying
// capacity's level and concentration, the province strength, tin's rarity;
// then the fields on the climate grid. Cheap next to prepareEcology.
export function applyEcology(eco: EcologyBase, params: EcologyParams): EcologyFields {
  const T = ECOLOGY_TUNING
  const { w, h, land, coarseLand, raw } = eco
  const n = w * h
  // Fold-out nudges: per-field abundance multipliers, on copies so the base
  // stays as it was; they both scale the displayed field and (for
  // subsistence + salt) flow into the carrying-capacity combine below.
  const wmap = params.weights ?? {}
  const scaled = (arr: Float32Array, id: EcologyFieldId): Float32Array => {
    const out = arr.slice()
    const m = wmap[id] ?? 1
    // The fish are on the sea too (the fishing grounds).
    if (m !== 1) for (let i = 0; i < n; i++) if (land[i] || id === 'fish') out[i] *= m
    return out
  }
  const arable = scaled(raw.arable, 'arable')
  const fish = scaled(raw.fish, 'fish')
  const game = scaled(raw.game, 'game')
  const pasture = scaled(raw.pasture, 'pasture')
  const salt = scaled(raw.salt, 'salt')

  // Saturating carrying-capacity base: subsistence sources complement with
  // diminishing returns (1 - e^-Σ w·x); salt adds a small preservation bonus (the
  // one sanctioned material→subsistence bleed).
  const base = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue
    base[i] = 1 - detExp(-(T.wArable * arable[i] + T.wFish * fish[i] + T.wGame * game[i] + T.wPasture * pasture[i] + T.wSaltCc * salt[i]))
  }
  const carryingCapacity = concentrationPipeline(base, land, eco.provinceDeviation, params, eco.grid)

  const timber = scaled(raw.timber, 'timber')
  const toolStone = scaled(raw.toolStone, 'toolStone')
  const copper = scaled(raw.copper, 'copper')
  const tinRadius = T.tinRadiusFrac * (1 - 0.6 * Math.max(0, Math.min(1, params.tinRarity ?? 0)))
  const tin = scaled(maskToLand(rasterisePointField(eco.tinPoints, tinRadius, eco.grid), land), 'tin')
  const iron = scaled(raw.iron, 'iron')
  const gold = scaled(raw.gold, 'gold')
  const silver = scaled(raw.silver, 'silver')
  const gemsRaw = new Float32Array(n)
  for (let i = 0; i < n; i++) if (land[i]) gemsRaw[i] = clamp01(T.gemOrogenW * eco.gemBelt[i] + T.gemAridW * eco.aridity[i] * copper[i])
  const gems = scaled(gemsRaw, 'gems')

  // Mask every per-resource field to the ocean sentinel so overlays skip
  // water — all but the fish, whose sea is its fishing grounds.
  const fine: Record<EcologyFieldId, Float32Array> = { carryingCapacity, arable, fish, game, pasture, timber, salt, toolStone, copper, tin, iron, gold, silver, gems }
  for (const id of ECOLOGY_FIELD_IDS) {
    if (id === 'fish') continue
    const f = fine[id]
    for (let i = 0; i < n; i++) if (!land[i]) f[i] = ECOLOGY_OCEAN
  }

  // A pole row is one value, its land's and (the fish) its sea's apart,
  // on both grids (fork 5; nothing happens on the torus).
  for (const id of ECOLOGY_FIELD_IDS) {
    eco.grid.averagePoleRows(fine[id], land)
    if (id === 'fish') eco.grid.averagePoleRows(fine[id], eco.sea)
  }
  const coarse = {} as Record<EcologyFieldId, Float32Array>
  for (const id of ECOLOGY_FIELD_IDS) {
    coarse[id] = toClimateCells(fine[id], land, coarseLand, eco.grid)
    eco.climate.averagePoleRows(coarse[id], coarseLand)
  }
  return { resX: CLIMATE_RES_X, resY: CLIMATE_RES_Y, fields: coarse, fine: { resX: w, resY: h, fields: fine } }
}

// A fine field averaged over each climate cell's land pixels, each by its
// area (`grid`'s cellArea: 1 on the torus); ECOLOGY_OCEAN on the cells the
// climate calls sea, 0 on a land cell without a land pixel.
function toClimateCells(field: Float32Array, land: Uint8Array, coarseLand: Uint8Array, grid: DomainGrid): Float32Array {
  const { resX: w, resY: h } = grid
  const nc = CLIMATE_RES_X * CLIMATE_RES_Y
  const sum = new Float64Array(nc)
  const count = new Float64Array(nc)
  for (let y = 0; y < h; y++) {
    const gy = Math.min(CLIMATE_RES_Y - 1, Math.floor((y / h) * CLIMATE_RES_Y))
    const a = grid.cellArea(y)
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!land[i]) continue
      const c = gy * CLIMATE_RES_X + Math.min(CLIMATE_RES_X - 1, Math.floor((x / w) * CLIMATE_RES_X))
      sum[c] += field[i] * a
      count[c] += a
    }
  }
  const out = new Float32Array(nc)
  for (let c = 0; c < nc; c++) out[c] = !coarseLand[c] ? ECOLOGY_OCEAN : count[c] > 0 ? sum[c] / count[c] : 0
  return out
}

// Deterministic mineralisation lottery (see the *_KEEP constants): hashes each
// point's integer position with the world seed + a per-resource salt and keeps
// the fraction that wins. Position-based (not index-based) so the surviving
// subset is stable as the feature list grows or reorders between epochs.
function thinPoints<P extends { x: number; y: number }>(points: P[], keepFraction: number, salt: number): P[] {
  if (keepFraction >= 1) return points
  const out: P[] = []
  for (const p of points) {
    let hsh = ((Math.floor(p.x) * 374761393 + Math.floor(p.y) * 668265263) ^ salt) | 0
    hsh = Math.imul(hsh ^ (hsh >>> 13), 1274126177)
    hsh = (hsh ^ (hsh >>> 16)) >>> 0
    if (hsh / 4294967296 < keepFraction) out.push(p)
  }
  return out
}

// Mask a point-influence field (copper/tin) to land only.
function maskToLand(field: Float32Array, land: Uint8Array): Float32Array {
  for (let i = 0; i < field.length; i++) if (!land[i]) field[i] = 0
  return field
}

// --- concentration pipeline (verified in Phase 1) ---------------------------

// By area (`grid`'s cellArea: 1 on the torus, where it is the plain mean).
function landMean(field: Float32Array, land: Uint8Array, grid: DomainGrid): number {
  const { resX: w, resY: h } = grid
  let sum = 0
  let count = 0
  for (let y = 0; y < h; y++) {
    const a = grid.cellArea(y)
    for (let i = y * w; i < (y + 1) * w; i++) if (land[i]) { sum += field[i] * a; count += a }
  }
  return count > 0 ? sum / count : 0
}

// Province noise (see Phase 1): smooth seeded value noise in [-1,1] at a coarse
// lattice frequency — broad "provinces", not fine texture. `lattice`: the
// noise's lattice over the domain (freqX × freqY cells), which wraps it.
function hashLattice(ix: number, iy: number, seed: number): number {
  let hsh = (ix * 374761393 + iy * 668265263 + seed * 1442695040) | 0
  hsh = (hsh ^ (hsh >>> 13)) * 1274126177
  hsh = hsh ^ (hsh >>> 16)
  return (hsh >>> 0) / 4294967295
}
// The noise at world pixel (x, y)'s centre, in [-1, 1], at a lattice of
// freqX × freqY cells over the world: the periodic chart lattice on the
// torus (provinceNoise), the globe's 3D lattice on the sphere (Domain.noise
// — one value at a pole, no seam, as rough east-west as north-south), of
// the same cell size along the equator.
function noiseSampler(domain: Domain, freqX: number, freqY: number, seed: number): (x: number, y: number) => number {
  const space = domain.noise
  const { width: w, height: h } = domain
  if (space.kind === 'chart') {
    const lattice = domain.grid(freqX, freqY)
    return (x, y) => provinceNoise((x + 0.5) / w, (y + 0.5) / h, lattice, seed)
  }
  const frame = globeFrame()
  return (x, y) => {
    space.frame(x + 0.5, y + 0.5, frame)
    return globeOctave(frame, freqX, w, seed) * 2 - 1
  }
}
function provinceNoise(u: number, v: number, lattice: DomainGrid, seed: number): number {
  const gx = u * lattice.resX
  const gy = v * lattice.resY
  const x0 = Math.floor(gx)
  const y0 = Math.floor(gy)
  const fx = smoothstep(gx - x0)
  const fy = smoothstep(gy - y0)
  const c00 = hashLattice(lattice.wrapCol(x0), lattice.wrapRow(y0), seed)
  const c10 = hashLattice(lattice.wrapCol(x0 + 1), lattice.wrapRow(y0), seed)
  const c01 = hashLattice(lattice.wrapCol(x0), lattice.wrapRow(y0 + 1), seed)
  const c11 = hashLattice(lattice.wrapCol(x0 + 1), lattice.wrapRow(y0 + 1), seed)
  const top = c00 + (c10 - c00) * fx
  const bottom = c01 + (c11 - c01) * fx
  return (top + (bottom - top) * fy) * 2 - 1
}

// asin(z) for the halos' arcs: below 0.25 by its series to z⁹ (a halo's
// reach, 3σ, is under 0.24 rad for every radiusFrac up to 0.05; the first
// term left out is 2e-8 of the value there), else detAsin — which was a
// third of a stamp's time on the sphere.
function asinOfHalfChord(z: number): number {
  if (z >= 0.25) return detAsin(Math.min(1, z))
  const z2 = z * z
  return z * (1 + z2 * (1 / 6 + z2 * (3 / 40 + z2 * (5 / 112 + z2 * (35 / 1152)))))
}

// Rasterises a soft Gaussian "influence" field (0..1, union-max) around a set of
// world-space points onto the raster `grid` the points are given in — reused for
// volcanic-soil provinces, copper (arc volcanoes), tin (sutures), obsidian, etc.
// Radius as a fraction of the smaller world dimension; stamps within three
// radii of each point only, so cost is O(points). The torus measures in the
// chart, whose pixels are square; the sphere on the globe (the distance on
// it, the cells of the disc's box, DomainGrid.discBox), so a halo is a disc
// at every latitude and one across a pole. `grid` lies over its domain one
// pixel per unit.
function rasterisePointField(points: { x: number; y: number }[], radiusFrac: number, grid: DomainGrid): Float32Array {
  const { resX: w, resY: h } = grid
  const field = new Float32Array(w * h)
  if (points.length === 0) return field
  const radius = Math.min(w, h) * radiusFrac
  const reach = Math.ceil(radius * 3)
  const inv2r2 = 1 / (2 * radius * radius)
  const space = grid.domain.noise
  if (space.kind === 'globe') {
    // The distance on the globe from the cells' and the point's positions
    // (GlobeNoise.frame, R · u): the arc 2R asin(c / 2) of the chord c
    // between the unit vectors. A cell's position is separable — its row's
    // sin and cos of the colatitude (the frame at longitude 0) times its
    // column's direction (the frame's east axis is (−sin λ, cos λ, 0)) —
    // so the tables are made once per call. Domain.distanceSq, whose point
    // cache a stamp of 10⁵ cells thrashes, made prepareEcology 6× the
    // torus's (2026-10-11, 200 volcanoes at 2048 × 1024: 10.0 s against
    // 1.7); now 2.8 s.
    const R = space.radius
    const frame = globeFrame()
    const st = new Float64Array(h)
    const ct = new Float64Array(h)
    for (let y = 0; y < h; y++) {
      space.frame(0, y + 0.5, frame)
      st[y] = frame.px / R
      ct[y] = frame.pz / R
    }
    const cl = new Float64Array(w)
    const sl = new Float64Array(w)
    for (let x = 0; x < w; x++) {
      space.frame(x + 0.5, h / 2, frame)
      cl[x] = frame.ey
      sl[x] = -frame.ex
    }
    const box = { x0: 0, x1: 0, y0: 0, y1: 0 }
    const chordReach = 2 * detSin(Math.min(Math.PI / 2, reach / (2 * R)))
    const chordReach2 = chordReach * chordReach
    for (const v of points) {
      space.frame(v.x, v.y, frame)
      const ux = frame.px / R
      const uy = frame.py / R
      const uz = frame.pz / R
      grid.discBox(v.x, v.y, reach, box)
      for (let gy = box.y0; gy <= box.y1; gy++) {
        const row = grid.index(0, gy)
        const shift = row % w
        const y = (row - shift) / w
        const dz = ct[y] - uz
        for (let gx = box.x0; gx <= box.x1; gx++) {
          const x = grid.wrapCol(gx + shift)
          const dx = st[y] * cl[x] - ux
          const dy = st[y] * sl[x] - uy
          const c2 = dx * dx + dy * dy + dz * dz
          if (c2 > chordReach2) continue
          const arc = 2 * R * asinOfHalfChord(Math.sqrt(c2) / 2)
          const bump = detExp(-(arc * arc) * inv2r2)
          const i = y * w + x
          if (bump > field[i]) field[i] = bump
        }
      }
    }
    return field
  }
  for (const v of points) {
    const cx = Math.floor(v.x)
    const cy = Math.floor(v.y)
    for (let dy = -reach; dy <= reach; dy++) {
      const y = grid.wrapRow(cy + dy)
      const ddy = cy + dy + 0.5 - v.y
      for (let dx = -reach; dx <= reach; dx++) {
        const ddx = cx + dx + 0.5 - v.x
        const bump = detExp(-(ddx * ddx + ddy * ddy) * inv2r2)
        const i = y * w + grid.wrapCol(cx + dx)
        if (bump > field[i]) field[i] = bump
      }
    }
  }
  return field
}

// Runs the base subsistence aggregate through `normalise → L1 gamma
// (mean-preserving) → L2 province (mean-1) → gain`, so carrying capacity's gain
// changes only the level and concentration only the shape. Verified in Phase 1.
function concentrationPipeline(base: Float32Array, land: Uint8Array, dev: Float32Array, params: EcologyParams, grid: DomainGrid): Float32Array {
  const n = base.length
  let maxBase = 0
  for (let i = 0; i < n; i++) if (land[i] && base[i] > maxBase) maxBase = base[i]
  const norm = new Float32Array(n)
  if (maxBase > 0) for (let i = 0; i < n; i++) if (land[i]) norm[i] = base[i] / maxBase
  const meanNorm = landMean(norm, land, grid)

  const gamma = detPow(2, params.concentration / 100)
  const shaped = new Float32Array(n)
  for (let i = 0; i < n; i++) if (land[i]) shaped[i] = detPow(norm[i], gamma)
  const meanShaped = landMean(shaped, land, grid)
  const l1Scale = meanShaped > 0 ? meanNorm / meanShaped : 1
  for (let i = 0; i < n; i++) if (land[i]) shaped[i] *= l1Scale

  const strength = params.provinceStrength
  const meanDev = landMean(dev, land, grid)
  const provincal = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue
    provincal[i] = shaped[i] * Math.max(0.1, 1 + strength * (dev[i] - meanDev))
  }
  const meanProv = landMean(provincal, land, grid)
  const l2Scale = meanProv > 0 ? meanNorm / meanProv : 1

  const gain = params.carryingCapacity / 100
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = land[i] ? provincal[i] * l2Scale * gain : ECOLOGY_OCEAN
  return out
}
