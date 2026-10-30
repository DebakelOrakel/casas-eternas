//! The epoch's phases (`tectonics/epoch/`), in the order
//! `plate_simulation::step_epoch` runs them.

pub mod boundary_pass;
pub mod feature_pruning;
pub mod mantle_coupling;
pub mod plate_churn;
pub mod plate_drift;
pub mod raft_events;
