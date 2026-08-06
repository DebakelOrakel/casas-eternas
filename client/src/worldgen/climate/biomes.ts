import { CLIMATE_RES_X, CLIMATE_RES_Y, sampleElevationAtCell } from './climateField'
import { SEA_LEVEL, metersToElevation } from '../elevation/elevationScale'

const RX = CLIMATE_RES_X
const RY = CLIMATE_RES_Y

// A Whittaker-style biome set (~11), keyed by mean annual temperature and
// precipitation, with the seasonal amplitude splitting continental grassland
// from milder woodland. Ocean is its own id so the biome layer can skip it.
// See docs/decisions/climate-biomes.md.
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
} as const

type BiomeId = (typeof Biome)[keyof typeof Biome]

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
}

export function biomeColor(id: number): [number, number, number] {
  return BIOME_COLORS[id] ?? [128, 128, 128]
}

// i18n catalog keys for the display names, NOT the names themselves
// (2026-08-06). This module is imported by the simulation worker, so it must
// not pull in the i18n runtime or hold UI language; the screen resolves these
// keys through t(). The catalog side (world.biome.*) already existed — it was
// simply never wired, so the legend and the hover readout stayed English.
const BIOME_LABEL_KEYS: Record<number, string> = {
  [Biome.Ocean]: 'world.biome.ocean',
  [Biome.Ice]: 'world.biome.iceCap',
  [Biome.Tundra]: 'world.biome.tundra',
  [Biome.Boreal]: 'world.biome.borealForest',
  [Biome.Grassland]: 'world.biome.grassland',
  [Biome.Woodland]: 'world.biome.woodland',
  [Biome.TemperateForest]: 'world.biome.temperateForest',
  [Biome.TemperateRainforest]: 'world.biome.temperateRainforest',
  [Biome.Desert]: 'world.biome.desert',
  [Biome.Savanna]: 'world.biome.savanna',
  [Biome.TropicalRainforest]: 'world.biome.tropicalRainforest',
  [Biome.Alpine]: 'world.biome.alpine',
  [Biome.SaltFlat]: 'world.biome.saltFlat',
}

export function biomeLabelKey(id: number): string {
  return BIOME_LABEL_KEYS[id] ?? 'world.biome.unknown'
}

// Land biomes (excludes Ocean) as {labelKey, rgb} for the overlay legend, in a
// rough cold→hot / dry→wet reading order. Keys, not labels — see
// BIOME_LABEL_KEYS.
export function biomeLegend(): { labelKey: string; rgb: [number, number, number] }[] {
  const order = [
    Biome.Ice,
    Biome.Tundra,
    Biome.Alpine,
    Biome.Boreal,
    Biome.Grassland,
    Biome.Woodland,
    Biome.TemperateForest,
    Biome.TemperateRainforest,
    Biome.Desert,
    Biome.SaltFlat,
    Biome.Savanna,
    Biome.TropicalRainforest,
  ]
  return order.map((id) => ({ labelKey: biomeLabelKey(id), rgb: biomeColor(id) }))
}

// The alpine override, promised by docs/decisions/climate-biomes.md ("plus ...
// an alpine override above the treeline") but never built until 2026-08-06: a
// mountain's cold-elevation biome used to fall out of the lapse rate alone —
// which classifies it as Tundra, exactly the same id/color/label as arctic
// lowland tundra. That is not wrong ecologically (a real snowline zone reads
// similarly whether it got cold from latitude or elevation), but it meant an
// equatorial snow-capped peak and a polar plain were visually and
// mechanically indistinguishable — the elevation was invisible to gameplay.
//
// A single global elevation threshold (not latitude-dependent) is the whole
// point of the override: real treeline elevation DOES fall with latitude, but
// reproducing that here would just re-derive what the lapse-rate-driven T/P
// classification already gives — the useful, DIFFERENT signal is "is this
// high ground, regardless of where on the planet it is", so a fixed metres
// threshold is what actually answers that. 2800 m sits within the commonly
// cited real-world treeline range (roughly 2500-3800 m depending on
// latitude/region) as a single representative value.
//
// A cell that would already classify as Ice (T < -10°C — a true glaciated
// summit) is left alone: Alpine means "bare rock / sparse cold-adapted
// vegetation above the treeline", not "less ice than Ice" — a permanently
// glaciated peak should still read as ice, elevation or not.
const ALPINE_TREELINE_ELEVATION = metersToElevation(2800)

// Classify one cell. T = mean annual °C, P = annual precip mm/yr, amp = seasonal
// TEMPERATURE amplitude °C, season = monsoon / precipitation-SEASONALITY index (0 =
// even year-round, →1 = strong wet-dry / monsoonal; see monsoon.ts). Aridity is
// implicit in the T bands (hotter needs more water to escape desert). The season axis
// is what separates evergreen forest (rain spread through the year) from open wet-dry
// vegetation (savanna, seasonal woodland) at the SAME annual total — the classic
// monsoon boundary. Thresholds are the tunable part of the Whittaker mapping.
function classify(tempC: number, precipMm: number, amplitude: number, season: number): BiomeId {
  if (tempC < -10) return Biome.Ice
  if (tempC < 0) return Biome.Tundra
  if (tempC < 7) {
    return precipMm < 200 ? Biome.Tundra : Biome.Boreal
  }
  if (tempC < 20) {
    // Temperate / subtropical. Strong precip seasonality opens the canopy: a marginal
    // forest with a pronounced dry season reads as woodland/grassland, not closed forest.
    if (precipMm < 250) return Biome.Desert
    if (precipMm < 600) return amplitude > 20 || season > 0.3 ? Biome.Grassland : Biome.Woodland
    if (precipMm < 1500) return season > 0.4 ? Biome.Woodland : Biome.TemperateForest
    return Biome.TemperateRainforest
  }
  // Hot (T ≥ 20). The tropical rainforest↔savanna split is driven by SEASONALITY, not
  // just the annual total: evergreen rainforest needs rain most of the year; a strong
  // wet-dry rhythm (monsoon) gives savanna even when the annual total is high.
  if (precipMm < 250) return Biome.Desert
  if (precipMm < 600) return Biome.Savanna
  return season > 0.45 ? Biome.Savanna : Biome.TropicalRainforest
}

// Biome id per climate cell (Uint8). Land only is classified; ocean → Biome.Ocean.
// Consumes the current-adjusted temperature, annual precipitation, and seasonal
// amplitude (all already on the climate grid).
export function computeBiomes(temperature: Float32Array, precipitation: Float32Array, seasonalAmplitude: Float32Array, monsoonIndex: Float32Array, elevation: Float32Array, worldWidth: number, worldHeight: number): Uint8Array {
  const biomes = new Uint8Array(RX * RY)
  for (let gy = 0; gy < RY; gy++) {
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      const cellElevation = sampleElevationAtCell(elevation, gx, gy, worldWidth, worldHeight)
      if (cellElevation <= SEA_LEVEL) {
        biomes[i] = Biome.Ocean
        continue
      }
      const base = classify(temperature[i], precipitation[i], seasonalAmplitude[i], monsoonIndex[i])
      biomes[i] = cellElevation > ALPINE_TREELINE_ELEVATION && base !== Biome.Ice ? Biome.Alpine : base
    }
  }
  return biomes
}
