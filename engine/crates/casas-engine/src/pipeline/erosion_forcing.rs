//! `pipeline/erosionForcing.ts`: the erosion forcing's coarse fields from
//! the tectonic state. Not ported: `assembleErosionForcing`, the raster
//! solver's assembly with the climate as water, which only the measuring
//! scripts run.

use crate::climate::climate_field::{CLIMATE_RES_X, CLIMATE_RES_Y};
use crate::core::domain::Domain;
use crate::core::world_time::world_epoch;
use crate::crust::raft_types::{Raft, Suture};
use crate::elevation::erodibility_field::{
    DEFAULT_ERODIBILITY_FIELD_PARAMS, compute_erodibility_field,
};
use crate::elevation::uplift_field::compute_uplift_field;
use crate::tectonics::plate_simulation_types::{PlateSimulation, PlateSimulationSnapshot};
use crate::tectonics::terrain_features::TerrainFeature;

/// The two coarse forcing fields at the climate's chart size: U from the
/// features' activity, the hardness from the crust's history.
pub struct CoarseForcingFields {
    pub uplift: Vec<f32>,
    pub hardness: Vec<f32>,
}

pub fn coarse_forcing_fields(sim: &PlateSimulation, domain: &Domain) -> CoarseForcingFields {
    coarse_forcing_of(
        &sim.features,
        &sim.rafts,
        &sim.sutures,
        sim.epoch,
        sim.archean_epochs,
        domain,
    )
}

/// The same from a save's snapshot, as a reader of the save derives it
/// (docs/decisions/rust-engine.md, fork 7b): the tile bakes erode with it,
/// and the terrain's id hashes it. No simulation is made for it.
pub fn coarse_forcing_of_snapshot(
    snap: &PlateSimulationSnapshot,
    domain: &Domain,
) -> CoarseForcingFields {
    coarse_forcing_of(
        &snap.features,
        &snap.rafts,
        snap.sutures.as_deref().unwrap_or(&[]),
        snap.epoch,
        snap.archean_epochs.unwrap_or(0.0),
        domain,
    )
}

fn coarse_forcing_of(
    features: &[TerrainFeature],
    rafts: &[Raft],
    sutures: &[Suture],
    epoch: f64,
    archean_epochs: f64,
    domain: &Domain,
) -> CoarseForcingFields {
    let uplift = compute_uplift_field(features, domain, CLIMATE_RES_X, CLIMATE_RES_Y);
    let hardness = compute_erodibility_field(
        rafts,
        sutures,
        features,
        world_epoch(archean_epochs, epoch),
        archean_epochs,
        domain,
        CLIMATE_RES_X,
        CLIMATE_RES_Y,
        &DEFAULT_ERODIBILITY_FIELD_PARAMS,
    );
    CoarseForcingFields { uplift, hardness }
}
