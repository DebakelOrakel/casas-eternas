//! The module test of the level refinement (mesh/mesh_sampler,
//! surface/amplify, mesh/mesh_refine) against the TypeScript engine: the
//! same scenarios give the same bits (docs/decisions/rust-engine.md,
//! fork 5). The fixture is written by `engine/scripts/levelFixture.mjs`;
//! the scenarios below are that script's, step for step.

use casas_engine::core::det_math::{det_cos, det_sin};
use casas_engine::core::domain::Domain;
use casas_engine::mesh::mesh_build::{FieldSampler, MESH_Z, build_mesh};
use casas_engine::mesh::mesh_refine::{
    RefineLevelOptions, SynthesisLevel, level_seed, level_synthesis, refine_mesh_level,
};
use casas_engine::mesh::mesh_sampler::{DenseRegion, create_mesh_sampler};
use casas_engine::mesh::mesh_serial::{compact_mesh, permute};
use casas_engine::surface::amplify::{
    amplify_constants, ridged_at, ridged_at_on, seed_cascade_scales, seed_roughness_amplitude,
};

const FIXTURE: &str = include_str!("fixtures/level.txt");

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
}

fn check(name: &str, h: &Hash) {
    let expected = FIXTURE
        .lines()
        .find(|l| l.split_whitespace().next() == Some(name))
        .unwrap_or_else(|| panic!("no {name} in the fixture"));
    assert_eq!(format!("{name} {:08x}", h.0), expected);
}

/// The script's generator.
struct Lcg(u32);

impl Lcg {
    fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        self.0
    }
    fn uniform(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * (self.next() as f64 / 4_294_967_296.0)
    }
}

fn height_at(x: f64, y: f64) -> f64 {
    0.09 * det_sin(x * 0.006) * det_cos(y * 0.008)
        + 0.05 * det_sin(x * 0.019 + y * 0.011)
        + 0.03 * det_cos(x * 0.043 - y * 0.027)
        - 0.02
}

struct Analytic;

impl FieldSampler for Analytic {
    fn height_at(&self, x: f64, y: f64) -> f64 {
        height_at(x, y)
    }
}

#[test]
fn the_amplification_is_the_typescript_engine_s() {
    let mut r = Lcg(1);
    let mut h = Hash::new();
    for (k, v) in amplify_constants() {
        for c in k.encode_utf16() {
            h.add(c as f64);
        }
        h.add(v);
    }
    for res in [256.0, 1024.0, 2048.0, 4096.0, 8192.0, 65536.0] {
        h.add_all(&seed_cascade_scales(res));
    }
    for _ in 0..400 {
        h.add(seed_roughness_amplitude(r.uniform(-0.1, 0.3)));
    }
    let sphere = Domain::sphere(2048.0, 1024.0);
    for i in 0..4000u32 {
        let x = r.uniform(0.0, 2048.0);
        let y = r.uniform(0.0, 1024.0);
        h.add(ridged_at(x, y, 2048.0, 1024.0, i.wrapping_mul(7919)));
        h.add(ridged_at_on(&sphere, x, y, i.wrapping_mul(104_729)));
    }
    check("amplify", &h);
}

fn sampler_and_synthesis(name: &str, domain: Domain) {
    let built = build_mesh(&domain, &Analytic, 7, 4.0, 24);
    let mut mesh = built.mesh;
    let z: Vec<f32> = built.state.get(MESH_Z)[..mesh.vertex_slots()].to_vec();
    // The sampler, plain and over a dense region; both walk the one mesh.
    let mut r = Lcg(2);
    let mut h = Hash::new();
    for dense in [
        None,
        Some(DenseRegion {
            x: 1900.0,
            y: 300.0,
            width: 300.0,
            height: 200.0,
            nodes: 40000.0,
        }),
    ] {
        let mut ms = create_mesh_sampler(mesh, &z, dense);
        for _ in 0..3000 {
            let x = r.uniform(-10.0, 2058.0);
            let y = r.uniform(0.0, 1024.0);
            h.add(ms.triangle_at(x, y) as f64);
            h.add(ms.height_at(x, y));
            h.add(ms.sample_at(&z, x, y));
            h.add(ms.nearest_node_at(x, y) as f64);
            h.add_all(&ms.normal_at(x, y));
        }
        mesh = ms.mesh;
    }
    // The walk's length too: the hint grids change nothing but the walk.
    h.add(mesh.last_tri as f64);
    h.add(mesh.walk_steps as f64);
    check(&format!("{name}_sampler"), &h);

    // The level synthesis, both forms.
    let mut r = Lcg(3);
    let mut h = Hash::new();
    for sphere in [None, domain.is_sphere().then_some(&domain)] {
        let synth = level_synthesis(SynthesisLevel {
            seed: 4242,
            level: 1,
            budget: 1.0,
            width: 2048,
            height: 1024,
            sphere,
        });
        let mut relief = |x: f64, y: f64| 0.02 + 0.01 * det_sin(x * 0.01 + y);
        for _ in 0..3000 {
            let x = r.uniform(0.0, 2048.0);
            let y = r.uniform(0.0, 1024.0);
            let base = r.uniform(-0.05, 0.2);
            h.add(synth.at(x, y, base, &mut relief));
        }
    }
    h.add(level_seed(4242, 2) as f64);
    check(&format!("{name}_synthesis"), &h);
}

#[test]
fn the_sampler_and_synthesis_on_the_torus_are_the_typescript_engine_s() {
    sampler_and_synthesis("torus", Domain::torus(2048.0, 1024.0));
}

#[test]
fn the_sampler_and_synthesis_on_the_sphere_are_the_typescript_engine_s() {
    sampler_and_synthesis("sphere", Domain::sphere(2048.0, 1024.0));
}

#[test]
fn a_level_refines_as_the_typescript_engine() {
    let domain = Domain::torus(1024.0, 512.0);
    let built = build_mesh(&domain, &Analytic, 7, 4.0, 24);
    // Compacted, as a level bake's parent is (it comes from the save).
    let (mesh, order) = compact_mesh(&built.mesh);
    let z = permute(built.state.get(MESH_Z), &order);
    let r = refine_mesh_level(
        mesh,
        &z,
        &RefineLevelOptions {
            budget: 2.0,
            seed: 4242,
            level: 1,
            width: 1024,
            height: 512,
            max_rounds: None,
        },
    );
    let mut h = Hash::new();
    h.add(r.inserted as f64);
    let m = &r.mesh;
    h.add_all(&m.vx[..m.vertex_slots()]);
    h.add_all(&m.vy[..m.vertex_slots()]);
    h.add_all(&m.tris[..3 * m.tri_slots()]);
    h.add_all(&r.z);
    h.add_all(&r.parent);
    check("refine", &h);
}
