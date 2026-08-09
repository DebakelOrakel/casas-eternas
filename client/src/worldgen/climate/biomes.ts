import { CLIMATE_RES_X, CLIMATE_RES_Y, sampleDryLandAtCell, sampleElevationAtCell } from './climateField'
import { SEA_LEVEL, metersToElevation } from '../elevation/elevationScale'
import { LAPSE_C_PER_ELEVATION } from './temperature'
import { sampleBilinearWorld, wrapValue } from '../core/field'

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
      out[i] = temperature[i] + LAPSE_C_PER_ELEVATION * (dry ? e - SEA_LEVEL : Math.max(0, e - SEA_LEVEL))
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
  const seaLevelTemp = seaLevelTemperature ?? reduceTemperatureToSeaLevel(temperature, elevation, worldWidth, worldHeight, dryLand)
  for (let wy = 0; wy < worldHeight; wy++) {
    const gy = Math.min(RY - 1, Math.floor((wy / worldHeight) * RY))
    for (let wx = 0; wx < worldWidth; wx++) {
      const world = wy * worldWidth + wx
      const here = elevation[world]
      const dry = !!(dryLand && dryLand[world])
      if (here <= SEA_LEVEL && !dry) {
        biomes[world] = Biome.Ocean
        continue
      }
      const gx = Math.min(RX - 1, Math.floor((wx / worldWidth) * RX))
      const cell = gy * RX + gx
      // Sea-level temperature interpolated, THEN this cell's own lapse — so the
      // regional part is smooth while the elevation term stays strictly local.
      const reduced = sampleBilinearWorld(seaLevelTemp, RX, RY, wx + 0.5, wy + 0.5, worldWidth, worldHeight)
      const temp = reduced - LAPSE_C_PER_ELEVATION * (dry ? here - SEA_LEVEL : Math.max(0, here - SEA_LEVEL))
      const precip = sampleLandBilinear(precipitation, wx, wy, worldWidth, worldHeight, precipitation[cell])
      const amp = sampleLandBilinear(seasonalAmplitude, wx, wy, worldWidth, worldHeight, seasonalAmplitude[cell])
      const season = sampleLandBilinear(monsoonIndex, wx, wy, worldWidth, worldHeight, monsoonIndex[cell])
      const base = classify(temp, precip, amp, season)
      biomes[world] = here > ALPINE_TREELINE_ELEVATION && base !== Biome.Ice ? Biome.Alpine : base
    }
  }
  return biomes
}

export function computeBiomes(temperature: Float32Array, precipitation: Float32Array, seasonalAmplitude: Float32Array, monsoonIndex: Float32Array, elevation: Float32Array, worldWidth: number, worldHeight: number, dryLand?: Uint8Array): Uint8Array {
  const biomes = new Uint8Array(RX * RY)
  for (let gy = 0; gy < RY; gy++) {
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      const cellElevation = sampleElevationAtCell(elevation, gx, gy, worldWidth, worldHeight)
      if (cellElevation <= SEA_LEVEL && !sampleDryLandAtCell(dryLand, gx, gy, worldWidth, worldHeight)) {
        biomes[i] = Biome.Ocean
        continue
      }
      const base = classify(temperature[i], precipitation[i], seasonalAmplitude[i], monsoonIndex[i])
      biomes[i] = cellElevation > ALPINE_TREELINE_ELEVATION && base !== Biome.Ice ? Biome.Alpine : base
    }
  }
  return biomes
}
