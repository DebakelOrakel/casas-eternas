//! The module test of the raft field and the mantle against the TypeScript
//! engine's `crust/raftField.ts` (git history) and `mantle/mantleField.ts`:
//! the same scenarios give the same bits (docs/decisions/rust-engine.md,
//! fork 5). The fixture is written by `engine/scripts/mantleFixture.mjs`;
//! the scenarios below are that script's, step for step.

#![allow(clippy::needless_range_loop)]

use casas_engine::core::domain::Domain;
use casas_engine::core::rng::Mulberry32;
use casas_engine::crust::raft_field as rf;
use casas_engine::crust::raft_types::{Raft, RaftBlob};
use casas_engine::mantle::mantle_field as m;
use casas_engine::mantle::mantle_tune_params::MANTLE_TUNING;
use casas_engine::tectonics::plate_seeds::PlateSeed;
use casas_engine::tectonics::plate_types::PlateType;

const FIXTURE: &str = include_str!("fixtures/mantle.txt");

struct Gen(u32);

impl Gen {
    fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_mul(1664525).wrapping_add(1013904223);
        self.0
    }
    fn uniform(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * (self.next() as f64 / 4294967296.0)
    }
    fn int(&mut self, lo: f64, hi: f64) -> i64 {
        self.uniform(lo, hi).floor() as i64
    }
}

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
    fn line(&self, name: &str) -> String {
        format!("{name} {:08x}", self.0)
    }
}

fn expected(name: &str) -> String {
    FIXTURE
        .lines()
        .find(|l| l.split_whitespace().next() == Some(name))
        .unwrap_or_else(|| panic!("no {name} in the fixture"))
        .to_string()
}

fn make_rafts(g: &mut Gen, d: &Domain) -> Vec<Raft> {
    let mut rafts = Vec::new();
    for r in 0..30 {
        let cx = g.uniform(0.0, d.width);
        let cy = g.uniform(0.0, d.height);
        let n = g.int(3.0, 9.0);
        let mut blobs = Vec::new();
        for b in 0..n {
            let x = d.wrap_x(cx + g.uniform(-80.0, 80.0));
            let y = d.height.min(0f64.max(cy + g.uniform(-60.0, 60.0)));
            let radius = g.uniform(20.0, 120.0);
            let birth_epoch = if b % 3 != 0 {
                Some(g.int(0.0, 200.0) as f64)
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
            name: None,
            blobs,
            no_merge_until_epoch: None,
        });
    }
    rafts
}

fn scenario(name: &str, d: Domain, seed: u32) {
    let mut g = Gen(seed);
    let rafts = make_rafts(&mut g, &d);
    let mut h = Hash::new();
    let index = rf::build_blob_index(&rafts, &d, 1.0);
    let near = rf::build_blob_index(&rafts, &d, 2.0);
    let mut per_raft = vec![0.0; rafts.len()];
    for k in 0..20000 {
        let special = k % 997 == 0;
        let x = if special {
            if k % 2 == 1 { f64::INFINITY } else { f64::NAN }
        } else {
            g.uniform(-100.0, d.width + 100.0)
        };
        let y = if special {
            3.0
        } else {
            g.uniform(0.0, d.height)
        };
        h.add(rf::raft_field(x, y, &rafts, &d));
        h.add(rf::raft_field_indexed(x, y, &index));
        h.add(rf::nearest_raft_indexed(x, y, &near, 2.0).map_or(-1.0, |r| r as f64));
        h.add(rf::raft_membership(x, y, &rafts, &d));
        if !special {
            h.add(rf::raft_fields_indexed(x, y, &index, &mut per_raft));
            h.add_all(&per_raft);
        }
    }
    let mut xs = vec![0.0; 5000];
    let mut ys = vec![0.0; 5000];
    for i in 0..xs.len() {
        xs[i] = g.uniform(0.0, d.width);
        ys[i] = g.uniform(0.0, d.height);
    }
    h.add_all(&rf::compute_membership_at(&rafts, &xs, &ys, &d));
    h.add_all(&rf::compute_craton_oldness_field(
        &rafts, 120.0, 80.0, 256, 128, &d,
    ));
    h.add_all(&rf::compute_craton_oldness_field(
        &rafts, 0.0, 0.0, 64, 32, &d,
    ));
    h.add_all(&rf::compute_owner_field(&rafts, 256, 128, &d));
    let seeds: Vec<PlateSeed> = (0..200)
        .map(|_| {
            let x = g.uniform(0.0, d.width);
            PlateSeed {
                x,
                y: g.uniform(0.0, d.height),
            }
        })
        .collect();
    for t in rf::derive_plate_types(&seeds, &rafts, &d) {
        h.add(if t == PlateType::Continental {
            1.0
        } else {
            0.0
        });
    }
    h.add(rf::stabilised_fraction(&rafts, 150.0, 60.0));
    h.add(rf::stabilised_fraction(&[], 150.0, 60.0));
    assert_eq!(
        h.line(&format!("{name}_raft_field")),
        expected(&format!("{name}_raft_field"))
    );

    let mut h = Hash::new();
    let mut mm = m::mantle_mesh(&d);
    h.add(mm.cell_m);
    h.add(mm.cell_units);
    h.add(mm.total_area);
    h.add(mm.stable_step);
    h.add(mm.mesh.count as f64);
    let mut rng = Mulberry32::new(seed * 7);
    let mut field = m::create_mantle_field(&mut || rng.next(), &mm, m::DEFAULT_INITIAL_SMOOTHING);
    h.add_all(&field);
    for e in 0..10 {
        field = m::evolve_mantle_field(field, &rafts, &mm, if e % 2 == 0 { 1.0 } else { 1.7 });
        h.add_all(&field);
    }
    m::sustain_mantle_vigour(&mut field, 0.4, &mm);
    h.add_all(&field);
    let (cx, cy) = (g.uniform(0.0, d.width), g.uniform(0.0, d.height));
    m::cool_mantle_at(&mut field, cx, cy, &mm, 300.0, 0.8);
    h.add_all(&field);
    let flow = m::compute_mantle_flow(&field, &mm, MANTLE_TUNING.flow_speed_scale);
    h.add_all(&flow.east);
    h.add_all(&flow.south);
    for _ in 0..2000 {
        let x = g.uniform(0.0, d.width);
        let y = g.uniform(0.0, d.height);
        h.add(m::mantle_at(&mut mm, &field, x, y));
        let (vx, vy) = m::mantle_flow_at(&mut mm, &flow, x, y);
        h.add(vx);
        h.add(vy);
    }
    h.add_all(&m::rasterise_mantle(&mut mm, &field));
    let saved = m::saved_mantle(&mm, &field);
    h.add(saved.cells as f64);
    h.add(saved.spacing_m);
    h.add(if m::mantle_fits(&mm, saved.cells, saved.spacing_m) {
        1.0
    } else {
        0.0
    });
    h.add(if m::mantle_fits(&mm, saved.cells + 1, saved.spacing_m) {
        1.0
    } else {
        0.0
    });
    h.add(mm.mesh.tri.last_tri as f64);
    h.add(mm.mesh.tri.walk_steps as f64);
    assert_eq!(
        h.line(&format!("{name}_mantle")),
        expected(&format!("{name}_mantle"))
    );
}

#[test]
fn the_torus_rafts_and_mantle_give_the_typescript_values() {
    scenario("torus", Domain::torus(2048.0, 1024.0), 1);
}

#[test]
fn the_sphere_rafts_and_mantle_give_the_typescript_values() {
    scenario("sphere", Domain::sphere(2048.0, 1024.0), 2);
}
