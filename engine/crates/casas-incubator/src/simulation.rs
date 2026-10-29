//! THE HISTORY (2026-10-26): the people over the span in steps of
//! STEP_YEARS on the habitat's cells, the climate, the sea, the game, the
//! farming and the herding, the villages and the camps, the droughts, the
//! copper and the towns, the log. Functions over plain arrays, no screen
//! state. Ported from the TypeScript (removed 2026-10-27) step for step,
//! draw for draw: a double where it computed, a float where it kept a
//! Float32Array. Seeded, and on
//! det_math since 2026-10-26 (not exp, log and the like, which differ
//! between JavaScript's engines in the last bit).
//!
//! A STEP:
//! 0. THE CLIMATE (climate_history.rs), every CLIMATE_YEARS: the cold
//!    lowers what the land carries and puts the land near today's glaciers
//!    under the ice; the sea's drop lays the shelf to it dry, to SHELF_M. A
//!    cell that carries nothing any more is left, its people go to the
//!    neighbours (THE RISING SEA); one that carries again may be settled
//!    again. A cold spell (climate_history.rs THE COLD SPELLS) moves what
//!    the land carries at its start and its end too.
//! 1. GROWTH: each cell's people toward what the land carries (its carrying
//!    capacity, CARRYING_FULL at FORAGER_DENSITY a km², to twice), by
//!    GROWTH_A a year, logistic.
//! 2. SETTLING, SUB_STEPS times: a cell at SEED_SHARE of what it carries or
//!    more settles each empty neighbour with a chance — its speed there (as
//!    step 1's front, `ground_of`: SPEED_MIN_KM_A to SPEED_MAX_KM_A by the
//!    carrying capacity, slower up a slope, CORRIDOR times faster along a
//!    river or a coast) times the sub-step's years over the way's km — and
//!    gives it SEED_PEOPLE of its own. Ice is not settled. Cellular, not a
//!    diffusion: a diffusion on cells of 10 km is stable only in steps of
//!    some 2 years, 50 000 of them.
//! 3. THE SEA: over open water the crossings (`crossings_of`, made once):
//!    from a settled coast cell to the nearest coast of another landmass,
//!    once the reach of its region is as far, with CROSSING_CHANCE a step;
//!    never farther than land in sight (REACH_END).
//!
//! The rest — the game, the knowledge, the farming and the herding, the
//! fishers, the villages, the camps, the droughts, the copper, the towns —
//! is told at its constants.
//!
//! STEP 2 OF THE PREHISTORY (docs/design/prehistory-in-three-steps.md):
//! the simulation begins where step 1 (peopling.rs) ends, with the people
//! where it brought them, at the carrying capacity, each cell's arrival
//! and the cell it came from as step 1 gives them, and each region's
//! knowledge at what its people give. Its time runs from there: nothing of
//! step 1 is kept again but its log. The big game is first hunted here.
//! It ends at its first city.

use crate::climate_history::{
    COLD_SPELL_DRY, COLD_SPELL_YEARS, ClimateHistory, ICE_REACH_KM, cold_share, cold_spells,
    ice_may_cover, spell_cold,
};
use crate::habitat::{ARABLE, COPPER, FISH, Habitat, PASTURE, km_between};
use crate::log::{LogEvent, POPULATION_MARKS};
use crate::peoples::{Traits, Tree};
use crate::peopling::Peopling;
use crate::travel::{reset, travel_days, within_days};
use casas_engine::climate::biomes::biome;
use casas_engine::core::det_math::{det_cos, det_exp, det_log};
use casas_engine::core::js;
use casas_engine::core::min_heap::MinHeap;
use casas_engine::core::rng::Mulberry32;
use std::collections::{HashMap, HashSet};
use std::f64::consts::{LN_10, PI};

// The people's span, years: the climate history's, from step 1's start;
// the history ends at it if no city comes first. 65 000 until 2026-10-26,
// then 100 000 for the simulation.
pub const SPAN_YEARS: f64 = 100_000.0;
// A history keeps its state every KEEP_YEARS, the playback's frames.
pub const KEEP_YEARS: f64 = 2500.0;
pub const POPULATION_STEP: f64 = 500.0;
pub const STEP_YEARS: f64 = 25.0;
// 1e-3: the farmers reach 15 a km² and more; the foragers' 0.1 is 100 steps.
pub const PEOPLE_FRAME_STEP: f64 = 1e-3;
// When a domesticate's wave came to a cell, in CAME_STEP years; CAME_NEVER
// where it never did.
pub const CAME_STEP: f64 = 10.0;
pub const CAME_NEVER: u16 = 0xffff;
// The fishers settle this long after people came.
pub const SETTLE_AFTER: f64 = 3000.0;
pub const FISH_RICH: f64 = 0.5;
/// niche.rs SUITABLE 0.3, coded (settleShared.ts PLANT_SUITS_CODE).
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

/// VILLAGE_LEAST: the least people a km² of a village, by its
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
// A third (2026-10-26; a half before): with the cold and the hunt the
// foragers seldom got to half of what the land carried before, and the
// front stood.
pub(crate) const SEED_SHARE: f64 = 1.0 / 3.0;
pub(crate) const SEED_PEOPLE: f64 = 0.2;
pub(crate) const FULL_SHARE: f64 = 0.95;
pub(crate) const SPEED_MIN_KM_A: f64 = 0.05;
pub(crate) const SPEED_MAX_KM_A: f64 = 0.5;
pub(crate) const SLOPE_DRAG: f64 = 10.0;
pub(crate) const CORRIDOR: f64 = 2.0;
pub(crate) const SHELF_M: f64 = 120.0;
// The climate moves the cells' carrying and the sea every CLIMATE_YEARS.
pub(crate) const CLIMATE_YEARS: f64 = 500.0;
// THE RISING SEA (2026-10-28): the people of a cell that carries nothing
// any more (the sea over the shelf, the ice) go to its neighbours that
// still carry, lived in or empty, evenly, each up to FLIGHT_CROWD times
// what it carries (as THE FLIGHT); the rest die. Where the sea took
// DROWNED_TOLD_KM2 of a landmass's shelf or more in one CLIMATE_YEARS, the
// log tells it (`Drowned`), with the people who moved away from it: a
// coast goes under, as Doggerland did. A shelf cell is its nearest
// landmass's (`shelf_landmass`). Before, the people of such a cell were
// gone. On Morvane (v14) the sea took 10 000 km² or more of a landmass 36
// times in step 2's first 5 000 years (4 landmasses, 10 200 to 67 900 km²
// each); at 50 000 the chronicle tells 5 of them. Since a dry shelf
// carries what its coast carries (`ground_of`, 2026-10-28), 1 459 to 1 998
// people move from each (58 to 168 when it carried what the poorest land
// does).
pub(crate) const DROWNED_TOLD_KM2: f64 = 50_000.0;
// THE GAME (2026-10-26), every GAME_STEPS steps on the cells people live in
// or have hunted: the small game and the big game, a share each of what the
// land holds without people. Each grows back toward it (SMALL_REGROW_A,
// BIG_REGROW_A a year: the big slowly) and is hunted by the people there by
// their density over the foragers' (HUNT_A, BIG_HUNT_A a year at that
// density). The big game is each species' own (2026-10-26; one share for
// all of it before): a vulnerable species grows back slower, by (1.2 − its
// vulnerability), and is hunted harder, by its vulnerability over 0.5 —
// the elephant and the horse go first, the aurochs holds; the big game of
// the people's own landmass, which grew up with them, at HOME_WARY of
// that. What the foragers live on: PLANT_FOOD of it plants, the rest the
// game — SMALL_FOOD small, BIG_FOOD big where there is big game. A species
// of the big game is gone from a landmass when its cells there hold less
// than EXTINCT_BELOW of it.
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
// THE FISHERS (2026-10-26): where the fish are FISH_RICH or more, people
// who have lived there SETTLE_AFTER years stay and grow dense — the fish
// carry FISH_GAIN × the fish times more people (the settlement's densities,
// settle.rs: fishers 1 a km², foragers 0.1), where no fields carry them
// instead (the Jōmon).
// THE VILLAGES (the same day), every CLIMATE_YEARS: the central places of
// the settled — where the farmers (the fields) or the fishers live
// `village_least` a km² or more, the densest first, each more than
// `village_days` of the ways (travel.rs) from any village standing founds
// one (a day and the fishers' a day and a half gave 2 262 on Morvane, too
// many; now 1 352); a village whose people fall under VILLAGE_LEAVE of its
// least is left (the ice, the sea, the hunger). The many small settlements
// around them are the hamlets, a count the screen makes of the density.
// The spacing was in rings of cells until 2026-10-26 (3 cells for the
// farmers, 5 for the fishers: some 30 and 50 km). The people over the span
// are counted every POPULATION_STEP years.
pub(crate) const FISH_GAIN: f64 = 10.0;
// THE CAMPS (2026-10-26): the meeting places of the foragers and the
// herders, kept in the villages' lists (their lifeway tells them apart),
// every CAMP_YEARS: where they live `camp_least` a km² or more, the
// densest first, each more than `camp_days` from any camp standing makes
// one; a camp is left where its people turn to the fields or the fish, fall
// under VILLAGE_LEAVE of its least, or a cell of its land (the cells
// nearest it) holds CAMP_MOVE times its people — then one is made there:
// the camps move with the people, the ice and the droughts. The far trade
// runs over them as over the villages. On Morvane some 200 foragers' camps
// through the cold, 580 herders' at the end; at 4 and 3 days and 0.05 a
// km² the foragers' were 2 800, over the thin land too.
pub(crate) const CAMP_YEARS: f64 = 2500.0;
pub(crate) const CAMP_DAYS_MOST: f64 = 6.0;
pub(crate) const CAMP_MOVE: f64 = 1.5;
pub(crate) const VILLAGE_DAYS_MOST: f64 = 2.0;
// THE DROUGHTS (2026-10-26): the land in squares of DRY_SQUARE_KM a
// landmass, so that a drought is a place. Each step a square's rain is its
// mean times 1 + DRY_SCALE × its variability × an anomaly (the variability
// is a year's; a step's mean of 25 years varies less): its own random walk
// (DRY_KEEP of the last, the rest new), and in a step with a strong ENSO
// (ENSO_CHANCE × the see-saw's strength) ENSO_PUSH × its mark. Under
// DRY_BELOW the step is dry: STORE_STEPS of them in a row the stores take;
// more are a famine — the fields and the pasture give the rain's share,
// the plants and the game half the shortfall less, and the people more
// than that die at once; a village under VILLAGE_LEAVE of its least is
// left. A famine is told in the log (`famines`) with the people it cost
// and the villages given up. With the year's variability whole and a
// famine from the second dry step, Morvane had 71 814 famines (3 597 of
// 10 000 people or more); now some 650 (some 30). A cold spell takes
// COLD_SPELL_DRY of the rain (climate_history.rs THE COLD SPELLS).
pub(crate) const DRY_SQUARE_KM: f64 = 300.0;
pub(crate) const DRY_SCALE: f64 = 0.25;
pub(crate) const STORE_STEPS: i32 = 2;
pub(crate) const DRY_KEEP: f64 = 0.6;
pub(crate) const DRY_BELOW: f64 = 0.75;
pub(crate) const ENSO_CHANCE: f64 = 0.3;
pub(crate) const ENSO_PUSH: f64 = 1.5;
// THE FLIGHT (2026-10-26): of those a famine's land does not carry,
// FAMINE_DEATH die; the rest leave for the cells around its square that no
// famine holds, as far as each has room — up to FLIGHT_CROWD times what it
// carries (they thin out to it as the people do) — and the rest of them die
// too. Before, all of them died. On Morvane some 450 000 fled, 2.7 M died:
// the cells around are mostly full. Herders taking a famine's farmland
// were tried the same day and never came: a farming cell that suits the
// herds has them already, and the fields cannot be given up while the
// lifeways are times that only go forward.
pub(crate) const FAMINE_DEATH: f64 = 0.5;
// THE EXCHANGE (2026-10-26): the everyday goods — grain, herds, wool — go
// no further than a day or two, from those who have to those who lack. In
// a famine a cell within EXCHANGE_DAYS of land no famine holds gets up to
// EXCHANGE of its shortfall from there, less with the days; deep in a
// famine's square nothing comes. Not drawn: it shows in fewer dead.
pub(crate) const EXCHANGE: f64 = 0.5;
pub(crate) const EXCHANGE_DAYS: f64 = 2.0;
pub(crate) const FLIGHT_CROWD: f64 = 1.5;
pub(crate) const VILLAGE_LEAVE: f64 = 0.5;
// THE FARMING AND THE HERDING (2026-10-26): no dates. Every CLIMATE_YEARS
// each region's best cell may become a centre, by a chance: of the farming
// (FARM_RATE × its wild crops over two × its arable land) while the
// climate is stable (climate_history.rs), where people have lived
// SETTLED_YEARS, CENTRE_CROPS wild crops grow and the arable land is
// CENTRE_ARABLE, and the region knows KNOW_FARM; of the herding (HERD_RATE
// × its herd animals over two × its pasture) likewise, the climate stable
// too (without it a herding centre came at year 7 500, deep in the cold;
// the earth's animals were all tamed in the Holocene), with CENTRE_HERDS
// herd animals, CENTRE_PASTURE pasture and KNOW_HERD — at
// CENTRE_SPACING_KM from any centre of its lifeway on its landmass. A farming centre tames
// its wild crops at once, its herd animals HERD_LAG later; a herding
// centre its herd animals. They spread over the cells people live in,
// FARM_KM_A and HERD_KM_A a year, each where it suits (its niche;
// FARM_ARABLE, HERD_PASTURE): a cell takes what its neighbour has and
// suits it; land it does not suit it crosses FARM_BARRIER, HERD_BARRIER
// times slower, kept nowhere there. Through suiting cells alone the waves
// ran out along the arable and pasture strips, half of the suiting cells
// never reached, in fronds (2026-10-26). The fields carry FARM_GAIN × the
// arable land times more people, the herds HERD_GAIN × the pasture (the
// settlement's densities, settle.rs: farmers 15, herders 1.5, foragers 0.1
// a km²). HERD_RATE was 0.2: the first herding centre came before the
// first fields on Morvane. A cell keeps its domesticates as bits, MAX_TAMED
// of them at most.
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
// THE KNOWLEDGE (2026-10-26), a region's (the habitable land's connected
// parts), every CLIMATE_YEARS: it moves toward KNOW_SCALE × log10(1 + its
// people / KNOW_PEOPLE) — more people keep more — by KNOW_GAIN of the way
// up, KNOW_LOSS of the way down (a small, isolated group loses some:
// Henrich's cumulative culture). People who cross bring KNOW_CARRIED of
// theirs. The boats' reach over open water is a region's: REACH_START +
// REACH_PER_KNOW × its knowledge, REACH_END at most. It was the time's
// until 2026-10-26, as it is in step 1 (peopling.rs): it grew evenly from
// 30 to 450 km over the span, and reached 98.5 % of Morvane's land, its far
// islands too. A crossing within it is tried with CROSSING_CHANCE a step.
// REACH_END is land in sight (2026-10-28, docs/design/prehistory-in-three-
// steps.md: no open sea in step 2, only the coast and what is seen from
// it): Cyprus, some 70 km off the coast and seen from it, was settled with
// cattle at +1 000 (docs/design/earth-prehistory-sources.md); 450 km until
// then, when this loop peopled the world itself. On Morvane (v14) step 2
// crossed 129 times, 8 of them over 100 km, the longest 432 km.
pub(crate) const KNOW_SCALE: f64 = 1.0;
// 3 000 (2026-10-26; 10 000 before): the foragers are thin, a region knew
// too little to cross for most of the span.
pub(crate) const KNOW_PEOPLE: f64 = 3000.0;
pub(crate) const KNOW_GAIN: f64 = 0.1;
pub(crate) const KNOW_LOSS: f64 = 0.02;
pub(crate) const KNOW_CARRIED: f64 = 0.8;
pub(crate) const REACH_START: f64 = 30.0;
pub(crate) const REACH_PER_KNOW: f64 = 150.0;
pub(crate) const REACH_END: f64 = 100.0;
pub(crate) const CROSSING_CHANCE: f64 = 0.02;
// THE SEAFARING (2026-10-26, a cheat, asked for): the reach takes the
// larger of a region's knowledge and its `seafaring`, which a crossing
// brings in full and which never falls; every CLIMATE_YEARS it passes both
// ways along the crossings made. Without it the ways to the large
// landmasses ran over small islands whose few people kept little, and
// Morvane's people reached 3 of its 7 large landmasses.
// THE STEPPING STONES (2026-10-26, a cheat too): from a region of fewer
// than STONE_CELLS cells people set out at once — any people, every
// crossing with STONE_CHANCE a step. The way to Morvane's largest landmass
// ran over some 100 such regions along a cold coast, at CROSSING_CHANCE
// each over 100 000 years.
pub(crate) const STONE_CELLS: i32 = 100;
pub(crate) const STONE_CHANCE: f64 = 0.5;
pub(crate) const CROSSINGS_A_PAIR: usize = 32;
pub(crate) const VOYAGE_KM: f64 = 3000.0;
/// The copper (docs/design/prehistory-in-three-steps.md, step 2): a
/// farmers' village that has stood COPPER_VILLAGE_YEARS within COPPER_DAYS
/// of copper of COPPER_RICH or more finds it and hammers it (the copper
/// lies in the mountains, the fields do not: it is fetched, as obsidian
/// was), at COPPER_RATE a
/// CLIMATE_YEARS and COPPER_SPACING_KM from where it was found before on
/// its landmass (2026-10-28: over the sea before, which step 2 does not
/// cross, as the farming's centres); a village that has known it
/// SMELT_AFTER years and stood SMELT_VILLAGE_YEARS smelts it, at
/// SMELT_RATE, as far from the smelting before on its landmass. Both are passed on to the people around at COPPER_KM_A, as the
/// fields are, the smelting only to who knows the copper. The copper
/// changes no food: on the earth it was an ornament first, then a sign of
/// rank.
pub(crate) const COPPER_RICH: f64 = 0.6;
pub(crate) const COPPER_DAYS: f64 = 20.0;
pub(crate) const COPPER_VILLAGE_YEARS: f64 = 1000.0;
pub(crate) const COPPER_RATE: f64 = 0.3;
pub(crate) const COPPER_SPACING_KM: f64 = 1500.0;
pub(crate) const COPPER_KM_A: f64 = 1.0;
pub(crate) const SMELT_AFTER: f64 = 3000.0;
pub(crate) const SMELT_VILLAGE_YEARS: f64 = 2000.0;
pub(crate) const SMELT_RATE: f64 = 0.1;
/// The towns: a farmers' village draws to itself a share of the people
/// of its hinterland, the land within CITY_DAYS nearer to it than to
/// another village: TOWN_SHARE, COPPER_SHARE more when it knows the copper
/// and SMELT_SHARE more when it smelts it (the copper is rank, and rank
/// draws). Its town grows toward that share at TOWN_GROWTH_A. The people
/// of the cells stay as they are: the town is a part of them. The history
/// ends at its first city, a town of CITY_PEOPLE or more (Çatalhöyük, a
/// large village, had some hundreds to a few thousand, Uruk perhaps
/// 40 000: docs/design/earth-prehistory-sources.md), at the CLIMATE_YEARS
/// it grows to it; at SPAN_YEARS if none does.
pub(crate) const CITY_DAYS: f64 = 1.0;
pub(crate) const TOWN_SHARE: f64 = 0.15;
pub(crate) const COPPER_SHARE: f64 = 0.1;
pub(crate) const SMELT_SHARE: f64 = 0.2;
pub(crate) const TOWN_GROWTH_A: f64 = 0.0005;
pub(crate) const CITY_PEOPLE: f64 = 10_000.0;

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

/// The big game as the fauna placed it (flora.rs populate): a code a cell,
/// 2 and above where it lives; and how vulnerable it is, 0 … 1 (the
/// catalog's megafauna weight: the elephant 0.8 … the aurochs 0.2).
pub struct BigGame<'a> {
    pub id: String,
    pub codes: &'a [u8],
    pub vulnerability: f64,
}

/// The rain's reliability per cell (the save's, generator/climate/
/// reliability.ts): the annual rain's coefficient of variation, the ENSO
/// see-saw's mark (−1 drier in its warm phase … +1), the see-saw's
/// strength (0 … 1).
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
    /// The domesticable starch plants and the tamable herd animals of the
    /// catalog as the flora and the fauna placed them.
    pub crops: Vec<Layer<'a>>,
    pub herds: Vec<Layer<'a>>,
    /// None without the save's refinement: no droughts.
    pub rain: Option<Rain>,
    /// Keep the traits (peoples.rs) with each kept state, for a measure;
    /// the history does not need them.
    pub keep_traits: bool,
}

/// A kept state: the people a km² in
/// PEOPLE_FRAME_STEP steps, the small game's share in 255ths, each species
/// of the big game's share in 255ths on its cells (SimulationResult
/// `species`, aligned). Float32 a cell, the people alone took 241 MB on
/// Morvane.
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

/// The history's result, without its knowledge and its regions.
pub struct SimulationResult {
    pub arrival: Vec<f32>,
    pub land: Vec<u8>,
    pub from: Vec<i32>,
    pub origin: i32,
    pub crossings: Vec<f32>,
    pub crossing_ways: Vec<i32>,
    pub kept: Vec<SimFrame>,
    /// The big game's species, their cells (the frames' `big` aligned).
    pub species: Vec<(String, Vec<i32>)>,
    /// The climate history's draw: when the cold was deepest, its depth,
    /// the melt's years.
    pub climate: (f64, f64, f64),
    /// Where a species of the big game died out: on a landmass, when its
    /// last tenth went, at a cell of it.
    pub extinctions: Vec<Extinction>,
    /// The history's log (historyLogShared.ts), each event written when it
    /// happened, in the order it happened.
    pub log: Vec<LogEvent>,
    pub centres: Vec<f32>,
    pub farm_at: Vec<f32>,
    pub herd_at: Vec<f32>,
    pub domestications: Vec<Domestication>,
    pub villages: Vec<i32>,
    pub village_from: Vec<f32>,
    pub village_to: Vec<f32>,
    pub population: Vec<f32>,
    /// Each village's and camp's town at the end, people (0 for a camp).
    pub village_town: Vec<f32>,
    /// When each cell knew the copper, and smelted it; Infinity for never.
    pub copper_at: Vec<f32>,
    pub smelt_at: Vec<f32>,
    /// The history's start, step 1's end (peopling.rs span), and its end:
    /// its first city's time, or SPAN_YEARS. The states are kept every
    /// KEEP_YEARS from the start and at the end, the people's count every
    /// POPULATION_STEP from the start.
    pub start: f64,
    pub end: f64,
    /// THE PEOPLES (peoples.rs): each cell's traits at the end, TRAITS a
    /// cell. Not packed: the peoples they give are (`tree`).
    pub traits: Vec<f32>,
    /// With `keep_traits`: the traits at each kept state (`kept`, aligned),
    /// in 65535ths; else empty. Not packed.
    pub trait_frames: Vec<Vec<u16>>,
    /// THE TREE (peoples.rs): the peoples at each kept state (`kept`,
    /// aligned) and their ids that last. Packed since v3 (pack.rs).
    pub tree: Tree,
    /// The cells whose traits the fields replaced, the herds'; the
    /// branches' splits (peoples.rs).
    pub replaced: u32,
    pub herd_replaced: u32,
    pub splits: u32,
}

/// Each cell's distance from today's glaciers over the cold climates, km
/// (climate_history.rs ice_may_cover): how soon
/// the ice reaches it; Infinity where it cannot.
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

/// The regions: the habitable land's connected parts, an id a cell (-1
/// elsewhere), and how many.
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

/// A crossing over open water: from a coast cell to another landmass's
/// nearest coast, km of sea between.
#[derive(Clone)]
struct Crossing {
    from: usize,
    to: usize,
    km: f64,
    // Its way over the sea, `from` to `to` (made for the ones kept).
    path: Vec<usize>,
    // Where the two searches met: a on `from`'s side, b on `to`'s.
    a: usize,
    b: usize,
}

/// The crossings, once: from every coast cell
/// people can live on today (`habitable`) over the sea, a multi-source
/// Dijkstra on the voyage's length, labelled by its REGION — the land
/// people can live on, connected (a landmass the ice cuts into parts is
/// several; by landmass, a landing reached one part and its people stayed
/// there); where two labels meet, the way between their two coasts. A
/// crossing needs as much reach as its longest stretch of OPEN water: a sea
/// cell beside land (any land, ice too) ends a stretch — boats keep to the
/// coast, past the ice (the "kelp highway" of the Americas' first people).
/// A voyage is VOYAGE_KM long at most. For each coast cell its shortest to
/// each other region; of those the CROSSINGS_A_PAIR needing the least reach
/// a pair of regions, both ways. `region`: regions_of's.
// Before (2026-10-26): the single shortest a pair, every sea km counted,
// left Morvane's first continent 258 km of open water from any other coast
// people can live on; and a coast of ice was a landing, where people stood
// on a strip before a glacier (the first skeleton even let such a landing,
// with no people, settle the land beyond: its 82 % were that).
fn crossings_of(
    h: &Habitat,
    max_km: f64,
    habitable: &dyn Fn(usize) -> bool,
    region: &[i32],
) -> Vec<Crossing> {
    let n = h.count;
    let mut voyage = vec![f64::INFINITY; n];
    // The open stretch at a cell and the longest on the way to it.
    let mut stretch = vec![0f32; n];
    let mut longest = vec![0f32; n];
    let mut source = vec![-1i32; n];
    // The cell each was reached from, for the ways.
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
    // The ways: from `from` out to where the searches met, and in to `to`.
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

// A species of the big game: its cells, its share in each (aligned), its
// cells' positions by landmass (for its extinction), its rates.
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
    // What each cell carries now (climate_history.rs): the cold's share of
    // today's, 0 under the ice; the shelf while the sea stands below it.
    capacity: Vec<f32>,
    // The game, a share of the land's; big game only where a species of it
    // lives.
    small: Vec<f32>,
    species: Vec<Species>,
    // Per cell the big game's shares summed, and how many species.
    big_sum: Vec<f32>,
    big_count: Vec<u8>,
    // The farming and the herding: when each came to a cell, its
    // domesticates there as bits, the centres, the domesticates.
    farm_at: Vec<f32>,
    herd_at: Vec<f32>,
    tamed_bits: Vec<u32>,
    centres: Vec<f64>,
    tamed: Vec<Tamed>,
    // The cells that may pass the fields or the herds on.
    farm_front: Vec<usize>,
    herd_front: Vec<usize>,
    copper_at: Vec<f32>,
    smelt_at: Vec<f32>,
    copper_front: Vec<usize>,
    smelt_front: Vec<usize>,
    // The cells the fishers live in (THE FISHERS).
    fishing: Vec<u8>,
    dry_square: Vec<i32>,
    square_rain: Vec<f32>,
    // How much of a famine's shortfall a cell's neighbours make up, 0 … 1
    // (THE EXCHANGE).
    fed: Vec<f32>,
    people: Vec<f32>,
    arrival: Vec<f32>,
    from: Vec<i32>,
    // A step touches two lists alone: the cells still growing or shrinking
    // (until within FULL_SHARE of what they carry), and the front — lived-in
    // cells with an empty neighbour people could settle. Over all the
    // lived-in cells a run took 40 s on Morvane. Both are made again from
    // all the lived-in cells when the climate moves (CLIMATE_YEARS).
    growing: Vec<usize>,
    // A cell on `growing` once at most.
    in_growing: Vec<u8>,
    front: Vec<usize>,
    lived: Vec<usize>,
    // THE LOG (historyLogShared.ts): each event when it happens; which
    // landmasses people reached, for a crossing's `first`.
    landmass_reached: Vec<u8>,
    log: Vec<LogEvent>,
    // THE PEOPLES (peoples.rs): they feed back into nothing here.
    traits: Traits,
}

impl Sim<'_, '_> {
    fn eco(&self, field: usize, i: usize) -> f64 {
        self.h.eco(field, i)
    }

    // The rain's share this step where a famine is (THE DROUGHTS), else 1.
    fn rain_of(&self, i: usize) -> f64 {
        let r = if self.dry_square[i] >= 0 {
            self.square_rain[self.dry_square[i] as usize] as f64
        } else {
            1.0
        };
        r + (1.0 - r) * EXCHANGE * self.fed[i] as f64
    }

    // What the fields and the herds add, as a factor on what the land
    // carries.
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

    // What the foragers get of what the land carries, from the game.
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

    // A cell takes domesticate `d` at `t`: knows it, and keeps it where it
    // suits; where not, only passes it on.
    fn take(&mut self, d: usize, cell: usize, t: f64) {
        if self.tamed_bits[cell] & (1 << d) != 0 {
            return;
        }
        self.tamed_bits[cell] |= 1 << d;
        // On the front for each it takes: a cell that had left it with its
        // first passed none it took later on.
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

    // CENTRE_SPACING_KM from every centre of the same lifeway on the same
    // landmass: the farming may begin beside a herding centre (with it, a
    // herding centre at year 7 500 kept Morvane's one place fit for the
    // fields from farming), and on another landmass (2026-10-28: step 2
    // crosses no open sea, so a centre does not spread over it; an
    // island's centre 737 km off Morvane's largest landmass kept that
    // landmass from farming, 2.4 % of the land farmed instead of 6.8 %).
    // On the earth the farming began apart many times (the Near East,
    // China, New Guinea, Mesoamerica).
    fn far_centre(&self, cell: usize, way: u8) -> bool {
        let mut k = 0;
        while k < self.centres.len() {
            let other = self.centres[k] as usize;
            if self.centres[k + 2] == way as f64
                && self.h.landmass[other] == self.h.landmass[cell]
                && km_between(self.h, cell, other) < CENTRE_SPACING_KM
            {
                return false;
            }
            k += 3;
        }
        true
    }

    // A cell is settled once it has people; one left (the ice, the sea over
    // the shelf) may be settled again. Its arrival is the first. It takes
    // the traits of `kin`, the cell its settlers came from.
    fn settle(&mut self, cell: usize, t: f64, density: f64, parent: i32, kin: usize) {
        self.people[cell] = density as f32;
        self.traits.inherit(cell, kin);
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

    // The copper known, or smelted, at `cell` from `t`.
    fn knows(&mut self, smelted: bool, cell: usize, t: f64) {
        if smelted {
            self.smelt_at[cell] = t as f32;
            self.smelt_front.push(cell);
        } else {
            self.copper_at[cell] = t as f32;
            self.copper_front.push(cell);
        }
    }

    // The traits in 65535ths, for a kept state (`keep_traits`).
    fn trait_frame(&self) -> Vec<u16> {
        self.traits
            .values
            .iter()
            .map(|&x| (x as f64 * 65535.0 + 0.5) as u16)
            .collect()
    }

    // THE TREE's peoples (peoples.rs) at a kept state of `people`, at `t`.
    fn tree_frame(&mut self, tree: &mut Tree, people: &[u16], t: f64) {
        let fields: Vec<u8> = self
            .farm_at
            .iter()
            .map(|&at| (at as f64 <= t) as u8)
            .collect();
        tree.frame(
            self.h,
            &mut self.traits,
            people,
            &fields,
            &self.input.peopling.group,
            t,
        );
    }

    // The state kept every KEEP_YEARS.
    fn frame(&self) -> SimFrame {
        let n = self.h.count;
        let mut frame = SimFrame {
            people: vec![0u16; n],
            small: vec![0u8; n],
            big: self
                .species
                .iter()
                .map(|sp| vec![0u8; sp.share.len()])
                .collect(),
        };
        for i in 0..n {
            let p = self.people[i] as f64 / PEOPLE_FRAME_STEP;
            frame.people[i] = if p > 65535.0 { 65535 } else { (p + 0.5) as u16 };
            frame.small[i] = (self.small[i] as f64 * 255.0 + 0.5) as u8;
        }
        for (k, sp) in self.species.iter().enumerate() {
            for j in 0..sp.share.len() {
                frame.big[k][j] = (sp.share[j] as f64 * 255.0 + 0.5) as u8;
            }
        }
        frame
    }

    fn open(&self, u: usize) -> bool {
        self.people[u] == 0.0 && self.capacity[u] > 0.0
    }

    fn is_camp(villages: &[i32], v: usize) -> bool {
        let way = villages[2 * v + 1] as u8;
        way == FORAGERS || way == HERDERS
    }
}

/// Each shelf cell's coast: the land cell nearest it by the way over the
/// shelf (a shelf between two landmasses is parted where their ways meet);
/// -1 elsewhere and for a shelf no land touches.
fn shelf_coast_of(h: &Habitat, shelf: &[u8]) -> Vec<i32> {
    let n = h.count;
    let mut of = vec![-1i32; n];
    let mut km = vec![f64::INFINITY; n];
    let mut heap = MinHeap::new(1 << 16);
    for i in 0..n {
        if h.land[i] == 0 || h.landmass[i] < 0 {
            continue;
        }
        let touches = h.edges(i).any(|e| shelf[h.nbr[e] as usize] != 0);
        if !touches {
            continue;
        }
        of[i] = i as i32;
        km[i] = 0.0;
        heap.push(0.0, i as i32);
    }
    while !heap.is_empty() {
        heap.pop();
        let i = heap.popped_index as usize;
        let d = heap.popped_key;
        if d > km[i] {
            continue;
        }
        for e in h.edges(i) {
            let u = h.nbr[e] as usize;
            let nd = d + h.dist_km[e] as f64;
            if shelf[u] == 0 || nd >= km[u] {
                continue;
            }
            km[u] = nd;
            of[u] = of[i];
            heap.push(nd, u as i32);
        }
    }
    for i in 0..n {
        if shelf[i] == 0 {
            of[i] = -1;
        }
    }
    of
}

pub(crate) struct Ground {
    pub base: Vec<f32>,
    pub speed: Vec<f32>,
    pub shelf: Vec<u8>,
    // Each shelf cell's coast (shelf_coast_of); -1 elsewhere.
    pub coast: Vec<i32>,
}

/// The foragers' density a cell carries in today's climate (people a km²),
/// the speed of their front over it (km a year), and whether it is a shelf
/// the sea can leave dry; 0 for ice and for the sea below SHELF_M.
///
/// A dry shelf carries what its coast carries, and is crossed as fast
/// (2026-10-28). The level holds no land fields under the sea, so the
/// shelf carried as little as the poorest land (FORAGER_DENSITY × 0.05)
/// and was crossed at the slowest: empty, while the earth's dry shelves
/// (Doggerland, Sundaland, Beringia) were lowlands of rivers, marshes and
/// coasts, lived in. A shelf no land touches keeps the old values. To be
/// replaced by the level's own fields for a dry shelf (the ecology with
/// the shelf as land), with the next generator round.
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
            // Walked while dry, carrying as little as the poorest land,
            // crossed at the slowest.
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
    let coast = shelf_coast_of(h, &shelf);
    for i in 0..n {
        let c = coast[i];
        if shelf[i] != 0 && c >= 0 && base[c as usize] > 0.0 {
            base[i] = base[c as usize];
            speed[i] = speed[c as usize];
        }
    }
    Ground {
        base,
        speed,
        shelf,
        coast,
    }
}

pub fn simulate(
    h: &Habitat,
    input: &SimulationInput,
    mut on_progress: Option<&mut dyn FnMut(f64)>,
) -> SimulationResult {
    let n = h.count;
    let land = &h.land;
    let climate = ClimateHistory::of(input.seed, SPAN_YEARS);
    let Ground {
        base,
        speed,
        shelf,
        coast,
    } = ground_of(h, input.carrying);
    let ice_km = ice_distance(h);
    // A cell whose carrying moved by CAPACITY_MOVED of it or more is marked
    // (`moved_now`), to grow or shrink again.
    let mut moved_now = vec![0u8; n];
    // `t` the climate's (a CLIMATE_YEARS), `spell` the cold a spell adds
    // now; the shelf cells the sea covers that were dry into `drowned`.
    let update_climate = |t: f64,
                          spell: f64,
                          capacity: &mut [f32],
                          moved_now: &mut [u8],
                          drowned: &mut Vec<usize>| {
        let cold = climate.cold(t);
        let drop = climate.sea_drop_m(t);
        drowned.clear();
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
                base[i] as f64 * cold_share(h.koppen[i], ice_km[i] as f64, cold, spell)
            };
            capacity[i] = now as f32;
            if shelf[i] != 0 && was > 0.0 && now <= 0.0 {
                drowned.push(i);
            }
            let c = capacity[i] as f64;
            moved_now[i] = u8::from((c - was).abs() >= CAPACITY_MOVED * js::max(was, c));
        }
    };
    // Each shelf cell's landmass, its coast's.
    let shelf_landmass: Vec<i32> = coast
        .iter()
        .map(|&c| if c < 0 { -1 } else { h.landmass[c as usize] })
        .collect();
    let mut drowned: Vec<usize> = Vec::new();
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
    // The regions joined by a crossing made, in pairs.
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
        copper_at: vec![f32::INFINITY; n],
        smelt_at: vec![f32::INFINITY; n],
        copper_front: Vec::new(),
        smelt_front: Vec::new(),
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
        traits: Traits::seed(h, input.peopling, input.seed),
    };
    let mut extinctions: Vec<Extinction> = Vec::new();
    // Herds a farming centre tames HERD_LAG after its fields.
    let mut herds_due: Vec<(usize, f64)> = Vec::new();
    // The villages: [cell, lifeway], when founded and left; the village in
    // a cell, -1 for none. A place of these lists is a camp by its lifeway
    // (THE CAMPS).
    let mut villages: Vec<i32> = Vec::new();
    let mut village_from: Vec<f64> = Vec::new();
    let mut village_to: Vec<f64> = Vec::new();
    let mut village_at = vec![-1i32; n];
    // The ways' days (travel.rs).
    let way_days = travel_days(h);
    // Each cell's days from copper rich enough to find, to COPPER_DAYS.
    let mut copper_days = vec![f32::INFINITY; n];
    {
        let rich: Vec<usize> = (0..n)
            .filter(|&i| land[i] != 0 && h.eco(COPPER, i) >= COPPER_RICH)
            .collect();
        within_days(
            h,
            &way_days,
            &rich,
            COPPER_DAYS,
            &mut copper_days,
            None,
            None,
        );
    }
    let mut town: Vec<f64> = Vec::new();
    let mut hinterland_days = vec![f32::INFINITY; n];
    let mut hinterland_of = vec![-1i32; n];
    let town_grow = 1.0 - det_exp(-TOWN_GROWTH_A * CLIMATE_YEARS);
    let mut found_copper: Vec<usize> = Vec::new();
    let mut found_smelting: Vec<usize> = Vec::new();
    let mut end = SPAN_YEARS;
    // Each cell's days to the nearest village standing; whether one was
    // left since they were made.
    let mut near_village = vec![f32::INFINITY; n];
    let mut scratch_days = vec![f32::INFINITY; n];
    let mut villages_left = false;
    // Each cell's days to the nearest camp, and which.
    let mut near_camp = vec![f32::INFINITY; n];
    let mut camp_owner = vec![-1i32; n];
    let mut population =
        vec![0f32; ((SPAN_YEARS - input.peopling.span) / POPULATION_STEP).floor() as usize + 1];
    let mut next_mark = 0usize;
    // The cells hunted, kept while their game grows back.
    let mut hunted: Vec<usize> = Vec::new();
    let mut in_hunted = vec![0u8; n];
    // [landmass, cell landed on, time, km] each crossing made, and its
    // way's cells, then -1.
    let mut made: Vec<f64> = Vec::new();
    let mut ways: Vec<i32> = Vec::new();
    let mut kept: Vec<SimFrame> = Vec::new();
    let mut trait_frames: Vec<Vec<u16>> = Vec::new();
    let mut tree = Tree::new();

    // Step 1's end, where the history begins, and its log.
    let start = input.peopling;
    let t0 = start.span;
    sim.log.extend(start.log.iter().cloned());
    // The cold spells, all after t0 (THE COLD SPELLS); the cold a spell
    // added at the last step.
    let spells = cold_spells(input.seed, t0, STEP_YEARS);
    let mut spell_was = 0.0;

    // The droughts' squares (THE DROUGHTS): their cells, their mean
    // variability and ENSO mark, their anomaly, rain, dry steps in a row,
    // and the famine going on in each.
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
    // The cells around each square, outside it: where its people flee to.
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
    for s in (t0 / STEP_YEARS) as usize..=steps {
        let t = s as f64 * STEP_YEARS;
        // The history begins: step 1's people at the capacity, their
        // arrival and where they came from, the knowledge their numbers
        // give.
        if t == t0 {
            update_climate(
                t,
                spell_cold(&spells, t),
                &mut sim.capacity,
                &mut moved_now,
                &mut drowned,
            );
            for i in 0..n {
                if start.arrival[i] == f32::INFINITY {
                    continue;
                }
                sim.arrival[i] = start.arrival[i];
                sim.from[i] = start.from[i];
                if land[i] != 0 && h.landmass[i] >= 0 {
                    sim.landmass_reached[h.landmass[i] as usize] = 1;
                }
                if sim.capacity[i] > 0.0 {
                    sim.people[i] = sim.capacity[i];
                    sim.lived.push(i);
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
        if (t - t0) % KEEP_YEARS == 0.0 {
            kept.push(sim.frame());
            if input.keep_traits {
                trait_frames.push(sim.trait_frame());
            }
            sim.tree_frame(&mut tree, &kept[kept.len() - 1].people, t);
        }
        if (t - t0) % POPULATION_STEP == 0.0 {
            let mut sum = 0.0;
            for &i in &sim.lived {
                sum += sim.people[i] as f64 * h.area_km2[i] as f64;
            }
            let at_k = ((t - t0) / POPULATION_STEP) as usize;
            population[at_k] = sum as f32;
            // The marks passed since the last count, at the time between.
            let last = if t > t0 {
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
                let at = if t > t0 {
                    t - POPULATION_STEP * (1.0 - (mark - last) / js::max(1e-9, sum - last))
                } else {
                    t0
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
        // 0. A cold spell begins or ends (THE COLD SPELLS): what the cells
        //    carry, at the climate's last CLIMATE_YEARS; every lived-in
        //    cell grows or shrinks to it (its change is under
        //    CAPACITY_MOVED in the warm climates).
        let spell = spell_cold(&spells, t);
        if spell != spell_was {
            spell_was = spell;
            if spell > 0.0 {
                sim.log.push(LogEvent::ColdSpell {
                    at: t,
                    years: COLD_SPELL_YEARS,
                });
            }
            if t % CLIMATE_YEARS != 0.0 {
                let last = (t / CLIMATE_YEARS).floor() * CLIMATE_YEARS;
                update_climate(last, spell, &mut sim.capacity, &mut moved_now, &mut drowned);
            }
            for k in 0..sim.lived.len() {
                let i = sim.lived[k];
                if sim.people[i] > 0.0 {
                    sim.grows(i);
                }
            }
        }
        // 0. The climate, every CLIMATE_YEARS: what the cells carry; the
        //    people of a cell that carries nothing now leave it for its
        //    neighbours (THE RISING SEA).
        if t > 0.0 && t % CLIMATE_YEARS == 0.0 {
            update_climate(t, spell, &mut sim.capacity, &mut moved_now, &mut drowned);
            let mut still = Vec::new();
            let mut leaving = Vec::new();
            for k in 0..sim.lived.len() {
                let i = sim.lived[k];
                if sim.people[i] == 0.0 {
                    continue;
                }
                if sim.capacity[i] <= 0.0 {
                    leaving.push(i);
                    continue;
                }
                still.push(i);
            }
            sim.lived = still;
            for k in 0..sim.lived.len() {
                let i = sim.lived[k];
                if moved_now[i] != 0 {
                    sim.grows(i);
                }
            }
            // Each landmass's shelf the sea took, in the order of its first
            // cell: [landmass, km², the people who moved from it, its cell of
            // the most people, their number].
            let mut sea_took: Vec<(i32, f64, f64, i32, f64)> = Vec::new();
            let mut took_at: HashMap<i32, usize> = HashMap::new();
            for &i in &drowned {
                let m = shelf_landmass[i];
                if m < 0 {
                    continue;
                }
                let k = *took_at.entry(m).or_insert_with(|| {
                    sea_took.push((m, 0.0, 0.0, i as i32, -1.0));
                    sea_took.len() - 1
                });
                sea_took[k].1 += h.area_km2[i] as f64;
            }
            for &i in &leaving {
                let had = sim.people[i] as f64 * h.area_km2[i] as f64;
                sim.people[i] = 0.0;
                let to: Vec<usize> = h
                    .edges(i)
                    .map(|e| h.nbr[e] as usize)
                    .filter(|&u| sim.capacity[u] > 0.0)
                    .collect();
                let mut moved = 0.0;
                for &u in &to {
                    let room = js::max(
                        0.0,
                        (FLIGHT_CROWD * sim.carried(u) - sim.people[u] as f64)
                            * h.area_km2[u] as f64,
                    );
                    let came = js::min(had / to.len() as f64, room);
                    if came <= 0.0 {
                        continue;
                    }
                    moved += came;
                    let density = came / h.area_km2[u] as f64;
                    if sim.people[u] == 0.0 {
                        sim.settle(u, t, density, i as i32, i);
                    } else {
                        sim.people[u] = (sim.people[u] as f64 + density) as f32;
                        sim.grows(u);
                    }
                }
                // The sea's (a shelf cell), not the ice's.
                if shelf[i] == 0 {
                    continue;
                }
                let Some(&k) = took_at.get(&shelf_landmass[i]) else {
                    continue;
                };
                sea_took[k].2 += moved;
                if had > sea_took[k].4 {
                    sea_took[k].3 = i as i32;
                    sea_took[k].4 = had;
                }
            }
            for &(m, km2, people, cell, _) in &sea_took {
                if km2 >= DROWNED_TOLD_KM2 {
                    sim.log.push(LogEvent::Drowned {
                        at: t,
                        cell: cell as f64,
                        landmass: m as f64,
                        km2,
                        people,
                    });
                }
            }
            let still = sim.lived.clone();
            sim.front = still;
            // THE PEOPLES: the traits' drift and contact (peoples.rs).
            sim.traits
                .climate_step(h, &sim.lived, &sim.people, &way_days);
            // The big game's extinctions: a species under EXTINCT_BELOW of
            // its own on a landmass.
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
            // The knowledge, toward what each region's people keep.
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
            // The centres: each region's best cell for the farming and for
            // the herding, by a chance.
            let stable = climate.stable(t);
            // A domesticate is tamed once on a landmass: a centre counts
            // only the wild ones not tamed there yet (each centre tamed its
            // own; on Morvane the horse five times, five herding centres,
            // 2026-10-26).
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
            // The fishers, the villages (THE FISHERS, THE VILLAGES).
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
                town.push(0.0);
            }
            // The copper, found and smelted; far only from the finds on
            // its landmass, as the centres (far_centre).
            let far = |found: &[usize], cell: usize| {
                found.iter().all(|&c| {
                    h.landmass[c] != h.landmass[cell] || km_between(h, cell, c) >= COPPER_SPACING_KM
                })
            };
            for v in 0..village_to.len() {
                if village_to[v] < f64::INFINITY || villages[2 * v + 1] as u8 != FARMERS {
                    continue;
                }
                let cell = villages[2 * v] as usize;
                let stood = t - village_from[v];
                let smelted = if sim.copper_at[cell] == f32::INFINITY {
                    if stood < COPPER_VILLAGE_YEARS
                        || copper_days[cell] as f64 > COPPER_DAYS
                        || !far(&found_copper, cell)
                        || sim.random.next() >= COPPER_RATE
                    {
                        continue;
                    }
                    found_copper.push(cell);
                    false
                } else {
                    if sim.smelt_at[cell] < f32::INFINITY
                        || (sim.copper_at[cell] as f64) > t - SMELT_AFTER
                        || stood < SMELT_VILLAGE_YEARS
                        || !far(&found_smelting, cell)
                        || sim.random.next() >= SMELT_RATE
                    {
                        continue;
                    }
                    found_smelting.push(cell);
                    true
                };
                sim.knows(smelted, cell, t);
                sim.log.push(LogEvent::Copper {
                    at: t,
                    cell: cell as f64,
                    smelted,
                });
            }
            // The towns, and the first city: the history's end.
            let seats: Vec<usize> = (0..village_to.len())
                .filter(|&v| village_to[v] == f64::INFINITY && villages[2 * v + 1] as u8 == FARMERS)
                .collect();
            let seat_cells: Vec<usize> = seats.iter().map(|&v| villages[2 * v] as usize).collect();
            let touched = within_days(
                h,
                &way_days,
                &seat_cells,
                CITY_DAYS,
                &mut hinterland_days,
                None,
                Some(&mut hinterland_of),
            );
            let mut hinterland = vec![0f64; seats.len()];
            for &c in &touched {
                hinterland[hinterland_of[c] as usize] +=
                    sim.people[c] as f64 * h.area_km2[c] as f64;
                hinterland_of[c] = -1;
            }
            reset(&mut hinterland_days, &touched);
            for v in 0..village_to.len() {
                if village_to[v] < f64::INFINITY {
                    town[v] = 0.0;
                }
            }
            let mut city: Option<(usize, f64)> = None;
            for (k, &v) in seats.iter().enumerate() {
                let cell = seat_cells[k];
                let mut share = TOWN_SHARE;
                if sim.copper_at[cell] as f64 <= t {
                    share += COPPER_SHARE;
                }
                if sim.smelt_at[cell] as f64 <= t {
                    share += SMELT_SHARE;
                }
                town[v] += (share * hinterland[k] - town[v]) * town_grow;
                if town[v] >= CITY_PEOPLE && city.is_none_or(|(_, most)| town[v] > most) {
                    city = Some((cell, town[v]));
                }
            }
            if let Some((cell, people)) = city {
                sim.log.push(LogEvent::City {
                    at: t,
                    cell: cell as f64,
                    people,
                });
                end = t;
                break;
            }
        }
        // The camps, every CAMP_YEARS (THE CAMPS).
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
            // Each cell's nearest camp: the camp's land; its densest cell.
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
                town.push(0.0);
            }
        }
        // 0b. The game, every GAME_STEPS: hunted where people live, grown
        //     back where they hunted; the cells people live in grow or
        //     shrink by it.
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
            // Each species over its cells hunted or growing back.
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
            // The cells whose food moved by FOOD_MOVED or more grow or
            // shrink again.
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
        // 0c. The droughts (THE DROUGHTS).
        if squares > 0 {
            let rain = input.rain.as_ref().unwrap();
            let enso = if sim.random.next() < ENSO_CHANCE * rain.enso_strength {
                ENSO_PUSH
            } else {
                0.0
            };
            let spread = (1.0 - DRY_KEEP * DRY_KEEP).sqrt();
            // A cold spell's rain, COLD_SPELL_DRY less (THE COLD SPELLS).
            let spell_rain = if spell > 0.0 {
                1.0 + COLD_SPELL_DRY
            } else {
                1.0
            };
            for q in 0..squares {
                let g = {
                    let a = sim.random.next();
                    let b = sim.random.next();
                    (-2.0 * det_log(1.0 - a)).sqrt() * det_cos(2.0 * PI * b)
                };
                anomaly[q] = (DRY_KEEP * anomaly[q] as f64
                    + spread * g
                    + enso * square_enso[q] as f64) as f32;
                let wet = (1.0 + DRY_SCALE * square_variability[q] as f64 * anomaly[q] as f64)
                    * spell_rain;
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
                // What the neighbours bring (THE EXCHANGE).
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
                // The famine: of those the land does not carry now, some
                // die, the rest flee (THE FLIGHT).
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
                // Their room around the square, people.
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
                            // `most` is a cell: the people fled have some.
                            sim.settle(u, t, density, most, most as usize);
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
        // 1. Growth, or shrinking toward less; a cell near what it carries
        //    leaves the list.
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
        // 2. Settling, over SUB_STEPS passes; the newly settled join the
        //    next. A front cell with no open neighbour left leaves the list.
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
                        sim.settle(u, at, density, i as i32, i);
                    }
                }
                if open_left {
                    still_front.push(i);
                }
            }
            // The newly settled, pushed onto `front` by settle, follow.
            still_front.extend_from_slice(&sim.front[count..]);
            sim.front = still_front;
        }
        // 2b. The fields and the herds, passed on to the lived-in
        //     neighbours they suit; a front cell with nothing left to pass
        //     leaves.
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
                            // THE REPLACEMENT (peoples.rs): the fields
                            // that come from a farmer cell to a cell
                            // without them, the herds from a herder cell
                            // to a cell without fields or herds, make it
                            // pending; `decide` decides it later.
                            let had = if plant {
                                sim.farm_at[u] < f32::INFINITY
                            } else {
                                sim.farm_at[u] < f32::INFINITY || sim.herd_at[u] < f32::INFINITY
                            };
                            sim.take(d, u, t + STEP_YEARS);
                            sim.grows(u);
                            let now = if plant {
                                sim.farm_at[u] < f32::INFINITY && sim.farm_at[i] < f32::INFINITY
                            } else {
                                sim.herd_at[u] < f32::INFINITY && sim.herd_at[i] < f32::INFINITY
                            };
                            if !had && now {
                                sim.traits.came(u, i, &sim.people, !plant);
                            }
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
        // THE REPLACEMENT decided where the farmers (the herders) have
        // grown in a pending cell (peoples.rs `decide`).
        sim.traits.decide(&sim.people);
        // 2c. The copper and its smelting, passed on.
        for smelted in [false, true] {
            let front = std::mem::take(if smelted {
                &mut sim.smelt_front
            } else {
                &mut sim.copper_front
            });
            let mut still = Vec::new();
            for &i in &front {
                let mut left = false;
                for e in h.edges(i) {
                    let u = h.nbr[e] as usize;
                    let known = if smelted {
                        sim.smelt_at[u]
                    } else {
                        sim.copper_at[u]
                    };
                    if sim.people[u] == 0.0
                        || known < f32::INFINITY
                        || (smelted && sim.copper_at[u] == f32::INFINITY)
                    {
                        continue;
                    }
                    left = true;
                    if sim.random.next()
                        < js::min(1.0, (COPPER_KM_A * STEP_YEARS) / h.dist_km[e] as f64)
                    {
                        sim.knows(smelted, u, t + STEP_YEARS);
                    }
                }
                if left {
                    still.push(i);
                }
            }
            let front = if smelted {
                &mut sim.smelt_front
            } else {
                &mut sim.copper_front
            };
            still.append(front);
            *front = still;
        }
        // 3. The crossings within the reach of their coast's knowledge.
        for (source, list) in &crossings_from {
            let source = *source;
            let g = region[source] as usize;
            // An empty coast sets out on none: where it carries nothing (the
            // ice) the share alone was 0 ≤ 0, and coasts never reached set
            // out (2026-10-26; a third of Morvane's crossings, and `from` in
            // circles).
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
                    // The way over the sea is passed: an arrival and a from
                    // on its sea cells, as step 1 gives them. A land cell on
                    // the way is a parent only once reached.
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
                    sim.settle(c.to, t + STEP_YEARS, density, parent, c.from);
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
        end_famine(&mut famine, q, end, &mut sim.log);
    }
    if (end - t0) % KEEP_YEARS != 0.0 {
        kept.push(sim.frame());
        if input.keep_traits {
            trait_frames.push(sim.trait_frame());
        }
        sim.tree_frame(&mut tree, &kept[kept.len() - 1].people, end);
    }
    population.truncate(((end - t0) / POPULATION_STEP) as usize + 1);
    SimulationResult {
        arrival: sim.arrival,
        land: land.clone(),
        from: sim.from,
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
        village_town: town.iter().map(|&x| x as f32).collect(),
        copper_at: sim.copper_at,
        smelt_at: sim.smelt_at,
        start: t0,
        end,
        replaced: sim.traits.replaced,
        herd_replaced: sim.traits.herd_replaced,
        splits: sim.traits.splits,
        traits: sim.traits.values,
        trait_frames,
        tree,
    }
}
