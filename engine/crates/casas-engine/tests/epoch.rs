//! The module test of the tectonic epoch against the TypeScript port
//! (`client/src/generator/tectonics/plateSimulation.ts`, git history): from
//! one synthetic snapshot, the whole simulation after each of 120 epochs,
//! on both shapes, bit for bit (docs/decisions/rust-engine.md, fork 5). The
//! fixture is written by `engine/scripts/epochFixture.mjs`; the snapshot is
//! syntheticSim.mjs's (synthetic_sim/), the hash below the script's. A
//! failure names the first epoch that differs; a change to the model that
//! is meant records the lines it moves (`fixture`, CASAS_RECORD=1).

use casas_engine::core::domain::Domain;
use casas_engine::tectonics::plate_simulation::step_epoch;

mod fixture;
mod sim_hash;
mod synthetic_sim;

use fixture::check;
use sim_hash::state_hash;
use synthetic_sim::synthetic_sim;

const FIXTURE: &str = include_str!("fixtures/epoch.txt");
const EPOCHS: usize = 120;

fn run(name: &str, d: Domain, seed: u32) {
    let mut sim = synthetic_sim(d, seed);
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
        check(
            "epoch.txt",
            &got,
            want,
            &format!("{name}: epoch {e} is the first that differs"),
        );
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
