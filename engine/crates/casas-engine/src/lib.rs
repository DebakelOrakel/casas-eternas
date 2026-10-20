//! The Rust engine (docs/decisions/rust-engine.md, DEC-0044).
//!
//! This crate holds the computation only. It does no I/O and knows no
//! binding; `casas-engine-node` and `casas-engine-wasm` expose it. Its
//! modules follow the TypeScript engine's directories
//! (`client/src/generator/`).

// A port keeps the TypeScript engine's index loops, so that a loop reads
// like its source and visits in its order.
#![allow(clippy::needless_range_loop)]

/// The version of this crate. It is not the pipeline version: that is the
/// engine plus its constants, and it comes with the first stage.
pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");

pub mod core;
pub mod elevation;
pub mod fields;
pub mod mesh;
pub mod surface;
