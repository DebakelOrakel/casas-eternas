//! The module test of the mesh building (hilbert, lattice, mesh_density,
//! mesh_state, mesh_relief, remesh, mesh_build) and of `rng` against the
//! TypeScript engine: the same scenarios give the same bits
//! (docs/decisions/rust-engine.md, fork 5). The fixture is written by
//! `engine/scripts/meshFixture.mjs`; the scenarios below are that script's,
//! step for step.

use casas_engine::core::det_math::{det_cos, det_sin};
use casas_engine::core::domain::Domain;
use casas_engine::core::rng::Mulberry32;
use casas_engine::mesh::hilbert::{hilbert_key, hilbert_order};
use casas_engine::mesh::lattice::{centroidal_geodesic_lattice, geodesic_lattice, hex_lattice};
use casas_engine::mesh::mesh_build::{
    DensityTarget, FieldSampler, MESH_DISCHARGE, MESH_Z, build_mesh, triangulate_points,
};
use casas_engine::mesh::mesh_column::{COLUMN_DEPTH, MESH_COLUMN};
use casas_engine::mesh::mesh_density::{MESH_TUNING, target_spacing_m};
use casas_engine::mesh::mesh_erosion::build_mesh_engine_index;
use casas_engine::mesh::mesh_neighbourhood as nb;
use casas_engine::mesh::mesh_state::{FieldKind, MeshState};
use casas_engine::mesh::periodic_delaunay::PeriodicTriangulation;
use casas_engine::mesh::remesh::{RefineOptions, RemeshStats, remesh};

const FIXTURE: &str = include_str!("fixtures/mesh.txt");

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
    fn mesh(&mut self, m: &PeriodicTriangulation) {
        self.add_all(&m.vx);
        self.add_all(&m.vy);
        self.add_all(&m.v_edge);
        self.add_all(&m.v_alive);
        self.add_all(&m.tris);
        self.add_all(&m.twin);
        self.add_all(&m.t_alive);
        self.add(m.walk_steps as f64);
        self.add(m.flips as f64);
    }
    fn state(&mut self, m: &PeriodicTriangulation, s: &MeshState) {
        for f in &s.fields {
            self.add_all(&f.data[..m.vertex_slots() * f.depth]);
        }
    }
    fn stats(&mut self, s: &RemeshStats) {
        self.add(s.rounds as f64);
        self.add(s.inserted as f64);
        self.add(s.removed as f64);
        for &n in &s.per_round {
            self.add(n);
        }
    }
    fn line(&self, name: &str) -> String {
        format!("{name} {:08x}", self.0)
    }
}

fn height_at(x: f64, y: f64) -> f64 {
    0.06 * det_sin(x * 0.011) * det_cos(y * 0.017) + 0.03 * det_sin(x * 0.041 + y * 0.023) - 0.04
}

fn discharge_at(x: f64, y: f64) -> f64 {
    2500.0 * (1.0 + det_sin(x * 0.05 + y * 0.03))
}

struct Analytic;

impl FieldSampler for Analytic {
    fn height_at(&self, x: f64, y: f64) -> f64 {
        height_at(x, y)
    }
    fn discharge_at(&self, x: f64, y: f64) -> Option<f64> {
        Some(discharge_at(x, y))
    }
    fn has_discharge(&self) -> bool {
        true
    }
}

fn expected(name: &str) -> String {
    FIXTURE
        .lines()
        .find(|l| l.split_whitespace().next() == Some(name))
        .unwrap_or_else(|| panic!("no {name} in the fixture"))
        .to_string()
}

#[test]
fn mulberry32_gives_the_typescript_draws() {
    let mut h = Hash::new();
    for seed in [0u32, 1, 0x9e3779b9, 0xffffffff] {
        let mut r = Mulberry32::new(seed);
        for _ in 0..1000 {
            h.add(r.next());
        }
    }
    assert_eq!(h.line("mulberry32"), expected("mulberry32"));
}

#[test]
fn the_hilbert_key_and_order_give_the_typescript_values() {
    let mut g = Gen(1);
    let mut h = Hash::new();
    for (x, y) in [
        (0.0, 0.0),
        (-1.0, 5.0),
        (2048.0, 1024.0),
        (3000.0, -7.0),
        (f64::NAN, 3.0),
        (f64::INFINITY, f64::NEG_INFINITY),
        (2047.9999, 1023.9999),
    ] {
        h.add(hilbert_key(x, y, 2048.0, 1024.0) as f64);
    }
    for _ in 0..100000 {
        let x = g.uniform(-100.0, 2148.0);
        h.add(hilbert_key(x, g.uniform(-100.0, 1124.0), 2048.0, 1024.0) as f64);
    }
    assert_eq!(h.line("hilbert_key"), expected("hilbert_key"));
    let mut xs = vec![0.0; 50000];
    let mut ys = vec![0.0; 50000];
    for i in 0..xs.len() {
        xs[i] = g.uniform(0.0, 2048.0);
        ys[i] = g.uniform(0.0, 64.0).floor() * 16.0;
    }
    let mut h = Hash::new();
    h.add_all(&hilbert_order(&xs, &ys, xs.len(), 2048.0, 1024.0));
    assert_eq!(h.line("hilbert_order"), expected("hilbert_order"));
}

#[test]
fn the_density_rule_gives_the_typescript_spacing() {
    let mut g = Gen(2);
    let mut h = Hash::new();
    for i in 0..20000 {
        let slope = if i % 97 == 0 {
            f64::NAN
        } else {
            g.uniform(-0.01, 0.3)
        };
        let q = if i % 89 == 0 {
            0.0
        } else {
            g.uniform(-10.0, 20000.0)
        };
        let k = g.uniform(-1e-3, 1e-3);
        let column = g.uniform(0.0, 100.0);
        let height = g.uniform(-1000.0, 3000.0);
        h.add(target_spacing_m(
            slope,
            q,
            k,
            column,
            height,
            if i % 2 == 0 { 1.0 } else { 0.25 },
        ));
    }
    assert_eq!(h.line("target_spacing"), expected("target_spacing"));
}

#[test]
fn the_lattices_give_the_typescript_meshes() {
    let mut h = Hash::new();
    h.mesh(&hex_lattice(&Domain::torus(2048.0, 1024.0), 40.0));
    assert_eq!(h.line("hex_lattice"), expected("hex_lattice"));
    let mut h = Hash::new();
    h.mesh(&geodesic_lattice(&Domain::sphere(2048.0, 1024.0), 30.0));
    assert_eq!(h.line("geodesic_lattice"), expected("geodesic_lattice"));
    let mut h = Hash::new();
    h.mesh(&centroidal_geodesic_lattice(
        &Domain::sphere(2048.0, 1024.0),
        60.0,
    ));
    assert_eq!(h.line("centroidal_lattice"), expected("centroidal_lattice"));
}

const BUDGET: f64 = 16.0;

fn build_remesh(name: &str, domain: Domain) {
    let built = build_mesh(&domain, &Analytic, 7, BUDGET, 24);
    let mut h = Hash::new();
    h.mesh(&built.mesh);
    h.state(&built.mesh, &built.state);
    h.stats(&built.stats);
    assert_eq!(
        h.line(&format!("{name}_build")),
        expected(&format!("{name}_build"))
    );

    let mut g = Gen(3);
    let m0 = &built.mesh;
    let (mut xs, mut ys) = (Vec::new(), Vec::new());
    for v in 0..m0.vertex_slots() {
        if m0.v_alive[v] == 0 {
            continue;
        }
        xs.push(m0.vx[v] + g.uniform(-0.6, 0.6));
        ys.push(m0.vy[v] + g.uniform(-0.6, 0.6));
    }
    let spacing = (MESH_TUNING.ocean_spacing_m * BUDGET) / domain.metres_per_unit;
    let (mut mesh, mapping) = triangulate_points(&domain, &xs, &ys, spacing);
    let mut h = Hash::new();
    h.mesh(&mesh);
    h.add_all(&mapping);
    assert_eq!(
        h.line(&format!("{name}_triangulate")),
        expected(&format!("{name}_triangulate"))
    );

    let mut s = MeshState::new(mesh.vertex_slots());
    s.add(MESH_Z, FieldKind::Intensive, 1);
    s.add(MESH_DISCHARGE, FieldKind::Intensive, 1);
    s.add("sediment", FieldKind::Extensive, 1);
    s.add(MESH_COLUMN, FieldKind::Extensive, COLUMN_DEPTH);
    for v in 0..mesh.vertex_slots() {
        if mesh.v_alive[v] == 0 {
            continue;
        }
        let (x, y) = (mesh.vx[v], mesh.vy[v]);
        s.get_mut(MESH_Z)[v] = (height_at(x, y) * 1.4) as f32;
        s.get_mut(MESH_DISCHARGE)[v] = discharge_at(x, y) as f32;
        s.get_mut("sediment")[v] = (10.0 + 5.0 * det_cos(x * 0.03)) as f32;
        let c = s.get_mut(MESH_COLUMN);
        c[v * COLUMN_DEPTH] = (40.0 * (1.0 + det_sin(x * 0.02 + y * 0.01))) as f32;
        c[v * COLUMN_DEPTH + 7] = (12.0 * (1.0 + det_cos(y * 0.05))) as f32;
    }
    let mut sample = |s: &mut MeshState,
                      _: &PeriodicTriangulation,
                      v: usize,
                      x: f64,
                      y: f64,
                      _: usize,
                      _: usize,
                      _: usize| {
        s.get_mut(MESH_Z)[v] = (height_at(x, y) * 1.4) as f32;
    };
    let mut options = RefineOptions::seeded(11);
    options.sample = Some(&mut sample);
    let mut target = DensityTarget {
        budget: BUDGET / 2.0,
    };
    let stats = remesh(&mut mesh, &mut s, &mut target, 4, &mut options);
    let mut h = Hash::new();
    h.mesh(&mesh);
    h.state(&mesh, &s);
    h.stats(&stats);
    assert_eq!(
        h.line(&format!("{name}_remesh")),
        expected(&format!("{name}_remesh"))
    );
    let errors = mesh.validate(true);
    assert!(
        errors.is_empty(),
        "{name}: invalid after the remesh: {:?}",
        &errors[..errors.len().min(3)]
    );

    let unit_m = domain.metres_per_unit;
    let z: Vec<f32> = s.get(MESH_Z).to_vec();
    let geo = nb::mesh_geometry(&mut mesh, unit_m);
    let mut h = Hash::new();
    h.add_all(&geo.cells.area_m2);
    h.add_all(&geo.cells.rho);
    h.add_all(&geo.cells.star_start);
    h.add_all(&geo.cells.star);
    h.add_all(&geo.length_m);
    h.add_all(&geo.wall_m);
    assert_eq!(
        h.line(&format!("{name}_geometry")),
        expected(&format!("{name}_geometry"))
    );
    let mut g = Gen(4);
    let centre: Vec<u8> = (0..mesh.vertex_slots())
        .map(|_| (g.next() & 1) as u8)
        .collect();
    let mut h = Hash::new();
    for (radius, admit) in [
        (30000.0, None),
        (10000.0, Some(&centre[..])),
        (120000.0, Some(&centre[..])),
    ] {
        let n = nb::neighbourhoods(&geo.cells, &mesh, radius, admit);
        h.add_all(&n.start);
        h.add_all(&n.member);
        h.add_all(&n.weight);
        h.add_all(&nb::max_within(&n, &z));
        h.add_all(&nb::mean_within(&n, &z));
    }
    assert_eq!(
        h.line(&format!("{name}_neighbourhoods")),
        expected(&format!("{name}_neighbourhoods"))
    );
    let mut h = Hash::new();
    for _ in 0..2000 {
        let x = g.uniform(0.0, domain.width);
        let y = g.uniform(0.0, domain.height);
        h.add(nb::node_at(&mut mesh, x, y) as f64);
    }
    let mut stamp = vec![-1i64; mesh.vertex_slots()];
    for p in 0..200 {
        let x = g.uniform(0.0, domain.width);
        let y = g.uniform(0.0, domain.height);
        let mut visit = |v: usize, d: f64| {
            h.add(v as f64);
            h.add(d);
        };
        nb::around_point(
            &geo.cells, &mut mesh, x, y, 50000.0, &mut visit, &mut stamp, p,
        );
    }
    let mut points = Vec::new();
    for _ in 0..50 {
        let x = g.uniform(0.0, domain.width);
        points.push((x, g.uniform(0.0, domain.height)));
    }
    h.add_all(&nb::gaussian_halos(&geo, &mut mesh, &points, 20000.0));
    h.add_all(&nb::discs_around(&geo, &mut mesh, &points, 15000.0));
    h.add_all(&nb::slope_of(&geo, &mesh, &z));
    let use_: Vec<u8> = mesh.v_alive.clone();
    h.add_all(&nb::boundary_density(
        &geo,
        &mesh,
        &use_,
        &|a, b| (z[a] > 0.0) != (z[b] > 0.0),
        7800.0,
    ));
    h.add(mesh.last_tri as f64);
    h.add(mesh.walk_steps as f64);
    assert_eq!(
        h.line(&format!("{name}_around")),
        expected(&format!("{name}_around"))
    );
    let extra: Vec<u8> = (0..mesh.vertex_slots())
        .map(|_| u8::from(g.next().is_multiple_of(7)))
        .collect();
    let mut h = Hash::new();
    for frozen in [None, Some(&extra[..])] {
        let ix = build_mesh_engine_index(&mut mesh, &z, 40.0, unit_m, frozen);
        h.add(ix.cell_count as f64);
        h.add(ix.active_count as f64);
        h.add(ix.frozen_count as f64);
        h.add(ix.edge_count as f64);
        h.add(ix.ref_m);
        h.add_all(&ix.active);
        h.add_all(&ix.active_of);
        h.add_all(&ix.nbr_start);
        h.add_all(&ix.nbr);
        h.add_all(&ix.edge_rev);
        h.add_all(&ix.len_rel);
        h.add_all(&ix.diff_factor);
        h.add_all(&ix.mfd_factor);
        h.add_all(&ix.area_rel);
    }
    assert_eq!(
        h.line(&format!("{name}_engine_index")),
        expected(&format!("{name}_engine_index"))
    );
}

#[test]
fn the_torus_builds_and_remeshes_as_the_typescript_engine() {
    build_remesh("torus", Domain::torus(2048.0, 1024.0));
}

#[test]
fn the_sphere_builds_and_remeshes_as_the_typescript_engine() {
    build_remesh("sphere", Domain::sphere(2048.0, 1024.0));
}

fn read<T: Copy + Default>(dir: &str, name: &str) -> Vec<T> {
    let bytes = std::fs::read(format!("{dir}/{name}")).unwrap();
    let size = std::mem::size_of::<T>();
    bytes
        .chunks_exact(size)
        .map(|c| {
            let mut v = T::default();
            // SAFETY: T is a plain number type and the chunk is its size.
            unsafe { std::ptr::copy_nonoverlapping(c.as_ptr(), &mut v as *mut T as *mut u8, size) };
            v
        })
        .collect()
}

/// A real epoch's column mean height (pipeline/coupledEpoch.ts
/// `columnMeanHeight`): the 10 km neighbourhoods of the rising nodes of a
/// level-1 history at epoch 12 (3.7 M slots, 202 M members) and the mean
/// height over them, dumped from the TypeScript engine. Not in the
/// repository: `CASAS_ENGINE_NB_DUMP=<dir> cargo test --release -- --ignored`.
#[test]
#[ignore]
fn a_dumped_column_mean_height_gives_the_typescript_values() {
    let dir = std::env::var("CASAS_ENGINE_NB_DUMP")
        .expect("CASAS_ENGINE_NB_DUMP names the dump directory");
    let alive: Vec<u8> = read(&dir, "alive.u8");
    let slots = alive.len();
    let mut mesh = PeriodicTriangulation::new(Domain::sphere(2048.0, 1024.0));
    mesh.vx = vec![0.0; slots];
    mesh.vy = vec![0.0; slots];
    mesh.v_alive = alive;
    mesh.vu = read(&dir, "vu.f64");
    let unit_m = mesh.domain.metres_per_unit;
    let star_start: Vec<i32> = read(&dir, "starStart.i32");
    let star: Vec<i32> = read(&dir, "star.i32");
    let geo = nb::MeshStar::from_parts(
        unit_m,
        vec![0.0; slots],
        read(&dir, "rho.f64"),
        star_start.iter().map(|&v| v as u32).collect(),
        star.iter().map(|&v| v as u32).collect(),
        true,
        (2048.0 / (2.0 * std::f64::consts::PI)) * unit_m,
    );
    let rising: Vec<u8> = read(&dir, "rising.u8");
    let height: Vec<f32> = read(&dir, "height.f32");
    let start = std::time::Instant::now();
    let n = nb::neighbourhoods(&geo, &mesh, 10000.0, Some(&rising));
    let result = nb::mean_within(&n, &height);
    eprintln!(
        "{} members in {:.0} ms",
        n.member.len(),
        start.elapsed().as_secs_f64() * 1e3
    );
    let want: Vec<f32> = read(&dir, "result.f32");
    let differ = result
        .iter()
        .zip(&want)
        .filter(|(a, b)| a.to_bits() != b.to_bits())
        .count();
    assert_eq!(differ, 0, "{differ} of {slots} differ");
}
