//! `archean/crustNucleation.ts`: where new continental crust appears in
//! the Archean: over hot, persistent upwellings that are still ocean.

use crate::core::domain::Domain;
use crate::crust::raft_field::raft_field;
use crate::crust::raft_types::{Raft, RaftBlob};
use crate::elevation::elevation_scale::shoreline_field;
use crate::mantle::mantle_field::MantleMesh;
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NucleationParams {
    pub upwelling_threshold: f64,
    pub persistence_epochs: f64,
    pub occupied_field_level: f64,
    pub blob_radius_m: f64,
    pub max_per_epoch: f64,
}

pub fn default_nucleation_params() -> NucleationParams {
    NucleationParams {
        upwelling_threshold: 0.70,
        persistence_epochs: 5.0,
        occupied_field_level: shoreline_field(),
        blob_radius_m: 546_000.0,
        max_per_epoch: 12.0,
    }
}

/// Advances the upwelling streaks and returns where crust nucleates this
/// epoch, at most `budget`, longest-standing first, jittered within the
/// cell.
#[allow(clippy::too_many_arguments)]
pub fn find_nucleation_sites(
    mantle: &[f64],
    streak: &mut [i16],
    rafts: &[Raft],
    params: &NucleationParams,
    random: &mut dyn FnMut() -> f64,
    mm: &MantleMesh,
    domain: &Domain,
    budget: f64,
) -> Vec<(f64, f64)> {
    let mesh = &mm.mesh;
    let mut candidates: Vec<(usize, i16)> = Vec::new();
    for i in 0..mesh.count {
        if mantle[i] < params.upwelling_threshold {
            streak[i] = 0;
            continue;
        }
        streak[i] = streak[i].wrapping_add(1);
        if (streak[i] as f64) < params.persistence_epochs {
            continue;
        }
        if raft_field(mesh.x[i], mesh.y[i], rafts, domain) > params.occupied_field_level {
            continue;
        }
        candidates.push((i, streak[i]));
    }
    // Stable, the longest first, as the comparator b − a.
    candidates.sort_by_key(|c| std::cmp::Reverse(c.1));
    let take = budget.min(params.max_per_epoch).max(0.0) as usize;
    let chosen: Vec<(usize, i16)> = candidates.into_iter().take(take).collect();
    for &(c, _) in &chosen {
        streak[c] = 0;
    }
    let cell = mm.cell_units;
    chosen
        .iter()
        .map(|&(c, _)| {
            let dx = (random() - 0.5) * cell;
            let dy = (random() - 0.5) * cell;
            let p = domain.displace(mesh.x[c], mesh.y[c], dx, dy);
            (p.x, p.y)
        })
        .collect()
}

/// A nucleated blob welded onto the raft within reach, or a new continent.
pub fn nucleate_crust(
    rafts: &mut Vec<Raft>,
    site: (f64, f64),
    epoch: f64,
    blob_radius: f64,
    attach_dist_sq: f64,
    domain: &Domain,
) {
    let blob = RaftBlob {
        x: site.0,
        y: site.1,
        radius: blob_radius,
        birth_epoch: Some(epoch),
    };
    let mut nearest = None;
    let mut nearest_sq = f64::INFINITY;
    for (i, r) in rafts.iter().enumerate() {
        for b in &r.blobs {
            let d = domain.distance_sq(site.0, site.1, b.x, b.y);
            if d < nearest_sq {
                nearest_sq = d;
                nearest = Some(i);
            }
        }
    }
    if let Some(i) = nearest
        && nearest_sq <= attach_dist_sq
    {
        rafts[i].blobs.push(blob);
        return;
    }
    let id = (rafts.iter().fold(-1i64, |m, r| m.max(r.id as i64)) + 1) as u32;
    rafts.push(Raft {
        id,
        name: None,
        blobs: vec![blob],
        no_merge_until_epoch: None,
    });
}
