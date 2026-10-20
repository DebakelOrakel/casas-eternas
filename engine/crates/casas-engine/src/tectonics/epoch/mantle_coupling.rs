//! `tectonics/epoch/mantleCoupling.ts`, phase 0: the mantle drives the
//! plates. The field evolves under the crust, its flow is fitted, and each
//! plate's motion relaxes toward the fit.

use crate::mantle::mantle_field::{compute_mantle_flow, evolve_mantle_field};
use crate::mantle::mantle_tune_params::MANTLE_TUNING;
use crate::tectonics::ocean_age::ocean_age_membership;
use crate::tectonics::plate_motion::{fit_motions_to_flow, relax_motion_toward};
use crate::tectonics::plate_simulation_types::PlateSimulation;
use crate::tectonics::tectonics_tune_params::TECTONICS_TUNING;

/// Returns the continental membership at the ocean age's cells, as the
/// crust stood when the epoch began.
pub fn couple_mantle_to_plates(sim: &mut PlateSimulation) -> Vec<f64> {
    let membership = ocean_age_membership(&sim.meshes.shared, &sim.rafts);
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
    let fitted = fit_motions_to_flow(&sim.seeds, &flow, &sim.meshes.mantle, &sim.domain);
    for i in 0..sim.motions.len() {
        relax_motion_toward(
            &mut sim.motions[i],
            &fitted[i],
            TECTONICS_TUNING.mantle_coupling_rate,
        );
    }
    membership
}
