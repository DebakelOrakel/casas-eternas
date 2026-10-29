//! The incubator's tuning and its version, as the engine has them
//! (`casas_engine_api::pipeline::constants`, world/identity.ts
//! derivePipelineVersion): every constant a run's numbers depend on, by
//! module, and the catalog (`data/catalog.json`); the version
//! `v<INCUBATOR_ALGO_VERSION>-<hash of them>`. A change to a constant or to
//! the catalog gives another version by itself; a change to the code that
//! changes what a run gives, or to the packed form, raises
//! INCUBATOR_ALGO_VERSION by hand. `make engine` writes both to
//! `dist/incubator/` (constants.json, version.json).

use crate::{climate_history, habitat, log, niche, peoples, peopling, settle, simulation, travel};
use serde_json::{Map, Value, json};

/// Raised by hand on a change to the code that changes what a run gives,
/// or to the packed form (H1). The tuning is hashed beside it.
///
/// v1 (2026-10-27): the history as the crate ported it from the client.
/// v2 (2026-10-28): the history begins where step 1 of the prehistory
/// (peopling.rs) ends, has the copper and the towns, and ends at its
/// first city; its time and its end in the packed form.
/// v3 (2026-10-29): the peoples (peoples.rs Tree) in the packed form; the
/// other arrays the same bytes.
/// v4 (2026-10-29): the peoples' tree every CLIMATE_YEARS, not only at the
/// kept states (its ids, births and ends other), and its events in the
/// log (peoples.rs `Tree::tell`); the other arrays the same bytes. A
/// reader that does not know the new kinds of the log passes over them.
/// v5 (2026-10-29): the peoples without the stripes (peoples.rs
/// `compact`, `Traits::kin_of`; the herds replace no traits); the other
/// arrays the same bytes.
/// v6 (2026-10-29): the chronicle's splits and merges once they held
/// (peoples.rs `Tree::tell`, THE HOLD), no split in step 2's first
/// EARLY_SPLIT_YEARS; splits, merges and peoples gone told from
/// SPLIT_TOLD_SHARE, the turns to farming from FARMERS_TOLD_SHARE; the
/// arrays and the other events the same bytes.
pub const INCUBATOR_ALGO_VERSION: u32 = 6;

// The constants of a module as (name, value) pairs.
macro_rules! table {
    ($module:ident: $($name:ident),* $(,)?) => {
        vec![$((stringify!($name), $module::$name as f64)),*]
    };
}

fn object(pairs: Vec<(&str, f64)>) -> Value {
    Value::Object(
        pairs
            .into_iter()
            .map(|(k, v)| (k.to_string(), json!(v)))
            .collect(),
    )
}

/// The tuning by module, and the catalog: `{ climate, habitat, niche,
/// travel, peopling, simulation, peoples, settle, log, catalog }`.
pub fn constants() -> Value {
    let catalog: Value =
        serde_json::from_str(include_str!("../data/catalog.json")).expect("data/catalog.json");
    let mut log = table!(log: );
    log.extend(log::POPULATION_MARKS.iter().enumerate().map(|(k, &v)| {
        (
            [
                "POPULATION_MARK_0",
                "POPULATION_MARK_1",
                "POPULATION_MARK_2",
            ][k],
            v,
        )
    }));
    json!({
        "climate": object(table!(climate_history: SEA_DROP_M, STADIALS, STABLE_COLD, STABLE_YEARS, ICE_REACH_KM,
            COLD_SPELLS_MOST, COLD_SPELL_YEARS, COLD_SPELL_COLD, COLD_SPELL_DRY, COLD_SPELL_FROM, COLD_SPELL_TO)),
        "habitat": object(table!(habitat: CELL_SPACING_KM)),
        "niche": object(table!(niche: SUITABLE, BARRIER, SPREAD_KM, ORIGIN_AREA_KM2, OFF_COVER, BIG_RIVER)),
        "travel": object(table!(travel: WALK_HOURS, RIVER_BOAT_SIZE, RIVER_DOWN_KM_DAY, RIVER_UP_KM_DAY, COAST_DEPTH_M, COAST_KM_DAY, LANDING_DAYS)),
        "peopling": object(table!(peopling: REACH_START_KM, REACH_END_KM, SEA_KM_A, CROSSING_YEARS, GROUP_SHARE, END_SEA_DROP_M)),
        "simulation": object(table!(simulation:
            SPAN_YEARS, KEEP_YEARS, POPULATION_STEP, STEP_YEARS, PEOPLE_FRAME_STEP, CAME_STEP, SETTLE_AFTER, FISH_RICH,
            SUB_STEPS, FORAGER_DENSITY, CARRYING_FULL, GROWTH_A, SEED_SHARE, SEED_PEOPLE, FULL_SHARE,
            SPEED_MIN_KM_A, SPEED_MAX_KM_A, SLOPE_DRAG, CORRIDOR, SHELF_M, CLIMATE_YEARS, DROWNED_TOLD_KM2, GAME_STEPS,
            SMALL_REGROW_A, BIG_REGROW_A, HUNT_A, BIG_HUNT_A, HOME_WARY, PLANT_FOOD, SMALL_FOOD, BIG_FOOD,
            EXTINCT_BELOW, FOOD_MOVED, CAPACITY_MOVED, FISH_GAIN, CAMP_YEARS, CAMP_DAYS_MOST, CAMP_MOVE,
            VILLAGE_DAYS_MOST, DRY_SQUARE_KM, DRY_SCALE, STORE_STEPS, DRY_KEEP, DRY_BELOW, ENSO_CHANCE,
            ENSO_PUSH, FAMINE_DEATH, EXCHANGE, EXCHANGE_DAYS, FLIGHT_CROWD, VILLAGE_LEAVE, SETTLED_YEARS,
            FARM_RATE, HERD_RATE, CENTRE_CROPS, CENTRE_ARABLE, CENTRE_HERDS, CENTRE_PASTURE, KNOW_FARM,
            KNOW_HERD, CENTRE_SPACING_KM, HERD_LAG, FARM_KM_A, HERD_KM_A, FARM_BARRIER, HERD_BARRIER,
            FARM_ARABLE, HERD_PASTURE, FARM_GAIN, HERD_GAIN, MAX_TAMED, KNOW_SCALE, KNOW_PEOPLE, KNOW_GAIN,
            KNOW_LOSS, KNOW_CARRIED, REACH_START, REACH_PER_KNOW, REACH_END, CROSSING_CHANCE,
            STONE_CELLS, STONE_CHANCE, CROSSINGS_A_PAIR, VOYAGE_KM,
            COPPER_RICH, COPPER_DAYS, COPPER_VILLAGE_YEARS, COPPER_RATE, COPPER_SPACING_KM, COPPER_KM_A,
            SMELT_AFTER, SMELT_VILLAGE_YEARS, SMELT_RATE, CITY_DAYS, TOWN_SHARE, COPPER_SHARE, SMELT_SHARE,
            TOWN_GROWTH_A, CITY_PEOPLE,
        )),
        "peoples": object(table!(peoples:
            TRAITS, BRANCH_SHARE, BRANCH_ROUNDS, BRANCH_STEP, TRAIT_DRIFT, LANGUAGE_DRIFT, TRAIT_CONTACT, LANGUAGE_CONTACT,
            CONTACT_DAYS, TRAIT_LIKE, PEOPLE_DISTANCE, REPLACE_SHARE, SPLIT_KM2,
            PEOPLE_LEAST, PEOPLE_LEAST_KM2, SPLIT_TOLD_SHARE, FARMERS_TOLD_SHARE, TOLD_LIVES_YEARS, EARLY_SPLIT_YEARS, FARMERS_TOLD,
        )),
        "settle": object(table!(settle:
            CARRYING_FULL, DENSITY_TAU, FORAGER_WEIGHT, LINKS, LINK_DAYS, SOURCE_RICH, SOURCE_DAYS,
            SOURCE_RADIUS, DECAY_DAYS, DRAW_LEAST, DRAW_MOST, DRAW_NONE, MAX_DAYS, TRADE_TOLD,
        )),
        "log": object(log),
        "catalog": without_notes(catalog),
    })
}

// The catalog without its `note`s, which say why and change no number.
fn without_notes(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .filter(|(k, _)| k != "note")
                .map(|(k, v)| (k, without_notes(v)))
                .collect::<Map<_, _>>(),
        ),
        Value::Array(items) => Value::Array(items.into_iter().map(without_notes).collect()),
        other => other,
    }
}

// Every leaf by its path (`simulation.SPAN_YEARS`, `catalog.plants.3.id`),
// its value as JavaScript prints it.
fn flatten(value: &Value, path: &str, out: &mut Vec<String>) {
    let join = |key: &str| {
        if path.is_empty() {
            key.to_string()
        } else {
            format!("{path}.{key}")
        }
    };
    match value {
        Value::Object(map) => map.iter().for_each(|(k, v)| flatten(v, &join(k), out)),
        Value::Array(items) => items
            .iter()
            .enumerate()
            .for_each(|(k, v)| flatten(v, &join(&k.to_string()), out)),
        Value::Number(n) => {
            let x = n.as_f64().expect("a finite number");
            let mut buffer = ryu_js::Buffer::new();
            out.push(format!("{path}={}", buffer.format(x)));
        }
        Value::String(s) => out.push(format!("{path}={s}")),
        Value::Bool(b) => out.push(format!("{path}={b}")),
        Value::Null => out.push(format!("{path}=null")),
    }
}

// world/identity.ts hashBytes: FNV-1a over the little-endian words, two
// seeds and primes, the tail's bytes folded in after.
fn hash_bytes(bytes: &[u8], seed_a: u32, seed_b: u32) -> (u32, u32) {
    let (mut a, mut b) = (seed_a, seed_b);
    let words = bytes.len() / 4;
    for w in 0..words {
        let word = u32::from_le_bytes(bytes[4 * w..4 * w + 4].try_into().unwrap());
        a = (a ^ word).wrapping_mul(0x0100_0193);
        b = (b ^ word).wrapping_mul(0x0000_0095);
    }
    for &byte in &bytes[4 * words..] {
        a = (a ^ byte as u32).wrapping_mul(0x0100_0193);
        b = (b ^ byte as u32).wrapping_mul(0x0000_0095);
    }
    (a, b)
}

/// The incubator's version: `v<INCUBATOR_ALGO_VERSION>-` and the hash of the
/// tuning's leaves, `path=value` sorted and `|`-joined, as
/// derivePipelineVersion hashes the pipeline's constants.
pub fn incubator_version() -> String {
    let mut leaves = Vec::new();
    flatten(&constants(), "", &mut leaves);
    leaves.sort();
    let (a, b) = hash_bytes(leaves.join("|").as_bytes(), 0x811c_9dc5, 0x9e37_79b9);
    format!("v{INCUBATOR_ALGO_VERSION}-{a:08x}{b:08x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    // What is format, not tuning: codes and the order of fields the client
    // shares. A change to them is INCUBATOR_ALGO_VERSION's.
    const FORMAT: &[&str] = &[
        "CELL_ECOLOGY",
        "GAME",
        "CARRYING",
        "ARABLE",
        "PASTURE",
        "FISH",
        "COPPER",
        "RIVER_EPHEMERAL",
        "CAME_NEVER",
        "NONE",
        "FORAGERS",
        "FISHERS",
        "HERDERS",
        "FARMERS",
        "GOODS",
        "POPULATION_MARKS",
        "LANGUAGE",
        "INCUBATOR_ALGO_VERSION",
    ];

    // Every constant of the modules is in the table or is format: one
    // added and left out would change runs without changing the version.
    #[test]
    fn every_constant_is_tuning_or_format() {
        let sources = [
            ("climate", include_str!("climate_history.rs")),
            ("habitat", include_str!("habitat.rs")),
            ("niche", include_str!("niche.rs")),
            ("travel", include_str!("travel.rs")),
            ("peopling", include_str!("peopling.rs")),
            ("simulation", include_str!("simulation.rs")),
            ("peoples", include_str!("peoples.rs")),
            ("settle", include_str!("settle.rs")),
            ("log", include_str!("log.rs")),
            ("flora", include_str!("flora.rs")),
            ("history", include_str!("history.rs")),
            ("catalog", include_str!("catalog.rs")),
            ("pack", include_str!("pack.rs")),
        ];
        let table = constants();
        for (module, source) in sources {
            for line in source.lines() {
                let line = line.trim_start();
                let Some(rest) = ["pub(crate) const ", "pub const ", "const "]
                    .iter()
                    .find_map(|p| line.strip_prefix(p))
                else {
                    continue;
                };
                if rest.starts_with("fn ") {
                    continue;
                }
                let name = rest.split(':').next().unwrap().trim();
                if FORMAT.contains(&name) {
                    continue;
                }
                assert!(
                    table.get(module).and_then(|m| m.get(name)).is_some(),
                    "{module}::{name} is neither in the tuning table nor format"
                );
            }
        }
    }

    #[test]
    fn the_hash_is_the_clients() {
        // world/identity.ts hashBytes on "a=1|b=2" (Node, 2026-10-27).
        assert_eq!(
            hash_bytes(b"a=1|b=2", 0x811c_9dc5, 0x9e37_79b9),
            (0x01d3_77a5, 0xb43d_30ed)
        );
    }
}
