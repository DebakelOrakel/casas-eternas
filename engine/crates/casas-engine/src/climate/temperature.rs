//! The base air temperature per cell of the climate's field mesh — the
//! latitude's profile (area-neutral contrast and tilt), the lapse, the mass
//! elevation effect on land.
//!
//! The pivot is AREA-NEUTRAL (DEC-0036 phase 8b-2): a contrast or a tilt
//! changes the gradient and keeps the world's area-weighted mean. It was
//! cos φ = ½, the latitude 60°, while the sphere's mean of cos φ is π/4:
//! contrast 60 / 140 % moved the sphere's mean temperature by −6 / +6 °C
//! and obliquity 10 / 35° by +4 / −5 °C (phase 8a) — a greenhouse, not a
//! contrast. The tilt's gradient is the annual insolation's
//! (`obliquity_contrast`), whose global mean the tilt does not change.

use crate::core::det_math::det_cos;
use crate::core::domain::Domain;
use crate::core::js;
use crate::elevation::elevation_scale::{ELEVATION_METERS, SEA_LEVEL};
use crate::fields::field_mesh::SharedFieldMesh;
use crate::fields::field_operators::smooth_gaussian;
use crate::planet::planet_forcing::{
    PlanetForcing, obliquity_contrast, solar_temperature_offset_c,
};

use super::climate_field::{CLIMATE_RES_Y, latitude_of_norm, shifted_norm};
use super::climate_mesh::ClimateTerrain;
use super::climate_tune_params::CLIMATE_TUNING;

use std::f64::consts::PI;

/// The latitudinal base at a latitude (0 equator … 1 pole), °C, before the
/// global offset: the pole's temperature plus the span times the profile's
/// shape, cos φ, the contrast and the tilt scaling the shape's departure
/// from its area mean (`profile_pivot`). Contrast 0 is a uniform world at
/// that mean, 1 the original span.
pub fn base_temperature_at_latitude(
    lat: f64,
    contrast: f64,
    planet: &PlanetForcing,
    sphere: bool,
) -> f64 {
    let t = &CLIMATE_TUNING;
    let span = t.temp_equator_c - t.temp_pole_c;
    let pivot = profile_pivot(sphere);
    let gradient = contrast * obliquity_contrast(planet.obliquity_deg);
    t.temp_pole_c + span * pivot + gradient * span * (det_cos((lat * PI) / 2.0) - pivot)
}

/// The area mean of cos φ over a shape's latitudes: on the sphere, where a
/// latitude's area goes as cos φ, ∫cos²φ / ∫cos φ = π/4; on the torus,
/// whose rows all hold one area, ∫cos φ dφ / (π/2) = 2/π.
pub fn profile_pivot(sphere: bool) -> f64 {
    if sphere { PI / 4.0 } else { 2.0 / PI }
}

/// The sea-level temperature per climate chart row, °C, offset included:
/// the band a flat sea has at each latitude, nothing of the terrain — what
/// the map's temperature scale shows (`seaLevelTemperatureBand` of the
/// bindings).
pub fn sea_level_temperature_band(
    offset_c: f64,
    contrast: f64,
    planet: &PlanetForcing,
    sphere: bool,
) -> Vec<f32> {
    let offset = offset_c + solar_temperature_offset_c(planet.solar_constant);
    let chart = Domain::torus(256.0, CLIMATE_RES_Y as f64);
    (0..CLIMATE_RES_Y)
        .map(|gy| {
            let lat = chart.latitude((gy as f64 + 0.5) / CLIMATE_RES_Y as f64);
            (base_temperature_at_latitude(lat, contrast, planet, sphere) + offset) as f32
        })
        .collect()
}

/// The air temperature per cell, °C.
pub fn compute_temperature(
    sh: &SharedFieldMesh,
    terrain: &ClimateTerrain,
    offset_c: f64,
    contrast: f64,
    equator_offset: f64,
    planet: &PlanetForcing,
) -> Vec<f64> {
    let t = &CLIMATE_TUNING;
    let fm = &sh.mesh;
    let n = fm.count;
    let sphere = fm.domain.is_sphere();
    let mut temperature = vec![0.0; n];
    let offset = offset_c + solar_temperature_offset_c(planet.solar_constant);
    let mut plateau_km = vec![0.0; n];
    for i in 0..n {
        let base = base_temperature_at_latitude(
            latitude_of_norm(shifted_norm(terrain.cm.y_norm[i], equator_offset)),
            contrast,
            planet,
            sphere,
        );
        let e = terrain.z[i];
        let value = base
            - t.lapse_c_per_elevation
                * if terrain.dry[i] != 0 {
                    e - SEA_LEVEL
                } else {
                    js::max(0.0, e - SEA_LEVEL)
                };
        temperature[i] = value + offset;
        if terrain.land[i] != 0 {
            plateau_km[i] = js::max(0.0, (e - SEA_LEVEL) * ELEVATION_METERS / 1000.0);
        }
    }
    if t.temp_plateau_c_per_km > 0.0 {
        let plateau_km = smooth_gaussian(fm, &plateau_km, t.temp_plateau_sigma_m);
        for i in 0..n {
            if terrain.land[i] != 0 {
                temperature[i] += t.temp_plateau_c_per_km * plateau_km[i];
            }
        }
    }
    temperature
}
