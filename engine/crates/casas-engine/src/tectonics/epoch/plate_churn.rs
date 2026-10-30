//! Phase 5: the epoch's continent-scale changes as events, then at most
//! one plate rift and one plate merge.

use crate::core::det_math::det_hypot;
use crate::crust::raft_names::pick_unused_raft_name;
use crate::crust::raft_types::Raft;
use crate::tectonics::plate_motion::generate_plate_motions;
use crate::tectonics::plate_seeds::PlateSeed;
use crate::tectonics::plate_simulation_types::{
    MergeEvent, PlateSimulation, RiftEvent, SimEvent, SimEventType,
};
use crate::tectonics::plate_types::PlateType;
use crate::tectonics::terrain_features::MovesWith;

use super::boundary_pass::BoundaryPassResult;
use super::raft_events::RaftEventResult;

fn apply_rift(sim: &mut PlateSimulation, event: &RiftEvent) {
    let seed = PlateSeed {
        x: event.x,
        y: event.y,
    };
    let random = &mut sim.random;
    let motion = generate_plate_motions(&[seed], &sim.domain, &mut || random.next())[0];
    sim.seeds.push(seed);
    sim.types.push(PlateType::Oceanic);
    sim.motions.push(motion);
    sim.ages.push(0.0);
}

fn apply_merge(sim: &mut PlateSimulation, event: &MergeEvent) {
    let (keep, remove) = (event.keep_index, event.remove_index);
    let new_keep = if keep > remove { keep - 1 } else { keep };
    let remap = |i: i64| -> i64 {
        if i == remove as i64 {
            new_keep as i64
        } else if i > remove as i64 {
            i - 1
        } else {
            i
        }
    };
    for f in sim.features.iter_mut() {
        f.plate_a = remap(f.plate_a as i64) as i32;
        f.plate_b = remap(f.plate_b as i64) as i32;
        if let MovesWith::Plate(p) = f.moves_with {
            f.moves_with = MovesWith::Plate(remap(p as i64) as u32);
        }
    }
    sim.seeds.remove(remove);
    sim.types.remove(remove);
    sim.motions.remove(remove);
    sim.ages.remove(remove);
}

/// The biggest blob's centre.
fn supercontinent_anchor(rafts: &[Raft]) -> Option<(f64, f64)> {
    let mut best: Option<&crate::crust::raft_types::RaftBlob> = None;
    for r in rafts {
        for b in &r.blobs {
            if best.is_none_or(|x| b.radius > x.radius) {
                best = Some(b);
            }
        }
    }
    best.map(|b| (b.x, b.y))
}

fn unit_len(x: f64, y: f64) -> f64 {
    let l = det_hypot(x, y);
    if l == 0.0 || l.is_nan() { 1.0 } else { l }
}

pub fn collect_events_and_apply_plate_churn(
    sim: &mut PlateSimulation,
    pass: &BoundaryPassResult,
    rafts: &RaftEventResult,
) -> Vec<SimEvent> {
    let mut events = Vec::new();
    for m in &rafts.raft_merges {
        let len = unit_len(m.tangent_x, m.tangent_y);
        let mut e = SimEvent::new(SimEventType::ContinentCollided);
        e.name_a = m.name_a.clone();
        e.name_b = m.name_b.clone();
        e.x = Some(m.x);
        e.y = Some(m.y);
        e.dir_x = Some(m.tangent_x / len);
        e.dir_y = Some(m.tangent_y / len);
        events.push(e);
    }
    if let Some(s) = &rafts.raft_split {
        let len = unit_len(s.axis_x, s.axis_y);
        let mut e = SimEvent::new(SimEventType::ContinentBrokeUp);
        e.name = s.parent_name.clone();
        e.x = Some(s.x);
        e.y = Some(s.y);
        e.dir_x = Some(s.axis_x / len);
        e.dir_y = Some(s.axis_y / len);
        events.push(e);
    }
    if sim.rafts.len() <= 1 && !sim.supercontinent_active {
        sim.supercontinent_active = true;
        if !sim.rafts.is_empty() {
            let random = &mut sim.random;
            let name = pick_unused_raft_name(&sim.rafts, &mut || random.next());
            sim.rafts[0].name = name;
        }
        if let Some((x, y)) = supercontinent_anchor(&sim.rafts) {
            let mut e = SimEvent::new(SimEventType::SupercontinentFormed);
            e.name = sim.rafts.first().and_then(|r| r.name.clone());
            e.x = Some(x);
            e.y = Some(y);
            events.push(e);
        }
    } else if sim.rafts.len() >= 2 {
        sim.supercontinent_active = false;
    }
    if let Some(rift) = &pass.rift_event {
        let continental_side = if sim.types[rift.plate_a] == PlateType::Continental {
            rift.plate_a
        } else if sim.types[rift.plate_b] == PlateType::Continental {
            rift.plate_b
        } else {
            rift.plate_a
        };
        let mut e = SimEvent::new(SimEventType::OceanicCreated);
        e.plate_index = Some(sim.seeds.len());
        e.other_plate_index = Some(continental_side);
        e.x = Some(rift.x);
        e.y = Some(rift.y);
        events.push(e);
        apply_rift(sim, rift);
    }
    if let Some(merge) = &pass.merge_event {
        if merge.removed_oceanic {
            let mut e = SimEvent::new(SimEventType::OceanicSubducted);
            e.plate_index = Some(merge.keep_index);
            e.x = Some(merge.x);
            e.y = Some(merge.y);
            events.push(e);
        }
        apply_merge(sim, merge);
    }
    events
}
