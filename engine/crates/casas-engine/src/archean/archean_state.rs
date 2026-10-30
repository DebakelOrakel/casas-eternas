//! The Archean world: rafts on the mantle, no plates, no ocean age, no
//! features.

use crate::core::domain::Domain;
use crate::core::rng::{Mulberry32, hash_seed_string};
use crate::crust::raft_types::Raft;
use crate::mantle::mantle_field::{DEFAULT_INITIAL_SMOOTHING, create_mantle_field};
use crate::tectonics::plate_simulation_types::{WorldMeshes, world_meshes};

pub struct ArcheanSimulation {
    pub width: f64,
    pub height: f64,
    pub domain: Domain,
    pub meshes: WorldMeshes,
    pub epoch: f64,
    pub random: Mulberry32,
    pub warp_seed: f64,
    pub rafts: Vec<Raft>,
    pub mantle: Vec<f64>,
    /// Per mantle cell: consecutive epochs above the nucleation threshold.
    pub upwelling_streak: Vec<i16>,
    pub last_recycled: usize,
    pub last_splits: usize,
    pub last_nucleated: usize,
    /// The land share controller's credit of nuclei, fractional.
    pub nucleation_credit: f64,
}

/// The world's coastline-warp seed, the one salted derivation every reader
/// of the fine-detail field family shares.
pub fn coastal_warp_seed(seed_string: &str) -> u32 {
    hash_seed_string(&format!("{seed_string}:coastalWarp"))
}

pub fn create_archean_simulation(seed_string: &str, domain: Domain) -> ArcheanSimulation {
    let mut random = Mulberry32::new(hash_seed_string(seed_string));
    let meshes = world_meshes(&domain);
    let mantle = create_mantle_field(
        &mut || random.next(),
        &meshes.mantle,
        DEFAULT_INITIAL_SMOOTHING,
    );
    let cells = meshes.mantle.mesh.count;
    ArcheanSimulation {
        width: domain.width,
        height: domain.height,
        domain,
        meshes,
        epoch: 0.0,
        random,
        warp_seed: coastal_warp_seed(seed_string) as f64,
        rafts: Vec::new(),
        mantle,
        upwelling_streak: vec![0; cells],
        last_recycled: 0,
        last_splits: 0,
        last_nucleated: 0,
        nucleation_credit: 0.0,
    }
}
