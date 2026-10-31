//! The incubator's tuning and its version, as the engine has them
//! (`casas_generator_api::pipeline::constants`, world/identity.ts
//! derivePipelineVersion): every constant a run's numbers depend on, by
//! module, and the catalog (`data/catalog.json`); the version
//! `v<INCUBATOR_ALGO_VERSION>-<hash of them>`. A change to a constant or to
//! the catalog gives another version by itself; a change to the code that
//! changes what a run gives, or to the packed form, raises
//! INCUBATOR_ALGO_VERSION by hand. `make engine` writes both to
//! `dist/incubator/` (constants.json, version.json).

use crate::{
    climate_history, eruptions, habitat, language, languages, log, name_contact, niche, peoples,
    peopling, place_names, settle, simulation, travel,
};
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
/// arrays and the other events the same bytes; the land drying
/// (simulation.rs THE LAND DRYING, 2026-10-29), its event in the log;
/// step 2's times toward the earth's (2026-10-29: STABLE_COLD,
/// STABLE_YEARS, COPPER_VILLAGE_YEARS, SMELT_AFTER), the tuning alone;
/// COPPER_RICH 0.5 for the generator's new copper (DEC-0053, 2026-10-29),
/// the tuning alone; step 2's times on the generator's v15 ecology
/// (2026-10-29: COPPER_DAYS, TOWN_SHARE, SMELT_SHARE), the tuning alone;
/// the fronts of the fields, the herds, the copper and the smelting at
/// their km a year (simulation.rs THE FRONTS' TIMES, 2026-10-29: one cell
/// a step before); the peoples without the stripes again (peoples.rs
/// `Traits::decide`, `kin_of`, 2026-10-29: the nearest farmer heart, and
/// the fields around), the other arrays and events the same bytes; where
/// the far trade's goods came from (settle.rs `Goods`, 2026-10-30), four
/// arrays after the peoples, the other arrays the same bytes; step 1's
/// controls, the reach over sea and the lowest sea level (peopling.rs
/// `Controls`, 2026-10-30), part of H1's input: their defaults give the
/// same bytes; a dry shelf carries what level 1's ecology gives it with
/// the shelf as land, not what its coast carries (simulation.rs
/// `ground_of`, TEG-13, 2026-10-30); the origin when none is given on
/// the landmass from which step 1 reaches the most land (history.rs
/// `origin_of`, TEG-7, 2026-10-31); the post-glacial rebound: the land
/// the ice pushed down is sea until it comes up again, in step 1 and step
/// 2 (climate_history.rs THE REBOUND, TEG-22, 2026-10-31); the log tells
/// where the sea floods the land the ice left and where it rises again
/// (simulation.rs THE REBOUND'S COASTS, `SeaFloodsIce` and `LandRises`,
/// TEG-22, 2026-10-31); the peoples' waves, and movers who
/// carry their traits into a lived cell (peoples.rs THE WAVES, TEG-14,
/// 2026-10-31), the other arrays and events the same bytes; a people the
/// waves took most of told as replaced, not merged (peoples.rs
/// `Tree::tell`, `PeopleReplaced`, TEG-14, 2026-10-31), a new kind of the
/// log, the arrays the same bytes;
/// the large eruptions (eruptions.rs,
/// simulation.rs THE ERUPTIONS, TEG-131, 2026-10-31) from level 1's
/// volcanoes, their events in the log (a reader that does not know the
/// new kinds passes over them): a world without volcanoes gives the same
/// bytes; step 2 on the v15 ecology again (TEG-10, 2026-10-31): the
/// fields spread where a cell's best share of arable land reaches
/// FARM_ARABLE, not its mean (habitat.rs `arable_best`), no farming
/// centre in a desert (BW), and the first city at CITY_LATEST_YEARS at
/// the latest (simulation.rs THE LATEST CITY); in a short step 2 the
/// chronicle tells the splits and merges that held to its end and
/// TOLD_SPAN_SHARE of it (peoples.rs `Tree::finish`, TEG-11), a long one
/// the same events; in a desert (BW) the crops suit a cell whose best
/// arable share reaches FARM_ARABLE (simulation.rs THE FLOODED DESERT),
/// and the latest city is a town of CITY_LATEST_PEOPLE or more, else
/// none (simulation.rs THE LATEST CITY); the languages' tree (languages.rs,
/// TEG-138, 2026-10-31): a family for each of step 1's groups, a language
/// where a people lived apart long enough and was big, a dialect for each
/// big people, with their dated sound changes and new words, packed after
/// the goods (the other arrays the same bytes), their arising and their
/// end in the log (new kinds, which a reader that does not know them
/// passes over); since the history reads it, the language kit
/// (`data/language/`, without its notes) and the language core's
/// constants are part of the version; the names of the places as recipes
/// (place_names.rs, TEG-139, 2026-10-31): the villages, the rivers, the
/// mountains, the lakes and the landmasses named by their peoples, packed
/// after the languages (the other arrays and the log the same bytes); the
/// other names (name_contact.rs, TEG-142, TEG-143, 2026-10-31): the old
/// names where another people took a place (kept as a loan or renamed)
/// and the exonyms between the peoples in contact at the end, packed
/// after the names (the other arrays and the log the same bytes); the
/// made names tuned (TEG-146, 2026-10-31): roots of two sounds or more
/// with no like syllables side by side and fewer repeated consonants, a
/// name's syllables and sounds capped, the core meanings take new words
/// at half the rate of the others, sound changes twice as often, the link
/// sounds follow the sound changes, a name's own word and a new word go
/// through the line's changes, no letter three times in a row; the
/// languages', the names' and the other names' arrays other, the other
/// arrays and the log the same bytes.
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

/// The tuning by module, the catalog and the language kit: `{ climate,
/// eruptions, habitat, niche, travel, peopling, simulation, peoples,
/// language, languages, names, settle, log, catalog, kit }`.
pub fn constants() -> Value {
    let catalog: Value =
        serde_json::from_str(include_str!("../data/catalog.json")).expect("data/catalog.json");
    let read = |name: &str, text: &str| -> Value {
        without_notes(
            serde_json::from_str(text).unwrap_or_else(|e| panic!("data/language/{name}: {e}")),
        )
    };
    let kit = json!({
        "sounds": read("sounds.json", include_str!("../data/language/sounds.json")),
        "inventories": read("inventories.json", include_str!("../data/language/inventories.json")),
        "syllables": read("syllables.json", include_str!("../data/language/syllables.json")),
        "changes": read("changes.json", include_str!("../data/language/changes.json")),
        "meanings": read("meanings.json", include_str!("../data/language/meanings.json")),
        "spelling": read("spelling.json", include_str!("../data/language/spelling.json")),
        "patterns": read("patterns.json", include_str!("../data/language/patterns.json")),
    });
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
            COLD_SPELLS_MOST, COLD_SPELL_YEARS, COLD_SPELL_COLD, COLD_SPELL_DRY, COLD_SPELL_FROM, COLD_SPELL_TO,
            DRYING_LAT_FROM, DRYING_LAT_TO, DRYING_FROM, DRYING_TO, DRYING_LAG_YEARS, DRYING_FAST_YEARS, DRYING_SLOW_YEARS,
            HUMID_DESERT_CARRYING, HUMID_DESERT_PASTURE, HUMID_STEPPE_CARRYING, HUMID_STEPPE_PASTURE,
            ICE_PROFILE_M, ICE_SINK, REBOUND_YEARS)),
        "eruptions": object(table!(eruptions:
            EARTH_VEI6_YEARS, EARTH_VEI7_YEARS, EARTH_VEI8_YEARS, EARTH_EXPLOSIVE, EARTH_FISSURE_YEARS, EARTH_EFFUSIVE,
            ASH_LOSS, ASH_KM_VEI6, ASH_KM_VEI7, ASH_KM_VEI8, ASH_YEARS_VEI6, ASH_YEARS_VEI7, ASH_YEARS_VEI8,
            COLD_VEI7, COLD_YEARS_VEI7, COLD_VEI8, COLD_YEARS_VEI8, FISSURE_KM, FISSURE_LOSS, FISSURE_YEARS,
            ERUPTION_TOLD_PEOPLE, FISSURE_TOLD_SHARE,
        )),
        "habitat": object(table!(habitat: CELL_SPACING_KM)),
        "niche": object(table!(niche: SUITABLE, BARRIER, SPREAD_KM, ORIGIN_AREA_KM2, OFF_COVER, BIG_RIVER)),
        "travel": object(table!(travel: WALK_HOURS, RIVER_BOAT_SIZE, RIVER_DOWN_KM_DAY, RIVER_UP_KM_DAY, COAST_DEPTH_M, COAST_KM_DAY, LANDING_DAYS)),
        "peopling": object(table!(peopling: REACH_START_KM, REACH_END_KM, SEA_KM_A, CROSSING_YEARS, GROUP_SHARE, END_SEA_DROP_M, ORIGIN_LANDMASS_KM2)),
        "simulation": object(table!(simulation:
            SPAN_YEARS, KEEP_YEARS, POPULATION_STEP, STEP_YEARS, PEOPLE_FRAME_STEP, CAME_STEP, SETTLE_AFTER, FISH_RICH,
            SUB_STEPS, FORAGER_DENSITY, CARRYING_FULL, GROWTH_A, SEED_SHARE, SEED_PEOPLE, FULL_SHARE,
            SPEED_MIN_KM_A, SPEED_MAX_KM_A, SLOPE_DRAG, CORRIDOR, SHELF_M, CLIMATE_YEARS, DROWNED_TOLD_KM2, DRYING_TOLD_KM2, REBOUND_TOLD_KM2, GAME_STEPS,
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
            TOWN_GROWTH_A, CITY_PEOPLE, CITY_LATEST_YEARS, CITY_LATEST_PEOPLE,
        )),
        "peoples": object(table!(peoples:
            TRAITS, BRANCH_SHARE, BRANCH_ROUNDS, BRANCH_STEP, TRAIT_DRIFT, LANGUAGE_DRIFT, TRAIT_CONTACT, LANGUAGE_CONTACT,
            CONTACT_DAYS, TRAIT_LIKE, PEOPLE_DISTANCE, REPLACE_SHARE, FIELDS_AROUND, FIELDS_AROUND_KM, SPLIT_KM2, WAVE_RATIO, WAVE_CHANCE, WAVE_KM_A,
            PEOPLE_LEAST, PEOPLE_LEAST_KM2, SPLIT_TOLD_SHARE, FARMERS_TOLD_SHARE, TOLD_LIVES_YEARS, EARLY_SPLIT_YEARS, TOLD_SPAN_SHARE, FARMERS_TOLD,
        )),
        "language": object(table!(language:
            LEXICON_SHARE, HOMOPHONE_TRIES, IMPLICATION_ROUNDS, WORD_LENGTH_SHIFT, WORD_LENGTH_SHORT, WORD_LENGTH_LONG,
            JOINER_ALWAYS, PEOPLE_PREFIX, ENDING_TRIES, FIT_STEPS, WORD_LEAST_SOUNDS, REPEAT_DAMP,
            NAME_SYLLABLES_MOST, WORD_SYLLABLES_MOST, WORD_SOUNDS_MOST, NAME_TRIES_LENGTH,
        )),
        "languages": object(table!(languages:
            LANGUAGE_APART_YEARS, LANGUAGE_SHARE, CENTURY_YEARS, SOUND_CHANGE_CHANCE, WORD_LOSS_CHANCE,
            CORE_WORD_LOSS_CHANCE, CHANGE_TRIES, CHANGE_LEAST_WORDS, DIALECT_CHANGES_LEAST, DIALECT_CHANGES_MOST,
        )),
        "names": object(table!(place_names:
            RIVER_LEAST_CELLS, LAKE_LEAST_CELLS, MOUNTAIN_LEAST_M, MOUNTAIN_LEAST_CELLS, MOUNTAINS_A_LANDMASS,
            LANDMASS_LEAST_KM2, HILL_SLOPE, HIGH_M, SNOW_M, BIG_RIVER_SIZE, BIG_LAKE_CELLS, BIG_LANDMASS_KM2,
            MARKET_PEOPLE, NAME_TRIES, BOOK_SPEECHES,
        )),
        "contact": object(table!(name_contact:
            TAKING_HOLD_YEARS, KEEP_RIVER, KEEP_LANDMASS, KEEP_TOWN, KEEP_LAKE, KEEP_MOUNTAIN, KEEP_VILLAGE,
            KEEP_TOWN_PEOPLE, HEAD_AGAIN, CONTACT_BORDER_KM, CONTACT_LINKS, CONTACT_FAR_DAYS, BORROW_NEAR,
            BORROW_FAR, TRANSLATE_SHARE, EXONYM_VILLAGES, EXONYM_RIVERS, EXONYM_MOUNTAINS, EXONYM_LAKES,
            EXONYM_LANDMASSES,
        )),
        "settle": object(table!(settle:
            CARRYING_FULL, DENSITY_TAU, FORAGER_WEIGHT, LINKS, LINK_DAYS, SOURCE_RICH, SOURCE_DAYS,
            SOURCE_RADIUS, DECAY_DAYS, DRAW_LEAST, DRAW_MOST, DRAW_NONE, MAX_DAYS, TRADE_TOLD,
        )),
        "log": object(log),
        "catalog": without_notes(catalog),
        "kit": kit,
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
        // The language core's tables of letters and of the notation's
        // fields (spelling.rs, notation.rs), and Kind's list.
        "MACRON",
        "ACUTE",
        "CIRCUMFLEX",
        "TILDE",
        "TEXT_FIELDS",
        "SERIES",
        "BOOLS",
        "ALL",
        // The packed names' mark of an empty slot, the codes of how a name
        // came, of a loan and between its words (place_names.rs).
        "NO_MEANING",
        "FIRST",
        "RENAMED",
        "KEPT",
        "BORROWED",
        "TRANSLATED",
        "OWN",
        "SET",
        "LOAN",
        "WORD_BREAK",
    ];

    // Every constant of the modules is in the table or is format: one
    // added and left out would change runs without changing the version.
    #[test]
    fn every_constant_is_tuning_or_format() {
        let sources = [
            ("climate", include_str!("climate_history.rs")),
            ("eruptions", include_str!("eruptions.rs")),
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
            ("languages", include_str!("languages.rs")),
            ("names", include_str!("place_names.rs")),
            ("contact", include_str!("name_contact.rs")),
            ("language", include_str!("language/mod.rs")),
            ("language", include_str!("language/change.rs")),
            ("language", include_str!("language/draw.rs")),
            ("language", include_str!("language/inventory.rs")),
            ("language", include_str!("language/kit.rs")),
            ("language", include_str!("language/loan.rs")),
            ("language", include_str!("language/names.rs")),
            ("language", include_str!("language/notation.rs")),
            ("language", include_str!("language/spelling.rs")),
            ("language", include_str!("language/syllable.rs")),
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
