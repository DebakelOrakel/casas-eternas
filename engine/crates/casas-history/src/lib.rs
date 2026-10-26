//! The incubator's history (docs/decisions/incubator-history-engine.md):
//! a port of `client/src/screens/incubator/` that gives its bits — the
//! habitat's cells, the flora, the fauna, the simulated history and its
//! settlement, the H1 artifact's bytes. Plain data in, plain data out; the
//! bindings (`casas-history-wasm`) wrap it.

pub mod catalog;

/// The history's version (world/historyArtifacts.ts HISTORY_VERSION): raised
/// by hand on any change to what a run gives or to the packed form, as the
/// client's was. `make engine` writes it to `dist/history/version.json`,
/// where the client reads it.
pub const HISTORY_VERSION: &str = "h1-2026-10-26c";
