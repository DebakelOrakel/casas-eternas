//! `tectonics/plateSimulation.ts`: persisting a world and running an epoch
//! of it. The epoch's six phases are in `epoch/`; `step_epoch` is their
//! order.

use crate::core::domain::Domain;
use crate::core::js::{to_int32, to_uint32};
use crate::core::rng::Mulberry32;
use crate::crust::raft_field::derive_plate_types;
use crate::fields::field_mesh::SavedField;
use crate::mantle::mantle_field::{
    DEFAULT_INITIAL_SMOOTHING, create_mantle_field, restore_mantle_field,
};
use crate::tectonics::plate_motion::PlateMotion;

use super::boundary_lattice::generate_detection_lattice;
use super::epoch::boundary_pass::run_boundary_pass;
use super::epoch::feature_pruning::prune_spent_features;
use super::epoch::mantle_coupling::couple_mantle_to_plates;
use super::epoch::plate_churn::collect_events_and_apply_plate_churn;
use super::epoch::plate_drift::advance_plates_and_crust;
use super::epoch::raft_events::apply_raft_events;
use super::ocean_age::restore_ocean_age;
use super::plate_simulation_types::{
    PlateSimulation, PlateSimulationSnapshot, SimEvent, WorldMeshes,
};
use super::tectonics_tune_params::TECTONICS_TUNING;

/// The snapshot a save holds of the simulation (its own arrays copied).
pub fn serialize_plate_simulation(sim: &PlateSimulation) -> PlateSimulationSnapshot {
    PlateSimulationSnapshot {
        epoch_ma: Some(sim.epoch_ma),
        sediment_export_m3: Some(sim.sediment_export_m3),
        eustatic_m: Some(sim.eustatic_m),
        climate_history: Some(sim.climate_history.clone()),
        lake_ages: Some(sim.lake_ages.clone()),
        archean_epochs: Some(sim.archean_epochs),
        width: sim.width,
        height: sim.height,
        initial_plate_count: sim.initial_plate_count,
        seeds: sim.seeds.clone(),
        motions: sim.motions.clone(),
        ages: sim.ages.clone(),
        rafts: sim.rafts.clone(),
        features: sim.features.clone(),
        epoch: sim.epoch,
        warp_seed: sim.warp_seed,
        supercontinent_active: sim.supercontinent_active,
        continental_rift_cooldown_until: sim.continental_rift_cooldown_until,
        hotspots: Some(sim.hotspots.clone()),
        sutures: Some(sim.sutures.clone()),
        rng_state: sim.random.state(),
    }
}

/// The simulation from a snapshot, its ocean age and (when the save holds
/// one) its mantle. `domain` is the world's shape on the snapshot's size;
/// `meshes` the world's field meshes on it (fresh for a world just read, or
/// the ones an earlier phase moved).
pub fn deserialize_plate_simulation(
    snap: &PlateSimulationSnapshot,
    ocean_age: &SavedField,
    mantle: Option<&SavedField>,
    domain: Domain,
    meshes: WorldMeshes,
) -> Result<PlateSimulation, String> {
    let lattice = generate_detection_lattice(
        &domain,
        TECTONICS_TUNING.detection_lattice_resolution_x,
        TECTONICS_TUNING.detection_lattice_resolution_y,
    );
    let n = lattice.len();
    let ocean_age = restore_ocean_age(&meshes.ocean, &meshes.shared, ocean_age)?;
    let mantle = match restore_mantle_field(&meshes.mantle, mantle)? {
        Some(m) => m,
        None => {
            let mut rng = Mulberry32::new(to_uint32(
                (to_int32(snap.warp_seed) ^ 0x5bd1e995u32 as i32) as f64,
            ));
            create_mantle_field(
                &mut || rng.next(),
                &meshes.mantle,
                DEFAULT_INITIAL_SMOOTHING,
            )
        }
    };
    let types = derive_plate_types(&snap.seeds, &snap.rafts, &domain);
    Ok(PlateSimulation {
        width: snap.width,
        height: snap.height,
        domain,
        meshes,
        epoch_ma: snap.epoch_ma.unwrap_or(1.0),
        sediment_export_m3: snap.sediment_export_m3.unwrap_or(0.0),
        eustatic_m: snap.eustatic_m.unwrap_or(0.0),
        climate_history: snap.climate_history.clone().unwrap_or_default(),
        lake_ages: snap.lake_ages.clone().unwrap_or_default(),
        initial_plate_count: snap.initial_plate_count,
        seeds: snap.seeds.clone(),
        rafts: snap.rafts.clone(),
        types,
        motions: snap.motions.clone(),
        ages: snap.ages.clone(),
        features: snap.features.clone(),
        epoch: snap.epoch,
        archean_epochs: snap.archean_epochs.unwrap_or(0.0),
        random: Mulberry32::new(snap.rng_state),
        warp_seed: snap.warp_seed,
        lattice,
        lattice_accumulated: vec![0.0; n],
        lattice_locked_epochs: vec![0; n],
        lattice_last_class_code: vec![-1; n],
        ocean_age,
        supercontinent_active: snap.supercontinent_active,
        continental_rift_cooldown_until: snap.continental_rift_cooldown_until,
        mantle,
        hotspots: snap.hotspots.clone().unwrap_or_default(),
        sutures: snap.sutures.clone().unwrap_or_default(),
    })
}

/// One epoch: the six phases in their order.
pub fn step_epoch(sim: &mut PlateSimulation) -> Vec<SimEvent> {
    step_epoch_coupled(sim).0
}

/// `step_epoch`, and the plates' motions as the mantle's coupling left
/// them, by the index the plates had before the step. TypeScript's coupled
/// epoch keeps the motion objects of before the step (a shallow copy) and
/// reads them after it: the coupling changes them in place, the churn only
/// appends and removes.
pub fn step_epoch_coupled(sim: &mut PlateSimulation) -> (Vec<SimEvent>, Vec<PlateMotion>) {
    let membership = couple_mantle_to_plates(sim);
    let coupled = sim.motions.clone();
    advance_plates_and_crust(sim, &membership);
    let pass = run_boundary_pass(sim);
    let rafts = apply_raft_events(sim, &pass);
    let events = collect_events_and_apply_plate_churn(sim, &pass, &rafts);
    prune_spent_features(sim);
    sim.epoch += 1.0;
    (events, coupled)
}
