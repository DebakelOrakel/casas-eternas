//! The native build of the engine for the Node job worker. `make engine`
//! copies it to `engine/dist/casas-engine.node`.

use napi_derive::napi;

/// The engine's crate version.
#[napi]
pub fn version() -> String {
    casas_engine::ENGINE_VERSION.to_string()
}
