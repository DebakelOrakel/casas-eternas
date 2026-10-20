//! The module test of the erosion engine (surface/erosion_engine*,
//! mesh/mesh_erosion's run) against the TypeScript engine: the same
//! scenarios give the same bits (docs/decisions/rust-engine.md, fork 5).
//! The fixture is written by `engine/scripts/erosionFixture.mjs`; the
//! scenarios below are that script's, step for step.

use casas_engine::core::det_math::{det_cos, det_sin};
use casas_engine::core::domain::Domain;
use casas_engine::mesh::mesh_build::{FieldSampler, MESH_Z, build_mesh};
use casas_engine::mesh::mesh_erosion::{
    MeshErosionOptions, MeshErosionResult, MeshPipeline, run_mesh_erosion,
};
use casas_engine::surface::erosion_engine::{
    DEFAULT_SOLVER_PARAMS, ErosionForcing, ErosionSolver, ErosionSolverParams,
};

const FIXTURE: &str = include_str!("fixtures/erosion.txt");

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

fn expected(name: &str) -> String {
    FIXTURE
        .lines()
        .find(|l| l.split_whitespace().next() == Some(name))
        .unwrap_or_else(|| panic!("no {name} in the fixture"))
        .to_string()
}

fn check(name: &str, h: &Hash) {
    assert_eq!(format!("{name} {:08x}", h.0), expected(name));
}

fn height_at(x: f64, y: f64) -> f64 {
    0.06 * det_sin(x * 0.011) * det_cos(y * 0.017) + 0.03 * det_sin(x * 0.041 + y * 0.023) - 0.04
}

struct Analytic;

impl FieldSampler for Analytic {
    fn height_at(&self, x: f64, y: f64) -> f64 {
        height_at(x, y)
    }
    fn discharge_at(&self, x: f64, y: f64) -> Option<f64> {
        Some(2500.0 * (1.0 + det_sin(x * 0.05 + y * 0.03)))
    }
    fn has_discharge(&self) -> bool {
        true
    }
}

/// The forcing arrays of the script's `forcingAt`.
struct Fields {
    uplift: Vec<f32>,
    erodibility: Vec<f32>,
    coast_mask: Vec<u8>,
    accumulation_weights: Vec<f32>,
    craton_age: Vec<f32>,
    rock_hard: Vec<f32>,
    slope_scale: Vec<f32>,
    diff_scale: Vec<f32>,
    status_mask: Option<Vec<u8>>,
    pinned_z: Option<Vec<f32>>,
}

impl Fields {
    fn new(xs: &[f64], ys: &[f64], z: &[f32], n: usize, extras: bool) -> Self {
        let at = |g: &dyn Fn(f64, f64) -> f64| -> Vec<f32> {
            (0..n).map(|i| g(xs[i], ys[i]) as f32).collect()
        };
        Fields {
            uplift: at(&|x, y| 0.6 + 0.5 * det_sin(x * 0.013 + y * 0.007)),
            erodibility: at(&|x, y| 1.0 + 0.4 * det_cos(x * 0.021 - y * 0.011)),
            coast_mask: (0..n)
                .map(|i| u8::from(z[i] > 0.0 || i % 11 == 0))
                .collect(),
            accumulation_weights: at(&|_, y| 0.8 + 0.6 * det_sin(y * 0.031)),
            craton_age: at(&|x, _| 0.5 + 0.5 * det_cos(x * 0.004)),
            rock_hard: at(&|x, y| 0.5 + 0.5 * det_sin(y * 0.009 + x * 0.002)),
            slope_scale: at(&|x, _| 1.0 + 0.3 * det_sin(x * 0.017)),
            diff_scale: at(&|_, y| 1.0 + 0.5 * det_cos(y * 0.013)),
            status_mask: extras.then(|| {
                (0..n)
                    .map(|i| {
                        if i % 13 == 0 {
                            1
                        } else if i % 17 == 0 {
                            2
                        } else {
                            0
                        }
                    })
                    .collect()
            }),
            pinned_z: extras.then(|| {
                (0..n)
                    .map(|i| {
                        if i % 29 == 0 {
                            (z[i] as f64 + 0.001) as f32
                        } else {
                            f32::NAN
                        }
                    })
                    .collect()
            }),
        }
    }
    fn forcing(&self) -> ErosionForcing<'_> {
        ErosionForcing {
            uplift: &self.uplift,
            erodibility: &self.erodibility,
            coast_mask: Some(&self.coast_mask),
            accumulation_weights: Some(&self.accumulation_weights),
            status_mask: self.status_mask.as_deref(),
            pinned_z: self.pinned_z.as_deref(),
            craton_age: Some(&self.craton_age),
            rock_hard: Some(&self.rock_hard),
            slope_scale: Some(&self.slope_scale),
            diff_scale: Some(&self.diff_scale),
        }
    }
}

const NO_CALM: ErosionSolverParams = ErosionSolverParams {
    eps_m: 0.0,
    ..DEFAULT_SOLVER_PARAMS
};

fn engine_hash(h: &mut Hash, e: &ErosionSolver) {
    let (t, r) = (&e.terrain, &e.routing);
    for a in [
        &t.z,
        &t.cut_volume,
        &t.deposit_volume,
        &t.deposit_coarse,
        &t.deposit_craton,
        &t.deposit_hard,
        &t.hill_net,
        &t.uplift_net,
        &t.flux,
        &t.flux_coarse,
        &t.flux_craton,
        &t.flux_hard,
        &t.donor_min,
        &t.erosion_volume,
        &t.erosion_coarse,
        &r.filled,
    ] {
        h.add_all(a);
    }
    h.add_all(&r.flow_target);
    h.add_all(&r.flow_dir);
    h.add_all(&r.accumulation);
    h.add_all(&r.segment);
    h.add_all(&r.stage);
    h.add_all(&r.pop_order[..e.popped_count]);
    h.add(e.popped_count as f64);
    h.add(e.tallies.eroded);
    h.add(e.tallies.exported);
}

fn raster(name: &str, domain: Domain) {
    const RES_X: usize = 256;
    const RES_Y: usize = 128;
    let grid = domain.grid(RES_X, RES_Y);
    let n = RES_X * RES_Y;
    let xs: Vec<f64> = (0..n).map(|i| ((i % RES_X) * 8 + 4) as f64).collect();
    let ys: Vec<f64> = (0..n).map(|i| ((i / RES_X) * 8 + 4) as f64).collect();
    let z: Vec<f32> = (0..n)
        .map(|i| (height_at(xs[i], ys[i]) * 1.4) as f32)
        .collect();
    for (variant, extras, iterations, every) in [("full", false, 12, 4), ("status", true, 8, 3)] {
        let fields = Fields::new(&xs, &ys, &z, n, extras);
        let mut engine = ErosionSolver::on_raster(&grid, &z, &fields.forcing(), NO_CALM);
        let mut h = Hash::new();
        h.add(engine.index.active_count as f64);
        h.add(engine.index.frozen_count as f64);
        h.add_all(&engine.index.active);
        engine.run(iterations, every, |i, residual| {
            h.add(i as f64);
            h.add(residual);
        });
        engine_hash(&mut h, &engine);
        h.add_all(&engine.expand_z(&z));
        check(&format!("raster_{name}_{variant}"), &h);
    }
    let uplift = vec![0f32; n];
    let erodibility = vec![1f32; n];
    let forcing = ErosionForcing {
        uplift: &uplift,
        erodibility: &erodibility,
        ..Default::default()
    };
    let mut calm = ErosionSolver::on_raster(&grid, &z, &forcing, DEFAULT_SOLVER_PARAMS);
    let mut h = Hash::new();
    let mut steps = Vec::new();
    let last = calm.run(40, 4, |i, residual| steps.push((i, residual)));
    for (i, residual) in steps {
        h.add(i as f64);
        h.add(residual);
    }
    h.add(last);
    h.add_all(&calm.terrain.z);
    check(&format!("raster_{name}_calm"), &h);
}

#[test]
fn the_raster_torus_erodes_as_the_typescript_engine() {
    raster("torus", Domain::torus(256.0, 128.0));
}

#[test]
fn the_raster_sphere_erodes_as_the_typescript_engine() {
    raster("sphere", Domain::sphere(256.0, 128.0));
}

fn result_hash(h: &mut Hash, r: &MeshErosionResult) {
    for a in [
        &r.z,
        &r.sediment_flux,
        &r.cut_m3,
        &r.deposit_m3,
        &r.deposit_coarse_m3,
        &r.hill_net_m3,
        &r.uplift_m3,
        &r.deposit_craton,
        &r.deposit_hard,
    ] {
        h.add_all(a);
    }
    h.add_all(&r.routing.flow_target);
    h.add_all(&r.routing.filled);
    h.add_all(&r.routing.accumulation);
    h.add_all(&r.routing.pop_order);
    h.add(r.routing.popped_count as f64);
    h.add(r.eroded_flux_m3);
    h.add(r.exported_flux_m3);
    h.add(r.index.active_count as f64);
}

fn mesh(name: &str, domain: Domain) {
    let built = build_mesh(&domain, &Analytic, 7, 16.0, 24);
    let mut mesh = built.mesh;
    let n = mesh.vertex_slots();
    let z: Vec<f32> = built.state.get(MESH_Z)[..n].to_vec();
    let fields = Fields::new(&mesh.vx[..n], &mesh.vy[..n], &z, n, false);
    let forcing = fields.forcing();
    let frozen: Vec<u8> = (0..n).map(|v| u8::from(v % 23 == 0)).collect();
    let base = MeshErosionOptions {
        age: 10,
        routing_every: Some(4),
        params: Some(NO_CALM),
        pool: None,
        frozen: None,
    };
    for (variant, options) in [
        ("single", base),
        (
            "frozen",
            MeshErosionOptions {
                age: 6,
                routing_every: Some(2),
                frozen: Some(&frozen),
                ..base
            },
        ),
        (
            "overlapped",
            MeshErosionOptions {
                routing_every: None,
                pool: Some(MeshPipeline {
                    pipeline_depth: 3,
                    synchronous: false,
                    stencil_workers: 3,
                }),
                ..base
            },
        ),
        (
            "synchronous",
            MeshErosionOptions {
                age: 9,
                routing_every: None,
                pool: Some(MeshPipeline {
                    pipeline_depth: 4,
                    synchronous: true,
                    stencil_workers: 2,
                }),
                ..base
            },
        ),
    ] {
        let result = run_mesh_erosion(&mut mesh, &z, &forcing, &options);
        let mut h = Hash::new();
        result_hash(&mut h, &result);
        check(&format!("mesh_{name}_{variant}"), &h);
    }
}

#[test]
fn the_mesh_on_the_torus_erodes_as_the_typescript_engine() {
    mesh("torus", Domain::torus(2048.0, 1024.0));
}

#[test]
fn the_mesh_on_the_sphere_erodes_as_the_typescript_engine() {
    mesh("sphere", Domain::sphere(2048.0, 1024.0));
}
