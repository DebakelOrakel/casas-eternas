//! `surface/glacial.ts`: ice as a process — the epoch's ice on the terrain
//! mesh at its steady state (the balance-flux inversion, Glen's law), the
//! cut it does (sliding and the buzzsaw above the ELA) and the till it
//! leaves at the termini. The TypeScript file explains each part. Not
//! ported: `iceInvariants`, a check of the raster harnesses.

use std::collections::{HashMap, HashSet};

use crate::climate::climate_tune_params::CLIMATE_TUNING;
use crate::climate::precipitation::OCEAN_PRECIP;
use crate::core::det_math::{det_exp, det_pow};
use crate::core::js;
use crate::elevation::elevation_scale::{ELEVATION_METERS, SEA_LEVEL, elevation_to_meters};
use crate::mesh::periodic_delaunay::PeriodicTriangulation;

use super::surface_tune_params::SURFACE_TUNING;

/// The epoch's ice per vertex slot (`MeshIceResult` in TypeScript, which
/// explains each field), with its ledger in m³/yr.
#[derive(Clone, Debug)]
pub struct MeshIceResult {
    pub thickness: Vec<f32>,
    pub balance: Vec<f32>,
    pub receiver: Vec<i32>,
    pub slope: Vec<f32>,
    pub order: Vec<i32>,
    pub ela_m: Vec<f32>,
    pub mass_in: f64,
    pub mass_melt: f64,
    pub mass_out: f64,
}

/// The climate at the nodes the ice reads, per slot.
pub struct MeshIceInputs<'a> {
    pub z: &'a [f32],
    pub sea_level_temperature: &'a [f32],
    pub precipitation: &'a [f32],
    pub seasonal_amplitude: &'a [f32],
    /// Metres per domain unit.
    pub cell_m: f64,
}

fn balance_at(z_units: f64, tc: f64, zc: f64, p: f64, half_range: f64) -> f64 {
    let t = &SURFACE_TUNING;
    let local = tc - CLIMATE_TUNING.lapse_c_per_elevation * (z_units - js::max(SEA_LEVEL, zc));
    let snow = if local <= -5.0 {
        1.0
    } else if local >= 5.0 {
        0.0
    } else {
        (5.0 - local) / 10.0
    };
    let accumulation = (p / 1000.0) * snow * t.ice_snow_to_ice;
    let summer = local + half_range;
    let melt = if summer > t.ice_melt_from_warmest_c {
        (summer - t.ice_melt_from_warmest_c) * t.ice_melt_per_deg_c
    } else {
        0.0
    };
    accumulation - melt
}

fn equilibrium_line(sea_level_c: f64, p: f64, half_range: f64) -> f64 {
    let (mut lo, mut hi) = (0.0, 1.0);
    if balance_at(hi, sea_level_c, SEA_LEVEL, p, half_range) <= 0.0 {
        return ELEVATION_METERS * 2.0;
    }
    if balance_at(lo, sea_level_c, SEA_LEVEL, p, half_range) >= 0.0 {
        return 0.0;
    }
    for _ in 0..24 {
        let mid = 0.5 * (lo + hi);
        if balance_at(mid, sea_level_c, SEA_LEVEL, p, half_range) > 0.0 {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    0.5 * (lo + hi) * ELEVATION_METERS
}

pub fn compute_ice_on_mesh(
    mesh: &mut PeriodicTriangulation,
    input: &MeshIceInputs,
) -> MeshIceResult {
    let t = &SURFACE_TUNING;
    let z = input.z;
    let cell_m = input.cell_m;
    let slots = mesh.vertex_slots();
    let mut balance = vec![0f32; slots];
    let mut ela_m = vec![0f32; slots];
    let mut thickness = vec![0f32; slots];
    let mut receiver = vec![-1i32; slots];
    let mut slope = vec![0f32; slots];
    let mut iceable = 0;
    let mut land: Vec<usize> = Vec::new();
    for v in 0..slots {
        if mesh.v_alive[v] == 0 {
            continue;
        }
        let mut p = input.precipitation[v] as f64;
        if p == OCEAN_PRECIP || p < 0.0 {
            p = 0.0;
        }
        let half_range = js::max(0.0, input.seasonal_amplitude[v] as f64) / 2.0;
        let tsl = input.sea_level_temperature[v] as f64;
        ela_m[v] = equilibrium_line(tsl, p, half_range) as f32;
        if z[v] as f64 <= SEA_LEVEL {
            continue;
        }
        land.push(v);
        balance[v] = balance_at(z[v] as f64, tsl, SEA_LEVEL, p, half_range) as f32;
        if balance[v] > 0.0 {
            iceable += 1;
        }
    }
    let mut order: Vec<i32> = land.iter().map(|&v| v as i32).collect();
    if iceable == 0 {
        return MeshIceResult {
            thickness,
            balance,
            receiver,
            slope,
            order,
            ela_m,
            mass_in: 0.0,
            mass_melt: 0.0,
            mass_out: 0.0,
        };
    }
    let mut area_of = vec![0.0; slots];
    for &v in &land {
        area_of[v] = mesh.voronoi_area(v);
    }
    let mut surface = vec![0f32; slots];
    let mut flux = vec![0.0; slots];
    let gamma = t.ice_flow_gamma;
    let mut star_start = vec![0usize; land.len() + 1];
    let mut star_to: Vec<usize> = Vec::new();
    let mut star_length: Vec<f64> = Vec::new();
    let mut out: Vec<u32> = Vec::new();
    for (i, &v) in land.iter().enumerate() {
        mesh.outgoing(v, &mut out);
        for &e in &out {
            star_to.push(mesh.to(e as usize));
            star_length.push(mesh.edge_length(e as usize));
        }
        star_start[i + 1] = star_to.len();
    }
    let mut land_index = vec![-1i32; slots];
    for (i, &v) in land.iter().enumerate() {
        land_index[v] = i as i32;
    }
    let mut surface_before = vec![0f32; slots];
    let mut stale = vec![0u8; land.len()];
    let descend = |i: usize, surface: &[f32], receiver: &mut [i32], slope: &mut [f32]| {
        let v = land[i];
        let mut best: i32 = -1;
        let mut best_drop = 0.0;
        for k in star_start[i]..star_start[i + 1] {
            let u = star_to[k];
            let drop = (surface[v] as f64 - surface[u] as f64) / (star_length[k] * cell_m);
            if drop > best_drop {
                best_drop = drop;
                best = u as i32;
            }
        }
        receiver[v] = best;
        slope[v] = best_drop as f32;
    };
    let (mut mass_in, mut mass_melt, mut mass_out) = (0.0, 0.0, 0.0);
    for round in 0..t.ice_flow_rounds as usize {
        for v in 0..slots {
            surface[v] = if mesh.v_alive[v] != 0 {
                (elevation_to_meters(z[v] as f64 - SEA_LEVEL) + thickness[v] as f64) as f32
            } else {
                0.0
            };
        }
        if round == 0 {
            for i in 0..land.len() {
                descend(i, &surface, &mut receiver, &mut slope);
            }
        } else {
            stale.fill(0);
            for (i, &v) in land.iter().enumerate() {
                if surface[v] == surface_before[v] {
                    continue;
                }
                stale[i] = 1;
                for k in star_start[i]..star_start[i + 1] {
                    let j = land_index[star_to[k]];
                    if j >= 0 {
                        stale[j as usize] = 1;
                    }
                }
            }
            for i in 0..land.len() {
                if stale[i] != 0 {
                    descend(i, &surface, &mut receiver, &mut slope);
                }
            }
        }
        surface_before.copy_from_slice(&surface);
        // The comparator sort's order: stable, highest surface first (every
        // land surface is positive and finite, where TypeScript's radix
        // sort gives the same).
        order.sort_by(|&a, &b| surface[b as usize].total_cmp(&surface[a as usize]));
        flux.fill(0.0);
        mass_in = 0.0;
        mass_melt = 0.0;
        mass_out = 0.0;
        for &v in &order {
            let v = v as usize;
            let area = area_of[v] * cell_m * cell_m;
            let b = balance[v] as f64 * area;
            let arriving = flux[v];
            let q = arriving + b;
            if b > 0.0 {
                mass_in += b;
            } else {
                mass_melt += js::min(arriving, -b);
            }
            flux[v] = if q > 0.0 { q } else { 0.0 };
            let r = receiver[v];
            if q > 0.0 {
                if r >= 0 && z[r as usize] as f64 > SEA_LEVEL {
                    flux[r as usize] += q;
                } else {
                    mass_out += q;
                }
            }
        }
        for &v in &land {
            let q = flux[v];
            let mut h = 0.0;
            if q > 0.0 {
                let s = js::max(t.ice_min_slope, slope[v] as f64);
                let width_m = area_of[v].sqrt() * cell_m;
                h = det_pow((q / width_m) / (gamma * s * s * s), 0.2);
                if h > t.ice_max_thickness_m {
                    h = t.ice_max_thickness_m;
                }
            }
            thickness[v] = (0.5 * thickness[v] as f64 + 0.5 * h) as f32;
        }
        for &v in &order {
            let v = v as usize;
            if thickness[v] <= 0.0 {
                continue;
            }
            let sv = elevation_to_meters(z[v] as f64 - SEA_LEVEL) + thickness[v] as f64;
            let j = land_index[v] as usize;
            for k in star_start[j]..star_start[j + 1] {
                let u = star_to[k];
                if z[u] as f64 <= SEA_LEVEL {
                    continue;
                }
                let s_min = sv - t.ice_surface_max_slope * star_length[k] * cell_m;
                let zu = elevation_to_meters(z[u] as f64 - SEA_LEVEL);
                let hu = s_min - zu;
                if hu > thickness[u] as f64 {
                    thickness[u] = js::min(t.ice_max_thickness_m, hu) as f32;
                }
            }
        }
    }
    for h in thickness.iter_mut() {
        if (*h as f64) < t.ice_min_thickness_m {
            *h = 0.0;
        }
    }
    MeshIceResult {
        thickness,
        balance,
        receiver,
        slope,
        order,
        ela_m,
        mass_in,
        mass_melt,
        mass_out,
    }
}

/// The epoch's glacial cut and till per slot, metres, and their volumes.
#[derive(Clone, Debug)]
pub struct GlacialErosionResult {
    pub cut_m: Vec<f32>,
    pub till_m: Vec<f32>,
    pub cut_m3: f64,
    pub till_m3: f64,
}

pub fn glacial_erosion_on_mesh(
    mesh: &mut PeriodicTriangulation,
    z: &[f32],
    ice: &MeshIceResult,
    epoch_years: f64,
    cell_m: f64,
) -> GlacialErosionResult {
    let t = &SURFACE_TUNING;
    let slots = mesh.vertex_slots();
    let mut cut_m = vec![0f32; slots];
    let mut till_m = vec![0f32; slots];
    let mut carried = vec![0.0; slots];
    // Each terminus's till, in the order the ice reached it.
    let mut termini: Vec<(usize, f64)> = Vec::new();
    let mut terminus_at: HashMap<usize, usize> = HashMap::new();
    let (mut cut_m3, mut till_m3) = (0.0, 0.0);
    for &v in &ice.order {
        let v = v as usize;
        let h = ice.thickness[v] as f64;
        if h < t.ice_min_thickness_m {
            continue;
        }
        let z_m = elevation_to_meters(z[v] as f64 - SEA_LEVEL);
        let sliding = h * js::max(t.ice_min_slope, ice.slope[v] as f64);
        let mut cut = t.glacial_erosion_per_sliding * sliding * epoch_years;
        if cut > t.glacial_erosion_max_m {
            cut = t.glacial_erosion_max_m;
        }
        let above_line_m = z_m - ice.ela_m[v] as f64;
        let b = ice.balance[v] as f64;
        if above_line_m > 0.0 && b > 0.0 {
            cut += above_line_m * (1.0 - det_exp(-t.glacial_buzzsaw_per_balance * b * epoch_years));
        }
        cut_m[v] = cut as f32;
        let area = mesh.voronoi_area(v) * cell_m * cell_m;
        cut_m3 += cut * area;
        carried[v] += cut * area;
        let r = ice.receiver[v];
        if r >= 0 && ice.thickness[r as usize] as f64 >= t.ice_min_thickness_m {
            carried[r as usize] += carried[v];
        } else {
            let at = if r >= 0 && z[r as usize] as f64 > SEA_LEVEL {
                r as usize
            } else {
                v
            };
            match terminus_at.get(&at) {
                Some(&k) => termini[k].1 += carried[v],
                None => {
                    terminus_at.insert(at, termini.len());
                    termini.push((at, carried[v]));
                }
            }
            till_m3 += carried[v];
        }
        carried[v] = 0.0;
    }
    for (at, volume) in termini {
        spread_till(mesh, at, volume, cell_m, &mut till_m);
    }
    GlacialErosionResult {
        cut_m,
        till_m,
        cut_m3,
        till_m3,
    }
}

const TILL_SPREAD_MAX_NODES: usize = 4096;

/// A terminus's till as an apron: ring by ring until it lies no thicker
/// than glacial_till_max_m.
fn spread_till(
    mesh: &mut PeriodicTriangulation,
    at: usize,
    volume_m3: f64,
    cell_m: f64,
    till_m: &mut [f32],
) {
    let t = &SURFACE_TUNING;
    let mut nodes = vec![at];
    let mut seen: HashSet<usize> = HashSet::from([at]);
    let mut area = mesh.voronoi_area(at) * cell_m * cell_m;
    let mut head = 0;
    let mut out: Vec<u32> = Vec::new();
    while volume_m3 / area > t.glacial_till_max_m
        && head < nodes.len()
        && nodes.len() < TILL_SPREAD_MAX_NODES
    {
        mesh.neighbours(nodes[head], &mut out);
        for &u in &out {
            let u = u as usize;
            if !seen.insert(u) {
                continue;
            }
            nodes.push(u);
            area += mesh.voronoi_area(u) * cell_m * cell_m;
        }
        head += 1;
    }
    let h = volume_m3 / area;
    for u in nodes {
        till_m[u] = (till_m[u] as f64 + h) as f32;
    }
}
