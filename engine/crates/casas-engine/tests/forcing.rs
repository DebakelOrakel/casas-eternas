//! The module test of the erosion forcing (elevation/uplift_field,
//! elevation/erodibility_field, surface/erosion_forcing_fields,
//! pipeline/erosion_forcing) against the TypeScript engine: the same
//! scenarios give the same bits (docs/decisions/rust-engine.md, fork 5).
//! The fixture is written by `engine/scripts/forcingFixture.mjs`; the
//! scenarios below are that script's, step for step. A change to the
//! model that is meant records the lines it moves (`fixture`,
//! CASAS_RECORD=1).

use casas_engine::core::domain::Domain;
use casas_engine::core::world_time::world_epoch;
use casas_engine::elevation::erodibility_field::{
    DEFAULT_ERODIBILITY_FIELD_PARAMS, compute_erodibility_field,
};
use casas_engine::elevation::uplift_field::compute_uplift_field;
use casas_engine::pipeline::erosion_forcing::coarse_forcing_fields;
use casas_engine::surface::erosion_engine::ErosionSolverParams;
use casas_engine::surface::erosion_forcing_fields::{
    AssembledForcing, CoarseForcingInputs, ErosionControls, assemble_fine_forcing,
    assemble_node_forcing, engine_params_for, erosion_litho_seed, scale_engine_params_for_dt,
};
use casas_engine::tectonics::plate_simulation::step_epoch;
use casas_engine::tectonics::terrain_features::{FeatureKind, MovesWith, TerrainFeature};

mod fixture;
mod synthetic_sim;

use synthetic_sim::{Gen, synthetic_sim};

const FIXTURE: &str = include_str!("fixtures/forcing.txt");
const EPOCHS: usize = 30;

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
    /// The parameters in the order of their TypeScript names, sorted.
    fn params(&mut self, p: &ErosionSolverParams) {
        for v in [
            p.abrasion_km,
            p.base_area_rel,
            p.channel_head_km2,
            p.coarse_slope,
            p.critical_slope,
            p.deposit_cap_land_m,
            p.deposit_cap_marine_m,
            p.eps_m,
            p.hill_diff_km2,
            p.hill_ref_km2,
            p.hill_scale_exponent,
            p.kappa_dt,
            p.m,
            p.marine_diff_dt,
            p.marine_freeboard_m,
            p.settle_coarse_km,
            p.settle_floor_km,
            p.settle_marine_km,
            p.settle_width_ref_km,
            p.settle_xi_km,
            p.shelf_band_km,
            p.uplift_dt,
        ] {
            self.add(v);
        }
    }
    fn assembled(&mut self, a: &AssembledForcing) {
        self.add_all(&a.uplift);
        self.add_all(&a.erodibility);
        self.add_all(&a.coast_mask);
        self.add_all(&a.accumulation_weights);
        self.params(&a.params);
    }
    fn check(&self, name: &str) {
        let want = FIXTURE
            .lines()
            .find(|l| l.split_whitespace().next() == Some(name))
            .unwrap_or_else(|| panic!("no {name} in the fixture"));
        fixture::check("forcing.txt", &format!("{name} {:08x}", self.0), want, name);
    }
}

fn run(name: &str, d: Domain, seed: u32) {
    let mut sim = synthetic_sim(d.clone(), seed);
    for _ in 0..EPOCHS {
        step_epoch(&mut sim);
    }
    assert!(!sim.sutures.is_empty(), "{name}: no suture to test against");
    let mut h = Hash::new();
    h.add(sim.features.len() as f64);
    h.add(sim.sutures.len() as f64);
    h.add_all(&compute_uplift_field(&sim.features, &d, 256, 128));
    h.add_all(&compute_uplift_field(&sim.features, &d, 100, 50));
    h.add_all(&compute_uplift_field(&[], &d, 10, 5));
    h.check(&format!("{name}_uplift"));

    let mut g = Gen(seed + 100);
    let mut features = sim.features.clone();
    for _ in 0..6 {
        let x = g.uniform(0.0, d.width);
        let y = g.uniform(0.0, d.height);
        features.push(TerrainFeature {
            x,
            y,
            thickness: g.uniform(-30.0, 40.0),
            tangent_x: 1.0,
            tangent_y: 0.0,
            kind: FeatureKind::Range,
            plate_a: -1,
            plate_b: -2,
            moves_with: MovesWith::Both,
            subsides: false,
            epochs_since_deposit: 0.0,
            volcanic: None,
            shortening_km_per_myr: None,
            shortening_first: false,
        });
    }
    let current = world_epoch(sim.archean_epochs, sim.epoch);
    let p = &DEFAULT_ERODIBILITY_FIELD_PARAMS;
    let mut h = Hash::new();
    h.add_all(&compute_erodibility_field(
        &sim.rafts,
        &sim.sutures,
        &features,
        current,
        sim.archean_epochs,
        &d,
        256,
        128,
        p,
    ));
    h.add_all(&compute_erodibility_field(
        &sim.rafts,
        &[],
        &[],
        current,
        sim.archean_epochs,
        &d,
        64,
        32,
        p,
    ));
    h.check(&format!("{name}_erodibility"));

    let coarse = coarse_forcing_fields(&sim, &d);
    let mut h = Hash::new();
    h.add_all(&coarse.uplift);
    h.add_all(&coarse.hardness);
    h.check(&format!("{name}_coarse"));

    let mut g = Gen(seed + 200);
    let count = 5000;
    let (mut xs, mut ys, mut alive) = (vec![0.0; count], vec![0.0; count], vec![0u8; count]);
    let (mut z, mut areas, mut water_nodes) =
        (vec![0f32; count], vec![0f32; count], vec![0f32; count]);
    for i in 0..count {
        xs[i] = g.uniform(0.0, d.width);
        ys[i] = g.uniform(0.0, d.height);
        alive[i] = u8::from(i % 7 != 0);
        z[i] = g.uniform(-0.3, 0.2) as f32;
        areas[i] = g.uniform(0.5, 2.0) as f32;
        water_nodes[i] = g.uniform(-0.1, 3.0) as f32;
    }
    let water: Vec<f32> = (0..64 * 32).map(|_| g.uniform(-0.2, 2.0) as f32).collect();
    let litho_seed = erosion_litho_seed(sim.warp_seed);
    let base = CoarseForcingInputs {
        uplift: Some(&coarse.uplift),
        hardness: Some(&coarse.hardness),
        forcing_res_x: 256,
        forcing_res_y: 128,
        water: None,
        water_res_x: 1,
        water_res_y: 1,
        water_nodes: None,
        litho_seed,
    };
    let with_water = CoarseForcingInputs {
        water: Some(&water),
        water_res_x: 64,
        water_res_y: 32,
        ..base
    };
    let mut h = Hash::new();
    h.add(litho_seed as f64);
    let controls = ErosionControls {
        alluvium: Some(30.0),
        rock_contrast: Some(80.0),
    };
    let per_node = CoarseForcingInputs {
        water_nodes: Some(&water_nodes),
        ..base
    };
    h.assembled(&assemble_node_forcing(
        &per_node, &xs, &ys, &alive, count, &z, &areas, &d, &controls, None,
    ));
    h.assembled(&assemble_node_forcing(
        &with_water,
        &xs,
        &ys,
        &alive,
        count,
        &z,
        &areas,
        &d,
        &ErosionControls::default(),
        Some(1.3),
    ));
    let bare = CoarseForcingInputs {
        uplift: None,
        hardness: None,
        ..base
    };
    let flat = ErosionControls {
        rock_contrast: Some(0.0),
        ..Default::default()
    };
    h.assembled(&assemble_node_forcing(
        &bare, &xs, &ys, &alive, count, &z, &areas, &d, &flat, None,
    ));
    h.check(&format!("{name}_nodes"));

    let rd = if d.is_sphere() {
        Domain::sphere(256.0, 128.0)
    } else {
        Domain::torus(256.0, 128.0)
    };
    let raw: Vec<f32> = (0..256 * 128)
        .map(|_| g.uniform(-0.3, 0.2) as f32)
        .collect();
    let mut h = Hash::new();
    let wet = ErosionControls {
        alluvium: Some(70.0),
        ..Default::default()
    };
    h.assembled(&assemble_fine_forcing(&with_water, &raw, &rd, &wet));
    h.assembled(&assemble_fine_forcing(
        &base,
        &raw,
        &rd,
        &ErosionControls::default(),
    ));
    let dry = ErosionControls {
        alluvium: Some(10.0),
        ..Default::default()
    };
    h.params(&scale_engine_params_for_dt(&engine_params_for(&dry), 12.5));
    h.check(&format!("{name}_raster"));
}

#[test]
fn the_torus_forcing_gives_the_typescript_fields() {
    run("torus", Domain::torus(2048.0, 1024.0), 7);
}

#[test]
fn the_sphere_forcing_gives_the_typescript_fields() {
    run("sphere", Domain::sphere(2048.0, 1024.0), 8);
}
