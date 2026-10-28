//! THE INCUBATOR'S FLORA AND FAUNA (2026-10-25, a trial): where each plant
//! and tree of the catalog grows and where each animal lives, and how many,
//! on the habitat's cells.
//!
//! THE FLORA:
//! 1. THE NICHE: the plant's weight for the cell's Köppen class, times its
//!    responses to the height, slope, cover, water and sea (the catalog's
//!    niche). A salt flat suits only the plants that stand it.
//! 2. THE RANGE: a plant starts on a landmass by its size, at one origin
//!    drawn by its niche, and spreads by the cheapest way (niche.rs): land
//!    whose climate it does not suit is dearer, the sea is not crossed. A
//!    suitable place outside the range is an empty niche: what it would
//!    grow on there is grey.
//!
//! THE FAUNA:
//! 1. THE NICHE AND THE RANGE, as a plant's: the Köppen class, the cover,
//!    the water and the coast; an origin on a landmass by its size, the
//!    spread by the cheapest way. The salmon instead swims up the rivers
//!    from every suitable mouth; the shore's animals are on every coast that
//!    suits them.
//! 2. HOW MANY: the herbivores share the land's game (the ecology's field,
//!    level 1's) times the biome's edible share, each by its niche squared
//!    among those in range there; a predator follows the herbivores in its
//!    range; an animal of the water is its niche. Without the game, every
//!    land cell feeds alike.

use crate::catalog::catalog;
use crate::habitat::{GAME, Habitat, SpreadOptions, spread_range};
use crate::niche::{BARRIER, SUITABLE, niche_of, range_of};
use casas_engine::climate::biomes::biome;
use casas_engine::core::js;

/// A layer: one code a cell (0 nothing, 1 suitable but not reached, 2 …
/// 255 in the range), and its shares of the land.
// A plant's or a tree's 2 … 255 is its niche (1 at 255); an animal's is
// how many, on a scale of the animal's own (its 99th percentile at 255).
pub struct Layer {
    pub codes: Vec<u8>,
    pub suitable: f64,
    pub reached: f64,
    pub empty: f64,
}

/// The plants, then the trees, in the catalog's order.
pub fn grow_flora(h: &Habitat, seed: f64) -> (Vec<Layer>, Vec<Layer>) {
    let c = catalog();
    let layer = |r: crate::niche::Range| Layer {
        codes: r.codes,
        suitable: r.suitable,
        reached: r.reached,
        empty: r.empty,
    };
    let plants = c
        .plants
        .iter()
        .map(|p| layer(range_of(&p.niche, h, seed)))
        .collect();
    let trees = c
        .trees
        .iter()
        .map(|t| layer(range_of(&t.niche, h, seed)))
        .collect();
    (plants, trees)
}

/// A biome's id by its name (generator/climate/biomes.ts `Biome`).
fn biome_id(name: &str) -> u8 {
    match name {
        "Ocean" => biome::OCEAN,
        "Ice" => biome::ICE,
        "Tundra" => biome::TUNDRA,
        "Boreal" => biome::BOREAL,
        "Grassland" => biome::GRASSLAND,
        "Woodland" => biome::WOODLAND,
        "TemperateForest" => biome::TEMPERATE_FOREST,
        "TemperateRainforest" => biome::TEMPERATE_RAINFOREST,
        "Desert" => biome::DESERT,
        "Savanna" => biome::SAVANNA,
        "TropicalRainforest" => biome::TROPICAL_RAINFOREST,
        "Alpine" => biome::ALPINE,
        "SaltFlat" => biome::SALT_FLAT,
        "Glacier" => biome::GLACIER,
        "MediterraneanScrub" => biome::MEDITERRANEAN_SCRUB,
        "Steppe" => biome::STEPPE,
        "TropicalDryForest" => biome::TROPICAL_DRY_FOREST,
        "ColdDesert" => biome::COLD_DESERT,
        _ => panic!("data/catalog.json: no biome {name}"),
    }
}

/// The animals, in the catalog's order.
pub fn populate(h: &Habitat, seed: f64) -> Vec<Layer> {
    let c = catalog();
    let n = h.count;
    let land_count = h.land_count as f64;
    let mut edible = [None::<f64>; 256];
    for (name, share) in &c.edible_share {
        edible[biome_id(name) as usize] = Some(*share);
    }

    // 1. The niches and the ranges.
    let grown: Vec<(Vec<f32>, Vec<u8>)> = c
        .animals
        .iter()
        .map(|s| {
            if s.by_sea {
                let (niche, _) = niche_of(&s.niche, h);
                let range = niche
                    .iter()
                    .map(|&v| u8::from(v as f64 >= SUITABLE))
                    .collect();
                return (niche, range);
            }
            if !s.upriver {
                let r = range_of(&s.niche, h, seed);
                return (r.niche, r.range);
            }
            let (niche, _) = niche_of(&s.niche, h);
            // Every suitable cell by the sea.
            let mut starts = Vec::new();
            for i in 0..n {
                if (niche[i] as f64) < SUITABLE {
                    continue;
                }
                if h.edges(i).any(|e| h.land[h.nbr[e] as usize] == 0) {
                    starts.push(i);
                }
            }
            let range = spread_range(
                h,
                &niche,
                &starts,
                &SpreadOptions {
                    suitable: SUITABLE,
                    barrier: BARRIER,
                    max_km: f64::INFINITY,
                    only_suitable: true,
                },
            );
            (niche, range)
        })
        .collect();
    let lives = |k: usize, i: usize| grown[k].1[i] == 1 && grown[k].0[i] as f64 >= SUITABLE;

    // 2. How many.
    let mut density: Vec<Vec<f32>> = c.animals.iter().map(|_| vec![0f32; n]).collect();
    let herbivores: Vec<usize> = c
        .animals
        .iter()
        .enumerate()
        .filter(|(_, s)| s.role == "herbivore")
        .map(|(k, _)| k)
        .collect();
    let mut prey = vec![0f32; n];
    let game = h.ecology[GAME].as_ref();
    for i in 0..n {
        if h.land[i] == 0 {
            continue;
        }
        let mut sum = 0.0;
        for &k in &herbivores {
            if lives(k, i) {
                let v = grown[k].0[i] as f64;
                sum += v * v;
            }
        }
        if sum == 0.0 {
            continue;
        }
        let forage = game.map_or(1.0, |g| g[i] as f64) * edible[h.biome[i] as usize].unwrap_or(0.0);
        for &k in &herbivores {
            if !lives(k, i) {
                continue;
            }
            let v = grown[k].0[i] as f64;
            density[k][i] = ((forage * (v * v)) / sum) as f32;
            prey[i] = (prey[i] as f64 + density[k][i] as f64) as f32;
        }
    }
    for (k, s) in c.animals.iter().enumerate() {
        if s.role == "herbivore" {
            continue;
        }
        for i in 0..n {
            if lives(k, i) {
                let v = grown[k].0[i] as f64;
                density[k][i] = if s.role == "predator" {
                    (prey[i] as f64 * v) as f32
                } else {
                    v as f32
                };
            }
        }
    }

    c.animals
        .iter()
        .enumerate()
        .map(|(k, _)| {
            let d = &density[k];
            let mut living: Vec<f32> = d.iter().copied().filter(|&v| v > 0.0).collect();
            living.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let top = if living.is_empty() {
                1.0
            } else {
                living[(0.99 * (living.len() - 1) as f64).floor() as usize] as f64
            };
            let mut codes = vec![0u8; n];
            let (mut suitable, mut reached, mut empty) = (0usize, 0usize, 0usize);
            for i in 0..n {
                let fits = grown[k].0[i] as f64 >= SUITABLE;
                if fits {
                    suitable += 1;
                }
                if lives(k, i) {
                    reached += 1;
                }
                if d[i] > 0.0 {
                    codes[i] = (2.0 + js::round(253.0 * js::min(1.0, d[i] as f64 / top))) as u8;
                } else if fits && grown[k].1[i] == 0 {
                    codes[i] = 1;
                    empty += 1;
                }
            }
            Layer {
                codes,
                suitable: suitable as f64 / land_count,
                reached: reached as f64 / land_count,
                empty: empty as f64 / land_count,
            }
        })
        .collect()
}
