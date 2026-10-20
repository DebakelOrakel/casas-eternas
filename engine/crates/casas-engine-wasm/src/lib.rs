//! The WASM build of the engine for the browser. `make engine` runs
//! wasm-bindgen over it into `engine/dist/wasm/`. It wraps
//! `casas-engine-api` one for one (docs/decisions/rust-engine.md, fork 6).

use wasm_bindgen::prelude::*;

/// The engine's crate version.
#[wasm_bindgen]
pub fn version() -> String {
    casas_engine_api::version().to_string()
}

/// A world in the engine.
#[wasm_bindgen]
pub struct World(casas_engine_api::World);

#[wasm_bindgen]
impl World {
    /// A new world in its Archean; `shape` "torus" or "sphere".
    pub fn genesis(
        seed: &str,
        width: u32,
        height: u32,
        shape: &str,
        diffusion: f64,
        land_share: f64,
    ) -> Result<World, JsError> {
        Ok(World(casas_engine_api::World::genesis(
            seed,
            width,
            height,
            shape_of(shape)?,
            diffusion,
            land_share,
        )))
    }

    #[wasm_bindgen(js_name = archeanStep)]
    pub fn archean_step(&mut self) {
        self.0.archean_step();
    }

    #[wasm_bindgen(getter, js_name = archeanEpoch)]
    pub fn archean_epoch(&self) -> f64 {
        self.0.archean_epoch()
    }

    pub fn mantle(&self) -> Vec<f64> {
        self.0.mantle()
    }

    #[wasm_bindgen(getter, js_name = raftCount)]
    pub fn raft_count(&self) -> u32 {
        self.0.raft_count()
    }
}

fn shape_of(shape: &str) -> Result<casas_engine_api::Shape, JsError> {
    match shape {
        "torus" => Ok(casas_engine_api::Shape::Torus),
        "sphere" => Ok(casas_engine_api::Shape::Sphere),
        _ => Err(JsError::new(&format!("no world shape {shape}"))),
    }
}
