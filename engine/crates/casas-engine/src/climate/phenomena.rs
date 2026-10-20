//! `climate/phenomena.ts`: coastal fog and föhn from the refinement's
//! months, winds and sea, each a share of the year per land cell, and each
//! changing the months it happens in.

use crate::core::det_math::det_hypot;
use crate::core::js;
use crate::elevation::elevation_scale::ELEVATION_METERS;
use crate::fields::field_mesh::SharedFieldMesh;

use super::climate_mesh::{ClimateTerrain, distance_to_sea};
use super::climate_tune_params::CLIMATE_TUNING;
use super::wind::CellVectors;

pub struct Phenomena {
    pub fog: Vec<f64>,
    pub foehn: Vec<f64>,
}

/// The highest ground `reach_m` upwind of cell `i` along the unit direction
/// (u, v), from `peak` (metres) per cell; 0 when none is higher.
pub fn upwind_peak(
    sh: &mut SharedFieldMesh,
    terrain: &ClimateTerrain,
    peak: &[f64],
    i: usize,
    u: f64,
    v: f64,
    reach_m: f64,
) -> f64 {
    let domain = &terrain.domain;
    let step_m = CLIMATE_TUNING.climate_track_step_m;
    let steps = js::max(1.0, js::round(reach_m / step_m)) as usize;
    let mut barrier = 0.0;
    for k in 1..=steps {
        let d = (k as f64 * step_m) / sh.mesh.unit_m;
        let at = domain.advance(sh.mesh.x[i], sh.mesh.y[i], -u * d, -v * d);
        let j = sh
            .sampler
            .nearest_cell(&mut sh.mesh, domain.wrap_x(at.x), domain.wrap_y(at.y));
        barrier = js::max(barrier, peak[j]);
    }
    barrier
}

/// Fog and föhn; `months_t` (°C, month-major) is changed in place.
pub fn apply_phenomena(
    sh: &mut SharedFieldMesh,
    terrain: &ClimateTerrain,
    months_t: &mut [f64],
    months: usize,
    winds: &[CellVectors],
    anomaly: &[f64],
) -> Phenomena {
    let t = &CLIMATE_TUNING;
    let domain = &terrain.domain;
    let land = &terrain.land;
    let n = sh.mesh.count;
    let mut fog = vec![0.0; n];
    let mut foehn = vec![0.0; n];
    let (_, nearest) = distance_to_sea(&sh.mesh, land);
    let mut sea_of = vec![-1i32; n];
    let mut reach = vec![0.0; n];
    for i in 0..n {
        let sea = nearest[i];
        if land[i] == 0 || sea < 0 {
            continue;
        }
        let s = sea as usize;
        let d = domain
            .distance_sq(sh.mesh.x[s], sh.mesh.y[s], sh.mesh.x[i], sh.mesh.y[i])
            .sqrt()
            * sh.mesh.unit_m;
        if d > t.fog_reach_m {
            continue;
        }
        sea_of[i] = sea;
        reach[i] = js::min(1.0, 1.0 - (d - t.fog_full_within_m) / t.fog_reach_m);
    }
    let peak: Vec<f64> = terrain
        .peak_elevation(sh)
        .iter()
        .map(|&p| js::max(0.0, p * ELEVATION_METERS))
        .collect();
    let ground: Vec<f64> = terrain
        .mean_elevation(sh)
        .iter()
        .map(|&m| js::max(0.0, m * ELEVATION_METERS))
        .collect();
    for m in 0..months {
        let base = m * n;
        let wind = &winds[m];
        for i in 0..n {
            if land[i] == 0 {
                continue;
            }
            let u = wind.e[i];
            let v = wind.s[i];
            let speed = det_hypot(u, v);
            let sea = sea_of[i];
            if sea >= 0 && speed > 0.0 {
                let s = sea as usize;
                let offset = domain.delta(sh.mesh.x[s], sh.mesh.y[s], sh.mesh.x[i], sh.mesh.y[i]);
                let dx = -offset.x;
                let dy = -offset.y;
                let onshore = (u * dx + v * dy) / (speed * det_hypot(dx, dy));
                let cold = js::min(1.0, js::max(0.0, -anomaly[s] / t.fog_full_cold_c));
                let lift = js::min(
                    1.0,
                    js::max(
                        0.0,
                        (months_t[base + i] - months_t[base + s]) / t.fog_full_contrast_c,
                    ),
                );
                let f = cold
                    * js::min(1.0, js::max(0.0, onshore) / t.fog_full_onshore)
                    * lift
                    * reach[i];
                if f > 0.0 {
                    months_t[base + i] -=
                        f * t.fog_cooling * (months_t[base + i] - months_t[base + s]);
                    fog[i] += f / months as f64;
                }
            }
            if speed > 0.0 {
                let barrier = js::max(
                    0.0,
                    upwind_peak(sh, terrain, &peak, i, u / speed, v / speed, t.foehn_reach_m)
                        - ground[i],
                );
                let f = js::min(
                    1.0,
                    js::max(
                        0.0,
                        (barrier - t.foehn_min_barrier_m) / t.foehn_full_barrier_m,
                    ),
                ) * js::min(1.0, speed / t.foehn_full_wind);
                if f > 0.0 {
                    months_t[base + i] += f * t.foehn_warming_c;
                    foehn[i] += f / months as f64;
                }
            }
        }
    }
    Phenomena { fog, foehn }
}
