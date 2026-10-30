//! The meteorology of one terrain — temperature, wind, the currents and
//! the sea surface they make, the seasonality and the seasonal rain — per
//! cell of the climate's field mesh, with the defaults of
//! `climateInputParams.ts`.

use crate::fields::field_mesh::SharedFieldMesh;
use crate::planet::planet_forcing::{DEFAULT_PLANET_FORCING, PlanetForcing, hadley_edge};

use super::climate_mesh::ClimateTerrain;
use super::monsoon::{SeasonalPrecipitation, compute_seasonal_precipitation};
use super::ocean_currents::{OceanCurrents, apply_ocean_sst, compute_ocean_currents};
use super::seasonality::compute_seasonal_amplitude;
use super::temperature::compute_temperature;
use super::wind::{CellVectors, compute_wind};

/// The climate panel's controls in model units (`WeatherParams`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WeatherParams {
    /// °C added to the latitudinal band.
    pub temperature_offset: f64,
    /// Equator-to-pole contrast factor, 1 = neutral.
    pub temperature_contrast: f64,
    /// Moisture supply factor, 1 = neutral.
    pub humidity: f64,
    /// Thermal-equator shift as a fraction of half-height.
    pub equator_offset: f64,
    /// The Planet stage's forcing; Earth when absent.
    pub planet: Option<PlanetForcing>,
}

/// The panel's slider defaults in model units: `CLIMATE_INPUTS`' 0 °C,
/// and 100 % contrast and humidity, which `toModel` makes factors of 1.
pub fn default_weather_params() -> WeatherParams {
    WeatherParams {
        temperature_offset: 0.0,
        temperature_contrast: 1.0,
        humidity: 1.0,
        equator_offset: 0.0,
        planet: None,
    }
}

/// The static climate per cell (`WeatherMesh`).
pub struct WeatherMesh {
    pub temperature: Vec<f64>,
    pub wind: CellVectors,
    pub currents: OceanCurrents,
    pub current_anomaly: Vec<f64>,
    pub seasonal_amplitude: Vec<f64>,
    pub seasonal: SeasonalPrecipitation,
}

pub fn compute_weather(
    sh: &mut SharedFieldMesh,
    terrain: &ClimateTerrain,
    params: &WeatherParams,
) -> WeatherMesh {
    let planet = params.planet.unwrap_or(DEFAULT_PLANET_FORCING);
    let mut temperature = compute_temperature(
        sh,
        terrain,
        params.temperature_offset,
        params.temperature_contrast,
        params.equator_offset,
        &planet,
    );
    let wind = compute_wind(
        &terrain.cm,
        &sh.mesh,
        params.equator_offset,
        planet.rotation_hours,
        0.0,
    );
    let currents = compute_ocean_currents(sh, terrain, &wind, params.equator_offset);
    let current_anomaly = apply_ocean_sst(
        sh,
        terrain,
        &mut temperature,
        &currents.e,
        &currents.s,
        &wind,
    );
    let seasonal_amplitude =
        compute_seasonal_amplitude(&sh.mesh, terrain, params.equator_offset, &planet);
    let seasonal = compute_seasonal_precipitation(
        sh,
        terrain,
        &temperature,
        &seasonal_amplitude,
        &wind,
        params.humidity,
        params.equator_offset,
        hadley_edge(planet.rotation_hours),
    );
    WeatherMesh {
        temperature,
        wind,
        currents,
        current_anomaly,
        seasonal_amplitude,
        seasonal,
    }
}
