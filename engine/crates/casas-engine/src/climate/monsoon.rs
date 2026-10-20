//! `climate/monsoon.ts`: seasonal precipitation and the signed monsoon
//! index — the precipitation model run for the two opposite seasons, each
//! with its shifted rain belt and its land-sea monsoon wind. The
//! TypeScript file explains the index's sign.

use crate::fields::field_mesh::SharedFieldMesh;
use crate::fields::field_operators::gradient;

use super::climate_field::shifted_norm;
use super::climate_mesh::ClimateTerrain;
use super::climate_tune_params::CLIMATE_TUNING;
use super::precipitation::{OCEAN_PRECIP, compute_precipitation};
use super::seasonality::OCEAN_AMPLITUDE;
use super::wind::CellVectors;

fn seasonal_temperature(
    terrain: &ClimateTerrain,
    annual: &[f64],
    amplitude: &[f64],
    equator_offset: f64,
    warm_north: bool,
) -> Vec<f64> {
    (0..annual.len())
        .map(|i| {
            let north = shifted_norm(terrain.cm.y_norm[i], equator_offset) < 0.5;
            let sign = if north == warm_north { 0.5 } else { -0.5 };
            let swing = if amplitude[i] == OCEAN_AMPLITUDE {
                0.0
            } else {
                amplitude[i]
            };
            annual[i] + sign * swing
        })
        .collect()
}

fn compute_monsoon_wind(
    sh: &SharedFieldMesh,
    base: &CellVectors,
    seasonal_temp: &[f64],
) -> CellVectors {
    let fm = &sh.mesh;
    let n = fm.count;
    let mut ge = vec![0.0; n];
    let mut gs = vec![0.0; n];
    gradient(fm, seasonal_temp, &mut ge, &mut gs);
    let k = CLIMATE_TUNING.monsoon_wind_strength * CLIMATE_TUNING.climate_gradient_length_m;
    CellVectors {
        e: (0..n).map(|i| base.e[i] + k * ge[i]).collect(),
        s: (0..n).map(|i| base.s[i] + k * gs[i]).collect(),
    }
}

/// Per cell: the annual mean precipitation (mm/yr, OCEAN_PRECIP on the sea)
/// and the signed seasonality index (+ the wet season in the top
/// hemisphere's summer).
#[derive(Clone, Debug, PartialEq)]
pub struct SeasonalPrecipitation {
    pub annual: Vec<f64>,
    pub index: Vec<f64>,
}

/// The seasonality index's magnitude, the sea's sentinel kept.
pub fn seasonality_magnitude(index: &[f32]) -> Vec<f32> {
    index
        .iter()
        .map(|&v| {
            if v as f64 == OCEAN_PRECIP {
                OCEAN_PRECIP as f32
            } else {
                v.abs()
            }
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
pub fn compute_seasonal_precipitation(
    sh: &mut SharedFieldMesh,
    terrain: &ClimateTerrain,
    annual_temp: &[f64],
    amplitude: &[f64],
    base_wind: &CellVectors,
    humidity: f64,
    equator_offset: f64,
    edge: f64,
) -> SeasonalPrecipitation {
    let t = &CLIMATE_TUNING;
    let temp_n = seasonal_temperature(terrain, annual_temp, amplitude, equator_offset, true);
    let temp_s = seasonal_temperature(terrain, annual_temp, amplitude, equator_offset, false);
    let wind_n = compute_monsoon_wind(sh, base_wind, &temp_n);
    let wind_s = compute_monsoon_wind(sh, base_wind, &temp_s);
    let precip_n = compute_precipitation(
        sh,
        terrain,
        &temp_n,
        &wind_n,
        humidity,
        equator_offset,
        t.monsoon_itcz_seasonal_shift,
        None,
        edge,
    );
    let precip_s = compute_precipitation(
        sh,
        terrain,
        &temp_s,
        &wind_s,
        humidity,
        equator_offset,
        -t.monsoon_itcz_seasonal_shift,
        None,
        edge,
    );
    let n = precip_n.len();
    let mut annual = vec![0.0; n];
    let mut index = vec![0.0; n];
    for i in 0..n {
        if precip_n[i] == OCEAN_PRECIP || precip_s[i] == OCEAN_PRECIP {
            annual[i] = OCEAN_PRECIP;
            index[i] = OCEAN_PRECIP;
            continue;
        }
        let (a, b) = (precip_n[i], precip_s[i]);
        annual[i] = (a + b) / 2.0;
        index[i] = (a - b) / (a + b + t.monsoon_seasonality_floor);
    }
    SeasonalPrecipitation { annual, index }
}
