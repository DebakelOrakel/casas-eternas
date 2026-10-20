//! `climate/storms.ts`: cyclones, tornadoes, blizzards, dust and thunder of
//! the refinement's months — derived fields, each 0..1 per cell of the
//! climate's field mesh; the tracks step along great circles. The
//! TypeScript file explains each.

use crate::core::det_math::det_hypot;
use crate::core::js;
use crate::elevation::elevation_scale::ELEVATION_METERS;
use crate::fields::field_mesh::SharedFieldMesh;

use super::climate_field::{latitude_of_norm, shifted_norm};
use super::climate_mesh::ClimateTerrain;
use super::climate_tune_params::CLIMATE_TUNING;
use super::phenomena::upwind_peak;
use super::wind::CellVectors;

pub struct Storms {
    pub cyclone: Vec<f64>,
    pub tornado: Vec<f64>,
    pub blizzard: Vec<f64>,
    pub dust: Vec<f64>,
    pub thunder: Vec<f64>,
}

/// A track across the mesh: steps along the great circle, the reached cell
/// found by a greedy walk over the mesh's links.
struct Track {
    x: f64,
    y: f64,
    cell: usize,
}

impl Track {
    fn start(sh: &SharedFieldMesh, cell: usize) -> Self {
        Track {
            x: sh.mesh.x[cell],
            y: sh.mesh.y[cell],
            cell,
        }
    }

    /// The field's vector at the reached cell, in the point's frame.
    fn read(
        &self,
        sh: &SharedFieldMesh,
        terrain: &ClimateTerrain,
        fe: &[f64],
        fs: &[f64],
    ) -> (f64, f64) {
        let c = self.cell;
        let v = terrain
            .domain
            .transport(fe[c], fs[c], sh.mesh.x[c], sh.mesh.y[c], self.x, self.y);
        (v.x, v.y)
    }

    /// One step along the unit direction (dx, dy) of the point's frame.
    fn step(&mut self, sh: &SharedFieldMesh, terrain: &ClimateTerrain, dx: f64, dy: f64) {
        let domain = &terrain.domain;
        let fm = &sh.mesh;
        let d = CLIMATE_TUNING.climate_track_step_m / fm.unit_m;
        let at = domain.advance(self.x, self.y, dx * d, dy * d);
        self.x = domain.wrap_x(at.x);
        self.y = domain.wrap_y(at.y);
        let mut best = self.cell;
        loop {
            let off = domain.delta(self.x, self.y, fm.x[best], fm.y[best]);
            let pe = off.x * fm.unit_m;
            let ps = off.y * fm.unit_m;
            let mut best_d = pe * pe + ps * ps;
            let mut next: i64 = -1;
            for e in fm.edges(best) {
                let de = pe - fm.off_e[e];
                let ds = ps - fm.off_s[e];
                let dd = de * de + ds * ds;
                if dd < best_d {
                    best_d = dd;
                    next = fm.nbr[e] as i64;
                }
            }
            if next < 0 {
                break;
            }
            best = next as usize;
        }
        self.cell = best;
    }
}

/// NaN and −0 pass, as in the TypeScript ternary.
fn clamp01(v: f64) -> f64 {
    v.clamp(0.0, 1.0)
}

/// `months_t` °C and `months_p` mm/yr rates (OCEAN_PRECIP on the sea),
/// month-major; `winds` the months' winds.
pub fn compute_storms(
    sh: &mut SharedFieldMesh,
    terrain: &ClimateTerrain,
    months_t: &[f64],
    months_p: &[f64],
    months: usize,
    winds: &[CellVectors],
    equator_offset: f64,
) -> Storms {
    let t = &CLIMATE_TUNING;
    let domain = &terrain.domain;
    let land = &terrain.land;
    let n = sh.mesh.count;
    let mut cyclone = vec![0.0; n];
    let mut tornado = vec![0.0; n];
    let mut blizzard = vec![0.0; n];
    let mut dust_source = vec![0.0; n];
    let mut dust = vec![0.0; n];
    let mut thunder = vec![0.0; n];
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
    let mut lat_deg = vec![0.0; n];
    let mut mean_area = 0.0;
    for i in 0..n {
        lat_deg[i] = latitude_of_norm(shifted_norm(terrain.cm.y_norm[i], equator_offset)) * 90.0;
        mean_area += sh.mesh.area[i] / n as f64;
    }
    let cyclone_steps = js::round(t.cyclone_track_m / t.climate_track_step_m) as usize;
    let dust_steps = js::round(t.dust_track_m / t.climate_track_step_m) as usize;
    let mf = months as f64;
    for m in 0..months {
        let base = m * n;
        let wind = &winds[m];
        for i in 0..n {
            let temp = months_t[base + i];
            let u = wind.e[i];
            let speed = det_hypot(u, wind.s[i]);
            let is_land = land[i] != 0;
            let rain_month = if is_land {
                months_p[base + i] / mf
            } else {
                0.0
            };
            let water = if is_land {
                clamp01(rain_month / t.thunder_full_rain_mm)
            } else {
                0.6
            };
            thunder[i] += (clamp01((temp - t.thunder_from_c) / t.thunder_span_c)
                * water
                * if is_land { 1.0 } else { t.thunder_sea_share })
                / mf;
            if !is_land {
                continue;
            }
            if temp < t.blizzard_below_c
                && rain_month > t.blizzard_min_snow_mm
                && speed > t.blizzard_min_wind
            {
                blizzard[i] += 1.0 / mf;
            }
            if temp > 0.0 {
                dust_source[i] += (clamp01(1.0 - rain_month / t.dust_dry_below_mm)
                    * clamp01(speed / t.dust_full_wind))
                    / mf;
            }
            if u > 0.0 && ground[i] < t.tornado_plain_below_m {
                let barrier = upwind_peak(
                    sh,
                    terrain,
                    &peak,
                    i,
                    u / speed,
                    wind.s[i] / speed,
                    t.tornado_reach_m,
                );
                let moist = clamp01((temp - t.tornado_from_c) / t.tornado_span_c)
                    * clamp01(rain_month / t.tornado_full_rain_mm);
                let lee = clamp01((barrier - t.tornado_min_barrier_m) / t.tornado_full_barrier_m);
                tornado[i] += (moist * lee * clamp01(u / t.tornado_full_wind)) / mf;
            }
        }
        let mut i0 = m % 2;
        while i0 < n {
            let lat = lat_deg[i0];
            if lat < t.cyclone_min_lat_deg || lat > t.cyclone_max_lat_deg || land[i0] != 0 {
                i0 += 2;
                continue;
            }
            let mut weight = clamp01((months_t[base + i0] - t.cyclone_warm_c) / t.cyclone_span_c)
                * (sh.mesh.area[i0] / mean_area);
            if weight <= 0.0 {
                i0 += 2;
                continue;
            }
            let mut track = Track::start(sh, i0);
            let mut step = 0;
            while step < cyclone_steps && weight > t.cyclone_fade_below {
                let i = track.cell;
                cyclone[i] += weight;
                let pole = if track.y < domain.height / 2.0 {
                    1.0
                } else {
                    -1.0
                };
                let (vx, vy) = track.read(sh, terrain, &wind.e, &wind.s);
                let dx = vx - t.cyclone_drift_west;
                let dy = vy - pole * t.cyclone_drift_pole;
                let d = det_hypot(dx, dy);
                // `|| 1`: 0 and NaN.
                let d = if d == 0.0 || d.is_nan() { 1.0 } else { d };
                track.step(sh, terrain, dx / d, dy / d);
                if land[i] != 0 {
                    weight *= t.cyclone_land_keep;
                } else if months_t[base + i] < t.cyclone_cold_c {
                    weight *= t.cyclone_cold_keep;
                }
                step += 1;
            }
            i0 += 2;
        }
    }
    let mut mean_e = vec![0.0; n];
    let mut mean_s = vec![0.0; n];
    for w in winds.iter().take(months) {
        for i in 0..n {
            mean_e[i] += w.e[i] / mf;
            mean_s[i] += w.s[i] / mf;
        }
    }
    for i0 in 0..n {
        let mut load = dust_source[i0];
        if load <= 0.0 {
            continue;
        }
        let mut track = Track::start(sh, i0);
        let mut step = 0;
        while step < dust_steps && load > 0.01 {
            dust[track.cell] += load;
            let (vx, vy) = track.read(sh, terrain, &mean_e, &mean_s);
            let s = det_hypot(vx, vy);
            if s < 0.05 {
                break;
            }
            track.step(sh, terrain, vx / s, vy / s);
            load *= t.dust_keep;
            step += 1;
        }
    }
    normalise(&mut cyclone);
    normalise(&mut dust);
    normalise(&mut thunder);
    normalise(&mut tornado);
    Storms {
        cyclone,
        tornado,
        blizzard,
        dust,
        thunder,
    }
}

/// Scaled to the 99th percentile of its non-zero cells, capped at 1.
fn normalise(field: &mut [f64]) {
    let mut values: Vec<f64> = field.iter().copied().filter(|&v| v > 0.0).collect();
    if values.is_empty() {
        return;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let top = values[(0.99 * (values.len() - 1) as f64).floor() as usize];
    if top <= 0.0 {
        return;
    }
    for v in field.iter_mut() {
        *v = js::min(1.0, *v / top);
    }
}
