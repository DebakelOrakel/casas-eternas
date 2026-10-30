//! `climate/pressure.ts`: surface pressure and the wind it drives for one
//! month, on the climate's field mesh — the zonal bands, a smoothed thermal
//! part, the balance of pressure gradient, Coriolis and friction, and the
//! turn a high range gives the wind. The TypeScript port
//! (`client/src/generator/climate/pressure.ts`, git history) explains each.

use crate::core::det_math::{det_cos, det_hypot, det_sin};
use crate::core::js;
use crate::elevation::elevation_scale::ELEVATION_METERS;
use crate::fields::field_mesh::SharedFieldMesh;
use crate::fields::field_operators::{gradient, smooth_gaussian};
use crate::planet::planet_forcing::hadley_edge;

use super::climate_field::{belt_y_norm, shifted_norm};
use super::climate_mesh::{ClimateTerrain, zonal_mean};
use super::climate_tune_params::CLIMATE_TUNING;
use super::wind::CellVectors;

use std::f64::consts::PI;

/// The refinement's months: a year, January first.
pub const REFINED_MONTHS: usize = 12;

/// The month's pressure (hPa per cell) and wind.
pub struct PressureWind {
    pub pressure: Vec<f64>,
    pub wind: CellVectors,
}

fn band_pressure(phi: f64, e1: f64, e2: f64) -> f64 {
    let a = CLIMATE_TUNING.pressure_band_hpa;
    let t = if phi < e1 {
        -det_cos((PI * phi) / e1)
    } else if phi < e2 {
        det_cos((PI * (phi - e1)) / (e2 - e1))
    } else {
        -det_cos((PI * (phi - e2)) / (1.0 - e2)) * 0.5 - 0.5
    };
    1013.0 + a * t
}

/// JavaScript's Math.sign.
fn sign(v: f64) -> f64 {
    if v > 0.0 {
        1.0
    } else if v < 0.0 {
        -1.0
    } else {
        v
    }
}

/// The pressure and the wind for one month: `temperature` the month's air
/// reduced to sea level, `base_wind` the banded wind, `extra_hpa` a further
/// smooth pressure part.
#[allow(clippy::too_many_arguments)]
pub fn compute_pressure_wind(
    sh: &mut SharedFieldMesh,
    terrain: &ClimateTerrain,
    temperature: &[f64],
    base_wind: &CellVectors,
    equator_offset: f64,
    rotation_hours: f64,
    belt_shift: f64,
    extra_hpa: Option<&[f64]>,
) -> PressureWind {
    let t = &CLIMATE_TUNING;
    let cm = &terrain.cm;
    let land = &terrain.land;
    let domain = &terrain.domain;
    let n = sh.mesh.count;
    let e1 = hadley_edge(rotation_hours);
    let e2 = (1.0 + e1) / 2.0;
    let row_mean = zonal_mean(cm, &sh.mesh, temperature, None);
    let thermal: Vec<f64> = (0..n)
        .map(|i| -(temperature[i] - row_mean[i]) * t.pressure_hpa_per_c)
        .collect();
    let mut thermal = smooth_gaussian(&sh.mesh, &thermal, t.pressure_smooth_sigma_m);
    if let Some(extra) = extra_hpa {
        for i in 0..n {
            thermal[i] += extra[i];
        }
    }
    let sphere = domain.is_sphere();
    let mut pressure = vec![0.0; n];
    let mut f = vec![0.0; n];
    for i in 0..n {
        let shifted = shifted_norm(cm.y_norm[i], equator_offset);
        let s_lat = (shifted - 0.5) * 2.0;
        let band = band_pressure(
            ((belt_y_norm(shifted, belt_shift, sphere) - 0.5) * 2.0).abs(),
            e1,
            e2,
        );
        pressure[i] = band + thermal[i];
        f[i] = det_sin((-s_lat * PI) / 2.0) * (24.0 / rotation_hours);
    }
    let relief: Vec<f64> = terrain
        .mean_elevation(sh)
        .iter()
        .map(|&m| js::max(0.0, m * ELEVATION_METERS))
        .collect();
    let l = t.climate_gradient_length_m;
    let mut pe = vec![0.0; n];
    let mut ps = vec![0.0; n];
    gradient(&sh.mesh, &thermal, &mut pe, &mut ps);
    let mut he = vec![0.0; n];
    let mut hs = vec![0.0; n];
    gradient(&sh.mesh, &relief, &mut he, &mut hs);
    let mut wind = CellVectors {
        e: vec![0.0; n],
        s: vec![0.0; n],
    };
    let reach = l / sh.mesh.unit_m;
    for i in 0..n {
        let gx = -pe[i] * l * t.pressure_wind_per_hpa;
        let gy = -ps[i] * l * t.pressure_wind_per_hpa;
        let gn = -gy;
        let r = if land[i] != 0 {
            t.pressure_friction_land
        } else {
            t.pressure_friction_sea
        };
        let fy = f[i];
        let d = r * r + fy * fy;
        let u = (r * gx + fy * gn) / d;
        let vn = (r * gn - fy * gx) / d;
        let mut wu = base_wind.e[i] + u;
        let mut wv = base_wind.s[i] - vn;
        let (hx, hy) = (he[i], hs[i]);
        let slope = det_hypot(hx, hy);
        if slope > 0.0 {
            let up = (wu * hx + wv * hy) / slope;
            let (x, y) = (sh.mesh.x[i], sh.mesh.y[i]);
            let p = domain.advance(x, y, reach * sign(wu), 0.0);
            let east = sh.sampler.sample(&mut sh.mesh, &relief, p.x, p.y);
            let p = domain.advance(x, y, 0.0, reach * sign(wv));
            let south = sh.sampler.sample(&mut sh.mesh, &relief, p.x, p.y);
            let top = js::max(js::max(relief[i], east), south);
            let block = js::min(
                1.0,
                js::max(
                    0.0,
                    (top - t.pressure_block_from_m)
                        / (t.pressure_block_full_m - t.pressure_block_from_m),
                ),
            ) * t.pressure_block_max;
            if up > 0.0 {
                wu -= block * up * hx / slope;
                wv -= block * up * hy / slope;
            }
        }
        wind.e[i] = wu;
        wind.s[i] = wv;
    }
    PressureWind { pressure, wind }
}
