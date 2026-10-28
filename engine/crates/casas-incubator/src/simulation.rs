//! `screens/incubator/simulation.ts`: THE HISTORY — the people over the span
//! in steps of STEP_YEARS on the habitat's cells, the climate, the sea, the
//! game, the farming and the herding, the villages and the camps, the
//! droughts, the log. The reasoning is in the TypeScript file; this is its
//! port, step for step, draw for draw: a double where the TypeScript
//! computes, a float where it keeps a Float32Array.
//!
//! STEP 2 OF THE PREHISTORY (docs/design/prehistory-in-three-steps.md):
//! the simulation begins where step 1 (peopling.rs) ends, with the people
//! where it brought them, at the carrying capacity, each cell's arrival
//! and the cell it came from as step 1 gives them, and each region's
//! knowledge at what its people give. Before that, the kept states and the
//! people's count are step 1's: its cells at the capacity of their time.
//! The big game is not hunted before step 2.

use crate::climate_history::{ClimateHistory, ICE_REACH_KM, cold_share, ice_may_cover};
use crate::habitat::{ARABLE, FISH, Habitat, PASTURE, km_between};
use crate::log::{LogEvent, POPULATION_MARKS};
use crate::peopling::Peopling;
use crate::travel::{reset, travel_days, within_days};
use casas_engine::climate::biomes::biome;
use casas_engine::core::det_math::{det_cos, det_exp, det_log};
use casas_engine::core::js;
use casas_engine::core::min_heap::MinHeap;
use casas_engine::core::rng::Mulberry32;
use std::collections::{HashMap, HashSet};
use std::f64::consts::{LN_10, PI};

pub const SPAN_YEARS: f64 = 100_000.0;
pub const KEEP_YEARS: f64 = 2500.0;
pub const POPULATION_STEP: f64 = 500.0;
pub const STEP_YEARS: f64 = 25.0;
pub const PEOPLE_FRAME_STEP: f64 = 1e-3;
pub const CAME_STEP: f64 = 10.0;
pub const CAME_NEVER: u16 = 0xffff;
pub const SETTLE_AFTER: f64 = 3000.0;
pub const FISH_RICH: f64 = 0.5;
/// niche.ts SUITABLE 0.3, coded (settleShared.ts PLANT_SUITS_CODE).
pub fn plant_suits_code() -> u8 {
    (2.0 + js::round(253.0 * 0.3)) as u8
}

/// settleShared.ts LIFEWAY.
pub mod lifeway {
    pub const NONE: u8 = 0;
    pub const FORAGERS: u8 = 1;
    pub const FISHERS: u8 = 2;
    pub const HERDERS: u8 = 3;
    pub const FARMERS: u8 = 4;
}
use lifeway::{FARMERS, FISHERS, FORAGERS, HERDERS, NONE};

/// settle.ts VILLAGE_LEAST: the least people a km² of a village, by its
/// lifeway (the fishers, the farmers).
pub fn village_least(way: u8) -> f64 {
    match way {
        FISHERS => 0.3,
        FARMERS => 2.0,
        _ => f64::NAN,
    }
}

pub(crate) const SUB_STEPS: usize = 3;
pub(crate) const FORAGER_DENSITY: f64 = 0.1;
pub(crate) const CARRYING_FULL: f64 = 0.8;
pub(crate) const GROWTH_A: f64 = 0.01;
pub(crate) const SEED_SHARE: f64 = 1.0 / 3.0;
pub(crate) const SEED_PEOPLE: f64 = 0.2;
pub(crate) const FULL_SHARE: f64 = 0.95;
pub(crate) const SPEED_MIN_KM_A: f64 = 0.05;
pub(crate) const SPEED_MAX_KM_A: f64 = 0.5;
pub(crate) const SLOPE_DRAG: f64 = 10.0;
pub(crate) const CORRIDOR: f64 = 2.0;
pub(crate) const SHELF_M: f64 = 120.0;
pub(crate) const CLIMATE_YEARS: f64 = 500.0;
pub(crate) const GAME_STEPS: usize = 8;
pub(crate) const SMALL_REGROW_A: f64 = 0.05;
pub(crate) const BIG_REGROW_A: f64 = 0.002;
pub(crate) const HUNT_A: f64 = 0.02;
pub(crate) const BIG_HUNT_A: f64 = 0.01;
pub(crate) const HOME_WARY: f64 = 0.03;
pub(crate) const PLANT_FOOD: f64 = 0.5;
pub(crate) const SMALL_FOOD: f64 = 0.35;
pub(crate) const BIG_FOOD: f64 = 0.15;
pub(crate) const EXTINCT_BELOW: f64 = 0.1;
pub(crate) const FOOD_MOVED: f64 = 0.02;
pub(crate) const CAPACITY_MOVED: f64 = 0.02;
pub(crate) const FISH_GAIN: f64 = 10.0;
pub(crate) const CAMP_YEARS: f64 = 2500.0;
pub(crate) const CAMP_DAYS_MOST: f64 = 6.0;
pub(crate) const CAMP_MOVE: f64 = 1.5;
pub(crate) const VILLAGE_DAYS_MOST: f64 = 2.0;
pub(crate) const DRY_SQUARE_KM: f64 = 300.0;
pub(crate) const DRY_SCALE: f64 = 0.25;
pub(crate) const STORE_STEPS: i32 = 2;
pub(crate) const DRY_KEEP: f64 = 0.6;
pub(crate) const DRY_BELOW: f64 = 0.75;
pub(crate) const ENSO_CHANCE: f64 = 0.3;
pub(crate) const ENSO_PUSH: f64 = 1.5;
pub(crate) const FAMINE_DEATH: f64 = 0.5;
pub(crate) const EXCHANGE: f64 = 0.5;
pub(crate) const EXCHANGE_DAYS: f64 = 2.0;
pub(crate) const FLIGHT_CROWD: f64 = 1.5;
pub(crate) const VILLAGE_LEAVE: f64 = 0.5;
pub(crate) const SETTLED_YEARS: f64 = 5000.0;
pub(crate) const FARM_RATE: f64 = 0.3;
pub(crate) const HERD_RATE: f64 = 0.1;
pub(crate) const CENTRE_CROPS: usize = 2;
pub(crate) const CENTRE_ARABLE: f64 = 0.5;
pub(crate) const CENTRE_HERDS: usize = 2;
pub(crate) const CENTRE_PASTURE: f64 = 0.5;
pub(crate) const KNOW_FARM: f64 = 1.0;
pub(crate) const KNOW_HERD: f64 = 0.8;
pub(crate) const CENTRE_SPACING_KM: f64 = 1500.0;
pub(crate) const HERD_LAG: f64 = 1000.0;
pub(crate) const FARM_KM_A: f64 = 1.0;
pub(crate) const HERD_KM_A: f64 = 2.0;
pub(crate) const FARM_BARRIER: f64 = 5.0;
pub(crate) const HERD_BARRIER: f64 = 3.0;
pub(crate) const FARM_ARABLE: f64 = 0.3;
pub(crate) const HERD_PASTURE: f64 = 0.3;
pub(crate) const FARM_GAIN: f64 = 100.0;
pub(crate) const HERD_GAIN: f64 = 10.0;
pub(crate) const MAX_TAMED: usize = 32;
pub(crate) const KNOW_SCALE: f64 = 1.0;
pub(crate) const KNOW_PEOPLE: f64 = 3000.0;
pub(crate) const KNOW_GAIN: f64 = 0.1;
pub(crate) const KNOW_LOSS: f64 = 0.02;
pub(crate) const KNOW_CARRIED: f64 = 0.8;
pub(crate) const REACH_START: f64 = 30.0;
pub(crate) const REACH_PER_KNOW: f64 = 150.0;
pub(crate) const REACH_END: f64 = 450.0;
pub(crate) const CROSSING_CHANCE: f64 = 0.02;
pub(crate) const ROUTE_SLACK_YEARS: f64 = 1000.0;
pub(crate) const STONE_CELLS: i32 = 100;
pub(crate) const STONE_CHANCE: f64 = 0.5;
pub(crate) const CROSSINGS_A_PAIR: usize = 32;
pub(crate) const VOYAGE_KM: f64 = 3000.0;

fn camp_least(way: u8) -> f64 {
    if way == FORAGERS { 0.1 } else { 0.3 }
}
fn camp_days(way: u8) -> f64 {
    if way == FORAGERS { 6.0 } else { 4.0 }
}
fn village_days(way: u8) -> f64 {
    if way == FISHERS { 2.0 } else { 1.5 }
}

/// A layer of a domesticable plant or animal, or of the big game.
pub struct Layer<'a> {
    pub id: String,
    pub codes: &'a [u8],
}

pub struct BigGame<'a> {
    pub id: String,
    pub codes: &'a [u8],
    pub vulnerability: f64,
}

pub struct Rain {
    pub variability: Vec<f32>,
    pub enso: Vec<f32>,
    pub enso_strength: f64,
}

pub struct SimulationInput<'a> {
    pub carrying: &'a [f32],
    pub origin: i32,
    /// Step 1 from `origin`.
    pub peopling: &'a Peopling,
    pub seed: f64,
    pub big_game: Vec<BigGame<'a>>,
    pub crops: Vec<Layer<'a>>,
    pub herds: Vec<Layer<'a>>,
    pub rain: Option<Rain>,
}

/// A kept state (simulation.ts SimFrame).
pub struct SimFrame {
    pub people: Vec<u16>,
    pub small: Vec<u8>,
    pub big: Vec<Vec<u8>>,
}

pub struct Extinction {
    pub id: String,
    pub landmass: f64,
    pub area_km2: f64,
    pub at: f64,
    pub cell: f64,
}

pub struct Domestication {
    pub plant: bool,
    pub id: String,
    pub cell: f64,
    pub at: f64,
    pub came: Vec<u16>,
}

/// simulation.ts SimulationResult, but its knowledge and regions.
pub struct SimulationResult {
    pub arrival: Vec<f32>,
    pub land: Vec<u8>,
    pub from: Vec<i32>,
    pub flow: Vec<f32>,
    pub origin: i32,
    pub crossings: Vec<f32>,
    pub crossing_ways: Vec<i32>,
    pub kept: Vec<SimFrame>,
    pub species: Vec<(String, Vec<i32>)>,
    pub climate: (f64, f64, f64),
    pub extinctions: Vec<Extinction>,
    pub log: Vec<LogEvent>,
    pub centres: Vec<f32>,
    pub farm_at: Vec<f32>,
    pub herd_at: Vec<f32>,
    pub domestications: Vec<Domestication>,
    pub villages: Vec<i32>,
    pub village_from: Vec<f32>,
    pub village_to: Vec<f32>,
    pub population: Vec<f32>,
}

/// Each cell's distance from today's glaciers over the cold climates, km
/// (simulation.ts iceDistance).
pub fn ice_distance(h: &Habitat) -> Vec<f32> {
    let n = h.count;
    let mut ice_km = vec![f32::INFINITY; n];
    let mut heap = MinHeap::new(1 << 16);
    for i in 0..n {
        if h.land[i] == 0 || (h.biome[i] != biome::ICE && h.biome[i] != biome::GLACIER) {
            continue;
        }
        ice_km[i] = 0.0;
        heap.push(0.0, i as i32);
    }
    while !heap.is_empty() {
        heap.pop();
        let i = heap.popped_index as usize;
        let d = heap.popped_key;
        if d > ice_km[i] as f64 {
            continue;
        }
        for e in h.edges(i) {
            let u = h.nbr[e] as usize;
            let nd = d + h.dist_km[e] as f64;
            if h.land[u] == 0
                || !ice_may_cover(h.koppen[u])
                || nd >= ice_km[u] as f64
                || nd > ICE_REACH_KM
            {
                continue;
            }
            ice_km[u] = nd as f32;
            heap.push(nd, u as i32);
        }
    }
    ice_km
}

fn regions_of(h: &Habitat, habitable: &dyn Fn(usize) -> bool) -> (Vec<i32>, usize) {
    let n = h.count;
    let mut region = vec![-1i32; n];
    let mut regions = 0usize;
    let mut stack = Vec::new();
    for s0 in 0..n {
        if h.land[s0] == 0 || !habitable(s0) || region[s0] >= 0 {
            continue;
        }
        region[s0] = regions as i32;
        stack.push(s0);
        while let Some(c) = stack.pop() {
            for e in h.edges(c) {
                let u = h.nbr[e] as usize;
                if h.land[u] == 0 || !habitable(u) || region[u] >= 0 {
                    continue;
                }
                region[u] = regions as i32;
                stack.push(u);
            }
        }
        regions += 1;
    }
    (region, regions)
}

#[derive(Clone)]
struct Crossing {
    from: usize,
    to: usize,
    km: f64,
    path: Vec<usize>,
    a: usize,
    b: usize,
}

/// The crossings, once (simulation.ts crossingsOf).
fn crossings_of(
    h: &Habitat,
    max_km: f64,
    habitable: &dyn Fn(usize) -> bool,
    region: &[i32],
) -> Vec<Crossing> {
    let n = h.count;
    let mut voyage = vec![f64::INFINITY; n];
    let mut stretch = vec![0f32; n];
    let mut longest = vec![0f32; n];
    let mut source = vec![-1i32; n];
    let mut prev = vec![-1i32; n];
    let mut heap = MinHeap::new(1 << 16);
    let mut coastal = vec![0u8; n];
    for i in 0..n {
        if h.land[i] != 0 {
            continue;
        }
        for e in h.edges(i) {
            if coastal[i] != 0 {
                break;
            }
            if h.land[h.nbr[e] as usize] != 0 {
                coastal[i] = 1;
            }
        }
    }
    for i in 0..n {
        if h.land[i] == 0 || !habitable(i) {
            continue;
        }
        for e in h.edges(i) {
            if h.land[h.nbr[e] as usize] != 0 {
                continue;
            }
            voyage[i] = 0.0;
            source[i] = i as i32;
            heap.push(0.0, i as i32);
            break;
        }
    }
    // The best a key, in the order the keys came.
    let mut best: Vec<Crossing> = Vec::new();
    let mut best_at: HashMap<(i32, i32), usize> = HashMap::new();
    let mut meet =
        |a: usize, b: usize, source: &[i32], longest: &[f32], best: &mut Vec<Crossing>| {
            let ma = region[source[a] as usize];
            let mb = region[source[b] as usize];
            let km = js::max(longest[a] as f64, longest[b] as f64);
            if ma == mb || km > max_km {
                return;
            }
            for (from, to, sa, sb) in [
                (source[a] as usize, source[b] as usize, a, b),
                (source[b] as usize, source[a] as usize, b, a),
            ] {
                let key = (from as i32, region[to]);
                match best_at.get(&key) {
                    Some(&k) => {
                        if km < best[k].km {
                            best[k] = Crossing {
                                from,
                                to,
                                km,
                                path: Vec::new(),
                                a: sa,
                                b: sb,
                            };
                        }
                    }
                    None => {
                        best_at.insert(key, best.len());
                        best.push(Crossing {
                            from,
                            to,
                            km,
                            path: Vec::new(),
                            a: sa,
                            b: sb,
                        });
                    }
                }
            }
        };
    while !heap.is_empty() {
        heap.pop();
        let i = heap.popped_index as usize;
        let d = heap.popped_key;
        if d > voyage[i] {
            continue;
        }
        for e in h.edges(i) {
            let u = h.nbr[e] as usize;
            if h.land[u] != 0 {
                if source[u] >= 0 && source[u] != source[i] {
                    meet(i, u, &source, &longest, &mut best);
                }
                continue;
            }
            if source[u] >= 0 && region[source[u] as usize] != region[source[i] as usize] {
                meet(i, u, &source, &longest, &mut best);
            }
            let nd = d + h.dist_km[e] as f64;
            let open = if coastal[u] != 0 {
                0.0
            } else {
                stretch[i] as f64 + h.dist_km[e] as f64
            };
            let most = js::max(longest[i] as f64, open);
            if nd >= voyage[u] || nd > VOYAGE_KM || most > max_km {
                continue;
            }
            voyage[u] = nd;
            prev[u] = i as i32;
            stretch[u] = open as f32;
            longest[u] = most as f32;
            source[u] = source[i];
            heap.push(nd, u as i32);
        }
    }
    // By pair of regions, in the order the pairs came.
    let mut pairs: Vec<Vec<Crossing>> = Vec::new();
    let mut pair_at: HashMap<(i32, i32), usize> = HashMap::new();
    for c in best {
        let key = (region[c.from], region[c.to]);
        match pair_at.get(&key) {
            Some(&k) => pairs[k].push(c),
            None => {
                pair_at.insert(key, pairs.len());
                pairs.push(vec![c]);
            }
        }
    }
    let back = |x: usize| -> Vec<usize> {
        let mut chain = Vec::new();
        let mut c = x as i32;
        while c >= 0 {
            chain.push(c as usize);
            c = prev[c as usize];
        }
        chain
    };
    let mut kept = Vec::new();
    for mut list in pairs {
        list.sort_by(|a, b| a.km.partial_cmp(&b.km).unwrap());
        list.truncate(CROSSINGS_A_PAIR);
        for mut c in list {
            let mut path = back(c.a);
            path.reverse();
            path.extend(back(c.b));
            c.path = path;
            kept.push(c);
        }
    }
    kept
}

struct Species {
    id: String,
    cells: Vec<i32>,
    share: Vec<f32>,
    // Its cells' positions by landmass, in the order the landmasses came.
    by_landmass: Vec<(i32, Vec<usize>)>,
    regrow: f64,
    hunt: f64,
    gone: HashSet<i32>,
}

struct Tamed {
    plant: bool,
    id: String,
    cell: usize,
    at: f64,
    came: Vec<u16>,
    // Its codes: an index into the input's crops or herds.
    layer: usize,
}

struct Famine {
    at: f64,
    cell: i32,
    before: f64,
    lost: f64,
    left: f64,
    villages: f64,
}

struct Sim<'h, 'a> {
    h: &'h Habitat,
    input: &'h SimulationInput<'a>,
    random: Mulberry32,
    capacity: Vec<f32>,
    small: Vec<f32>,
    species: Vec<Species>,
    big_sum: Vec<f32>,
    big_count: Vec<u8>,
    farm_at: Vec<f32>,
    herd_at: Vec<f32>,
    tamed_bits: Vec<u32>,
    centres: Vec<f64>,
    tamed: Vec<Tamed>,
    farm_front: Vec<usize>,
    herd_front: Vec<usize>,
    fishing: Vec<u8>,
    dry_square: Vec<i32>,
    square_rain: Vec<f32>,
    fed: Vec<f32>,
    people: Vec<f32>,
    arrival: Vec<f32>,
    from: Vec<i32>,
    growing: Vec<usize>,
    in_growing: Vec<u8>,
    front: Vec<usize>,
    lived: Vec<usize>,
    landmass_reached: Vec<u8>,
    log: Vec<LogEvent>,
}

impl Sim<'_, '_> {
    fn eco(&self, field: usize, i: usize) -> f64 {
        self.h.eco(field, i)
    }

    fn rain_of(&self, i: usize) -> f64 {
        let r = if self.dry_square[i] >= 0 {
            self.square_rain[self.dry_square[i] as usize] as f64
        } else {
            1.0
        };
        r + (1.0 - r) * EXCHANGE * self.fed[i] as f64
    }

    fn gain(&self, i: usize) -> f64 {
        let r = self.rain_of(i);
        let fields = if self.farm_at[i] < f32::INFINITY {
            1.0 + FARM_GAIN * self.eco(ARABLE, i) * r
        } else if self.fishing[i] != 0 {
            1.0 + FISH_GAIN * self.eco(FISH, i)
        } else {
            1.0
        };
        let herds = if self.herd_at[i] < f32::INFINITY {
            1.0 + HERD_GAIN * self.eco(PASTURE, i) * r
        } else {
            1.0
        };
        fields * herds * ((1.0 + r) / 2.0)
    }

    fn food(&self, i: usize) -> f64 {
        let small = self.small[i] as f64;
        PLANT_FOOD
            + if self.big_count[i] != 0 {
                SMALL_FOOD * small + BIG_FOOD * (self.big_sum[i] as f64 / self.big_count[i] as f64)
            } else {
                (SMALL_FOOD + BIG_FOOD) * small
            }
    }

    fn carried(&self, i: usize) -> f64 {
        self.capacity[i] as f64 * self.food(i) * self.gain(i)
    }

    fn codes_of(&self, d: usize) -> &[u8] {
        let t = &self.tamed[d];
        if t.plant {
            self.input.crops[t.layer].codes
        } else {
            self.input.herds[t.layer].codes
        }
    }

    fn suits(&self, d: usize, cell: usize) -> bool {
        let c = self.codes_of(d)[cell];
        if self.tamed[d].plant {
            (c == 1 || c >= plant_suits_code()) && self.eco(ARABLE, cell) >= FARM_ARABLE
        } else {
            c >= 1 && self.eco(PASTURE, cell) >= HERD_PASTURE
        }
    }

    fn grows(&mut self, cell: usize) {
        if self.in_growing[cell] != 0 {
            return;
        }
        self.in_growing[cell] = 1;
        self.growing.push(cell);
    }

    fn take(&mut self, d: usize, cell: usize, t: f64) {
        if self.tamed_bits[cell] & (1 << d) != 0 {
            return;
        }
        self.tamed_bits[cell] |= 1 << d;
        let plant = self.tamed[d].plant;
        if plant {
            self.farm_front.push(cell);
        } else {
            self.herd_front.push(cell);
        }
        if !self.suits(d, cell) {
            return;
        }
        self.tamed[d].came[cell] = js::round(t / CAME_STEP) as u16;
        if plant {
            self.farm_at[cell] = js::min(self.farm_at[cell] as f64, t) as f32;
        } else {
            self.herd_at[cell] = js::min(self.herd_at[cell] as f64, t) as f32;
        }
    }

    fn tame(&mut self, plant: bool, layer: usize, cell: usize, t: f64) {
        if self.tamed.len() >= MAX_TAMED {
            return;
        }
        let id = if plant {
            self.input.crops[layer].id.clone()
        } else {
            self.input.herds[layer].id.clone()
        };
        self.log.push(LogEvent::Domesticated {
            at: t,
            cell: cell as f64,
            id: id.clone(),
            plant,
        });
        self.tamed.push(Tamed {
            plant,
            id,
            cell,
            at: t,
            came: vec![CAME_NEVER; self.h.count],
            layer,
        });
        let d = self.tamed.len() - 1;
        self.take(d, cell, t);
    }

    fn far_centre(&self, cell: usize, way: u8) -> bool {
        let mut k = 0;
        while k < self.centres.len() {
            if self.centres[k + 2] == way as f64
                && km_between(self.h, cell, self.centres[k] as usize) < CENTRE_SPACING_KM
            {
                return false;
            }
            k += 3;
        }
        true
    }

    fn settle(&mut self, cell: usize, t: f64, density: f64, parent: i32) {
        self.people[cell] = density as f32;
        if self.arrival[cell] == f32::INFINITY {
            self.arrival[cell] = t as f32;
            self.from[cell] = parent;
            if self.h.landmass[cell] >= 0 {
                self.landmass_reached[self.h.landmass[cell] as usize] = 1;
            }
        }
        self.grows(cell);
        self.front.push(cell);
        self.lived.push(cell);
    }

    fn open(&self, u: usize) -> bool {
        self.people[u] == 0.0 && self.capacity[u] > 0.0
    }

    fn is_camp(villages: &[i32], v: usize) -> bool {
        let way = villages[2 * v + 1] as u8;
        way == FORAGERS || way == HERDERS
    }
}

/// The foragers' density a cell carries in today's climate (people a km²),
/// the speed of their front over it (km a year), and whether it is a shelf
/// the sea can leave dry; 0 for ice and for the sea below SHELF_M.
pub(crate) struct Ground {
    pub base: Vec<f32>,
    pub speed: Vec<f32>,
    pub shelf: Vec<u8>,
}

pub(crate) fn ground_of(h: &Habitat, carrying: &[f32]) -> Ground {
    let n = h.count;
    let land = &h.land;
    let mut base = vec![0f32; n];
    let mut speed = vec![0f32; n];
    let mut shelf = vec![0u8; n];
    for i in 0..n {
        if land[i] == 0 {
            if h.sea_depth_m[i] as f64 > SHELF_M {
                continue;
            }
            shelf[i] = 1;
            base[i] = (FORAGER_DENSITY * 0.05) as f32;
            speed[i] = (SPEED_MIN_KM_A * CORRIDOR) as f32;
            continue;
        }
        if h.biome[i] == biome::ICE || h.biome[i] == biome::GLACIER {
            continue;
        }
        let k = js::min(2.0, carrying[i] as f64 / CARRYING_FULL);
        base[i] = (FORAGER_DENSITY * js::max(0.05, k)) as f32;
        let mut v = SPEED_MIN_KM_A + (SPEED_MAX_KM_A - SPEED_MIN_KM_A) * js::min(1.0, k);
        v /= 1.0 + h.slope[i] as f64 * SLOPE_DRAG;
        if h.near_river[i] != 0 || h.near_sea[i] != 0 {
            v *= CORRIDOR;
        }
        speed[i] = v as f32;
    }
    Ground { base, speed, shelf }
}

pub fn simulate(
    h: &Habitat,
    input: &SimulationInput,
    mut on_progress: Option<&mut dyn FnMut(f64)>,
) -> SimulationResult {
    let n = h.count;
    let land = &h.land;
    let climate = ClimateHistory::of(input.seed, SPAN_YEARS);
    let Ground { base, speed, shelf } = ground_of(h, input.carrying);
    let ice_km = ice_distance(h);
    let mut moved_now = vec![0u8; n];
    let update_climate = |t: f64, capacity: &mut [f32], moved_now: &mut [u8]| {
        let cold = climate.cold(t);
        let drop = climate.sea_drop_m(t);
        for i in 0..n {
            if base[i] <= 0.0 {
                continue;
            }
            let was = capacity[i] as f64;
            let now = if shelf[i] != 0 {
                if h.sea_depth_m[i] as f64 <= drop {
                    base[i] as f64
                } else {
                    0.0
                }
            } else {
                base[i] as f64 * cold_share(h.koppen[i], ice_km[i] as f64, cold)
            };
            capacity[i] = now as f32;
            let c = capacity[i] as f64;
            moved_now[i] = u8::from((c - was).abs() >= CAPACITY_MOVED * js::max(was, c));
        }
    };
    let habitable = |i: usize| land[i] == 1 && base[i] > 0.0;
    let (region, regions) = regions_of(h, &habitable);
    let crossings = crossings_of(h, REACH_END, &habitable, &region);
    let mut knowledge = vec![0f32; regions];
    let mut region_people = vec![0f64; regions];
    let mut seafaring = vec![0f32; regions];
    let mut region_cells = vec![0i32; regions];
    for i in 0..n {
        if region[i] >= 0 {
            region_cells[region[i] as usize] += 1;
        }
    }
    let sea_known = |knowledge: &[f32], seafaring: &[f32], g: usize| {
        js::max(knowledge[g] as f64, seafaring[g] as f64)
    };
    let mut links: Vec<usize> = Vec::new();
    // The crossings by their coast cell, in the order the cells came.
    let mut crossings_from: Vec<(usize, Vec<usize>)> = Vec::new();
    {
        let mut at: HashMap<usize, usize> = HashMap::new();
        for (k, c) in crossings.iter().enumerate() {
            match at.get(&c.from) {
                Some(&p) => crossings_from[p].1.push(k),
                None => {
                    at.insert(c.from, crossings_from.len());
                    crossings_from.push((c.from, vec![k]));
                }
            }
        }
    }

    let species: Vec<Species> = input
        .big_game
        .iter()
        .map(|g| {
            let cells: Vec<i32> = (0..n)
                .filter(|&i| g.codes[i] >= 2)
                .map(|i| i as i32)
                .collect();
            let mut by_landmass: Vec<(i32, Vec<usize>)> = Vec::new();
            let mut at: HashMap<i32, usize> = HashMap::new();
            for (k, &i) in cells.iter().enumerate() {
                let m = h.landmass[i as usize];
                if m < 0 {
                    continue;
                }
                match at.get(&m) {
                    Some(&p) => by_landmass[p].1.push(k),
                    None => {
                        at.insert(m, by_landmass.len());
                        by_landmass.push((m, vec![k]));
                    }
                }
            }
            Species {
                id: g.id.clone(),
                share: vec![1f32; cells.len()],
                cells,
                by_landmass,
                regrow: BIG_REGROW_A * (1.2 - g.vulnerability),
                hunt: BIG_HUNT_A * (g.vulnerability / 0.5),
                gone: HashSet::new(),
            }
        })
        .collect();
    let mut big_sum = vec![0f32; n];
    let mut big_count = vec![0u8; n];
    for sp in &species {
        for &i in &sp.cells {
            big_sum[i as usize] += 1.0;
            big_count[i as usize] += 1;
        }
    }
    let home_landmass = if input.origin >= 0 {
        h.landmass[input.origin as usize]
    } else {
        -1
    };

    let mut sim = Sim {
        h,
        input,
        random: Mulberry32::new(js::to_uint32(input.seed) ^ 0x51a7),
        capacity: vec![0f32; n],
        small: vec![1f32; n],
        species,
        big_sum,
        big_count,
        farm_at: vec![f32::INFINITY; n],
        herd_at: vec![f32::INFINITY; n],
        tamed_bits: vec![0u32; n],
        centres: Vec::new(),
        tamed: Vec::new(),
        farm_front: Vec::new(),
        herd_front: Vec::new(),
        fishing: vec![0u8; n],
        dry_square: vec![-1i32; n],
        square_rain: Vec::new(),
        fed: vec![0f32; n],
        people: vec![0f32; n],
        arrival: vec![f32::INFINITY; n],
        from: vec![-1i32; n],
        growing: Vec::new(),
        in_growing: vec![0u8; n],
        front: Vec::new(),
        lived: Vec::new(),
        landmass_reached: vec![0u8; h.landmasses],
        log: Vec::new(),
    };
    let mut extinctions: Vec<Extinction> = Vec::new();
    let mut herds_due: Vec<(usize, f64)> = Vec::new();
    let mut villages: Vec<i32> = Vec::new();
    let mut village_from: Vec<f64> = Vec::new();
    let mut village_to: Vec<f64> = Vec::new();
    let mut village_at = vec![-1i32; n];
    let way_days = travel_days(h);
    let mut near_village = vec![f32::INFINITY; n];
    let mut scratch_days = vec![f32::INFINITY; n];
    let mut villages_left = false;
    let mut near_camp = vec![f32::INFINITY; n];
    let mut camp_owner = vec![-1i32; n];
    let mut population = vec![0f32; (SPAN_YEARS / POPULATION_STEP).floor() as usize + 1];
    let mut next_mark = 0usize;
    let mut hunted: Vec<usize> = Vec::new();
    let mut in_hunted = vec![0u8; n];
    let mut made: Vec<f64> = Vec::new();
    let mut ways: Vec<i32> = Vec::new();
    let mut kept: Vec<SimFrame> = Vec::new();

    // Step 1's span, its cells by arrival and its log.
    let start = input.peopling;
    let t0 = start.span;
    let mut by_arrival: Vec<usize> = (0..n)
        .filter(|&i| start.arrival[i] < f32::INFINITY)
        .collect();
    by_arrival.sort_by(|&a, &b| {
        start.arrival[a]
            .total_cmp(&start.arrival[b])
            .then(a.cmp(&b))
    });
    let mut arrived = 0usize;
    sim.log.extend(start.log.iter().cloned());

    // The droughts' squares.
    let mut square_cells: Vec<Vec<usize>> = Vec::new();
    if input.rain.is_some() {
        let mut ids: HashMap<(i32, i64, i64), usize> = HashMap::new();
        let rows = js::max(
            1.0,
            js::round(
                (if h.radius_km > 0.0 {
                    PI * h.radius_km
                } else {
                    h.height_km
                }) / DRY_SQUARE_KM,
            ),
        );
        for i in 0..n {
            if land[i] == 0 {
                continue;
            }
            let row = js::min(rows - 1.0, (h.v[i] as f64 * rows).floor());
            let around = if h.radius_km > 0.0 {
                2.0 * PI * h.radius_km * det_cos((0.5 - (row + 0.5) / rows) * PI)
            } else {
                h.width_km
            };
            let cols = js::max(1.0, js::round(around / DRY_SQUARE_KM));
            let col = js::min(cols - 1.0, (h.u[i] as f64 * cols).floor());
            let key = (h.landmass[i], row as i64, col as i64);
            let id = *ids.entry(key).or_insert_with(|| {
                square_cells.push(Vec::new());
                square_cells.len() - 1
            });
            sim.dry_square[i] = id as i32;
            square_cells[id].push(i);
        }
    }
    let squares = square_cells.len();
    let mut square_variability = vec![0f32; squares];
    let mut square_enso = vec![0f32; squares];
    if let Some(rain) = &input.rain {
        for q in 0..squares {
            let len = square_cells[q].len() as f64;
            for &i in &square_cells[q] {
                square_variability[q] =
                    (square_variability[q] as f64 + rain.variability[i] as f64 / len) as f32;
                square_enso[q] = (square_enso[q] as f64 + rain.enso[i] as f64 / len) as f32;
            }
        }
    }
    let mut anomaly = vec![0f32; squares];
    sim.square_rain = vec![1f32; squares];
    let mut dry_run = vec![0i32; squares];
    let mut famine: Vec<Option<Famine>> = (0..squares).map(|_| None).collect();
    let square_rim: Vec<Vec<usize>> = {
        let mut seen = vec![usize::MAX; n];
        square_cells
            .iter()
            .enumerate()
            .map(|(q, cells)| {
                let mut rim = Vec::new();
                for &i in cells {
                    for e in h.edges(i) {
                        let u = h.nbr[e] as usize;
                        if sim.dry_square[u] != q as i32 && base[u] > 0.0 && seen[u] != q {
                            seen[u] = q;
                            rim.push(u);
                        }
                    }
                }
                rim
            })
            .collect()
    };
    let end_famine = |famine: &mut [Option<Famine>], q: usize, t: f64, log: &mut Vec<LogEvent>| {
        let Some(f) = famine[q].take() else { return };
        if f.cell < 0 {
            return;
        }
        log.push(LogEvent::Famine {
            at: f.at,
            to: t,
            cell: f.cell as f64,
            landmass: h.landmass[f.cell as usize] as f64,
            before: f.before,
            lost: f.lost,
            left: f.left,
            villages: f.villages,
        });
    };

    let steps = js::round(SPAN_YEARS / STEP_YEARS) as usize;
    let sub_years = STEP_YEARS / SUB_STEPS as f64;
    let grow = 1.0 - det_exp(-GROWTH_A * STEP_YEARS);
    let plant_code = plant_suits_code();
    for s in 0..=steps {
        let t = s as f64 * STEP_YEARS;
        // Step 1: its cells reached by `t` at the capacity of the time.
        if t <= t0 {
            if t % CLIMATE_YEARS != 0.0 {
                continue;
            }
            update_climate(t, &mut sim.capacity, &mut moved_now);
            while arrived < by_arrival.len() && start.arrival[by_arrival[arrived]] as f64 <= t {
                arrived += 1;
            }
            sim.lived.clear();
            for &i in &by_arrival[..arrived] {
                sim.people[i] = sim.capacity[i];
                if sim.capacity[i] > 0.0 {
                    sim.lived.push(i);
                }
            }
        }
        // Step 2 begins: step 1's people, their arrival and where they
        // came from, the knowledge their numbers give.
        if t == t0 {
            for &i in &by_arrival {
                sim.arrival[i] = start.arrival[i];
                sim.from[i] = start.from[i];
                if land[i] != 0 && h.landmass[i] >= 0 {
                    sim.landmass_reached[h.landmass[i] as usize] = 1;
                }
            }
            sim.front = sim.lived.clone();
            for k in 0..sim.lived.len() {
                let i = sim.lived[k];
                sim.grows(i);
                if region[i] >= 0 {
                    region_people[region[i] as usize] +=
                        sim.people[i] as f64 * h.area_km2[i] as f64;
                }
            }
            for g in 0..regions {
                knowledge[g] =
                    (KNOW_SCALE * (det_log(1.0 + region_people[g] / KNOW_PEOPLE) / LN_10)) as f32;
            }
        }
        if t % KEEP_YEARS == 0.0 {
            let mut frame = SimFrame {
                people: vec![0u16; n],
                small: vec![0u8; n],
                big: sim
                    .species
                    .iter()
                    .map(|sp| vec![0u8; sp.share.len()])
                    .collect(),
            };
            for i in 0..n {
                let p = sim.people[i] as f64 / PEOPLE_FRAME_STEP;
                frame.people[i] = if p > 65535.0 { 65535 } else { (p + 0.5) as u16 };
                frame.small[i] = (sim.small[i] as f64 * 255.0 + 0.5) as u8;
            }
            for (k, sp) in sim.species.iter().enumerate() {
                for j in 0..sp.share.len() {
                    frame.big[k][j] = (sp.share[j] as f64 * 255.0 + 0.5) as u8;
                }
            }
            kept.push(frame);
        }
        if t % POPULATION_STEP == 0.0 {
            let mut sum = 0.0;
            for &i in &sim.lived {
                sum += sim.people[i] as f64 * h.area_km2[i] as f64;
            }
            let at_k = (t / POPULATION_STEP) as usize;
            population[at_k] = sum as f32;
            let last = if t > 0.0 {
                population[at_k - 1] as f64
            } else {
                0.0
            };
            while next_mark < POPULATION_MARKS.len() && sum >= POPULATION_MARKS[next_mark] {
                let mark = POPULATION_MARKS[next_mark];
                next_mark += 1;
                let mut standing = 0;
                for v in 0..village_to.len() {
                    if village_to[v] == f64::INFINITY && !Sim::is_camp(&villages, v) {
                        standing += 1;
                    }
                }
                let at = if t > 0.0 {
                    t - POPULATION_STEP * (1.0 - (mark - last) / js::max(1e-9, sum - last))
                } else {
                    0.0
                };
                sim.log.push(LogEvent::Population {
                    at,
                    cell: input.origin as f64,
                    count: mark,
                    villages: standing as f64,
                    centres: (sim.centres.len() / 3) as f64,
                });
            }
        }
        if s == steps {
            break;
        }
        if t < t0 {
            continue;
        }
        // 0. The climate, every CLIMATE_YEARS.
        if t > 0.0 && t % CLIMATE_YEARS == 0.0 {
            update_climate(t, &mut sim.capacity, &mut moved_now);
            let mut still = Vec::new();
            for k in 0..sim.lived.len() {
                let i = sim.lived[k];
                if sim.people[i] == 0.0 {
                    continue;
                }
                if sim.capacity[i] <= 0.0 {
                    sim.people[i] = 0.0;
                    continue;
                }
                still.push(i);
            }
            sim.lived = still.clone();
            for &i in &still {
                if moved_now[i] != 0 {
                    sim.grows(i);
                }
            }
            sim.front = still;
            // The big game's extinctions.
            for sp in sim.species.iter_mut() {
                for (m, at) in &sp.by_landmass {
                    if sp.gone.contains(m) {
                        continue;
                    }
                    let mut sum = 0.0;
                    for &k in at {
                        sum += sp.share[k] as f64;
                    }
                    if sum >= EXTINCT_BELOW * at.len() as f64 {
                        continue;
                    }
                    sp.gone.insert(*m);
                    let cell = sp.cells[at[0]] as f64;
                    extinctions.push(Extinction {
                        id: sp.id.clone(),
                        landmass: *m as f64,
                        area_km2: h.landmass_km2[*m as usize],
                        at: t,
                        cell,
                    });
                    sim.log.push(LogEvent::Extinct {
                        at: t,
                        cell,
                        landmass: *m as f64,
                        id: sp.id.clone(),
                    });
                }
            }
            // The knowledge.
            region_people.fill(0.0);
            for &i in &sim.lived {
                if region[i] >= 0 {
                    region_people[region[i] as usize] +=
                        sim.people[i] as f64 * h.area_km2[i] as f64;
                }
            }
            for g in 0..regions {
                let target = KNOW_SCALE * (det_log(1.0 + region_people[g] / KNOW_PEOPLE) / LN_10);
                let k = knowledge[g] as f64;
                knowledge[g] =
                    (k + (target - k) * if target > k { KNOW_GAIN } else { KNOW_LOSS }) as f32;
            }
            let mut k = 0;
            while k < links.len() {
                let a = links[k];
                let b = links[k + 1];
                let most = js::max(
                    sea_known(&knowledge, &seafaring, a),
                    sea_known(&knowledge, &seafaring, b),
                );
                seafaring[a] = js::max(seafaring[a] as f64, most) as f32;
                seafaring[b] = js::max(seafaring[b] as f64, most) as f32;
                k += 2;
            }
            // The centres.
            let stable = climate.stable(t);
            let tamed_on: HashSet<(String, i32)> = sim
                .tamed
                .iter()
                .map(|d| (d.id.clone(), h.landmass[d.cell]))
                .collect();
            let wild_here =
                |id: &str, i: usize| !tamed_on.contains(&(id.to_string(), h.landmass[i]));
            let mut best_farm: Vec<(i32, usize, f64)> = Vec::new();
            let mut best_herd: Vec<(i32, usize, f64)> = Vec::new();
            let mut farm_at_region = vec![usize::MAX; regions];
            let mut herd_at_region = vec![usize::MAX; regions];
            for &i in &sim.lived {
                let g = region[i];
                if g < 0 || sim.people[i] == 0.0 || sim.arrival[i] as f64 > t - SETTLED_YEARS {
                    continue;
                }
                let gu = g as usize;
                if stable
                    && sim.farm_at[i] == f32::INFINITY
                    && knowledge[gu] as f64 >= KNOW_FARM
                    && sim.eco(ARABLE, i) >= CENTRE_ARABLE
                {
                    let wild = input
                        .crops
                        .iter()
                        .filter(|c| c.codes[i] >= plant_code && wild_here(&c.id, i))
                        .count();
                    let w = if wild >= CENTRE_CROPS {
                        (wild as f64 / 2.0) * sim.eco(ARABLE, i)
                    } else {
                        0.0
                    };
                    let known = if farm_at_region[gu] == usize::MAX {
                        0.0
                    } else {
                        best_farm[farm_at_region[gu]].2
                    };
                    if w > known {
                        if farm_at_region[gu] == usize::MAX {
                            farm_at_region[gu] = best_farm.len();
                            best_farm.push((g, i, w));
                        } else {
                            best_farm[farm_at_region[gu]] = (g, i, w);
                        }
                    }
                }
                if stable
                    && sim.herd_at[i] == f32::INFINITY
                    && knowledge[gu] as f64 >= KNOW_HERD
                    && sim.eco(PASTURE, i) >= CENTRE_PASTURE
                {
                    let wild = input
                        .herds
                        .iter()
                        .filter(|c| c.codes[i] >= 2 && wild_here(&c.id, i))
                        .count();
                    let w = if wild >= CENTRE_HERDS {
                        (wild as f64 / 2.0) * sim.eco(PASTURE, i)
                    } else {
                        0.0
                    };
                    let known = if herd_at_region[gu] == usize::MAX {
                        0.0
                    } else {
                        best_herd[herd_at_region[gu]].2
                    };
                    if w > known {
                        if herd_at_region[gu] == usize::MAX {
                            herd_at_region[gu] = best_herd.len();
                            best_herd.push((g, i, w));
                        } else {
                            best_herd[herd_at_region[gu]] = (g, i, w);
                        }
                    }
                }
            }
            for &(_, cell, w) in &best_farm {
                if sim.random.next() >= FARM_RATE * js::min(1.0, w)
                    || !sim.far_centre(cell, FARMERS)
                {
                    continue;
                }
                sim.centres.extend([cell as f64, t, FARMERS as f64]);
                sim.log.push(LogEvent::Centre {
                    at: t,
                    cell: cell as f64,
                    lifeway: FARMERS as f64,
                });
                for (k, crop) in input.crops.iter().enumerate() {
                    if crop.codes[cell] >= plant_code && wild_here(&crop.id, cell) {
                        sim.tame(true, k, cell, t);
                    }
                }
                herds_due.push((cell, t + HERD_LAG));
                sim.grows(cell);
            }
            for &(_, cell, w) in &best_herd {
                if sim.random.next() >= HERD_RATE * js::min(1.0, w)
                    || !sim.far_centre(cell, HERDERS)
                {
                    continue;
                }
                sim.centres.extend([cell as f64, t, HERDERS as f64]);
                sim.log.push(LogEvent::Centre {
                    at: t,
                    cell: cell as f64,
                    lifeway: HERDERS as f64,
                });
                for (k, herd) in input.herds.iter().enumerate() {
                    if herd.codes[cell] >= 2 && wild_here(&herd.id, cell) {
                        sim.tame(false, k, cell, t);
                    }
                }
                sim.grows(cell);
            }
            let mut k = herds_due.len();
            while k > 0 {
                k -= 1;
                if herds_due[k].1 > t {
                    continue;
                }
                let cell = herds_due[k].0;
                for (j, herd) in input.herds.iter().enumerate() {
                    if herd.codes[cell] >= 2 && wild_here(&herd.id, cell) {
                        sim.tame(false, j, cell, t);
                    }
                }
                herds_due.remove(k);
                sim.grows(cell);
            }
            // The fishers, the villages.
            for k in 0..sim.lived.len() {
                let i = sim.lived[k];
                if sim.fishing[i] != 0
                    || sim.eco(FISH, i) < FISH_RICH
                    || sim.arrival[i] as f64 > t - SETTLE_AFTER
                {
                    continue;
                }
                sim.fishing[i] = 1;
                sim.grows(i);
            }
            for v in 0..village_to.len() {
                let cell = villages[2 * v] as usize;
                if village_to[v] < f64::INFINITY
                    || Sim::is_camp(&villages, v)
                    || sim.people[cell] as f64
                        >= village_least(villages[2 * v + 1] as u8) * VILLAGE_LEAVE
                {
                    continue;
                }
                village_to[v] = t;
                village_at[cell] = -1;
                villages_left = true;
                sim.log.push(LogEvent::VillageLeft {
                    at: t,
                    cell: cell as f64,
                    village: v as f64,
                });
            }
            if villages_left {
                near_village.fill(f32::INFINITY);
                let standing: Vec<usize> = (0..village_to.len())
                    .filter(|&v| village_to[v] == f64::INFINITY && !Sim::is_camp(&villages, v))
                    .map(|v| villages[2 * v] as usize)
                    .collect();
                within_days(
                    h,
                    &way_days,
                    &standing,
                    VILLAGE_DAYS_MOST,
                    &mut near_village,
                    None,
                    None,
                );
                villages_left = false;
            }
            let way_of = |sim: &Sim, i: usize| {
                if sim.farm_at[i] as f64 <= t {
                    FARMERS
                } else if sim.fishing[i] != 0 {
                    FISHERS
                } else {
                    NONE
                }
            };
            let mut candidates: Vec<usize> = sim
                .lived
                .iter()
                .copied()
                .filter(|&i| {
                    let way = way_of(&sim, i);
                    way != NONE
                        && sim.people[i] as f64 >= village_least(way)
                        && near_village[i] as f64 > village_days(way)
                        && village_at[i] < 0
                })
                .collect();
            candidates.sort_by(|&a, &b| {
                sim.people[b]
                    .partial_cmp(&sim.people[a])
                    .unwrap()
                    .then(a.cmp(&b))
            });
            for i in candidates {
                let way = way_of(&sim, i);
                if near_village[i] as f64 <= village_days(way) {
                    continue;
                }
                let touched = within_days(
                    h,
                    &way_days,
                    &[i],
                    VILLAGE_DAYS_MOST,
                    &mut scratch_days,
                    None,
                    None,
                );
                for &c in &touched {
                    near_village[c] =
                        js::min(near_village[c] as f64, scratch_days[c] as f64) as f32;
                }
                reset(&mut scratch_days, &touched);
                village_at[i] = village_to.len() as i32;
                sim.log.push(LogEvent::Village {
                    at: t,
                    cell: i as f64,
                    village: village_to.len() as f64,
                    lifeway: way as f64,
                });
                villages.extend([i as i32, way as i32]);
                village_from.push(t);
                village_to.push(f64::INFINITY);
            }
        }
        // The camps, every CAMP_YEARS.
        if t > 0.0 && t % CAMP_YEARS == 0.0 {
            let camp_way_of = |sim: &Sim, i: usize| {
                if sim.farm_at[i] as f64 <= t || sim.fishing[i] != 0 {
                    NONE
                } else if sim.herd_at[i] as f64 <= t {
                    HERDERS
                } else {
                    FORAGERS
                }
            };
            let near = |near_camp: &mut [f32],
                        camp_owner: &mut [i32],
                        villages: &[i32],
                        village_to: &[f64]|
             -> Vec<usize> {
                let standing: Vec<usize> = (0..village_to.len())
                    .filter(|&v| village_to[v] == f64::INFINITY && Sim::is_camp(villages, v))
                    .collect();
                near_camp.fill(f32::INFINITY);
                camp_owner.fill(-1);
                let cells: Vec<usize> =
                    standing.iter().map(|&v| villages[2 * v] as usize).collect();
                within_days(
                    h,
                    &way_days,
                    &cells,
                    CAMP_DAYS_MOST,
                    near_camp,
                    None,
                    Some(camp_owner),
                );
                standing
            };
            let standing = near(&mut near_camp, &mut camp_owner, &villages, &village_to);
            let mut densest = vec![0f32; standing.len()];
            for &i in &sim.lived {
                let k = camp_owner[i];
                if k >= 0 && camp_way_of(&sim, i) != NONE && sim.people[i] > densest[k as usize] {
                    densest[k as usize] = sim.people[i];
                }
            }
            let mut camps_left = false;
            for (k, &v) in standing.iter().enumerate() {
                let cell = villages[2 * v] as usize;
                let way = camp_way_of(&sim, cell);
                if way != NONE
                    && sim.people[cell] as f64 >= camp_least(way) * VILLAGE_LEAVE
                    && densest[k] as f64 <= CAMP_MOVE * sim.people[cell] as f64
                {
                    continue;
                }
                village_to[v] = t;
                village_at[cell] = -1;
                camps_left = true;
                sim.log.push(LogEvent::CampLeft {
                    at: t,
                    cell: cell as f64,
                    village: v as f64,
                });
            }
            if camps_left {
                near(&mut near_camp, &mut camp_owner, &villages, &village_to);
            }
            let mut candidates: Vec<usize> = sim
                .lived
                .iter()
                .copied()
                .filter(|&i| {
                    let way = camp_way_of(&sim, i);
                    way != NONE
                        && sim.people[i] as f64 >= camp_least(way)
                        && near_camp[i] as f64 > camp_days(way)
                        && village_at[i] < 0
                })
                .collect();
            candidates.sort_by(|&a, &b| {
                sim.people[b]
                    .partial_cmp(&sim.people[a])
                    .unwrap()
                    .then(a.cmp(&b))
            });
            for i in candidates {
                let way = camp_way_of(&sim, i);
                if near_camp[i] as f64 <= camp_days(way) {
                    continue;
                }
                let touched = within_days(
                    h,
                    &way_days,
                    &[i],
                    CAMP_DAYS_MOST,
                    &mut scratch_days,
                    None,
                    None,
                );
                for &c in &touched {
                    near_camp[c] = js::min(near_camp[c] as f64, scratch_days[c] as f64) as f32;
                }
                reset(&mut scratch_days, &touched);
                village_at[i] = village_to.len() as i32;
                sim.log.push(LogEvent::Camp {
                    at: t,
                    cell: i as f64,
                    village: village_to.len() as f64,
                    lifeway: way as f64,
                });
                villages.extend([i as i32, way as i32]);
                village_from.push(t);
                village_to.push(f64::INFINITY);
            }
        }
        // 0b. The game, every GAME_STEPS.
        if s % GAME_STEPS == 0 {
            let years = GAME_STEPS as f64 * STEP_YEARS;
            for k in 0..sim.lived.len() {
                let i = sim.lived[k];
                if sim.people[i] > 0.0 && in_hunted[i] == 0 {
                    in_hunted[i] = 1;
                    hunted.push(i);
                }
            }
            let before: Vec<f64> = hunted.iter().map(|&i| sim.food(i)).collect();
            for &i in &hunted {
                let pressure = sim.people[i] as f64 / FORAGER_DENSITY;
                let small = sim.small[i] as f64;
                sim.small[i] = js::max(
                    0.01,
                    js::min(
                        1.0,
                        small
                            + years
                                * (SMALL_REGROW_A * small * (1.0 - small)
                                    - HUNT_A * pressure * small),
                    ),
                ) as f32;
            }
            for sp in sim.species.iter_mut() {
                for k in 0..sp.cells.len() {
                    let i = sp.cells[k] as usize;
                    let was = sp.share[k] as f64;
                    if sim.people[i] == 0.0 && was >= 0.999 {
                        continue;
                    }
                    let pressure = sim.people[i] as f64 / FORAGER_DENSITY;
                    let wary = if h.landmass[i] == home_landmass {
                        HOME_WARY
                    } else {
                        1.0
                    };
                    let now = js::max(
                        0.001,
                        js::min(
                            1.0,
                            was + years
                                * (sp.regrow * was * (1.0 - was) - sp.hunt * wary * pressure * was),
                        ),
                    );
                    sp.share[k] = now as f32;
                    sim.big_sum[i] = (sim.big_sum[i] as f64 + (now - was)) as f32;
                }
            }
            let mut still_hunted = Vec::new();
            let mut moved = Vec::new();
            for (k, &i) in hunted.iter().enumerate() {
                if sim.people[i] > 0.0
                    || sim.small[i] < 0.99
                    || (sim.big_count[i] != 0
                        && (sim.big_sum[i] as f64) < 0.99 * sim.big_count[i] as f64)
                {
                    still_hunted.push(i);
                } else {
                    in_hunted[i] = 0;
                }
                if sim.people[i] > 0.0 && (sim.food(i) - before[k]).abs() >= FOOD_MOVED {
                    moved.push(i);
                }
            }
            hunted = still_hunted;
            for i in moved {
                sim.grows(i);
            }
        }
        // 0c. The droughts.
        if squares > 0 {
            let rain = input.rain.as_ref().unwrap();
            let enso = if sim.random.next() < ENSO_CHANCE * rain.enso_strength {
                ENSO_PUSH
            } else {
                0.0
            };
            let spread = (1.0 - DRY_KEEP * DRY_KEEP).sqrt();
            for q in 0..squares {
                let g = {
                    let a = sim.random.next();
                    let b = sim.random.next();
                    (-2.0 * det_log(1.0 - a)).sqrt() * det_cos(2.0 * PI * b)
                };
                anomaly[q] = (DRY_KEEP * anomaly[q] as f64
                    + spread * g
                    + enso * square_enso[q] as f64) as f32;
                let wet = 1.0 + DRY_SCALE * square_variability[q] as f64 * anomaly[q] as f64;
                if wet < DRY_BELOW {
                    dry_run[q] += 1;
                } else {
                    dry_run[q] = 0;
                    end_famine(&mut famine, q, t, &mut sim.log);
                }
                let r = if dry_run[q] > STORE_STEPS {
                    js::max(0.0, wet)
                } else {
                    1.0
                };
                if r == sim.square_rain[q] as f64 {
                    continue;
                }
                sim.square_rain[q] = r as f32;
                for &i in &square_cells[q] {
                    if sim.people[i] > 0.0 {
                        sim.grows(i);
                    }
                }
                for &i in &square_cells[q] {
                    sim.fed[i] = 0.0;
                }
                if r == 1.0 {
                    continue;
                }
                let givers: Vec<usize> = square_rim[q]
                    .iter()
                    .copied()
                    .filter(|&u| sim.people[u] > 0.0 && sim.rain_of(u) == 1.0)
                    .collect();
                let reached = within_days(
                    h,
                    &way_days,
                    &givers,
                    EXCHANGE_DAYS,
                    &mut scratch_days,
                    None,
                    None,
                );
                for &c in &reached {
                    if sim.dry_square[c] == q as i32 {
                        sim.fed[c] = (1.0 - scratch_days[c] as f64 / EXCHANGE_DAYS) as f32;
                    }
                }
                reset(&mut scratch_days, &reached);
                // The famine.
                let mut lost = 0.0;
                let mut most: i32 = -1;
                let mut before = 0.0;
                let mut fleeing = 0.0;
                for &i in &square_cells[q] {
                    if sim.people[i] == 0.0 {
                        continue;
                    }
                    before += sim.people[i] as f64 * h.area_km2[i] as f64;
                    if most < 0 || sim.people[i] > sim.people[most as usize] {
                        most = i as i32;
                    }
                    let k = sim.carried(i);
                    if sim.people[i] as f64 <= k {
                        continue;
                    }
                    let over = (sim.people[i] as f64 - k) * h.area_km2[i] as f64;
                    lost += FAMINE_DEATH * over;
                    fleeing += (1.0 - FAMINE_DEATH) * over;
                    sim.people[i] = k as f32;
                }
                let mut room = 0.0;
                let mut rooms = Vec::with_capacity(square_rim[q].len());
                for &u in &square_rim[q] {
                    let free = if sim.rain_of(u) < 1.0 || sim.capacity[u] <= 0.0 {
                        0.0
                    } else {
                        js::max(
                            0.0,
                            (FLIGHT_CROWD * sim.capacity[u] as f64 * sim.food(u) * sim.gain(u)
                                - sim.people[u] as f64)
                                * h.area_km2[u] as f64,
                        )
                    };
                    rooms.push(free);
                    room += free;
                }
                let fled = js::min(fleeing, room);
                lost += fleeing - fled;
                if fled > 0.0 {
                    for (k, &u) in square_rim[q].iter().enumerate() {
                        if rooms[k] <= 0.0 {
                            continue;
                        }
                        let density = (rooms[k] * fled) / room / h.area_km2[u] as f64;
                        if sim.people[u] == 0.0 {
                            sim.settle(u, t, density, most);
                        } else {
                            sim.people[u] = (sim.people[u] as f64 + density) as f32;
                            sim.grows(u);
                        }
                    }
                }
                let mut left = 0;
                for v in 0..village_to.len() {
                    let cell = villages[2 * v] as usize;
                    if village_to[v] < f64::INFINITY
                        || Sim::is_camp(&villages, v)
                        || sim.dry_square[cell] != q as i32
                        || sim.people[cell] as f64
                            >= village_least(villages[2 * v + 1] as u8) * VILLAGE_LEAVE
                    {
                        continue;
                    }
                    village_to[v] = t;
                    village_at[cell] = -1;
                    villages_left = true;
                    sim.log.push(LogEvent::VillageLeft {
                        at: t,
                        cell: cell as f64,
                        village: v as f64,
                    });
                    left += 1;
                }
                let f = famine[q].get_or_insert(Famine {
                    at: t,
                    cell: most,
                    before,
                    lost: 0.0,
                    left: 0.0,
                    villages: 0.0,
                });
                f.lost += lost;
                f.left += fled;
                f.villages += left as f64;
                if f.cell < 0 {
                    f.cell = most;
                }
            }
        }
        // 1. Growth.
        let mut still_growing = Vec::new();
        for k in 0..sim.growing.len() {
            let i = sim.growing[k];
            let kc = sim.carried(i);
            if sim.people[i] > 0.0 {
                sim.people[i] = (sim.people[i] as f64 + (kc - sim.people[i] as f64) * grow) as f32;
            }
            if sim.people[i] > 0.0 && (kc - sim.people[i] as f64).abs() > (1.0 - FULL_SHARE) * kc {
                still_growing.push(i);
            } else {
                sim.in_growing[i] = 0;
            }
        }
        sim.growing = still_growing;
        // 2. Settling.
        for pass in 0..SUB_STEPS {
            let at = t + (pass as f64 + 1.0) * sub_years;
            let count = sim.front.len();
            let mut still_front = Vec::new();
            for k in 0..count {
                let i = sim.front[k];
                if sim.people[i] == 0.0 {
                    continue;
                }
                let mut open_left = false;
                for e in h.edges(i) {
                    let u = h.nbr[e] as usize;
                    if !sim.open(u) {
                        continue;
                    }
                    open_left = true;
                    if (sim.people[i] as f64) < SEED_SHARE * sim.capacity[i] as f64 * sim.food(i) {
                        continue;
                    }
                    let chance = js::min(1.0, (speed[u] as f64 * sub_years) / h.dist_km[e] as f64);
                    if sim.random.next() < chance {
                        let density = sim.capacity[u] as f64 * SEED_PEOPLE;
                        sim.settle(u, at, density, i as i32);
                    }
                }
                if open_left {
                    still_front.push(i);
                }
            }
            still_front.extend_from_slice(&sim.front[count..]);
            sim.front = still_front;
        }
        // 2b. The fields and the herds, passed on.
        for plant in [true, false] {
            let front = if plant {
                &sim.farm_front
            } else {
                &sim.herd_front
            };
            if front.is_empty() {
                continue;
            }
            let added = front.len();
            let list: Vec<usize> = front[..added].to_vec();
            let km_a = if plant { FARM_KM_A } else { HERD_KM_A };
            let mut still = Vec::new();
            for &i in &list {
                let mut left = false;
                for e in h.edges(i) {
                    let u = h.nbr[e] as usize;
                    if sim.people[u] == 0.0 {
                        continue;
                    }
                    for d in 0..sim.tamed.len() {
                        if sim.tamed_bits[i] & (1 << d) == 0
                            || sim.tamed_bits[u] & (1 << d) != 0
                            || sim.tamed[d].plant != plant
                        {
                            continue;
                        }
                        left = true;
                        let barrier = if sim.suits(d, u) {
                            1.0
                        } else if plant {
                            FARM_BARRIER
                        } else {
                            HERD_BARRIER
                        };
                        if sim.random.next()
                            < js::min(1.0, (km_a * STEP_YEARS) / (h.dist_km[e] as f64 * barrier))
                        {
                            sim.take(d, u, t + STEP_YEARS);
                            sim.grows(u);
                        }
                    }
                }
                if left {
                    still.push(i);
                }
            }
            let front = if plant {
                &mut sim.farm_front
            } else {
                &mut sim.herd_front
            };
            still.extend_from_slice(&front[added..]);
            *front = still;
        }
        // 3. The crossings.
        for (source, list) in &crossings_from {
            let source = *source;
            let g = region[source] as usize;
            let stone = region_cells[g] < STONE_CELLS;
            if sim.people[source] == 0.0
                || (!stone
                    && (sim.people[source] as f64)
                        < SEED_SHARE * sim.capacity[source] as f64 * sim.food(source))
            {
                continue;
            }
            let known = sea_known(&knowledge, &seafaring, g);
            let reach = js::min(REACH_END, REACH_START + REACH_PER_KNOW * known);
            for &ci in list {
                let c = &crossings[ci];
                if c.km > reach || !sim.open(c.to) || sim.arrival[c.to] < f32::INFINITY {
                    continue;
                }
                if sim.random.next() < if stone { STONE_CHANCE } else { CROSSING_CHANCE } {
                    let mut parent = c.from as i32;
                    for &cell in &c.path {
                        if cell == c.from || cell == c.to {
                            continue;
                        }
                        if land[cell] == 0 && sim.arrival[cell] == f32::INFINITY {
                            sim.arrival[cell] = (t + STEP_YEARS) as f32;
                            sim.from[cell] = parent;
                        }
                        if sim.arrival[cell] < f32::INFINITY {
                            parent = cell as i32;
                        }
                    }
                    let landed = h.landmass[c.to];
                    let first = landed >= 0 && sim.landmass_reached[landed as usize] == 0;
                    sim.log.push(LogEvent::Crossing {
                        at: t + STEP_YEARS,
                        cell: c.to as f64,
                        landmass: landed as f64,
                        km: c.km,
                        first,
                    });
                    let density = sim.capacity[c.to] as f64 * SEED_PEOPLE;
                    sim.settle(c.to, t + STEP_YEARS, density, parent);
                    let to = region[c.to] as usize;
                    knowledge[to] =
                        js::max(knowledge[to] as f64, KNOW_CARRIED * knowledge[g] as f64) as f32;
                    seafaring[to] = js::max(seafaring[to] as f64, known) as f32;
                    links.extend([g, to]);
                    made.extend([landed as f64, c.to as f64, t + STEP_YEARS, c.km]);
                    ways.extend(c.path.iter().map(|&x| x as i32));
                    ways.push(-1);
                }
            }
        }
        if let Some(p) = on_progress.as_deref_mut()
            && s % 100 == 0
        {
            p(s as f64 / steps as f64);
        }
    }
    for q in 0..squares {
        end_famine(&mut famine, q, SPAN_YEARS, &mut sim.log);
    }
    // THE ROUTES' TREE.
    let mut route_from = vec![-1i32; n];
    let mut cost = vec![f64::INFINITY; n];
    let mut popped: Vec<usize> = Vec::new();
    if input.origin >= 0 && sim.arrival[input.origin as usize] < f32::INFINITY {
        let o = input.origin as usize;
        let mut heap = MinHeap::new(1 << 16);
        cost[o] = 0.0;
        heap.push(0.0, o as i32);
        while !heap.is_empty() {
            heap.pop();
            let i = heap.popped_index as usize;
            let d = heap.popped_key;
            if d > cost[i] {
                continue;
            }
            popped.push(i);
            for e in h.edges(i) {
                let u = h.nbr[e] as usize;
                if sim.arrival[u] >= f32::INFINITY
                    || (sim.arrival[u] as f64) < sim.arrival[i] as f64 - ROUTE_SLACK_YEARS
                {
                    continue;
                }
                let nd = d + h.dist_km[e] as f64;
                if nd >= cost[u] {
                    continue;
                }
                cost[u] = nd;
                route_from[u] = i as i32;
                heap.push(nd, u as i32);
            }
        }
    }
    let mut flow = vec![0f32; n];
    let mut missed: Vec<usize> = Vec::new();
    for i in 0..n {
        if sim.arrival[i] >= f32::INFINITY || cost[i] < f64::INFINITY {
            continue;
        }
        route_from[i] = sim.from[i];
        missed.push(i);
    }
    missed.sort_by(|&a, &b| sim.arrival[b].partial_cmp(&sim.arrival[a]).unwrap());
    let add_flow = |i: usize, flow: &mut Vec<f32>| {
        if land[i] != 0 {
            flow[i] += 1.0;
        }
        if route_from[i] >= 0 {
            let p = route_from[i] as usize;
            flow[p] = (flow[p] as f64 + flow[i] as f64) as f32;
        }
    };
    for &i in &missed {
        add_flow(i, &mut flow);
    }
    for k in (0..popped.len()).rev() {
        add_flow(popped[k], &mut flow);
    }
    SimulationResult {
        arrival: sim.arrival,
        land: land.clone(),
        from: route_from,
        flow,
        origin: input.origin,
        crossings: made.iter().map(|&x| x as f32).collect(),
        crossing_ways: ways,
        kept,
        species: sim
            .species
            .into_iter()
            .map(|sp| (sp.id, sp.cells))
            .collect(),
        climate: (climate.max_at, climate.depth, climate.deglaciation),
        extinctions,
        log: sim.log,
        centres: sim.centres.iter().map(|&x| x as f32).collect(),
        farm_at: sim.farm_at,
        herd_at: sim.herd_at,
        domestications: sim
            .tamed
            .into_iter()
            .map(|d| Domestication {
                plant: d.plant,
                id: d.id,
                cell: d.cell as f64,
                at: d.at,
                came: d.came,
            })
            .collect(),
        villages,
        village_from: village_from.iter().map(|&x| x as f32).collect(),
        village_to: village_to.iter().map(|&x| x as f32).collect(),
        population,
    }
}
