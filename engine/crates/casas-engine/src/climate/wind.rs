//! `climate/wind.ts`: the prevailing surface wind as the three-cell
//! pattern per hemisphere, per cell of the climate's field mesh, east and
//! south in each cell's frame (1 = 8 m/s).

use crate::core::det_math::det_sin;
use crate::fields::field_mesh::FieldMesh;
use crate::planet::planet_forcing::hadley_edge;

use super::climate_field::{belt_y_norm, shifted_norm};
use super::climate_mesh::ClimateMesh;
use super::climate_tune_params::CLIMATE_TUNING;

/// A vector field per cell: east and south in the cell's frame.
#[derive(Clone, Debug, PartialEq)]
pub struct CellVectors {
    pub e: Vec<f64>,
    pub s: Vec<f64>,
}

/// The banded wind; `belt_shift` the season's shift of the cells (0, the
/// year's mean position).
pub fn compute_wind(
    cm: &ClimateMesh,
    fm: &FieldMesh,
    equator_offset: f64,
    rotation_hours: f64,
    belt_shift: f64,
) -> CellVectors {
    let t = &CLIMATE_TUNING;
    let n = fm.count;
    let mut wind = CellVectors {
        e: vec![0.0; n],
        s: vec![0.0; n],
    };
    let sphere = fm.domain.is_sphere();
    let e1 = hadley_edge(rotation_hours);
    let e2 = (1.0 + e1) / 2.0;
    for i in 0..n {
        let y_norm = belt_y_norm(
            shifted_norm(cm.y_norm[i], equator_offset),
            belt_shift,
            sphere,
        );
        let s_lat = (y_norm - 0.5) * 2.0;
        let phi = s_lat.abs();
        // Math.sign: 0 at the equator.
        let hemi = if s_lat > 0.0 {
            1.0
        } else if s_lat < 0.0 {
            -1.0
        } else {
            s_lat
        };
        let (u_sign, poleward, local) = if phi < e1 {
            (-1.0, false, phi / e1)
        } else if phi < e2 {
            (1.0, true, (phi - e1) / (e2 - e1))
        } else {
            (-1.0, false, (phi - e2) / (1.0 - e2))
        };
        let taper = det_sin(std::f64::consts::PI * local);
        wind.e[i] = u_sign * t.wind_zonal_strength * taper;
        wind.s[i] = (if poleward { hemi } else { -hemi }) * t.wind_meridional_strength * taper;
    }
    wind
}
