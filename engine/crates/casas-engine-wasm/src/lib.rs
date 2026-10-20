//! The WASM build of the engine for the browser. `make engine` copies it to
//! `engine/dist/casas-engine.wasm`.
//!
//! The exports are plain functions over numbers and linear memory, with no
//! generated glue: the engine moves typed arrays, and a pointer and a length
//! are all that needs.

/// Where the engine's crate version starts in linear memory (UTF-8).
#[unsafe(no_mangle)]
pub extern "C" fn version_ptr() -> *const u8 {
    casas_engine::ENGINE_VERSION.as_ptr()
}

/// The length in bytes of the engine's crate version.
#[unsafe(no_mangle)]
pub extern "C" fn version_len() -> u32 {
    casas_engine::ENGINE_VERSION.len() as u32
}
