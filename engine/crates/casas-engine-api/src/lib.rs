//! The engine's surface to TypeScript (docs/decisions/rust-engine.md,
//! fork 6). A world is an object here: its state — the Archean or the
//! plates, the coupled terrain, the field meshes with their walks — stays
//! in the engine, and only what TypeScript shows, saves or posts crosses,
//! as plain data. `casas-engine-node` (napi) and `casas-engine-wasm`
//! (wasm-bindgen) wrap these methods one for one.

use casas_engine::archean::archean_state::{ArcheanSimulation, create_archean_simulation};
use casas_engine::archean::archean_step::{ArcheanParams, archean_step, default_archean_params};
use casas_engine::core::domain::Domain;

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

enum Era {
    Archean(Box<ArcheanSimulation>),
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

    /// One Archean step.
    pub fn archean_step(&mut self) {
        let Era::Archean(a) = &mut self.era;
        archean_step(a, &self.archean_params);
    }

    /// The Archean's epoch.
    pub fn archean_epoch(&self) -> f64 {
        let Era::Archean(a) = &self.era;
        a.epoch
    }

    /// The mantle's buoyancy per cell of its field mesh.
    pub fn mantle(&self) -> Vec<f64> {
        let Era::Archean(a) = &self.era;
        a.mantle.clone()
    }

    /// The rafts' count.
    pub fn raft_count(&self) -> u32 {
        let Era::Archean(a) = &self.era;
        a.rafts.len() as u32
    }
}
