//! `planet/planetForcing.ts` with the defaults of `planetInputParams.ts`:
//! the astronomical controls as the factors the climate chain multiplies
//! in, each 1 at Earth's values. The TypeScript files explain each.

use crate::core::det_math::{det_cos, det_pow, det_sin, sq};
use crate::core::js;

/// The Planet stage's slider defaults (`PLANET_INPUTS`).
pub const DEFAULT_OBLIQUITY_DEG: f64 = 23.5;
pub const DEFAULT_GREENHOUSE_C: f64 = 0.0;
pub const DEFAULT_ROTATION_HOURS: f64 = 24.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlanetForcing {
    pub obliquity_deg: f64,
    /// Fraction, not percent.
    pub eccentricity: f64,
    pub precession_deg: f64,
    /// Fraction of Earth's solar constant.
    pub solar_constant: f64,
    pub rotation_hours: f64,
    /// The world age in Myr from which vegetation covers the land.
    pub land_plants_from_ma: f64,
}

pub const EARTH_ECCENTRICITY: f64 = 0.0167;
pub const EQUINOX_PERIHELION_DEG: f64 = 90.0;
pub const EARTH_SOLAR_CONSTANT: f64 = 1.0;

pub const DEFAULT_PLANET_FORCING: PlanetForcing = PlanetForcing {
    obliquity_deg: DEFAULT_OBLIQUITY_DEG,
    eccentricity: EARTH_ECCENTRICITY,
    precession_deg: EQUINOX_PERIHELION_DEG,
    solar_constant: EARTH_SOLAR_CONSTANT,
    rotation_hours: DEFAULT_ROTATION_HOURS,
    land_plants_from_ma: 0.0,
};

const RAD: f64 = std::f64::consts::PI / 180.0;

/// The annual-mean insolation gradient's factor, (2 − 3 sin²ε), relative to
/// the default tilt.
pub fn obliquity_contrast(obliquity_deg: f64) -> f64 {
    let s = |deg: f64| 2.0 - 3.0 * sq(det_sin(deg * RAD));
    s(obliquity_deg) / s(DEFAULT_OBLIQUITY_DEG)
}

/// The mean temperature shift of a different sun, °C.
pub fn solar_temperature_offset_c(solar_constant: f64) -> f64 {
    255.0 * (det_pow(js::max(0.01, solar_constant), 0.25) - 1.0)
}

/// The seasonal amplitude's factor of one hemisphere.
pub fn seasonality_factor(forcing: &PlanetForcing, north: bool) -> f64 {
    let tilt = det_sin(forcing.obliquity_deg * RAD) / det_sin(DEFAULT_OBLIQUITY_DEG * RAD);
    let bias = 2.0 * forcing.eccentricity * det_cos(forcing.precession_deg * RAD);
    js::max(0.0, tilt * (1.0 + if north { bias } else { -bias }))
}

/// Where the Hadley cell ends, as a fraction of the equator-to-pole span.
pub fn hadley_edge(rotation_hours: f64) -> f64 {
    let edge = (1.0 / 3.0) * (rotation_hours / DEFAULT_ROTATION_HOURS);
    js::min(0.9, js::max(0.1, edge))
}
