//! `screens/incubator/settle.ts`, its part for a history: what each reached
//! cell allows, the lifeways' shares and the density at the span's end
//! (`settleShared.ts`), the sources of the goods, the far trade's links
//! over the history's villages and camps, and its first trade for the log.
//! The rest of a settlement — the centres, the domesticates, the villages,
//! the people's count — is the history's own (the H1 artifact). The
//! reasoning is in the TypeScript files.

use crate::habitat::{ARABLE, CARRYING, FISH, Habitat, PASTURE};
use crate::log::LogEvent;
use crate::simulation::{FISH_RICH, SETTLE_AFTER, lifeway};
use crate::travel::{reset, travel_days, within_days};
use casas_engine::core::det_math::det_exp;
use casas_engine::core::js;
use casas_engine::core::min_heap::MinHeap;
use std::collections::HashMap;

pub(crate) const CARRYING_FULL: f64 = 0.8;
pub(crate) const DENSITY_TAU: f64 = 3000.0;
pub(crate) const FORAGER_WEIGHT: f64 = 0.2;
pub(crate) const LINKS: usize = 3;
pub(crate) const LINK_DAYS: f64 = 6.0;
pub(crate) const SOURCE_RICH: f64 = 0.6;
pub(crate) const SOURCE_DAYS: f64 = 20.0;
pub(crate) const SOURCE_RADIUS: usize = 10;
pub(crate) const DECAY_DAYS: f64 = 8.0;
pub(crate) const MAX_DAYS: f64 = 32.0;
pub(crate) const TRADE_TOLD: f64 = 0.05;
/// settleShared.ts GOODS, in order: the fields of the habitat.
pub(crate) const GOODS: [usize; 3] = [5, 6, 7];

fn density_of(way: usize) -> f64 {
    [0.0, 0.1, 1.0, 1.5, 15.0][way]
}
fn share_gain(way: usize) -> f64 {
    [0.0, 0.0, 1.0, 2.0, 4.0][way]
}

/// A cell's times and what it allows (settleShared.ts SettleTimes).
pub struct Times<'a> {
    pub arrival: &'a [f32],
    pub farm_at: &'a [f32],
    pub herd_at: &'a [f32],
    pub fish_ok: &'a [u8],
    pub farm_suit: &'a [f32],
    pub herd_suit: &'a [f32],
    pub fish_suit: &'a [f32],
    pub carrying: &'a [f32],
}

fn grown_since(t: f64, since: f64) -> f64 {
    js::max(0.0, 1.0 - det_exp(-(t - since) / DENSITY_TAU))
}

pub fn lifeway_since(s: &Times, i: usize, way: usize) -> f64 {
    match way as u8 {
        lifeway::FARMERS => s.farm_at[i] as f64,
        lifeway::HERDERS => s.herd_at[i] as f64,
        lifeway::FISHERS => {
            if s.fish_ok[i] != 0 {
                s.arrival[i] as f64 + SETTLE_AFTER
            } else {
                f64::INFINITY
            }
        }
        _ => s.arrival[i] as f64,
    }
}

/// The lifeways' shares at `t` into `shares` (a Float32Array of 5 in the
/// TypeScript), the largest's lifeway returned.
pub fn shares_at(s: &Times, i: usize, t: f64, shares: &mut [f32; 5]) -> u8 {
    *shares = [0.0; 5];
    if (s.arrival[i] as f64) > t || s.arrival[i].is_nan() {
        return lifeway::NONE;
    }
    shares[lifeway::FORAGERS as usize] = FORAGER_WEIGHT as f32;
    let mut sum = FORAGER_WEIGHT;
    let suits = [
        0.0,
        0.0,
        s.fish_suit[i] as f64,
        s.herd_suit[i] as f64,
        s.farm_suit[i] as f64,
    ];
    for way in [lifeway::FISHERS, lifeway::HERDERS, lifeway::FARMERS] {
        let way = way as usize;
        let since = lifeway_since(s, i, way);
        if since > t || since.is_nan() {
            continue;
        }
        let w = share_gain(way) * suits[way] * grown_since(t, since);
        shares[way] = w as f32;
        sum += w;
    }
    let mut top = lifeway::FORAGERS as usize;
    for w in 1..5 {
        shares[w] = (shares[w] as f64 / sum) as f32;
        if shares[w] > shares[top] {
            top = w;
        }
    }
    top as u8
}

fn way_density(s: &Times, i: usize, t: f64, way: usize) -> f64 {
    let c = s.carrying[i] as f64;
    let floor = density_of(lifeway::FORAGERS as usize) * c;
    let full = density_of(way) * c;
    floor + (full - floor) * grown_since(t, lifeway_since(s, i, way))
}

pub fn density_at(s: &Times, i: usize, t: f64, shares: &[f32; 5]) -> f64 {
    let mut d = 0.0;
    for way in 1..5 {
        if shares[way] > 0.0 {
            d += shares[way] as f64 * way_density(s, i, t, way);
        }
    }
    d
}

/// The cells within `rings` rings of cell `c`, itself first.
fn rings_around(h: &Habitat, c: usize, rings: usize, seen: &mut [i32], mark: i32) -> Vec<usize> {
    let mut cells = vec![c];
    seen[c] = mark;
    let mut from = 0;
    for _ in 0..rings {
        let to = cells.len();
        for k in from..to {
            let i = cells[k];
            for e in h.edges(i) {
                let u = h.nbr[e] as usize;
                if seen[u] == mark {
                    continue;
                }
                seen[u] = mark;
                cells.push(u);
            }
        }
        from = to;
    }
    cells
}

/// The cells where `value` is the largest within `rings` rings, ties to the
/// lower index, of those `candidate` admits.
fn local_tops(
    h: &Habitat,
    value: &[f32],
    rings: usize,
    candidate: impl Fn(usize) -> bool,
) -> Vec<usize> {
    let mut seen = vec![-1i32; h.count];
    let mut tops = Vec::new();
    for i in 0..h.count {
        if !candidate(i) {
            continue;
        }
        let top = !rings_around(h, i, rings, &mut seen, i as i32)
            .into_iter()
            .any(|u| u != i && (value[u] > value[i] || (value[u] == value[i] && u < i)));
        if top {
            tops.push(i);
        }
    }
    tops
}

/// What a history's settlement computes besides the history's own.
pub struct Settled {
    pub lifeway: Vec<u8>,
    pub density: Vec<f32>,
    pub fish_ok: Vec<u8>,
    pub farm_suit: Vec<f32>,
    pub herd_suit: Vec<f32>,
    pub fish_suit: Vec<f32>,
    pub carrying: Vec<f32>,
    pub sources: Vec<i32>,
    pub links: Vec<f32>,
    pub trade: Option<LogEvent>,
}

/// `villages` [cell, lifeway] the history's villages and camps, when each
/// began and was left; the settlement at `end`, the history's.
#[allow(clippy::too_many_arguments)]
pub fn settle_history(
    h: &Habitat,
    arrival: &[f32],
    farm_at: &[f32],
    herd_at: &[f32],
    villages: &[i32],
    village_from: &[f32],
    village_to: &[f32],
    end: f64,
) -> Settled {
    let n = h.count;
    let carrying_field = h.ecology[CARRYING].as_deref();
    let mut fish_ok = vec![0u8; n];
    let mut carrying_norm = vec![0f32; n];
    let mut farm_suit = vec![0f32; n];
    let mut herd_suit = vec![0f32; n];
    let mut fish_suit = vec![0f32; n];
    for i in 0..n {
        if h.land[i] == 0 || arrival[i] >= f32::INFINITY {
            continue;
        }
        farm_suit[i] = js::min(1.0, h.eco(ARABLE, i)) as f32;
        herd_suit[i] = js::min(1.0, h.eco(PASTURE, i)) as f32;
        fish_suit[i] = js::min(1.0, h.eco(FISH, i)) as f32;
        if h.eco(FISH, i) >= FISH_RICH {
            fish_ok[i] = 1;
        }
        let carrying = carrying_field.map_or(0.4, |c| c[i] as f64);
        carrying_norm[i] = js::min(2.0, carrying / CARRYING_FULL) as f32;
    }
    let times = Times {
        arrival,
        farm_at,
        herd_at,
        fish_ok: &fish_ok,
        farm_suit: &farm_suit,
        herd_suit: &herd_suit,
        fish_suit: &fish_suit,
        carrying: &carrying_norm,
    };
    let mut lifeway_of = vec![0u8; n];
    let mut density = vec![0f32; n];
    let mut shares = [0f32; 5];
    for i in 0..n {
        if h.land[i] == 0 {
            continue;
        }
        lifeway_of[i] = shares_at(&times, i, end, &mut shares);
        density[i] = density_at(&times, i, end, &shares) as f32;
    }

    // The links.
    let way_days = travel_days(h);
    let count = village_from.len();
    let mut village_of: HashMap<usize, usize> = HashMap::new();
    for v in 0..count {
        village_of.insert(villages[2 * v] as usize, v);
    }
    let mut dist = vec![f32::INFINITY; n];
    let mut edges: Vec<(usize, usize)> = Vec::new();
    let mut edge_at: HashMap<(usize, usize), usize> = HashMap::new();
    let mut edge_days: Vec<f64> = Vec::new();
    let mut neighbours: Vec<Vec<usize>> = vec![Vec::new(); count];
    for v in 0..count {
        let c = villages[2 * v] as usize;
        let mut near: Vec<(usize, f64)> = Vec::new();
        let mut visit = |cell: usize, d: f64| -> bool {
            if let Some(&u) = village_of.get(&cell)
                && u != v
            {
                near.push((u, d));
            }
            near.len() >= LINKS
        };
        let touched = within_days(
            h,
            &way_days,
            &[c],
            LINK_DAYS,
            &mut dist,
            Some(&mut visit),
            None,
        );
        reset(&mut dist, &touched);
        for (u, d) in near {
            let key = (v.min(u), v.max(u));
            if edge_at.contains_key(&key) {
                continue;
            }
            edge_at.insert(key, edges.len());
            edges.push(key);
            edge_days.push(d);
            neighbours[v].push(u);
            neighbours[u].push(v);
        }
    }

    // The sources.
    let mut sources: Vec<i32> = Vec::new();
    for (g, &field) in GOODS.iter().enumerate() {
        let Some(values) = h.ecology[field].as_deref() else {
            continue;
        };
        for c in local_tops(h, values, SOURCE_RADIUS, |i| {
            values[i] as f64 >= SOURCE_RICH && lifeway_of[i] > 0
        }) {
            sources.extend([c as i32, g as i32]);
        }
    }
    let mut weight = vec![0f64; edges.len()];
    let mut s = 0;
    while s < sources.len() {
        let mut start: Option<usize> = None;
        let mut visit = |cell: usize, _d: f64| -> bool {
            match village_of.get(&cell) {
                Some(&u) => {
                    start = Some(u);
                    true
                }
                None => false,
            }
        };
        let touched = within_days(
            h,
            &way_days,
            &[sources[s] as usize],
            SOURCE_DAYS,
            &mut dist,
            Some(&mut visit),
            None,
        );
        reset(&mut dist, &touched);
        s += 2;
        let Some(start) = start else { continue };
        let mut days: HashMap<usize, f64> = HashMap::from([(start, 0.0)]);
        let mut heap = MinHeap::new(64);
        heap.push(0.0, start as i32);
        while !heap.is_empty() {
            heap.pop();
            let v = heap.popped_index as usize;
            let d = heap.popped_key;
            if d > days[&v] {
                continue;
            }
            for &u in &neighbours[v] {
                let k = edge_at[&(v.min(u), v.max(u))];
                let nd = d + edge_days[k];
                if nd > MAX_DAYS || nd >= days.get(&u).copied().unwrap_or(f64::INFINITY) {
                    continue;
                }
                let first = !days.contains_key(&u);
                days.insert(u, nd);
                heap.push(nd, u as i32);
                if first {
                    weight[k] += det_exp(-d / DECAY_DAYS);
                }
            }
        }
    }
    let mut links: Vec<f32> = Vec::with_capacity(3 * edges.len());
    for (k, &(a, b)) in edges.iter().enumerate() {
        links.extend([a as f32, b as f32, weight[k] as f32]);
    }

    // The first trade (settle.ts firstTrade).
    let mut first: Option<usize> = None;
    let mut first_at = f64::INFINITY;
    let mut k = 0;
    while k < links.len() {
        if (links[k + 2] as f64) < TRADE_TOLD {
            k += 3;
            continue;
        }
        let (a, b) = (links[k] as usize, links[k + 1] as usize);
        let at = js::max(village_from[a] as f64, village_from[b] as f64);
        if at >= js::min(village_to[a] as f64, village_to[b] as f64) || at >= first_at {
            k += 3;
            continue;
        }
        first_at = at;
        first = Some(k);
        k += 3;
    }
    let trade = first.filter(|_| first_at <= end).map(|k| {
        let a = links[k] as usize;
        LogEvent::Trade {
            at: first_at,
            cell: villages[2 * a] as f64,
            a: a as f64,
            b: links[k + 1] as f64,
        }
    });

    Settled {
        lifeway: lifeway_of,
        density,
        fish_ok,
        farm_suit,
        herd_suit,
        fish_suit,
        carrying: carrying_norm,
        sources,
        links,
        trade,
    }
}
