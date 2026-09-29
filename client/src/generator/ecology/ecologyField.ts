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

import { CLIMATE_RES_X, CLIMATE_RES_Y } from '../climate/climateField'
import { CLIMATE_TUNING } from '../climate/climateTuneParams'
import { OCEAN_PRECIP } from '../climate/precipitation'
import { Biome, reduceTemperatureToSeaLevel } from '../climate/biomes'
import { clamp01, smoothstep } from '../core/interpolation'
import { wrapValue } from '../core/field'
import { MAP_WIDTH, METERS_PER_CELL } from '../core/mapConfig'
import { SEA_LEVEL, metersToElevation } from '../elevation/elevationScale'
import { ECOLOGY_TUNING, PASTURE_BY_BIOME, TIMBER_BY_BIOME } from './ecologyTuneParams'
import type { Volcano } from '../tectonics/volcanoes'
import type { LandBiomeId } from './ecologyTuneParams'

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
// elevation/discharge/lakeDepth are full-res (worldWidth×worldHeight). Hydrology
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
  worldWidth: number
  worldHeight: number
}

// --- shared helpers ---------------------------------------------------------

// Terrestrial net primary productivity, Miami-model style (0..1): limited by
// whichever of temperature and precipitation is scarcer (Liebig's law of the
// minimum). The ecological backbone of both arable land and wild game.
function productivity(tempC: number, precipMm: number): number {
  const nppTemp = 1 / (1 + Math.exp(1.315 - 0.119 * tempC))
  const nppPrecip = 1 - Math.exp(-0.000664 * Math.max(0, precipMm))
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

// The largest value within `r` pixels (a square, wrapped on the torus):
// "is there water / a rich sea within reach". Two passes, rows then columns.
function maxWithin(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const rows = new Float32Array(src.length)
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      let m = src[row + x]
      for (let d = 1; d <= r; d++) {
        const a = src[row + wrapValue(x - d, w)]
        const b = src[row + wrapValue(x + d, w)]
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
        const a = rows[wrapValue(y - d, h) * w + x]
        const b = rows[wrapValue(y + d, h) * w + x]
        if (a > m) m = a
        if (b > m) m = b
      }
      out[y * w + x] = m
    }
  }
  return out
}

// The mean within `r` pixels (a square, wrapped): "how much of the land
// around is sea". Running sums, rows then columns.
function meanWithin(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const span = 2 * r + 1
  const rows = new Float32Array(src.length)
  for (let y = 0; y < h; y++) {
    const row = y * w
    let sum = 0
    for (let d = -r; d <= r; d++) sum += src[row + wrapValue(d, w)]
    for (let x = 0; x < w; x++) {
      rows[row + x] = sum / span
      sum += src[row + wrapValue(x + r + 1, w)] - src[row + wrapValue(x - r, w)]
    }
  }
  const out = new Float32Array(src.length)
  for (let x = 0; x < w; x++) {
    let sum = 0
    for (let d = -r; d <= r; d++) sum += rows[wrapValue(d, h) * w + x]
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / span
      sum += rows[wrapValue(y + r + 1, h) * w + x] - rows[wrapValue(y - r, h) * w + x]
    }
  }
  return out
}

// A bilinear read of a climate-grid field at a world pixel's centre, over the
// corners `use` accepts only (the weights of the rest dropped and the others
// renormalised; with none, the containing cell's value). A land field's sea
// corners carry a sentinel, and a sea field's land corners the wrong thing.
// The corners and weights are set once per pixel (setPixel) and read for
// every field and month (read).
class ClimatePixel {
  private readonly idx = new Int32Array(4)
  private readonly wt = new Float64Array(4)
  private cell = 0
  setPixel(wx: number, wy: number, worldW: number, worldH: number): void {
    const gx = ((wx + 0.5) / worldW) * CLIMATE_RES_X - 0.5
    const gy = ((wy + 0.5) / worldH) * CLIMATE_RES_Y - 0.5
    const x0 = Math.floor(gx)
    const y0 = Math.floor(gy)
    const fx = gx - x0
    const fy = gy - y0
    const x0m = wrapValue(x0, CLIMATE_RES_X)
    const y0m = wrapValue(y0, CLIMATE_RES_Y)
    const x1m = (x0m + 1) % CLIMATE_RES_X
    const y1m = (y0m + 1) % CLIMATE_RES_Y
    this.idx[0] = y0m * CLIMATE_RES_X + x0m
    this.idx[1] = y0m * CLIMATE_RES_X + x1m
    this.idx[2] = y1m * CLIMATE_RES_X + x0m
    this.idx[3] = y1m * CLIMATE_RES_X + x1m
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
    return weight > 0 ? sum / weight : field[offset + this.cell]
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
  land: Uint8Array
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
}

export function computeEcology(inputs: EcologyInputs, params: EcologyParams): EcologyFields {
  return applyEcology(prepareEcology(inputs), params)
}

export function prepareEcology(inputs: EcologyInputs): EcologyBase {
  const { temperature, precipitation, biomes, biomesFine, upwelling, months, rainVariability, elevation, discharge, maxDischarge, lakeDepth, saltFlat, waterTable, oases, volcanoes, orogenPoints, cratonAge, warpSeed, worldWidth: w, worldHeight: h } = inputs
  const T = ECOLOGY_TUNING
  const n = w * h
  const nc = CLIMATE_RES_X * CLIMATE_RES_Y
  // Metres per pixel: the generator's world is MAP_WIDTH × METERS_PER_CELL
  // wide whatever raster it is sampled on.
  const mPerPx = (MAP_WIDTH * METERS_PER_CELL) / w
  // The slope's scale: flatness was measured on the rise across a climate
  // cell, and a pixel's rise is read against the same length.
  const pxPerCell = w / CLIMATE_RES_X

  const land = new Uint8Array(n)
  const sea = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    if (elevation[i] > SEA_LEVEL) land[i] = 1
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
  const px = new ClimatePixel()
  const coastR = reachPx(T.coastReachM, mPerPx)
  const waterR = reachPx(T.waterReachM, mPerPx)

  // The sea's richness per sea pixel: a base, the share of shelf sea
  // within reach, the upwelling and the winter mixing (see the fish
  // constants).
  const shelfFloor = SEA_LEVEL - metersToElevation(T.fishShelfDepthM)
  const shallow = new Float32Array(n)
  for (let i = 0; i < n; i++) if (!land[i] && elevation[i] > shelfFloor) shallow[i] = 1
  const shelfShare = meanWithin(shallow, w, h, coastR)
  const seaRich = new Float32Array(n)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (land[i]) continue
      px.setPixel(x, y, w, h)
      const rising = upwelling ? clamp01(px.read(upwelling, coarseSea) / T.fishUpwellingFull) : 0
      const cool = seaMixing(px.read(temperature, coarseSea))
      seaRich[i] = T.fishSeaBase + T.fishShelfW * shelfShare[i] + T.fishUpwellingW * rising + T.fishMixingW * cool
    }
  }
  const richSeaNear = maxWithin(seaRich, w, h, coastR)
  const seaShare = meanWithin(sea, w, h, coastR)

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
      river[i] = Math.min(1, riverRoot[i] * 2)
      riverWet[i] = Math.min(1, share * 4)
    }
  }
  if (lakeDepth) for (let i = 0; i < n; i++) if (lakeDepth[i] > 0) lake[i] = 1
  const riverNear = maxWithin(river, w, h, waterR)
  const riverRootNear = maxWithin(riverRoot, w, h, waterR)
  const riverWetNear = maxWithin(riverWet, w, h, waterR)
  const lakeNear = maxWithin(lake, w, h, waterR)
  // A hand-dug well within a herd's reach.
  let wellNear: Float32Array | null = null
  if (waterTable) {
    const shallow = new Float32Array(n)
    for (let i = 0; i < n; i++) if (waterTable[i] >= 0 && waterTable[i] <= T.wellDepthM) shallow[i] = 1
    wellNear = maxWithin(shallow, w, h, waterR)
  }
  // The oases' gardens.
  const oasis = new Float32Array(n)
  for (const o of oases) {
    const cx = Math.floor(o.x)
    const cy = Math.floor(o.y)
    for (let dy = -waterR; dy <= waterR; dy++) for (let dx = -waterR; dx <= waterR; dx++) oasis[wrapValue(cy + dy, h) * w + wrapValue(cx + dx, w)] = 1
  }

  // How much of the land around differs in biome (game's edges): per pixel
  // the share of its four neighbours of another biome, averaged within reach.
  const differs = new Float32Array(n)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!land[i]) continue
      const b = biomeAt[i]
      let d = 0
      if (biomeAt[y * w + wrapValue(x + 1, w)] !== b) d++
      if (biomeAt[y * w + wrapValue(x - 1, w)] !== b) d++
      if (biomeAt[wrapValue(y + 1, h) * w + x] !== b) d++
      if (biomeAt[wrapValue(y - 1, h) * w + x] !== b) d++
      differs[i] = d / 4
    }
  }
  const edges = meanWithin(differs, w, h, reachPx(T.ecotoneReachM, mPerPx))

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
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!land[i]) continue
      px.setPixel(x, y, w, h)
      const height = Math.max(0, elevation[i] - SEA_LEVEL)

      // The pixel's slope, as a rise across a climate cell's length.
      const e = elevation
      const dx = e[y * w + wrapValue(x + 1, w)] - e[y * w + wrapValue(x - 1, w)]
      const dy = e[wrapValue(y + 1, h) * w + x] - e[wrapValue(y - 1, h) * w + x]
      const flat = 1 / (1 + T.slopeK * Math.hypot(dx, dy) * 0.5 * pxPerCell)
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

      // Fish: the richest sea within reach, as far as the sea is at hand
      // (a straight coast in full), plus the rivers and lakes near.
      const access = Math.min(1, seaShare[i] / T.fishFullSeaShare)
      const freshwater = Math.min(1, T.fishRiverW * riverNear[i] + T.fishLakeW * lakeNear[i])
      fish[i] = 1 - Math.exp(-(access * richSeaNear[i] + freshwater))

      // Game: productivity, more where biomes meet.
      game[i] = npp * (1 + T.ecotoneBonus * clamp01(edges[i] / T.ecotoneFullShare))

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
      salt[i] = clamp01(Math.max(flatSalt, arid * (T.saltInteriorW + (T.saltCoastW - T.saltInteriorW) * Math.min(1, seaShare[i] / T.fishFullSeaShare))))

      // Wetland (bog iron): flat, wet, water-fed lowland.
      const water = lakeNear[i] > 0 ? 1 : riverWetNear[i]
      wetland[i] = flat * water * clamp01(yearP / 600)
      aridity[i] = aridWarm(yearT, yearP)
      craton[i] = Math.max(0, px.read(cratonAge, cratonMask))
    }
  }

  // Material and prestige before the sliders. Copper = arc volcanoes; tin =
  // orogen belts (its radius a slider); iron = old cratons + bog iron.
  const arcVolcanoes = volcanoes.filter((v) => v.kind === 'arc')
  const obsidian = rasterisePointField(thinPoints(volcanoes, T.obsidianKeep, warpSeed ^ 0x0b51d1a2), T.obsidianRadiusFrac, w, h)
  const toolStone = new Float32Array(n)
  for (let i = 0; i < n; i++) if (land[i]) toolStone[i] = Math.max(obsidian[i], T.flintBase * flatness[i])
  const copper = maskToLand(rasterisePointField(thinPoints(arcVolcanoes, T.copperKeep, warpSeed ^ 0xc0bbe401), T.copperRadiusFrac, w, h), land)
  // Iron: the old-craton signal broken into deposits by a seeded noise (so it
  // fluctuates instead of reading as a flat 100%), plus bog iron in wetlands.
  const iron = new Float32Array(n)
  const ironSeed = (warpSeed ^ 0x51ed2701) | 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!land[i]) continue
      const noise01 = (provinceNoise((x + 0.5) / w, (y + 0.5) / h, T.ironDepositFreqX, T.ironDepositFreqY, ironSeed) + 1) / 2
      const deposit = T.ironDepositFloor + (1 - T.ironDepositFloor) * noise01
      iron[i] = clamp01(Math.max(T.ironCratonW * craton[i] * deposit, T.ironBogW * wetland[i]))
    }
  }
  // Prestige (separate channel — no carrying-capacity contribution). Gold:
  // placer (carried down rivers) + lode at orogenic belts. Silver:
  // hydrothermal, near volcanic arcs. Gems: metamorphic/orogenic belts + arid
  // weathering (turquoise near copper, in applyEcology).
  const lode = rasterisePointField(thinPoints(orogenPoints, T.goldLodeKeep, warpSeed ^ 0x601dfeed), T.goldLodeRadiusFrac, w, h)
  const arc = rasterisePointField(thinPoints(arcVolcanoes, T.silverKeep, warpSeed ^ 0x5117e201), T.silverRadiusFrac, w, h)
  const gemBelt = rasterisePointField(thinPoints(orogenPoints, T.gemKeep, warpSeed ^ 0x9e35c0de), T.gemRadiusFrac, w, h)
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
  const volcanic = rasterisePointField(volcanoes, T.volcanicProvinceRadiusFrac, w, h)
  const provinceDeviation = new Float32Array(n)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!land[i]) continue
      const noise = provinceNoise((x + 0.5) / w, (y + 0.5) / h, T.provinceNoiseFreqX, T.provinceNoiseFreqY, warpSeed)
      provinceDeviation[i] = T.volcanicWeight * volcanic[i] + T.noiseWeight * noise
    }
  }

  return {
    w, h, land, coarseLand,
    raw: { arable, fish, game, pasture, timber, salt, toolStone, copper, iron, gold, silver },
    gemBelt, aridity,
    tinPoints: thinPoints(orogenPoints, T.tinKeep, warpSeed ^ 0x71b2a903),
    provinceDeviation,
  }
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
    if (m !== 1) for (let i = 0; i < n; i++) if (land[i]) out[i] *= m
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
    base[i] = 1 - Math.exp(-(T.wArable * arable[i] + T.wFish * fish[i] + T.wGame * game[i] + T.wPasture * pasture[i] + T.wSaltCc * salt[i]))
  }
  const carryingCapacity = concentrationPipeline(base, land, eco.provinceDeviation, params)

  const timber = scaled(raw.timber, 'timber')
  const toolStone = scaled(raw.toolStone, 'toolStone')
  const copper = scaled(raw.copper, 'copper')
  const tinRadius = T.tinRadiusFrac * (1 - 0.6 * Math.max(0, Math.min(1, params.tinRarity ?? 0)))
  const tin = scaled(maskToLand(rasterisePointField(eco.tinPoints, tinRadius, w, h), land), 'tin')
  const iron = scaled(raw.iron, 'iron')
  const gold = scaled(raw.gold, 'gold')
  const silver = scaled(raw.silver, 'silver')
  const gemsRaw = new Float32Array(n)
  for (let i = 0; i < n; i++) if (land[i]) gemsRaw[i] = clamp01(T.gemOrogenW * eco.gemBelt[i] + T.gemAridW * eco.aridity[i] * copper[i])
  const gems = scaled(gemsRaw, 'gems')

  // Mask every per-resource field to the ocean sentinel so overlays skip water.
  const fine: Record<EcologyFieldId, Float32Array> = { carryingCapacity, arable, fish, game, pasture, timber, salt, toolStone, copper, tin, iron, gold, silver, gems }
  for (const id of ECOLOGY_FIELD_IDS) {
    const f = fine[id]
    for (let i = 0; i < n; i++) if (!land[i]) f[i] = ECOLOGY_OCEAN
  }

  const coarse = {} as Record<EcologyFieldId, Float32Array>
  for (const id of ECOLOGY_FIELD_IDS) coarse[id] = toClimateCells(fine[id], land, coarseLand, w, h)
  return { resX: CLIMATE_RES_X, resY: CLIMATE_RES_Y, fields: coarse, fine: { resX: w, resY: h, fields: fine } }
}

// A fine field averaged over each climate cell's land pixels; ECOLOGY_OCEAN on
// the cells the climate calls sea, 0 on a land cell without a land pixel.
function toClimateCells(field: Float32Array, land: Uint8Array, coarseLand: Uint8Array, w: number, h: number): Float32Array {
  const nc = CLIMATE_RES_X * CLIMATE_RES_Y
  const sum = new Float64Array(nc)
  const count = new Float64Array(nc)
  for (let y = 0; y < h; y++) {
    const gy = Math.min(CLIMATE_RES_Y - 1, Math.floor((y / h) * CLIMATE_RES_Y))
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!land[i]) continue
      const c = gy * CLIMATE_RES_X + Math.min(CLIMATE_RES_X - 1, Math.floor((x / w) * CLIMATE_RES_X))
      sum[c] += field[i]
      count[c]++
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

function landMean(field: Float32Array, land: Uint8Array): number {
  let sum = 0
  let count = 0
  for (let i = 0; i < field.length; i++) if (land[i]) { sum += field[i]; count += 1 }
  return count > 0 ? sum / count : 0
}

// Province noise (see Phase 1): smooth seeded value noise in [-1,1], toroidal, at
// a coarse lattice frequency — broad "provinces", not fine texture.
function hashLattice(ix: number, iy: number, seed: number): number {
  let hsh = (ix * 374761393 + iy * 668265263 + seed * 1442695040) | 0
  hsh = (hsh ^ (hsh >>> 13)) * 1274126177
  hsh = hsh ^ (hsh >>> 16)
  return (hsh >>> 0) / 4294967295
}
function provinceNoise(u: number, v: number, freqX: number, freqY: number, seed: number): number {
  const gx = u * freqX
  const gy = v * freqY
  const x0 = Math.floor(gx)
  const y0 = Math.floor(gy)
  const fx = smoothstep(gx - x0)
  const fy = smoothstep(gy - y0)
  const c00 = hashLattice(wrapValue(x0, freqX), wrapValue(y0, freqY), seed)
  const c10 = hashLattice(wrapValue(x0 + 1, freqX), wrapValue(y0, freqY), seed)
  const c01 = hashLattice(wrapValue(x0, freqX), wrapValue(y0 + 1, freqY), seed)
  const c11 = hashLattice(wrapValue(x0 + 1, freqX), wrapValue(y0 + 1, freqY), seed)
  const top = c00 + (c10 - c00) * fx
  const bottom = c01 + (c11 - c01) * fx
  return (top + (bottom - top) * fy) * 2 - 1
}

// Rasterises a soft Gaussian "influence" field (0..1, union-max) around a set of
// world-space points onto the w×h raster the points are given in — reused for
// volcanic-soil provinces, copper (arc volcanoes), tin (sutures), obsidian, etc.
// Radius as a fraction of the smaller world dimension; stamps within three
// radii of each point only, so cost is O(points).
function rasterisePointField(points: { x: number; y: number }[], radiusFrac: number, w: number, h: number): Float32Array {
  const field = new Float32Array(w * h)
  if (points.length === 0) return field
  const radius = Math.min(w, h) * radiusFrac
  const reach = Math.ceil(radius * 3)
  const inv2r2 = 1 / (2 * radius * radius)
  for (const v of points) {
    const cx = Math.floor(v.x)
    const cy = Math.floor(v.y)
    for (let dy = -reach; dy <= reach; dy++) {
      const y = wrapValue(cy + dy, h)
      const ddy = cy + dy + 0.5 - v.y
      for (let dx = -reach; dx <= reach; dx++) {
        const ddx = cx + dx + 0.5 - v.x
        const bump = Math.exp(-(ddx * ddx + ddy * ddy) * inv2r2)
        const i = y * w + wrapValue(cx + dx, w)
        if (bump > field[i]) field[i] = bump
      }
    }
  }
  return field
}

// Runs the base subsistence aggregate through `normalise → L1 gamma
// (mean-preserving) → L2 province (mean-1) → gain`, so carrying capacity's gain
// changes only the level and concentration only the shape. Verified in Phase 1.
function concentrationPipeline(base: Float32Array, land: Uint8Array, dev: Float32Array, params: EcologyParams): Float32Array {
  const n = base.length
  let maxBase = 0
  for (let i = 0; i < n; i++) if (land[i] && base[i] > maxBase) maxBase = base[i]
  const norm = new Float32Array(n)
  if (maxBase > 0) for (let i = 0; i < n; i++) if (land[i]) norm[i] = base[i] / maxBase
  const meanNorm = landMean(norm, land)

  const gamma = Math.pow(2, params.concentration / 100)
  const shaped = new Float32Array(n)
  for (let i = 0; i < n; i++) if (land[i]) shaped[i] = Math.pow(norm[i], gamma)
  const meanShaped = landMean(shaped, land)
  const l1Scale = meanShaped > 0 ? meanNorm / meanShaped : 1
  for (let i = 0; i < n; i++) if (land[i]) shaped[i] *= l1Scale

  const strength = params.provinceStrength
  const meanDev = landMean(dev, land)
  const provincal = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue
    provincal[i] = shaped[i] * Math.max(0.1, 1 + strength * (dev[i] - meanDev))
  }
  const meanProv = landMean(provincal, land)
  const l2Scale = meanProv > 0 ? meanNorm / meanProv : 1

  const gain = params.carryingCapacity / 100
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = land[i] ? provincal[i] * l2Scale * gain : ECOLOGY_OCEAN
  return out
}
