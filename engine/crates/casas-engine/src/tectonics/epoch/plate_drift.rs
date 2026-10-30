//! Phase 1: every plate advanced and all that rides on it (rafts,
//! sutures, features, the ocean age), the crust recycled, the features
//! decayed, the plumes moved and the hotspots' volcanoes deposited.

use crate::core::det_math::{det_hypot, det_pow};
use crate::core::world_time::{TECTONIC_MA_PER_EPOCH, world_age_ma, world_epoch_ma};
use crate::crust::raft_field::derive_plate_types;
use crate::crust::raft_lifecycle::{advance_rafts, recycle_unstabilised_crust};
use crate::mantle::mantle_field::mantle_at;
use crate::tectonics::ocean_age::advect_ocean_age;
use crate::tectonics::plate_motion::{advance_point_by_motion, get_velocity_at};
use crate::tectonics::plate_seeds::PlateSeed;
use crate::tectonics::plate_simulation_types::PlateSimulation;
use crate::tectonics::plumes::advance_plumes;
use crate::tectonics::tectonics_tune_params::TECTONICS_TUNING as T;
use crate::tectonics::terrain_features::{
    FeatureKind, MovesWith, advance_terrain_features, find_or_create_feature_index,
};

fn nearest(seeds: &[PlateSeed], x: f64, y: f64, sim_domain: &crate::core::domain::Domain) -> usize {
    let mut best = 0;
    let mut best_sq = f64::INFINITY;
    for (p, s) in seeds.iter().enumerate() {
        let d = sim_domain.distance_sq(x, y, s.x, s.y);
        if d < best_sq {
            best_sq = d;
            best = p;
        }
    }
    best
}

/// Each hotspot's volcano onto the plate over it, along the plate's motion.
fn deposit_hotspot_volcanoes(sim: &mut PlateSimulation) {
    let domain = &sim.domain;
    for hs in &sim.hotspots {
        let plate = nearest(&sim.seeds, hs.x, hs.y, domain);
        let v = get_velocity_at(hs.x, hs.y, &sim.motions[plate], domain);
        let speed = det_hypot(v.x, v.y);
        let speed = if speed == 0.0 || speed.is_nan() {
            1.0
        } else {
            speed
        };
        let idx = find_or_create_feature_index(
            &mut sim.features,
            hs.x,
            hs.y,
            plate as i32,
            -1,
            MovesWith::Plate(plate as u32),
            v.x / speed,
            v.y / speed,
            FeatureKind::Range,
            true,
            domain,
        );
        sim.features[idx].thickness += T.hotspot_deposit_per_epoch;
        sim.features[idx].epochs_since_deposit = 0.0;
    }
}

pub fn advance_plates_and_crust(sim: &mut PlateSimulation, membership: &[f64]) {
    let step_ma = if sim.epoch_ma == 0.0 || sim.epoch_ma.is_nan() {
        TECTONIC_MA_PER_EPOCH
    } else {
        sim.epoch_ma
    };
    let previous_seeds = sim.seeds.clone();
    for i in 0..sim.seeds.len() {
        let p = advance_point_by_motion(
            sim.seeds[i].x,
            sim.seeds[i].y,
            &sim.motions[i],
            step_ma,
            &sim.domain,
        );
        sim.seeds[i].x = p.x;
        sim.seeds[i].y = p.y;
        sim.ages[i] += 1.0;
    }
    advance_rafts(
        &mut sim.rafts,
        &sim.seeds,
        &sim.motions,
        step_ma,
        &sim.domain,
    );
    let now_ma = world_age_ma(sim.archean_epochs, sim.epoch);
    {
        let archean = sim.archean_epochs;
        let mantle = &sim.mantle;
        let mm = &mut sim.meshes.mantle;
        recycle_unstabilised_crust(
            &mut sim.rafts,
            &mut |x, y| mantle_at(mm, mantle, x, y),
            &|birth| (now_ma - world_epoch_ma(birth, archean)) / TECTONIC_MA_PER_EPOCH,
            T.stabilisation_epochs,
            T.recycle_downwelling_threshold,
        );
    }
    for s in sim.sutures.iter_mut() {
        let host = nearest(&sim.seeds, s.x, s.y, &sim.domain);
        let p = advance_point_by_motion(s.x, s.y, &sim.motions[host], step_ma, &sim.domain);
        let t = sim
            .domain
            .transport(s.tangent_x, s.tangent_y, s.x, s.y, p.x, p.y);
        s.x = p.x;
        s.y = p.y;
        s.tangent_x = t.x;
        s.tangent_y = t.y;
    }
    sim.types = derive_plate_types(&sim.seeds, &sim.rafts, &sim.domain);
    let age = std::mem::take(&mut sim.ocean_age);
    sim.ocean_age = advect_ocean_age(
        &mut sim.meshes.ocean,
        &mut sim.meshes.shared,
        &age,
        &sim.seeds,
        &sim.motions,
        step_ma,
        membership,
        Some(&previous_seeds),
    );
    advance_terrain_features(&mut sim.features, &sim.motions, step_ma, &sim.domain);
    let shortening_keep = det_pow(2.0, -step_ma / T.shortening_half_life_ma);
    for f in sim.features.iter_mut() {
        // `if (shorteningKmPerMyr)`: neither absent, 0 nor NaN.
        if let Some(s) = f.shortening_km_per_myr
            && s != 0.0
            && !s.is_nan()
        {
            f.shortening_km_per_myr = Some(s * shortening_keep);
        }
        f.thickness *= T.thickness_decay_per_epoch;
        if f.subsides && f.epochs_since_deposit > 0.0 {
            f.thickness *= T.oceanic_subsidence_decay_per_epoch;
        }
        f.epochs_since_deposit += 1.0;
    }
    advance_plumes(
        &mut sim.hotspots,
        &sim.mantle,
        &mut sim.meshes.mantle,
        &sim.domain,
        sim.epoch,
    );
    if sim.epoch % T.hotspot_epoch_interval == 0.0 {
        deposit_hotspot_volcanoes(sim);
    }
}
