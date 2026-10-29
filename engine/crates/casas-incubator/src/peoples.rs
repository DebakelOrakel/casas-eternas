//! THE PEOPLES, part 1 (2026-10-29; docs/design/prehistory-in-three-steps.md,
//! step 2): cultural traits per cell, and the peoples they give.
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
//! - THE DRIFT, every CLIMATE_YEARS: by branch, not by cell; each trait of
//!   a branch takes a normal step of TRAIT_DRIFT (LANGUAGE_DRIFT), the same
//!   for all its cells. A branch is a people's descent: the people who
//!   went one way together (step 1's tree, which goes around the
//!   mountains, the deserts and the sea), and who drift together because
//!   they meet more often among themselves than a step of one cell shows.
//! - THE CONTACT, every CLIMATE_YEARS after the drift: one pass over the
//!   lived cells (`contact`).
//! - THE SETTLERS: a cell settled empty takes the traits and the branch of
//!   the cell its settlers came from. Fields or herds that spread to lived
//!   cells change no traits: foragers who take up the farming keep theirs.
//! - THE PEOPLES (`peoples_of`): the lived cells joined by neighbour edges
//!   whose trait distance is under PEOPLE_DISTANCE, a union-find.
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
use casas_engine::core::det_math::{det_cos, det_exp, det_log};
use casas_engine::core::js;
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
        }
    }

    /// A cell settled empty takes the traits and the branch of `kin`, the
    /// cell its settlers came from.
    pub fn inherit(&mut self, cell: usize, kin: usize) {
        if cell == kin {
            return;
        }
        self.values
            .copy_within(kin * TRAITS..(kin + 1) * TRAITS, cell * TRAITS);
        self.branch[cell] = self.branch[kin];
    }

    /// Every CLIMATE_YEARS: the drift, then the contact, on the lived cells.
    pub fn climate_step(&mut self, h: &Habitat, lived: &[usize], people: &[f32], days: &[f32]) {
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

    #[test]
    fn a_walk_is_reflected_into_the_bounds() {
        assert_eq!(reflect(-0.25), 0.25);
        assert_eq!(reflect(1.25), 0.75);
        assert_eq!(reflect(0.5), 0.5);
    }
}
