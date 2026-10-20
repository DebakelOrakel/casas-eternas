//! The WASM build of the engine for the browser. `make engine` runs
//! wasm-bindgen over it into `engine/dist/wasm/`. It wraps
//! `casas-engine-api` one for one (docs/decisions/rust-engine.md, fork 6).

mod tree;

use casas_engine_api::{EpochControls, EraError};
use tree::to_js;
use wasm_bindgen::prelude::*;

/// The engine's crate version.
#[wasm_bindgen]
pub fn version() -> String {
    casas_engine_api::version().to_string()
}

fn era(e: EraError) -> JsError {
    JsError::new(e.0)
}

fn number(object: &JsValue, key: &str) -> Result<f64, JsError> {
    js_sys::Reflect::get(object, &JsValue::from_str(key))
        .ok()
        .and_then(|v| v.as_f64())
        .ok_or_else(|| JsError::new(&format!("the controls have no number {key}")))
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
    pub fn archean_step(&mut self) -> Result<(), JsError> {
        self.0.archean_step().map_err(era)
    }

    #[wasm_bindgen(getter, js_name = archeanEpoch)]
    pub fn archean_epoch(&self) -> Result<f64, JsError> {
        self.0.archean_epoch().map_err(era)
    }

    pub fn mantle(&self) -> Vec<f64> {
        self.0.mantle()
    }

    #[wasm_bindgen(getter, js_name = raftCount)]
    pub fn raft_count(&self) -> u32 {
        self.0.raft_count()
    }

    pub fn finalize(&mut self) -> Result<(), JsError> {
        self.0.finalize().map_err(era)
    }

    /// One coupled epoch; its events. `controls`: { alluvium,
    /// rockContrast, temperatureOffset, temperatureContrast, humidity,
    /// equatorOffset }.
    pub fn epoch(&mut self, controls: &JsValue) -> Result<JsValue, JsError> {
        let c = EpochControls {
            alluvium: number(controls, "alluvium")?,
            rock_contrast: number(controls, "rockContrast")?,
            temperature_offset: number(controls, "temperatureOffset")?,
            temperature_contrast: number(controls, "temperatureContrast")?,
            humidity: number(controls, "humidity")?,
            equator_offset: number(controls, "equatorOffset")?,
        };
        self.0.epoch(&c).map(to_js).map_err(era)
    }

    pub fn snapshot(&mut self) -> Result<JsValue, JsError> {
        self.0.snapshot().map(to_js).map_err(era)
    }

    /// The mantle's and the ocean age's saved values, as [mantle, ocean].
    #[wasm_bindgen(js_name = savedFields)]
    pub fn saved_fields(&mut self) -> Result<JsValue, JsError> {
        let (m, o) = self.0.saved_fields().map_err(era)?;
        Ok(to_js(casas_engine_api::Value::List(vec![m, o])))
    }

    #[wasm_bindgen(js_name = meshPayload)]
    pub fn mesh_payload(&mut self) -> Result<JsValue, JsError> {
        self.0.mesh_payload().map(to_js).map_err(era)
    }
}

fn shape_of(shape: &str) -> Result<casas_engine_api::Shape, JsError> {
    match shape {
        "torus" => Ok(casas_engine_api::Shape::Torus),
        "sphere" => Ok(casas_engine_api::Shape::Sphere),
        _ => Err(JsError::new(&format!("no world shape {shape}"))),
    }
}
