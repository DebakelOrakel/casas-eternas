//! `climate/precipitation.ts`: annual precipitation per land cell of the
//! climate's field mesh — moisture evaporated over the sea, advected
//! downwind, rained out (more on windward slopes), shaped by the zonal
//! bands; with the refinement's sea, its anomaly and its ocean highs when
//! given. The TypeScript file explains each term.

use crate::core::det_math::{det_cos, det_exp, det_hypot};
use crate::core::js;
use crate::elevation::elevation_scale::SEA_LEVEL;
use crate::fields::field_mesh::SharedFieldMesh;
use crate::planet::planet_forcing::{DEFAULT_ROTATION_HOURS, hadley_edge};

use super::climate_field::{belt_y_norm, shifted_norm};
use super::climate_mesh::ClimateTerrain;
use super::climate_tune_params::CLIMATE_TUNING;
use super::wind::CellVectors;

use std::f64::consts::PI;

/// The sea's sentinel: precipitation is a land field.
pub const OCEAN_PRECIP: f64 = -1.0;

/// The evaporation at a temperature, clamped.
pub fn evaporation(temp_c: f64) -> f64 {
    let t = &CLIMATE_TUNING;
    let e = (temp_c - t.precip_evap_zero_c) / t.precip_evap_span_c;
    if e < t.precip_evap_min {
        t.precip_evap_min
    } else if e > t.precip_evap_max {
        t.precip_evap_max
    } else {
        e
    }
}

/// The zonal band's rain factor at latitude φ (0 equator … 1 pole) for a
/// Hadley edge.
pub fn band_factor(phi: f64, edge: f64) -> f64 {
    let t = &CLIMATE_TUNING;
    let psi = band_latitude(phi, edge);
    let wave = det_cos(3.0 * PI * psi);
    let low = t.precip_band_base - t.precip_band_swing;
    let f = if psi <= 1.0 / 3.0 {
        t.precip_band_base + t.precip_band_swing * wave
    } else {
        low + (t.precip_band_storm_peak - low) * (1.0 + wave) / 2.0
    };
    if f < t.precip_band_floor {
        t.precip_band_floor
    } else {
        f
    }
}

/// The Hadley cell's edge at Earth's day.
pub fn earth_hadley_edge() -> f64 {
    hadley_edge(DEFAULT_ROTATION_HOURS)
}

/// Where a latitude sits in the three cells laid out for Earth.
pub fn band_latitude(phi: f64, edge: f64) -> f64 {
    let e2 = (1.0 + edge) / 2.0;
    if phi <= edge {
        return (phi / edge) / 3.0;
    }
    if phi <= e2 {
        return 1.0 / 3.0 + ((phi - edge) / (e2 - edge)) / 3.0;
    }
    2.0 / 3.0 + ((phi - e2) / (1.0 - e2)) / 3.0
}

/// The refinement's word on the rain, per cell.
pub struct RefinedRain<'a> {
    pub sea_temperature: &'a [f64],
    pub sea_anomaly: &'a [f64],
    pub high_hpa: &'a [f64],
}

/// Annual precipitation, mm/yr per land cell, OCEAN_PRECIP on the sea.
#[allow(clippy::too_many_arguments)]
pub fn compute_precipitation(
    sh: &mut SharedFieldMesh,
    terrain: &ClimateTerrain,
    temperature: &[f64],
    wind: &CellVectors,
    humidity: f64,
    equator_offset: f64,
    belt_shift: f64,
    refined: Option<&RefinedRain>,
    edge: f64,
) -> Vec<f64> {
    let t = &CLIMATE_TUNING;
    let domain = &terrain.domain;
    let land = &terrain.land;
    let n = sh.mesh.count;
    let unit_m = sh.mesh.unit_m;
    let mut evap = vec![0.0; n];
    let mut rain_frac = vec![0.0; n];
    let half = t.precip_orog_half_span_m / unit_m;
    let lever = t.precip_orog_lever_m / (2.0 * t.precip_orog_half_span_m);
    for i in 0..n {
        let ocean = land[i] == 0;
        evap[i] = evaporation(match refined {
            Some(r) if ocean => r.sea_temperature[i],
            _ => temperature[i],
        });
        if ocean {
            rain_frac[i] = t.precip_base_rainout;
            continue;
        }
        let u = wind.e[i];
        let v = wind.s[i];
        let speed = det_hypot(u, v);
        let mut upslope = 0.0;
        if speed > 0.0 {
            let ax = (u / speed) * half;
            let ay = (v / speed) * half;
            let (mut up, mut down) = (0.0, 0.0);
            let (x, y) = (sh.mesh.x[i], sh.mesh.y[i]);
            for k in [-0.5, 0.0, 0.5] {
                let px = -ay * k * 2.0;
                let py = ax * k * 2.0;
                let p = domain.displace(x, y, -ax, -ay);
                let p = domain.advance(p.x, p.y, px, py);
                up += js::max(terrain.elevation_at(p.x, p.y), SEA_LEVEL) / 3.0;
                let p = domain.displace(x, y, ax, ay);
                let p = domain.advance(p.x, p.y, px, py);
                down += js::max(terrain.elevation_at(p.x, p.y), SEA_LEVEL) / 3.0;
            }
            upslope = js::max(0.0, down - up) * speed * lever;
        }
        rain_frac[i] = js::min(
            t.precip_rainout_max,
            t.precip_base_rainout + t.precip_orographic_rate * upslope,
        );
    }

    let mut moisture: Vec<f64> = (0..n)
        .map(|i| if land[i] != 0 { 0.0 } else { evap[i] })
        .collect();
    let mut rained_out = vec![0.0; n];
    let sinking = refined.map(|r| {
        subsidence(
            &terrain.cm.y_norm,
            sh.mesh.domain.is_sphere(),
            r.high_hpa,
            equator_offset,
            belt_shift,
            edge,
        )
    });
    let mut carried = vec![0.0; n];
    let mut source_anomaly = vec![0.0; n];
    if let Some(r) = refined {
        for i in 0..n {
            carried[i] = if land[i] != 0 {
                0.0
            } else {
                evap[i] * r.sea_anomaly[i]
            };
        }
    }
    let mut corners = vec![0usize; 3 * n];
    let mut weights = vec![0.0; 3 * n];
    let step = t.precip_advect_step_m / unit_m;
    for i in 0..n {
        if land[i] == 0 {
            continue;
        }
        let p = domain.advance(
            sh.mesh.x[i],
            sh.mesh.y[i],
            -wind.e[i] * step,
            -wind.s[i] * t.precip_advect_meridional_scale * step,
        );
        let taps = sh.sampler.taps(&mut sh.mesh, p.x, p.y);
        for k in 0..3 {
            corners[3 * i + k] = taps.corners[k];
            weights[3 * i + k] = taps.weights[k];
        }
    }
    let at = |field: &[f64], i: usize| -> f64 {
        weights[3 * i] * field[corners[3 * i]]
            + weights[3 * i + 1] * field[corners[3 * i + 1]]
            + weights[3 * i + 2] * field[corners[3 * i + 2]]
    };
    for _ in 0..t.precip_iters as usize {
        let mut next = vec![0.0; n];
        let mut next_carried = if refined.is_some() {
            vec![0.0; n]
        } else {
            Vec::new()
        };
        for i in 0..n {
            if land[i] == 0 {
                next[i] = evap[i];
                if refined.is_some() {
                    next_carried[i] = carried[i];
                }
                continue;
            }
            let advected = at(&moisture, i);
            let rain = advected * rain_frac[i];
            rained_out[i] = rain;
            next[i] = advected - rain * (1.0 - t.precip_land_recycle_frac);
            if let Some(s) = &sinking {
                next[i] *= 1.0 - t.rain_subsidence_mix * s[i];
            }
            if refined.is_some() && advected > 0.0 {
                let anomaly = at(&carried, i) / advected;
                source_anomaly[i] = anomaly;
                next_carried[i] = next[i] * anomaly;
            }
        }
        moisture = next;
        if refined.is_some() {
            carried = next_carried;
        }
    }

    let sphere = domain.is_sphere();
    (0..n)
        .map(|i| {
            if land[i] == 0 {
                return OCEAN_PRECIP;
            }
            let band = band_factor(
                (belt_y_norm(
                    shifted_norm(terrain.cm.y_norm[i], equator_offset),
                    belt_shift,
                    sphere,
                ) - 0.5)
                    .abs()
                    * 2.0,
                edge,
            );
            let factor = match refined {
                Some(r) => flank_relief(band, r.high_hpa[i]) * source_stability(source_anomaly[i]),
                None => band,
            };
            rained_out[i] * factor * t.precip_scale * humidity
        })
        .collect()
}

/// How strongly the air sinks, 0..1 per cell.
fn subsidence(
    y_norm: &[f64],
    sphere: bool,
    high_hpa: &[f64],
    equator_offset: f64,
    belt_shift: f64,
    edge: f64,
) -> Vec<f64> {
    let t = &CLIMATE_TUNING;
    y_norm
        .iter()
        .enumerate()
        .map(|(i, &y)| {
            let band = band_factor(
                (belt_y_norm(shifted_norm(y, equator_offset), belt_shift, sphere) - 0.5).abs()
                    * 2.0,
                edge,
            );
            let from_band = js::min(
                1.0,
                js::max(
                    0.0,
                    (t.rain_subsidence_band - band)
                        / (t.rain_subsidence_band - t.precip_band_floor),
                ),
            );
            let h = high_hpa[i];
            if h < 0.0 {
                from_band * (1.0 - js::min(1.0, -h / t.rain_flank_full_hpa))
            } else {
                js::max(from_band, js::min(1.0, h / t.ocean_high_flank_hpa))
            }
        })
        .collect()
}

/// The band factor under a high's western flank.
fn flank_relief(band: f64, high_hpa: f64) -> f64 {
    let t = &CLIMATE_TUNING;
    if high_hpa >= 0.0 || band >= t.rain_flank_factor {
        return band;
    }
    let f = js::min(1.0, -high_hpa / t.rain_flank_full_hpa);
    band + (t.rain_flank_factor - band) * f
}

/// The rain's multiplier from the anomaly of the sea the air rose from.
fn source_stability(anomaly: f64) -> f64 {
    let t = &CLIMATE_TUNING;
    let f = det_exp(t.rain_source_per_c * anomaly);
    if f < t.rain_source_min {
        t.rain_source_min
    } else if f > t.rain_source_max {
        t.rain_source_max
    } else {
        f
    }
}
