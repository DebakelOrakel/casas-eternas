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
//!   proportion: the shelf to that depth is land. SEA_DROP_M is the
//!   default; step 1's control, the lowest sea level (2026-10-30,
//!   peopling.rs `Controls`), sets another depth (`with_sea_low`). The
//!   curve's shape does not change, only its depth in metres;
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
//!
//! THE REBOUND (2026-10-31, TEG-22; the post-glacial rebound): the ice
//! pushes the crust down, and the crust comes up again slowly after the
//! ice melts. The ice is thickest far inside its margin: a cell `ice_km`
//! from today's glaciers, under an ice that reaches ICE_REACH_KM × cold,
//! carries ice of sqrt(ICE_PROFILE_M × the km to the margin in m) (the
//! plastic ice sheet's profile). The crust sinks toward ICE_SINK of that
//! thickness and follows it with the time constant REBOUND_YEARS, after
//! the ice and before it (`Rebound`). The depression is below today's
//! crust: today it is 0. A cell sunk below the sea of its time is sea
//! (peopling.rs `dry_at`, simulation.rs THE CLIMATE): where the ice
//! melts, the sea comes into the land it freed, and the land comes up out
//! of it over some thousands of years, as the Baltic's and Hudson Bay's
//! coasts did. Only the ice's cells sink (`ice_may_cover`, within
//! ICE_REACH_KM): no sinking beyond the margin and no peripheral bulge.
//! The chronicle tells the big floods and risings (simulation.rs THE
//! REBOUND'S COASTS); the incubator's map draws the sunk land as sea at
//! the time shown (`flooded_runs`).

use crate::habitat::Habitat;
use crate::simulation::{CLIMATE_YEARS, SPAN_YEARS, ice_distance};
use casas_generator::climate::koppen::KOPPEN_CODES;
use casas_generator::core::det_math::{det_cos, det_exp, det_pow, det_sin};
use casas_generator::core::js;
use casas_generator::core::rng::Mulberry32;
use std::f64::consts::PI;

pub const SEA_DROP_M: f64 = 120.0;
pub(crate) const STADIALS: usize = 4;
// THE STABLE WARMTH (2026-10-29, step 2's times against the earth's,
// docs/design/prehistory-in-three-steps.md). The curve is the sea's and
// the ice's: on the earth the warmth came before the sea. The Holocene
// began 11 700 years ago with the sea near −60 m, the farming some 150
// years later with it near −50 m, step 2's start (from memory, not
// verified; DES-0035 has the farming's date). So the warmth is stable
// when the curve is under 0.5 (the sea above −60 m) and was so 1 000 years
// before: two climate steps, as the cosine melt is no step as the
// Younger Dryas's end was. 0.15 and 2 000 until then (the sea above
// −18 m): stable at +4 500, +3 500 and +4 500 after step 2's start on
// Morvane, Thalassor and Zephyra, and the first farming at once after it
// (the knowledge and the settled years were met from +1 500), at +3 500
// to +8 000. Now stable at +500 on all three; the first farming waits on
// FARM_RATE's chance (simulation.rs), a median of +1 000, +1 500, +1 500
// over six origins each (500 … 6 000). At 0.5 and 500 the first farming
// fell on step 2's first step on two of the worlds: the start, not the
// climate, would set it.
pub(crate) const STABLE_COLD: f64 = 0.5;
pub(crate) const STABLE_YEARS: f64 = 1000.0;
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
// THE REBOUND. The earth's numbers:
// - The ice's profile: a perfectly plastic ice sheet on a flat bed has the
//   thickness H = sqrt(2 τ0 x / (ρi g)) at x from its margin (Nye 1952,
//   J. Glaciol. 2(12); Cuffey and Paterson 2010, The Physics of Glaciers,
//   4th ed., ch. 8). With the basal shear stress τ0 = 100 kPa (50 to
//   150 kPa for the ice sheets) and ρi = 917 kg/m³, 2 τ0 / (ρi g) = 22 m:
//   ICE_PROFILE_M. At 400 km from the margin (ICE_REACH_KM at cold 1) the
//   ice is some 3 000 m thick, as the Laurentide and the Fennoscandian
//   ice at their centres (some 3 000 m; Peltier 2004, Annu. Rev. Earth
//   Planet. Sci. 32, ICE-5G).
// - The depression in isostatic equilibrium: ρi / ρm of the ice's
//   thickness, with the mantle's density ρm = 3 300 kg/m³ (Turcotte and
//   Schubert 2002, Geodynamics, 2nd ed., ch. 6): 917 / 3 300 = 0.28, some
//   a third: ICE_SINK. Under 3 000 m of ice, 830 m.
// - The time constant: the uplift after the melt falls about as
//   exp(−t / τ), with τ some 3 400 years in the southeast of Hudson Bay
//   and 4 200 years in the Gulf of Bothnia (Peltier 2004; Mitrovica and
//   Peltier 1995, Geophys. J. Int. 122, read the Hudson Bay records the
//   same way; the values from Peltier 2004 as cited, not verified in the
//   paper itself): REBOUND_YEARS 4 000. The crust lags the ice the same
//   way when it grows.
// - What follows on the earth: the highest shoreline at the Höga Kusten
//   (Sweden) stands 286 m above today's sea (UNESCO World Heritage 898,
//   2000), and the sea over southeast Hudson Bay fell some 250 m in the
//   last 9 000 years (Peltier 2004); both still rise some 10 mm a year
//   (Sella et al. 2007, Geophys. Res. Lett. 34, L02306; from memory, not
//   verified).
// The ice's margin is ICE_REACH_KM × cold from today's glaciers (simulation.rs
// `ice_distance`); a cell sinks by the ice over it, not by its
// neighbours' (no flexure). The depression is kept every CLIMATE_YEARS
// (`Rebound::of`'s `step`) by the km from today's glaciers, km by km.
pub(crate) const ICE_PROFILE_M: f64 = 22.0;
pub(crate) const ICE_SINK: f64 = 0.28;
pub(crate) const REBOUND_YEARS: f64 = 4000.0;

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
    // The sea's drop at cold 1, m (SEA_DROP_M unless `with_sea_low`).
    sea_low_m: f64,
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
            sea_low_m: SEA_DROP_M,
        }
    }

    /// The same curve with the sea `m` metres lower at cold 1.
    pub fn with_sea_low(mut self, m: f64) -> Self {
        self.sea_low_m = m;
        self
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
        self.sea_low_m * self.cold(t)
    }

    /// Whether the climate has been warm and calm for STABLE_YEARS by `t`.
    pub fn stable(&self, t: f64) -> bool {
        self.cold(t) < STABLE_COLD && self.cold(t - STABLE_YEARS) < STABLE_COLD
    }
}

/// The crust's depression under the ice and after it (THE REBOUND), m
/// below today's, by the km from today's glaciers (0 … ICE_REACH_KM, km by
/// km) and the time (every `step` years from 0).
pub struct Rebound {
    step: f64,
    // A row a `step`, ICE_REACH_KM + 1 values a row.
    rows: Vec<f32>,
    bins: usize,
}

impl Rebound {
    /// The depression from 0 to `span` years every `step`: at 0 in
    /// equilibrium with the ice, then toward it with REBOUND_YEARS, the
    /// ice of each `step` at its middle.
    pub fn of(history: &ClimateHistory, span: f64, step: f64) -> Self {
        let samples = (span / step).ceil() as usize + 1;
        let bins = ICE_REACH_KM as usize + 1;
        // The equilibrium at the cold `c`, `km` from today's glaciers.
        let settled = |c: f64, km: f64| -> f64 {
            let inside_km = ICE_REACH_KM * c - km;
            if inside_km <= 0.0 {
                0.0
            } else {
                ICE_SINK * (ICE_PROFILE_M * inside_km * 1000.0).sqrt()
            }
        };
        let keep = det_exp(-step / REBOUND_YEARS);
        let mut rows = vec![0f32; samples * bins];
        let c0 = history.cold(0.0);
        let mut now: Vec<f64> = (0..bins).map(|km| settled(c0, km as f64)).collect();
        for k in 0..samples {
            if k > 0 {
                let c = history.cold((k as f64 - 0.5) * step);
                for (km, d) in now.iter_mut().enumerate() {
                    let goal = settled(c, km as f64);
                    *d = goal + (*d - goal) * keep;
                }
            }
            for (km, &d) in now.iter().enumerate() {
                rows[k * bins + km] = d as f32;
            }
        }
        Rebound { step, rows, bins }
    }

    /// The depression at `t` (the last `step` at or before it) of a cell
    /// `ice_km` from today's glaciers, m; 0 beyond ICE_REACH_KM.
    pub fn depression_m(&self, ice_km: f64, t: f64) -> f64 {
        if ice_km.is_nan() || ice_km > ICE_REACH_KM {
            return 0.0;
        }
        let bins = self.bins;
        let samples = self.rows.len() / bins;
        let k = ((js::max(0.0, t) / self.step).floor() as usize).min(samples - 1);
        let row = &self.rows[k * bins..(k + 1) * bins];
        let lo = ice_km.floor() as usize;
        let hi = (lo + 1).min(bins - 1);
        let f = ice_km - lo as f64;
        row[lo] as f64 + (row[hi] as f64 - row[lo] as f64) * f
    }

    /// Whether a cell is under the sea at `t` by its depression: land of
    /// `height_m` above today's sea, or a shelf `-height_m` deep, with the
    /// sea `drop_m` below today's.
    pub fn sunk(&self, ice_km: f64, height_m: f64, drop_m: f64, t: f64) -> bool {
        height_m - self.depression_m(ice_km, t) < -drop_m
    }

    /// Whether a land cell is open sea at `t` by its depression: sunk,
    /// and not under the ice, which reaches `reach_km` from today's
    /// glaciers then (`cold_share`'s rule). The chronicle's floods and
    /// risings (simulation.rs THE REBOUND'S COASTS) and the map's sea
    /// (`flooded_runs`) are this.
    pub fn flooded(&self, ice_km: f64, height_m: f64, reach_km: f64, drop_m: f64, t: f64) -> bool {
        ice_km > reach_km && self.sunk(ice_km, height_m, drop_m, t)
    }

    /// When each of `cells` ([cell, its km from today's glaciers, its
    /// height above today's sea in m]) is open sea by its depression
    /// (`flooded`), every `step` from 0 as the simulation takes it: [cell,
    /// from, to] a run, years (to: the first `step` it is not), in the
    /// order they end. For the incubator's map.
    pub fn flooded_runs(&self, history: &ClimateHistory, cells: &[(usize, f64, f64)]) -> Vec<i32> {
        let samples = self.rows.len() / self.bins;
        let mut from = vec![-1i64; cells.len()];
        let mut runs = Vec::new();
        for k in 0..=samples {
            let t = k as f64 * self.step;
            let (reach, drop) = (ICE_REACH_KM * history.cold(t), history.sea_drop_m(t));
            for (c, &(cell, ice_km, height_m)) in cells.iter().enumerate() {
                let now = k < samples && self.flooded(ice_km, height_m, reach, drop, t);
                if now && from[c] < 0 {
                    from[c] = k as i64;
                } else if !now && from[c] >= 0 {
                    runs.extend([cell as i32, (from[c] as f64 * self.step) as i32, t as i32]);
                    from[c] = -1;
                }
            }
        }
        runs
    }
}

/// When the land the ice pushed down is open sea on a habitat (`Rebound::
/// flooded_runs`), with `seed`'s climate and the sea `sea_low_m` lower at
/// cold 1, every CLIMATE_YEARS as step 1 and the history take it: the
/// land's cells the ice may cover (peopling.rs `dry_at`).
pub fn flooded_runs(h: &Habitat, seed: f64, sea_low_m: f64) -> Vec<i32> {
    let history = ClimateHistory::of(seed, SPAN_YEARS).with_sea_low(sea_low_m);
    let rebound = Rebound::of(&history, SPAN_YEARS, CLIMATE_YEARS);
    let ice_km = ice_distance(h);
    let cells: Vec<(usize, f64, f64)> = (0..h.count)
        .filter(|&i| h.land[i] != 0 && ice_may_cover(h.koppen[i]) && ice_km[i] < f32::INFINITY)
        .map(|i| (i, ice_km[i] as f64, h.height_m[i] as f64))
        .collect();
    rebound.flooded_runs(&history, &cells)
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

/// Whether a class is a desert (BW): no farming centre there
/// (simulation.rs CENTRE_ARABLE).
pub fn is_desert(koppen: u8) -> bool {
    KOPPEN_CODES
        .get(koppen as usize)
        .is_some_and(|c| c.starts_with("BW"))
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
    fn the_crust_sinks_under_the_ice_and_comes_up_after_it() {
        for seed in 0..50 {
            let history = ClimateHistory::of(seed as f64, 100_000.0);
            let rebound = Rebound::of(&history, 100_000.0, 500.0);
            let melted = history.max_at + history.deglaciation;
            // Deepest near today's glaciers; none beyond the ice's reach.
            let deep = rebound.depression_m(0.0, history.max_at);
            assert!(deep > 300.0 && deep < ICE_SINK * 3000.0, "{deep}");
            assert!(rebound.depression_m(200.0, history.max_at) < deep);
            assert_eq!(rebound.depression_m(f64::INFINITY, history.max_at), 0.0);
            assert_eq!(
                rebound.depression_m(ICE_REACH_KM + 1.0, history.max_at),
                0.0
            );
            // Still down when the ice is gone, then up with REBOUND_YEARS.
            let at_melt = rebound.depression_m(0.0, melted);
            assert!(at_melt > 0.1 * deep, "{at_melt} of {deep}");
            let later = rebound.depression_m(0.0, melted + REBOUND_YEARS);
            assert!((later / at_melt - det_exp(-1.0)).abs() < 0.05);
            // Land 50 m high near the glaciers is sea at the melt, land later.
            assert!(rebound.sunk(0.0, 50.0, 0.0, melted));
            assert!(!rebound.sunk(0.0, 50.0, 0.0, melted + 5.0 * REBOUND_YEARS));
        }
    }

    #[test]
    fn the_runs_are_the_flooded_steps() {
        for seed in 0..20 {
            let history = ClimateHistory::of(seed as f64, 100_000.0);
            let rebound = Rebound::of(&history, 100_000.0, 500.0);
            let cells = [(0, 50.0, 50.0), (1, 150.0, 20.0), (2, 600.0, 0.0)];
            let runs = rebound.flooded_runs(&history, &cells);
            let samples = rebound.rows.len() / rebound.bins;
            for &(cell, ice_km, height_m) in &cells {
                for k in 0..samples {
                    let t = k as f64 * 500.0;
                    let want = rebound.flooded(
                        ice_km,
                        height_m,
                        ICE_REACH_KM * history.cold(t),
                        history.sea_drop_m(t),
                        t,
                    );
                    let got = runs
                        .chunks(3)
                        .any(|r| r[0] == cell as i32 && r[1] as f64 <= t && t < r[2] as f64);
                    assert_eq!(want, got, "seed {seed} cell {cell} at {t}");
                }
            }
            // The low land near the glaciers floods once the ice left it;
            // beyond the ice's reach none does.
            assert!(runs.chunks(3).any(|r| r[0] == 0));
            assert!(!runs.chunks(3).any(|r| r[0] == 2));
        }
    }

    #[test]
    fn the_land_dries_from_the_pole_side_after_step_2s_start() {
        use casas_generator::climate::koppen::koppen_id;
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
