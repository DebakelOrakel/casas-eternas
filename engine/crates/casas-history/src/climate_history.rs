//! `screens/incubator/climateHistory.ts`: the world's glacial cycle over the
//! people's span, drawn from its seed, and what follows from it — the sea's
//! drop, the ice's reach, what the cold leaves the land. The reasoning is in
//! the TypeScript file.

use casas_engine::climate::koppen::KOPPEN_CODES;
use casas_engine::core::det_math::{det_cos, det_pow, det_sin};
use casas_engine::core::js;
use casas_engine::core::rng::Mulberry32;
use std::f64::consts::PI;

const SEA_DROP_M: f64 = 120.0;
const STADIALS: usize = 4;
const STABLE_COLD: f64 = 0.15;
const STABLE_YEARS: f64 = 2000.0;
pub const ICE_REACH_KM: f64 = 400.0;

struct Swing {
    period: f64,
    phase: f64,
    amplitude: f64,
}

pub struct ClimateHistory {
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
                c += s.amplitude * (1.0 - f) * det_sin((2.0 * PI * t) / s.period + s.phase);
            }
            return js::max(0.0, js::min(1.0, c));
        }
        if t >= self.max_at + self.deglaciation {
            return 0.0;
        }
        self.depth * 0.5 * (1.0 + det_cos((PI * (t - self.max_at)) / self.deglaciation))
    }

    pub fn sea_drop_m(&self, t: f64) -> f64 {
        SEA_DROP_M * self.cold(t)
    }

    pub fn stable(&self, t: f64) -> bool {
        self.cold(t) < STABLE_COLD && self.cold(t - STABLE_YEARS) < STABLE_COLD
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

/// What a cell carries at a cold, as a share of today's.
pub fn cold_share(koppen: u8, ice_km: f64, cold: f64) -> f64 {
    if ice_km <= ICE_REACH_KM * cold {
        return 0.0;
    }
    let loss = match group(koppen) {
        b'A' => 0.1,
        b'B' => 0.3,
        b'C' => 0.25,
        b'D' => 0.4,
        b'E' => 0.5,
        _ => 0.2,
    };
    1.0 - loss * cold
}
