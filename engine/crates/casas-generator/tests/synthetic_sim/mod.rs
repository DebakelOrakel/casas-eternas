//! The synthetic plate simulation the epoch and the forcing tests start
//! from: `engine/scripts/syntheticSim.mjs`, step for step.

use casas_generator::core::domain::Domain;
use casas_generator::core::rng::Mulberry32;
use casas_generator::crust::raft_types::{Raft, RaftBlob};
use casas_generator::fields::field_mesh::SavedField;
use casas_generator::tectonics::ocean_age::create_ocean_age_field;
use casas_generator::tectonics::plate_motion::generate_plate_motions;
use casas_generator::tectonics::plate_seeds::PlateSeed;
use casas_generator::tectonics::plate_simulation::deserialize_plate_simulation;
use casas_generator::tectonics::plate_simulation_types::{
    PlateSimulation, PlateSimulationSnapshot, world_meshes,
};

pub struct Gen(pub u32);

impl Gen {
    pub fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_mul(1664525).wrapping_add(1013904223);
        self.0
    }
    pub fn uniform(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * (self.next() as f64 / 4294967296.0)
    }
}

pub fn synthetic_sim(d: Domain, seed: u32) -> PlateSimulation {
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
    deserialize_plate_simulation(&snap, &age, None, d, meshes).unwrap()
}
