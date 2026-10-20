//! The module test of the field mesh (field_mesh, field_operators) against
//! the TypeScript engine's `fields/`: the same scenarios give the same bits
//! (docs/decisions/rust-engine.md, fork 5). The fixture is written by
//! `engine/scripts/fieldsFixture.mjs`; the scenarios below are that
//! script's, step for step.

// The scenarios keep the script's index loops.
#![allow(clippy::needless_range_loop)]

use casas_engine::core::det_math::{det_cos, det_sin};
use casas_engine::core::domain::Domain;
use casas_engine::fields::field_mesh::{
    create_field_mesh, create_field_sampler, raster_owners, rasterise_field, rasterise_vector_field,
};
use casas_engine::fields::field_operators as op;

const FIXTURE: &str = include_str!("fixtures/fields.txt");

struct Gen(u32);

impl Gen {
    fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_mul(1664525).wrapping_add(1013904223);
        self.0
    }
    fn uniform(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * (self.next() as f64 / 4294967296.0)
    }
}

struct Hash(u32);

impl Hash {
    fn new() -> Self {
        Hash(0x811c_9dc5)
    }
    fn add(&mut self, v: f64) {
        let b = if v.is_nan() {
            0x7ff8_0000_0000_0000
        } else {
            v.to_bits()
        };
        self.0 = (self.0 ^ b as u32).wrapping_mul(0x0100_0193);
        self.0 = (self.0 ^ (b >> 32) as u32).wrapping_mul(0x0100_0193);
    }
    fn add_all<T: Copy + Into<f64>>(&mut self, a: &[T]) {
        for &v in a {
            self.add(v.into());
        }
    }
    fn report(&mut self, r: &op::SolveReport) {
        self.add(r.iterations as f64);
        self.add(r.residual);
        self.add(if r.converged { 1.0 } else { 0.0 });
        self.add(r.removed_mean);
    }
    fn line(&self, name: &str) -> String {
        format!("{name} {:08x}", self.0)
    }
}

fn expected(name: &str) -> String {
    FIXTURE
        .lines()
        .find(|l| l.split_whitespace().next() == Some(name))
        .unwrap_or_else(|| panic!("no {name} in the fixture"))
        .to_string()
}

const SPACING_M: f64 = 150000.0;

fn scenario(name: &str, domain: Domain, seed: u32) {
    let mut g = Gen(seed);
    let mut fm = create_field_mesh(&domain, SPACING_M);
    let mut h = Hash::new();
    for a in [&fm.x, &fm.y, &fm.u, &fm.east, &fm.south, &fm.area] {
        h.add_all(a);
    }
    for a in [&fm.nbr_start, &fm.nbr, &fm.rev] {
        h.add_all(a);
    }
    for a in [
        &fm.wall,
        &fm.dist,
        &fm.coupling,
        &fm.off_e,
        &fm.off_s,
        &fm.turn_c,
        &fm.turn_s,
        &fm.grad_e,
        &fm.grad_s,
    ] {
        h.add_all(a);
    }
    h.add(fm.count as f64);
    h.add(fm.pentagons as f64);
    h.add(fm.max_degree as f64);
    h.add(fm.radius_m);
    assert_eq!(
        h.line(&format!("{name}_mesh")),
        expected(&format!("{name}_mesh"))
    );

    let n = fm.count;
    let mut phi = vec![0.0; n];
    let mut ve = vec![0.0; n];
    let mut vs = vec![0.0; n];
    for i in 0..n {
        phi[i] = det_sin(fm.x[i] * 0.01) * det_cos(fm.y[i] * 0.02) * 100.0;
        ve[i] = 10.0 * det_cos(fm.y[i] * 0.006);
        vs[i] = 3.0 * det_sin(fm.x[i] * 0.004);
    }
    let sampler = create_field_sampler(&mut fm);
    let mut h = Hash::new();
    for k in 0..5000 {
        let x = g.uniform(-10.0, domain.width + 10.0);
        let y = g.uniform(0.0, domain.height);
        let t = sampler.taps(&mut fm, x, y);
        h.add(t.triangle as f64);
        for c in t.corners {
            h.add(c as f64);
        }
        h.add_all(&t.weights);
        h.add(sampler.sample(&mut fm, &phi, x, y));
        let to = if k % 3 == 0 {
            None
        } else {
            Some(g.uniform(0.0, n as f64).floor() as usize)
        };
        let (vx, vy) = sampler.sample_vector(&mut fm, &ve, &vs, x, y, to);
        h.add(vx);
        h.add(vy);
        h.add(sampler.nearest_cell(&mut fm, x, y) as f64);
    }
    h.add_all(&rasterise_field(&mut fm, &phi, 128, 64));
    h.add_all(&rasterise_vector_field(&sampler, &mut fm, &ve, &vs, 64, 32));
    h.add_all(&raster_owners(&sampler, &mut fm, 64, 32));
    h.add(fm.tri.last_tri as f64);
    h.add(fm.tri.walk_steps as f64);
    assert_eq!(
        h.line(&format!("{name}_sampler")),
        expected(&format!("{name}_sampler"))
    );

    let mut h = Hash::new();
    let mut out = vec![0.0; n];
    let mut out2 = vec![0.0; n];
    op::laplacian(&fm, &phi, &mut out);
    h.add_all(&out);
    let dt = op::stable_diffusion_step(&fm, 2000.0);
    h.add(dt);
    op::diffuse_explicit(&fm, &phi, 2000.0, dt, &mut out);
    h.add_all(&out);
    let mut implicit = phi.clone();
    let r = op::diffuse_implicit(
        &fm,
        &mut implicit,
        2000.0,
        dt * 40.0,
        op::SolveOptions::default(),
    );
    h.report(&r);
    h.add_all(&implicit);
    h.add_all(&op::smooth_gaussian(&fm, &phi, 400000.0));
    op::gradient(&fm, &phi, &mut out, &mut out2);
    h.add_all(&out);
    h.add_all(&out2);
    let within: Vec<u8> = phi.iter().map(|&p| u8::from(p > -20.0)).collect();
    op::divergence(&fm, &ve, &vs, &mut out, None);
    h.add_all(&out);
    op::divergence(&fm, &ve, &vs, &mut out, Some(&within));
    h.add_all(&out);
    for e in 0..40 {
        let (x, y) = op::carry_from(&fm, e, 1.5, -0.5);
        h.add(x);
        h.add(y);
    }
    h.add_all(&op::east_wall_normals(&fm));
    assert_eq!(
        h.line(&format!("{name}_operators")),
        expected(&format!("{name}_operators"))
    );

    let mut h = Hash::new();
    let mut dep = op::departures(&fm);
    op::compute_departures(
        &mut fm,
        &sampler,
        &ve,
        &vs,
        3e4 * 86400.0 / 30.0,
        &mut dep,
        2,
    );
    let hash_dep = |h: &mut Hash, d: &op::Departures| {
        h.add_all(&d.x);
        h.add_all(&d.y);
        h.add_all(&d.corners);
        h.add_all(&d.weights);
        h.add_all(&d.unit);
        h.add_all(&d.off_e);
        h.add_all(&d.off_s);
    };
    hash_dep(&mut h, &dep);
    let mut ge = vec![0.0; n];
    let mut gs = vec![0.0; n];
    op::gradient(&fm, &phi, &mut ge, &mut gs);
    op::transport_scalar(&fm, &dep, &phi, &mut out, None, false);
    h.add_all(&out);
    op::transport_scalar(&fm, &dep, &phi, &mut out, Some((&ge, &gs)), false);
    h.add_all(&out);
    op::transport_scalar(&fm, &dep, &phi, &mut out, Some((&ge, &gs)), true);
    h.add_all(&out);
    op::transport_vector(&fm, &dep, &ve, &vs, &mut out, &mut out2);
    h.add_all(&out);
    h.add_all(&out2);
    let mut px = vec![0.0; n];
    let mut py = vec![0.0; n];
    for i in 0..n {
        px[i] = fm.x[i] + g.uniform(-3.0, 3.0);
        let y = fm.y[i] + g.uniform(-3.0, 3.0);
        py[i] = domain.height.min(0f64.max(y));
    }
    let mut dep2 = op::departures(&fm);
    op::departures_from_points(&mut fm, &sampler, &px, &py, &mut dep2);
    hash_dep(&mut h, &dep2);
    assert_eq!(
        h.line(&format!("{name}_transport")),
        expected(&format!("{name}_transport"))
    );

    let mut h = Hash::new();
    let mut sol = vec![0.0; n];
    let r = op::solve_helmholtz(&fm, 1e-11, &phi, &mut sol, op::SolveOptions::default());
    h.report(&r);
    h.add_all(&sol);
    let mut sol0 = vec![0.0; n];
    let options = op::SolveOptions {
        tolerance: 1e-9,
        ..Default::default()
    };
    let r = op::solve_helmholtz(&fm, 0.0, &phi, &mut sol0, options);
    h.report(&r);
    h.add_all(&sol0);
    let ew = op::east_wall_normals(&fm);
    let mut rows = Vec::with_capacity(n);
    for i in 0..n {
        let mut row = vec![(i as u32, 1e-11 * fm.area[i])];
        for e in fm.edges(i) {
            row.push((i as u32, fm.coupling[e]));
            row.push((fm.nbr[e], -fm.coupling[e] + 0.3 * ew[e] / fm.dist[e]));
        }
        rows.push(row);
    }
    let m = op::sparse_matrix(&rows);
    h.add_all(&m.start);
    h.add_all(&m.col);
    h.add_all(&m.val);
    let b: Vec<f64> = (0..n).map(|i| fm.area[i] * phi[i] * 1e-9).collect();
    let mut apply = |x: &[f64], o: &mut [f64]| op::sparse_apply(&m, x, o);
    let ilu = op::ilu0(&m);
    let mut xa = vec![0.0; n];
    let options = op::SolveOptions {
        tolerance: 1e-10,
        ..Default::default()
    };
    let r = op::solve_bicgstab(
        n,
        &mut apply,
        &mut |r, o| ilu.apply(r, o),
        &b,
        &mut xa,
        options,
    );
    h.report(&r);
    h.add_all(&xa);
    let (of, count) = op::aggregate(&m, 2, 16);
    h.add_all(&of);
    h.add(count as f64);
    let mut two = op::two_level_preconditioner(&m, &of, count);
    let mut xb = vec![0.0; n];
    let r = op::solve_bicgstab(
        n,
        &mut apply,
        &mut |r, o| two.apply(r, o),
        &b,
        &mut xb,
        options,
    );
    h.report(&r);
    h.add_all(&xb);
    let mut diag = vec![0.0; n];
    for i in 0..n {
        for k in m.start[i] as usize..m.start[i + 1] as usize {
            if m.col[k] as usize == i {
                diag[i] = m.val[k];
            }
        }
    }
    let mut xc = vec![0.0; n];
    let options = op::SolveOptions {
        max_iterations: 30,
        ..Default::default()
    };
    let r = op::solve_bicgstab(
        n,
        &mut apply,
        &mut |r, o| {
            for i in 0..n {
                o[i] = r[i] / diag[i];
            }
        },
        &b,
        &mut xc,
        options,
    );
    h.report(&r);
    h.add_all(&xc);
    assert_eq!(
        h.line(&format!("{name}_solvers")),
        expected(&format!("{name}_solvers"))
    );
}

#[test]
fn the_torus_field_mesh_gives_the_typescript_values() {
    scenario("torus", Domain::torus(2048.0, 1024.0), 1);
}

#[test]
fn the_sphere_field_mesh_gives_the_typescript_values() {
    scenario("sphere", Domain::sphere(2048.0, 1024.0), 2);
}
