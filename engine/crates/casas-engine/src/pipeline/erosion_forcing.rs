//! `pipeline/erosionForcing.ts`: the erosion forcing's coarse fields from
//! the tectonic state. Not ported: `assembleErosionForcing`, the raster
//! solver's assembly with the climate as water, which only the measuring
//! scripts run.

use crate::climate::climate_field::{CLIMATE_RES_X, CLIMATE_RES_Y};
use crate::core::domain::Domain;
use crate::core::world_time::world_epoch;
use crate::elevation::erodibility_field::{
    DEFAULT_ERODIBILITY_FIELD_PARAMS, compute_erodibility_field,
};
use crate::elevation::uplift_field::compute_uplift_field;
use crate::tectonics::plate_simulation_types::PlateSimulation;

/// The two coarse forcing fields at the climate's chart size: U from the
/// features' activity, the hardness from the crust's history.
pub struct CoarseForcingFields {
    pub uplift: Vec<f32>,
    pub hardness: Vec<f32>,
}

pub fn coarse_forcing_fields(sim: &PlateSimulation, domain: &Domain) -> CoarseForcingFields {
    let uplift = compute_uplift_field(&sim.features, domain, CLIMATE_RES_X, CLIMATE_RES_Y);
    let hardness = compute_erodibility_field(
        &sim.rafts,
        &sim.sutures,
        &sim.features,
        world_epoch(sim.archean_epochs, sim.epoch),
        sim.archean_epochs,
        domain,
        CLIMATE_RES_X,
        CLIMATE_RES_Y,
        &DEFAULT_ERODIBILITY_FIELD_PARAMS,
    );
    CoarseForcingFields { uplift, hardness }
}
