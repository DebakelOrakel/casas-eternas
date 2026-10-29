//! THE WORLD'S CLIMATE HISTORY (2026-10-26): the world's glacial cycle over
//! the people's span, drawn once from its seed — how cold it gets, when the
//! cold is deepest, how fast it ends — and what follows from it: the sea's
//! drop and so the land bridges, the ice's reach, what the cold leaves the
//! land. Step 1 of the prehistory (peopling.rs) runs on it, and the history
//! (simulation.rs) from where step 1 ends.
//!
//! THE CURVE, `cold` 0 … 1 (1: the earth's last glacial maximum): from a
//! middling cold at the span's start it deepens, with stadials (STADIALS
//! swings), to its maximum at `max_at` of the span; it ends over
//! `deglaciation` years, and the rest is warm and calm. THE WORLD'S
//! TIMELINE (2026-10-26, asked for): the start in year 0, the large
//! landmasses reached by some 40 000, the cold deepest at 40 … 55 % of the
//! span, a stable warmth from some 60 000, the first fields by 65 000 …
//! 70 000. The first form put the maximum at 76 … 86 %, as on the earth,
//! and so no farming before year 85 000.
//!
//! WHAT FOLLOWS:
//! - the sea stands SEA_DROP_M lower at cold 1 (the earth's −120 m), in
//!   proportion: the shelf to that depth is land;
//! - the ice grows out of today's glaciers over the cold climates (Köppen D
//!   and E), ICE_REACH_KM far at cold 1, in proportion (simulation.rs
//!   `ice_distance`): the ice sheets grew from their cores. 800 km at
//!   first; Morvane, half under ice today, was then shut for most of the
//!   cold. A first form closed the whole tundra from cold 0.5 and the
//!   subarctic from 0.8; on Morvane, cold and half under ice, that shut
//!   most of the world for most of the span, while the earth's glacial
//!   tundra was the mammoth steppe, lived in;
//! - the cold lowers what the land carries, the cold climates most (by the
//!   class's main group, `cold_share`), the dry ones by the cold's
//!   dryness;
//! - the climate is stable when it has stayed under STABLE_COLD for
//!   STABLE_YEARS: a condition of the farming and the herding.
//!
//! THE COLD SPELLS (2026-10-28, as the 8.2 ka event; docs/design/
//! earth-prehistory-sources.md): `cold_spells`, drawn from the seed apart
//! from the curve, 1 to COLD_SPELLS_MOST of them, each COLD_SPELL_YEARS
//! long, from COLD_SPELL_FROM to COLD_SPELL_TO years after step 2's start
//! (never before it: step 1, peopling.rs, does not see them). During one
//! the cold that lowers what the land carries is COLD_SPELL_COLD more (not
//! the sea's, not the ice's, not the stability's: 160 years move no ice
//! sheet), and the rain of the droughts COLD_SPELL_DRY less
//! (simulation.rs THE DROUGHTS).
//!
//! THE LAND DRYING (2026-10-29, as the African Humid Period's end;
//! docs/design/earth-prehistory-sources.md): the dry classes (Köppen B:
//! the deserts BW, the steppes BS) between DRYING_LAT_FROM and
//! DRYING_LAT_TO of latitude are a class wetter from step 2's start: the
//! desert carries and grazes about as a steppe, the steppe carries about
//! as a savanna (`humid_gain`). Their wetness (`wetness`) falls from 1 to
//! 0 once: at the belt's poleward edge from `drying_start` (drawn from the
//! seed, DRYING_FROM to DRYING_TO after step 2's start) within
//! DRYING_FAST_YEARS; toward its equatorward edge later (DRYING_LAG_YEARS
//! more) and slower (DRYING_SLOW_YEARS). simulation.rs THE LAND DRYING
//! applies it, the rivers' cells excepted.

use casas_engine::climate::koppen::KOPPEN_CODES;
use casas_engine::core::det_math::{det_cos, det_pow, det_sin};
use casas_engine::core::js;
use casas_engine::core::rng::Mulberry32;
use std::f64::consts::PI;

pub const SEA_DROP_M: f64 = 120.0;
pub(crate) const STADIALS: usize = 4;
pub(crate) const STABLE_COLD: f64 = 0.15;
pub(crate) const STABLE_YEARS: f64 = 2000.0;
pub const ICE_REACH_KM: f64 = 400.0;
// THE COLD SPELLS. The 8.2 ka event lasted 160.5 ± 5.5 years, some −1 °C
// and −20 % rain in parts of Europe (Thomas et al. 2007, Morrill et al.
// 2013: DES-0035). The curve's cold 1 is the earth's last glacial maximum,
// in Europe some 8 to 12 °C colder than today (from memory, not verified);
// so −1 °C is some 0.1 of it. At 0.1 what the land carries falls by
// `cold_share`'s loss × 0.1: 1 % (A) to 5 % (E), 2.5 % in the temperate
// (C) — mild, as the event was: the farmers of Southwest Asia show no
// collapse at it (Flohr et al. 2016). The spells come in steps of 25
// years (simulation.rs STEP_YEARS): 160 years are 7 steps, 175 years.
// On Morvane (v14, with its rain) two spells, at +6 750 and +7 525 after
// step 2's start: 117 famines in their 350 years (488 in the whole
// history of 24 500), 111 000 dead, one the chronicle tells, no village
// given up; the people 1.0 % fewer 500 years on than without the spells,
// 0.9 % 1 500 years on.
pub(crate) const COLD_SPELLS_MOST: usize = 2;
pub(crate) const COLD_SPELL_YEARS: f64 = 160.0;
pub(crate) const COLD_SPELL_COLD: f64 = 0.1;
pub(crate) const COLD_SPELL_DRY: f64 = -0.2;
pub(crate) const COLD_SPELL_FROM: f64 = 2000.0;
pub(crate) const COLD_SPELL_TO: f64 = 10_000.0;
// THE LAND DRYING. The belt: the subtropics' dry climates, 10° to 35°
// (the Sahara's humid period reached some 15° to 30° N; DES-0035 [44]–
// [47]). The start: the green Sahara ends near +6 000 on the earth's
// timeline (5.5 ka BP off Mauritania, ~20° N; the drying of the Eastern
// Sahara from c. 5 300 BC, +4 300): here 4 000 to 6 000 years after step
// 2's start. Abrupt at 20° N, near 2 000 years later at 6.5° N (Shanahan
// et al. 2015), the Sahara emptied over some 2 000 years from north to
// south (Kuper and Kröpelin 2006): so 200 years at the poleward edge, 2 000
// at the equatorward edge, which begins 2 000 years after it. The climate
// moves every CLIMATE_YEARS (500): the poleward edge dries in one of its
// steps, the equatorward edge in four or five.
// The gains, in the ecology's units (the carrying capacity's field, the
// pasture 0 … 1), from the classes' means in the belt on three worlds
// (2026-10-29; Morvane, Thalassor, Zephyra): the carrying capacity of BW
// 0.14 – 0.26, of BS 0.44 – 0.55, of Aw 0.56 – 0.73; the pasture of BW
// 0.15 – 0.35, of BS 0.56 – 0.74, of Aw 0.52 – 0.60. A desert gains what
// lifts it to a steppe (+0.3, +0.4); a steppe gains carrying capacity to a
// savanna's (+0.15) and no pasture: the generator's savanna has less
// pasture than its steppe.
pub(crate) const DRYING_LAT_FROM: f64 = 10.0;
pub(crate) const DRYING_LAT_TO: f64 = 35.0;
pub(crate) const DRYING_FROM: f64 = 4000.0;
pub(crate) const DRYING_TO: f64 = 6000.0;
pub(crate) const DRYING_LAG_YEARS: f64 = 2000.0;
pub(crate) const DRYING_FAST_YEARS: f64 = 200.0;
pub(crate) const DRYING_SLOW_YEARS: f64 = 2000.0;
pub(crate) const HUMID_DESERT_CARRYING: f64 = 0.3;
pub(crate) const HUMID_DESERT_PASTURE: f64 = 0.4;
pub(crate) const HUMID_STEPPE_CARRYING: f64 = 0.15;
pub(crate) const HUMID_STEPPE_PASTURE: f64 = 0.0;

struct Swing {
    period: f64,
    phase: f64,
    amplitude: f64,
}

pub struct ClimateHistory {
    // The draw, for a readout: when the cold was deepest, its depth, the
    // melt's years.
    pub max_at: f64,
    pub depth: f64,
    pub deglaciation: f64,
    start: f64,
    swings: Vec<Swing>,
}

impl ClimateHistory {
    pub fn of(seed: f64, span: f64) -> Self {
        let mut random = Mulberry32::new(js::to_uint32(seed) ^ 0xc11a7e);
        let max_at = span * (0.4 + 0.15 * random.next());
        let depth = 0.75 + 0.25 * random.next();
        let deglaciation = 6000.0 + 6000.0 * random.next();
        let start = 0.3 + 0.2 * random.next();
        let swings = (0..STADIALS)
            .map(|_| {
                let period = 6000.0 + 10_000.0 * random.next();
                let phase = 2.0 * PI * random.next();
                let amplitude = 0.06 + 0.08 * random.next();
                Swing {
                    period,
                    phase,
                    amplitude,
                }
            })
            .collect();
        ClimateHistory {
            max_at,
            depth,
            deglaciation,
            start,
            swings,
        }
    }

    /// The cold at `t`, 0 … 1.
    pub fn cold(&self, t: f64) -> f64 {
        if t <= self.max_at {
            let f = js::max(0.0, t / self.max_at);
            let mut c = self.start + (self.depth - self.start) * det_pow(f, 1.5);
            for s in &self.swings {
                // The stadials fade out toward the maximum, where the cold
                // holds.
                c += s.amplitude * (1.0 - f) * det_sin((2.0 * PI * t) / s.period + s.phase);
            }
            return js::max(0.0, js::min(1.0, c));
        }
        if t >= self.max_at + self.deglaciation {
            return 0.0;
        }
        // The melt: a smooth fall from the maximum to the warmth.
        self.depth * 0.5 * (1.0 + det_cos((PI * (t - self.max_at)) / self.deglaciation))
    }

    /// The sea's drop below today's at `t`, metres (≥ 0).
    pub fn sea_drop_m(&self, t: f64) -> f64 {
        SEA_DROP_M * self.cold(t)
    }

    /// Whether the climate has been warm and calm for STABLE_YEARS by `t`.
    pub fn stable(&self, t: f64) -> bool {
        self.cold(t) < STABLE_COLD && self.cold(t - STABLE_YEARS) < STABLE_COLD
    }
}

/// The cold spells' starts after `t0` (step 2's start), years, in time, on
/// whole `step`s, apart by COLD_SPELL_YEARS at least.
pub fn cold_spells(seed: f64, t0: f64, step: f64) -> Vec<f64> {
    let mut random = Mulberry32::new(js::to_uint32(seed) ^ 0xc01d_5e11);
    let count = 1 + js::min(
        (COLD_SPELLS_MOST - 1) as f64,
        (random.next() * COLD_SPELLS_MOST as f64).floor(),
    ) as usize;
    let mut starts: Vec<f64> = (0..count)
        .map(|_| {
            let at = t0 + COLD_SPELL_FROM + (COLD_SPELL_TO - COLD_SPELL_FROM) * random.next();
            (at / step).floor() * step
        })
        .collect();
    starts.sort_by(|a, b| a.partial_cmp(b).unwrap());
    for k in 1..starts.len() {
        let after = starts[k - 1] + (COLD_SPELL_YEARS / step).ceil() * step;
        starts[k] = js::max(starts[k], after);
    }
    starts
}

/// The cold a spell adds at `t` (COLD_SPELL_COLD within one, else 0).
pub fn spell_cold(starts: &[f64], t: f64) -> f64 {
    if starts.iter().any(|&s| t >= s && t < s + COLD_SPELL_YEARS) {
        COLD_SPELL_COLD
    } else {
        0.0
    }
}

/// The land drying's start after `t0` (step 2's start), years: at the
/// dry belt's poleward edge (THE LAND DRYING), drawn from the seed.
pub fn drying_start(seed: f64, t0: f64) -> f64 {
    let mut random = Mulberry32::new(js::to_uint32(seed) ^ 0xd2e5_a11d);
    t0 + DRYING_FROM + (DRYING_TO - DRYING_FROM) * random.next()
}

/// What the humid period adds to a class in the dry belt (`lat_deg`, its
/// latitude, degrees): (carrying capacity, pasture) in the ecology's
/// units; None for a class or a latitude it does not touch.
pub fn humid_gain(koppen: u8, lat_deg: f64) -> Option<(f64, f64)> {
    if !(DRYING_LAT_FROM..=DRYING_LAT_TO).contains(&lat_deg) {
        return None;
    }
    let code = KOPPEN_CODES.get(koppen as usize)?.as_bytes();
    match code {
        [b'B', b'W', ..] => Some((HUMID_DESERT_CARRYING, HUMID_DESERT_PASTURE)),
        [b'B', b'S', ..] => Some((HUMID_STEPPE_CARRYING, HUMID_STEPPE_PASTURE)),
        _ => None,
    }
}

/// The humid period's wetness at `t` at latitude `lat_deg` in the dry
/// belt, 1 … 0: from `start` (`drying_start`) at the poleward edge within
/// DRYING_FAST_YEARS; at the equatorward edge DRYING_LAG_YEARS later and
/// within DRYING_SLOW_YEARS; linear between.
pub fn wetness(start: f64, lat_deg: f64, t: f64) -> f64 {
    let f = js::max(
        0.0,
        js::min(
            1.0,
            (DRYING_LAT_TO - lat_deg) / (DRYING_LAT_TO - DRYING_LAT_FROM),
        ),
    );
    let from = start + DRYING_LAG_YEARS * f;
    let years = DRYING_FAST_YEARS + (DRYING_SLOW_YEARS - DRYING_FAST_YEARS) * f;
    js::max(0.0, js::min(1.0, 1.0 - (t - from) / years))
}

/// A Köppen class's main group letter, '\0' for none.
fn group(koppen: u8) -> u8 {
    KOPPEN_CODES
        .get(koppen as usize)
        .and_then(|c| c.bytes().next())
        .unwrap_or(0)
}

/// Whether the ice may grow over a class (the cold ones, D and E).
pub fn ice_may_cover(koppen: u8) -> bool {
    matches!(group(koppen), b'D' | b'E')
}

/// What a cell carries at a cold, as a share of today's: 0 under the ice
/// (`ice_km`: its distance from today's glaciers over the cold climates,
/// Infinity where the ice cannot come); `spell` the cold a spell adds to
/// the land's loss, not to the ice.
pub fn cold_share(koppen: u8, ice_km: f64, cold: f64, spell: f64) -> f64 {
    if ice_km <= ICE_REACH_KM * cold {
        return 0.0;
    }
    // What the cold takes of what the land carries, at cold 1, by the
    // class's main group (A tropical … E polar).
    let loss = match group(koppen) {
        b'A' => 0.1,
        b'B' => 0.3,
        b'C' => 0.25,
        b'D' => 0.4,
        b'E' => 0.5,
        _ => 0.2,
    };
    1.0 - loss * (cold + spell)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cold_spells_come_after_step_2s_start() {
        for seed in 0..200 {
            let t0 = 55_000.0;
            let starts = cold_spells(seed as f64, t0, 25.0);
            assert!((1..=COLD_SPELLS_MOST).contains(&starts.len()));
            assert_eq!(starts, cold_spells(seed as f64, t0, 25.0));
            for (k, &s) in starts.iter().enumerate() {
                assert!(s >= t0 + COLD_SPELL_FROM && s % 25.0 == 0.0);
                if k > 0 {
                    assert!(s >= starts[k - 1] + COLD_SPELL_YEARS);
                }
            }
            assert_eq!(spell_cold(&starts, t0), 0.0);
            assert_eq!(spell_cold(&starts, starts[0]), COLD_SPELL_COLD);
        }
    }

    #[test]
    fn the_land_dries_from_the_pole_side_after_step_2s_start() {
        use casas_engine::climate::koppen::koppen_id;
        let t0 = 55_000.0;
        for seed in 0..200 {
            let s = drying_start(seed as f64, t0);
            assert!(s >= t0 + DRYING_FROM && s < t0 + DRYING_TO);
            assert_eq!(s, drying_start(seed as f64, t0));
        }
        let s = t0 + 5000.0;
        // Wet at step 2's start, dry at the end, falling in time.
        for lat in [10.0, 20.0, 35.0] {
            assert_eq!(wetness(s, lat, t0), 1.0);
            assert_eq!(
                wetness(s, lat, s + DRYING_LAG_YEARS + DRYING_SLOW_YEARS),
                0.0
            );
            let mut was = 1.0;
            for k in 0..100 {
                let w = wetness(s, lat, s + 50.0 * k as f64);
                assert!(w <= was);
                was = w;
            }
        }
        // Abrupt at the poleward edge, later and slower toward the equator.
        assert_eq!(wetness(s, 35.0, s + DRYING_FAST_YEARS), 0.0);
        assert_eq!(wetness(s, 10.0, s + DRYING_LAG_YEARS), 1.0);
        assert!(wetness(s, 20.0, s + 1000.0) > wetness(s, 30.0, s + 1000.0));
        // The belt and its classes.
        assert!(humid_gain(koppen_id("BWh"), 20.0).is_some());
        assert!(humid_gain(koppen_id("BSk"), 34.0).is_some());
        assert!(humid_gain(koppen_id("BWh"), 40.0).is_none());
        assert!(humid_gain(koppen_id("BWh"), 5.0).is_none());
        assert!(humid_gain(koppen_id("Aw"), 20.0).is_none());
        assert!(humid_gain(0, 20.0).is_none());
    }
}
