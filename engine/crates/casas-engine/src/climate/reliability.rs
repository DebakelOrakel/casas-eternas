//! The rain's year-to-year spread and an ENSO-like see-saw of the
//! equatorial basins, derived from the refinement's year. The TypeScript
//! port (`client/src/generator/climate/reliability.ts`, git history)
//! explains both.

use crate::core::det_math::{det_exp, det_hypot, sq};
use crate::core::js;
use crate::fields::field_mesh::FieldMesh;

use super::climate_field::{latitude_of_norm, shifted_norm};
use super::climate_mesh::{BasinRows, ClimateTerrain};
use super::climate_tune_params::CLIMATE_TUNING;
use super::precipitation::OCEAN_PRECIP;

pub struct Reliability {
    pub rain_variability: Vec<f64>,
    pub enso_pattern: Vec<f64>,
    pub enso_period_years: f64,
    pub enso_strength: f64,
}

#[derive(Clone, Copy)]
struct Basin {
    west: f64,
    east: f64,
    strength: f64,
    width_deg: f64,
}

pub fn compute_reliability(
    fm: &FieldMesh,
    terrain: &ClimateTerrain,
    rows: &BasinRows,
    precipitation: &[f32],
    monsoon_index: &[f32],
    anomaly: &[f64],
    equator_offset: f64,
) -> Reliability {
    let t = &CLIMATE_TUNING;
    let cm = &terrain.cm;
    let domain = &terrain.domain;
    let land = &terrain.land;
    let n = fm.count;
    let w = domain.width;
    let mut basins: Vec<Basin> = Vec::new();
    let same = t.enso_same_basin_m / fm.unit_m;
    let zonal = |a: f64, b: f64| -> f64 {
        let mut d = (a - b).abs();
        if d > w / 2.0 {
            d = w - d;
        }
        d
    };
    for ring in &rows.rings {
        if latitude_of_norm(shifted_norm(ring.y / domain.height, equator_offset)) * 90.0
            > t.enso_rows_deg
        {
            continue;
        }
        let count = ring.count;
        for k0 in 0..count {
            if ring.land[k0] == 0 || ring.land[(k0 + 1) % count] != 0 {
                continue;
            }
            let len = ring.run_length[(k0 + 1) % count] as usize;
            if len >= count {
                continue;
            }
            let third = js::max(1.0, (len as f64 / 3.0).floor()) as usize;
            let (mut warm, mut cold) = (0.0, 0.0);
            for k in 0..third {
                warm += anomaly[ring.cell[(k0 + 1 + k) % count] as usize] / third as f64;
                cold += anomaly[ring.cell[(k0 + len - k) % count] as usize] / third as f64;
            }
            let width_deg = (len as f64 * 360.0) / count as f64;
            let strength = js::min(1.0, js::max(0.0, (warm - cold) / t.enso_full_gradient_c))
                * js::min(
                    1.0,
                    js::max(
                        0.0,
                        (width_deg - t.enso_min_width_deg)
                            / (t.enso_full_width_deg - t.enso_min_width_deg),
                    ),
                );
            // `strength <= 0`, NaN passing as in JavaScript.
            if strength <= 0.0 {
                continue;
            }
            let west = (((k0 + 1) % count) as f64 + 0.5) * (w / count as f64);
            let east = (((k0 + len) % count) as f64 + 0.5) * (w / count as f64);
            match basins
                .iter_mut()
                .find(|b| zonal(b.west, west) <= same && zonal(b.east, east) <= same)
            {
                Some(known) => {
                    if strength > known.strength {
                        *known = Basin {
                            west,
                            east,
                            strength,
                            width_deg,
                        };
                    }
                }
                None => basins.push(Basin {
                    west,
                    east,
                    strength,
                    width_deg,
                }),
            }
        }
    }
    let mut enso_pattern = vec![0.0; n];
    for i in 0..n {
        if land[i] == 0 {
            continue;
        }
        let lat = latitude_of_norm(shifted_norm(cm.y_norm[i], equator_offset)) * 90.0;
        let by_lat = det_exp(-sq(lat / t.enso_reach_lat_deg));
        let per_unit = fm.unit_m * rows.rings[cm.band[i] as usize].scale;
        let mut mark = 0.0;
        for b in &basins {
            let wet = det_exp(-sq((zonal(fm.x[i], b.east) * per_unit) / t.enso_reach_m));
            let dry = det_exp(-sq((zonal(fm.x[i], b.west) * per_unit) / t.enso_reach_m));
            mark += b.strength * by_lat * (wet - dry);
        }
        enso_pattern[i] = js::max(-1.0, js::min(1.0, mark));
    }
    let mut rain_variability = vec![0.0; n];
    for i in 0..n {
        let p = precipitation[i] as f64;
        if land[i] == 0 || p == OCEAN_PRECIP {
            continue;
        }
        let own = js::min(
            t.rain_variability_max,
            t.rain_variability_scale / js::max(p, t.rain_variability_floor_mm).sqrt(),
        ) * (1.0 + t.rain_variability_season * (monsoon_index[i] as f64).abs());
        let enso = t.enso_variability * enso_pattern[i].abs();
        rain_variability[i] = js::min(t.rain_variability_max, det_hypot(own, enso));
    }
    let mut best: Option<Basin> = None;
    for b in &basins {
        if best.is_none_or(|x| b.strength > x.strength) {
            best = Some(*b);
        }
    }
    Reliability {
        rain_variability,
        enso_pattern,
        enso_period_years: best.map_or(0.0, |b| {
            t.enso_period_min_years
                + (t.enso_period_max_years - t.enso_period_min_years)
                    * js::min(1.0, b.width_deg / 180.0)
        }),
        enso_strength: best.map_or(0.0, |b| b.strength),
    }
}
