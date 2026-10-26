//! The WASM build of the incubator's history for the browser
//! (docs/decisions/incubator-history-engine.md, fork 3). `make engine` runs
//! wasm-bindgen over it into `engine/dist/history/`.

use wasm_bindgen::prelude::*;

/// The history's version (`casas_history::HISTORY_VERSION`).
#[wasm_bindgen]
pub fn version() -> String {
    casas_history::HISTORY_VERSION.to_string()
}
