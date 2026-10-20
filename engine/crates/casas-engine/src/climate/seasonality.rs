//! `climate/seasonality.ts`: the annual temperature amplitude per land cell
//! of the climate's field mesh, from latitude and continentality.

use crate::core::js;
use crate::fields::field_mesh::FieldMesh;
use crate::planet::planet_forcing::{PlanetForcing, seasonality_factor};

use super::climate_field::{latitude_of_norm, shifted_norm};
use super::climate_mesh::{ClimateTerrain, distance_to_sea};
use super::climate_tune_params::CLIMATE_TUNING;

/// The sea's sentinel: seasonality is a land field.
pub const OCEAN_AMPLITUDE: f64 = -1.0;

fn compute_continentality(fm: &FieldMesh, land: &[u8]) -> Vec<f64> {
    let (dist, _) = distance_to_sea(fm, land);
    dist.iter()
        .map(|&d| {
            if d == f64::INFINITY {
                1.0
            } else {
                js::min(1.0, d / CLIMATE_TUNING.season_continentality_scale_m)
            }
        })
        .collect()
}

/// The annual amplitude (summer − winter), °C per cell; OCEAN_AMPLITUDE on
/// the sea.
pub fn compute_seasonal_amplitude(
    fm: &FieldMesh,
    terrain: &ClimateTerrain,
    equator_offset: f64,
    planet: &PlanetForcing,
) -> Vec<f64> {
    let t = &CLIMATE_TUNING;
    let continentality = compute_continentality(fm, &terrain.land);
    (0..fm.count)
        .map(|i| {
            if terrain.land[i] == 0 {
                return OCEAN_AMPLITUDE;
            }
            let y_norm = shifted_norm(terrain.cm.y_norm[i], equator_offset);
            let phi = latitude_of_norm(y_norm);
            let amp_lat = t.season_max_amplitude * phi * seasonality_factor(planet, y_norm < 0.5);
            amp_lat * (t.season_coast_damp + (1.0 - t.season_coast_damp) * continentality[i])
        })
        .collect()
}
