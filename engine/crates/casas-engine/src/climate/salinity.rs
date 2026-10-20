//! `climate/salinity.ts`: the sea surface's salt from its fresh-water
//! budget, carried by the currents, and where the cold salty water sinks.
//! The TypeScript file explains the budget and the sinking rule.

use crate::core::js;
use crate::fields::field_mesh::SharedFieldMesh;
use crate::fields::field_operators::transport_scalar;

use super::climate_field::{latitude_of_norm, shifted_norm};
use super::climate_mesh::{ClimateTerrain, distance_to_sea, zonal_mean};
use super::climate_tune_params::CLIMATE_TUNING;
use super::ocean_currents::current_departures;
use super::precipitation::{band_factor, evaporation};
use super::wind::CellVectors;

pub struct Salinity {
    pub salinity: Vec<f64>,
    pub deep_water: Vec<f64>,
}

#[allow(clippy::too_many_arguments)]
pub fn compute_salinity(
    sh: &mut SharedFieldMesh,
    terrain: &ClimateTerrain,
    sea_temperature: &[f64],
    land_rain: &[f64],
    currents: &CellVectors,
    equator_offset: f64,
    humidity: f64,
    edge: f64,
) -> Salinity {
    let t = &CLIMATE_TUNING;
    let land = &terrain.land;
    let n = sh.mesh.count;
    let lat: Vec<f64> = (0..n)
        .map(|i| latitude_of_norm(shifted_norm(terrain.cm.y_norm[i], equator_offset)))
        .collect();
    let sea_rain: Vec<f64> = (0..n)
        .map(|i| {
            if land[i] != 0 {
                0.0
            } else {
                t.salinity_sea_rain_mm
                    * band_factor(lat[i], edge)
                    * evaporation(sea_temperature[i])
                    * humidity
            }
        })
        .collect();
    let (_, nearest) = distance_to_sea(&sh.mesh, land);
    let mut river_in = vec![0.0; n];
    for i in 0..n {
        if land[i] == 0 || land_rain[i] < 0.0 || nearest[i] < 0 {
            continue;
        }
        let surplus = land_rain[i]
            - t.salinity_evap_mm * t.salinity_land_evap_share * evaporation(sea_temperature[i]);
        if surplus > 0.0 {
            let j = nearest[i] as usize;
            river_in[j] += (surplus * sh.mesh.area[i]) / sh.mesh.area[j];
        }
    }
    let mut budget = vec![0.0; n];
    for i in 0..n {
        if land[i] != 0 {
            continue;
        }
        let fresh =
            sea_rain[i] + river_in[i] - t.salinity_evap_mm * evaporation(sea_temperature[i]);
        budget[i] = -fresh * t.salinity_psu_per_mm;
        if sea_temperature[i] < t.ebm_sea_ice_below_c {
            budget[i] += t.salinity_brine_psu;
        }
    }
    let dep = current_departures(sh, &currents.e, &currents.s);
    let mut salinity = vec![t.salinity_mean_psu; n];
    let mut next = vec![0.0; n];
    for _ in 0..t.salinity_iters as usize {
        transport_scalar(&sh.mesh, &dep, &salinity, &mut next, None, false);
        for i in 0..n {
            next[i] = if land[i] != 0 {
                t.salinity_mean_psu
            } else {
                next[i] * (1.0 - t.salinity_relax)
                    + t.salinity_mean_psu * t.salinity_relax
                    + budget[i]
            };
        }
        std::mem::swap(&mut salinity, &mut next);
    }
    for i in 0..n {
        salinity[i] = if land[i] != 0 {
            0.0
        } else {
            js::max(t.salinity_min_psu, js::min(t.salinity_max_psu, salinity[i]))
        };
    }
    let mean = zonal_mean(&terrain.cm, &sh.mesh, &salinity, Some(&|i| land[i] == 0));
    let mut deep_water = vec![0.0; n];
    for i in 0..n {
        if land[i] != 0 || lat[i] * 90.0 < t.deep_water_min_lat_deg {
            continue;
        }
        let surface = js::max(t.sea_freezes_c, sea_temperature[i]);
        let cold = js::min(
            1.0,
            js::max(
                0.0,
                (t.deep_water_below_c - surface) / (t.deep_water_below_c - t.sea_freezes_c),
            ),
        );
        let salty = js::min(
            1.0,
            js::max(0.0, (salinity[i] - mean[i]) / t.deep_water_full_anomaly_psu),
        );
        deep_water[i] = cold * salty;
    }
    Salinity {
        salinity,
        deep_water,
    }
}
