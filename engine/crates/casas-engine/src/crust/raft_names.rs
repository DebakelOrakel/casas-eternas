//! `crust/raftNames.ts`: naming continents, which are rafts.

use super::continent_names::CONTINENT_NAME_POOL;
use super::raft_types::Raft;

/// A name from the pool no raft holds, drawn by `random`; None when the
/// pool is spent.
pub fn pick_unused_raft_name(rafts: &[Raft], random: &mut dyn FnMut() -> f64) -> Option<String> {
    let available: Vec<&str> = CONTINENT_NAME_POOL
        .iter()
        .copied()
        .filter(|n| !rafts.iter().any(|r| r.name.as_deref() == Some(*n)))
        .collect();
    if available.is_empty() {
        return None;
    }
    Some(available[(random() * available.len() as f64).floor() as usize].to_string())
}

/// A raft must hold at least this share of all continental crust to be a
/// continent and have a name.
pub const CONTINENT_MIN_LAND_SHARE: f64 = 0.05;

pub fn deserves_continent_name(area: f64, total_area: f64) -> bool {
    total_area > 0.0 && area / total_area >= CONTINENT_MIN_LAND_SHARE
}

/// Names the continents from a shuffled pool: every raft big enough to be
/// one, and the largest always. `areas` are land areas.
pub fn assign_raft_names(
    rafts: &[Raft],
    random: &mut dyn FnMut() -> f64,
    areas: &[f64],
) -> Vec<Raft> {
    let total: f64 = areas.iter().fold(0.0, |a, &b| a + b);
    let mut largest = 0;
    for (i, &a) in areas.iter().enumerate() {
        if a > areas[largest] {
            largest = i;
        }
    }
    let mut pool: Vec<&str> = CONTINENT_NAME_POOL.to_vec();
    for i in (1..pool.len()).rev() {
        let j = (random() * (i + 1) as f64).floor() as usize;
        pool.swap(i, j);
    }
    let mut next = 0;
    rafts
        .iter()
        .enumerate()
        .map(|(i, raft)| {
            let deserves = i == largest || deserves_continent_name(areas[i], total);
            let name = if deserves && next < pool.len() {
                next += 1;
                Some(pool[next - 1].to_string())
            } else {
                None
            };
            Raft {
                name,
                ..raft.clone()
            }
        })
        .collect()
}
