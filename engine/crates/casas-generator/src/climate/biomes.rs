//! The biome set, the biome of a Köppen class, and the Köppen class and
//! biome of every land point of a climate sampled there. Ids are stable:
//! saves store them. Not ported, because they are presentation: the
//! colours, the label keys and the legend.

use crate::core::domain::Domain;
use crate::core::js;

use super::climate_points::{ClimatePoints, PointClimate};
use super::climate_tune_params::CLIMATE_TUNING;
use super::koppen::{classify_koppen, koppen_code, synthesize_months};

/// The biome ids (`Biome` in TypeScript, which explains each).
pub mod biome {
    pub const OCEAN: u8 = 0;
    pub const ICE: u8 = 1;
    pub const TUNDRA: u8 = 2;
    pub const BOREAL: u8 = 3;
    pub const GRASSLAND: u8 = 4;
    pub const WOODLAND: u8 = 5;
    pub const TEMPERATE_FOREST: u8 = 6;
    pub const TEMPERATE_RAINFOREST: u8 = 7;
    pub const DESERT: u8 = 8;
    pub const SAVANNA: u8 = 9;
    pub const TROPICAL_RAINFOREST: u8 = 10;
    pub const ALPINE: u8 = 11;
    pub const SALT_FLAT: u8 = 12;
    pub const GLACIER: u8 = 13;
    pub const MEDITERRANEAN_SCRUB: u8 = 14;
    pub const STEPPE: u8 = 15;
    pub const TROPICAL_DRY_FOREST: u8 = 16;
    pub const COLD_DESERT: u8 = 17;
}

/// The biomes that are hydrology states, not climate classes: every
/// re-classification carries them over.
pub const HYDROLOGY_STATE_BIOMES: [u8; 2] = [biome::SALT_FLAT, biome::GLACIER];

/// The biome of a Köppen class; `map` mm/yr, `amp` the seasonal range °C,
/// `season` the monsoon index's magnitude.
pub fn biome_from_koppen(id: u8, map: f64, amp: f64, season: f64) -> u8 {
    let Some(code) = koppen_code(id) else {
        return biome::ICE;
    };
    let t = &CLIMATE_TUNING;
    match code {
        "Af" => biome::TROPICAL_RAINFOREST,
        "Am" => biome::TROPICAL_DRY_FOREST,
        "Aw" | "As" => {
            if map >= t.savanna_max_precip_mm {
                biome::TROPICAL_DRY_FOREST
            } else {
                biome::SAVANNA
            }
        }
        "BWh" => biome::DESERT,
        "BWk" => biome::COLD_DESERT,
        "BSh" | "BSk" => biome::STEPPE,
        "Csa" | "Csb" | "Csc" => biome::MEDITERRANEAN_SCRUB,
        "ET" => biome::TUNDRA,
        "EF" => biome::ICE,
        "Dsc" | "Dsd" | "Dwc" | "Dwd" | "Dfc" | "Dfd" => {
            if map < t.boreal_min_precip_mm {
                biome::TUNDRA
            } else {
                biome::BOREAL
            }
        }
        "Cfb" | "Cfc" => {
            if map >= t.temperate_forest_max_precip_mm {
                biome::TEMPERATE_RAINFOREST
            } else {
                temperate_canopy(map, amp, season)
            }
        }
        _ => temperate_canopy(map, amp, season),
    }
}

fn temperate_canopy(map: f64, amp: f64, season: f64) -> u8 {
    let t = &CLIMATE_TUNING;
    if map < t.temperate_grassland_max_precip_mm {
        return if amp > t.temperate_open_canopy_amplitude_c
            || season > t.temperate_open_canopy_season
        {
            biome::GRASSLAND
        } else {
            biome::WOODLAND
        };
    }
    if map < t.temperate_forest_max_precip_mm && season > t.temperate_woodland_season {
        return biome::WOODLAND;
    }
    biome::TEMPERATE_FOREST
}

#[allow(clippy::too_many_arguments)]
fn classify_annual(
    temp_c: f64,
    precip_mm: f64,
    amp: f64,
    index: f64,
    north: bool,
    t: &mut [f64; 12],
    p: &mut [f64; 12],
) -> (u8, u8) {
    synthesize_months(
        temp_c,
        amp,
        precip_mm,
        index,
        north,
        CLIMATE_TUNING.monsoon_seasonality_floor,
        t,
        p,
    );
    let koppen = classify_koppen(t, p);
    (
        koppen,
        biome_from_koppen(koppen, precip_mm, amp, index.abs()),
    )
}

fn classify_months(t: &[f64; 12], p: &[f64; 12]) -> u8 {
    let koppen = classify_koppen(t, p);
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    let (mut map, mut top) = (0.0, 0.0);
    for m in 0..12 {
        lo = js::min(lo, t[m]);
        hi = js::max(hi, t[m]);
        map += p[m];
        if (3..9).contains(&m) {
            top += p[m];
        }
    }
    let season = (top - (map - top)).abs() / (map + CLIMATE_TUNING.monsoon_seasonality_floor / 2.0);
    biome_from_koppen(koppen, map, hi - lo, season)
}

/// The biome and the Köppen class per point.
pub struct PointBiomes {
    pub biome: Vec<u8>,
    pub koppen: Vec<u8>,
}

/// The Köppen class and the biome of every land point; `precipitation`
/// overrides the annual rain the biome reads (not the class).
pub fn classify_points(
    climate: &PointClimate,
    points: &ClimatePoints,
    domain: &Domain,
    precipitation: Option<&[f32]>,
) -> PointBiomes {
    let n = points.count;
    let mut biome = vec![0u8; n];
    let mut koppen = vec![0u8; n];
    let mut t = [0.0; 12];
    let mut p = [0.0; 12];
    let mut t_synth = [0.0; 12];
    let mut p_synth = [0.0; 12];
    for i in 0..n {
        if let Some(alive) = points.alive
            && alive[i] == 0
        {
            continue;
        }
        if points.land[i] == 0 {
            biome[i] = biome::OCEAN;
            continue;
        }
        let rain = climate.precipitation[i] as f64;
        let effective = precipitation.map_or(rain, |e| e[i] as f64);
        let base = if let Some(months) = &climate.months {
            let count = months.count;
            let mut mean = 0.0;
            for m in 0..count {
                mean += js::max(0.0, months.precipitation[m * n + i] as f64) / count as f64;
            }
            let scale = if mean > 0.0 && effective >= 0.0 {
                effective / mean
            } else {
                1.0
            };
            for m in 0..12 {
                t[m] = months.temperature[m * n + i] as f64;
                p[m] = js::max(0.0, months.precipitation[m * n + i] as f64) / count as f64;
            }
            koppen[i] = classify_koppen(&t, &p);
            if scale != 1.0 {
                for v in &mut p {
                    *v *= scale;
                }
            }
            classify_months(&t, &p)
        } else {
            let north = domain.north(points.y[i] / domain.height);
            let amp = climate.seasonal_amplitude[i] as f64;
            let index = climate.monsoon_index[i] as f64;
            let temperature = climate.temperature[i] as f64;
            let (own_koppen, own_biome) = classify_annual(
                temperature,
                js::max(0.0, rain),
                amp,
                index,
                north,
                &mut t_synth,
                &mut p_synth,
            );
            koppen[i] = own_koppen;
            if effective == rain {
                own_biome
            } else {
                classify_annual(
                    temperature,
                    js::max(0.0, effective),
                    amp,
                    index,
                    north,
                    &mut t_synth,
                    &mut p_synth,
                )
                .1
            }
        };
        biome[i] = if points.height.at(i) > CLIMATE_TUNING.alpine_treeline_elevation
            && base != biome::ICE
        {
            biome::ALPINE
        } else {
            base
        };
    }
    PointBiomes { biome, koppen }
}
