//! The module test of the replay (pipeline/replay_runs) against the
//! TypeScript engine's `pipeline/replayRuns.ts`: a plan of two Archean
//! runs, the hand-over, a tectonics run and a restored one, on both shapes,
//! its checkpoints, and the world resumed from a checkpoint
//! (docs/decisions/rust-engine.md, fork 5). The fixture was written by
//! `engine/scripts/replayFixture.mjs`, and is recorded from this engine
//! since DEC-0049 (`fixture`).

use casas_engine::climate::weather::{WeatherParams, default_weather_params};
use casas_engine::pipeline::coupled_epoch::CoupledTerrain;
use casas_engine::pipeline::replay_runs::{
    GenesisRun, ReplayOptions, ReplayPlan, ReplayPosition, ReplaySnapshot, TectonicsRun,
    replay_runs, snapshot_of,
};
use casas_engine::surface::erosion_forcing_fields::ErosionControls;

mod fixture;
mod sim_hash;

use fixture::check;
use sim_hash::state_hash;

const FILE: &str = "replay.txt";
const FIXTURE: &str = include_str!("fixtures/replay.txt");

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
    fn hex(&self) -> String {
        format!("{:08x}", self.0)
    }
}

fn snapshot_hash(s: &ReplaySnapshot) -> String {
    let mut h = Hash::new();
    h.add_all(&s.ocean_age.values);
    h.add_all(&s.mantle.values);
    h.add_all(&s.lattice_accumulated);
    h.add_all(&s.lattice_locked_epochs);
    h.add_all(&s.lattice_last_class_code);
    h.add_all(&s.mesh.nodes);
    h.add_all(&s.mesh.connectivity);
    h.add_all(&s.mesh.z);
    h.add_all(&s.mesh.column);
    h.add_all(&s.mesh.ice);
    h.hex()
}

fn terrain_hash(t: &CoupledTerrain) -> String {
    let mut h = Hash::new();
    let n = t.mesh.vertex_slots();
    h.add_all(&t.z[..n]);
    h.add_all(&t.baseline[..n]);
    h.add_all(&t.column.data[..n * 48]);
    h.add_all(&t.ice);
    h.add_all(&t.routing.as_ref().unwrap().flow_target);
    h.hex()
}

fn run(name: &str, sphere: bool) {
    let defaults = default_weather_params();
    let plan = ReplayPlan {
        seed: format!("Morvane {name}"),
        width: 2048.0,
        height: 1024.0,
        sphere,
        genesis: vec![
            GenesisRun {
                epochs: 30,
                diffusion: 0.5,
                land_share: 0.3,
            },
            GenesisRun {
                epochs: 20,
                diffusion: 0.8,
                land_share: 0.35,
            },
        ],
        tectonics: vec![
            TectonicsRun {
                epochs: 4,
                controls: ErosionControls::default(),
                weather: defaults,
                restored: false,
            },
            TectonicsRun {
                epochs: 3,
                controls: ErosionControls {
                    alluvium: Some(65.0),
                    rock_contrast: Some(35.0),
                },
                weather: WeatherParams {
                    humidity: 1.2,
                    temperature_offset: -1.0,
                    ..defaults
                },
                restored: true,
            },
        ],
    };
    let mut lines: Vec<String> = Vec::new();
    let mut checkpoints: Vec<(ReplayPosition, ReplaySnapshot)> = Vec::new();
    let (sim, terrain) = {
        let mut on_checkpoint = |p: ReplayPosition, sim: &_, terrain: &_| {
            let s = snapshot_of(sim, terrain);
            lines.push(format!(
                "{name} checkpoint {} {} {}",
                p.run,
                p.epoch,
                snapshot_hash(&s)
            ));
            checkpoints.push((p, s));
        };
        replay_runs(
            &plan,
            &mut ReplayOptions {
                budget: 4.0,
                leaf_workers: None,
                on_epoch: None,
                resume: None,
                on_checkpoint: Some(&mut on_checkpoint),
            },
        )
        .unwrap()
    };
    lines.push(format!(
        "{name} full {} {}",
        terrain_hash(&terrain),
        state_hash(&sim, &[])
    ));
    let (position, snapshot) = &checkpoints[1];
    let (sim, terrain) = replay_runs(
        &plan,
        &mut ReplayOptions {
            budget: 4.0,
            leaf_workers: None,
            on_epoch: None,
            resume: Some((*position, snapshot)),
            on_checkpoint: None,
        },
    )
    .unwrap();
    lines.push(format!(
        "{name} resumed {} {} {} {}",
        position.run,
        position.epoch,
        terrain_hash(&terrain),
        state_hash(&sim, &[])
    ));
    let expected: Vec<&str> = FIXTURE
        .lines()
        .filter(|l| l.starts_with(&format!("{name} ")))
        .collect();
    assert_eq!(lines.len(), expected.len(), "{name}: the fixture's lines");
    for (got, want) in lines.iter().zip(&expected) {
        check(FILE, got, want, name);
    }
}

#[test]
fn the_torus_replay_gives_the_typescript_world() {
    run("torus", false);
}

#[test]
fn the_sphere_replay_gives_the_typescript_world() {
    run("sphere", true);
}
