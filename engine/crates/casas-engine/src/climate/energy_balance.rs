//! The year's temperature cycle around the annual mean, from a linear
//! energy balance solved per annual harmonic on the climate's field mesh
//! (BiCGSTAB with a two-level preconditioner), and the daily-mean
//! insolation. The TypeScript port
//! (`client/src/generator/climate/energyBalance.ts`, git history) explains
//! the equation.

use std::collections::HashMap;

use crate::core::det_math::{det_acos, det_asin, det_cos, det_sin, det_tan, sq};
use crate::core::js;
use crate::fields::field_mesh::SharedFieldMesh;
use crate::fields::field_operators::{
    SolveOptions, SolveReport, aggregate, solve_bicgstab, sparse_apply, sparse_matrix,
    two_level_preconditioner,
};
use crate::planet::planet_forcing::PlanetForcing;

use super::climate_field::{latitude_of_norm, shifted_norm};
use super::climate_mesh::ClimateTerrain;
use super::climate_tune_params::CLIMATE_TUNING;
use super::wind::CellVectors;

use std::f64::consts::PI;

const RAD: f64 = PI / 180.0;
const YEAR_S: f64 = 365.25 * 86400.0;

/// The coarse correction's patches: cells within this many links.
const EBM_AGGREGATE_HOPS: usize = 12;

/// The months' temperature departures, °C, month-major, and the two
/// solves' reports.
pub struct SeasonalCycle {
    pub cycle: Vec<f64>,
    pub solves: Vec<SolveReport>,
}

pub fn seasonal_cycle(
    sh: &SharedFieldMesh,
    terrain: &ClimateTerrain,
    annual_temperature: &[f64],
    wind: &CellVectors,
    planet: &PlanetForcing,
    equator_offset: f64,
    months: usize,
) -> SeasonalCycle {
    let fm = &sh.mesh;
    let land = &terrain.land;
    let n = fm.count;
    let t = &CLIMATE_TUNING;
    let omega = (2.0 * PI) / YEAR_S;
    let mut harmonics: HashMap<u64, [f64; 4]> = HashMap::new();
    let mut sun_of = |y_norm: f64| -> [f64; 4] {
        *harmonics.entry(y_norm.to_bits()).or_insert_with(|| {
            let lat_north = (0.5 - y_norm) * PI;
            let mut sun = vec![0.0; months];
            let mut mean = 0.0;
            for m in 0..months {
                sun[m] = month_insolation(lat_north, (m as f64 + 0.5) / months as f64, planet);
                mean += sun[m] / months as f64;
            }
            let mut h = [0.0; 4];
            for k in 1..=2 {
                for m in 0..months {
                    let phase = (2.0 * PI * k as f64 * (m as f64 + 0.5)) / months as f64;
                    h[2 * k - 2] += (2.0 / months as f64) * (sun[m] - mean) * det_cos(phase);
                    h[2 * k - 1] -= (2.0 / months as f64) * (sun[m] - mean) * det_sin(phase);
                }
            }
            h
        })
    };
    let sun: Vec<[f64; 4]> = (0..n)
        .map(|i| sun_of(shifted_norm(terrain.cm.y_norm[i], equator_offset)))
        .collect();
    let mut absorbed = vec![0.0; n];
    let mut capacity = vec![0.0; n];
    for i in 0..n {
        let ice = annual_temperature[i] < t.ebm_ice_below_c;
        let albedo = if ice {
            t.ebm_albedo_ice
        } else if land[i] != 0 {
            t.ebm_albedo_land
        } else {
            t.ebm_albedo_sea
        };
        absorbed[i] = 1.0 - albedo;
        let frozen = land[i] == 0 && annual_temperature[i] < t.ebm_sea_ice_below_c;
        capacity[i] = if land[i] != 0 || frozen {
            t.ebm_capacity_land
        } else {
            t.ebm_capacity_sea
        };
    }
    let mut weight = vec![0.0; fm.nbr.len()];
    let mut diag = vec![0.0; n];
    for i in 0..n {
        let mut d = t.ebm_radiation * fm.area[i];
        for e in fm.edges(i) {
            let j = fm.nbr[e] as usize;
            let c = fm.turn_c[e];
            let sn = fm.turn_s[e];
            let ue = 0.5 * (wind.e[i] + c * wind.e[j] - sn * wind.s[j]);
            let us = 0.5 * (wind.s[i] + sn * wind.e[j] + c * wind.s[j]);
            let inflow =
                js::max(0.0, -(ue * fm.off_e[e] + us * fm.off_s[e]) / fm.dist[e]) * fm.wall[e];
            let w = t.ebm_diffusion_w_per_k * fm.coupling[e] + t.ebm_carry_per_wind_m * inflow;
            weight[e] = w;
            d += w;
        }
        diag[i] = d;
    }
    let mut cycle = vec![0.0; months * n];
    let mut solves = Vec::new();
    let mut x = vec![0.0; 2 * n];
    let mut b = vec![0.0; 2 * n];
    for k in 1..=2usize {
        let mut rows: Vec<Vec<(u32, f64)>> = Vec::with_capacity(2 * n);
        for i in 0..n {
            let wk = k as f64 * omega * capacity[i] * fm.area[i];
            let mut re = vec![(2 * i as u32, diag[i]), (2 * i as u32 + 1, -wk)];
            let mut im = vec![(2 * i as u32, wk), (2 * i as u32 + 1, diag[i])];
            for e in fm.edges(i) {
                re.push((2 * fm.nbr[e], -weight[e]));
                im.push((2 * fm.nbr[e] + 1, -weight[e]));
            }
            rows.push(re);
            rows.push(im);
            b[2 * i] = fm.area[i] * absorbed[i] * sun[i][2 * k - 2];
            b[2 * i + 1] = fm.area[i] * absorbed[i] * sun[i][2 * k - 1];
        }
        let matrix = sparse_matrix(&rows);
        let (patches, count) = aggregate(&matrix, EBM_AGGREGATE_HOPS, 16);
        let of: Vec<u32> = (0..2 * n)
            .map(|u| 2 * patches[u] + (u as u32 & 1))
            .collect();
        let mut pre = two_level_preconditioner(&matrix, &of, 2 * count);
        x.fill(0.0);
        solves.push(solve_bicgstab(
            2 * n,
            &mut |v, out| sparse_apply(&matrix, v, out),
            &mut |r, out| pre.apply(r, out),
            &b,
            &mut x,
            SolveOptions {
                tolerance: 1e-10,
                max_iterations: 2000,
            },
        ));
        for m in 0..months {
            let phase = (2.0 * PI * k as f64 * (m as f64 + 0.5)) / months as f64;
            let c = det_cos(phase);
            let s = det_sin(phase);
            for i in 0..n {
                cycle[m * n + i] += x[2 * i] * c - x[2 * i + 1] * s;
            }
        }
    }
    damp_tropical_land(&mut cycle, terrain, equator_offset, months);
    SeasonalCycle { cycle, solves }
}

/// The tropics' weak temperature gradient: the land's departure damped by
/// `ebm_tropic_damping` up to `ebm_tropic_full_deg` from the equator, and
/// less toward `ebm_tropic_none_deg` (a smoothstep), past which the land
/// keeps its cycle. climate_tune_params.rs explains the constants
/// (`ebm_tropic_damping`).
fn damp_tropical_land(
    cycle: &mut [f64],
    terrain: &ClimateTerrain,
    equator_offset: f64,
    months: usize,
) {
    let t = &CLIMATE_TUNING;
    let land = &terrain.land;
    let n = land.len();
    let span = t.ebm_tropic_none_deg - t.ebm_tropic_full_deg;
    for i in 0..n {
        if land[i] == 0 {
            continue;
        }
        let phi = latitude_of_norm(shifted_norm(terrain.cm.y_norm[i], equator_offset)) * 90.0;
        let s = js::min(js::max((phi - t.ebm_tropic_full_deg) / span, 0.0), 1.0);
        let keep = 1.0 - t.ebm_tropic_damping * (1.0 - s * s * (3.0 - 2.0 * s));
        for m in 0..months {
            cycle[m * n + i] *= keep;
        }
    }
}

/// Daily-mean insolation, W/m², at a latitude (radians, + north) and a time
/// of year (0..1 from 1 January), for the planet's orbit.
pub fn month_insolation(lat_north: f64, year_fraction: f64, planet: &PlanetForcing) -> f64 {
    let lambda = 2.0 * PI * (year_fraction - CLIMATE_TUNING.ebm_vernal_equinox_year);
    let decl = det_asin(det_sin(planet.obliquity_deg * RAD) * det_sin(lambda));
    let perihelion = (planet.precession_deg + 90.0) * RAD;
    let e = planet.eccentricity;
    let distance = sq((1.0 + e * det_cos(lambda - perihelion)) / (1.0 - e * e));
    let x = -det_tan(lat_north) * det_tan(decl);
    let h0 = if x >= 1.0 {
        0.0
    } else if x <= -1.0 {
        PI
    } else {
        det_acos(x)
    };
    let q = (CLIMATE_TUNING.ebm_solar_wm2 * planet.solar_constant / PI)
        * distance
        * (h0 * det_sin(lat_north) * det_sin(decl)
            + det_cos(lat_north) * det_cos(decl) * det_sin(h0));
    js::max(0.0, q)
}
