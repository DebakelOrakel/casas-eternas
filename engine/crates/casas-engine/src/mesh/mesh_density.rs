//! `mesh/meshDensity.ts`: THE DENSITY RULE (decision 1 of
//! docs/decisions/adaptive-mesh.md), the target node spacing at a point.
//! The reasoning and the measurements behind the constants are in the
//! TypeScript file.

use crate::core::js;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshTuning {
    pub min_spacing_m: f64,
    pub max_spacing_m: f64,
    pub ocean_spacing_m: f64,
    pub deep_ocean_below_m: f64,
    pub ocean_built_above_m: f64,
    pub ocean_built_spacing_m: f64,
    pub relief_per_node_m: f64,
    pub discharge_ref_m3s: f64,
    pub curvature_factor: f64,
    pub column_threshold_m: f64,
    pub column_spacing_m: f64,
    pub insert_ratio: f64,
    pub remove_ratio: f64,
}

pub const MESH_TUNING: MeshTuning = MeshTuning {
    min_spacing_m: 2000.0,
    max_spacing_m: 7800.0,
    ocean_spacing_m: 40000.0,
    deep_ocean_below_m: -300.0,
    ocean_built_above_m: 500.0,
    ocean_built_spacing_m: 10_000.0,
    relief_per_node_m: 100.0,
    discharge_ref_m3s: 5000.0,
    curvature_factor: 0.5,
    column_threshold_m: 50.0,
    column_spacing_m: 4000.0,
    insert_ratio: 1.5,
    remove_ratio: 0.5,
};

/// Target spacing in metres from the slope (m/m), the discharge (m³/s), the
/// curvature (1/m), the sediment column (m), the height above sea level and
/// the relief built on the solid baseline (m). In the deep sea, relief built
/// past `ocean_built_above_m` (a volcano, tectonics/volcanic_build.rs) keeps
/// `ocean_built_spacing_m`: at the ocean's spacing a cone 160 km wide is one
/// node, and coarsening spreads it out.
pub fn target_spacing_m(
    slope: f64,
    discharge_m3s: f64,
    curvature_per_m: f64,
    column_m: f64,
    height_m: f64,
    built_m: f64,
    budget: f64,
) -> f64 {
    if height_m < MESH_TUNING.deep_ocean_below_m {
        if built_m > MESH_TUNING.ocean_built_above_m {
            return MESH_TUNING.ocean_built_spacing_m * budget;
        }
        return MESH_TUNING.ocean_spacing_m * budget;
    }
    let mut h = MESH_TUNING.max_spacing_m;
    if slope > 0.0 {
        h = js::min(h, MESH_TUNING.relief_per_node_m / slope);
    }
    if discharge_m3s > 0.0 {
        h = js::min(
            h,
            MESH_TUNING.min_spacing_m * (MESH_TUNING.discharge_ref_m3s / discharge_m3s).sqrt(),
        );
    }
    let k = curvature_per_m.abs();
    if k > 0.0 {
        h = js::min(h, MESH_TUNING.curvature_factor / k);
    }
    if column_m > MESH_TUNING.column_threshold_m {
        h = js::min(h, MESH_TUNING.column_spacing_m);
    }
    if h < MESH_TUNING.min_spacing_m {
        h = MESH_TUNING.min_spacing_m;
    }
    h * budget
}
