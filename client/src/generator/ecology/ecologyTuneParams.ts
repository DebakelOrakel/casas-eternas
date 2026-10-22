import { SLOPE_RECALIBRATION } from '../elevation/elevationScale'

// The two tables above are tuning too, and they are DELIBERATELY not folded into
// the object below. Spreading them in (flattened per biome id) would give the
// object an index signature, and TypeScript would then accept `ECOLOGY_TUNING.wArble`
// as a number instead of flagging the typo — the compile-time check that makes a
// rename of this size safe in the first place. So the gap is stated rather than
// hidden: whatever eventually hashes ecology's tuning must flatten these two in.
// (The amplification's constants are what silent omission looks like — see the engine's surface/amplify.rs.)

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

  // Fish tuning (the engine's `prepare_ecology`). A sea's richness = a base + the shelf share
  // + the upwelling + the winter mixing, each weighted; freshwater = big
  // rivers + lake presence. The upwelling counts in full at
  // `fishUpwellingFull` (the refinement's units: at 3 it cools the sea by
  // its full 6 °C, climateTuneParams.upwellingMaxCoolingC). The mixing is
  // full from `fishMixFullC` down to `fishMixIceC`, gone at `fishMixWarmC`
  // and `fishMixIceSpanC` below the ice. Shelf: sea to `fishShelfDepthM`.
  // A coast reaches the sea in full where `fishFullSeaShare` of the land
  // within `coastReachM` is sea (a straight coast; it was 3 of a climate
  // cell's 8 neighbours before the fields went per pixel).
  // Measured on Earth (scratch run of the refined climate, 2026-09-29), nine
  // rich fishing coasts (Lima, Walvis Bay, Agadir, Monterey, Bergen,
  // St John's, Hokkaido, Aberdeen, Reykjavik) against six poor ones (Jeddah,
  // Kingston, Athens, Perth, Darwin, Mombasa): with the current speed as the
  // upwelling and the sea's share around the cell as the reach, 0.20
  // against 0.17 (×1.2; Kingston 0.30, Lima 0.13). Now 0.28 against 0.12
  // (×2.3; Lima 0.38, Walvis Bay 0.35, Kingston 0.08), the coasts' mean
  // 0.14 → 0.16. Left: Athens 0.25 (the Mediterranean is poor from its
  // circulation, which this does not know) and Agadir 0.10 (the refined
  // wind gives Morocco no upwelling). Per pixel (the same day, the value at
  // the place itself): 0.28 against 0.14 (×2.05) with the shelf as its
  // share within reach; as a shelf pixel anywhere within reach ×1.55 (every
  // warm coast has some shelf).
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
  fishFullSeaShare: 3 / 8,
  // The reaches of the per-pixel rule (docs/decisions/ecology-as-function.md),
  // metres: the sea a coast fishes and makes salt from, and the shelf it
  // counts; the water a field or a herd reaches (a river, a lake, a well,
  // an oasis); the land whose biomes make an edge for game. Set, not
  // measured: a day's walk to the sea, a pixel to the water, two pixels of
  // edge.
  coastReachM: 30000,
  waterReachM: 8000,
  ecotoneReachM: 16000,
  // Placer gold's reach from a river (its gravels and terraces), bog iron's
  // waterlogged ground (the water table within `wetlandTableM` of the
  // surface) at `wetlandTableW` of a river's wet ground, and the stream
  // below which a river neither feeds fish nor waters a field (`riverFloor`,
  // √ of its share of the largest discharge: every pixel has some).
  // Measured on the three golden worlds (2026-09-29), against the means per
  // climate cell before the fields went per pixel (iron 0.079, 0.063,
  // 0.073; gold 0.019, 0.023, 0.039): per pixel with the water a pixel away
  // iron 0.033, 0.023, 0.028 and gold 0.007, 0.008, 0.014 (bog iron and
  // placer gold became strips). The placer at 24 km gold 0.016, 0.020,
  // 0.034, at 30 km 0.020, 0.026, 0.044. Bog iron on waterlogged ground in
  // full 0.35 (the table reaches the surface on much of the land); a wider
  // floodplain instead (24, 40 km) 0.040–0.056; the ground at 0.15 iron
  // 0.079, 0.066, 0.062. The river floor on Earth (scratch run, the same
  // day): the land with a trace of fish (0–5 %) 72 → 13 %.
  placerReachM: 30000,
  wetlandTableM: 0,
  wetlandTableW: 0.15,
  riverFloor: 0.05,
  fishRiverW: 0.6,
  fishLakeW: 0.5,

  // Arable (the engine's `prepare_ecology`): the coldest month that still grows, °C; a big
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
  // Water in dry land (the engine's `prepare_ecology`): an oasis
  // waters its cell's fields as a big river does (`oasisW`); a herd drinks
  // where the water table lies within `wellDepthM` (a hand-dug well), the
  // cell's share of it × `wellW`; below `pastureDryMm` of rain the grazing
  // is lost toward `pastureDryFullMm` where there is no such water.
  // Measured on the three golden worlds (2026-09-29): the oases (37, 16
  // and 2) add 15, 5 and 1 farmed cells to 1176, 180 and 149 dry ones
  // (below 250 mm). The hydrogeology puts the table within 30 m on some
  // 60–80 % of the dry land (along its wadis), so the dry land keeps most
  // of its grazing: its pasture 0.12–0.15 with the wells, 0.04–0.06
  // without; the worlds' mean pasture −2 to −3 %. Wells as irrigation
  // were tried first: at 0.3 of a river's water they made two thirds of
  // the dry land farmland (365 → 775 of 1176 cells above 0.1).
  oasisW: 1,
  wellDepthM: 30,
  wellW: 1,
  pastureDryMm: 400,
  pastureDryFullMm: 100,

  // Arable flatness sensitivity: steeper ground is progressively harder to farm.
  // Scaled by SLOPE_RECALIBRATION (see elevationScale.ts): flatness reads raw
  // elevation differences, which halved, so without this every slope on the map
  // would suddenly count as farmable. Read per node as the rise across
  // `flatnessRunM` — the climate cell's length the slope was set on (the
  // torus's 62.4 km, a pixel's rise × 8 on the 2048 raster before DEC-0036
  // phase 7); used for arable, wetland and flint.
  slopeK: 8 * SLOPE_RECALIBRATION,
  flatnessRunM: 62_400,

  // Ecotone (biome-boundary) game bonus and its cap.
  ecotoneBonus: 0.18,
  // The share of edge at which it counts in full: per pixel, the share of
  // its four neighbours of another biome, averaged within `ecotoneReachM`.
  // On the terrain mesh (DEC-0036 phase 7) the boundary's length per area
  // in the unit a raster of `ecotoneCountedOnM` pixels counted it in — the
  // 7.8 km pixel the share was set on (the engine's
  // `boundary_density`) — so the figure does not move with the mesh's spacing.
  // (Before the fields went per pixel: the share of a climate cell's fine
  // neighbour pairs; one straight border through the cell was some 0.06.
  // Per pixel the land's game mean stays 0.21.) Measured on Earth
  // (scratch run of the refined climate, 2026-09-29): game's land mean
  // 0.233 (annual means, coarse edges) → 0.210 (months, fine edges), 9 % of
  // the cells move by more than 0.1; with the fine biomes' mean pasture
  // and timber keep their means (0.240 → 0.234, 0.289 → 0.296) and move by
  // more than 0.1 on 10 and 12 % of the cells, at the biomes' borders (the
  // Congo's rim: timber 0.20 → 0.42, pasture 0.90 → 0.66).
  ecotoneFullShare: 0.1,
  ecotoneCountedOnM: 7_800,

  // Metal / stone influence radii (σ of the halo, metres; until DEC-0036
  // phase 7 a fraction of the smaller world dimension: × 1024 pixels of
  // 7.8 km, the torus's — copper 0.02, tin 0.019, obsidian 0.015, gold's
  // lode 0.015, silver 0.018, gems 0.014, the volcanic province 0.05; not
  // recalibrated). Tin is tightest → the rare,
  // clustered bottleneck; copper broader (arc belts); obsidian tight (point sources).
  // Halved 2026-08-07: since supercontinent assembly moved into the playable window
  // the feature set carries ~3.5× more volcanoes (192 vs 55 measured), and the old
  // radii (~240-320 km per point) overlapped into a carpet — copper covered 55% of
  // land at ≥5%. Radius halving plus the keep-fraction lottery below brings that
  // back to isolated deposit clusters (same-seed ≥5%-of-land coverage: copper
  // 55→18%, silver 49→7%, tin 29→6%, gems 24→5%, gold 70→13%, obsidian-driven
  // toolstone ≥20% 53→6%; flint baseline untouched by design).
  copperRadiusM: 159_744,
  tinRadiusM: 151_757,
  obsidianRadiusM: 119_808,
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

  // Salt (the engine's `prepare_ecology`): below this precip (a month's rate where the climate
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
  goldLodeRadiusM: 119_808,
  silverRadiusM: 143_770,
  gemRadiusM: 111_821,

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
  volcanicProvinceRadiusM: 399_360,

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
