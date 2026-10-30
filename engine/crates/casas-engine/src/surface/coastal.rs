//! The coast as a process — the shore line on the mesh, the waves'
//! exposure (wind² × fetch), the wave erosion toward the wave base, and
//! the one-line drift along the shore with its deposits and export. The
//! TypeScript port (`client/src/generator/surface/coastal.ts`, git
//! history) explains each part.

use crate::core::det_math::det_hypot;
use crate::core::js;
use crate::elevation::elevation_scale::{ELEVATION_METERS, SEA_LEVEL, elevation_to_meters};
use crate::mesh::periodic_delaunay::PeriodicTriangulation;

use super::surface_tune_params::SURFACE_TUNING;

/// The epoch's coast inputs per slot (`CoastalInputs` in TypeScript).
pub struct CoastalInputs<'a> {
    pub z: &'a [f32],
    pub areas: &'a [f32],
    pub wind_e: &'a [f32],
    pub wind_s: &'a [f32],
    pub cell_m: f64,
    pub hardness: &'a [f32],
    pub sediment_flux: &'a [f32],
    pub iterations: f64,
    pub epoch_years: f64,
}

#[derive(Clone, Debug)]
pub struct CoastalResult {
    pub cut_m: Vec<f32>,
    pub deposit_m: Vec<f32>,
    pub exposure: Vec<f32>,
    pub shore_nodes: usize,
    pub eroded_m3: f64,
    pub supplied_m3: f64,
    pub deposited_m3: f64,
    pub exported_m3: f64,
}

fn normalise_to_p90(values: &mut [f32], members: &[i32]) {
    let mut sorted: Vec<f32> = members.iter().map(|&m| values[m as usize]).collect();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let p90 = if sorted.is_empty() {
        0.0
    } else {
        sorted[(0.9 * (sorted.len() - 1) as f64).floor() as usize] as f64
    };
    if p90 <= 0.0 {
        return;
    }
    for &m in members {
        let m = m as usize;
        values[m] = js::min(1.0, values[m] as f64 / p90) as f32;
    }
}

/// `x || 1` for a length.
fn or_one(v: f64) -> f64 {
    if v == 0.0 || v.is_nan() { 1.0 } else { v }
}

/// The shore: land nodes with a sea neighbour in slot order, and each
/// one's landward unit normal in its own frame.
pub struct Shore {
    pub shore: Vec<i32>,
    pub is_shore: Vec<u8>,
    pub normal_x: Vec<f32>,
    pub normal_y: Vec<f32>,
}

pub fn find_shore(mesh: &PeriodicTriangulation, z: &[f32]) -> Shore {
    let slots = mesh.vertex_slots();
    let domain = &mesh.domain;
    let mut out: Vec<u32> = Vec::new();
    let mut is_shore = vec![0u8; slots];
    let mut shore = Vec::new();
    let mut normal_x = vec![0f32; slots];
    let mut normal_y = vec![0f32; slots];
    for v in 0..slots {
        if mesh.v_alive[v] == 0 || z[v] as f64 <= SEA_LEVEL {
            continue;
        }
        mesh.outgoing(v, &mut out);
        let (mut nx, mut ny) = (0.0, 0.0);
        let mut sea_count = 0;
        for &e in &out {
            let u = mesh.to(e as usize);
            if z[u] as f64 > SEA_LEVEL {
                continue;
            }
            sea_count += 1;
            let offset = domain.delta(mesh.vx[u], mesh.vy[u], mesh.vx[v], mesh.vy[v]);
            nx -= offset.x;
            ny -= offset.y;
        }
        if sea_count == 0 {
            continue;
        }
        is_shore[v] = 1;
        shore.push(v as i32);
        let len = or_one(det_hypot(nx, ny));
        normal_x[v] = (nx / len) as f32;
        normal_y[v] = (ny / len) as f32;
    }
    Shore {
        shore,
        is_shore,
        normal_x,
        normal_y,
    }
}

/// The waves' energy at each shore node (wind² × fetch share), written
/// into `exposure` at the shore's slots.
#[allow(clippy::too_many_arguments)]
pub fn shore_exposure(
    mesh: &mut PeriodicTriangulation,
    z: &[f32],
    shore: &[i32],
    wind_e: &[f32],
    wind_s: &[f32],
    step_units: f64,
    fetch_cap: usize,
    exposure: &mut [f32],
) {
    let domain = mesh.domain.clone();
    let mut hint = mesh.last_tri as usize;
    for &v in shore {
        let v = v as usize;
        let u = wind_e[v] as f64;
        let w = wind_s[v] as f64;
        let speed = det_hypot(u, w);
        if speed <= 1e-6 {
            continue;
        }
        let (mut hx, mut hy) = (-u / speed, -w / speed);
        let mut fetch = 0;
        let (mut px, mut py) = (mesh.vx[v], mesh.vy[v]);
        for _ in 0..fetch_cap {
            let at = domain.advance(px, py, hx * step_units, hy * step_units);
            let heading = domain.transport(hx, hy, px, py, at.x, at.y);
            (hx, hy) = (heading.x, heading.y);
            px = at.x;
            py = at.y;
            let t = mesh.locate(px, py, Some(hint));
            hint = t;
            let b = mesh.barycentric(t, px, py);
            let ground = b[0] * z[mesh.tris[3 * t] as usize] as f64
                + b[1] * z[mesh.tris[3 * t + 1] as usize] as f64
                + b[2] * z[mesh.tris[3 * t + 2] as usize] as f64;
            if ground > SEA_LEVEL {
                break;
            }
            fetch += 1;
        }
        exposure[v] = (speed * speed * (fetch as f64 / fetch_cap as f64)) as f32;
    }
}

pub fn compute_coastal(mesh: &mut PeriodicTriangulation, input: &CoastalInputs) -> CoastalResult {
    let t = &SURFACE_TUNING;
    let z = input.z;
    let areas = input.areas;
    let cell_m = input.cell_m;
    let slots = mesh.vertex_slots();
    let mut cut_m = vec![0f32; slots];
    let mut deposit_m = vec![0f32; slots];
    let mut exposure = vec![0f32; slots];
    let cell_m2 = cell_m * cell_m;
    let shore = find_shore(mesh, z);
    if shore.shore.is_empty() {
        return CoastalResult {
            cut_m,
            deposit_m,
            exposure,
            shore_nodes: 0,
            eroded_m3: 0.0,
            supplied_m3: 0.0,
            deposited_m3: 0.0,
            exported_m3: 0.0,
        };
    }
    let fetch_cap = js::max(
        1.0,
        js::round((t.coast_fetch_cap_km * 1000.0) / t.coast_fetch_step_m),
    ) as usize;
    shore_exposure(
        mesh,
        z,
        &shore.shore,
        input.wind_e,
        input.wind_s,
        t.coast_fetch_step_m / cell_m,
        fetch_cap,
        &mut exposure,
    );
    normalise_to_p90(&mut exposure, &shore.shore);

    let mut supply = vec![0.0; slots];
    let (mut eroded_m3, mut supplied_m3) = (0.0, 0.0);
    for &v in &shore.shore {
        let v = v as usize;
        let z_m = elevation_to_meters(z[v] as f64 - SEA_LEVEL);
        let room = z_m + t.coast_wave_base_m;
        if room <= 0.0 {
            continue;
        }
        let retreat_m = ((t.coast_retreat_per_yr * exposure[v] as f64)
            / js::max(0.25, input.hardness[v] as f64))
            * input.epoch_years;
        let width_m = (areas[v] as f64).sqrt() * cell_m;
        let cut = room * js::min(1.0, retreat_m / width_m);
        if cut <= 0.0 {
            continue;
        }
        cut_m[v] = cut as f32;
        let volume = cut * areas[v] as f64 * cell_m2;
        supply[v] += volume;
        eroded_m3 += volume;
    }
    for &v in &shore.shore {
        let v = v as usize;
        let q = input.sediment_flux[v] as f64;
        if q > 0.0 {
            supply[v] += q * input.iterations;
            supplied_m3 += q * input.iterations;
        }
    }

    let domain = mesh.domain.clone();
    let mut out: Vec<u32> = Vec::new();
    let mut target = vec![-1i32; slots];
    let mut capacity = vec![0.0; slots];
    for &v in &shore.shore {
        let v = v as usize;
        let u = input.wind_e[v] as f64;
        let w = input.wind_s[v] as f64;
        let speed = det_hypot(u, w);
        if speed <= 1e-6 {
            continue;
        }
        let (nx, ny) = (shore.normal_x[v] as f64, shore.normal_y[v] as f64);
        let along = u * nx + w * ny;
        let ax = u - along * nx;
        let ay = w - along * ny;
        let a_len = det_hypot(ax, ay);
        if a_len <= 1e-6 {
            continue;
        }
        mesh.outgoing(v, &mut out);
        let mut best = -1i32;
        let mut best_dot = 0.2;
        for &e in &out {
            let c = mesh.to(e as usize);
            if shore.is_shore[c] == 0 {
                continue;
            }
            let offset = domain.delta(mesh.vx[c], mesh.vy[c], mesh.vx[v], mesh.vy[v]);
            let len = or_one(det_hypot(offset.x, offset.y));
            let dot = (offset.x * ax + offset.y * ay) / (len * a_len);
            if dot > best_dot {
                best_dot = dot;
                best = c as i32;
            }
        }
        target[v] = best;
        let cos_theta = js::min(1.0, along.abs() / speed);
        let sin2 = 2.0 * cos_theta * js::max(0.0, 1.0 - cos_theta * cos_theta).sqrt();
        capacity[v] =
            t.coast_drift_capacity_m3_per_yr * exposure[v] as f64 * sin2 * input.epoch_years;
    }

    let mut in_degree = vec![0i32; slots];
    for &v in &shore.shore {
        let tv = target[v as usize];
        if tv >= 0 {
            in_degree[tv as usize] += 1;
        }
    }
    let mut inflow = vec![0.0; slots];
    let mut outflow = vec![0.0; slots];
    let mut done = vec![0u8; slots];
    let mut queue: Vec<usize> = shore
        .shore
        .iter()
        .map(|&v| v as usize)
        .filter(|&v| in_degree[v] == 0)
        .collect();
    let mut head = 0;
    while head < queue.len() {
        let v = queue[head];
        head += 1;
        done[v] = 1;
        let have = supply[v] + inflow[v];
        let tv = target[v];
        let q = if tv >= 0 {
            js::min(capacity[v], have)
        } else {
            0.0
        };
        outflow[v] = q;
        if tv >= 0 {
            let tv = tv as usize;
            inflow[tv] += q;
            in_degree[tv] -= 1;
            if in_degree[tv] == 0 {
                queue.push(tv);
            }
        }
    }
    let ring: Vec<usize> = shore
        .shore
        .iter()
        .map(|&v| v as usize)
        .filter(|&v| done[v] == 0)
        .collect();
    if !ring.is_empty() {
        let mut chain_inflow = vec![0.0; slots];
        for &v in &ring {
            chain_inflow[v] = inflow[v];
        }
        for _ in 0..2 * ring.len() + 2 {
            for &v in &ring {
                inflow[v] = chain_inflow[v];
            }
            for &v in &ring {
                let tv = target[v];
                if tv >= 0 {
                    inflow[tv as usize] += outflow[v];
                }
            }
            let mut moved = 0;
            for &v in &ring {
                let q = js::min(capacity[v], supply[v] + inflow[v]);
                if (q - outflow[v]).abs() > 1.0 {
                    moved += 1;
                }
                outflow[v] = q;
            }
            if moved == 0 {
                break;
            }
        }
        for &v in &ring {
            inflow[v] = chain_inflow[v];
        }
        for &v in &ring {
            let tv = target[v];
            if tv >= 0 {
                inflow[tv as usize] += outflow[v];
            }
        }
    }
    let (mut deposited_m3, mut exported_m3) = (0.0, 0.0);
    let freeboard = t.coast_deposit_freeboard_m / ELEVATION_METERS;
    let max_depth = -t.coast_deposit_max_depth_m / ELEVATION_METERS;
    for &v in &shore.shore {
        let v = v as usize;
        let mut excess = supply[v] + inflow[v] - outflow[v];
        if excess <= 0.0 {
            continue;
        }
        mesh.outgoing(v, &mut out);
        let shallow = |u: usize| z[u] as f64 <= SEA_LEVEL && z[u] as f64 >= max_depth;
        let sea_count = out
            .iter()
            .filter(|&&e| shallow(mesh.to(e as usize)))
            .count();
        if sea_count > 0 {
            let share = excess / sea_count as f64;
            for &e in &out {
                let u = mesh.to(e as usize);
                if !shallow(u) {
                    continue;
                }
                let room_m = js::max(
                    0.0,
                    (freeboard - z[u] as f64 - deposit_m[u] as f64 / ELEVATION_METERS)
                        * ELEVATION_METERS,
                );
                let area_m2 = areas[u] as f64 * cell_m2;
                let take = js::min(share, room_m * area_m2);
                deposit_m[u] = (deposit_m[u] as f64 + take / area_m2) as f32;
                deposited_m3 += take;
                excess -= take;
            }
        }
        exported_m3 += js::max(0.0, excess);
    }
    CoastalResult {
        cut_m,
        deposit_m,
        exposure,
        shore_nodes: shore.shore.len(),
        eroded_m3,
        supplied_m3,
        deposited_m3,
        exported_m3,
    }
}
