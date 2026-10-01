import { CLIMATE_RES_X, CLIMATE_RES_Y, isLandAtCell, sampleDryLandAtCell, sampleElevationAtCell, shiftedYNorm, zonalLandMean } from './climateField'
import { classifyKoppen, koppenCode, synthesizeMonths } from './koppen'
import { CLIMATE_TUNING } from './climateTuneParams'
import { SEA_LEVEL, isLandAt } from '../elevation/elevationScale'
import { sampleBilinearWorld, wrapValue } from '../core/field'
import { seasonalityMagnitude } from './monsoon'
import { OCEAN_PRECIP } from './precipitation'

const RX = CLIMATE_RES_X
const RY = CLIMATE_RES_Y

// The biome set. Since 2026-09-28 the biome follows from the Köppen–Geiger
// class of the place's twelve months (koppen.ts, biomeFromKoppen below), no
// longer from the annual means on a Whittaker chart; the last four ids are
// the biomes the months can tell apart and the means could not. Ocean is its
// own id so the biome layer can skip it. Ids are stable (saves store them).
// See docs/decisions/climate-biomes.md and docs/design/climate-refinement.md.
export const Biome = {
  Ocean: 0,
  Ice: 1,
  Tundra: 2,
  Boreal: 3,
  Grassland: 4,
  Woodland: 5,
  TemperateForest: 6,
  TemperateRainforest: 7,
  Desert: 8,
  Savanna: 9,
  TropicalRainforest: 10,
  Alpine: 11,
  // Hydrology override, not a Whittaker class (like Ocean): the exposed dry
  // floor of a terminal basin — see computeLakes' salt-flat mask.
  SaltFlat: 12,
  // Hydrology override, the salt flat's cold sibling: a lake basin frozen
  // through (mean annual below SURFACE_TUNING.lakeFrozenBelowC) — see
  // computeLakes' frozen mask. Distinct from Ice on purpose: Ice is a CLIMATE
  // class on land, a glacier is a water body in a solid state — different
  // gameplay (fresh water, crossing), different tooltip.
  Glacier: 13,
  // Dry-summer shrubland (Köppen Cs): maquis, chaparral, fynbos.
  MediterraneanScrub: 14,
  // Semi-arid grass (Köppen BS), between grassland and desert.
  Steppe: 15,
  // Tropical forest with a dry season (Köppen Am, the wet end of Aw).
  TropicalDryForest: 16,
  // Desert with cold winters (Köppen BWk): Gobi, Patagonia.
  ColdDesert: 17,
} as const

type BiomeId = (typeof Biome)[keyof typeof Biome]

// The biomes that are HYDROLOGY STATES, not climate classes: no classifier
// can reach them — they are decided by the terminal-basin and frozen-lake
// passes that ran on the macro world, and every re-classification (the
// worldmap sharpens biomes on its current terrain tier) must CARRY them over
// from the macro authority instead of re-deriving. Declared HERE, next to the
// enum, so the next hydrology-state biome cannot silently miss the carry-over
// — Glacier was hand-added to that list one day after SaltFlat's entry, which
// is exactly the class of edit this set exists to make impossible to forget.
export const HYDROLOGY_STATE_BIOMES: ReadonlySet<number> = new Set<number>([Biome.SaltFlat, Biome.Glacier])

// Palette tuned for on-map distinguishability (2026-07-26): the four forests keep
// green hues but spread across value/temperature (dark-muted → bright → teal → deep),
// and the dry cluster (grassland/woodland/savanna/desert) is separated by hue + lightness
// (pale-yellow / olive / gold / pale-sand) instead of the near-identical tans it was.
const BIOME_COLORS: Record<number, [number, number, number]> = {
  [Biome.Ocean]: [40, 90, 140],
  [Biome.Ice]: [240, 244, 249],
  [Biome.Tundra]: [178, 176, 164], // warm light grey
  [Biome.Boreal]: [60, 98, 86], // dark muted conifer green
  [Biome.Grassland]: [214, 202, 122], // pale yellow
  [Biome.Woodland]: [150, 162, 88], // olive green
  [Biome.TemperateForest]: [96, 162, 78], // bright green
  [Biome.TemperateRainforest]: [42, 130, 100], // teal-green (wet)
  [Biome.Desert]: [236, 218, 170], // pale sand (lightest)
  [Biome.Savanna]: [208, 166, 78], // gold / ochre
  [Biome.TropicalRainforest]: [22, 106, 50], // deep saturated green
  [Biome.Alpine]: [158, 154, 168], // cool slate/lavender-grey — bare rock, distinct from Tundra's warm grey and Ice's near-white
  [Biome.SaltFlat]: [236, 230, 218], // warm off-white salt crust — real pans aren't snow-white, and Ice keeps the cold near-white
  [Biome.Glacier]: [214, 228, 244], // pale glacier blue — bluer than Ice's near-white, reads as frozen WATER
  [Biome.MediterraneanScrub]: [170, 150, 80], // dusty olive-brown, dry evergreen scrub
  [Biome.Steppe]: [226, 206, 150], // pale buff, between grassland's yellow and desert's sand
  [Biome.TropicalDryForest]: [120, 140, 50], // khaki green, a forest that browns in the dry season
  [Biome.ColdDesert]: [200, 190, 170], // grey-beige, cooler than the hot desert's sand
}

export function biomeColor(id: number): [number, number, number] {
  return BIOME_COLORS[id] ?? [128, 128, 128]
}

// i18n catalog keys for the display names, NOT the names themselves
// (2026-08-06). This module is imported by the simulation worker, so it must
// not pull in the i18n runtime or hold UI language; the screen resolves these
// keys through t(). The catalog side (biome.*) already existed — it was
// simply never wired, so the legend and the hover readout stayed English.
const BIOME_LABEL_KEYS: Record<number, string> = {
  [Biome.Ocean]: 'biome.ocean',
  [Biome.Ice]: 'biome.iceCap',
  [Biome.Tundra]: 'biome.tundra',
  [Biome.Boreal]: 'biome.borealForest',
  [Biome.Grassland]: 'biome.grassland',
  [Biome.Woodland]: 'biome.woodland',
  [Biome.TemperateForest]: 'biome.temperateForest',
  [Biome.TemperateRainforest]: 'biome.temperateRainforest',
  [Biome.Desert]: 'biome.desert',
  [Biome.Savanna]: 'biome.savanna',
  [Biome.TropicalRainforest]: 'biome.tropicalRainforest',
  [Biome.Alpine]: 'biome.alpine',
  [Biome.SaltFlat]: 'biome.saltFlat',
  [Biome.Glacier]: 'biome.glacier',
  [Biome.MediterraneanScrub]: 'biome.mediterraneanScrub',
  [Biome.Steppe]: 'biome.steppe',
  [Biome.TropicalDryForest]: 'biome.tropicalDryForest',
  [Biome.ColdDesert]: 'biome.coldDesert',
}

export function biomeLabelKey(id: number): string {
  return BIOME_LABEL_KEYS[id] ?? 'biome.unknown'
}

// Land biomes (excludes Ocean) as {labelKey, rgb} for the overlay legend, in a
// rough cold→hot / dry→wet reading order. Keys, not labels — see
// BIOME_LABEL_KEYS.
export function biomeLegend(): { labelKey: string; rgb: [number, number, number] }[] {
  const order = [
    Biome.Ice,
    Biome.Glacier,
    Biome.Tundra,
    Biome.Alpine,
    Biome.Boreal,
    Biome.ColdDesert,
    Biome.Steppe,
    Biome.Grassland,
    Biome.Woodland,
    Biome.MediterraneanScrub,
    Biome.TemperateForest,
    Biome.TemperateRainforest,
    Biome.Desert,
    Biome.SaltFlat,
    Biome.Savanna,
    Biome.TropicalDryForest,
    Biome.TropicalRainforest,
  ]
  return order.map((id) => ({ labelKey: biomeLabelKey(id), rgb: biomeColor(id) }))
}

// The biome of a Köppen class (docs/design/climate-refinement.md, the table
// agreed 2026-09-28). The class decides the kind; within the temperate and
// continental classes the annual rain and the unevenness of the year still
// decide how closed the canopy is, by the Whittaker thresholds that did it
// before — Köppen does not split forest from grassland there.
// `map` mm/yr, `amp` the seasonal range °C, `season` the monsoon index's
// magnitude (0 even, →1 strongly wet-dry).
export function biomeFromKoppen(id: number, map: number, amp: number, season: number): BiomeId {
  const code = koppenCode(id)
  if (!code) return Biome.Ice
  const T = CLIMATE_TUNING
  switch (code) {
    case 'Af': return Biome.TropicalRainforest
    case 'Am': return Biome.TropicalDryForest
    case 'Aw': case 'As': return map >= T.savannaMaxPrecipMm ? Biome.TropicalDryForest : Biome.Savanna
    case 'BWh': return Biome.Desert
    case 'BWk': return Biome.ColdDesert
    case 'BSh': case 'BSk': return Biome.Steppe
    case 'Csa': case 'Csb': case 'Csc': return Biome.MediterraneanScrub
    case 'ET': return Biome.Tundra
    case 'EF': return Biome.Ice
    case 'Dsc': case 'Dsd': case 'Dwc': case 'Dwd': case 'Dfc': case 'Dfd':
      return map < T.borealMinPrecipMm ? Biome.Tundra : Biome.Boreal
    case 'Cfb': case 'Cfc':
      if (map >= T.temperateForestMaxPrecipMm) return Biome.TemperateRainforest
      return temperateCanopy(map, amp, season)
    default:
      // Cfa, Cw*, Dfa/Dfb, Dwa/Dwb, Dsa/Dsb.
      return temperateCanopy(map, amp, season)
  }
}

// How closed a temperate canopy is: grassland where the rain is short and
// the year harsh or uneven, woodland where it is short and mild or uneven,
// forest otherwise.
function temperateCanopy(map: number, amp: number, season: number): BiomeId {
  const T = CLIMATE_TUNING
  if (map < T.temperateGrasslandMaxPrecipMm) {
    return amp > T.temperateOpenCanopyAmplitudeC || season > T.temperateOpenCanopySeason ? Biome.Grassland : Biome.Woodland
  }
  if (map < T.temperateForestMaxPrecipMm && season > T.temperateWoodlandSeason) return Biome.Woodland
  return Biome.TemperateForest
}

// One cell from its annual figures: twelve synthesized months (koppen.ts),
// their class, the class's biome. `index` is the SIGNED monsoon index (its
// sign is the rain's phase); `north` whether the cell lies in the top
// hemisphere. Scratch arrays passed in, so a raster pass allocates once.
function classifyAnnual(tempC: number, precipMm: number, amp: number, index: number, north: boolean, t: Float64Array, p: Float64Array): { koppen: number; biome: BiomeId } {
  synthesizeMonths(tempC, amp, precipMm, index, north, CLIMATE_TUNING.monsoonSeasonalityFloor, t, p)
  const koppen = classifyKoppen(t, p)
  return { koppen, biome: biomeFromKoppen(koppen, precipMm, amp, Math.abs(index)) }
}

// Biome id per climate cell (Uint8). Land only is classified; ocean → Biome.Ocean.
// Consumes the current-adjusted temperature, annual precipitation, and seasonal
// amplitude (all already on the climate grid).
// Biomes at the WORLD raster's own resolution, not the climate grid's.
//
// The coarse version below decides a 62 km cell from ONE sampled elevation, so
// a massif containing a 3,000 m peak and a 400 m valley becomes whichever the
// centre happened to be. That is why there is no treeline: `Biome.Alpine` is a
// pure elevation test, and at 62 km a mountain is alpine wholesale or not at
// all. The game's own unit of place — a hex tile — is ~1.5 km, so this is 40x
// too coarse exactly where a player looks.
//
// The fix is NOT to run the climate model finer. Temperature bands, winds and
// moisture advection are genuinely regional and the advection is iterative;
// 64x the cells would buy little. But the CLASSIFICATION is pointwise, and
// four of its five inputs are smooth regional fields while the fifth —
// elevation — already exists at full resolution. So this costs one pass.
//
// Temperature is the one input that cannot simply be read from the coarse
// grid: it already carries the lapse correction for its cell's SAMPLED
// elevation (see temperature.ts). Reading it and applying the lapse again for
// the local elevation would count it twice. Undoing the coarse term first is
// exact, because the correction is additive.
//
// ALL FOUR coarse inputs are then INTERPOLATED, not read from the containing
// cell. Nearest-sampling them left a staircase on the 62 km grid, which is what
// the first version of this shipped with and what it looked like: elevation-
// driven boundaries came out organic while everything else stepped along cell
// borders. Measured on the calibration seed — the share of biome boundaries
// sitting exactly on a coarse cell border, against the 12.5% that would land
// there by chance:
//
//   nearest (as shipped)   36.1%   2.88x chance
//   + temperature only     33.9%   2.71x
//   + precipitation only   23.2%   1.85x
//   + monsoon only         33.1%   2.64x
//   + seasonality only     36.1%   2.88x   (zero cells changed)
//   ALL FOUR               12.4%   0.99x   — the grid signature is gone
//
// The lesson is that no single input is "the" culprit: each one steps at its
// own cell borders, so removing one still leaves the others drawing the same
// grid. Precipitation is the largest single contributor and temperature —
// the obvious suspect, since it is the one with an elevation term — is nearly
// irrelevant here, precisely BECAUSE its elevation term is already local.
// Seasonality is inert on this world (it only decides one narrow classify
// branch) and is interpolated anyway, so the four are treated alike rather
// than leaving a trap for whoever next asks why one of them is different.
// Total cost: 6.3% of land cells reclassify. This sharpens boundaries; it is
// not a different climate.
// The coarse temperature field with its own lapse term REMOVED, by the same rule
// computeTemperature applied (dry-basin floors unclamped, everything else
// clamped at sea level). What is left carries no elevation at all — latitude
// band, contrast, the global offset and the coastal SST anomaly, all of which
// are genuinely smooth. That is what makes temperature safe to interpolate:
// blending the raw field would mix in each neighbour cell's own sampled
// elevation and bleed a summit's cold sideways across the valley next to it.
// `elevation` here must be the field computeTemperature ACTUALLY ran on, which
// is not always the field being classified: the worldmap reclassifies on
// amplified terrain that the generator's climate never saw. Undoing the lapse
// against carved elevation would add back more than was subtracted — the bake
// lowers land by ~57 m on average and over 1000 m at worst, so a whole 62 km
// cell would come out a few tenths of a degree, and locally several degrees,
// too warm. Hence the separate parameter on computeBiomesFine.
export function reduceTemperatureToSeaLevel(temperature: Float32Array, elevation: Float32Array, worldWidth: number, worldHeight: number, dryLand?: Uint8Array): Float32Array {
  const out = new Float32Array(RX * RY)
  for (let gy = 0; gy < RY; gy++) {
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      const e = sampleElevationAtCell(elevation, gx, gy, worldWidth, worldHeight)
      const dry = sampleDryLandAtCell(dryLand, gx, gy, worldWidth, worldHeight)
      out[i] = temperature[i] + CLIMATE_TUNING.lapseCPerElevation * (dry ? e - SEA_LEVEL : Math.max(0, e - SEA_LEVEL))
    }
  }
  return out
}

// Bilinear over the LAND corners only. Precipitation, seasonal amplitude and the
// monsoon index all mark ocean with -1, so a plain bilinear would pull that
// sentinel into every coastal land value — the documented reason these were left
// on nearest. Dropping the ocean corners and renormalising the remaining weights
// keeps the sentinel out by construction; with no land corner at all there is
// nothing to blend and the containing cell's own value stands.
function sampleLandBilinear(field: Float32Array, wx: number, wy: number, worldWidth: number, worldHeight: number, fallback: number): number {
  const gx = ((wx + 0.5) / worldWidth) * RX - 0.5
  const gy = ((wy + 0.5) / worldHeight) * RY - 0.5
  const x0 = Math.floor(gx)
  const y0 = Math.floor(gy)
  const fx = gx - x0
  const fy = gy - y0
  const x0m = wrapValue(x0, RX)
  const y0m = wrapValue(y0, RY)
  const x1m = (x0m + 1) % RX
  const y1m = (y0m + 1) % RY
  let sum = 0
  let weight = 0
  const add = (index: number, w: number): void => {
    const v = field[index]
    if (v >= 0) {
      sum += v * w
      weight += w
    }
  }
  add(y0m * RX + x0m, (1 - fx) * (1 - fy))
  add(y0m * RX + x1m, fx * (1 - fy))
  add(y1m * RX + x0m, (1 - fx) * fy)
  add(y1m * RX + x1m, fx * fy)
  return weight > 0 ? sum / weight : fallback
}

export function computeBiomesFine(temperature: Float32Array, precipitation: Float32Array, seasonalAmplitude: Float32Array, monsoonIndex: Float32Array, elevation: Float32Array, worldWidth: number, worldHeight: number, dryLand?: Uint8Array,
  // The sea-level reduction of `temperature`, when the caller classifies a
  // DIFFERENT terrain than the climate was computed on (see
  // reduceTemperatureToSeaLevel). Omitted where the two are the same field,
  // which is the generator's case.
  seaLevelTemperature?: Float32Array,
): Uint8Array {
  const biomes = new Uint8Array(worldWidth * worldHeight)
  const seasonality = seasonalityMagnitude(monsoonIndex)
  const seaLevelTemp = seaLevelTemperature ?? reduceTemperatureToSeaLevel(temperature, elevation, worldWidth, worldHeight, dryLand)
  // An island's climate (climateField.zonalLandMean): its row's land mean.
  const onLand = (i: number): boolean => precipitation[i] >= 0
  const islandPrecip = zonalLandMean(precipitation, onLand)
  const islandAmp = zonalLandMean(seasonalAmplitude, onLand)
  const islandSeason = zonalLandMean(seasonality, onLand)
  const months = new Float64Array(12)
  const rain = new Float64Array(12)
  for (let wy = 0; wy < worldHeight; wy++) {
    const gy = Math.min(RY - 1, Math.floor((wy / worldHeight) * RY))
    const north = (wy + 0.5) / worldHeight < 0.5
    for (let wx = 0; wx < worldWidth; wx++) {
      const world = wy * worldWidth + wx
      const here = elevation[world]
      const dry = !!(dryLand && dryLand[world])
      if (!isLandAt(here, dry)) {
        biomes[world] = Biome.Ocean
        continue
      }
      const gx = Math.min(RX - 1, Math.floor((wx / worldWidth) * RX))
      const cell = gy * RX + gx
      // Sea-level temperature interpolated, THEN this cell's own lapse — so the
      // regional part is smooth while the elevation term stays strictly local.
      const reduced = sampleBilinearWorld(seaLevelTemp, RX, RY, wx + 0.5, wy + 0.5, worldWidth, worldHeight)
      const temp = reduced - CLIMATE_TUNING.lapseCPerElevation * (dry ? here - SEA_LEVEL : Math.max(0, here - SEA_LEVEL))
      const precip = sampleLandBilinear(precipitation, wx, wy, worldWidth, worldHeight, islandPrecip[gy])
      const amp = sampleLandBilinear(seasonalAmplitude, wx, wy, worldWidth, worldHeight, islandAmp[gy])
      // The index is blended as a magnitude (neighbours across the rain
      // belt carry opposite signs, and blending them would read an even
      // year exactly where the wet-dry savanna lives); its sign, the phase,
      // is the containing cell's.
      const season = sampleLandBilinear(seasonality, wx, wy, worldWidth, worldHeight, islandSeason[gy])
      const index = monsoonIndex[cell] < 0 ? -season : season
      const base = classifyAnnual(temp, precip, amp, index, north, months, rain).biome
      biomes[world] = here > CLIMATE_TUNING.alpineTreelineElevation && base !== Biome.Ice ? Biome.Alpine : base
    }
  }
  return biomes
}

export function computeBiomes(temperature: Float32Array, precipitation: Float32Array, seasonalAmplitude: Float32Array, monsoonIndex: Float32Array, elevation: Float32Array, worldWidth: number, worldHeight: number, dryLand?: Uint8Array): Uint8Array {
  const biomes = new Uint8Array(RX * RY)
  const months = new Float64Array(12)
  const rain = new Float64Array(12)
  for (let gy = 0; gy < RY; gy++) {
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      const cellElevation = sampleElevationAtCell(elevation, gx, gy, worldWidth, worldHeight)
      if (!isLandAtCell(elevation, dryLand, gx, gy, worldWidth, worldHeight)) {
        biomes[i] = Biome.Ocean
        continue
      }
      const base = classifyAnnual(temperature[i], precipitation[i], seasonalAmplitude[i], monsoonIndex[i], shiftedYNorm(gy, RY, 0) < 0.5, months, rain).biome
      biomes[i] = cellElevation > CLIMATE_TUNING.alpineTreelineElevation && base !== Biome.Ice ? Biome.Alpine : base
    }
  }
  return biomes
}

// The Köppen class per climate cell from the annual figures (synthesized
// months, as computeBiomes classifies); 0 on the sea. The layer's field
// before the climate step's refinement, and the history's.
export function computeKoppenField(temperature: Float32Array, precipitation: Float32Array, seasonalAmplitude: Float32Array, monsoonIndex: Float32Array, elevation: Float32Array, worldWidth: number, worldHeight: number, dryLand?: Uint8Array): Uint8Array {
  const out = new Uint8Array(RX * RY)
  const months = new Float64Array(12)
  const rain = new Float64Array(12)
  for (let gy = 0; gy < RY; gy++) {
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      if (!isLandAtCell(elevation, dryLand, gx, gy, worldWidth, worldHeight)) continue
      out[i] = classifyAnnual(temperature[i], precipitation[i], seasonalAmplitude[i], monsoonIndex[i], shiftedYNorm(gy, RY, 0) < 0.5, months, rain).koppen
    }
  }
  return out
}

// The Köppen class per climate cell from real months (the refinement's):
// temperature °C and rain as mm/yr rates, month-major, rain OCEAN_PRECIP on
// the sea, which is where the class stays 0.
export function koppenFromMonths(temperature: Float32Array, precipitation: Float32Array, months: number): Uint8Array {
  const n = RX * RY
  const out = new Uint8Array(n)
  const t = new Float64Array(12)
  const p = new Float64Array(12)
  for (let i = 0; i < n; i++) {
    if (precipitation[i] < 0) continue
    for (let m = 0; m < 12; m++) {
      t[m] = temperature[m * n + i]
      p[m] = precipitation[m * n + i] / months
    }
    out[i] = classifyKoppen(t, p)
  }
  return out
}

// THE REFINEMENT'S BIOMES (build step 5b): from real months rather than
// synthesized ones. `monthsT` °C and `monthsP` mm/yr rates, month-major on
// the climate grid, rain OCEAN_PRECIP on the sea. `precipitation` is the
// annual rain the classification should see — the months' own mean, or the
// hydrology's effective rain (the riparian bonus): each cell's months are
// scaled by its ratio to the months' mean, so the bonus keeps the season's
// shape.

// One cell from its twelve months: the class, then the class's biome, with
// the range and the rain's unevenness read off the same months.
function classifyMonths(t: Float64Array, p: Float64Array): BiomeId {
  const koppen = classifyKoppen(t, p)
  let lo = Infinity
  let hi = -Infinity
  let map = 0
  let top = 0
  for (let m = 0; m < 12; m++) {
    lo = Math.min(lo, t[m])
    hi = Math.max(hi, t[m])
    map += p[m]
    if (m >= 3 && m < 9) top += p[m]
  }
  // The monsoon index's magnitude, from the two halves of the year as
  // monsoon.ts defines it (the floor keeps an arid year from reading uneven).
  const season = Math.abs(top - (map - top)) / (map + CLIMATE_TUNING.monsoonSeasonalityFloor / 2)
  return biomeFromKoppen(koppen, map, hi - lo, season)
}

// The months scaled to `precipitation`'s annual total, per cell; the sea
// keeps its mark.
function scaledMonths(monthsP: Float32Array, months: number, precipitation: Float32Array): Float32Array {
  const n = RX * RY
  const out = new Float32Array(monthsP.length)
  for (let i = 0; i < n; i++) {
    if (precipitation[i] < 0 || monthsP[i] < 0) {
      for (let m = 0; m < months; m++) out[m * n + i] = OCEAN_PRECIP
      continue
    }
    let mean = 0
    for (let m = 0; m < months; m++) mean += monthsP[m * n + i] / months
    const k = mean > 0 ? precipitation[i] / mean : 1
    for (let m = 0; m < months; m++) out[m * n + i] = monthsP[m * n + i] * k
  }
  return out
}

// Coarse, per climate cell: the ecology's and the cover's biomes.
export function computeBiomesFromMonths(monthsT: Float32Array, monthsP: Float32Array, months: number, precipitation: Float32Array, elevation: Float32Array, worldWidth: number, worldHeight: number, dryLand?: Uint8Array): Uint8Array {
  const n = RX * RY
  const rain = scaledMonths(monthsP, months, precipitation)
  const biomes = new Uint8Array(n)
  const t = new Float64Array(12)
  const p = new Float64Array(12)
  for (let gy = 0; gy < RY; gy++) {
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      if (!isLandAtCell(elevation, dryLand, gx, gy, worldWidth, worldHeight) || rain[i] < 0) {
        biomes[i] = Biome.Ocean
        continue
      }
      for (let m = 0; m < 12; m++) {
        t[m] = monthsT[m * n + i]
        p[m] = rain[m * n + i] / months
      }
      const base = classifyMonths(t, p)
      const cellElevation = sampleElevationAtCell(elevation, gx, gy, worldWidth, worldHeight)
      biomes[i] = cellElevation > CLIMATE_TUNING.alpineTreelineElevation && base !== Biome.Ice ? Biome.Alpine : base
    }
  }
  return biomes
}

// Fine, per world pixel, as computeBiomesFine does from annual figures: each
// month's temperature reduced to sea level, interpolated, given this pixel's
// own lapse; each month's rain interpolated over the land corners only.
// `annualTemperature` is the months' mean, which carries the coarse lapse the
// reduction removes (the lapse is the same in every month).
export function computeBiomesFineFromMonths(monthsT: Float32Array, monthsP: Float32Array, months: number, annualTemperature: Float32Array, precipitation: Float32Array, elevation: Float32Array, worldWidth: number, worldHeight: number, dryLand?: Uint8Array): Uint8Array {
  const n = RX * RY
  const lapseBack = reduceTemperatureToSeaLevel(annualTemperature, elevation, worldWidth, worldHeight, dryLand)
  const seaT = new Float32Array(monthsT.length)
  for (let m = 0; m < months; m++) {
    for (let i = 0; i < n; i++) seaT[m * n + i] = monthsT[m * n + i] + (lapseBack[i] - annualTemperature[i])
  }
  const rain = scaledMonths(monthsP, months, precipitation)
  // An island's climate (climateField.zonalLandMean): each month's rain
  // over its row's land.
  const islandRain = Array.from({ length: months }, (_, m) => zonalLandMean(rain, (i) => rain[m * n + i] >= 0, m * n))
  const biomes = new Uint8Array(worldWidth * worldHeight)
  const t = new Float64Array(12)
  const p = new Float64Array(12)
  const corners = [0, 0, 0, 0]
  const weights = [0, 0, 0, 0]
  for (let wy = 0; wy < worldHeight; wy++) {
    const fy = ((wy + 0.5) / worldHeight) * RY - 0.5
    const y0 = Math.floor(fy)
    const ty = fy - y0
    const r0 = wrapValue(y0, RY) * RX
    const r1 = wrapValue(y0 + 1, RY) * RX
    for (let wx = 0; wx < worldWidth; wx++) {
      const world = wy * worldWidth + wx
      const here = elevation[world]
      const dry = !!(dryLand && dryLand[world])
      if (!isLandAt(here, dry)) {
        biomes[world] = Biome.Ocean
        continue
      }
      const fx = ((wx + 0.5) / worldWidth) * RX - 0.5
      const x0 = Math.floor(fx)
      const tx = fx - x0
      const c0 = wrapValue(x0, RX)
      const c1 = wrapValue(x0 + 1, RX)
      corners[0] = r0 + c0; corners[1] = r0 + c1; corners[2] = r1 + c0; corners[3] = r1 + c1
      weights[0] = (1 - tx) * (1 - ty); weights[1] = tx * (1 - ty); weights[2] = (1 - tx) * ty; weights[3] = tx * ty
      // Land corners for the rain; with none, the island's (its row's land).
      let landWeight = 0
      for (let k = 0; k < 4; k++) if (rain[corners[k]] >= 0) landWeight += weights[k]
      const lapse = CLIMATE_TUNING.lapseCPerElevation * (dry ? here - SEA_LEVEL : Math.max(0, here - SEA_LEVEL))
      const nearest = Math.min(RY - 1, Math.floor((wy / worldHeight) * RY)) * RX + Math.min(RX - 1, Math.floor((wx / worldWidth) * RX))
      for (let m = 0; m < 12; m++) {
        const base = m * n
        t[m] = seaT[base + corners[0]] * weights[0] + seaT[base + corners[1]] * weights[1] + seaT[base + corners[2]] * weights[2] + seaT[base + corners[3]] * weights[3] - lapse
        let sum = 0
        if (landWeight > 0) {
          for (let k = 0; k < 4; k++) if (rain[corners[k]] >= 0) sum += rain[base + corners[k]] * weights[k]
          sum /= landWeight
        } else {
          sum = islandRain[m][Math.floor(nearest / RX)]
        }
        p[m] = sum / months
      }
      const cls = classifyMonths(t, p)
      biomes[world] = here > CLIMATE_TUNING.alpineTreelineElevation && cls !== Biome.Ice ? Biome.Alpine : cls
    }
  }
  return biomes
}
