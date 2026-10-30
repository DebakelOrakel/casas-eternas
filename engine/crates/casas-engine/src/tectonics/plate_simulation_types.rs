//! `tectonics/plateSimulationTypes.ts`: the simulation's data and its event
//! vocabulary. The reasoning behind each field is in the TypeScript file.

use crate::core::domain::Domain;
use crate::core::rng::Mulberry32;
use crate::crust::raft_types::{Raft, Suture};
use crate::fields::field_mesh::{SharedFieldMesh, shared_field_mesh};
use crate::mantle::mantle_field::{MantleMesh, mantle_mesh};

use super::boundary_lattice::LatticePoint;
use super::ocean_age::{OceanAge, ocean_age, ocean_age_spacing_m};
use super::plate_motion::PlateMotion;
use super::plate_seeds::PlateSeed;
use super::plate_types::PlateType;
use super::plumes::Plume;
use super::terrain_features::TerrainFeature;

/// The field meshes a world's stages read: the mantle's, and the one the
/// ocean age, the flexure and the climate share, with the ocean age's
/// scratch. The TypeScript engine keeps them in module caches per domain,
/// so the Archean and the tectonics move the same walk state; here the
/// caller makes them once per world and hands them on.
pub struct WorldMeshes {
    pub mantle: MantleMesh,
    pub shared: SharedFieldMesh,
    pub ocean: OceanAge,
}

pub fn world_meshes(domain: &Domain) -> WorldMeshes {
    let shared = shared_field_mesh(domain, ocean_age_spacing_m(domain));
    let ocean = ocean_age(&shared);
    WorldMeshes {
        mantle: mantle_mesh(domain),
        shared,
        ocean,
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ClimateEpochRecord {
    pub epoch: f64,
    pub mean_land_temp_c: f64,
    pub ice_volume_km3: f64,
    pub sea_level_m: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct LakeAgeRecord {
    pub x: f64,
    pub y: f64,
    pub level: f64,
    pub age_ma: f64,
}

pub struct PlateSimulation {
    pub width: f64,
    pub height: f64,
    pub domain: Domain,
    pub meshes: WorldMeshes,
    pub epoch_ma: f64,
    pub sediment_export_m3: f64,
    pub eustatic_m: f64,
    pub climate_history: Vec<ClimateEpochRecord>,
    pub lake_ages: Vec<LakeAgeRecord>,
    pub initial_plate_count: f64,
    pub seeds: Vec<PlateSeed>,
    pub rafts: Vec<Raft>,
    pub types: Vec<PlateType>,
    pub motions: Vec<PlateMotion>,
    pub ages: Vec<f64>,
    pub features: Vec<TerrainFeature>,
    pub epoch: f64,
    pub archean_epochs: f64,
    pub random: Mulberry32,
    pub warp_seed: f64,
    pub lattice: Vec<LatticePoint>,
    pub lattice_accumulated: Vec<f32>,
    pub lattice_locked_epochs: Vec<i16>,
    pub lattice_last_class_code: Vec<i8>,
    pub ocean_age: Vec<f64>,
    pub supercontinent_active: bool,
    pub continental_rift_cooldown_until: f64,
    pub mantle: Vec<f64>,
    pub hotspots: Vec<Plume>,
    pub sutures: Vec<Suture>,
}

/// What a save holds of a running simulation (`PlateSimulationSnapshot`);
/// the absent fields of old saves are their defaults.
#[derive(Clone, Debug, PartialEq)]
pub struct PlateSimulationSnapshot {
    pub epoch_ma: Option<f64>,
    pub sediment_export_m3: Option<f64>,
    pub eustatic_m: Option<f64>,
    pub climate_history: Option<Vec<ClimateEpochRecord>>,
    pub lake_ages: Option<Vec<LakeAgeRecord>>,
    pub archean_epochs: Option<f64>,
    pub width: f64,
    pub height: f64,
    pub initial_plate_count: f64,
    pub seeds: Vec<PlateSeed>,
    pub motions: Vec<PlateMotion>,
    pub ages: Vec<f64>,
    pub rafts: Vec<Raft>,
    pub features: Vec<TerrainFeature>,
    pub epoch: f64,
    pub warp_seed: f64,
    pub supercontinent_active: bool,
    pub continental_rift_cooldown_until: f64,
    pub hotspots: Option<Vec<Plume>>,
    pub sutures: Option<Vec<Suture>>,
    pub rng_state: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SimEventType {
    ContinentCollided,
    ContinentBrokeUp,
    SupercontinentFormed,
    OceanicCreated,
    OceanicSubducted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EventCategory {
    Continent,
    Routine,
}

pub fn event_category(t: SimEventType) -> EventCategory {
    match t {
        SimEventType::OceanicCreated | SimEventType::OceanicSubducted => EventCategory::Routine,
        _ => EventCategory::Continent,
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct SimEvent {
    pub kind: SimEventType,
    pub name: Option<String>,
    pub name_a: Option<String>,
    pub name_b: Option<String>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub dir_x: Option<f64>,
    pub dir_y: Option<f64>,
    pub plate_index: Option<usize>,
    pub other_plate_index: Option<usize>,
}

impl SimEvent {
    pub fn new(kind: SimEventType) -> Self {
        SimEvent {
            kind,
            name: None,
            name_a: None,
            name_b: None,
            x: None,
            y: None,
            dir_x: None,
            dir_y: None,
            plate_index: None,
            other_plate_index: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RiftEvent {
    pub x: f64,
    pub y: f64,
    pub plate_a: usize,
    pub plate_b: usize,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MergeEvent {
    pub x: f64,
    pub y: f64,
    pub keep_index: usize,
    pub remove_index: usize,
    /// The crust on the removed plate's side of the boundary is oceanic.
    pub removed_oceanic: bool,
}
