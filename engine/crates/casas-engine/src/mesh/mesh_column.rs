//! `mesh/meshColumn.ts`: the sediment column per node (phase 5.2). This
//! port holds what the density rule reads; the layers' operations come with
//! the erosion.

pub struct ColumnTuning {
    /// Layers per node; when full the two oldest merge.
    pub layer_cap: usize,
    pub soft_min_m: f64,
    pub sediment_erodibility: f64,
}

pub const COLUMN_TUNING: ColumnTuning = ColumnTuning {
    layer_cap: 8,
    soft_min_m: 1.0,
    sediment_erodibility: 3.0,
};

pub const MESH_COLUMN: &str = "column";
pub const COLUMN_VALUES: usize = 6;
pub const COLUMN_DEPTH: usize = COLUMN_TUNING.layer_cap * COLUMN_VALUES;

const T_FINE: usize = 0;
const T_COARSE: usize = 1;

/// The whole column's thickness at a node, metres.
pub fn column_thickness(data: &[f32], v: usize, layers: usize) -> f64 {
    let mut t = 0.0;
    let base = v * COLUMN_DEPTH;
    for layer in 0..layers {
        t += data[base + layer * COLUMN_VALUES + T_FINE] as f64
            + data[base + layer * COLUMN_VALUES + T_COARSE] as f64;
    }
    t
}
