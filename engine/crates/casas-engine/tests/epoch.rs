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
use casas_engine::tectonics::plate_motion::{PlateMotion, generate_plate_motions};
use casas_engine::tectonics::plate_seeds::PlateSeed;
use casas_engine::tectonics::plate_simulation::{deserialize_plate_simulation, step_epoch};
use casas_engine::tectonics::plate_simulation_types::{
    PlateSimulation, PlateSimulationSnapshot, SimEvent, SimEventType, world_meshes,
};
use casas_engine::tectonics::plate_types::PlateType;
use casas_engine::tectonics::terrain_features::{FeatureKind, MovesWith};

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

struct Hash(u32);

impl Hash {
    fn add(&mut self, v: f64) {
        let b = if v.is_nan() {
            0x7ff8_0000_0000_0000
        } else {
            v.to_bits()
        };
        self.0 = (self.0 ^ b as u32).wrapping_mul(0x0100_0193);
        self.0 = (self.0 ^ (b >> 32) as u32).wrapping_mul(0x0100_0193);
    }
    fn opt(&mut self, v: Option<f64>) {
        self.add(v.unwrap_or(f64::NAN));
    }
    fn name(&mut self, s: &Option<String>) {
        match s {
            None => self.add(-1.0),
            Some(s) => {
                let units: Vec<u16> = s.encode_utf16().collect();
                self.add(units.len() as f64);
                for u in units {
                    self.add(u as f64);
                }
            }
        }
    }
}

fn state_hash(sim: &PlateSimulation, events: &[SimEvent]) -> String {
    let mut h = Hash(0x811c_9dc5);
    h.add(sim.epoch);
    h.add(sim.seeds.len() as f64);
    for s in &sim.seeds {
        h.add(s.x);
        h.add(s.y);
    }
    for t in &sim.types {
        h.add(if *t == PlateType::Continental {
            1.0
        } else {
            0.0
        });
    }
    for m in &sim.motions {
        match m {
            PlateMotion::Euler(e) => {
                for v in [e.pole_x, e.pole_y, e.pole_z, e.rate] {
                    h.add(v);
                }
            }
            PlateMotion::Rigid(r) => {
                for v in [r.drift_x, r.drift_y, r.spin, r.centroid_x, r.centroid_y] {
                    h.add(v);
                }
            }
        }
    }
    for &a in &sim.ages {
        h.add(a);
    }
    h.add(sim.rafts.len() as f64);
    for r in &sim.rafts {
        h.add(r.id as f64);
        h.name(&r.name);
        h.opt(r.no_merge_until_epoch);
        h.add(r.blobs.len() as f64);
        for b in &r.blobs {
            h.add(b.x);
            h.add(b.y);
            h.add(b.radius);
            h.opt(b.birth_epoch);
        }
    }
    h.add(sim.features.len() as f64);
    for t in &sim.features {
        let moves = match t.moves_with {
            MovesWith::Both => -1.0,
            MovesWith::Plate(p) => p as f64,
        };
        for v in [
            t.x,
            t.y,
            t.thickness,
            t.tangent_x,
            t.tangent_y,
            if t.kind == FeatureKind::Trench {
                1.0
            } else {
                0.0
            },
            t.plate_a as f64,
            t.plate_b as f64,
            moves,
            if t.subsides { 1.0 } else { 0.0 },
            t.epochs_since_deposit,
        ] {
            h.add(v);
        }
        h.opt(t.volcanic.map(|b| if b { 1.0 } else { 0.0 }));
        h.opt(t.shortening_km_per_myr);
    }
    for &v in &sim.lattice_accumulated {
        h.add(v as f64);
    }
    for &v in &sim.lattice_locked_epochs {
        h.add(v as f64);
    }
    for &v in &sim.lattice_last_class_code {
        h.add(v as f64);
    }
    for &v in &sim.ocean_age {
        h.add(v);
    }
    for &v in &sim.mantle {
        h.add(v);
    }
    for p in &sim.hotspots {
        for v in [p.x, p.y, p.id as f64, p.birth_epoch] {
            h.add(v);
        }
    }
    for s in &sim.sutures {
        for v in [s.x, s.y, s.tangent_x, s.tangent_y, s.epoch] {
            h.add(v);
        }
    }
    h.add(if sim.supercontinent_active { 1.0 } else { 0.0 });
    h.add(sim.continental_rift_cooldown_until);
    h.add(sim.random.state() as f64);
    for e in events {
        h.add(match e.kind {
            SimEventType::ContinentCollided => 0.0,
            SimEventType::ContinentBrokeUp => 1.0,
            SimEventType::SupercontinentFormed => 2.0,
            SimEventType::OceanicCreated => 3.0,
            SimEventType::OceanicSubducted => 4.0,
        });
        h.name(&e.name);
        h.name(&e.name_a);
        h.name(&e.name_b);
        for v in [
            e.x,
            e.y,
            e.dir_x,
            e.dir_y,
            e.plate_index.map(|i| i as f64),
            e.other_plate_index.map(|i| i as f64),
        ] {
            h.opt(v);
        }
    }
    format!("{:08x}", h.0)
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
