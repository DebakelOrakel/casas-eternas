//! DYNAMIC TOPOGRAPHY, the mantle's buoyancy anomaly as a height term,
//! read from the mantle's field mesh. This port holds the point query;
//! the render's raster (which needs the terrain mesh's rasteriser) comes
//! with the render.

use crate::fields::field_mesh::{FieldMesh, FieldSampler};

use super::elevation_tune_params::ELEVATION_TUNING;

pub fn dynamic_topography_at(
    mantle: &[f64],
    sampler: &FieldSampler,
    mesh: &mut FieldMesh,
    x: f64,
    y: f64,
) -> f64 {
    sampler.sample(mesh, mantle, x, y) * ELEVATION_TUNING.dynamic_topography_per_unit
}
