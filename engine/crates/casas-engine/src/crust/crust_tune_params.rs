//! The raft geometry both eras share. The reasoning behind each value
//! is in the TypeScript port
//! (`client/src/generator/crust/crustTuneParams.ts`, git history).

/// Two blobs' radii sum times this is the centre distance that counts as
/// overlapping (a raft merge).
pub const MERGE_OVERLAP_FACTOR: f64 = 0.5;
/// Blobs within (ra + rb) times this are one landmass.
pub const RAFT_CONNECT_FACTOR: f64 = 0.75;
