//! The module test of the Archean against the TypeScript engine's
//! `archean/`: a world from a seed string, 200 Archean epochs (saved and
//! restored at the 100th), the hand-over and 20 tectonic epochs, the whole
//! state after every step, on both shapes (docs/decisions/rust-engine.md,
//! fork 5). The fixture is written by `engine/scripts/archeanFixture.mjs`.
//! A failure names the first step that differs.

// The steps keep the script's index loops.
#![allow(clippy::needless_range_loop)]

mod sim_hash;

use casas_engine::archean::archean_snapshot::{deserialize_archean, serialize_archean};
use casas_engine::archean::archean_state::create_archean_simulation;
use casas_engine::archean::archean_step::{archean_step, default_archean_params};
use casas_engine::archean::finalize_archean::finalize_archean;
use casas_engine::core::domain::Domain;
use casas_engine::mantle::mantle_field::saved_mantle;
use casas_engine::tectonics::plate_simulation::step_epoch;
use sim_hash::{archean_hash, state_hash};

const FIXTURE: &str = include_str!("fixtures/archean.txt");
const ARCHEAN_EPOCHS: usize = 200;
const RESTORE_AT: usize = 100;
const TECTONIC_EPOCHS: usize = 20;

fn run(shape: &str, domain: Domain) {
    let expected: Vec<&str> = FIXTURE
        .lines()
        .filter(|l| l.starts_with(&format!("{shape} ")))
        .collect();
    assert_eq!(
        expected.len(),
        ARCHEAN_EPOCHS + TECTONIC_EPOCHS + 2,
        "the fixture's {shape} lines"
    );
    let params = default_archean_params();
    let mut sim = create_archean_simulation("casas-fixture", domain);
    assert_eq!(
        format!("{shape} archean 0 {}", archean_hash(&sim)),
        expected[0],
        "{shape}: the new world differs"
    );
    for e in 1..=ARCHEAN_EPOCHS {
        archean_step(&mut sim, &params);
        if e == RESTORE_AT {
            let snap = serialize_archean(&sim);
            let mantle = saved_mantle(&sim.meshes.mantle, &sim.mantle);
            let streak = sim.upwelling_streak.clone();
            let domain = sim.domain.clone();
            sim = deserialize_archean(&snap, Some(&mantle), streak, domain, sim.meshes).unwrap();
        }
        let got = format!("{shape} archean {e} {}", archean_hash(&sim));
        assert_eq!(
            got, expected[e],
            "{shape}: Archean epoch {e} is the first that differs"
        );
    }
    let mut plates = finalize_archean(sim);
    let at = ARCHEAN_EPOCHS + 1;
    assert_eq!(
        format!("{shape} handover 0 {}", state_hash(&plates, &[])),
        expected[at],
        "{shape}: the hand-over differs"
    );
    for e in 1..=TECTONIC_EPOCHS {
        let events = step_epoch(&mut plates);
        let got = format!("{shape} handover {e} {}", state_hash(&plates, &events));
        assert_eq!(
            got,
            expected[at + e],
            "{shape}: tectonic epoch {e} after the hand-over is the first that differs"
        );
    }
}

#[test]
fn the_torus_archean_gives_the_typescript_world() {
    run("torus", Domain::torus(2048.0, 1024.0));
}

#[test]
fn the_sphere_archean_gives_the_typescript_world() {
    run("sphere", Domain::sphere(2048.0, 1024.0));
}
