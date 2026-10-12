import { classifyKoppen, koppenCode, synthesizeMonths } from './koppen'
import { CLIMATE_TUNING } from './climateTuneParams'
import type { ClimatePoints, PointClimate } from './climatePoints'
import type { Domain } from '../core/domain'

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

// THE BIOMES AT POINTS (DEC-0036 phase 7): the Köppen class and the biome
// of every land point of a climate sampled there (climatePoints.
// climateAtPoints) — the terrain mesh's nodes for the world, the climate
// mesh's own cells for the Planet step's preview. Pointwise: each point's
// temperature carries its OWN lapse (the climate's sea-level field less the
// point's height), its rain the land corners of its triangle, so a treeline
// follows the relief and no boundary steps along a grid. With the
// refinement's months the class is the months' (classifyMonths); without,
// the annual figures' twelve synthesized months (classifyAnnual). Above
// the treeline every class but Ice is Alpine. Sea points: Ocean, class 0.
//
// `precipitation` overrides the climate's annual rain (the hydrology's
// effective rain, the riparian bonus: hydrology.riparianPrecipitationOn);
// each month is then scaled by its ratio to the months' mean, so the bonus
// keeps the season's shape. The class is always the climate's own rain's.
export interface PointBiomes {
  biome: Uint8Array
  koppen: Uint8Array
}

export function classifyPoints(climate: PointClimate, points: ClimatePoints, domain: Domain, precipitation?: ArrayLike<number>): PointBiomes {
  const n = points.count
  const biome = new Uint8Array(n)
  const koppen = new Uint8Array(n)
  const t = new Float64Array(12)
  const p = new Float64Array(12)
  const tSynth = new Float64Array(12)
  const pSynth = new Float64Array(12)
  const months = climate.months
  const height = points.height
  for (let i = 0; i < n; i++) {
    if (points.alive && !points.alive[i]) continue
    if (!points.land[i]) {
      biome[i] = Biome.Ocean
      continue
    }
    const rain = climate.precipitation[i]
    const effective = precipitation ? precipitation[i] : rain
    let base: BiomeId
    if (months) {
      let mean = 0
      for (let m = 0; m < months.count; m++) mean += Math.max(0, months.precipitation[m * n + i]) / months.count
      const scale = mean > 0 && effective >= 0 ? effective / mean : 1
      for (let m = 0; m < 12; m++) {
        t[m] = months.temperature[m * n + i]
        p[m] = Math.max(0, months.precipitation[m * n + i]) / months.count
      }
      koppen[i] = classifyKoppen(t, p)
      if (scale !== 1) for (let m = 0; m < 12; m++) p[m] *= scale
      base = classifyMonths(t, p)
    } else {
      const north = domain.north(points.y[i] / domain.height)
      const amp = climate.seasonalAmplitude[i]
      const index = climate.monsoonIndex[i]
      const own = classifyAnnual(climate.temperature[i], Math.max(0, rain), amp, index, north, tSynth, pSynth)
      koppen[i] = own.koppen
      base = effective === rain ? own.biome : classifyAnnual(climate.temperature[i], Math.max(0, effective), amp, index, north, tSynth, pSynth).biome
    }
    biome[i] = height[i] > CLIMATE_TUNING.alpineTreelineElevation && base !== Biome.Ice ? Biome.Alpine : base
  }
  return { biome, koppen }
}
