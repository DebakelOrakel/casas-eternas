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
}
