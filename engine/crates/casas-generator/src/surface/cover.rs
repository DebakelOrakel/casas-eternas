//! How much of the ground the vegetation holds, per node from its biome —
//! one value for the erodibility, the critical slope and the river banks;
//! zero before the land plants.

use crate::climate::biomes::biome;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverTuning {
    pub erodibility_drop: f64,
    pub critical_slope_rise: f64,
}

pub const COVER_TUNING: CoverTuning = CoverTuning {
    erodibility_drop: 0.6,
    critical_slope_rise: 0.5,
};

/// Per biome id, the cover (the river course's bank strength).
pub fn cover_by_biome(id: u8) -> Option<f64> {
    use biome::*;
    Some(match id {
        OCEAN | ICE | DESERT | SALT_FLAT | GLACIER | COLD_DESERT => 0.2,
        TUNDRA => 0.35,
        BOREAL | WOODLAND => 0.7,
        GRASSLAND => 0.5,
        TEMPERATE_FOREST => 0.85,
        TEMPERATE_RAINFOREST | TROPICAL_RAINFOREST => 0.9,
        SAVANNA => 0.45,
        ALPINE | STEPPE => 0.4,
        MEDITERRANEAN_SCRUB => 0.55,
        TROPICAL_DRY_FOREST => 0.75,
        _ => return None,
    })
}

/// The cover per element from its biome; all zero before the plants.
pub fn cover_field(biomes: &[u8], plants_present: bool) -> Vec<f32> {
    if !plants_present {
        return vec![0.0; biomes.len()];
    }
    biomes
        .iter()
        .map(|&b| {
            if b == biome::OCEAN {
                0.0
            } else {
                cover_by_biome(b).unwrap_or(0.5) as f32
            }
        })
        .collect()
}
