//! One Archean epoch: convection, drift on the flow with compaction,
//! nucleation by the land share, recycling, collisions and break-up,
//! consolidation. The parameters' measurements are in the TypeScript
//! port (`client/src/generator/archean/archeanStep.ts`, git history).

use crate::core::det_math::sq;
use crate::crust::crust_tune_params::{MERGE_OVERLAP_FACTOR, RAFT_CONNECT_FACTOR};
use crate::crust::raft_lifecycle::{
    advance_rafts_on_flow, compact_rafts, consolidate_raft_blobs, merge_overlapping_rafts,
    recycle_unstabilised_crust, split_disconnected_rafts,
};
use crate::mantle::mantle_field::{
    compute_mantle_flow, evolve_mantle_field, mantle_at, mantle_flow_at, sustain_mantle_vigour,
};
use crate::mantle::mantle_tune_params::MANTLE_TUNING;
use serde::Serialize;

use super::archean_land::{
    LandShareParams, archean_land_aim, archean_land_share, nucleation_budget,
};
use super::archean_state::ArcheanSimulation;
use super::crust_nucleation::{
    NucleationParams, default_nucleation_params, find_nucleation_sites, nucleate_crust,
};

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArcheanParams {
    pub nucleation: NucleationParams,
    pub land_share: f64,
    pub land: LandShareParams,
    pub mantle_rms: f64,
    pub attach_dist_m: f64,
    pub stabilisation_epochs: f64,
    pub recycle_threshold: f64,
    pub diffusion: f64,
    pub raft_rigidity: f64,
    pub compaction: f64,
    pub consolidate_proximity: f64,
    pub consolidate_max_radius_m: f64,
}

pub fn default_archean_params() -> ArcheanParams {
    ArcheanParams {
        nucleation: default_nucleation_params(),
        land_share: 0.3,
        land: LandShareParams {
            reach_epoch: 160.0,
            hold_epochs: 10.0,
            nucleus_land_m2: 30_000e6,
            history_from: 0.15,
            history_slope: 0.27,
            history_steep_from: 0.3,
            history_steep_slope: 0.25,
            ceiling_over_ramp: 1.3,
        },
        mantle_rms: 0.4,
        diffusion: 1.0,
        raft_rigidity: 0.95,
        compaction: 0.06,
        consolidate_proximity: 0.4,
        consolidate_max_radius_m: 1_170_000.0,
        attach_dist_m: 1_482_000.0,
        stabilisation_epochs: 25.0,
        recycle_threshold: -0.6,
    }
}

pub fn archean_step(sim: &mut ArcheanSimulation, params: &ArcheanParams) {
    let domain = sim.domain.clone();
    let field = std::mem::take(&mut sim.mantle);
    sim.mantle = evolve_mantle_field(field, &sim.rafts, &sim.meshes.mantle, params.diffusion);
    sustain_mantle_vigour(&mut sim.mantle, params.mantle_rms, &sim.meshes.mantle);
    let flow = compute_mantle_flow(
        &sim.mantle,
        &sim.meshes.mantle,
        MANTLE_TUNING.flow_speed_scale,
    );
    {
        let mm = &mut sim.meshes.mantle;
        advance_rafts_on_flow(
            &mut sim.rafts,
            &mut |x, y| mantle_flow_at(mm, &flow, x, y),
            &domain,
            params.raft_rigidity,
        );
    }
    compact_rafts(&mut sim.rafts, params.compaction, &domain);
    let land = archean_land_share(sim);
    let aim = archean_land_aim(params.land_share, &params.land);
    let budget = nucleation_budget(
        sim,
        land,
        aim,
        &params.land,
        params.nucleation.max_per_epoch,
    );
    let sites = {
        let random = &mut sim.random;
        find_nucleation_sites(
            &sim.mantle,
            &mut sim.upwelling_streak,
            &sim.rafts,
            &params.nucleation,
            &mut || random.next(),
            &sim.meshes.mantle,
            &domain,
            budget,
        )
    };
    sim.nucleation_credit -= sites.len() as f64;
    sim.last_nucleated = sites.len();
    for &site in &sites {
        nucleate_crust(
            &mut sim.rafts,
            site,
            sim.epoch,
            params.nucleation.blob_radius_m / domain.metres_per_unit,
            sq(params.attach_dist_m / domain.metres_per_unit),
            &domain,
        );
    }
    {
        let epoch = sim.epoch;
        let mantle = &sim.mantle;
        let mm = &mut sim.meshes.mantle;
        sim.last_recycled = recycle_unstabilised_crust(
            &mut sim.rafts,
            &mut |x, y| mantle_at(mm, mantle, x, y),
            &|birth| epoch - birth,
            params.stabilisation_epochs,
            params.recycle_threshold,
        );
    }
    merge_overlapping_rafts(&mut sim.rafts, MERGE_OVERLAP_FACTOR, sim.epoch, &domain);
    {
        let random = &mut sim.random;
        sim.last_splits = split_disconnected_rafts(
            &mut sim.rafts,
            RAFT_CONNECT_FACTOR,
            &mut || random.next(),
            &domain,
            false,
        );
    }
    if params.consolidate_proximity > 0.0 {
        consolidate_raft_blobs(
            &mut sim.rafts,
            sim.epoch,
            params.stabilisation_epochs,
            params.consolidate_proximity,
            params.consolidate_max_radius_m / domain.metres_per_unit,
            &domain,
        );
    }
    sim.epoch += 1.0;
}
