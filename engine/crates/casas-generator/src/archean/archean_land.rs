//! THE LAND SHARE LEVER (DEC-0036 phase 8b-1). The Archean makes crust
//! until its land reaches the aim and then only what holds it; the land
//! measured on the mantle's cells, the baseline plus the dynamic
//! topography. The measurements are in the TypeScript port
//! (`client/src/generator/archean/archeanLand.ts`, git history).

use crate::core::domain::domain_area;
use crate::core::js;
use crate::crust::raft_field::build_blob_index;
use crate::elevation::dynamic_topography::dynamic_topography_at;
use crate::elevation::elevation_field::raft_baseline_at;
use serde::Serialize;

use super::archean_state::ArcheanSimulation;

/// The land share of the world's area.
pub fn archean_land_share(sim: &mut ArcheanSimulation) -> f64 {
    let domain = &sim.domain;
    let blobs = build_blob_index(&sim.rafts, domain, 1.0);
    let (mut land, mut total) = (0.0, 0.0);
    let mm = &mut sim.meshes.mantle;
    for i in 0..mm.mesh.count {
        let (x, y, a) = (mm.mesh.x[i], mm.mesh.y[i], mm.mesh.area[i]);
        total += a;
        let base = raft_baseline_at(
            x,
            y,
            &sim.rafts,
            None,
            domain,
            sim.warp_seed,
            Some(&blobs),
            None,
        );
        if base + dynamic_topography_at(&sim.mantle, &mm.sampler, &mut mm.mesh, x, y) > 0.0 {
            land += a;
        }
    }
    land / total
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LandShareParams {
    pub reach_epoch: f64,
    pub hold_epochs: f64,
    pub nucleus_land_m2: f64,
    pub history_from: f64,
    pub history_slope: f64,
    pub history_steep_from: f64,
    pub history_steep_slope: f64,
    pub ceiling_over_ramp: f64,
}

/// The land the Archean steers toward for a target: raised by what the
/// history takes back.
pub fn archean_land_aim(target: f64, p: &LandShareParams) -> f64 {
    let steep = if target > p.history_steep_from {
        p.history_steep_slope * (target - p.history_steep_from)
    } else {
        0.0
    };
    target + p.history_slope * js::max(0.0, target - p.history_from) + steep
}

/// How many nuclei this epoch may place: the deficit over the epochs left,
/// as a credit capped at the ceiling.
pub fn nucleation_budget(
    sim: &mut ArcheanSimulation,
    land: f64,
    target: f64,
    p: &LandShareParams,
    max_per_epoch: f64,
) -> f64 {
    let deficit = target - land;
    if deficit.is_nan() || deficit <= 0.0 {
        sim.nucleation_credit = 0.0;
        return 0.0;
    }
    let to_go = js::max(p.hold_epochs, p.reach_epoch - sim.epoch);
    let d = &sim.domain;
    let world_m2 = domain_area(d) * d.metres_per_unit * d.metres_per_unit;
    let rate = (deficit * world_m2) / (to_go * p.nucleus_land_m2);
    let ramp = (target * world_m2) / (p.reach_epoch * p.nucleus_land_m2);
    let ceiling = js::max(max_per_epoch, p.ceiling_over_ramp * ramp);
    sim.nucleation_credit = js::min(ceiling, sim.nucleation_credit + rate);
    sim.nucleation_credit.floor()
}
