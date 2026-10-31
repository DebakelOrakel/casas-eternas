//! A history on the habitat, its inputs made as the incubator's worker makes
//! them (incubatorWorker.ts `simulate`): the domesticable starch plants, the
//! herd animals and the big game of the catalog, as the flora and the fauna
//! placed them; the carrying capacity; the rain's reliability at each cell's
//! centre; the origin, or the one origin_of chooses; step 1 of
//! the prehistory from it (peopling.rs), where the history begins.

use crate::catalog::catalog;
use crate::flora::Layer as Grown;
use crate::habitat::{CARRYING, Habitat};
use crate::peopling::{Controls, ORIGIN_LANDMASS_KM2, people};
use crate::simulation::{BigGame, Layer, Rain, SimulationInput, SimulationResult, simulate};
use casas_generator::climate::biomes::biome;
use casas_generator::climate::koppen::KOPPEN_CODES;

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

/// The origin when none is given (TEG-7, 2026-10-31): of the landmasses
/// of ORIGIN_LANDMASS_KM2 or more, each its land that feeds best in a
/// tropical class (Köppen A), else its land that feeds best; of those, the
/// one from which step 1 (`people`, on the same seed and controls) reaches
/// the most land. Without such a landmass, the land that feeds best in a
/// tropical class anywhere, else anywhere. The best land of the whole
/// world alone lay on a landmass step 1 hardly leaves on two of three
/// worlds (Thalassor 14.8 %, Zephyra 7.5 % of the land reached), and the
/// largest landmass alone fails on Morvane (50.7 %: its second landmass
/// is never reached).
pub fn origin_of(h: &Habitat, carrying: &[f32], seed: f64, controls: Controls) -> i32 {
    let open =
        |i: usize| h.land[i] != 0 && h.biome[i] != biome::ICE && h.biome[i] != biome::GLACIER;
    let tropical = |i: usize| {
        KOPPEN_CODES
            .get(h.koppen[i] as usize)
            .is_some_and(|c| c.starts_with('A'))
    };
    // Per landmass (and at index `landmasses`, the whole world): the best
    // land, and the best tropical land.
    let mut best = vec![-1i32; h.landmasses + 1];
    let mut best_tropical = vec![-1i32; h.landmasses + 1];
    for i in 0..h.count {
        if !open(i) {
            continue;
        }
        let mut slots = vec![h.landmasses];
        if h.landmass[i] >= 0 && h.landmass_km2[h.landmass[i] as usize] >= ORIGIN_LANDMASS_KM2 {
            slots.push(h.landmass[i] as usize);
        }
        for m in slots {
            if best[m] < 0 || carrying[i] > carrying[best[m] as usize] {
                best[m] = i as i32;
            }
            if tropical(i)
                && (best_tropical[m] < 0 || carrying[i] > carrying[best_tropical[m] as usize])
            {
                best_tropical[m] = i as i32;
            }
        }
    }
    let pick = |m: usize| {
        if best_tropical[m] >= 0 {
            best_tropical[m]
        } else {
            best[m]
        }
    };
    let candidates: Vec<i32> = (0..h.landmasses).map(pick).filter(|&c| c >= 0).collect();
    if candidates.len() < 2 {
        return candidates
            .first()
            .copied()
            .unwrap_or_else(|| pick(h.landmasses));
    }
    let mut chosen = -1;
    let mut most = -1.0;
    for &c in &candidates {
        let p = people(h, carrying, &[c as usize], seed, controls);
        let reached: f64 = (0..h.count)
            .filter(|&i| open(i) && p.arrival[i].is_finite())
            .map(|i| h.area_km2[i] as f64)
            .sum();
        if reached > most {
            most = reached;
            chosen = c;
        }
    }
    chosen
}

/// The history: `flora` the plants then the trees, `fauna` the animals, in
/// the catalog's order (flora.rs); `origin` a cell, or -1 to choose it;
/// `controls` step 1's (peopling.rs).
#[allow(clippy::too_many_arguments)]
pub fn run_history(
    h: &Habitat,
    flora: &[Grown],
    fauna: &[Grown],
    origin: i32,
    controls: Controls,
    seed: f64,
    rain: Option<&RainChart>,
    on_progress: Option<&mut dyn FnMut(f64)>,
) -> SimulationResult {
    run_history_keeping(
        h,
        flora,
        fauna,
        origin,
        controls,
        seed,
        rain,
        on_progress,
        false,
    )
}

/// The history, and with `keep_traits` the traits at each kept state
/// (SimulationResult `trait_frames`), for a measure of the peoples.
#[allow(clippy::too_many_arguments)]
pub fn run_history_keeping(
    h: &Habitat,
    flora: &[Grown],
    fauna: &[Grown],
    origin: i32,
    controls: Controls,
    seed: f64,
    rain: Option<&RainChart>,
    on_progress: Option<&mut dyn FnMut(f64)>,
    keep_traits: bool,
) -> SimulationResult {
    let c = catalog();
    let carrying = carrying_of(h);
    let origin = if origin >= 0 && h.land[origin as usize] != 0 {
        origin
    } else {
        origin_of(h, &carrying, seed, controls)
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
    let peopling = people(h, &carrying, &[origin as usize], seed, controls);
    let input = SimulationInput {
        carrying: &carrying,
        origin,
        peopling: &peopling,
        seed,
        big_game,
        crops,
        herds,
        rain: rain.map(|r| rain_of_cells(h, r)),
        keep_traits,
    };
    simulate(h, &input, on_progress)
}
