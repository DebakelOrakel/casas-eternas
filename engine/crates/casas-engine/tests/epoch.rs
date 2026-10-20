//! The module test of the tectonic epoch against the TypeScript engine's
//! `tectonics/plateSimulation.ts`: from one synthetic snapshot, the whole
//! simulation after each of 120 epochs, on both shapes, bit for bit
//! (docs/decisions/rust-engine.md, fork 5). The fixture is written by
//! `engine/scripts/epochFixture.mjs`; the snapshot and the hash below are
//! that script's. A failure names the first epoch that differs.

use casas_engine::core::domain::Domain;
use casas_engine::core::rng::Mulberry32;
use casas_engine::crust::raft_types::{Raft, RaftBlob};
use casas_engine::fields::field_mesh::SavedField;
use casas_engine::tectonics::ocean_age::create_ocean_age_field;
use casas_engine::tectonics::plate_motion::generate_plate_motions;
use casas_engine::tectonics::plate_seeds::PlateSeed;
use casas_engine::tectonics::plate_simulation::{deserialize_plate_simulation, step_epoch};
use casas_engine::tectonics::plate_simulation_types::{PlateSimulationSnapshot, world_meshes};

mod sim_hash;

use sim_hash::state_hash;

const FIXTURE: &str = include_str!("fixtures/epoch.txt");
const EPOCHS: usize = 120;

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

fn run(name: &str, d: Domain, seed: u32) {
    let mut g = Gen(seed);
    let seeds: Vec<PlateSeed> = (0..18)
        .map(|_| {
            let x = g.uniform(0.0, d.width);
            PlateSeed {
                x,
                y: g.uniform(0.0, d.height),
            }
        })
        .collect();
    let mut rafts = Vec::new();
    for r in 0..12 {
        let cx = g.uniform(0.0, d.width);
        let cy = g.uniform(0.0, d.height);
        let mut blobs = Vec::new();
        for b in 0..6 {
            let x = d.wrap_x(cx + g.uniform(-90.0, 90.0));
            let y = d.height.min(0f64.max(cy + g.uniform(-60.0, 60.0)));
            let radius = g.uniform(40.0, 120.0);
            let birth_epoch = if b % 2 == 0 {
                Some(g.uniform(0.0, 150.0).floor())
            } else {
                None
            };
            blobs.push(RaftBlob {
                x,
                y,
                radius,
                birth_epoch,
            });
        }
        rafts.push(Raft {
            id: r,
            name: if r % 3 == 0 {
                Some("Morvane".to_string())
            } else {
                None
            },
            blobs,
            no_merge_until_epoch: None,
        });
    }
    let mut rng = Mulberry32::new(seed);
    let motions = generate_plate_motions(&seeds, &d, &mut || rng.next());
    let ages: Vec<f64> = (0..seeds.len())
        .map(|_| g.uniform(0.0, 80.0).floor())
        .collect();
    let snap = PlateSimulationSnapshot {
        epoch_ma: None,
        sediment_export_m3: None,
        eustatic_m: None,
        climate_history: None,
        lake_ages: None,
        archean_epochs: Some(150.0),
        width: d.width,
        height: d.height,
        initial_plate_count: 18.0,
        seeds,
        motions,
        ages,
        rafts,
        features: Vec::new(),
        epoch: 0.0,
        warp_seed: 2900000000.0 + seed as f64,
        supercontinent_active: false,
        continental_rift_cooldown_until: 0.0,
        hotspots: Some(Vec::new()),
        sutures: Some(Vec::new()),
        rng_state: 12345 + seed,
    };
    let meshes = world_meshes(&d);
    let age = SavedField {
        values: create_ocean_age_field(40.0, &meshes.shared),
        cells: meshes.shared.mesh.count,
        spacing_m: meshes.ocean.cell_m,
    };
    let mut sim = deserialize_plate_simulation(&snap, &age, None, d, meshes).unwrap();
    let expected: Vec<&str> = FIXTURE
        .lines()
        .filter(|l| l.starts_with(&format!("{name} ")))
        .collect();
    assert_eq!(
        expected.len(),
        EPOCHS + 1,
        "the fixture has {} {name} lines",
        expected.len()
    );
    assert_eq!(
        format!("{name} 0 {}", state_hash(&sim, &[])),
        expected[0],
        "{name}: the snapshot differs"
    );
    for (e, want) in expected.iter().enumerate().skip(1) {
        let events = step_epoch(&mut sim);
        let got = format!("{name} {e} {}", state_hash(&sim, &events));
        assert_eq!(&got, want, "{name}: epoch {e} is the first that differs");
    }
}

#[test]
fn the_torus_epochs_give_the_typescript_state() {
    run("torus", Domain::torus(2048.0, 1024.0), 7);
}

#[test]
fn the_sphere_epochs_give_the_typescript_state() {
    run("sphere", Domain::sphere(2048.0, 1024.0), 8);
}
