//! STEP 1 OF THE PREHISTORY (docs/design/prehistory-in-three-steps.md): the
//! old stone age as a reachability graph, not a simulation. From one or
//! more origins, the earliest time people can be in each cell, over the
//! span the world's glacial cycle gives (ClimateHistory) until the cold
//! ends, where step 2 begins.
//!
//! A search by time over all cells. Over dry ground the front moves at the
//! simulation's speeds (`ground_of`). The shelf is dry ground while the sea
//! is below it, the cold lands while the ice is away from them: a way that
//! is closed now is taken when it opens, so the front waits on its edge.
//! Over water people go by boat, as far over open sea (km out of sight of
//! any dry ground) as the time's reach, which grows from REACH_START_KM to
//! REACH_END_KM over the span; a crossing beyond the reach waits for it.
//! A landing after open sea costs time by how near the reach it went:
//! crossings at the limit of what boats can do are made rarely.
//!
//! Each cell keeps the cell it was reached from. Those links make a tree,
//! and the tree is the relationship of the groups: where two branches
//! part, two groups parted. A group begins where the tree forks into two
//! branches of GROUP_SHARE of the land reached or more, and where a
//! crossing lands people who settle that much: the large forks, not every
//! valley.
//!
//! Not in the tuning (`tuning.rs`) and not in H1 yet: a trial beside the
//! simulation, which it is meant to replace as step 1.

use crate::climate_history::{ClimateHistory, ICE_REACH_KM, ice_may_cover};
use crate::habitat::Habitat;
use crate::log::LogEvent;
use crate::simulation::{CLIMATE_YEARS, Ground, SPAN_YEARS, VOYAGE_KM, ground_of, ice_distance};
use casas_engine::core::min_heap::MinHeap;

/// The boats' reach over open sea at the span's start and end, km.
pub const REACH_START_KM: f64 = 30.0;
pub const REACH_END_KM: f64 = 450.0;
/// The front's speed over water, km a year: a coast is followed by boat
/// about as fast as it is walked along.
pub const SEA_KM_A: f64 = 1.0;
/// A landing after open sea as long as the reach costs this many years;
/// less in proportion.
pub const CROSSING_YEARS: f64 = 1000.0;
/// A branch of this share of the land cells reached, or more, is a group
/// of its own.
pub const GROUP_SHARE: f64 = 0.02;

pub struct Peopling {
    /// The years from the span's start; Infinity where not reached.
    pub arrival: Vec<f32>,
    /// The cell each was reached from; -1 for an origin and where not reached.
    pub from: Vec<i32>,
    /// The origin each cell's people came from, by its index in the input.
    pub root: Vec<i32>,
    /// Each reached cell's group, numbered by when its first cell was
    /// reached; -1 where not reached.
    pub group: Vec<i32>,
    pub groups: usize,
    /// 1 where people came by boat.
    pub afloat: Vec<u8>,
    /// The foragers a km² each reached cell carries in today's climate, a
    /// dry shelf too (`ground_of`); 0 where not reached.
    pub density: Vec<f32>,
    /// The span: from the start to the end of the cold, years.
    pub span: f64,
    /// The first landing on each landmass after open sea.
    pub log: Vec<LogEvent>,
}

// The world's climate sampled every CLIMATE_YEARS: the sea's drop and the
// ice's reach.
struct Climate {
    drop_m: Vec<f64>,
    ice_km: Vec<f64>,
}

impl Climate {
    fn at(&self, t: f64) -> usize {
        ((t / CLIMATE_YEARS) as usize).min(self.drop_m.len() - 1)
    }
}

fn reach_km(t: f64, span: f64) -> f64 {
    REACH_START_KM + (REACH_END_KM - REACH_START_KM) * (t / span).clamp(0.0, 1.0)
}

// The time the reach is `km`; Infinity beyond the span's.
fn reach_at(km: f64, span: f64) -> f64 {
    if km <= REACH_START_KM {
        return 0.0;
    }
    if km > REACH_END_KM {
        return f64::INFINITY;
    }
    span * (km - REACH_START_KM) / (REACH_END_KM - REACH_START_KM)
}

pub fn people(h: &Habitat, carrying: &[f32], origins: &[usize], seed: f64) -> Peopling {
    let n = h.count;
    let history = ClimateHistory::of(seed, SPAN_YEARS);
    let span = history.max_at + history.deglaciation;
    let samples = (span / CLIMATE_YEARS) as usize + 1;
    let climate = Climate {
        drop_m: (0..samples)
            .map(|k| history.sea_drop_m(k as f64 * CLIMATE_YEARS))
            .collect(),
        ice_km: (0..samples)
            .map(|k| ICE_REACH_KM * history.cold(k as f64 * CLIMATE_YEARS))
            .collect(),
    };
    let Ground { base, speed, shelf } = ground_of(h, carrying);
    let ice_km = ice_distance(h);
    let iced = |i: usize| ice_may_cover(h.koppen[i]) && ice_km[i] < f32::INFINITY;

    // Dry ground at the sample `k`, which the front walks.
    let dry_at = |i: usize, k: usize| -> bool {
        if h.land[i] != 0 {
            base[i] > 0.0 && !(iced(i) && ice_km[i] as f64 <= climate.ice_km[k])
        } else {
            shelf[i] != 0 && h.sea_depth_m[i] as f64 <= climate.drop_m[k]
        }
    };
    // The first time from `t` the cell is dry ground; None if not in the span.
    let dry_from = |i: usize, t: f64| -> Option<f64> {
        let k0 = climate.at(t);
        if dry_at(i, k0) {
            return Some(t);
        }
        // Land the ice never leaves, and the sea below any shelf, never open.
        if (h.land[i] != 0 && base[i] <= 0.0) || (h.land[i] == 0 && shelf[i] == 0) {
            return None;
        }
        (k0 + 1..samples)
            .find(|&k| dry_at(i, k))
            .map(|k| k as f64 * CLIMATE_YEARS)
    };
    let near_dry = |i: usize, k: usize| h.edges(i).any(|e| dry_at(h.nbr[e] as usize, k));

    let mut arrival = vec![f64::INFINITY; n];
    let mut from = vec![-1i32; n];
    let mut root = vec![-1i32; n];
    // Afloat: the open sea since the last sight of dry ground, the longest
    // such stretch and the voyage since the last landing, km.
    let mut stretch = vec![0f32; n];
    let mut longest = vec![0f32; n];
    let mut voyage = vec![0f32; n];
    let mut afloat = vec![0u8; n];
    // On dry ground: the longest open sea of the crossing that brought
    // people there, kept over the dry shelf they walk on from where they
    // landed; -1 on land reached on foot.
    let mut landed = vec![-1f32; n];
    let mut done = vec![0u8; n];
    let mut heap = MinHeap::new(1 << 16);
    for (r, &o) in origins.iter().enumerate() {
        if o >= n || arrival[o] == 0.0 {
            continue;
        }
        arrival[o] = 0.0;
        root[o] = r as i32;
        heap.push(0.0, o as i32);
    }
    let mut landmass_reached = vec![false; h.landmasses];
    let mut log: Vec<LogEvent> = origins
        .iter()
        .filter(|&&o| o < n)
        .map(|&o| LogEvent::Departure {
            at: 0.0,
            cell: o as f64,
        })
        .collect();
    while !heap.is_empty() {
        heap.pop();
        let i = heap.popped_index as usize;
        let t = heap.popped_key;
        if done[i] != 0 || t > arrival[i] {
            continue;
        }
        done[i] = 1;
        if afloat[i] == 0 && h.land[i] != 0 {
            let m = h.landmass[i];
            if m >= 0 && !landmass_reached[m as usize] {
                landmass_reached[m as usize] = true;
                if landed[i] >= 0.0 {
                    log.push(LogEvent::Crossing {
                        at: t,
                        cell: i as f64,
                        landmass: m as f64,
                        km: landed[i] as f64,
                        first: true,
                    });
                }
            }
        }
        let k = climate.at(t);
        for e in h.edges(i) {
            let u = h.nbr[e] as usize;
            if done[u] != 0 {
                continue;
            }
            let km = h.dist_km[e] as f64;
            let walk = km / speed[u].max(1e-6) as f64;
            let landing = CROSSING_YEARS * longest[i] as f64 / reach_km(t, span);
            let (at, float) = if dry_at(u, k) {
                // Walked, or landed.
                (t + walk + landing, None)
            } else if h.land[u] != 0 {
                // Land closed by the ice: walked when it opens.
                match dry_from(u, t) {
                    Some(open) => (open + walk + landing, None),
                    None => continue,
                }
            } else {
                // Afloat. A shelf that will be dry is walked onto later
                // only if no boat gets there first.
                // On dry ground the three are 0.
                let open = if near_dry(u, k) {
                    0.0
                } else {
                    stretch[i] as f64 + km
                };
                let most = open.max(longest[i] as f64);
                let went = voyage[i] as f64 + km;
                if went > VOYAGE_KM {
                    continue;
                }
                let ready = t.max(reach_at(most, span));
                let at = ready + km / SEA_KM_A;
                let walk_later = if shelf[u] != 0 {
                    dry_from(u, t).map(|o| o + walk + landing)
                } else {
                    None
                };
                match walk_later {
                    Some(w) if w <= at => (w, None),
                    _ => (at, Some((open, most, went))),
                }
            };
            if at > span || at >= arrival[u] {
                continue;
            }
            arrival[u] = at;
            from[u] = i as i32;
            root[u] = root[i];
            match float {
                Some((open, most, went)) => {
                    afloat[u] = 1;
                    stretch[u] = open as f32;
                    longest[u] = most as f32;
                    voyage[u] = went as f32;
                }
                None => {
                    landed[u] = if afloat[i] != 0 {
                        longest[i]
                    } else if h.land[i] == 0 {
                        landed[i]
                    } else {
                        -1.0
                    };
                    afloat[u] = 0;
                    stretch[u] = 0.0;
                    longest[u] = 0.0;
                    voyage[u] = 0.0;
                }
            }
            heap.push(at, u as i32);
        }
    }
    let (group, groups) = groups_of(h, &arrival, &from, &afloat);
    let density = (0..n)
        .map(|i| if arrival[i] < f64::INFINITY { base[i] } else { 0.0 })
        .collect();
    Peopling {
        arrival: arrival.iter().map(|&a| a as f32).collect(),
        from,
        root,
        group,
        groups,
        afloat,
        density,
        span,
        log,
    }
}

// The groups: a cell heads one where its branch holds GROUP_SHARE of the
// land cells reached or more, and its parent has another such branch or
// it landed from a boat; every other cell is its parent's.
fn groups_of(h: &Habitat, arrival: &[f64], from: &[i32], afloat: &[u8]) -> (Vec<i32>, usize) {
    let n = h.count;
    let mut order: Vec<usize> = (0..n).filter(|&i| arrival[i] < f64::INFINITY).collect();
    order.sort_by(|&a, &b| arrival[a].total_cmp(&arrival[b]).then(a.cmp(&b)));
    // The land cells reached through each cell, itself among them.
    let mut beyond = vec![0u32; n];
    for &i in order.iter().rev() {
        beyond[i] += u32::from(h.land[i] != 0);
        if from[i] >= 0 {
            beyond[from[i] as usize] += beyond[i];
        }
    }
    let reached = order.iter().filter(|&&i| h.land[i] != 0).count();
    let least = ((GROUP_SHARE * reached as f64).ceil() as u32).max(1);
    let mut large = vec![0u8; n];
    for &i in &order {
        if from[i] >= 0 && beyond[i] >= least {
            let p = from[i] as usize;
            large[p] = large[p].saturating_add(1);
        }
    }
    let mut group = vec![-1i32; n];
    let mut groups = 0usize;
    for &i in &order {
        let p = from[i];
        let heads = p < 0
            || (beyond[i] >= least
                && (large[p as usize] >= 2 || (h.land[i] != 0 && afloat[p as usize] != 0)));
        group[i] = if heads {
            groups += 1;
            groups as i32 - 1
        } else {
            group[p as usize]
        };
    }
    (group, groups)
}
