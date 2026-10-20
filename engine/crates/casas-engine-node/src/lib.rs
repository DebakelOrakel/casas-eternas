//! The native build of the engine for the Node job worker. `make engine`
//! copies it to `engine/dist/casas-engine.node`. It wraps
//! `casas-engine-api` one for one (docs/decisions/rust-engine.md, fork 6).

mod tree;

use casas_engine_api::{EpochControls, EraError};
use napi::bindgen_prelude::Float64Array;
use napi_derive::napi;
use tree::Tree;

/// The engine's crate version.
#[napi]
pub fn version() -> String {
    casas_engine_api::version().to_string()
}

fn era(e: EraError) -> napi::Error {
    napi::Error::from_reason(e.0)
}

/// The history's controls for an epoch.
#[napi(object)]
pub struct Controls {
    pub alluvium: f64,
    pub rock_contrast: f64,
    pub temperature_offset: f64,
    pub temperature_contrast: f64,
    pub humidity: f64,
    pub equator_offset: f64,
}

/// A world in the engine.
#[napi]
pub struct World(casas_engine_api::World);

#[napi]
impl World {
    /// A new world in its Archean; `shape` "torus" or "sphere".
    #[napi(factory)]
    pub fn genesis(
        seed: String,
        width: u32,
        height: u32,
        shape: String,
        diffusion: f64,
        land_share: f64,
    ) -> napi::Result<World> {
        Ok(World(casas_engine_api::World::genesis(
            &seed,
            width,
            height,
            shape_of(&shape)?,
            diffusion,
            land_share,
        )))
    }

    #[napi]
    pub fn archean_step(&mut self) -> napi::Result<()> {
        self.0.archean_step().map_err(era)
    }

    #[napi(getter)]
    pub fn archean_epoch(&self) -> napi::Result<f64> {
        self.0.archean_epoch().map_err(era)
    }

    #[napi]
    pub fn mantle(&self) -> Float64Array {
        Float64Array::new(self.0.mantle())
    }

    #[napi(getter)]
    pub fn raft_count(&self) -> u32 {
        self.0.raft_count()
    }

    #[napi]
    pub fn finalize(&mut self) -> napi::Result<()> {
        self.0.finalize().map_err(era)
    }

    /// One coupled epoch; its events.
    #[napi]
    pub fn epoch(&mut self, controls: Controls) -> napi::Result<Tree> {
        let c = EpochControls {
            alluvium: controls.alluvium,
            rock_contrast: controls.rock_contrast,
            temperature_offset: controls.temperature_offset,
            temperature_contrast: controls.temperature_contrast,
            humidity: controls.humidity,
            equator_offset: controls.equator_offset,
        };
        self.0.epoch(&c).map(Tree).map_err(era)
    }

    #[napi]
    pub fn snapshot(&mut self) -> napi::Result<Tree> {
        self.0.snapshot().map(Tree).map_err(era)
    }

    /// The mantle's and the ocean age's saved values, as [mantle, ocean].
    #[napi]
    pub fn saved_fields(&mut self) -> napi::Result<Vec<Tree>> {
        let (m, o) = self.0.saved_fields().map_err(era)?;
        Ok(vec![Tree(m), Tree(o)])
    }

    #[napi]
    pub fn mesh_payload(&mut self) -> napi::Result<Tree> {
        self.0.mesh_payload().map(Tree).map_err(era)
    }
}

fn shape_of(shape: &str) -> napi::Result<casas_engine_api::Shape> {
    match shape {
        "torus" => Ok(casas_engine_api::Shape::Torus),
        "sphere" => Ok(casas_engine_api::Shape::Sphere),
        _ => Err(napi::Error::from_reason(format!("no world shape {shape}"))),
    }
}
