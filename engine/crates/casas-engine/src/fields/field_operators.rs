//! `fields/fieldOperators.ts`: THE OPERATORS ON A FIELD MESH (DEC-0036):
//! diffusion, gradient, divergence, semi-Lagrangian transport, the elliptic
//! and the general solvers, sparse matrices with ILU(0) and a two-level
//! preconditioner. One code for both shapes; the shape is in the mesh's
//! geometry. Fields are f64 per cell. The reasoning is in the TypeScript
//! file.
//!
//! Not ported, because they change the time and nothing else: the per-mesh
//! caches of the convex diffusion limit and of the east wall normals.

use crate::core::js;

use super::field_mesh::{FieldMesh, FieldSampler};

// ------------------------------------------------------------- frames

/// Neighbour `fm.nbr[e]`'s vector (ve, vs), in its own frame, read in the
/// frame of the cell that owns edge e.
pub fn carry_from(fm: &FieldMesh, e: usize, ve: f64, vs: f64) -> (f64, f64) {
    let c = fm.turn_c[e];
    let s = fm.turn_s[e];
    (c * ve - s * vs, s * ve + c * vs)
}

// ---------------------------------------------------------- diffusion

/// The Laplacian ∇²φ per cell: Σ_j k_ij (φj − φi) / A_i.
pub fn laplacian(fm: &FieldMesh, phi: &[f64], out: &mut [f64]) {
    for i in 0..fm.count {
        let p = phi[i];
        let mut s = 0.0;
        for e in fm.edges(i) {
            s += fm.coupling[e] * (phi[fm.nbr[e] as usize] - p);
        }
        out[i] = s / fm.area[i];
    }
}

/// The largest explicit step (seconds, κ in m²/s) that keeps every cell's
/// new value a convex combination of the old.
pub fn stable_diffusion_step(fm: &FieldMesh, kappa: f64) -> f64 {
    let mut best = f64::INFINITY;
    for i in 0..fm.count {
        let mut s = 0.0;
        for e in fm.edges(i) {
            s += fm.coupling[e];
        }
        let dt = fm.area[i] / (kappa * s);
        if dt < best {
            best = dt;
        }
    }
    best
}

/// One explicit diffusion step, φ + dt · κ ∇²φ, into out.
pub fn diffuse_explicit(fm: &FieldMesh, phi: &[f64], kappa: f64, dt: f64, out: &mut [f64]) {
    let k = kappa * dt;
    for i in 0..fm.count {
        let p = phi[i];
        let mut s = 0.0;
        for e in fm.edges(i) {
            s += fm.coupling[e] * (phi[fm.nbr[e] as usize] - p);
        }
        out[i] = p + (k * s) / fm.area[i];
    }
}

/// One implicit diffusion step, (1 − dt κ ∇²) φ' = φ, from φ as the first
/// guess; `phi` receives the result.
pub fn diffuse_implicit(
    fm: &FieldMesh,
    phi: &mut [f64],
    kappa: f64,
    dt: f64,
    options: SolveOptions,
) -> SolveReport {
    let alpha = 1.0 / (kappa * dt);
    let rhs: Vec<f64> = phi.iter().map(|&p| -alpha * p).collect();
    solve_helmholtz(fm, alpha, &rhs, phi, options)
}

/// A Gaussian smoothing of standard deviation `sigma_m` per axis: diffusion
/// to κt = σ²/2 in equal explicit steps no larger than the convex limit.
pub fn smooth_gaussian(fm: &FieldMesh, phi: &[f64], sigma_m: f64) -> Vec<f64> {
    let kt = (sigma_m * sigma_m) / 2.0;
    let limit = stable_diffusion_step(fm, 1.0);
    let steps = js::max(1.0, (kt / limit).ceil()) as usize;
    let mut a = phi[..fm.count].to_vec();
    let mut b = vec![0.0; fm.count];
    for _ in 0..steps {
        diffuse_explicit(fm, &a, 1.0, kt / steps as f64, &mut b);
        std::mem::swap(&mut a, &mut b);
    }
    a
}

// ------------------------------------------------- gradient, divergence

/// The least-squares gradient: east and south per cell, in its frame.
pub fn gradient(fm: &FieldMesh, phi: &[f64], out_e: &mut [f64], out_s: &mut [f64]) {
    for i in 0..fm.count {
        let p = phi[i];
        let (mut ge, mut gs) = (0.0, 0.0);
        for e in fm.edges(i) {
            let d = phi[fm.nbr[e] as usize] - p;
            ge += fm.grad_e[e] * d;
            gs += fm.grad_s[e] * d;
        }
        out_e[i] = ge;
        out_s[i] = gs;
    }
}

/// The divergence of a vector field by finite volumes. With `within`, only
/// the walls between two cells inside carry a flux and a cell outside gets
/// 0.
pub fn divergence(fm: &FieldMesh, ve: &[f64], vs: &[f64], out: &mut [f64], within: Option<&[u8]>) {
    for i in 0..fm.count {
        if within.is_some_and(|w| w[i] == 0) {
            out[i] = 0.0;
            continue;
        }
        let ae = ve[i];
        let a_s = vs[i];
        let mut s = 0.0;
        for e in fm.edges(i) {
            let j = fm.nbr[e] as usize;
            if within.is_some_and(|w| w[j] == 0) {
                continue;
            }
            let c = fm.turn_c[e];
            let sn = fm.turn_s[e];
            let be = c * ve[j] - sn * vs[j];
            let bs = sn * ve[j] + c * vs[j];
            s += (fm.wall[e] * (0.5 * (ae + be) * fm.off_e[e] + 0.5 * (a_s + bs) * fm.off_s[e]))
                / fm.dist[e];
        }
        out[i] = s / fm.area[i];
    }
}

// ------------------------------------------------- semi-Lagrangian transport

/// Where each cell's parcel was a step ago: the point, its triangle's
/// corners and weights, on the sphere its unit vector, and each corner's
/// offset to it in that corner's frame (metres).
pub struct Departures {
    pub x: Vec<f64>,
    pub y: Vec<f64>,
    pub corners: Vec<u32>,
    pub weights: Vec<f64>,
    pub unit: Vec<f64>,
    pub off_e: Vec<f64>,
    pub off_s: Vec<f64>,
}

pub fn departures(fm: &FieldMesh) -> Departures {
    let n = fm.count;
    Departures {
        x: vec![0.0; n],
        y: vec![0.0; n],
        corners: vec![0; 3 * n],
        weights: vec![0.0; 3 * n],
        unit: vec![0.0; if fm.globe { 3 * n } else { 0 }],
        off_e: vec![0.0; 3 * n],
        off_s: vec![0.0; 3 * n],
    }
}

/// The departures of a wind (m/s per cell in its frame) over dt seconds:
/// the midpoint rule along the great circle, `iterations` times.
pub fn compute_departures(
    fm: &mut FieldMesh,
    sampler: &FieldSampler,
    ve: &[f64],
    vs: &[f64],
    dt: f64,
    out: &mut Departures,
    iterations: usize,
) {
    let scale = dt / fm.unit_m;
    for i in 0..fm.count {
        let (mut vx, mut vy) = (ve[i], vs[i]);
        for _ in 0..iterations {
            let p = fm
                .domain
                .advance(fm.x[i], fm.y[i], -0.5 * scale * vx, -0.5 * scale * vy);
            (vx, vy) = sampler.sample_vector(fm, ve, vs, p.x, p.y, Some(i));
        }
        let p = fm
            .domain
            .advance(fm.x[i], fm.y[i], -scale * vx, -scale * vy);
        tap_departure(fm, sampler, out, i, p.x, p.y);
    }
}

/// Departures known exactly: cell i's parcel was at (px[i], py[i]).
pub fn departures_from_points(
    fm: &mut FieldMesh,
    sampler: &FieldSampler,
    px: &[f64],
    py: &[f64],
    out: &mut Departures,
) {
    for i in 0..fm.count {
        tap_departure(fm, sampler, out, i, px[i], py[i]);
    }
}

fn tap_departure(
    fm: &mut FieldMesh,
    sampler: &FieldSampler,
    out: &mut Departures,
    i: usize,
    px: f64,
    py: f64,
) {
    out.x[i] = px;
    out.y[i] = py;
    let t = sampler.taps(fm, px, py);
    for k in 0..3 {
        let c = t.corners[k];
        out.corners[3 * i + k] = c as u32;
        out.weights[3 * i + k] = t.weights[k];
        let d = fm.domain.delta(px, py, fm.x[c], fm.y[c]);
        out.off_e[3 * i + k] = d.x * fm.unit_m;
        out.off_s[3 * i + k] = d.y * fm.unit_m;
    }
    if fm.globe {
        let gf = fm.domain.globe_frame(px, py);
        let r = fm.domain.radius();
        out.unit[3 * i] = gf.px / r;
        out.unit[3 * i + 1] = gf.py / r;
        out.unit[3 * i + 2] = gf.pz / r;
    }
}

/// A scalar moved by the departures: linear in the departure's triangle, or
/// with the field's gradient each corner extended half way to the
/// departure; `clip` limits each value to its triangle's corner range.
pub fn transport_scalar(
    fm: &FieldMesh,
    dep: &Departures,
    phi: &[f64],
    out: &mut [f64],
    grad: Option<(&[f64], &[f64])>,
    clip: bool,
) {
    for i in 0..fm.count {
        let k = 3 * i;
        let (ca, cb, cc) = (
            dep.corners[k] as usize,
            dep.corners[k + 1] as usize,
            dep.corners[k + 2] as usize,
        );
        let (a, b, c) = (phi[ca], phi[cb], phi[cc]);
        let Some((ge, gs)) = grad else {
            out[i] = dep.weights[k] * a + dep.weights[k + 1] * b + dep.weights[k + 2] * c;
            continue;
        };
        let mut s = 0.0;
        for m in k..k + 3 {
            let n = dep.corners[m] as usize;
            s += dep.weights[m] * (phi[n] + 0.5 * (ge[n] * dep.off_e[m] + gs[n] * dep.off_s[m]));
        }
        if clip {
            let lo = js::min(js::min(a, b), c);
            let hi = js::max(js::max(a, b), c);
            s = if s < lo {
                lo
            } else if s > hi {
                hi
            } else {
                s
            };
        }
        out[i] = s;
    }
}

/// A vector field moved by the departures, carried along the great circle
/// to the arrival cell and read in its frame.
pub fn transport_vector(
    fm: &FieldMesh,
    dep: &Departures,
    ve: &[f64],
    vs: &[f64],
    out_e: &mut [f64],
    out_s: &mut [f64],
) {
    for i in 0..fm.count {
        if !fm.globe {
            let (mut e, mut s) = (0.0, 0.0);
            for k in 3 * i..3 * i + 3 {
                e += dep.weights[k] * ve[dep.corners[k] as usize];
                s += dep.weights[k] * vs[dep.corners[k] as usize];
            }
            out_e[i] = e;
            out_s[i] = s;
            continue;
        }
        let (mut vx, mut vy, mut vz) = (0.0, 0.0, 0.0);
        for k in 3 * i..3 * i + 3 {
            let c = dep.corners[k] as usize;
            let a = ve[c] * dep.weights[k];
            let b = vs[c] * dep.weights[k];
            vx += a * fm.east[3 * c] + b * fm.south[3 * c];
            vy += a * fm.east[3 * c + 1] + b * fm.south[3 * c + 1];
            vz += a * fm.east[3 * c + 2] + b * fm.south[3 * c + 2];
        }
        let (qx, qy, qz) = (dep.unit[3 * i], dep.unit[3 * i + 1], dep.unit[3 * i + 2]);
        let r = vx * qx + vy * qy + vz * qz;
        vx -= r * qx;
        vy -= r * qy;
        vz -= r * qz;
        let o = 3 * i;
        let (ux, uy, uz) = (fm.u[o], fm.u[o + 1], fm.u[o + 2]);
        let c = qx * ux + qy * uy + qz * uz;
        let wx = qy * uz - qz * uy;
        let wy = qz * ux - qx * uz;
        let wz = qx * uy - qy * ux;
        let k = (wx * vx + wy * vy + wz * vz) / (1.0 + c);
        let rx = c * vx + (wy * vz - wz * vy) + wx * k;
        let ry = c * vy + (wz * vx - wx * vz) + wy * k;
        let rz = c * vz + (wx * vy - wy * vx) + wz * k;
        out_e[i] = rx * fm.east[o] + ry * fm.east[o + 1] + rz * fm.east[o + 2];
        out_s[i] = rx * fm.south[o] + ry * fm.south[o + 1] + rz * fm.south[o + 2];
    }
}

// ------------------------------------------------------- elliptic solves

#[derive(Clone, Copy, Debug)]
pub struct SolveOptions {
    /// The relative residual |b − Ax| / |b| to stop at, and the cap.
    pub tolerance: f64,
    pub max_iterations: usize,
}

impl Default for SolveOptions {
    fn default() -> Self {
        SolveOptions {
            tolerance: 1e-10,
            max_iterations: 2000,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SolveReport {
    pub iterations: usize,
    pub residual: f64,
    pub converged: bool,
    /// For α = 0: the area-weighted mean of f that was removed.
    pub removed_mean: f64,
}

/// (∇² − α) φ = f by conjugate gradients, α ≥ 0 (1/m²); `phi` holds the
/// first guess and receives the solution. For α = 0 f's mean is removed and
/// the solution has an area-weighted mean of 0.
pub fn solve_helmholtz(
    fm: &FieldMesh,
    alpha: f64,
    f: &[f64],
    phi: &mut [f64],
    options: SolveOptions,
) -> SolveReport {
    let n = fm.count;
    let mut total_area = 0.0;
    for i in 0..n {
        total_area += fm.area[i];
    }
    let mut removed_mean = 0.0;
    if alpha == 0.0 {
        let mut m = 0.0;
        for i in 0..n {
            m += fm.area[i] * f[i];
        }
        removed_mean = m / total_area;
    }
    let b: Vec<f64> = (0..n)
        .map(|i| -fm.area[i] * (f[i] - removed_mean))
        .collect();
    let diag: Vec<f64> = (0..n)
        .map(|i| {
            let mut s = alpha * fm.area[i];
            for e in fm.edges(i) {
                s += fm.coupling[e];
            }
            s
        })
        .collect();
    let mut apply = |x: &[f64], out: &mut [f64]| {
        for i in 0..n {
            let xi = x[i];
            let mut s = alpha * fm.area[i] * xi;
            for e in fm.edges(i) {
                s += fm.coupling[e] * (xi - x[fm.nbr[e] as usize]);
            }
            out[i] = s;
        }
    };
    let mut report = conjugate_gradient(n, &mut apply, &diag, &b, phi, options);
    if alpha == 0.0 {
        let mut m = 0.0;
        for i in 0..n {
            m += fm.area[i] * phi[i];
        }
        m /= total_area;
        for p in phi.iter_mut().take(n) {
            *p -= m;
        }
    }
    report.removed_mean = removed_mean;
    report
}

/// A system's product: `apply(x, out)` writes A x.
pub type Apply<'a> = &'a mut dyn FnMut(&[f64], &mut [f64]);

/// A symmetric positive (semi-)definite system A x = b by conjugate
/// gradients with a Jacobi preconditioner (a zero diagonal entry leaves its
/// unknown alone); `x` holds the first guess and receives the solution.
pub fn conjugate_gradient(
    n: usize,
    apply: Apply,
    diag: &[f64],
    b: &[f64],
    x: &mut [f64],
    options: SolveOptions,
) -> SolveReport {
    let mut r = vec![0.0; n];
    let mut z = vec![0.0; n];
    let mut p = vec![0.0; n];
    let mut q = vec![0.0; n];
    apply(x, &mut q);
    let mut b_norm = 0.0;
    for i in 0..n {
        r[i] = b[i] - q[i];
        b_norm += b[i] * b[i];
    }
    b_norm = b_norm.sqrt();
    if b_norm == 0.0 {
        x[..n].fill(0.0);
        return SolveReport {
            iterations: 0,
            residual: 0.0,
            converged: true,
            removed_mean: 0.0,
        };
    }
    let mut rz = 0.0;
    for i in 0..n {
        z[i] = if diag[i] != 0.0 { r[i] / diag[i] } else { 0.0 };
        p[i] = z[i];
        rz += r[i] * z[i];
    }
    let mut residual = 0.0;
    for it in 1..=options.max_iterations {
        apply(&p, &mut q);
        let mut pq = 0.0;
        for i in 0..n {
            pq += p[i] * q[i];
        }
        let a = rz / pq;
        let mut rr = 0.0;
        for i in 0..n {
            x[i] += a * p[i];
            r[i] -= a * q[i];
            rr += r[i] * r[i];
        }
        residual = rr.sqrt() / b_norm;
        if residual <= options.tolerance {
            return SolveReport {
                iterations: it,
                residual,
                converged: true,
                removed_mean: 0.0,
            };
        }
        let mut rz_next = 0.0;
        for i in 0..n {
            z[i] = if diag[i] != 0.0 { r[i] / diag[i] } else { 0.0 };
            rz_next += r[i] * z[i];
        }
        let beta = rz_next / rz;
        rz = rz_next;
        for i in 0..n {
            p[i] = z[i] + beta * p[i];
        }
    }
    SolveReport {
        iterations: options.max_iterations,
        residual,
        converged: false,
        removed_mean: 0.0,
    }
}

fn norm(a: &[f64]) -> f64 {
    let mut q = 0.0;
    for &v in a {
        q += v * v;
    }
    q.sqrt()
}

/// A general system A x = b by BiCGSTAB (van der Vorst 1992) with a
/// preconditioner (`precondition(r, out)` writes K⁻¹ r); `x` holds the first
/// guess and receives the solution. The true residual is recomputed at the
/// end; a breakdown restarts from the current x.
pub fn solve_bicgstab(
    n: usize,
    apply: Apply,
    precondition: Apply,
    b: &[f64],
    x: &mut [f64],
    options: SolveOptions,
) -> SolveReport {
    let tolerance = options.tolerance;
    let mut r = vec![0.0; n];
    let mut shadow = vec![0.0; n];
    let mut p = vec![0.0; n];
    let mut v = vec![0.0; n];
    let mut y = vec![0.0; n];
    let mut s = vec![0.0; n];
    let mut zz = vec![0.0; n];
    let mut t = vec![0.0; n];
    let b_norm = norm(&b[..n]);
    if b_norm == 0.0 {
        x[..n].fill(0.0);
        return SolveReport {
            iterations: 0,
            residual: 0.0,
            converged: true,
            removed_mean: 0.0,
        };
    }
    let restart = |apply: &mut dyn FnMut(&[f64], &mut [f64]),
                   x: &[f64],
                   r: &mut [f64],
                   shadow: &mut [f64],
                   p: &mut [f64],
                   v: &mut [f64]| {
        apply(x, v);
        for i in 0..n {
            r[i] = b[i] - v[i];
            shadow[i] = r[i];
            p[i] = 0.0;
            v[i] = 0.0;
        }
    };
    restart(apply, x, &mut r, &mut shadow, &mut p, &mut v);
    let mut rho = 1.0;
    let mut alpha = 1.0;
    let mut omega = 1.0;
    let mut residual = norm(&r) / b_norm;
    let mut it = 0;
    while residual > tolerance && it < options.max_iterations {
        it += 1;
        let mut rho_next = 0.0;
        for i in 0..n {
            rho_next += shadow[i] * r[i];
        }
        if rho_next == 0.0 || omega == 0.0 {
            restart(apply, x, &mut r, &mut shadow, &mut p, &mut v);
            rho = 1.0;
            alpha = 1.0;
            omega = 1.0;
            continue;
        }
        let beta = (rho_next / rho) * (alpha / omega);
        rho = rho_next;
        for i in 0..n {
            p[i] = r[i] + beta * (p[i] - omega * v[i]);
        }
        precondition(&p, &mut y);
        apply(&y, &mut v);
        let mut sv = 0.0;
        for i in 0..n {
            sv += shadow[i] * v[i];
        }
        alpha = rho / sv;
        for i in 0..n {
            s[i] = r[i] - alpha * v[i];
        }
        if norm(&s) / b_norm <= tolerance {
            // The TypeScript code notes the residual here; the true one
            // below replaces it.
            for i in 0..n {
                x[i] += alpha * y[i];
            }
            break;
        }
        precondition(&s, &mut zz);
        apply(&zz, &mut t);
        let (mut ts, mut tt) = (0.0, 0.0);
        for i in 0..n {
            ts += t[i] * s[i];
            tt += t[i] * t[i];
        }
        omega = if tt > 0.0 { ts / tt } else { 0.0 };
        for i in 0..n {
            x[i] += alpha * y[i] + omega * zz[i];
            r[i] = s[i] - omega * t[i];
        }
        residual = norm(&r) / b_norm;
    }
    apply(x, &mut v);
    for i in 0..n {
        r[i] = b[i] - v[i];
    }
    let residual = norm(&r) / b_norm;
    SolveReport {
        iterations: it,
        residual,
        converged: residual <= tolerance * 10.0,
        removed_mean: 0.0,
    }
}

/// Per directed edge, the wall's length times the east component of its
/// unit normal toward the neighbour, metres, exactly antisymmetric.
pub fn east_wall_normals(fm: &FieldMesh) -> Vec<f64> {
    (0..fm.nbr.len())
        .map(|e| (fm.wall[e] * (fm.off_e[e] - fm.off_e[fm.rev[e] as usize])) / (2.0 * fm.dist[e]))
        .collect()
}

// ------------------------------------------------------- sparse matrices

/// A square sparse matrix in compressed rows, columns ascending, the
/// diagonal among them.
#[derive(Clone, Debug)]
pub struct SparseMatrix {
    pub n: usize,
    pub start: Vec<u32>,
    pub col: Vec<u32>,
    pub val: Vec<f64>,
}

/// A matrix from its rows, each a list of (column, value) in any order (a
/// column given twice is summed, in the order given); every row must hold
/// its diagonal.
pub fn sparse_matrix(rows: &[Vec<(u32, f64)>]) -> SparseMatrix {
    let n = rows.len();
    let mut start = vec![0u32; n + 1];
    let mut col: Vec<u32> = Vec::new();
    let mut val: Vec<f64> = Vec::new();
    for (r, row) in rows.iter().enumerate() {
        start[r] = col.len() as u32;
        let mut sorted = row.clone();
        sorted.sort_by_key(|e| e.0);
        let mut has_diagonal = false;
        for &(c, v) in &sorted {
            if c as usize == r {
                has_diagonal = true;
            }
            if col.len() > start[r] as usize && *col.last().unwrap() == c {
                *val.last_mut().unwrap() += v;
            } else {
                col.push(c);
                val.push(v);
            }
        }
        assert!(has_diagonal, "sparseMatrix: row {r} has no diagonal");
    }
    start[n] = col.len() as u32;
    SparseMatrix { n, start, col, val }
}

/// out = A x.
pub fn sparse_apply(m: &SparseMatrix, x: &[f64], out: &mut [f64]) {
    for r in 0..m.n {
        let mut s = 0.0;
        for k in m.start[r] as usize..m.start[r + 1] as usize {
            s += m.val[k] * x[m.col[k] as usize];
        }
        out[r] = s;
    }
}

/// The incomplete LU factorisation with no fill, and its preconditioner
/// (LU)⁻¹.
pub struct Ilu0 {
    n: usize,
    start: Vec<u32>,
    col: Vec<u32>,
    lu: Vec<f64>,
    diag_at: Vec<usize>,
}

pub fn ilu0(m: &SparseMatrix) -> Ilu0 {
    let n = m.n;
    let mut lu = m.val.clone();
    let mut diag_at = vec![usize::MAX; n];
    for r in 0..n {
        for k in m.start[r] as usize..m.start[r + 1] as usize {
            if m.col[k] as usize == r {
                diag_at[r] = k;
            }
        }
    }
    let mut at = vec![-1i64; n];
    for i in 0..n {
        let row = m.start[i] as usize..m.start[i + 1] as usize;
        for k in row.clone() {
            at[m.col[k] as usize] = k as i64;
        }
        for p in row.clone() {
            let kc = m.col[p] as usize;
            if kc >= i {
                break;
            }
            let mut pivot = lu[diag_at[kc]];
            if pivot == 0.0 {
                pivot = m.val[diag_at[kc]];
            }
            lu[p] /= pivot;
            let lik = lu[p];
            for q in diag_at[kc] + 1..m.start[kc + 1] as usize {
                let w = at[m.col[q] as usize];
                if w >= 0 {
                    lu[w as usize] -= lik * lu[q];
                }
            }
        }
        for k in row {
            at[m.col[k] as usize] = -1;
        }
        if lu[diag_at[i]] == 0.0 {
            lu[diag_at[i]] = m.val[diag_at[i]];
        }
    }
    Ilu0 {
        n,
        start: m.start.clone(),
        col: m.col.clone(),
        lu,
        diag_at,
    }
}

impl Ilu0 {
    /// out = (LU)⁻¹ r.
    pub fn apply(&self, r: &[f64], out: &mut [f64]) {
        for i in 0..self.n {
            let mut s = r[i];
            for k in self.start[i] as usize..self.diag_at[i] {
                s -= self.lu[k] * out[self.col[k] as usize];
            }
            out[i] = s;
        }
        for i in (0..self.n).rev() {
            let mut s = out[i];
            for k in self.diag_at[i] + 1..self.start[i + 1] as usize {
                s -= self.lu[k] * out[self.col[k] as usize];
            }
            out[i] = s / self.lu[self.diag_at[i]];
        }
    }
}

/// Aggregates of a matrix's unknowns for a coarse correction: connected
/// patches grown breadth-first `hops` steps from the lowest unknown not yet
/// taken; rows longer than `long_row` stand alone.
pub fn aggregate(m: &SparseMatrix, hops: usize, long_row: usize) -> (Vec<u32>, usize) {
    let n = m.n;
    let mut of = vec![-1i64; n];
    let long = |r: usize| (m.start[r + 1] - m.start[r]) as usize > long_row;
    let mut count = 0usize;
    for seed in 0..n {
        if of[seed] >= 0 {
            continue;
        }
        let id = count as i64;
        count += 1;
        of[seed] = id;
        if long(seed) {
            continue;
        }
        let mut frontier = vec![seed];
        let mut h = 0;
        while h < hops && !frontier.is_empty() {
            let mut next = Vec::new();
            for &r in &frontier {
                for k in m.start[r] as usize..m.start[r + 1] as usize {
                    let c = m.col[k] as usize;
                    if of[c] >= 0 || long(c) {
                        continue;
                    }
                    of[c] = id;
                    next.push(c);
                }
            }
            frontier = next;
            h += 1;
        }
    }
    (of.into_iter().map(|v| v as u32).collect(), count)
}

/// A two-level preconditioner: ILU(0) smoothing, then a coarse correction on
/// aggregates solved by a dense LU with partial pivoting.
pub struct TwoLevel {
    m: SparseMatrix,
    of: Vec<u32>,
    nc: usize,
    coarse: Vec<f64>,
    perm: Vec<usize>,
    smooth: Ilu0,
    res: Vec<f64>,
    rc: Vec<f64>,
}

pub fn two_level_preconditioner(m: &SparseMatrix, of: &[u32], count: usize) -> TwoLevel {
    let nc = count;
    let mut coarse = vec![0.0; nc * nc];
    for r in 0..m.n {
        let big_i = of[r] as usize * nc;
        for k in m.start[r] as usize..m.start[r + 1] as usize {
            coarse[big_i + of[m.col[k] as usize] as usize] += m.val[k];
        }
    }
    let perm = dense_lu(&mut coarse, nc);
    TwoLevel {
        m: m.clone(),
        of: of.to_vec(),
        nc,
        coarse,
        perm,
        smooth: ilu0(m),
        res: vec![0.0; m.n],
        rc: vec![0.0; nc],
    }
}

impl TwoLevel {
    pub fn apply(&mut self, r: &[f64], out: &mut [f64]) {
        self.smooth.apply(r, out);
        sparse_apply(&self.m, out, &mut self.res);
        self.rc.fill(0.0);
        for i in 0..self.m.n {
            self.rc[self.of[i] as usize] += r[i] - self.res[i];
        }
        dense_solve(&self.coarse, &self.perm, self.nc, &mut self.rc);
        for i in 0..self.m.n {
            out[i] += self.rc[self.of[i] as usize];
        }
    }
}

/// In place: the LU factors of a dense row-major n × n matrix with partial
/// pivoting; returns the row permutation.
fn dense_lu(a: &mut [f64], n: usize) -> Vec<usize> {
    let mut perm: Vec<usize> = (0..n).collect();
    for k in 0..n {
        let mut p = k;
        let mut best = a[k * n + k].abs();
        for i in k + 1..n {
            let v = a[i * n + k].abs();
            if v > best {
                best = v;
                p = i;
            }
        }
        if p != k {
            for j in 0..n {
                a.swap(k * n + j, p * n + j);
            }
            perm.swap(k, p);
        }
        let d = a[k * n + k];
        if d == 0.0 {
            continue;
        }
        for i in k + 1..n {
            a[i * n + k] /= d;
            let f = a[i * n + k];
            if f == 0.0 {
                continue;
            }
            for j in k + 1..n {
                a[i * n + j] -= f * a[k * n + j];
            }
        }
    }
    perm
}

/// Solves (PLU) x = b in place in b; a zero pivot leaves its unknown 0.
fn dense_solve(a: &[f64], perm: &[usize], n: usize, b: &mut [f64]) {
    let mut y = vec![0.0; n];
    for i in 0..n {
        let mut s = b[perm[i]];
        for j in 0..i {
            s -= a[i * n + j] * y[j];
        }
        y[i] = s;
    }
    for i in (0..n).rev() {
        let mut s = y[i];
        for j in i + 1..n {
            s -= a[i * n + j] * y[j];
        }
        let d = a[i * n + i];
        y[i] = if d != 0.0 { s / d } else { 0.0 };
    }
    b[..n].copy_from_slice(&y);
}
