import { Biome } from '../climate/biomes'
import { SLOPE_RECALIBRATION } from '../elevation/elevationScale'

// Algorithm tuning for the ecology layer — how strongly each input weighs, how
// far a deposit reaches, how much of a resource survives its keep-fraction.
// NOT user inputs: the three ecology sliders (carrying capacity, concentration,
// province strength) reach the module as `EcologyParams` and belong in an
// xyInputParams declaration, not here.
//
// One object, read directly as `ECOLOGY_TUNING.wArable` — see the module
// contract in client/src/generator/CLAUDE.md for why both halves of that matter.
//
// `slopeK` is stored DERIVED (`8 * SLOPE_RECALIBRATION`) so a change to the
// shared recalibration moves it too, and a hash over this object notices.

// Every biome id, and every one except Ocean — derived from the Biome table
// rather than restated, so the two tables below are EXHAUSTIVE by type: adding a
// biome to climate/biomes.ts becomes a compile error here instead of a silent
// default at runtime. `Record<number, number>`, which these used to be, accepted
// any key and demanded none.
type BiomeId = (typeof Biome)[keyof typeof Biome]
export type LandBiomeId = Exclude<BiomeId, typeof Biome.Ocean>

// How suitable each biome is for grazing (pasture). Open grassland/savanna best;
// dense forest and ice worst; tundra/steppe support thin herding.
export const PASTURE_BY_BIOME: Record<LandBiomeId, number> = {
  [Biome.Grassland]: 1.0,
  [Biome.Savanna]: 0.9,
  [Biome.Woodland]: 0.55,
  [Biome.Tundra]: 0.35,
  [Biome.TemperateForest]: 0.2,
  [Biome.TemperateRainforest]: 0.12,
  [Biome.Boreal]: 0.15,
  [Biome.Desert]: 0.12,
  [Biome.TropicalRainforest]: 0.06,
  [Biome.Ice]: 0.0,
  // Alpine meadows above the treeline support real (seasonal/transhumance)
  // grazing — comparable to tundra, not to bare ice.
  [Biome.Alpine]: 0.3,
  // A salt crust grows nothing.
  [Biome.SaltFlat]: 0.0,
  // Neither does a frozen lake.
  [Biome.Glacier]: 0.0,
  // The Köppen biomes (2026-09-28), set between their neighbours: the
  // steppe is the herders' ground, the scrub feeds goats and sheep, the dry
  // forest opens in its dry season, the cold desert barely feeds anything.
  [Biome.Steppe]: 0.85,
  [Biome.MediterraneanScrub]: 0.5,
  [Biome.TropicalDryForest]: 0.35,
  [Biome.ColdDesert]: 0.15,
}

// How much usable timber each biome yields (forests high, open/cold low).
export const TIMBER_BY_BIOME: Record<LandBiomeId, number> = {
  [Biome.TropicalRainforest]: 1.0,
  [Biome.TemperateRainforest]: 0.9,
  [Biome.TemperateForest]: 0.85,
  [Biome.Boreal]: 0.8,
  [Biome.Woodland]: 0.5,
  [Biome.Savanna]: 0.2,
  [Biome.Grassland]: 0.1,
  [Biome.Tundra]: 0.05,
  [Biome.Desert]: 0.02,
  [Biome.Ice]: 0.0,
  // Above the treeline by definition — no timber.
  [Biome.Alpine]: 0.0,
  [Biome.SaltFlat]: 0.0,
  [Biome.Glacier]: 0.0,
  // The Köppen biomes: the dry forest nearly a forest, the scrub a low
  // woodland, the steppe and the cold desert next to nothing.
  [Biome.TropicalDryForest]: 0.7,
  [Biome.MediterraneanScrub]: 0.25,
  [Biome.Steppe]: 0.05,
  [Biome.ColdDesert]: 0.02,
}

// The two tables above are tuning too, and they are DELIBERATELY not folded into
// the object below. Spreading them in (flattened per biome id) would give the
// object an index signature, and TypeScript would then accept `ECOLOGY_TUNING.wArble`
// as a number instead of flagging the typo — the compile-time check that makes a
// rename of this size safe in the first place. So the gap is stated rather than
// hidden: whatever eventually hashes ecology's tuning must flatten these two in.
// (AMPLIFY_CONSTANTS is what silent omission looks like — see surface/amplify.ts.)

export const ECOLOGY_TUNING = {
  // Weights of each subsistence source in the saturating carrying-capacity combine
  // (arable dominant — farming supports the densest populations). Kept LOW enough
  // that the combine (1 - e^-Σw·x) doesn't saturate near 1 for ordinary land — so
  // carrying capacity spreads across the whole ramp (desert ~0.1 … rich coast
  // ~0.8) instead of everything reading as lush green, which was hiding both the
  // level knob and the province mottling. Recalibrated 2026-07-26.
  wArable: 1.1,
  wFish: 0.6,
  wGame: 0.45,
  wPasture: 0.35,

  // Fish tuning (computeFish). A sea's richness = a base + the shelf share
  // + the upwelling + the winter mixing, each weighted; freshwater = big
  // rivers + lake presence. The upwelling counts in full at
  // `fishUpwellingFull` (the refinement's units: at 3 it cools the sea by
  // its full 6 °C, climateTuneParams.upwellingMaxCoolingC). The mixing is
  // full from `fishMixFullC` down to `fishMixIceC`, gone at `fishMixWarmC`
  // and `fishMixIceSpanC` below the ice. Shelf: sea to `fishShelfDepthM`.
  // A coast reaches the sea in full with `fishFullSeaNeighbours` of its 8
  // neighbours sea (a straight coast).
  // Measured on Earth (scratch run of the refined climate, 2026-09-29), nine
  // rich fishing coasts (Lima, Walvis Bay, Agadir, Monterey, Bergen,
  // St John's, Hokkaido, Aberdeen, Reykjavik) against six poor ones (Jeddah,
  // Kingston, Athens, Perth, Darwin, Mombasa): with the current speed as the
  // upwelling and the sea's share around the cell as the reach, 0.20
  // against 0.17 (×1.2; Kingston 0.30, Lima 0.13). Now 0.28 against 0.12
  // (×2.3; Lima 0.38, Walvis Bay 0.35, Kingston 0.08), the coasts' mean
  // 0.14 → 0.16. Left: Athens 0.25 (the Mediterranean is poor from its
  // circulation, which this does not know) and Agadir 0.10 (the refined
  // wind gives Morocco no upwelling).
  fishSeaBase: 0.05,
  fishShelfW: 0.15,
  fishUpwellingW: 0.3,
  fishUpwellingFull: 3,
  fishMixingW: 0.2,
  fishMixFullC: 12,
  fishMixWarmC: 24,
  fishMixIceC: -1,
  fishMixIceSpanC: 6,
  fishShelfDepthM: 200,
  fishFullSeaNeighbours: 3,
  fishRiverW: 0.6,
  fishLakeW: 0.5,

  // Arable (computeArable): the coldest month that still grows, °C; a big
  // river's water on the fields, mm/yr at full flow; the harvest's loss per
  // unit of the rain's variability.
  // Measured on Earth (scratch run of the refined climate with its rivers,
  // 2026-09-29), twelve farmland places (Paris, Des Moines, Ludhiana, Patna,
  // Zhengzhou, Yogyakarta, Milan, Kyiv, Rosario, Tanta, Baghdad, Dhaka)
  // against ten that are not (Tamanrasset, Yakutsk, Calama, Lhasa, Alice
  // Springs, Riyadh, Norilsk, Nuuk, Kashgar, Ulaanbaatar): with the annual
  // means 0.17 against 0.09 (×1.9; Tanta 0.03, Baghdad 0.04). The months
  // alone change little (×1.9), the frost ×2.0, the river's water ×2.5
  // (Tanta 0.31, Baghdad 0.18), the risk ×2.75 (at 1.5 ×2.9, at 2000 mm
  // ×3.0: kept lower, as few places decide it). The land's mean arable
  // 0.139 → 0.109, the carrying capacity 0.386 → 0.346. Ludhiana and Patna
  // stay near 0: the refined climate has no monsoon there.
  arableFrostC: 5,
  arableIrrigationMm: 1000,
  arableRiskW: 1,

  // Arable flatness sensitivity: steeper ground is progressively harder to farm.
  // Scaled by SLOPE_RECALIBRATION (see elevationScale.ts): flatness reads raw
  // elevation differences, which halved, so without this every slope on the map
  // would suddenly count as farmable. Used here and in flatnessAt (wetland, tool
  // stone).
  slopeK: 8 * SLOPE_RECALIBRATION,

  // Ecotone (biome-boundary) game bonus and its cap.
  ecotoneBonus: 0.18,

  // Metal / stone influence radii (world fraction). Tin is tightest → the rare,
  // clustered bottleneck; copper broader (arc belts); obsidian tight (point sources).
  // Halved 2026-08-07: since supercontinent assembly moved into the playable window
  // the feature set carries ~3.5× more volcanoes (192 vs 55 measured), and the old
  // radii (~240-320 km per point) overlapped into a carpet — copper covered 55% of
  // land at ≥5%. Radius halving plus the keep-fraction lottery below brings that
  // back to isolated deposit clusters (same-seed ≥5%-of-land coverage: copper
  // 55→18%, silver 49→7%, tin 29→6%, gems 24→5%, gold 70→13%, obsidian-driven
  // toolstone ≥20% 53→6%; flint baseline untouched by design).
  copperRadiusFrac: 0.02,
  tinRadiusFrac: 0.019,
  obsidianRadiusFrac: 0.015,
  flintBase: 0.15,

  // Mineralisation lottery: only this fraction of the candidate points (arc
  // volcanoes, orogens) actually carries a given ore — not every arc is
  // mineralised. Deterministic per point position + warpSeed + per-resource salt,
  // so each resource picks a different subset and deposits stay stable per world.
  copperKeep: 0.33,
  silverKeep: 0.25,
  obsidianKeep: 0.25,
  tinKeep: 0.5,
  goldLodeKeep: 0.5,
  gemKeep: 0.5,

  // Salt (computeSalt): below this precip (a month's rate where the climate
  // has months) a cell reads arid; coasts evaporate best; a salt flat
  // counts `saltFlatW`.
  // Measured on Earth (scratch run of the refined climate with its rivers
  // and lakes, 2026-09-29), twelve salt works and salt lakes (the Camargue,
  // Trapani, Cádiz, the Rann of Kutch, Tianjin, Swakopmund, Guerrero Negro,
  // the Dead Sea, Death Valley, the Red Sea's coast, Dubai, the Chott el
  // Djerid) against ten wet or cold places without: on the annual means
  // 0.21 against 0.00, the Camargue, Tianjin and the Red Sea's coast 0.
  // Per month 0.27 against 0.01 (the Camargue 0.03, Tianjin 0.09, the Red
  // Sea 0.13; Kutch 1.0 from its salt flat). Tried and dropped: pans only
  // on a flat shore (0.21 → 0.17: the grid's slope is no guide to a
  // shore's lagoons) and the sea's salinity (0.17: the seas differ by a few
  // psu, the climate by far more).
  saltAridPrecip: 500,
  saltCoastW: 1.0,
  saltInteriorW: 0.35,
  saltFlatW: 1,

  // Salt's small bonus to carrying capacity (preservation → denser settlement).
  wSaltCc: 0.15,

  // Iron: broad craton signal + bog-iron in wetlands. Deposit noise breaks the
  // (nearly uniform) craton signal into banded-iron-style deposits, so iron stays
  // common but fluctuates rather than reading as a flat 100%.
  ironCratonW: 0.9,
  ironBogW: 0.7,
  ironDepositFreqX: 13,
  ironDepositFreqY: 7,
  ironDepositFloor: 0.35,

  // Prestige (rare & clustered — the point). Gold = placer (rivers) + lode (orogens);
  // silver = hydrothermal near volcanic arcs; gems = metamorphic (orogens) + arid
  // weathering (turquoise near copper). None feed carrying capacity.
  goldLodeRadiusFrac: 0.015,
  silverRadiusFrac: 0.018,
  gemRadiusFrac: 0.014,

  // Placer gate: √(discharge/max) below this floor carries no gold — only genuinely
  // large rivers concentrate placer. The old ungated √·2 curve lit up every stream
  // (gold ≥5% on 70% of land, and 63% even before the Archean rework).
  goldPlacerSqrtFloor: 0.15,
  goldPlacerGain: 2,
  goldPlacerW: 0.7,
  goldLodeW: 0.9,
  silverW: 0.9,
  gemOrogenW: 0.85,
  gemAridW: 0.6,
  volcanicProvinceRadiusFrac: 0.05,

  // Higher frequency → more mottling (broad smooth gradients read as "no variation").
  // Weights are large because smooth value-noise has LOW variance (interpolation
  // pulls values toward the mean), so it needs a big multiplier to produce visible
  // deviation; the strength knob (0..1) then scales this. Volcanic provinces punch
  // harder than the organic noise.
  provinceNoiseFreqX: 11,
  provinceNoiseFreqY: 6,
  volcanicWeight: 1.6,
  noiseWeight: 1.5,
} as const
