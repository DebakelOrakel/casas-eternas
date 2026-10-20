//! `surface/erosionEngineState.ts`: the erosion engine's graph index. This
//! port holds the index; the engine's state comes with the engine.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IndexKind {
    Raster,
    Mesh,
}

/// The engine's substrate: a CSR neighbour table over the active nodes,
/// with a reach length, a facet factor and a reverse edge per directed
/// edge and an area per node (`EngineIndex` in TypeScript, which explains
/// each field).
#[derive(Clone, Debug)]
pub struct EngineIndex {
    pub kind: IndexKind,
    /// The raster's dimensions; 0 for a mesh.
    pub width: u32,
    pub height: u32,
    /// The cells or vertex slots the full arrays are laid out for.
    pub cell_count: u32,
    pub active_count: u32,
    pub active: Vec<i32>,
    pub active_of: Vec<i32>,
    pub frozen_count: u32,
    pub nbr_start: Vec<i32>,
    pub nbr: Vec<i32>,
    pub edge_count: u32,
    pub edge_rev: Vec<i32>,
    pub len_rel: Vec<f32>,
    pub diff_factor: Vec<f32>,
    pub mfd_factor: Vec<f32>,
    pub area_rel: Vec<f32>,
    /// The reference length in metres.
    pub ref_m: f64,
}
