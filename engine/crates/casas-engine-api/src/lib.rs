//! The engine's surface to TypeScript (docs/decisions/rust-engine.md,
//! fork 6). A world is an object here: its state — the Archean or the
//! plates, the coupled terrain, the field meshes with their walks — stays
//! in the engine, and only what TypeScript shows, saves or posts crosses,
//! as plain data (`value::Value`, in the TypeScript types' shapes,
//! `forms`). `casas-engine-node` (napi) and `casas-engine-wasm`
//! (wasm-bindgen) wrap these methods one for one.

pub mod forms;
pub mod value;

use casas_engine::archean::archean_state::{ArcheanSimulation, create_archean_simulation};
use casas_engine::archean::archean_step::{ArcheanParams, archean_step, default_archean_params};
use casas_engine::archean::finalize_archean::finalize_archean;
use casas_engine::climate::weather::WeatherParams;
use casas_engine::core::domain::Domain;
use casas_engine::core::world_time::TECTONIC_MA_PER_EPOCH;
use casas_engine::mantle::mantle_field::saved_mantle;
use casas_engine::pipeline::coupled_epoch::{
    CoupledEpochOptions, CoupledTerrain, HISTORY_DEFAULTS, create_coupled_terrain,
    step_coupled_epoch,
};
use casas_engine::surface::erosion_forcing_fields::ErosionControls;
use casas_engine::tectonics::ocean_age::saved_ocean_age;
use casas_engine::tectonics::plate_simulation::serialize_plate_simulation;
use casas_engine::tectonics::plate_simulation_types::PlateSimulation;

pub use value::Value;

/// The engine's crate version.
pub fn version() -> &'static str {
    casas_engine::ENGINE_VERSION
}

/// The world's shape.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shape {
    Torus,
    Sphere,
}

/// What a call asked of a world in the wrong era.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EraError(pub &'static str);

impl std::fmt::Display for EraError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

enum Era {
    Archean(Box<ArcheanSimulation>),
    Plates {
        sim: Box<PlateSimulation>,
        coupled: Box<CoupledTerrain>,
    },
    /// Between two eras, for the hand-over's move only.
    Moving,
}

/// The history's controls for an epoch (the tectonics panel's and the
/// climate's): the erosion's materials and the weather's levers. The
/// planet is Earth's (the Planet stage's forcing does not cross yet).
#[derive(Clone, Copy, Debug)]
pub struct EpochControls {
    pub alluvium: f64,
    pub rock_contrast: f64,
    pub temperature_offset: f64,
    pub temperature_contrast: f64,
    pub humidity: f64,
    pub equator_offset: f64,
}

/// A world in the engine.
pub struct World {
    era: Era,
    archean_params: ArcheanParams,
}

impl World {
    /// A new world in its Archean (`createArcheanSimulation` in
    /// TypeScript), with the Archean's controls: the mantle's diffusion
    /// and the land share it aims at.
    pub fn genesis(
        seed: &str,
        width: u32,
        height: u32,
        shape: Shape,
        diffusion: f64,
        land_share: f64,
    ) -> World {
        let domain = match shape {
            Shape::Torus => Domain::torus(width as f64, height as f64),
            Shape::Sphere => Domain::sphere(width as f64, height as f64),
        };
        let archean_params = ArcheanParams {
            diffusion,
            land_share,
            ..default_archean_params()
        };
        World {
            era: Era::Archean(Box::new(create_archean_simulation(seed, domain))),
            archean_params,
        }
    }

    fn archean(&self) -> Result<&ArcheanSimulation, EraError> {
        match &self.era {
            Era::Archean(a) => Ok(a),
            _ => Err(EraError("the world is past its Archean")),
        }
    }

    fn plates(&mut self) -> Result<(&mut PlateSimulation, &mut CoupledTerrain), EraError> {
        match &mut self.era {
            Era::Plates { sim, coupled } => Ok((sim, coupled)),
            _ => Err(EraError("the world has no plates yet")),
        }
    }

    /// One Archean step.
    pub fn archean_step(&mut self) -> Result<(), EraError> {
        match &mut self.era {
            Era::Archean(a) => {
                archean_step(a, &self.archean_params);
                Ok(())
            }
            _ => Err(EraError("the world is past its Archean")),
        }
    }

    /// The Archean's epoch.
    pub fn archean_epoch(&self) -> Result<f64, EraError> {
        Ok(self.archean()?.epoch)
    }

    /// The mantle's buoyancy per cell of its field mesh, in either era.
    pub fn mantle(&self) -> Vec<f64> {
        match &self.era {
            Era::Archean(a) => a.mantle.clone(),
            Era::Plates { sim, .. } => sim.mantle.clone(),
            Era::Moving => Vec::new(),
        }
    }

    /// The rafts' count, in either era.
    pub fn raft_count(&self) -> u32 {
        match &self.era {
            Era::Archean(a) => a.rafts.len() as u32,
            Era::Plates { sim, .. } => sim.rafts.len() as u32,
            Era::Moving => 0,
        }
    }

    /// The hand-over (the runtime's `handleGenesisFinalize`): the plates
    /// from the Archean, the epoch's length, and the history's terrain
    /// from the synthesis at the hand-over.
    pub fn finalize(&mut self) -> Result<(), EraError> {
        let Era::Archean(a) = std::mem::replace(&mut self.era, Era::Moving) else {
            return Err(EraError("the world is past its Archean"));
        };
        let mut sim = Box::new(finalize_archean(*a));
        sim.epoch_ma = TECTONIC_MA_PER_EPOCH;
        let coupled = Box::new(create_coupled_terrain(&mut sim, HISTORY_DEFAULTS.budget));
        self.era = Era::Plates { sim, coupled };
        Ok(())
    }

    /// One coupled epoch at the history's settings (the runtime's
    /// tectonics loop); its events, as `SimEvent`s.
    pub fn epoch(&mut self, c: &EpochControls) -> Result<Value, EraError> {
        let (sim, coupled) = self.plates()?;
        let options = CoupledEpochOptions {
            weather: Some(WeatherParams {
                temperature_offset: c.temperature_offset,
                temperature_contrast: c.temperature_contrast,
                humidity: c.humidity,
                equator_offset: c.equator_offset,
                planet: None,
            }),
            iterations_per_epoch: HISTORY_DEFAULTS.iterations_per_epoch,
            budget: Some(HISTORY_DEFAULTS.budget),
            climate_every: Some(HISTORY_DEFAULTS.climate_every),
            remesh_every: Some(HISTORY_DEFAULTS.remesh_every),
            uplift_scale: Some(HISTORY_DEFAULTS.uplift_scale),
            controls: ErosionControls {
                alluvium: Some(c.alluvium),
                rock_contrast: Some(c.rock_contrast),
            },
            leaf_workers: None,
        };
        let stats = step_coupled_epoch(sim, coupled, &options);
        Ok(Value::List(stats.events.iter().map(forms::event).collect()))
    }

    /// The plate simulation as the save holds it
    /// (`serializePlateSimulation`).
    pub fn snapshot(&mut self) -> Result<Value, EraError> {
        let (sim, _) = self.plates()?;
        Ok(forms::snapshot(&serialize_plate_simulation(sim)))
    }

    /// The field meshes' values as the save holds them: the mantle's and
    /// the ocean age's (`SavedField`).
    pub fn saved_fields(&mut self) -> Result<(Value, Value), EraError> {
        let (sim, _) = self.plates()?;
        let mantle = saved_mantle(&sim.meshes.mantle, &sim.mantle);
        let ocean = saved_ocean_age(&sim.meshes.ocean, &sim.meshes.shared, &sim.ocean_age);
        Ok((forms::saved_field(&mantle), forms::saved_field(&ocean)))
    }

    /// The coupled terrain as the save's bytes.
    pub fn mesh_payload(&mut self) -> Result<Value, EraError> {
        let (_, coupled) = self.plates()?;
        Ok(forms::mesh_payload(coupled))
    }
}
