//! A history on the habitat, its inputs made as the incubator's worker makes
//! them (incubatorWorker.ts `simulate`): the domesticable starch plants, the
//! herd animals and the big game of the catalog, as the flora and the fauna
//! placed them; the carrying capacity; the rain's reliability at each cell's
//! centre; the origin, or the one people.ts chooses (originOf); step 1 of
//! the prehistory from it (peopling.rs), where the history begins.

use crate::catalog::catalog;
use crate::flora::Layer as Grown;
use crate::habitat::{CARRYING, Habitat};
use crate::peopling::people;
use crate::simulation::{BigGame, Layer, Rain, SimulationInput, SimulationResult, simulate};
use casas_engine::climate::biomes::biome;
use casas_engine::climate::koppen::KOPPEN_CODES;

/// The rain's reliability charted (map/refinedLayers.ts): a raster of
/// `width` × `height` over the world.
pub struct RainChart<'a> {
    pub width: usize,
    pub height: usize,
    pub variability: &'a [f32],
    pub enso: &'a [f32],
    pub enso_strength: f64,
}

/// At each cell's centre (incubatorWorker.ts rainOfCells).
fn rain_of_cells(h: &Habitat, rain: &RainChart) -> Rain {
    let mut variability = vec![0f32; h.count];
    let mut enso = vec![0f32; h.count];
    for i in 0..h.count {
        let row = ((h.v[i] as f64 * rain.height as f64).floor() as usize).min(rain.height - 1);
        let col = ((h.u[i] as f64 * rain.width as f64).floor() as usize).min(rain.width - 1);
        let t = row * rain.width + col;
        variability[i] = rain.variability[t];
        enso[i] = rain.enso[t];
    }
    Rain {
        variability,
        enso,
        enso_strength: rain.enso_strength,
    }
}

/// The carrying capacity the history reads: the habitat's, or 0.4.
pub fn carrying_of(h: &Habitat) -> Vec<f32> {
    h.ecology[CARRYING]
        .clone()
        .unwrap_or_else(|| vec![0.4; h.count])
}

/// The origin when none is given: the land that feeds best in a tropical
/// class (Köppen A), else anywhere (people.ts originOf).
pub fn origin_of(h: &Habitat, carrying: &[f32]) -> i32 {
    let mut best: i32 = -1;
    let mut best_tropical: i32 = -1;
    for i in 0..h.count {
        if h.land[i] == 0 || h.biome[i] == biome::ICE || h.biome[i] == biome::GLACIER {
            continue;
        }
        if best < 0 || carrying[i] > carrying[best as usize] {
            best = i as i32;
        }
        let tropical = KOPPEN_CODES
            .get(h.koppen[i] as usize)
            .is_some_and(|c| c.starts_with('A'));
        if tropical && (best_tropical < 0 || carrying[i] > carrying[best_tropical as usize]) {
            best_tropical = i as i32;
        }
    }
    if best_tropical >= 0 {
        best_tropical
    } else {
        best
    }
}

/// The history: `flora` the plants then the trees, `fauna` the animals, in
/// the catalog's order (flora.rs); `origin` a cell, or -1 to choose it.
pub fn run_history(
    h: &Habitat,
    flora: &[Grown],
    fauna: &[Grown],
    origin: i32,
    seed: f64,
    rain: Option<&RainChart>,
    on_progress: Option<&mut dyn FnMut(f64)>,
) -> SimulationResult {
    let c = catalog();
    let carrying = carrying_of(h);
    let origin = if origin >= 0 && h.land[origin as usize] != 0 {
        origin
    } else {
        origin_of(h, &carrying)
    };
    let crops = c
        .plants
        .iter()
        .zip(flora)
        .filter(|(p, _)| p.domesticable && p.use_ == "starch")
        .map(|(p, l)| Layer {
            id: p.niche.id.clone(),
            codes: &l.codes,
        })
        .collect();
    let herds = c
        .animals
        .iter()
        .zip(fauna)
        .filter(|(a, _)| c.herd_animals.contains(&a.niche.id))
        .map(|(a, l)| Layer {
            id: a.niche.id.clone(),
            codes: &l.codes,
        })
        .collect();
    let big_game = c
        .animals
        .iter()
        .zip(fauna)
        .filter_map(|(a, l)| {
            c.megafauna.get(&a.niche.id).map(|&v| BigGame {
                id: a.niche.id.clone(),
                codes: &l.codes,
                vulnerability: v,
            })
        })
        .collect();
    let peopling = people(h, &carrying, &[origin as usize], seed);
    let input = SimulationInput {
        carrying: &carrying,
        origin,
        peopling: &peopling,
        seed,
        big_game,
        crops,
        herds,
        rain: rain.map(|r| rain_of_cells(h, r)),
    };
    simulate(h, &input, on_progress)
}
