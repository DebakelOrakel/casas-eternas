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
