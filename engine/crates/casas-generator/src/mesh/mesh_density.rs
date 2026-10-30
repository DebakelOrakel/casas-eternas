//! THE DENSITY RULE (decision 1 of docs/decisions/adaptive-mesh.md): the
//! target node spacing at a point, from four local quantities —
//!
//! ```text
//! h = clamp(min(h_relief, h_discharge, h_curvature, h_column), h_min, h_max)
//! ```
//!
//! with the deep ocean floor at one fixed spacing. ONE function for the macro
//! mesh and for every tile; the two differ only by `budget`, a scalar on the
//! result (1 for the macro mesh, smaller for a tile). Every term is a length
//! in metres so the constants read as what they are:
//!
//!   h_relief     = relief_per_node_m / slope — one node per
//!                  `relief_per_node_m` of height difference; a 5 % slope at
//!                  100 m gives 2 km.
//!   h_discharge  = min_spacing_m · sqrt(discharge_ref_m3s / Q) — the spacing
//!                  reaches the floor at the reference discharge and grows
//!                  as the square root below it (four times less water,
//!                  twice the spacing), so trunk rivers densify and
//!                  headwaters do not. Q is water AND ice flux once the ice
//!                  model exists (design/glacial.md).
//!   h_curvature  = curvature_factor / |κ| — a fraction of the radius of
//!                  curvature, so a crest or a valley floor is resolved
//!                  across, not only along.
//!   h_column     = column_spacing_m where the sediment column is thicker
//!                  than column_threshold_m, else unbounded (live since
//!                  phase 5.2, mesh/mesh_column.rs).
//!
//! Below `deep_ocean_below_m` none of the terms applies and the spacing is
//! `ocean_spacing_m` outright: the engine never computes there (the deep
//! ocean is frozen, surface/erosion_engine_state.rs), so a ridge flank or a
//! trench wall resolved at kilometres would be nodes carrying nothing.
//! Measured on the first build: with the relief term active under the sea,
//! three of four million nodes sat on the ocean floor. The shelf and the
//! continental slope above the threshold are land-like — the coast iso-line
//! and the deltas live there.
//!
//! The constants are MEASURED, not decided (ADAPTIVE_MESH_PLAN.md phase
//! 4.1): a mesh harness (`npm run harness:mesh measure <save.zip>`, since
//! removed) reported node counts on a real save, and the numbers here are
//! what those measurements settled on. They are part of every artifact's
//! identity through the constants hash (decision 2).
//!
//! Measured 2026-09-23 on a saved 2048×1024 world with 26 % land
//! (relief and discharge from the save's rasters, sampled bilinearly):
//!
//! ```text
//! min_spacing_m  max_spacing_m  deep_ocean_below_m  nodes   land    ocean   build
//!     2000          16000            -1000          1.91 M  1.01 M  0.90 M  14 s
//!     2000          16000             -300          1.35 M  1.03 M  0.32 M  10 s
//!     3900          16000             -300          0.89 M  0.66 M  0.23 M   7 s
//!     2000           7800             -300          1.67 M  1.34 M  0.33 M  19 s  <- chosen
//! ```
//!
//! with the relief term active under the sea (no deep-ocean cut-off) the
//! first build had 4.1 M nodes, 3.1 M of them on the ocean floor. The
//! binding term on land is relief for three nodes in four, the floor for
//! most of the rest; discharge binds on some 60 000 trunk-river nodes and
//! curvature never does at these constants (relief reaches the floor
//! first). A remesh on the unchanged state after a build removes about
//! 1 % (nodes the refine placed under the removal threshold of a
//! neighbour's target); the second one moves nothing — the hysteresis
//! band holds.
//!
//! The ceiling is ONE MACRO CELL (the torus's, 7.8 km) and not the 16 km the
//! first measurements ran with: the plains' micro-relief (`fine_value` in
//! elevation/elevation_field.rs, 20 m) has a 15.6 km octave that the raster
//! samples at 7.8 km and a 16 km node spacing would alias away — and it is
//! what makes lowland drainage dendritic (`ELEVATION_TUNING.plain_detail_max`).
//! While the consumers still read a 2048 rasterisation of the mesh, the mesh
//! is nowhere coarser than that raster on land; the price was +25 % nodes.
//! The constant is a macro cell stated in metres: on the sphere a macro cell
//! is 9.8 km (DEC-0035 fork 6) and the ceiling stays 7.8 km, a mesh finer
//! than its raster there. Kept so by the calibration (DEC-0036 phase 8a):
//! the micro-relief octave it must resolve is 15.6 km on both shapes now
//! (elevation/globe_noise.rs, `globe_octave_on`), so the ceiling is the
//! octave's, not the raster's.
//! The golden worlds (35 % land at most) build 1.6–4.2 M nodes.

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
    // Spacing floor and ceiling on land (the shelf and the continental slope
    // count as land here), and the one spacing of the deep ocean floor.
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
    // The remeshing hysteresis (decision 8): an edge longer than
    // insert_ratio times the target gets a node, a node whose spacing is
    // below remove_ratio times the target goes. The band between the two is
    // what keeps a mesh from oscillating between epochs.
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
