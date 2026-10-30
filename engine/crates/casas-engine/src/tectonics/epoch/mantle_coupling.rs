//! `tectonics/epoch/mantleCoupling.ts`, phase 0: the mantle drives the
//! plates. The seeds move toward their footprints' centres, the field
//! evolves under the crust, its flow is fitted, the fit is dragged by each
//! plate's keel, and each plate's motion relaxes toward it.

use crate::crust::raft_field::{build_blob_index, compute_membership_at};
use crate::crust::raft_lifecycle::{
    RAFT_CARRY_REACH, carrier_plate_at, nearest_plate_index, raft_host_plates,
};
use crate::mantle::mantle_field::{compute_mantle_flow, evolve_mantle_field};
use crate::mantle::mantle_tune_params::MANTLE_TUNING;
use crate::tectonics::ocean_age::ocean_age_membership;
use crate::tectonics::plate_motion::{fit_motions_to_flow, relax_motion_toward, scale_motion};
use crate::tectonics::plate_simulation_types::PlateSimulation;
use crate::tectonics::tectonics_tune_params::TECTONICS_TUNING;

/// A plate's footprint on the mantle mesh (the cells nearest its seed, the
/// fit's footprint): its area, m², and the area-weighted sum of its cells'
/// positions — on the torus the offsets from the seed, on the sphere the
/// points in space —, and the area of continental crust the plate carries
/// (`carrier_plate_at`, wherever it lies).
struct Footprint {
    area: f64,
    sum: (f64, f64, f64),
    continental: f64,
}

fn plate_footprints(sim: &PlateSimulation) -> Vec<Footprint> {
    let domain = &sim.domain;
    let mesh = &sim.meshes.mantle.mesh;
    let mut out: Vec<Footprint> = (0..sim.seeds.len())
        .map(|_| Footprint {
            area: 0.0,
            sum: (0.0, 0.0, 0.0),
            continental: 0.0,
        })
        .collect();
    let membership = compute_membership_at(&sim.rafts, &mesh.x, &mesh.y, domain);
    let blobs = build_blob_index(&sim.rafts, domain, RAFT_CARRY_REACH);
    let hosts = raft_host_plates(&sim.rafts, &sim.seeds, domain);
    for i in 0..mesh.count {
        let (x, y, a) = (mesh.x[i], mesh.y[i], mesh.area[i]);
        if membership[i] > 0.5 {
            let c = carrier_plate_at(x, y, &blobs, &hosts, &sim.seeds, domain);
            out[c].continental += a;
        }
        let p = nearest_plate_index(x, y, &sim.seeds, domain);
        let f = &mut out[p];
        f.area += a;
        if domain.is_sphere() {
            let g = domain.globe_frame(x, y);
            f.sum.0 += a * g.px;
            f.sum.1 += a * g.py;
            f.sum.2 += a * g.pz;
        } else {
            let o = domain.delta(x, y, sim.seeds[p].x, sim.seeds[p].y);
            f.sum.0 += a * o.x;
            f.sum.1 += a * o.y;
        }
    }
    out
}

/// THE SEEDS FOLLOW THEIR PLATES (TEG-53, TEG-104; DES-0027 entry 4,
/// 2026-10-29). Each seed moves `seed_recentre_rate` of the way to its
/// footprint's centroid: one damped Lloyd step an epoch. Without it the
/// seeds drift with their own motions only, crowd one region and leave
/// plates with no mantle cell, which fit no motion and crawl (sphere
/// zulu, 600 epochs; the measurements are at the constant).
fn recentre_seeds(sim: &mut PlateSimulation, footprints: &[Footprint]) {
    let rate = TECTONICS_TUNING.seed_recentre_rate;
    let domain = sim.domain.clone();
    for (p, f) in footprints.iter().enumerate() {
        if f.area <= 0.0 {
            continue;
        }
        let s = sim.seeds[p];
        let target = if domain.is_sphere() {
            let (x, y, z) = f.sum;
            if x * x + y * y + z * z <= 0.0 {
                continue;
            }
            domain.globe_locate(x, y, z)
        } else {
            domain.advance(s.x, s.y, f.sum.0 / f.area, f.sum.1 / f.area)
        };
        let o = domain.delta(target.x, target.y, s.x, s.y);
        let q = domain.advance(s.x, s.y, o.x * rate, o.y * rate);
        sim.seeds[p].x = q.x;
        sim.seeds[p].y = q.y;
    }
}

/// THE KEEL'S DRAG (TEG-51; DES-0027 entry 2, 2026-10-29). A continent's
/// keel couples its plate to the slower deep mantle: each plate's fitted
/// motion is scaled by 1 / (1 + `keel_drag` · f), f its carried continental
/// area over its footprint's (at most 1). Earth's continental plates move
/// at 10–30 km/Myr, its oceanic ones at 50–100; the measurements are at
/// the constant.
fn keel_factor(f: &Footprint) -> f64 {
    if f.area <= 0.0 {
        return 1.0;
    }
    let share = (f.continental / f.area).min(1.0);
    1.0 / (1.0 + TECTONICS_TUNING.keel_drag * share)
}

/// Returns the continental membership at the ocean age's cells, as the
/// crust stood when the epoch began.
pub fn couple_mantle_to_plates(sim: &mut PlateSimulation) -> Vec<f64> {
    let membership = ocean_age_membership(&sim.meshes.shared, &sim.rafts);
    let footprints = plate_footprints(sim);
    recentre_seeds(sim, &footprints);
    let field = std::mem::take(&mut sim.mantle);
    sim.mantle = evolve_mantle_field(
        field,
        &sim.rafts,
        &sim.meshes.mantle,
        MANTLE_TUNING.diffusion_passes,
    );
    let speed =
        (TECTONICS_TUNING.mantle_flow_speed_km_per_myr * 1000.0) / sim.domain.metres_per_unit;
    let flow = compute_mantle_flow(&sim.mantle, &sim.meshes.mantle, speed);
    let mut fitted = fit_motions_to_flow(&sim.seeds, &flow, &sim.meshes.mantle, &sim.domain);
    for (m, f) in fitted.iter_mut().zip(&footprints) {
        scale_motion(m, keel_factor(f));
    }
    for i in 0..sim.motions.len() {
        relax_motion_toward(
            &mut sim.motions[i],
            &fitted[i],
            TECTONICS_TUNING.mantle_coupling_rate,
        );
    }
    membership
}
