//! The ecology layer's tuning — the weights, reaches, radii and
//! keep-fractions, and the two biome tables. Each value is explained here,
//! with how it was measured. (Until 2026-10-29 the explanations up to
//! 2026-10-22 were in a TypeScript copy, `ecology/ecologyTuneParams.ts`,
//! which nothing ran; it was removed and its comments moved here.)

use crate::climate::biomes::biome;
use crate::elevation::elevation_scale::SLOPE_RECALIBRATION;

/// How suitable each land biome is for grazing; None for the ocean.
pub fn pasture_by_biome(b: u8) -> Option<f64> {
    Some(match b {
        biome::GRASSLAND => 1.0,
        biome::SAVANNA => 0.9,
        biome::WOODLAND => 0.55,
        biome::TUNDRA => 0.35,
        biome::TEMPERATE_FOREST => 0.2,
        biome::TEMPERATE_RAINFOREST => 0.12,
        biome::BOREAL => 0.15,
        biome::DESERT => 0.12,
        biome::TROPICAL_RAINFOREST => 0.06,
        biome::ICE => 0.0,
        biome::ALPINE => 0.3,
        biome::SALT_FLAT => 0.0,
        biome::GLACIER => 0.0,
        biome::STEPPE => 0.85,
        biome::MEDITERRANEAN_SCRUB => 0.5,
        biome::TROPICAL_DRY_FOREST => 0.35,
        biome::COLD_DESERT => 0.15,
        _ => return None,
    })
}

/// How much usable timber each land biome yields; None for the ocean.
pub fn timber_by_biome(b: u8) -> Option<f64> {
    Some(match b {
        biome::TROPICAL_RAINFOREST => 1.0,
        biome::TEMPERATE_RAINFOREST => 0.9,
        biome::TEMPERATE_FOREST => 0.85,
        biome::BOREAL => 0.8,
        biome::WOODLAND => 0.5,
        biome::SAVANNA => 0.2,
        biome::GRASSLAND => 0.1,
        biome::TUNDRA => 0.05,
        biome::DESERT => 0.02,
        biome::ICE => 0.0,
        biome::ALPINE => 0.0,
        biome::SALT_FLAT => 0.0,
        biome::GLACIER => 0.0,
        biome::TROPICAL_DRY_FOREST => 0.7,
        biome::MEDITERRANEAN_SCRUB => 0.25,
        biome::STEPPE => 0.05,
        biome::COLD_DESERT => 0.02,
        _ => return None,
    })
}

/// The tuning. The two biome tables above are tuning too, but they are not
/// in this struct, and `ecology_constants` (the fixture's `tuning` hash)
/// does not hold them; the scenario hashes see them through the fields.
/// (The TypeScript object kept them out so that a misspelt key stayed a
/// compile error: flattened in per biome id, they gave it an index
/// signature. The amplification's constants are what silent omission looks
/// like — see surface/amplify.rs.)
#[derive(Clone, Copy, Debug)]
pub struct EcologyTuning {
    pub w_arable: f64,
    pub w_fish: f64,
    pub w_game: f64,
    pub w_pasture: f64,
    pub fish_sea_base: f64,
    pub fish_shelf_w: f64,
    pub fish_upwelling_w: f64,
    pub fish_upwelling_full: f64,
    pub fish_mixing_w: f64,
    pub fish_mix_full_c: f64,
    pub fish_mix_warm_c: f64,
    pub fish_mix_ice_c: f64,
    pub fish_mix_ice_span_c: f64,
    pub fish_shelf_depth_m: f64,
    pub fish_full_sea_share: f64,
    pub coast_reach_m: f64,
    pub water_reach_m: f64,
    pub ecotone_reach_m: f64,
    pub placer_reach_m: f64,
    pub wetland_table_m: f64,
    pub wetland_table_w: f64,
    pub river_floor: f64,
    pub fish_river_w: f64,
    pub fish_lake_w: f64,
    pub arable_frost_c: f64,
    pub arable_irrigation_mm: f64,
    pub arable_risk_w: f64,
    pub arable_season_months: f64,
    pub crop_temp_mid: f64,
    pub crop_temp_rate: f64,
    pub crop_need_mm: f64,
    pub crop_need_per_c_mm: f64,
    pub crop_need_dry: f64,
    pub crop_need_full: f64,
    pub leach_warm_c: f64,
    pub leach_w: f64,
    pub leach_from_mm: f64,
    pub leach_full_mm: f64,
    pub flood_q_min_m3s: f64,
    pub flood_q_full_m3s: f64,
    pub flood_reach_m: f64,
    pub flood_rise_full_m: f64,
    pub flood_rise_m: f64,
    pub shelf_depth_m: f64,
    pub oasis_w: f64,
    pub well_depth_m: f64,
    pub well_w: f64,
    pub pasture_dry_mm: f64,
    pub pasture_dry_full_mm: f64,
    pub slope_k: f64,
    pub flatness_run_m: f64,
    pub ecotone_bonus: f64,
    pub ecotone_full_share: f64,
    pub ecotone_counted_on_m: f64,
    pub copper_radius_m: f64,
    pub copper_extinct_radius_m: f64,
    pub copper_extinct_w: f64,
    pub tin_radius_m: f64,
    pub obsidian_radius_m: f64,
    pub flint_base: f64,
    pub copper_keep: f64,
    pub copper_extinct_keep: f64,
    pub silver_keep: f64,
    pub obsidian_keep: f64,
    pub tin_keep: f64,
    pub gold_lode_keep: f64,
    pub gem_keep: f64,
    pub salt_arid_precip: f64,
    pub salt_coast_w: f64,
    pub salt_interior_w: f64,
    pub salt_flat_w: f64,
    pub w_salt_cc: f64,
    pub iron_craton_w: f64,
    pub iron_bog_w: f64,
    pub iron_deposit_freq_x: f64,
    pub iron_deposit_freq_y: f64,
    pub iron_deposit_floor: f64,
    pub gold_lode_radius_m: f64,
    pub silver_radius_m: f64,
    pub gem_radius_m: f64,
    pub gold_placer_sqrt_floor: f64,
    pub gold_placer_gain: f64,
    pub gold_placer_w: f64,
    pub gold_lode_w: f64,
    pub silver_w: f64,
    pub gem_orogen_w: f64,
    pub gem_arid_w: f64,
    pub volcanic_province_radius_m: f64,
    pub province_noise_freq_x: f64,
    pub province_noise_freq_y: f64,
    pub volcanic_weight: f64,
    pub noise_weight: f64,
}

pub const ECOLOGY_TUNING: EcologyTuning = EcologyTuning {
    // Weights of each subsistence source in the saturating carrying-capacity
    // combine (1 − e^(−Σ w·x)); arable dominant — farming supports the
    // densest populations. Low enough that the combine does not saturate
    // near 1 for ordinary land, so carrying capacity spreads across the
    // whole ramp (desert ~0.1 … rich coast ~0.8) and does not read as lush
    // green everywhere, which hid both the level knob and the province
    // mottling. Recalibrated 2026-07-26.
    w_arable: 1.1,
    w_fish: 0.6,
    w_game: 0.45,
    w_pasture: 0.35,
    // Fish (`prepare_ecology`). A sea's richness = a base + the shelf share
    // + the upwelling + the winter mixing, each weighted; freshwater = big
    // rivers + lake presence. The upwelling counts in full at
    // `fish_upwelling_full` (the refinement's units: at 3 it cools the sea
    // by its full 6 °C, the climate's upwelling_max_cooling_c). The mixing
    // is full from `fish_mix_full_c` down to `fish_mix_ice_c`, gone at
    // `fish_mix_warm_c` and `fish_mix_ice_span_c` below the ice (`sea_mixing`).
    // Shelf: sea to `fish_shelf_depth_m`. A coast reaches the sea in full
    // where `fish_full_sea_share` of the land within `coast_reach_m` is sea
    // (a straight coast; it was 3 of a climate cell's 8 neighbours before
    // the fields went per pixel).
    // Measured on Earth (scratch run of the refined climate, 2026-09-29),
    // nine rich fishing coasts (Lima, Walvis Bay, Agadir, Monterey, Bergen,
    // St John's, Hokkaido, Aberdeen, Reykjavik) against six poor ones
    // (Jeddah, Kingston, Athens, Perth, Darwin, Mombasa): with the current
    // speed as the upwelling and the sea's share around the cell as the
    // reach, 0.20 against 0.17 (×1.2; Kingston 0.30, Lima 0.13). Now 0.28
    // against 0.12 (×2.3; Lima 0.38, Walvis Bay 0.35, Kingston 0.08), the
    // coasts' mean 0.14 → 0.16. Left: Athens 0.25 (the Mediterranean is
    // poor from its circulation, which this does not know) and Agadir 0.10
    // (the refined wind gives Morocco no upwelling). Per pixel (the same
    // day, the value at the place itself): 0.28 against 0.14 (×2.05) with
    // the shelf as its share within reach; as a shelf pixel anywhere within
    // reach ×1.55 (every warm coast has some shelf).
    fish_sea_base: 0.05,
    fish_shelf_w: 0.15,
    fish_upwelling_w: 0.3,
    fish_upwelling_full: 3.0,
    fish_mixing_w: 0.2,
    fish_mix_full_c: 12.0,
    fish_mix_warm_c: 24.0,
    fish_mix_ice_c: -1.0,
    fish_mix_ice_span_c: 6.0,
    fish_shelf_depth_m: 200.0,
    fish_full_sea_share: 3.0 / 8.0,
    // The reaches of the per-pixel rule (docs/decisions/ecology-as-function.md),
    // metres: the sea a coast fishes and makes salt from, and the shelf it
    // counts; the water a field or a herd reaches (a river, a lake, a well,
    // an oasis); the land whose biomes make an edge for game. Set, not
    // measured: a day's walk to the sea, a pixel to the water, two pixels
    // of edge.
    coast_reach_m: 30000.0,
    water_reach_m: 8000.0,
    ecotone_reach_m: 16000.0,
    // Placer gold's reach from a river (its gravels and terraces), bog
    // iron's waterlogged ground (the water table within `wetland_table_m`
    // of the surface) at `wetland_table_w` of a river's wet ground, and the
    // stream below which a river neither feeds fish nor waters a field
    // (`river_floor`, √ of its share of the largest discharge: every pixel
    // has some).
    // Measured on the three golden worlds (2026-09-29), against the means
    // per climate cell before the fields went per pixel (iron 0.079, 0.063,
    // 0.073; gold 0.019, 0.023, 0.039): per pixel with the water a pixel
    // away iron 0.033, 0.023, 0.028 and gold 0.007, 0.008, 0.014 (bog iron
    // and placer gold became strips). The placer at 24 km gold 0.016,
    // 0.020, 0.034, at 30 km 0.020, 0.026, 0.044. Bog iron on waterlogged
    // ground in full 0.35 (the table reaches the surface on much of the
    // land); a wider floodplain instead (24, 40 km) 0.040–0.056; the ground
    // at 0.15 iron 0.079, 0.066, 0.062. The river floor on Earth (scratch
    // run, the same day): the land with a trace of fish (0–5 %) 72 → 13 %.
    placer_reach_m: 30000.0,
    wetland_table_m: 0.0,
    wetland_table_w: 0.15,
    river_floor: 0.05,
    fish_river_w: 0.6,
    fish_lake_w: 0.5,
    // Arable (`prepare_ecology`): the coldest month that still grows, °C; a
    // big river's water on the fields, mm/yr at full flow; the harvest's
    // loss per unit of the rain's variability.
    // Measured on Earth (scratch run of the refined climate with its
    // rivers, 2026-09-29), twelve farmland places (Paris, Des Moines,
    // Ludhiana, Patna, Zhengzhou, Yogyakarta, Milan, Kyiv, Rosario, Tanta,
    // Baghdad, Dhaka) against ten that are not (Tamanrasset, Yakutsk,
    // Calama, Lhasa, Alice Springs, Riyadh, Norilsk, Nuuk, Kashgar,
    // Ulaanbaatar): with the annual means 0.17 against 0.09 (×1.9; Tanta
    // 0.03, Baghdad 0.04). The months alone change little (×1.9), the frost
    // ×2.0, the river's water ×2.5 (Tanta 0.31, Baghdad 0.18), the risk
    // ×2.75 (at 1.5 ×2.9, at 2000 mm ×3.0: kept lower, as few places decide
    // it). The land's mean arable 0.139 → 0.109, the carrying capacity
    // 0.386 → 0.346. Ludhiana and Patna stay near 0: the refined climate
    // has no monsoon there. (Measured before the crops, DEC-0052.)
    arable_frost_c: 5.0,
    arable_irrigation_mm: 1000.0,
    arable_risk_w: 1.0,
    // THE CROPS (DEC-0052, 2026-10-29). The arable had the wild land's
    // Miami productivity and the mean of the twelve months: a crop field
    // gives one harvest, and on the three worlds of 2026-10-29 (Morvane,
    // Thalassor, Zephyra, level 1) only 10.8 / 15.8 / 5.4 % of the land had
    // 0.3 or more (Earth some 25–30 % of the land is fit to farm; from
    // memory, GAEZ-like). The year is the sum of the months' growth over
    // `arable_season_months` (7: a season, full at seven good months; 6
    // gave 29.6 / 32.3 / 17.5 % and the dry steppes BSh 51 % on Morvane).
    arable_season_months: 7.0,
    // The crop's warmth: a logistic steeper than the wild land's (1.315,
    // 0.119): half at 9.2 °C, 0.90 at 18 °C, 0.98 at 25 °C (the wild
    // land's half at 11 °C, 0.70 at 18 °C, 0.84 at 25 °C): a warm month is
    // a full month for a crop.
    crop_temp_mid: 2.3,
    crop_temp_rate: 0.25,
    // The crop's water: the month's rain and the water on the fields
    // against the crop's need, `crop_need_mm` + `crop_need_per_c_mm` × T
    // (mm/yr, a rate as the months' rain), from `crop_need_dry` × need
    // (nothing) to `crop_need_full` × need (full), a smoothstep. The wild
    // land's 1 − e^(−0.000664 P) gave a desert's 150 mm 0.1 and a crop 0.1
    // there too; the precipitation constant made larger instead (0.0012
    // to 0.002, variants of 2026-10-29) made 14–23 % of Morvane's hot
    // desert BWh rain-fed farmland of 0.3 or more (0.3 % before).
    // 0.4 / 1.2 gave 30.5 / 33.4 / 17.9 %, BSh 60 % on Morvane.
    crop_need_mm: 150.0,
    crop_need_per_c_mm: 30.0,
    crop_need_dry: 0.5,
    crop_need_full: 1.4,
    // The wet tropics' leaching: where the year is `leach_warm_c` or
    // warmer, the arable × (1 − `leach_w` × smoothstep(`leach_from_mm`,
    // `leach_full_mm`, the year's rain)) — Af's oxisols, poor once
    // cleared. It takes the Af land with 0.3 or more from 63 / 80 / 71 % to
    // 48 / 72 / 60 % (the crops' variant of 0.4 / 1.2, a season of 6).
    leach_warm_c: 18.0,
    leach_w: 0.6,
    leach_from_mm: 1500.0,
    leach_full_mm: 2500.0,
    // THE FLOOD SILT (TEG-108, 2026-10-30). A large river floods once a
    // year: the rain season or the snow melt of its upper catchment. The
    // flood soaks its floodplain and leaves fresh silt on it, so the
    // floodplain gives a harvest each year without rain and without fallow,
    // also in a desert: the Nile (some 2 800 m³/s before its dams, a flood
    // some 7 m above the low water at Aswan), the Indus (some 6 600 m³/s),
    // the Tigris and the Euphrates (some 1 000 and 800 m³/s), the Amu Darya
    // (some 1 400 m³/s). The silt (0..1) is the share of a node's land
    // the flood reaches. On that share the crop has its water for the
    // season (only the warmth and the frost limit it), no harvest is lost
    // to the rain's variability, and the silt cancels the tropics'
    // leaching (a várzea is fertile, the terra firme beside it is not).
    // The rest of the node is arable as before.
    // The source: a node of the river graph that is not ephemeral (a wadi
    // has no flood to rely on), its discharge from `flood_q_min_m3s` (no
    // silt) to `flood_q_full_m3s` (full), a smoothstep. The floodplain:
    // the land within `flood_reach_m` of such a node, full up to
    // `flood_rise_full_m` above it, none from `flood_rise_m`, a smoothstep;
    // land below the river (a backswamp, a delta) is full.
    flood_q_min_m3s: 100.0,
    flood_q_full_m3s: 1000.0,
    flood_reach_m: 15000.0,
    flood_rise_full_m: 3.0,
    flood_rise_m: 10.0,
    // THE DRY SHELF (TEG-13, DES-0032 open point 5): the sea floor down to
    // `shelf_depth_m` below the sea is dry land at a glacial maximum (the
    // last one some 120 m; the incubator's SHELF_M). Level 1 holds the
    // ecology of this shelf as land (`dry_shelf`).
    shelf_depth_m: 120.0,
    // Water in dry land (`prepare_ecology`): an oasis waters its cell's
    // fields as a big river does (`oasis_w`); a herd drinks where the water
    // table lies within `well_depth_m` (a hand-dug well), the cell's share
    // of it × `well_w`; below `pasture_dry_mm` of rain the grazing is lost
    // toward `pasture_dry_full_mm` where there is no such water.
    // Measured on the three golden worlds (2026-09-29): the oases (37, 16
    // and 2) add 15, 5 and 1 farmed cells to 1176, 180 and 149 dry ones
    // (below 250 mm). The hydrogeology puts the table within 30 m on some
    // 60–80 % of the dry land (along its wadis), so the dry land keeps most
    // of its grazing: its pasture 0.12–0.15 with the wells, 0.04–0.06
    // without; the worlds' mean pasture −2 to −3 %. Wells as irrigation
    // were tried first: at 0.3 of a river's water they made two thirds of
    // the dry land farmland (365 → 775 of 1176 cells above 0.1).
    oasis_w: 1.0,
    well_depth_m: 30.0,
    well_w: 1.0,
    pasture_dry_mm: 400.0,
    pasture_dry_full_mm: 100.0,
    // Arable flatness sensitivity: steeper ground is progressively harder
    // to farm. Scaled by SLOPE_RECALIBRATION (elevation_scale.rs): flatness
    // reads raw elevation differences, which halved, so without it every
    // slope on the map would count as farmable. Read per node as the rise
    // across `flatness_run_m` — the climate cell's length the slope was set
    // on (the torus's 62.4 km, a pixel's rise × 8 on the 2048 raster before
    // DEC-0036 phase 7); used for arable, wetland and flint.
    slope_k: 8.0 * SLOPE_RECALIBRATION,
    flatness_run_m: 62400.0,
    // Ecotone (biome-boundary) game bonus and its cap.
    ecotone_bonus: 0.18,
    // The share of edge at which it counts in full: per pixel, the share of
    // its four neighbours of another biome, averaged within
    // `ecotone_reach_m`. On the terrain mesh (DEC-0036 phase 7) the
    // boundary's length per area in the unit a raster of
    // `ecotone_counted_on_m` pixels counted it in — the 7.8 km pixel the
    // share was set on (`boundary_density`) — so the figure does not move
    // with the mesh's spacing. (Before the fields went per pixel: the share
    // of a climate cell's fine neighbour pairs; one straight border through
    // the cell was some 0.06. Per pixel the land's game mean stays 0.21.)
    // Measured on Earth (scratch run of the refined climate, 2026-09-29):
    // game's land mean 0.233 (annual means, coarse edges) → 0.210 (months,
    // fine edges), 9 % of the cells move by more than 0.1; with the fine
    // biomes' mean pasture and timber keep their means (0.240 → 0.234,
    // 0.289 → 0.296) and move by more than 0.1 on 10 and 12 % of the
    // cells, at the biomes' borders (the Congo's rim: timber 0.20 → 0.42,
    // pasture 0.90 → 0.66).
    ecotone_full_share: 0.1,
    ecotone_counted_on_m: 7800.0,
    // Metal / stone influence radii (σ of the halo, metres; until DEC-0036
    // phase 7 a fraction of the smaller world dimension: × 1024 pixels of
    // 7.8 km, the torus's — copper 0.02, tin 0.019, obsidian 0.015, gold's
    // lode 0.015, silver 0.018, gems 0.014, the volcanic province 0.05; not
    // recalibrated). Tin is tightest → the rare, clustered bottleneck;
    // copper broader (arc belts); obsidian tight (point sources).
    // Halved 2026-08-07: since supercontinent assembly moved into the
    // playable window the feature set carries ~3.5× more volcanoes (192 vs
    // 55 measured), and the old radii (~240–320 km per point) overlapped
    // into a carpet — copper covered 55 % of land at ≥ 5 %. Radius halving
    // plus the keep-fraction lottery below brings that back to isolated
    // deposit clusters (same-seed ≥ 5 %-of-land coverage: copper 55 → 18 %,
    // silver 49 → 7 %, tin 29 → 6 %, gems 24 → 5 %, gold 70 → 13 %,
    // obsidian-driven toolstone ≥ 20 % 53 → 6 %; flint baseline untouched
    // by design).
    copper_radius_m: 159744.0,
    // THE EXTINCT ARCS' COPPER (DEC-0053, 2026-10-29): an arc's porphyry
    // copper stays when the arc is no longer fed. A halo of σ
    // `copper_extinct_radius_m` about each extinct arc the lottery keeps
    // (`copper_extinct_keep`, a salt of its own), × `copper_extinct_w`;
    // the copper is the larger of it and the active arcs'. Weaker and
    // tighter than an active arc's (eroded, partly buried). Swept on the
    // three worlds of 2026-10-29 (0.7/0.33/110 km, 0.8/0.4/120 km,
    // 0.8/0.5/100 km; the extinct arcs through the map's marker grid):
    // this, "moderate", brought Morvane's copper ≥ 0.6 within 300 km of 9
    // of its 19 arable clusters (1 before), the stronger two 12, at 22–24 %
    // of the land with copper ≥ 0.05 against 18.6 %. Built without the
    // grid (all 949 extinct arcs on Morvane): 27.8 / 14.6 / 5.4 % of the
    // land at 0.05 / 0.3 / 0.6, 21 of the new arable's 26 clusters within
    // 300 km of 0.6 (Thalassor 14.0 / 6.8 / 2.5 %, 2 of 12; Zephyra 13.3 /
    // 6.2 / 2.6 %, 9 of 26). A keep of 0.15 gives the grid's cover back.
    copper_extinct_radius_m: 110000.0,
    copper_extinct_w: 0.7,
    tin_radius_m: 151757.0,
    obsidian_radius_m: 119808.0,
    flint_base: 0.15,
    // Mineralisation lottery: only this fraction of the candidate points
    // (arc volcanoes, orogens) carries a given ore — not every arc is
    // mineralised. Deterministic per point position + warp seed +
    // per-resource salt, so each resource picks a different subset and
    // deposits stay stable per world.
    copper_keep: 0.33,
    copper_extinct_keep: 0.33,
    silver_keep: 0.25,
    obsidian_keep: 0.25,
    tin_keep: 0.5,
    gold_lode_keep: 0.5,
    gem_keep: 0.5,
    // Salt (`prepare_ecology`): below this precipitation (a month's rate
    // where the climate has months) a cell reads arid (`arid_warm`); coasts
    // evaporate best; a salt flat counts `salt_flat_w`.
    // Measured on Earth (scratch run of the refined climate with its rivers
    // and lakes, 2026-09-29), twelve salt works and salt lakes (the
    // Camargue, Trapani, Cádiz, the Rann of Kutch, Tianjin, Swakopmund,
    // Guerrero Negro, the Dead Sea, Death Valley, the Red Sea's coast,
    // Dubai, the Chott el Djerid) against ten wet or cold places without:
    // on the annual means 0.21 against 0.00, the Camargue, Tianjin and the
    // Red Sea's coast 0. Per month 0.27 against 0.01 (the Camargue 0.03,
    // Tianjin 0.09, the Red Sea 0.13; Kutch 1.0 from its salt flat). Tried
    // and dropped: pans only on a flat shore (0.21 → 0.17: the grid's slope
    // is no guide to a shore's lagoons) and the sea's salinity (0.17: the
    // seas differ by a few psu, the climate by far more).
    salt_arid_precip: 500.0,
    salt_coast_w: 1.0,
    salt_interior_w: 0.35,
    salt_flat_w: 1.0,
    // Salt's small bonus to carrying capacity (preservation → denser
    // settlement).
    w_salt_cc: 0.15,
    // Iron: broad craton signal + bog iron in wetlands. Deposit noise breaks
    // the (nearly uniform) craton signal into banded-iron-style deposits,
    // so iron stays common but fluctuates and does not read as a flat 100 %.
    iron_craton_w: 0.9,
    iron_bog_w: 0.7,
    iron_deposit_freq_x: 13.0,
    iron_deposit_freq_y: 7.0,
    iron_deposit_floor: 0.35,
    // Prestige (rare and clustered — the point). Gold = placer (rivers) +
    // lode (orogens); silver = hydrothermal near volcanic arcs; gems =
    // metamorphic (orogens) + arid weathering (turquoise near copper). None
    // feed carrying capacity.
    gold_lode_radius_m: 119808.0,
    silver_radius_m: 143770.0,
    gem_radius_m: 111821.0,
    // Placer gate: √(discharge / max) below this floor carries no gold —
    // only large rivers concentrate placer. The old ungated √·2 curve lit
    // up every stream (gold ≥ 5 % on 70 % of land, and 63 % even before the
    // Archean rework).
    gold_placer_sqrt_floor: 0.15,
    gold_placer_gain: 2.0,
    gold_placer_w: 0.7,
    gold_lode_w: 0.9,
    silver_w: 0.9,
    gem_orogen_w: 0.85,
    gem_arid_w: 0.6,
    volcanic_province_radius_m: 399360.0,
    // Higher frequency → more mottling (broad smooth gradients read as "no
    // variation"). The weights are large because smooth value noise has
    // LOW variance (interpolation pulls values toward the mean), so it
    // needs a big multiplier to give a visible deviation; the strength knob
    // (0..1) then scales it. Volcanic provinces punch harder than the
    // organic noise.
    province_noise_freq_x: 11.0,
    province_noise_freq_y: 6.0,
    volcanic_weight: 1.6,
    noise_weight: 1.5,
};

/// The tuning as (name, value), for the fixture's `tuning` hash
/// (tests/ecology.rs). The names are the camelCase keys and the order is
/// that of the TypeScript object the hash was first recorded from (removed
/// 2026-10-29); they are only names now. Do not rename or reorder an
/// entry: the hash moves.
pub fn ecology_constants() -> Vec<(&'static str, f64)> {
    let t = &ECOLOGY_TUNING;
    vec![
        ("wArable", t.w_arable),
        ("wFish", t.w_fish),
        ("wGame", t.w_game),
        ("wPasture", t.w_pasture),
        ("fishSeaBase", t.fish_sea_base),
        ("fishShelfW", t.fish_shelf_w),
        ("fishUpwellingW", t.fish_upwelling_w),
        ("fishUpwellingFull", t.fish_upwelling_full),
        ("fishMixingW", t.fish_mixing_w),
        ("fishMixFullC", t.fish_mix_full_c),
        ("fishMixWarmC", t.fish_mix_warm_c),
        ("fishMixIceC", t.fish_mix_ice_c),
        ("fishMixIceSpanC", t.fish_mix_ice_span_c),
        ("fishShelfDepthM", t.fish_shelf_depth_m),
        ("fishFullSeaShare", t.fish_full_sea_share),
        ("coastReachM", t.coast_reach_m),
        ("waterReachM", t.water_reach_m),
        ("ecotoneReachM", t.ecotone_reach_m),
        ("placerReachM", t.placer_reach_m),
        ("wetlandTableM", t.wetland_table_m),
        ("wetlandTableW", t.wetland_table_w),
        ("riverFloor", t.river_floor),
        ("fishRiverW", t.fish_river_w),
        ("fishLakeW", t.fish_lake_w),
        ("arableFrostC", t.arable_frost_c),
        ("arableIrrigationMm", t.arable_irrigation_mm),
        ("arableRiskW", t.arable_risk_w),
        ("arableSeasonMonths", t.arable_season_months),
        ("cropTempMid", t.crop_temp_mid),
        ("cropTempRate", t.crop_temp_rate),
        ("cropNeedMm", t.crop_need_mm),
        ("cropNeedPerCMm", t.crop_need_per_c_mm),
        ("cropNeedDry", t.crop_need_dry),
        ("cropNeedFull", t.crop_need_full),
        ("leachWarmC", t.leach_warm_c),
        ("leachW", t.leach_w),
        ("leachFromMm", t.leach_from_mm),
        ("leachFullMm", t.leach_full_mm),
        ("floodQMinM3s", t.flood_q_min_m3s),
        ("floodQFullM3s", t.flood_q_full_m3s),
        ("floodReachM", t.flood_reach_m),
        ("floodRiseFullM", t.flood_rise_full_m),
        ("floodRiseM", t.flood_rise_m),
        ("shelfDepthM", t.shelf_depth_m),
        ("oasisW", t.oasis_w),
        ("wellDepthM", t.well_depth_m),
        ("wellW", t.well_w),
        ("pastureDryMm", t.pasture_dry_mm),
        ("pastureDryFullMm", t.pasture_dry_full_mm),
        ("slopeK", t.slope_k),
        ("flatnessRunM", t.flatness_run_m),
        ("ecotoneBonus", t.ecotone_bonus),
        ("ecotoneFullShare", t.ecotone_full_share),
        ("ecotoneCountedOnM", t.ecotone_counted_on_m),
        ("copperRadiusM", t.copper_radius_m),
        ("copperExtinctRadiusM", t.copper_extinct_radius_m),
        ("copperExtinctW", t.copper_extinct_w),
        ("tinRadiusM", t.tin_radius_m),
        ("obsidianRadiusM", t.obsidian_radius_m),
        ("flintBase", t.flint_base),
        ("copperKeep", t.copper_keep),
        ("copperExtinctKeep", t.copper_extinct_keep),
        ("silverKeep", t.silver_keep),
        ("obsidianKeep", t.obsidian_keep),
        ("tinKeep", t.tin_keep),
        ("goldLodeKeep", t.gold_lode_keep),
        ("gemKeep", t.gem_keep),
        ("saltAridPrecip", t.salt_arid_precip),
        ("saltCoastW", t.salt_coast_w),
        ("saltInteriorW", t.salt_interior_w),
        ("saltFlatW", t.salt_flat_w),
        ("wSaltCc", t.w_salt_cc),
        ("ironCratonW", t.iron_craton_w),
        ("ironBogW", t.iron_bog_w),
        ("ironDepositFreqX", t.iron_deposit_freq_x),
        ("ironDepositFreqY", t.iron_deposit_freq_y),
        ("ironDepositFloor", t.iron_deposit_floor),
        ("goldLodeRadiusM", t.gold_lode_radius_m),
        ("silverRadiusM", t.silver_radius_m),
        ("gemRadiusM", t.gem_radius_m),
        ("goldPlacerSqrtFloor", t.gold_placer_sqrt_floor),
        ("goldPlacerGain", t.gold_placer_gain),
        ("goldPlacerW", t.gold_placer_w),
        ("goldLodeW", t.gold_lode_w),
        ("silverW", t.silver_w),
        ("gemOrogenW", t.gem_orogen_w),
        ("gemAridW", t.gem_arid_w),
        ("volcanicProvinceRadiusM", t.volcanic_province_radius_m),
        ("provinceNoiseFreqX", t.province_noise_freq_x),
        ("provinceNoiseFreqY", t.province_noise_freq_y),
        ("volcanicWeight", t.volcanic_weight),
        ("noiseWeight", t.noise_weight),
    ]
}
