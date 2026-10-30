//! THE WAYS' DAYS (2026-10-26): how long a step from a cell to its
//! neighbour takes, in days, and the search over those days. They give
//! the central places' spacing, the trade and the exchange between
//! neighbours. Before, these counted km over the cells, and the trade
//! counted the links it passed.
//!
//! - On foot: Tobler's hiking function on the step's grade, WALK_HOURS a
//!   day (6 km/h at a slight downhill, 5 on the flat: some 30 km a day),
//!   times the land's ease (`terrain_ease` by biome: the rainforest half,
//!   the open land whole); ice and glaciers are not crossed.
//! - On a river (both cells beside one of RIVER_BOAT_SIZE or more, the
//!   habitat's river size): by dugout, RIVER_DOWN_KM_DAY downstream (the
//!   lower cell ahead), RIVER_UP_KM_DAY up — or on foot, whichever is
//!   quicker.
//! - Along the coast, by boat: sea cells of COAST_DEPTH_M or less at
//!   COAST_KM_DAY, landing or setting out LANDING_DAYS; the open sea is
//!   not a way (the crossings are the people's, not the trade's).

use crate::habitat::Habitat;
use casas_generator::climate::biomes::biome;
use casas_generator::core::det_math::det_exp;
use casas_generator::core::js;
use casas_generator::core::min_heap::MinHeap;

pub(crate) const WALK_HOURS: f64 = 6.0;
pub(crate) const RIVER_BOAT_SIZE: f64 = 0.1;
pub(crate) const RIVER_DOWN_KM_DAY: f64 = 50.0;
pub(crate) const RIVER_UP_KM_DAY: f64 = 20.0;
pub(crate) const COAST_DEPTH_M: f64 = 200.0;
pub(crate) const COAST_KM_DAY: f64 = 40.0;
pub(crate) const LANDING_DAYS: f64 = 0.25;

fn terrain_ease(b: u8) -> f64 {
    match b {
        biome::ICE | biome::GLACIER => 0.0,
        biome::TROPICAL_RAINFOREST => 0.5,
        biome::TEMPERATE_RAINFOREST | biome::ALPINE => 0.6,
        biome::BOREAL => 0.7,
        biome::TEMPERATE_FOREST
        | biome::TROPICAL_DRY_FOREST
        | biome::WOODLAND
        | biome::TUNDRA
        | biome::DESERT
        | biome::COLD_DESERT
        | biome::SALT_FLAT => 0.8,
        _ => 1.0,
    }
}

/// The days of each step, aligned with the habitat's neighbours; Infinity
/// where it is not a way.
pub fn travel_days(h: &Habitat) -> Vec<f32> {
    let mut days = vec![f32::INFINITY; h.nbr.len()];
    let by_boat = |i: usize| h.land[i] == 0 && h.sea_depth_m[i] as f64 <= COAST_DEPTH_M;
    for i in 0..h.count {
        if h.land[i] == 0 && !by_boat(i) {
            continue;
        }
        for e in h.edges(i) {
            let u = h.nbr[e] as usize;
            let km = h.dist_km[e] as f64;
            if h.land[i] != 0 && h.land[u] != 0 {
                let ease = terrain_ease(h.biome[u]);
                if ease <= 0.0 {
                    continue;
                }
                let grade = (h.height_m[u] as f64 - h.height_m[i] as f64) / (km * 1000.0);
                let mut km_day = WALK_HOURS * 6.0 * det_exp(-3.5 * (grade + 0.05).abs()) * ease;
                if h.river_size[i] as f64 >= RIVER_BOAT_SIZE
                    && h.river_size[u] as f64 >= RIVER_BOAT_SIZE
                {
                    km_day = js::max(
                        km_day,
                        if h.height_m[u] <= h.height_m[i] {
                            RIVER_DOWN_KM_DAY
                        } else {
                            RIVER_UP_KM_DAY
                        },
                    );
                }
                days[e] = (km / km_day) as f32;
            } else if by_boat(i) && by_boat(u) {
                days[e] = (km / COAST_KM_DAY) as f32;
            } else if by_boat(i) || by_boat(u) {
                days[e] = (km / COAST_KM_DAY + LANDING_DAYS) as f32;
            }
        }
    }
    days
}

/// From the cells `from` over the ways, the nearest first, as far as
/// `max_days`: `dist` set on each cell reached (the caller's, Infinity
/// elsewhere, set back by `reset`), `visit(cell, days)` for each, stopping
/// where it returns true; `owner`, if given, set on each cell reached to the
/// index in `from` of the cell nearest it. The cells reached, to reset.
pub fn within_days(
    h: &Habitat,
    days: &[f32],
    from: &[usize],
    max_days: f64,
    dist: &mut [f32],
    mut visit: Option<&mut dyn FnMut(usize, f64) -> bool>,
    mut owner: Option<&mut [i32]>,
) -> Vec<usize> {
    let mut touched = Vec::new();
    let mut heap = MinHeap::new(256);
    for (k, &c) in from.iter().enumerate() {
        if dist[c] == 0.0 {
            continue;
        }
        dist[c] = 0.0;
        if let Some(o) = owner.as_deref_mut() {
            o[c] = k as i32;
        }
        touched.push(c);
        heap.push(0.0, c as i32);
    }
    while !heap.is_empty() {
        heap.pop();
        let i = heap.popped_index as usize;
        let d = heap.popped_key;
        if d > dist[i] as f64 {
            continue;
        }
        if let Some(v) = visit.as_deref_mut()
            && v(i, d)
        {
            break;
        }
        for e in h.edges(i) {
            let nd = d + days[e] as f64;
            let u = h.nbr[e] as usize;
            if nd > max_days || nd >= dist[u] as f64 {
                continue;
            }
            if dist[u] == f32::INFINITY {
                touched.push(u);
            }
            dist[u] = nd as f32;
            if let Some(o) = owner.as_deref_mut() {
                o[u] = o[i];
            }
            heap.push(nd, u as i32);
        }
    }
    touched
}

pub fn reset(dist: &mut [f32], touched: &[usize]) {
    for &c in touched {
        dist[c] = f32::INFINITY;
    }
}
