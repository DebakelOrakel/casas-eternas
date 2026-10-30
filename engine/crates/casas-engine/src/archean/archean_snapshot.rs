//! Saving a world still in the Archean.

use crate::core::domain::Domain;
use crate::core::js::{to_int32, to_uint32};
use crate::core::rng::Mulberry32;
use crate::crust::raft_types::Raft;
use crate::fields::field_mesh::SavedField;
use crate::mantle::mantle_field::{
    DEFAULT_INITIAL_SMOOTHING, create_mantle_field, restore_mantle_field,
};
use crate::tectonics::plate_simulation_types::WorldMeshes;

use super::archean_state::ArcheanSimulation;

#[derive(Clone, Debug, PartialEq)]
pub struct ArcheanSnapshot {
    pub width: f64,
    pub height: f64,
    pub epoch: f64,
    pub warp_seed: f64,
    pub nucleation_credit: Option<f64>,
    pub rafts: Vec<Raft>,
    pub rng_state: u32,
}

pub fn serialize_archean(a: &ArcheanSimulation) -> ArcheanSnapshot {
    ArcheanSnapshot {
        width: a.width,
        height: a.height,
        epoch: a.epoch,
        warp_seed: a.warp_seed,
        nucleation_credit: Some(a.nucleation_credit),
        rafts: a.rafts.clone(),
        rng_state: a.random.state(),
    }
}

/// The Archean from a snapshot; `streak` of another length than the
/// mantle's cells starts the streaks over.
pub fn deserialize_archean(
    snap: &ArcheanSnapshot,
    mantle: Option<&SavedField>,
    streak: Vec<i16>,
    domain: Domain,
    meshes: WorldMeshes,
) -> Result<ArcheanSimulation, String> {
    let cells = meshes.mantle.mesh.count;
    let mantle = match restore_mantle_field(&meshes.mantle, mantle)? {
        Some(m) => m,
        None => {
            let mut rng = Mulberry32::new(to_uint32(
                (to_int32(snap.warp_seed) ^ 0x5bd1e995u32 as i32) as f64,
            ));
            create_mantle_field(
                &mut || rng.next(),
                &meshes.mantle,
                DEFAULT_INITIAL_SMOOTHING,
            )
        }
    };
    Ok(ArcheanSimulation {
        width: snap.width,
        height: snap.height,
        domain,
        meshes,
        epoch: snap.epoch,
        random: Mulberry32::new(snap.rng_state),
        warp_seed: snap.warp_seed,
        rafts: snap.rafts.clone(),
        mantle,
        upwelling_streak: if streak.len() == cells {
            streak
        } else {
            vec![0; cells]
        },
        last_recycled: 0,
        last_splits: 0,
        last_nucleated: 0,
        nucleation_credit: snap.nucleation_credit.unwrap_or(0.0),
    })
}
