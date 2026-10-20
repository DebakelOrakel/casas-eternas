//! The state hashes the epoch and Archean tests share, as
//! `engine/scripts/simHash.mjs` makes them.

use casas_engine::archean::archean_state::ArcheanSimulation;
use casas_engine::tectonics::plate_motion::PlateMotion;
use casas_engine::tectonics::plate_simulation_types::{PlateSimulation, SimEvent, SimEventType};
use casas_engine::tectonics::plate_types::PlateType;
use casas_engine::tectonics::terrain_features::{FeatureKind, MovesWith};

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

pub fn state_hash(sim: &PlateSimulation, events: &[SimEvent]) -> String {
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

/// The Archean world's state, as `archeanHash`.
#[allow(dead_code)]
pub fn archean_hash(sim: &ArcheanSimulation) -> String {
    let mut h = Hash(0x811c_9dc5);
    for v in [
        sim.epoch,
        sim.last_recycled as f64,
        sim.last_splits as f64,
        sim.last_nucleated as f64,
        sim.nucleation_credit,
        sim.warp_seed,
    ] {
        h.add(v);
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
    for &v in &sim.mantle {
        h.add(v);
    }
    for &v in &sim.upwelling_streak {
        h.add(v as f64);
    }
    h.add(sim.random.state() as f64);
    format!("{:08x}", h.0)
}
