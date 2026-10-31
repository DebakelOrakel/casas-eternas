//! The incubator (docs/decisions/incubator-history-engine.md):
//! a port of `client/src/screens/incubator/` that gives its bits — the
//! habitat's cells, the flora, the fauna, the simulated history and its
//! settlement, the H1 artifact's bytes. Plain data in, plain data out; the
//! bindings (`casas-incubator-wasm`) wrap it.

// A port keeps the TypeScript's loops over indices, as the engine does.
#![allow(clippy::needless_range_loop)]

pub mod catalog;
pub mod chart;
pub mod climate_history;
pub mod eruptions;
pub mod flora;
pub mod habitat;
pub mod history;
pub mod language;
pub mod languages;
pub mod log;
pub mod niche;
pub mod pack;
pub mod peoples;
pub mod peopling;
pub mod place_names;
pub mod settle;
pub mod simulation;
pub mod travel;
pub mod tuning;
