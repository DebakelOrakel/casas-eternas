//! The module test of the coupled epoch (pipeline/coupled_epoch) against
//! the TypeScript port (`client/src/generator/pipeline/coupledEpoch.ts`,
//! git history): from the synthetic simulation after 12 tectonic epochs,
//! the terrain from the synthesis and 4 coupled epochs at the history's
//! settings, on both shapes, bit for bit (docs/decisions/rust-engine.md,
//! fork 5). The fixture was written by `engine/scripts/coupledFixture.mjs`,
//! and is recorded from this engine since DEC-0049 (`fixture`). A failure
//! names the first epoch that differs.

use casas_engine::core::domain::Domain;
use casas_engine::pipeline::coupled_epoch::{
    CoupledEpochOptions, CoupledEpochStats, CoupledTerrain, create_coupled_terrain,
    encode_coupled_terrain, step_coupled_epoch,
};
use casas_engine::surface::erosion_forcing_fields::ErosionControls;
use casas_engine::tectonics::plate_simulation::step_epoch;
use casas_engine::tectonics::plate_simulation_types::PlateSimulation;

mod fixture;
mod sim_hash;
mod synthetic_sim;

use fixture::check;
use sim_hash::state_hash;
use synthetic_sim::synthetic_sim;

const FILE: &str = "coupled.txt";
const FIXTURE: &str = include_str!("fixtures/coupled.txt");
const EPOCHS: usize = 12;
const COUPLED: usize = 4;

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
    fn terrain(&mut self, t: &CoupledTerrain) {
        let m = &t.mesh;
        let n = m.vertex_slots();
        self.add_all(&m.vx[..n]);
        self.add_all(&m.vy[..n]);
        self.add_all(&m.tris[..3 * m.tri_slots()]);
        self.add_all(&t.z[..n]);
        self.add_all(&t.baseline[..n]);
        self.add_all(&t.areas[..n]);
        self.add_all(&t.sediment_flux);
        self.add_all(&t.pre_erosion_z[..n]);
        self.add_all(&t.column.data[..n * 48]);
        self.add_all(&t.column.epochs);
        self.add_all(&t.ice);
        if let Some(r) = &t.routing {
            self.add_all(&r.flow_target);
            self.add_all(&r.filled);
            self.add_all(&r.pop_order);
        }
        let bytes = encode_coupled_terrain(t);
        self.add_all(&bytes.connectivity);
        self.add_all(&bytes.column);
    }
    fn sim(&mut self, sim: &PlateSimulation) {
        self.add(sim.sediment_export_m3);
        self.add(sim.eustatic_m);
        for r in &sim.lake_ages {
            for v in [r.x, r.y, r.level, r.age_ma] {
                self.add(v);
            }
        }
        for r in &sim.climate_history {
            for v in [r.epoch, r.mean_land_temp_c, r.ice_volume_km3, r.sea_level_m] {
                self.add(v);
            }
        }
    }
    fn stats(&mut self, s: &CoupledEpochStats) {
        for v in [
            s.deposited_m3,
            s.re_eroded_m3,
            s.ice_coast_column_m3,
            s.column_volume_m3,
            s.rebound_max_m,
            s.subsidence_max_m,
            s.mean_land_temp_c,
            s.ice_volume_km3,
            s.sea_level_m,
            s.lakes as f64,
            s.oldest_lake_ma,
            s.mean_land_cover,
            s.scree_m3,
            s.solifluction_share,
            s.folded_share,
            s.ice_area_share,
            s.glacial_cut_m3,
            s.till_m3,
            s.ela_mean_m,
            s.shore_nodes as f64,
            s.coast_cut_m3,
            s.coast_deposit_m3,
            s.coast_export_m3,
            s.ice_load_m3,
            s.ice_weight_m3,
            s.uplift_load_m3,
            s.nodes_before as f64,
            s.nodes_after as f64,
            s.removed as f64,
            s.inserted as f64,
            s.land_cells,
            s.land_volume,
            s.eroded_flux_m3,
            s.exported_flux_m3,
        ] {
            self.add(v);
        }
    }
}

fn run(name: &str, d: Domain, seed: u32) {
    let expected: Vec<&str> = FIXTURE
        .lines()
        .filter(|l| l.starts_with(&format!("{name} ")))
        .collect();
    assert_eq!(expected.len(), COUPLED + 1);
    let mut sim = synthetic_sim(d, seed);
    for _ in 0..EPOCHS {
        step_epoch(&mut sim);
    }
    let mut terrain = create_coupled_terrain(&mut sim, 4.0);
    let mut h = Hash::new();
    h.terrain(&terrain);
    check(
        FILE,
        &format!("{name} 0 {:08x} {}", h.0, state_hash(&sim, &[])),
        expected[0],
        &format!("{name}: the terrain from the synthesis differs"),
    );
    let options = CoupledEpochOptions {
        weather: None,
        iterations_per_epoch: 4,
        budget: Some(4.0),
        climate_every: Some(3.0),
        remesh_every: Some(3.0),
        uplift_scale: Some(1.0),
        controls: ErosionControls::default(),
        leaf_workers: None,
    };
    for (e, want) in expected.iter().enumerate().skip(1) {
        let stats = step_coupled_epoch(&mut sim, &mut terrain, &options);
        let mut h = Hash::new();
        h.terrain(&terrain);
        h.sim(&sim);
        h.stats(&stats);
        check(
            FILE,
            &format!("{name} {e} {:08x} {}", h.0, state_hash(&sim, &stats.events)),
            want,
            &format!("{name}: coupled epoch {e} is the first that differs"),
        );
    }
}

#[test]
fn the_torus_coupled_epochs_give_the_typescript_terrain() {
    run("torus", Domain::torus(2048.0, 1024.0), 7);
}

#[test]
fn the_sphere_coupled_epochs_give_the_typescript_terrain() {
    run("sphere", Domain::sphere(2048.0, 1024.0), 8);
}
