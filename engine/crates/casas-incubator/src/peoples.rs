//! THE PEOPLES, parts 1 and 2 (2026-10-29; docs/design/prehistory-in-
//! three-steps.md, step 2): cultural traits per cell, the peoples they
//! give, and the peoples' tree over the kept states.
//!
//! Each cell carries TRAITS traits in [0, 1]. They mean nothing: they are
//! identity only. Trait LANGUAGE is the language: it drifts less and is
//! pulled less by contact. The traits feed back into nothing of the
//! history, and their draws come from a stream of their own: the history
//! is the same bits with them and without them.
//!
//! - THE SEED, at step 2's start: each group of step 1 (peopling.rs) a
//!   random vector. Its finer branches (BRANCH_SHARE) take their parent
//!   branch's vector and a step of BRANCH_STEP: kin, not alike. Each cell
//!   reached takes its branch's vector.
//! - THE SPLIT, every CLIMATE_YEARS before the drift: a branch's joined
//!   part of more than SPLIT_KM2 parts in two branches (`split`).
//! - THE DRIFT, every CLIMATE_YEARS: by branch, not by cell; each trait of
//!   a branch takes a normal step of TRAIT_DRIFT (LANGUAGE_DRIFT), the same
//!   for all its cells. A branch is a people's descent: the people who
//!   went one way together (step 1's tree, which goes around the
//!   mountains, the deserts and the sea), and who drift together because
//!   they meet more often among themselves than a step of one cell shows.
//! - THE CONTACT, every CLIMATE_YEARS after the drift: one pass over the
//!   lived cells (`contact`).
//! - THE SETTLERS: a cell settled empty takes the traits and the branch of
//!   the cell its settlers came from.
//! - THE REPLACEMENT (`came`, `decide`): the fields that come to a lived
//!   cell without them from a farmer cell make it pending; once its
//!   people when they came (the foragers) are REPLACE_SHARE or fewer of
//!   its people now (the farmers grown in it), it takes the traits and the
//!   branch of the cell the fields came from; while they are more, the
//!   foragers keep theirs (in Europe the farmers who came replaced most of
//!   the hunters, as the genes show). The herds the same,
//!   HERD_REPLACE_SHARE. The copper, and the fields or herds that come to
//!   a cell that has them, carry no traits; nor do people who move into a
//!   lived cell (the famines, the rising sea): they meet by contact.
//! - THE PEOPLES (`peoples_of`): the lived cells joined by neighbour edges
//!   whose trait distance is under PEOPLE_DISTANCE, a union-find.
//! - THE TREE (`Tree`): the peoples at each kept state, with ids that
//!   last, their splits and merges.
//!
//! Measured on Morvane (v14), Thalassor and Zephyra (origin 783 702) on
//! 2026-10-29, the peoples of 1 000 people and 10 000 km² or more at the
//! history's end: 165, 189 and 171 (5.9, 9.6 and 7.9 a million km² of land
//! reached; the earth's new stone age some 3 to 10 archaeological cultures
//! a million km²), the largest 5.3, 3.1 and 4.0 % of the land lived in;
//! in peoples of fewer than 10 cells 0.5, 0.5 and 0.2 % of the lived cells.
//! Tried before, on Morvane:
//! - Drift by cell: the cells' noise averages out over a large people, so
//!   nothing parts (45 peoples at a distance of 0.02, 19 at 0.03).
//! - Drift by area (the cells within 15 days of a seed): the borders of
//!   the areas blur by contact into ramps of cells each a people of its
//!   own (9 % of the lived cells in peoples under 10 cells), and a ramp
//!   joins two peoples once one step of it is under the distance (the
//!   largest 12 %, at 0.05 one of 50 %).
//! - Drift by people (each people's own step, the peoples made again each
//!   time): the peoples never part, the branches of a group join again in
//!   5 000 years; some 45, the groups and the landmasses.

use crate::habitat::Habitat;
use crate::peopling::{Peopling, branches_of};
use crate::simulation::PEOPLE_FRAME_STEP;
use casas_engine::core::det_math::{det_cos, det_exp, det_log};
use casas_engine::core::js;
use casas_engine::core::min_heap::MinHeap;
use casas_engine::core::rng::Mulberry32;
use std::f64::consts::PI;

/// The traits a cell carries.
pub const TRAITS: usize = 8;
/// The trait that is the language.
pub const LANGUAGE: usize = 0;
/// The branches of step 1's tree that drift apart: of this share of the
/// land cells reached or more (as peopling.rs GROUP_SHARE, 0.02, for the
/// groups). On Morvane 192 branches; at 0.002, 246 peoples at the end,
/// at 0.005, 119. The count of the peoples hangs on it most.
pub const BRANCH_SHARE: f64 = 0.003;
/// A branch's step from its parent branch at the seed, a normal's spread
/// a trait: kin peoples begin near (some 0.04 apart, under
/// PEOPLE_DISTANCE half the time), and part as they drift.
pub const BRANCH_STEP: f64 = 0.03;
/// The drift's step every CLIMATE_YEARS, a normal's spread a trait; the
/// language's half: two branches some 0.2 apart a trait after 25 000
/// years.
pub const TRAIT_DRIFT: f64 = 0.03;
pub const LANGUAGE_DRIFT: f64 = 0.015;
/// The contact's rate every CLIMATE_YEARS (`contact`); the language's half.
/// On Morvane neither these nor CONTACT_DAYS (0.2, 0.5) changed the count
/// at the end: TRAIT_LIKE parts the peoples before the contact can join
/// them. Within a people it smooths what the settling and the seed leave.
pub const TRAIT_CONTACT: f64 = 0.5;
pub const LANGUAGE_CONTACT: f64 = 0.25;
/// A neighbour's weight falls with the ways' days (travel.rs) to it as 1 /
/// (1 + (days / CONTACT_DAYS)²): 0.85 for a day's third on the flat, 0.2 for
/// 2 days over a range.
pub const CONTACT_DAYS: f64 = 1.0;
/// Who differs much meets less (Axelrod's homophily): a neighbour's
/// weight falls by exp(-(distance / TRAIT_LIKE)²) too. Without it the
/// borders blur into ramps (2.5 % of Morvane's lived cells in peoples
/// under 10 cells, 78 peoples), with it they stay sharp (0.5 %, 165): the
/// count is the same for a distance of 0.01 to 0.1.
pub const TRAIT_LIKE: f64 = 0.05;
/// Two neighbours are of one people under this trait distance
/// (`trait_distance`). On Morvane at the end 165 peoples at 0.03 and 0.05,
/// 163 at 0.1, 144 at 0.15; at step 2's start 117, 55 and 45 (kin
/// branches near).
pub const PEOPLE_DISTANCE: f64 = 0.03;
/// THE REPLACEMENT (part 2; decided later since 2026-10-29): the fields
/// that come to a lived cell without them from a farmer cell make it
/// pending (`came`); it takes the farmers' traits and branch once its
/// people when they came (F0, the foragers) are this share or less of its
/// people now, the farmers grown in it (`decide`). At their coming F0 is
/// the people now: the rule never holds then, and no case is decided at
/// the coming. Part 2 decided at the coming against the source cell's
/// people: on Morvane (v14) of 24 909 comings 9 815 replaced (788 of
/// another branch), as the front's farmers had not grown yet. Decided
/// later (Morvane, Morvane from origin 473 575, Thalassor, Zephyra from
/// 783 702): 23 584, 23 620, 29 268 and 16 883 replaced (10 851, 14 139,
/// 17 676 and 9 336 of another branch), 1 325, 1 294, 1 366 and 690 still
/// pending at the end (dense foragers: the coasts, the fish); the cell's
/// farmers grow fast from 0.1 to 1 a km², so it is decided a median 25
/// to 50 years after the coming, p90 50. The peoples at the end 167, 155,
/// 192 and 173 (166, 153, 192 and 169 before), the largest the same (3.0,
/// 3.4, 3.1, 4.0 %); mainly farmers by km² 13, 23, 19 and 14 (11, 27, 29,
/// 12), by people 54, 57, 85, 35 (52, 57, 90, 34). At 0.2: all but some 30
/// cells replaced, a median of 25 years, the peoples 167, 154, 191, 173.
/// The fields spread mostly inside the people that began them (the arable
/// land is short): the peoples hardly change.
pub const REPLACE_SHARE: f64 = 0.1;
/// The same for the herds that come to a cell without fields or herds
/// from a herder cell. The herders (1.5 a km²) are not many more than the
/// foragers (0.1 to 0.3): decided at the coming (part 2) 557 of Morvane's
/// 92 424 comings replaced; decided later 8 979 (864 of another branch, a
/// median of 175 years after, p90 300), 83 343 still pending at the end.
/// On the other worlds 7 294, 9 878, 7 676. The rule is the fields', for
/// one rule.
pub const HERD_REPLACE_SHARE: f64 = 0.1;
/// THE SPLIT (part 2): a branch's joined lived cells of more than this
/// many km² part in two branches. By km², not by days across: the target
/// is the people's share of the land. Without it Morvane's origin 473 575
/// had a people of 35 % of the land lived in (a branch that settled a
/// landmass reached late in step 2, and never forked). At 1.5 M km²: 11
/// splits, the largest 4.8 % (145 peoples); at 1 M: 19, 3.4 % (153); on
/// Morvane's own origin 1 split, 3.0 % (166; 5.3 % before); none on
/// Thalassor and Zephyra (3.1, 4.0 %). The earth's largest cultures of
/// the new stone age (the LBK, the Corded Ware) some 0.5 to 1.5 M km².
pub const SPLIT_KM2: f64 = 1.0e6;
/// A people of the tree (`Tree`) has this many people and this many km²
/// or more; a smaller set of joined alike cells beside one is part of it.
pub const PEOPLE_LEAST: f64 = 1000.0;
pub const PEOPLE_LEAST_KM2: f64 = 10_000.0;

/// The traits of all cells and what moves them.
pub struct Traits {
    /// TRAITS a cell, cell by cell; 0 where no one came yet.
    pub values: Vec<f32>,
    random: Mulberry32,
    // Each cell's branch, which drifts as one; -1 where no one came yet.
    branch: Vec<i32>,
    branches: usize,
    // The contact's new values, TRAITS a lived cell.
    scratch: Vec<f32>,
    // The pass a cell drifted in last.
    stamp: Vec<u32>,
    pass: u32,
    /// Each cell's people of the tree (`Tree`) at the last kept state, or
    /// its settlers' people; -1 before the first.
    pub ident: Vec<i32>,
    // THE SPLIT's days from a cell, Infinity where not searched.
    dist: Vec<f64>,
    /// The cells whose traits the fields replaced, the herds'; the splits.
    pub replaced: u32,
    pub herd_replaced: u32,
    pub splits: u32,
    // THE REPLACEMENT's pending cells, in the order they became pending;
    // each cell's source, -1 where not pending; its people when the fields
    // or herds came (F0), a km²; 1 where the herds came.
    pending: Vec<usize>,
    source: Vec<i32>,
    foragers: Vec<f32>,
    by_herds: Vec<u8>,
}

// A normal draw (Box–Muller, as THE DROUGHTS draw theirs).
fn normal(random: &mut Mulberry32) -> f64 {
    let a = random.next();
    let b = random.next();
    (-2.0 * det_log(1.0 - a)).sqrt() * det_cos(2.0 * PI * b)
}

// Into [0, 1], reflected at the bounds: a walk clamped at them piles up
// there and makes the cells alike.
fn reflect(mut x: f64) -> f64 {
    loop {
        if x < 0.0 {
            x = -x;
        } else if x > 1.0 {
            x = 2.0 - x;
        } else {
            return x;
        }
    }
}

impl Traits {
    /// The seed at step 2's start (THE SEED).
    pub fn seed(h: &Habitat, start: &Peopling, seed: f64) -> Traits {
        let n = h.count;
        let mut random = Mulberry32::new(js::to_uint32(seed) ^ 0x7ea1);
        let groups: Vec<f64> = (0..start.groups * TRAITS).map(|_| random.next()).collect();
        let arrival: Vec<f64> = start.arrival.iter().map(|&a| a as f64).collect();
        let (branch, branches) = branches_of(h, &arrival, &start.from, &start.afloat, BRANCH_SHARE);
        // Each branch's head: its cell whose parent is of another branch,
        // or an origin. A branch is numbered after its parent's.
        let mut head = vec![usize::MAX; branches];
        for i in 0..n {
            let b = branch[i];
            if b < 0 {
                continue;
            }
            let p = start.from[i];
            if p < 0 || branch[p as usize] != b {
                head[b as usize] = i;
            }
        }
        let mut of = vec![0f32; branches * TRAITS];
        for b in 0..branches {
            let i = head[b];
            let p = start.from[i];
            let g = start.group[i] as usize;
            if p < 0 || start.group[p as usize] != start.group[i] {
                for t in 0..TRAITS {
                    of[b * TRAITS + t] = groups[g * TRAITS + t] as f32;
                }
            } else {
                let parent = branch[p as usize] as usize;
                for t in 0..TRAITS {
                    of[b * TRAITS + t] =
                        reflect(of[parent * TRAITS + t] as f64 + BRANCH_STEP * normal(&mut random))
                            as f32;
                }
            }
        }
        let mut values = vec![0f32; n * TRAITS];
        for i in 0..n {
            if branch[i] >= 0 {
                let b = branch[i] as usize;
                values[i * TRAITS..(i + 1) * TRAITS]
                    .copy_from_slice(&of[b * TRAITS..(b + 1) * TRAITS]);
            }
        }
        Traits {
            values,
            random,
            branch,
            branches,
            scratch: Vec::new(),
            stamp: vec![0; n],
            pass: 0,
            ident: vec![-1; n],
            dist: vec![f64::INFINITY; n],
            replaced: 0,
            herd_replaced: 0,
            splits: 0,
            pending: Vec::new(),
            source: vec![-1; n],
            foragers: vec![0.0; n],
            by_herds: vec![0; n],
        }
    }

    /// A cell settled empty takes the traits and the branch of `kin`, the
    /// cell its settlers came from; a pending cell (`came`) is no longer.
    pub fn inherit(&mut self, cell: usize, kin: usize) {
        if cell == kin {
            return;
        }
        self.values
            .copy_within(kin * TRAITS..(kin + 1) * TRAITS, cell * TRAITS);
        self.branch[cell] = self.branch[kin];
        self.ident[cell] = self.ident[kin];
        self.source[cell] = -1;
    }

    /// THE REPLACEMENT, its first half: the fields (`herds` false) or the
    /// herds came to lived `cell` from `kin`. The cell is pending: it
    /// keeps kin as its source and its people now (the foragers, F0) until
    /// `decide`. The fields that come to a cell pending from the herds
    /// take the herds' place: their source, the people then.
    pub fn came(&mut self, cell: usize, kin: usize, people: &[f32], herds: bool) {
        if self.source[cell] < 0 {
            self.pending.push(cell);
        }
        self.source[cell] = kin as i32;
        self.foragers[cell] = people[cell];
        self.by_herds[cell] = herds as u8;
    }

    /// THE REPLACEMENT, its second half, every step: a pending cell whose
    /// F0 is REPLACE_SHARE (HERD_REPLACE_SHARE) or less of its people now
    /// (the farmers grown in it) takes the traits, branch and people of
    /// its source as the source is now, and is no longer pending. A
    /// pending cell left empty, or whose source is empty now (a famine,
    /// the sea), is no longer pending and keeps its own traits: no
    /// search for other farmers (on the three worlds no source was empty,
    /// 2026-10-29). The cells in the order they became pending, so that a
    /// source replaced in the same pass gives its new traits on; a source
    /// still pending gives its own (its foragers are still many: the
    /// farmers who came took their ways).
    pub fn decide(&mut self, people: &[f32]) {
        let mut kept = 0;
        for k in 0..self.pending.len() {
            let cell = self.pending[k];
            let s = self.source[cell];
            // -1: settled again since (`inherit`).
            let done = if s < 0 || people[cell] <= 0.0 || people[s as usize] <= 0.0 {
                true
            } else {
                let herds = self.by_herds[cell] != 0;
                let share = if herds {
                    HERD_REPLACE_SHARE
                } else {
                    REPLACE_SHARE
                };
                let replace = self.foragers[cell] as f64 <= share * people[cell] as f64;
                if replace {
                    self.inherit(cell, s as usize);
                    if herds {
                        self.herd_replaced += 1;
                    } else {
                        self.replaced += 1;
                    }
                }
                replace
            };
            if done {
                self.source[cell] = -1;
            } else {
                self.pending[kept] = cell;
                kept += 1;
            }
        }
        self.pending.truncate(kept);
    }

    /// Every CLIMATE_YEARS: the split, the drift, then the contact, on the
    /// lived cells.
    pub fn climate_step(&mut self, h: &Habitat, lived: &[usize], people: &[f32], days: &[f32]) {
        self.split(h, lived, people, days);
        // THE DRIFT: a step for each trait of each branch, drawn for every
        // branch in order (lived or not, so that the stream does not hang
        // on who lives where).
        let steps: Vec<f64> = (0..self.branches * TRAITS)
            .map(|k| {
                let spread = if k % TRAITS == LANGUAGE {
                    LANGUAGE_DRIFT
                } else {
                    TRAIT_DRIFT
                };
                spread * normal(&mut self.random)
            })
            .collect();
        // A cell may stand on `lived` twice (left and settled again): it
        // drifts once.
        self.pass += 1;
        for &i in lived {
            let b = self.branch[i];
            if people[i] <= 0.0 || b < 0 || self.stamp[i] == self.pass {
                continue;
            }
            self.stamp[i] = self.pass;
            let b = b as usize;
            for t in 0..TRAITS {
                let x = &mut self.values[i * TRAITS + t];
                *x = reflect(*x as f64 + steps[b * TRAITS + t]) as f32;
            }
        }
        self.contact(h, lived, people, days);
    }

    // THE CONTACT: each lived cell toward the mean of its lived neighbours,
    // each weighted by its people, by how near it is by the ways
    // (CONTACT_DAYS) and by how alike (TRAIT_LIKE), at a rate of
    // TRAIT_CONTACT (LANGUAGE_CONTACT) times the neighbours' weight over the
    // cell's own people and the neighbours' weight: a few foragers beside
    // many farmers take their ways, many farmers beside a few foragers keep
    // theirs; a cell whose neighbours are far (a range, a desert) moves
    // little. From the values before the pass.
    fn contact(&mut self, h: &Habitat, lived: &[usize], people: &[f32], days: &[f32]) {
        let c2 = CONTACT_DAYS * CONTACT_DAYS;
        self.scratch.clear();
        self.scratch.resize(lived.len() * TRAITS, 0.0);
        for (k, &i) in lived.iter().enumerate() {
            let own = &self.values[i * TRAITS..(i + 1) * TRAITS];
            let out = &mut self.scratch[k * TRAITS..(k + 1) * TRAITS];
            out.copy_from_slice(own);
            if people[i] <= 0.0 {
                continue;
            }
            let p_i = people[i] as f64 * h.area_km2[i] as f64;
            let mut weight = 0.0;
            let mut pull = [0f64; TRAITS];
            for e in h.edges(i) {
                let u = h.nbr[e] as usize;
                let d = days[e] as f64;
                if people[u] <= 0.0 || d == f64::INFINITY {
                    continue;
                }
                let near = people[u] as f64 * h.area_km2[u] as f64 * c2 / (c2 + d * d);
                // Alike (most neighbours, within a branch): the weight, no
                // pull.
                if self.values[u * TRAITS..(u + 1) * TRAITS] == *own {
                    weight += near;
                    continue;
                }
                let l = trait_distance(&self.values, i, u) / TRAIT_LIKE;
                let w = near * det_exp(-l * l);
                weight += w;
                for t in 0..TRAITS {
                    pull[t] += w * (self.values[u * TRAITS + t] as f64 - own[t] as f64);
                }
            }
            if weight <= 0.0 {
                continue;
            }
            for t in 0..TRAITS {
                let rate = if t == LANGUAGE {
                    LANGUAGE_CONTACT
                } else {
                    TRAIT_CONTACT
                };
                out[t] = (own[t] as f64 + rate * pull[t] / (p_i + weight)) as f32;
            }
        }
        for (k, &i) in lived.iter().enumerate() {
            self.values[i * TRAITS..(i + 1) * TRAITS]
                .copy_from_slice(&self.scratch[k * TRAITS..(k + 1) * TRAITS]);
        }
    }
}

impl Traits {
    // THE SPLIT, before the drift: a branch's joined part (its lived cells
    // joined by ways, `days` finite) of more than SPLIT_KM2 parts in two.
    // A and B are its two ends: A the cell farthest by the days from its
    // first cell, B the cell farthest from A. Each cell goes to the end it
    // is nearer by the days; B's side becomes a new branch, which takes a
    // step of BRANCH_STEP from the old as the seed's branches do, and
    // drifts on its own from then. The cut is where the days from the two
    // ends are equal: across the part's long axis, as the ways go (a range
    // across the part counts its days).
    fn split(&mut self, h: &Habitat, lived: &[usize], people: &[f32], days: &[f32]) {
        let mut km2 = vec![0f64; self.branches];
        self.pass += 1;
        for &i in lived {
            let b = self.branch[i];
            if people[i] <= 0.0 || b < 0 || self.stamp[i] == self.pass {
                continue;
            }
            self.stamp[i] = self.pass;
            km2[b as usize] += h.area_km2[i] as f64;
        }
        let large: Vec<i32> = (0..self.branches)
            .filter(|&b| km2[b] > SPLIT_KM2)
            .map(|b| b as i32)
            .collect();
        if large.is_empty() {
            return;
        }
        // The cells of the large branches, in the order of `lived`.
        let mut cells: Vec<usize> = Vec::new();
        self.pass += 1;
        for &i in lived {
            if people[i] > 0.0
                && self.stamp[i] != self.pass
                && large.binary_search(&self.branch[i]).is_ok()
            {
                self.stamp[i] = self.pass;
                cells.push(i);
            }
        }
        // `stamp` == `pass` marks a large branch's cell not yet in a part.
        let open = self.pass;
        for k in 0..cells.len() {
            let first = cells[k];
            if self.stamp[first] != open {
                continue;
            }
            let b = self.branch[first];
            let part = self.reach(h, first, b, people, days);
            let mut area = 0.0;
            for &i in &part {
                self.stamp[i] = open - 1;
                area += h.area_km2[i] as f64;
            }
            if area <= SPLIT_KM2 {
                self.clear(&part);
                continue;
            }
            let a = farthest(&part, &self.dist);
            self.clear(&part);
            let from_a_part = self.reach(h, a, b, people, days);
            let from_a: Vec<f64> = from_a_part.iter().map(|&i| self.dist[i]).collect();
            let end_b = farthest(&from_a_part, &self.dist);
            self.clear(&from_a_part);
            let from_b_part = self.reach(h, end_b, b, people, days);
            // The same part from either end: the same cells, in another
            // order. B's side by the cells of A's search.
            let new = self.branches as i32;
            let step: Vec<f64> = (0..TRAITS)
                .map(|_| BRANCH_STEP * normal(&mut self.random))
                .collect();
            for (j, &i) in from_a_part.iter().enumerate() {
                if self.dist[i] < from_a[j] {
                    self.branch[i] = new;
                    for t in 0..TRAITS {
                        let x = &mut self.values[i * TRAITS + t];
                        *x = reflect(*x as f64 + step[t]) as f32;
                    }
                }
            }
            self.clear(&from_b_part);
            self.branches += 1;
            self.splits += 1;
        }
    }

    // The cells of branch `b` joined to `from` by ways through lived cells
    // of it, their days from it in `dist` (cleared by `clear`).
    fn reach(
        &mut self,
        h: &Habitat,
        from: usize,
        b: i32,
        people: &[f32],
        days: &[f32],
    ) -> Vec<usize> {
        let mut heap = MinHeap::new(256);
        let mut out = Vec::new();
        self.dist[from] = 0.0;
        heap.push(0.0, from as i32);
        while !heap.is_empty() {
            heap.pop();
            let i = heap.popped_index as usize;
            let d = heap.popped_key;
            if d > self.dist[i] {
                continue;
            }
            out.push(i);
            for e in h.edges(i) {
                let u = h.nbr[e] as usize;
                let nd = d + days[e] as f64;
                if people[u] <= 0.0 || self.branch[u] != b || nd >= self.dist[u] {
                    continue;
                }
                self.dist[u] = nd;
                heap.push(nd, u as i32);
            }
        }
        out
    }

    fn clear(&mut self, cells: &[usize]) {
        for &i in cells {
            self.dist[i] = f64::INFINITY;
        }
    }
}

// The cell of `cells` farthest by `dist`; the first of equals.
fn farthest(cells: &[usize], dist: &[f64]) -> usize {
    let mut best = cells[0];
    for &i in cells {
        if dist[i] > dist[best] {
            best = i;
        }
    }
    best
}

/// The traits' distance of two cells: Euclidean, the root of the mean
/// square over the traits (so that it does not hang on TRAITS). Not the
/// largest one trait's: with 8 traits it varies less from edge to edge.
pub fn trait_distance(values: &[f32], a: usize, b: usize) -> f64 {
    let mut sum = 0.0;
    for t in 0..TRAITS {
        let d = values[a * TRAITS + t] as f64 - values[b * TRAITS + t] as f64;
        sum += d * d;
    }
    (sum / TRAITS as f64).sqrt()
}

fn find(parent: &mut [u32], mut x: u32) -> u32 {
    while parent[x as usize] != x {
        let p = parent[x as usize];
        parent[x as usize] = parent[p as usize];
        x = p;
    }
    x
}

/// The peoples: the lived cells (`people` over 0) joined by neighbour
/// edges (`nbr_start`, `nbr` as the habitat's) whose trait distance is
/// under `distance` (PEOPLE_DISTANCE), a union-find. Each cell's people,
/// numbered by its first cell; -1 where no one lives. And how many.
pub fn peoples_of(
    nbr_start: &[u32],
    nbr: &[u32],
    values: &[f32],
    people: &[f32],
    distance: f64,
) -> (Vec<i32>, usize) {
    let n = people.len();
    let mut parent: Vec<u32> = (0..n as u32).collect();
    for i in 0..n {
        if people[i] <= 0.0 {
            continue;
        }
        for e in nbr_start[i] as usize..nbr_start[i + 1] as usize {
            let u = nbr[e] as usize;
            if u <= i || people[u] <= 0.0 || trait_distance(values, i, u) >= distance {
                continue;
            }
            let a = find(&mut parent, i as u32);
            let b = find(&mut parent, u as u32);
            if a != b {
                // The lower root stays: the people is its first cell's.
                let (lo, hi) = if a < b { (a, b) } else { (b, a) };
                parent[hi as usize] = lo;
            }
        }
    }
    let mut label = vec![-1i32; n];
    let mut count = 0usize;
    for i in 0..n {
        if people[i] <= 0.0 {
            continue;
        }
        let r = find(&mut parent, i as u32) as usize;
        if label[r] < 0 {
            label[r] = count as i32;
            count += 1;
        }
        label[i] = label[r];
    }
    (label, count)
}

/// A people of the tree at one kept state.
#[derive(Clone, Debug, PartialEq)]
pub struct PeopleFrame {
    /// The kept state's index (SimulationResult `kept`).
    pub frame: u32,
    pub people: f32,
    pub km2: f32,
    /// The share of its people in cells with fields.
    pub farmers: f32,
    /// Its heart: the cell the most steps from its border (ties: the most
    /// people, then the first). Not a mean of places, which a people bent
    /// round a sea or a range does not hold.
    pub centre: i32,
}

/// A people of the tree, from the kept state it was first seen at.
#[derive(Clone, Debug, PartialEq)]
pub struct People {
    /// The people it parted from; -1 for one of step 2's start.
    pub parent: i32,
    /// Step 1's group (peopling.rs) its first people came from, by their
    /// most people: its descent.
    pub group: i32,
    /// The time of the kept state it was first seen at, years.
    pub born: f64,
    /// The time of the kept state it was first not seen at; Infinity
    /// while it lives.
    pub ended: f64,
    /// The people most of its people went into where it ended; -1 where
    /// it died out.
    pub merged_into: i32,
    pub frames: Vec<PeopleFrame>,
}

impl People {
    /// Of PEOPLE_LEAST people and PEOPLE_LEAST_KM2 or more at one kept
    /// state or more: not only an isolated small band (an island's, which
    /// `fold_small` keeps). The chronicle tells these alone (pack.rs
    /// `peopleBig`).
    pub fn big(&self) -> bool {
        self.frames
            .iter()
            .any(|f| f.people as f64 >= PEOPLE_LEAST && f.km2 as f64 >= PEOPLE_LEAST_KM2)
    }
}

/// THE TREE (part 2): the peoples at each kept state, each with an id
/// that lasts. At a kept state the peoples are clustered (`peoples_of`,
/// PEOPLE_DISTANCE) over the cells the state holds people in, and a
/// cluster under PEOPLE_LEAST people or PEOPLE_LEAST_KM2 is part of the
/// larger neighbour it shares the most edges with (`fold_small`: the
/// borders' small sets of cells between two peoples, which come and go);
/// one with no larger neighbour (an island's band) is a people.
/// Each cluster is matched with the last state's peoples by their
/// overlap: each cell's people a km² × km² goes to the pair of its last
/// people (`Traits::ident`, which settlers carry) and its cluster now.
/// The pairs by overlap, the largest first, match a last people and a
/// cluster both not matched yet: the cluster keeps the people's id. A
/// cluster not matched is a new people whose parent is the last people
/// it overlaps most (a split: the larger part kept the id). A last
/// people not matched ends, merged into the people now that holds most
/// of its overlap, or died out where it overlaps none.
pub struct Tree {
    pub peoples: Vec<People>,
    /// Each kept state's people id of each cell the state holds people in
    /// (`frame` people over 0), in the cells' order; u16: some 650 to
    /// 1 350 ids in a whole history on the three worlds, 8 to 10 MB of
    /// ids on Morvane and Zephyra. Packed (pack.rs `peopleIds{k}`).
    pub ids: Vec<Vec<u16>>,
    // The peoples alive at the last kept state.
    alive: Vec<u32>,
}

impl Default for Tree {
    fn default() -> Self {
        Self::new()
    }
}

impl Tree {
    pub fn new() -> Tree {
        Tree {
            peoples: Vec::new(),
            ids: Vec::new(),
            alive: Vec::new(),
        }
    }

    /// The peoples at a kept state: `people` the state's (in
    /// PEOPLE_FRAME_STEP a km²), `fields` 1 where a cell has the fields
    /// by now, `group` each cell's step-1 group, `t` the state's time.
    /// Sets `traits.ident`. The state's ids, as in `ids`.
    pub fn frame(
        &mut self,
        h: &Habitat,
        traits: &mut Traits,
        people: &[u16],
        fields: &[u8],
        group: &[i32],
        t: f64,
    ) -> Vec<u16> {
        let n = h.count;
        let frame = self.ids.len() as u32;
        let weight: Vec<f64> = (0..n)
            .map(|i| people[i] as f64 * PEOPLE_FRAME_STEP * h.area_km2[i] as f64)
            .collect();
        let density: Vec<f32> = people.iter().map(|&p| p as f32).collect();
        let (label, clusters) = peoples_of(
            &h.nbr_start,
            &h.nbr,
            &traits.values,
            &density,
            PEOPLE_DISTANCE,
        );
        let (fold, count) = fold_small(h, &label, clusters, &weight);
        let cluster: Vec<i32> = label
            .iter()
            .map(|&l| if l < 0 { -1 } else { fold[l as usize] })
            .collect();
        // The overlap of each (last people, cluster) pair.
        let mut pairs: Vec<(u32, u32, f64)> = (0..n)
            .filter(|&i| cluster[i] >= 0 && traits.ident[i] >= 0)
            .map(|i| (traits.ident[i] as u32, cluster[i] as u32, weight[i]))
            .collect();
        pairs.sort_by_key(|a| (a.0, a.1));
        let mut overlap: Vec<(u32, u32, f64)> = Vec::new();
        for (p, q, w) in pairs {
            match overlap.last_mut() {
                Some(last) if last.0 == p && last.1 == q => last.2 += w,
                _ => overlap.push((p, q, w)),
            }
        }
        let ids = match_overlap(&mut self.peoples, &mut self.alive, &overlap, count, t);
        // A new people's descent: its parent's, or at step 2's start the
        // group of most of its people.
        let mut by_group: Vec<(u32, i32, f64)> = (0..n)
            .filter(|&i| cluster[i] >= 0 && group[i] >= 0)
            .map(|i| (cluster[i] as u32, group[i], weight[i]))
            .collect();
        by_group.sort_by_key(|a| (a.0, a.1));
        let mut most: Vec<(i32, f64)> = vec![(-1, -1.0); count];
        let mut k = 0;
        while k < by_group.len() {
            let (q, g, mut w) = by_group[k];
            k += 1;
            while k < by_group.len() && by_group[k].0 == q && by_group[k].1 == g {
                w += by_group[k].2;
                k += 1;
            }
            if w > most[q as usize].1 {
                most[q as usize] = (g, w);
            }
        }
        for q in 0..count {
            let id = ids[q];
            if id < 0 {
                continue;
            }
            let p = &self.peoples[id as usize];
            if p.group < 0 && p.frames.is_empty() {
                let g = if p.parent >= 0 {
                    self.peoples[p.parent as usize].group
                } else {
                    most[q].0
                };
                self.peoples[id as usize].group = g;
            }
        }
        // Each people's measure at this state.
        let centre = hearts(h, &cluster, count, &weight);
        let mut sum = vec![(0f64, 0f64, 0f64); count];
        for i in 0..n {
            if cluster[i] < 0 {
                continue;
            }
            let s = &mut sum[cluster[i] as usize];
            s.0 += weight[i];
            s.1 += h.area_km2[i] as f64;
            if fields[i] != 0 {
                s.2 += weight[i];
            }
        }
        for q in 0..count {
            if ids[q] < 0 {
                continue;
            }
            let (pp, km2, farm) = sum[q];
            self.peoples[ids[q] as usize].frames.push(PeopleFrame {
                frame,
                people: pp as f32,
                km2: km2 as f32,
                farmers: if pp > 0.0 { (farm / pp) as f32 } else { 0.0 },
                centre: centre[q],
            });
        }
        let mut out = Vec::new();
        for i in 0..n {
            if people[i] == 0 {
                continue;
            }
            let id = ids[cluster[i] as usize];
            traits.ident[i] = id;
            assert!((0..65535).contains(&id), "a people id over u16");
            out.push(id as u16);
        }
        self.ids.push(out.clone());
        out
    }
}

// Each cluster of `label` (`count` of them) to the one it is part of: a
// small one (under PEOPLE_LEAST people or PEOPLE_LEAST_KM2) to the larger
// neighbour it shares the most edges with (ties: the first), and on to
// where that one goes; a large one, or a small one with no larger
// neighbour (an island's band), to itself. The clusters kept numbered again from 0 in
// their order, as `peoples_of` numbers them: the map is to those; and how
// many.
fn fold_small(h: &Habitat, label: &[i32], count: usize, weight: &[f64]) -> (Vec<i32>, usize) {
    let mut size = vec![(0f64, 0f64); count];
    for i in 0..h.count {
        if label[i] >= 0 {
            let s = &mut size[label[i] as usize];
            s.0 += weight[i];
            s.1 += h.area_km2[i] as f64;
        }
    }
    let large: Vec<bool> = size
        .iter()
        .map(|&(p, km2)| p >= PEOPLE_LEAST && km2 >= PEOPLE_LEAST_KM2)
        .collect();
    // A small one to a larger neighbour (more people; of equals the
    // first), chains followed: the weights rise along them, so they end.
    let larger = |m: usize, l: usize| size[m].0 > size[l].0 || (size[m].0 == size[l].0 && m < l);
    let mut touch: Vec<(u32, u32)> = Vec::new();
    for i in 0..h.count {
        let l = label[i];
        if l < 0 || large[l as usize] {
            continue;
        }
        for e in h.edges(i) {
            let m = label[h.nbr[e] as usize];
            if m >= 0 && m != l && larger(m as usize, l as usize) {
                touch.push((l as u32, m as u32));
            }
        }
    }
    touch.sort();
    let mut into: Vec<i32> = (0..count as i32).collect();
    let mut best = vec![0usize; count];
    let mut k = 0;
    while k < touch.len() {
        let (l, m) = touch[k];
        let mut c = 0;
        while k < touch.len() && touch[k] == (l, m) {
            c += 1;
            k += 1;
        }
        if c > best[l as usize] {
            best[l as usize] = c;
            into[l as usize] = m as i32;
        }
    }
    for l in 0..count {
        let mut m = into[l] as usize;
        while into[m] as usize != m {
            m = into[m] as usize;
        }
        into[l] = m as i32;
    }
    // Number the kept clusters again in order.
    let mut number = vec![-1i32; count];
    let mut next = 0;
    for l in 0..count {
        if into[l] == l as i32 {
            number[l] = next;
            next += 1;
        }
    }
    (
        into.iter().map(|&m| number[m as usize]).collect(),
        next as usize,
    )
}

// The ids of the clusters now (`count` of them, by the clusters of
// `overlap`'s second), the peoples matched, made and ended in `peoples`
// and `alive` (see `Tree`). A cluster with no overlap, at step 2's start,
// is a new people of no parent.
fn match_overlap(
    peoples: &mut Vec<People>,
    alive: &mut Vec<u32>,
    overlap: &[(u32, u32, f64)],
    count: usize,
    t: f64,
) -> Vec<i32> {
    let mut ids = vec![-1i32; count];
    let mut matched_last = vec![false; peoples.len()];
    let mut order: Vec<usize> = (0..overlap.len()).collect();
    order.sort_by(|&a, &b| {
        overlap[b]
            .2
            .total_cmp(&overlap[a].2)
            .then((overlap[a].0, overlap[a].1).cmp(&(overlap[b].0, overlap[b].1)))
    });
    for &k in &order {
        let (p, q, _) = overlap[k];
        if matched_last[p as usize] || ids[q as usize] >= 0 {
            continue;
        }
        matched_last[p as usize] = true;
        ids[q as usize] = p as i32;
    }
    // The largest overlap of each cluster (its parent), of each last
    // people (where it went); the first of equals.
    let mut parent = vec![(-1i32, 0f64); count];
    let mut went = vec![(-1i32, 0f64); peoples.len()];
    for &(p, q, w) in overlap {
        if w > parent[q as usize].1 || parent[q as usize].0 < 0 {
            parent[q as usize] = (p as i32, w);
        }
        if w > went[p as usize].1 || went[p as usize].0 < 0 {
            went[p as usize] = (q as i32, w);
        }
    }
    for q in 0..count {
        if ids[q] >= 0 {
            continue;
        }
        ids[q] = peoples.len() as i32;
        peoples.push(People {
            parent: parent[q].0,
            group: -1,
            born: t,
            ended: f64::INFINITY,
            merged_into: -1,
            frames: Vec::new(),
        });
    }
    for &p in alive.iter() {
        let p = p as usize;
        if matched_last[p] {
            continue;
        }
        peoples[p].ended = t;
        if went[p].0 >= 0 {
            peoples[p].merged_into = ids[went[p].0 as usize];
        }
    }
    alive.clear();
    alive.extend(ids.iter().map(|&id| id as u32));
    alive.sort();
    ids
}

// Each cluster's heart (`PeopleFrame::centre`): a search inward from the
// border cells (a neighbour not of its cluster), the steps from it; the
// cell the most steps in, ties to the most people, then the first.
fn hearts(h: &Habitat, cluster: &[i32], count: usize, weight: &[f64]) -> Vec<i32> {
    let n = h.count;
    let mut depth = vec![u32::MAX; n];
    let mut queue: Vec<usize> = Vec::new();
    for i in 0..n {
        let c = cluster[i];
        if c < 0 {
            continue;
        }
        if h.edges(i).any(|e| cluster[h.nbr[e] as usize] != c) {
            depth[i] = 0;
            queue.push(i);
        }
    }
    let mut k = 0;
    while k < queue.len() {
        let i = queue[k];
        k += 1;
        for e in h.edges(i) {
            let u = h.nbr[e] as usize;
            if cluster[u] == cluster[i] && depth[u] == u32::MAX {
                depth[u] = depth[i] + 1;
                queue.push(u);
            }
        }
    }
    let mut best = vec![-1i32; count];
    for i in 0..n {
        let c = cluster[i];
        if c < 0 {
            continue;
        }
        let b = &mut best[c as usize];
        // A cluster with no border (a whole landmass's, its edges all
        // inward) is searched from nowhere: depth MAX for all, the most
        // people wins.
        if *b < 0
            || depth[i] > depth[*b as usize]
            || (depth[i] == depth[*b as usize] && weight[i] > weight[*b as usize])
        {
            *b = i as i32;
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    // A row of six cells: two alike halves, a step between, the last empty.
    #[test]
    fn peoples_are_joined_alike_cells() {
        let nbr_start = [0u32, 1, 3, 5, 7, 9, 10];
        let nbr = [1u32, 0, 2, 1, 3, 2, 4, 3, 5, 4];
        let mut values = vec![0f32; 6 * TRAITS];
        for i in 3..6 {
            for t in 0..TRAITS {
                values[i * TRAITS + t] = 0.5;
            }
        }
        values[TRAITS] = 0.01;
        let people = [1.0f32, 1.0, 1.0, 1.0, 1.0, 0.0];
        let (label, count) = peoples_of(&nbr_start, &nbr, &values, &people, 0.1);
        assert_eq!(count, 2);
        assert_eq!(label, vec![0, 0, 0, 1, 1, -1]);
        // Wide enough, one people.
        let (_, count) = peoples_of(&nbr_start, &nbr, &values, &people, 0.6);
        assert_eq!(count, 1);
    }

    // A row of `n` land cells of `km2` each, a step of a day between
    // neighbours.
    fn row(n: usize, km2: f32) -> Habitat {
        let mut nbr_start = vec![0u32];
        let mut nbr = Vec::new();
        for i in 0..n {
            if i > 0 {
                nbr.push(i as u32 - 1);
            }
            if i + 1 < n {
                nbr.push(i as u32 + 1);
            }
            nbr_start.push(nbr.len() as u32);
        }
        let e = nbr.len();
        Habitat {
            count: n,
            torus: true,
            land: vec![1; n],
            land_count: n,
            area_km2: vec![km2; n],
            height_m: vec![0.0; n],
            slope: vec![0.0; n],
            sea_depth_m: vec![0.0; n],
            biome: vec![0; n],
            koppen: vec![0; n],
            near_river: vec![0; n],
            river_size: vec![0.0; n],
            near_lake: vec![0; n],
            near_sea: vec![0; n],
            landmass: vec![0; n],
            landmasses: 1,
            landmass_km2: vec![km2 as f64 * n as f64],
            ecology: [(); 8].map(|_| None),
            nbr_start,
            nbr,
            dist_km: vec![10.0; e],
            u: vec![0.0; n],
            v: vec![0.0; n],
            radius_km: 0.0,
            width_km: 0.0,
            height_km: 0.0,
        }
    }

    // The traits of `n` cells, each the vector of all `of[i]`, one branch.
    fn traits_of(of: &[f32]) -> Traits {
        let n = of.len();
        Traits {
            values: of.iter().flat_map(|&x| [x; TRAITS]).collect(),
            random: Mulberry32::new(1),
            branch: vec![0; n],
            branches: 1,
            scratch: Vec::new(),
            stamp: vec![0; n],
            pass: 0,
            ident: vec![-1; n],
            dist: vec![f64::INFINITY; n],
            replaced: 0,
            herd_replaced: 0,
            splits: 0,
            pending: Vec::new(),
            source: vec![-1; n],
            foragers: vec![0.0; n],
            by_herds: vec![0; n],
        }
    }

    fn set(traits: &mut Traits, cell: usize, x: f32) {
        traits.values[cell * TRAITS..(cell + 1) * TRAITS].fill(x);
    }

    // Six cells of 10 000 people and 10 000 km² each: two peoples; one
    // parts in two, the smaller part a new people; it goes into the
    // other; the last dies out.
    #[test]
    fn the_tree_keeps_ids_and_records_splits_and_merges() {
        let h = row(6, 10_000.0);
        let mut traits = traits_of(&[0.0, 0.0, 0.0, 0.5, 0.5, 0.5]);
        let mut people = vec![1000u16; 6];
        let fields = [1u8, 1, 1, 0, 0, 0];
        let group = [3, 3, 3, 7, 7, 7];
        let mut tree = Tree::new();
        assert_eq!(
            tree.frame(&h, &mut traits, &people, &fields, &group, 0.0),
            vec![0, 0, 0, 1, 1, 1]
        );
        assert_eq!(tree.peoples[0].group, 3);
        assert_eq!(tree.peoples[1].group, 7);
        assert_eq!(tree.peoples[0].frames[0].farmers, 1.0);
        assert_eq!(tree.peoples[0].frames[0].people, 30_000.0);
        // Cells 4 and 5 part from 3: they are the larger part, they keep
        // the id; 3 is a new people, of parent 1.
        set(&mut traits, 4, 0.9);
        set(&mut traits, 5, 0.9);
        assert_eq!(
            tree.frame(&h, &mut traits, &people, &fields, &group, 10.0),
            vec![0, 0, 0, 2, 1, 1]
        );
        assert_eq!(tree.peoples[2].parent, 1);
        assert_eq!(tree.peoples[2].group, 7);
        assert_eq!(tree.peoples[2].born, 10.0);
        // 3 grows alike with 0 … 2: it goes into people 0.
        set(&mut traits, 3, 0.0);
        assert_eq!(
            tree.frame(&h, &mut traits, &people, &fields, &group, 20.0),
            vec![0, 0, 0, 0, 1, 1]
        );
        assert_eq!(tree.peoples[2].ended, 20.0);
        assert_eq!(tree.peoples[2].merged_into, 0);
        // 4 and 5 left empty: people 1 died out.
        people[4] = 0;
        people[5] = 0;
        assert_eq!(
            tree.frame(&h, &mut traits, &people, &fields, &group, 30.0),
            vec![0, 0, 0, 0]
        );
        assert_eq!(tree.peoples[1].ended, 30.0);
        assert_eq!(tree.peoples[1].merged_into, -1);
        assert_eq!(tree.peoples.len(), 3);
        assert!(tree.peoples[0].ended.is_infinite());
        assert_eq!(tree.peoples[0].frames.len(), 4);
    }

    // A set of few people between two peoples is part of the one it shares
    // the most edges with; one alone is a people of its own.
    #[test]
    fn small_sets_are_part_of_a_neighbour() {
        let h = row(7, 10_000.0);
        let mut traits = traits_of(&[0.0, 0.0, 0.3, 0.6, 0.6, 0.0, 0.9]);
        // Cell 2: 10 people; cell 5 empty, so cell 6 is alone.
        let people = [1000u16, 1000, 1, 1000, 1000, 0, 1];
        let mut tree = Tree::new();
        let ids = tree.frame(&h, &mut traits, &people, &[0; 7], &[0; 7], 0.0);
        // Cell 2 touches both by one edge: the first.
        assert_eq!(ids, vec![0, 0, 0, 1, 1, 2]);
        assert_eq!(tree.peoples.len(), 3);
    }

    // A branch of 4 000 000 km² in a row parts at its middle.
    #[test]
    fn a_large_branch_splits_at_its_middle() {
        let h = row(4, 1.0e6);
        let mut traits = traits_of(&[0.5; 4]);
        let lived = [0usize, 1, 2, 3];
        let people = [1.0f32; 4];
        let days = vec![1.0f32; h.nbr.len()];
        traits.split(&h, &lived, &people, &days);
        assert_eq!(traits.splits, 1);
        assert_eq!(traits.branch, vec![1, 1, 0, 0]);
        assert!(trait_distance(&traits.values, 1, 2) > 0.0);
        assert_eq!(trait_distance(&traits.values, 0, 1), 0.0);
        // Each part of 2 000 000 km² parts again, the next time.
        traits.split(&h, &lived, &people, &days);
        assert_eq!(traits.splits, 3);
    }

    // The fields come to cells 1 and 3 from farmer cells 0 and 2 (0.1 a
    // km² of foragers in each): cell 1 is decided once its people grew to
    // ten times its foragers or more, with its source's traits as they are
    // then; cell 3's source is left empty, and it keeps its own.
    #[test]
    fn the_replacement_is_decided_once_the_farmers_grew() {
        let mut traits = traits_of(&[0.0, 0.5, 0.2, 0.7]);
        traits.branch = vec![0, 1, 2, 3];
        traits.ident = vec![10, 11, 12, 13];
        let mut people = [15.0f32, 0.1, 15.0, 0.1];
        traits.came(1, 0, &people, false);
        traits.came(3, 2, &people, false);
        traits.decide(&people);
        assert_eq!(traits.pending, vec![1, 3]);
        people[1] = 0.5;
        traits.decide(&people);
        assert_eq!(traits.replaced, 0);
        set(&mut traits, 0, 0.3);
        people[1] = 1.5;
        people[2] = 0.0;
        traits.decide(&people);
        assert_eq!(traits.replaced, 1);
        assert_eq!(traits.values[TRAITS], 0.3);
        assert_eq!((traits.branch[1], traits.ident[1]), (0, 10));
        assert_eq!((traits.branch[3], traits.values[3 * TRAITS]), (3, 0.7));
        assert!(traits.pending.is_empty());
        assert_eq!(traits.source, vec![-1; 4]);
    }

    #[test]
    fn a_walk_is_reflected_into_the_bounds() {
        assert_eq!(reflect(-0.25), 0.25);
        assert_eq!(reflect(1.25), 0.75);
        assert_eq!(reflect(0.5), 0.5);
    }
}
