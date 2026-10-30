//! Phase 4: the raft lifecycle. Collisions suture, a sustained continental
//! rift tears a continent and opens a ridge plate in the gap, and a raft
//! left as separate clusters comes apart.

use crate::core::det_math::sq;
use crate::core::world_time::world_epoch;
use crate::crust::crust_tune_params::{MERGE_OVERLAP_FACTOR, RAFT_CONNECT_FACTOR};
use crate::crust::raft_lifecycle::{
    merge_overlapping_rafts, split_disconnected_rafts, split_raft_at_rift,
};
use crate::crust::raft_names::{deserves_continent_name, pick_unused_raft_name};
use crate::crust::raft_types::{RaftMergeEvent, RaftSplitEvent, Suture};
use crate::mantle::mantle_field::cool_mantle_at;
use crate::tectonics::ocean_age::reset_ocean_age_around;
use crate::tectonics::plate_motion::{get_velocity_at, motion_moving_at};
use crate::tectonics::plate_seeds::PlateSeed;
use crate::tectonics::plate_simulation_types::PlateSimulation;
use crate::tectonics::plate_types::PlateType;
use crate::tectonics::tectonics_tune_params::TECTONICS_TUNING as T;
use crate::tectonics::terrain_features::{FeatureKind, MovesWith, find_or_create_feature_index};

use super::boundary_pass::BoundaryPassResult;

/// A young oceanic plate born at the rift point, at the flanks' mean
/// velocity there.
fn birth_ridge_plate(sim: &mut PlateSimulation, x: f64, y: f64, flank_a: usize, flank_b: usize) {
    let va = get_velocity_at(x, y, &sim.motions[flank_a], &sim.domain);
    let vb = get_velocity_at(x, y, &sim.motions[flank_b], &sim.domain);
    let motion = motion_moving_at(x, y, (va.x + vb.x) / 2.0, (va.y + vb.y) / 2.0, &sim.domain);
    sim.seeds.push(PlateSeed { x, y });
    sim.types.push(PlateType::Oceanic);
    sim.motions.push(motion);
    sim.ages.push(0.0);
}

pub struct RaftEventResult {
    pub raft_merges: Vec<RaftMergeEvent>,
    pub raft_split: Option<RaftSplitEvent>,
}

pub fn apply_raft_events(sim: &mut PlateSimulation, pass: &BoundaryPassResult) -> RaftEventResult {
    let domain = sim.domain.clone();
    let now = world_epoch(sim.archean_epochs, sim.epoch);
    let raft_merges = merge_overlapping_rafts(&mut sim.rafts, MERGE_OVERLAP_FACTOR, now, &domain);
    for m in &raft_merges {
        sim.sutures.push(Suture {
            x: m.x,
            y: m.y,
            tangent_x: m.tangent_x,
            tangent_y: m.tangent_y,
            epoch: now,
        });
    }
    let mut raft_split = None;
    if let Some(rift) = pass.continental_rift {
        let (sa, sb) = (sim.seeds[rift.plate_a], sim.seeds[rift.plate_b]);
        let o = domain.delta(sa.x, sa.y, sb.x, sb.y);
        let o = domain.transport(o.x, o.y, sb.x, sb.y, rift.x, rift.y);
        let (cnx, cny) = (o.x, o.y);
        let cnl = (cnx * cnx + cny * cny).sqrt();
        let cnl = if cnl == 0.0 || cnl.is_nan() { 1.0 } else { cnl };
        let new_raft_id = (sim.rafts.iter().fold(-1i64, |m, r| m.max(r.id as i64)) + 1) as u32;
        raft_split = split_raft_at_rift(
            &mut sim.rafts,
            rift.x,
            rift.y,
            cnx / cnl,
            cny / cnl,
            new_raft_id,
            sq(T.split_max_dist_m / domain.metres_per_unit),
            T.split_gap_m / domain.metres_per_unit,
            now,
            T.split_merge_immunity_epochs,
            &domain,
        );
        if raft_split.is_some() {
            let reset = T.rift_reset_radius_m / domain.metres_per_unit;
            let rr2 = reset * reset;
            for b in &pass.boundaries {
                if domain.distance_sq(b.x, b.y, rift.x, rift.y) <= rr2 {
                    sim.lattice_locked_epochs[b.lattice_index as usize] =
                        -(T.rift_margin_recovery_epochs as i16);
                    sim.lattice_accumulated[b.lattice_index as usize] = 0.0;
                }
            }
            sim.continental_rift_cooldown_until = sim.epoch + T.cont_rift_cooldown_epochs;
            if let Some(k) = sim.rafts.iter().position(|r| r.id == new_raft_id) {
                let areas: Vec<f64> = sim
                    .rafts
                    .iter()
                    .map(|r| r.blobs.iter().fold(0.0, |s, b| s + b.radius * b.radius))
                    .collect();
                let total = areas.iter().fold(0.0, |a, &b| a + b);
                let own = sim.rafts[k]
                    .blobs
                    .iter()
                    .fold(0.0, |s, b| s + b.radius * b.radius);
                if deserves_continent_name(own, total) {
                    let random = &mut sim.random;
                    let name = pick_unused_raft_name(&sim.rafts, &mut || random.next());
                    sim.rafts[k].name = name;
                }
            }
            let (fx, fy) = (-cny / cnl, cnx / cnl);
            let idx = find_or_create_feature_index(
                &mut sim.features,
                rift.x,
                rift.y,
                rift.plate_a as i32,
                -2,
                MovesWith::Plate(rift.plate_a as u32),
                fx,
                fy,
                FeatureKind::Range,
                false,
                &domain,
            );
            sim.features[idx].thickness += T.flood_basalt_deposit;
            sim.features[idx].epochs_since_deposit = 0.0;
            birth_ridge_plate(sim, rift.x, rift.y, rift.plate_a, rift.plate_b);
            reset_ocean_age_around(
                &mut sim.meshes.ocean,
                &mut sim.meshes.shared,
                &mut sim.ocean_age,
                rift.x,
                rift.y,
                T.breakup_fresh_crust_radius_m / domain.metres_per_unit,
            );
            cool_mantle_at(
                &mut sim.mantle,
                rift.x,
                rift.y,
                &sim.meshes.mantle,
                T.rift_cool_radius_m / domain.metres_per_unit,
                T.rift_cool_amount,
            );
        }
    }
    let random = &mut sim.random;
    split_disconnected_rafts(
        &mut sim.rafts,
        RAFT_CONNECT_FACTOR,
        &mut || random.next(),
        &domain,
        true,
    );
    RaftEventResult {
        raft_merges,
        raft_split,
    }
}
