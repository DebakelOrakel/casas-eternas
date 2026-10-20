//! `climate/oceanCurrents.ts`: the ocean on the climate's field mesh — the
//! wind-driven currents (Stommel with the island rule), the sea surface
//! they make and carry inland, the Ekman upwelling and the overturning's
//! inflow. The TypeScript file explains the equations and the solves.

use crate::core::det_math::{det_cos, det_exp, det_hypot, det_sin};
use crate::core::js;
use crate::fields::field_mesh::{FieldMesh, SharedFieldMesh};
use crate::fields::field_operators::{
    Departures, SolveOptions, SolveReport, aggregate, compute_departures, conjugate_gradient,
    departures, divergence, east_wall_normals, gradient, solve_bicgstab, sparse_apply,
    sparse_matrix, transport_scalar, two_level_preconditioner,
};

use super::climate_field::{latitude_of_norm, shifted_norm};
use super::climate_mesh::{ClimateTerrain, mesh_components};
use super::climate_tune_params::CLIMATE_TUNING;
use super::wind::CellVectors;

use std::f64::consts::PI;

/// The currents per sea cell, normalised to a fastest cell of 1, 0 on land,
/// with the stream function, the solve's report and the landmasses.
pub struct OceanCurrents {
    pub e: Vec<f64>,
    pub s: Vec<f64>,
    pub psi: Vec<f64>,
    pub solve: SolveReport,
    pub islands: usize,
    pub landmasses: usize,
}

const EMPTY_SOLVE: SolveReport = SolveReport {
    iterations: 0,
    residual: 0.0,
    converged: true,
    removed_mean: 0.0,
};

/// The wind-driven currents under `wind`.
pub fn compute_ocean_currents(
    sh: &SharedFieldMesh,
    terrain: &ClimateTerrain,
    wind: &CellVectors,
    equator_offset: f64,
) -> OceanCurrents {
    let fm = &sh.mesh;
    let n = fm.count;
    let land = &terrain.land;
    let beta: Vec<f64> = (0..n)
        .map(|i| {
            det_cos(
                (latitude_of_norm(shifted_norm(terrain.cm.y_norm[i], equator_offset)) * PI) / 2.0,
            ) / CLIMATE_TUNING.currents_boundary_width_m
        })
        .collect();
    let turned_s: Vec<f64> = wind.e.iter().map(|&v| -v).collect();
    let mut curl = vec![0.0; n];
    divergence(fm, &wind.s, &turned_s, &mut curl, None);
    let solution = solve_stommel(fm, land, &beta, &curl);
    let psi = solution.psi;
    let mut g_e = vec![0.0; n];
    let mut g_s = vec![0.0; n];
    gradient(fm, &psi, &mut g_e, &mut g_s);
    let mut e = vec![0.0; n];
    let mut s = vec![0.0; n];
    let mut vmax = 1e-9;
    for i in 0..n {
        if land[i] != 0 {
            continue;
        }
        e[i] = -g_s[i];
        s[i] = g_e[i];
        vmax = js::max(vmax, det_hypot(e[i], s[i]));
    }
    for i in 0..n {
        e[i] /= vmax;
        s[i] /= vmax;
    }
    OceanCurrents {
        e,
        s,
        psi,
        solve: solution.solve,
        islands: solution.islands,
        landmasses: solution.landmasses,
    }
}

pub struct StommelSolution {
    pub psi: Vec<f64>,
    pub solve: SolveReport,
    pub islands: usize,
    pub landmasses: usize,
}

/// The coarse correction's patches: cells within this many links.
const STOMMEL_AGGREGATE_HOPS: usize = 6;

/// ∇²ψ + β ∂ψ/∂x = curl over the sea cells, with the island rule.
pub fn solve_stommel(fm: &FieldMesh, land: &[u8], beta: &[f64], curl: &[f64]) -> StommelSolution {
    let n = fm.count;
    let wall_east = east_wall_normals(fm);
    let lands = mesh_components(fm, land);
    let mut reference: i64 = -1;
    for id in 0..lands.cells.len() {
        if reference < 0 || lands.area[id] > lands.area[reference as usize] {
            reference = id as i64;
        }
    }
    let mut island_column = vec![-1i32; lands.cells.len()];
    let mut unknowns = 0i32;
    for id in 0..lands.cells.len() {
        if id as i64 == reference {
            continue;
        }
        let coast = lands.cells[id]
            .iter()
            .any(|&c| fm.edges(c as usize).any(|e| land[fm.nbr[e] as usize] == 0));
        if coast {
            island_column[id] = unknowns;
            unknowns += 1;
        }
    }
    let mut column = vec![-1i32; n];
    let mut pinned: i64 = -1;
    for i in 0..n {
        if land[i] != 0 {
            continue;
        }
        if reference < 0 && pinned < 0 {
            pinned = i as i64;
            continue;
        }
        column[i] = unknowns;
        unknowns += 1;
    }
    let col_of = |j: usize| -> i32 {
        if land[j] != 0 {
            island_column[lands.label[j] as usize]
        } else {
            column[j]
        }
    };
    let unknowns = unknowns as usize;
    let mut rows: Vec<Vec<(u32, f64)>> = vec![Vec::new(); unknowns];
    let mut rhs = vec![0.0; unknowns];
    let edge = |row: &mut Vec<(u32, f64)>, own: i32, i: usize, e: usize| {
        let j = fm.nbr[e] as usize;
        let b = 0.5 * (beta[i] + beta[j]) * wall_east[e] * 0.5;
        row.push((own as u32, fm.coupling[e] - b));
        let c = col_of(j);
        if c >= 0 {
            row.push((c as u32, -(fm.coupling[e] + b)));
        }
    };
    for i in 0..n {
        let own = column[i];
        if own < 0 {
            continue;
        }
        let mut row = Vec::new();
        for e in fm.edges(i) {
            edge(&mut row, own, i, e);
        }
        rows[own as usize] = row;
        rhs[own as usize] = -fm.area[i] * curl[i];
    }
    for id in 0..lands.cells.len() {
        let own = island_column[id];
        if own < 0 {
            continue;
        }
        let mut row = Vec::new();
        let mut sum = 0.0;
        for &c in &lands.cells[id] {
            let c = c as usize;
            sum += fm.area[c] * curl[c];
            for e in fm.edges(c) {
                if land[fm.nbr[e] as usize] == 0 {
                    edge(&mut row, own, c, e);
                }
            }
        }
        rows[own as usize] = row;
        rhs[own as usize] = -sum;
    }
    let mut x = vec![0.0; unknowns];
    let mut solve = EMPTY_SOLVE;
    if unknowns > 0 {
        let matrix = sparse_matrix(&rows);
        let (of, count) = aggregate(&matrix, STOMMEL_AGGREGATE_HOPS, 16);
        let mut pre = two_level_preconditioner(&matrix, &of, count);
        solve = solve_bicgstab(
            unknowns,
            &mut |v, out| sparse_apply(&matrix, v, out),
            &mut |r, out| pre.apply(r, out),
            &rhs,
            &mut x,
            SolveOptions {
                tolerance: 1e-10,
                max_iterations: 2000,
            },
        );
    }
    let psi = (0..n)
        .map(|i| {
            let c = col_of(i);
            if c >= 0 { x[c as usize] } else { 0.0 }
        })
        .collect();
    StommelSolution {
        psi,
        solve,
        islands: island_column.iter().filter(|&&c| c >= 0).count(),
        landmasses: lands.cells.len(),
    }
}

/// The overturning's surface inflow: east and south per sea cell, scaled
/// to a fastest cell of 1, and its solve.
pub struct OceanFlow {
    pub e: Vec<f64>,
    pub s: Vec<f64>,
    pub solve: SolveReport,
}

/// The surface water drawn toward where it sinks (`sink` per cell), each
/// connected sea its own balance.
pub fn compute_sink_inflow(
    sh: &SharedFieldMesh,
    terrain: &ClimateTerrain,
    sink: &[f64],
) -> OceanFlow {
    let fm = &sh.mesh;
    let n = fm.count;
    let sea: Vec<u8> = terrain.land.iter().map(|&l| u8::from(l == 0)).collect();
    let seas = mesh_components(fm, &sea);
    let mut sank = vec![0.0; seas.cells.len()];
    let mut total = 0.0;
    for id in 0..seas.cells.len() {
        for &c in &seas.cells[id] {
            sank[id] += fm.area[c as usize] * sink[c as usize];
        }
        total += sank[id];
    }
    let mut e = vec![0.0; n];
    let mut s = vec![0.0; n];
    // `!(total > 0)`: NaN too.
    if total.is_nan() || total <= 0.0 {
        return OceanFlow {
            e,
            s,
            solve: EMPTY_SOLVE,
        };
    }
    let mut b = vec![0.0; n];
    let mut diag = vec![0.0; n];
    for i in 0..n {
        if sea[i] == 0 {
            continue;
        }
        let id = seas.label[i] as usize;
        b[i] = fm.area[i] * (sink[i] - sank[id] / seas.area[id]);
        for k in fm.edges(i) {
            if sea[fm.nbr[k] as usize] != 0 {
                diag[i] += fm.coupling[k];
            }
        }
        if diag[i] == 0.0 {
            b[i] = 0.0;
        }
    }
    let mut apply = |x: &[f64], out: &mut [f64]| {
        for i in 0..n {
            if sea[i] == 0 {
                out[i] = 0.0;
                continue;
            }
            let xi = x[i];
            let mut v = 0.0;
            for k in fm.edges(i) {
                let j = fm.nbr[k] as usize;
                if sea[j] != 0 {
                    v += fm.coupling[k] * (xi - x[j]);
                }
            }
            out[i] = v;
        }
    };
    let mut chi = vec![0.0; n];
    let solve = conjugate_gradient(
        n,
        &mut apply,
        &diag,
        &b,
        &mut chi,
        SolveOptions {
            tolerance: 1e-10,
            max_iterations: 5000,
        },
    );
    for id in 0..seas.cells.len() {
        let mut m = 0.0;
        for &c in &seas.cells[id] {
            m += fm.area[c as usize] * chi[c as usize];
        }
        m /= seas.area[id];
        for &c in &seas.cells[id] {
            chi[c as usize] -= m;
        }
    }
    let mut fastest = 0.0;
    for i in 0..n {
        if sea[i] == 0 {
            continue;
        }
        let (mut ge, mut gs) = (0.0, 0.0);
        for k in fm.edges(i) {
            let j = fm.nbr[k] as usize;
            if sea[j] == 0 {
                continue;
            }
            let d = chi[j] - chi[i];
            ge += fm.grad_e[k] * d;
            gs += fm.grad_s[k] * d;
        }
        e[i] = ge;
        s[i] = gs;
        fastest = js::max(fastest, det_hypot(ge, gs));
    }
    if fastest > 0.0 {
        for i in 0..n {
            e[i] /= fastest;
            s[i] /= fastest;
        }
    }
    OceanFlow { e, s, solve }
}

/// The Ekman upwelling per sea cell, positive where water comes up, 0 on
/// land, per 62.4 km.
pub fn compute_upwelling(
    sh: &SharedFieldMesh,
    terrain: &ClimateTerrain,
    wind: &CellVectors,
    equator_offset: f64,
    rotation_hours: f64,
) -> Vec<f64> {
    let fm = &sh.mesh;
    let n = fm.count;
    let mut te = vec![0.0; n];
    let mut ts = vec![0.0; n];
    let mut sea = vec![0u8; n];
    for i in 0..n {
        if terrain.land[i] != 0 {
            continue;
        }
        sea[i] = 1;
        let y_norm = shifted_norm(terrain.cm.y_norm[i], equator_offset);
        let sign = if y_norm < 0.5 { 1.0 } else { -1.0 };
        let f =
            sign * js::max(
                CLIMATE_TUNING.upwelling_min_f,
                det_sin((latitude_of_norm(y_norm) * PI) / 2.0).abs(),
            ) * (24.0 / rotation_hours);
        te[i] = -wind.s[i] / f;
        ts[i] = wind.e[i] / f;
    }
    let mut out = vec![0.0; n];
    divergence(fm, &te, &ts, &mut out, Some(&sea));
    for v in &mut out {
        *v *= CLIMATE_TUNING.climate_gradient_length_m;
    }
    out
}

/// The sea's anomaly carried onto the land with the wind, °C per land cell.
pub fn carry_inland(
    sh: &mut SharedFieldMesh,
    terrain: &ClimateTerrain,
    sea_anomaly: &[f64],
    wind: &CellVectors,
) -> Vec<f64> {
    let t = &CLIMATE_TUNING;
    let land = &terrain.land;
    let domain = &terrain.domain;
    let n = sh.mesh.count;
    let mut out = vec![0.0; n];
    let step = terrain.cm.cell_m;
    let steps = js::max(1.0, js::round(t.currents_inland_reach_m / step)) as usize;
    for i in 0..n {
        if land[i] == 0 {
            continue;
        }
        let mut lee = 0.0;
        for e in sh.mesh.edges(i) {
            let j = sh.mesh.nbr[e] as usize;
            let a = if land[j] != 0 { 0.0 } else { sea_anomaly[j] };
            if f64::abs(a) > f64::abs(lee) {
                lee = a;
            }
        }
        let mut carried = 0.0;
        let u = wind.e[i];
        let v = wind.s[i];
        let speed = det_hypot(u, v);
        if speed > 0.0 {
            for k in 1..=steps {
                let d = (k as f64 * step) / sh.mesh.unit_m;
                let p = domain.advance(
                    sh.mesh.x[i],
                    sh.mesh.y[i],
                    -(u / speed) * d,
                    -(v / speed) * d,
                );
                let j =
                    sh.sampler
                        .nearest_cell(&mut sh.mesh, domain.wrap_x(p.x), domain.wrap_y(p.y));
                if land[j] != 0 {
                    continue;
                }
                carried =
                    sea_anomaly[j] * det_exp(-((k - 1) as f64 * step) / t.currents_inland_decay_m);
                break;
            }
        }
        let breeze = lee * t.currents_coastal_lee_share;
        out[i] = if f64::abs(carried) > f64::abs(breeze) {
            carried
        } else {
            breeze
        };
    }
    out
}

/// The departures of the sea's surface along normalised currents for one
/// pass of the transport.
pub fn current_departures(
    sh: &mut SharedFieldMesh,
    currents_e: &[f64],
    currents_s: &[f64],
) -> Departures {
    let mut dep = departures(&sh.mesh);
    compute_departures(
        &mut sh.mesh,
        &sh.sampler,
        currents_e,
        currents_s,
        CLIMATE_TUNING.currents_advect_step_m,
        &mut dep,
        2,
    );
    dep
}

/// The currents' heat transport applied to `temperature` in place; returns
/// the currents' mark on the sea (SST minus base, 0 on land).
pub fn apply_ocean_sst(
    sh: &mut SharedFieldMesh,
    terrain: &ClimateTerrain,
    temperature: &mut [f64],
    currents: &OceanCurrents,
    wind: &CellVectors,
) -> Vec<f64> {
    let t = &CLIMATE_TUNING;
    let land = &terrain.land;
    let n = sh.mesh.count;
    let dep = current_departures(sh, &currents.e, &currents.s);
    let base = temperature.to_vec();
    let mut sst = temperature.to_vec();
    let mut next = vec![0.0; n];
    let relax = t.currents_base_relax;
    for _ in 0..t.currents_advect_iters as usize {
        transport_scalar(&sh.mesh, &dep, &sst, &mut next, None, false);
        for i in 0..n {
            next[i] = if land[i] != 0 {
                base[i]
            } else {
                next[i] * (1.0 - relax) + base[i] * relax
            };
        }
        std::mem::swap(&mut sst, &mut next);
    }
    let anomaly: Vec<f64> = (0..n)
        .map(|i| if land[i] == 0 { sst[i] - base[i] } else { 0.0 })
        .collect();
    let inland = carry_inland(sh, terrain, &anomaly, wind);
    for i in 0..n {
        temperature[i] = if land[i] != 0 {
            base[i] + t.currents_coastal_factor * inland[i]
        } else {
            sst[i]
        };
    }
    anomaly
}
