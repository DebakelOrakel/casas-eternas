//! `screens/incubator/niche.ts`: where a plant, a tree or an animal can live
//! (its niche over the habitat) and where it got to (its range). The
//! reasoning is in the TypeScript file.

use crate::catalog::Niche;
use crate::habitat::{
    Habitat, SpreadOptions, draw_origins_by_landmass, hash_text, spread_range, trapezoid,
};
use casas_engine::climate::biomes::biome;
use casas_engine::climate::koppen::KOPPEN_CODES;
use casas_engine::core::det_math::det_exp;
use casas_engine::core::js;
use casas_engine::core::rng::Mulberry32;

pub const SUITABLE: f64 = 0.3;
pub const BARRIER: f64 = 30.0;
pub(crate) const SPREAD_KM: f64 = 8000.0;
pub(crate) const ORIGIN_AREA_KM2: f64 = 500_000.0;
pub(crate) const OFF_COVER: f64 = 0.25;
pub(crate) const BIG_RIVER: f64 = 0.3;

fn open_biome(b: u8) -> bool {
    matches!(
        b,
        biome::GRASSLAND
            | biome::STEPPE
            | biome::SAVANNA
            | biome::DESERT
            | biome::COLD_DESERT
            | biome::TUNDRA
            | biome::ALPINE
            | biome::MEDITERRANEAN_SCRUB
            | biome::SALT_FLAT
    )
}

fn forest_biome(b: u8) -> bool {
    matches!(
        b,
        biome::BOREAL
            | biome::TEMPERATE_FOREST
            | biome::TEMPERATE_RAINFOREST
            | biome::TROPICAL_RAINFOREST
    )
}

fn cover_fit(s: &Niche, b: u8) -> f64 {
    let Some(cover) = &s.cover else { return 1.0 };
    let open = open_biome(b);
    let forest = forest_biome(b);
    if !open && !forest {
        return 1.0;
    }
    if (cover == "open") == open {
        1.0
    } else {
        OFF_COVER
    }
}

/// The niche, and the climate's part of it alone (niche.ts nicheOf).
pub fn niche_of(s: &Niche, h: &Habitat) -> (Vec<f32>, Vec<f32>) {
    let n = h.count;
    let weight: Vec<f64> = KOPPEN_CODES
        .iter()
        .map(|code| {
            if code.is_empty() {
                0.0
            } else {
                s.climates.get(*code).copied().unwrap_or(0.0)
            }
        })
        .collect();
    let oasis: Vec<bool> = KOPPEN_CODES
        .iter()
        .map(|code| !code.is_empty() && s.oasis.iter().any(|o| o == code))
        .collect();
    let mut niche = vec![0f32; n];
    let mut climate = vec![0f32; n];
    for i in 0..n {
        let b = h.biome[i];
        if h.land[i] == 0 || b == biome::ICE || b == biome::GLACIER {
            continue;
        }
        let k = h.koppen[i] as usize;
        let mut v = weight.get(k).copied().unwrap_or(0.0);
        if v == 0.0 {
            continue;
        }
        if let Some(t) = &s.height {
            v *= trapezoid(h.height_m[i] as f64, t);
        }
        if let Some(t) = &s.slope {
            v *= trapezoid(h.slope[i] as f64, t);
        }
        v *= cover_fit(s, b);
        climate[i] = v as f32;
        if b == biome::SALT_FLAT && !s.salt {
            v = 0.0;
        }
        let water = if h.near_river[i] != 0 {
            h.near_river[i]
        } else {
            h.near_lake[i]
        } as f64;
        if oasis.get(k).copied().unwrap_or(false) && water == 0.0 {
            v = 0.0;
        }
        if let Some(wet) = s.wet.filter(|w| *w != 0.0) {
            v *= 1.0 - wet + wet * water;
        }
        if let Some(fp) = s.floodplain.filter(|w| *w != 0.0) {
            v *= 1.0 - fp + fp * js::min(1.0, h.river_size[i] as f64 / BIG_RIVER);
        }
        if let Some(coast) = s.coast.filter(|w| *w != 0.0) {
            v *= 1.0 - coast + coast * h.near_sea[i] as f64;
        }
        niche[i] = v as f32;
    }
    (niche, climate)
}

/// One niche's range: its codes and shares of the land, its niche and its
/// range (niche.ts rangeOf).
pub struct Range {
    pub codes: Vec<u8>,
    pub niche: Vec<f32>,
    pub range: Vec<u8>,
    pub suitable: f64,
    pub reached: f64,
    pub empty: f64,
}

/// The seed of a niche's draws: its id's hash XOR the world's seed, as the
/// TypeScript's `hashText(id) ^ seed` gives it to mulberry32.
pub fn seed_of(id: &str, seed: f64) -> u32 {
    hash_text(id) ^ js::to_uint32(seed)
}

pub fn range_of(s: &Niche, h: &Habitat, seed: f64) -> Range {
    let n = h.count;
    let (niche, climate) = niche_of(s, h);
    let mut random = Mulberry32::new(seed_of(&s.id, seed));
    let starts = draw_origins_by_landmass(
        h,
        &niche,
        |m| 1.0 - det_exp(-h.landmass_km2[m] / ORIGIN_AREA_KM2),
        SUITABLE,
        &mut random,
    );
    let range = spread_range(
        h,
        &climate,
        &starts,
        &SpreadOptions {
            suitable: SUITABLE,
            barrier: BARRIER,
            max_km: SPREAD_KM,
            only_suitable: false,
        },
    );
    let mut codes = vec![0u8; n];
    let (mut suitable, mut reached, mut empty) = (0usize, 0usize, 0usize);
    for i in 0..n {
        let fits = niche[i] as f64 >= SUITABLE;
        if fits {
            suitable += 1;
        }
        if fits && range[i] != 0 {
            reached += 1;
        }
        if range[i] != 0 && niche[i] > 0.0 {
            codes[i] = (2.0 + js::round(253.0 * js::min(1.0, niche[i] as f64))) as u8;
        } else if fits {
            codes[i] = 1;
            empty += 1;
        }
    }
    let land = h.land_count as f64;
    Range {
        codes,
        niche,
        range,
        suitable: suitable as f64 / land,
        reached: reached as f64 / land,
        empty: empty as f64 / land,
    }
}
