//! The native build of the engine for the Node job worker. `make engine`
//! copies it to `engine/dist/casas-engine.node`. It wraps
//! `casas-engine-api` one for one (docs/decisions/rust-engine.md, fork 6).

use napi::bindgen_prelude::Float64Array;
use napi_derive::napi;

/// The engine's crate version.
#[napi]
pub fn version() -> String {
    casas_engine_api::version().to_string()
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
    pub fn archean_step(&mut self) {
        self.0.archean_step();
    }

    #[napi(getter)]
    pub fn archean_epoch(&self) -> f64 {
        self.0.archean_epoch()
    }

    #[napi]
    pub fn mantle(&self) -> Float64Array {
        Float64Array::new(self.0.mantle())
    }

    #[napi(getter)]
    pub fn raft_count(&self) -> u32 {
        self.0.raft_count()
    }
}

fn shape_of(shape: &str) -> napi::Result<casas_engine_api::Shape> {
    match shape {
        "torus" => Ok(casas_engine_api::Shape::Torus),
        "sphere" => Ok(casas_engine_api::Shape::Sphere),
        _ => Err(napi::Error::from_reason(format!("no world shape {shape}"))),
    }
}
