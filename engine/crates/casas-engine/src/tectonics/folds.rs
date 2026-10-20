//! `tectonics/folds.ts`: FOLDS (ADAPTIVE_MESH_PLAN.md phase 5.7), the
//! uplift's multiplier at a convergent margin: a train of anticlines and
//! synclines across the nearest active range, averaged over the width of
//! the cell it stands for. The reasoning is in the TypeScript file.

use crate::core::det_math::{det_cos, det_sin};
use crate::core::domain::Domain;
use crate::elevation::capsule::capsule_weight;
use crate::elevation::elevation_field::{FeatureBuckets, range_half_length, range_perp_radius};

use super::tectonics_tune_params::TECTONICS_TUNING;
use super::terrain_features::FeatureKind;

/// The uplift's multiplier at a world point; `spacing_units` the width of
/// the cell the factor stands for (0 for a point).
pub fn fold_factor_at(
    fb: &FeatureBuckets,
    x: f64,
    y: f64,
    domain: &Domain,
    spacing_units: f64,
    near: &mut Vec<u32>,
) -> f64 {
    fb.near(x, y, near);
    let mut best_weight = 0.0;
    let mut across = 0.0;
    let perp_radius = range_perp_radius(domain);
    let half_length = range_half_length(domain);
    for &b in near.iter() {
        for &fi in &fb.buckets[b as usize] {
            let f = &fb.features[fi as usize];
            if f.kind != FeatureKind::Range || f.thickness <= 0.0 {
                continue;
            }
            let o = domain.delta(x, y, f.x, f.y);
            let w = capsule_weight(o.x, o.y, f.tangent_x, f.tangent_y, half_length, perp_radius);
            if w <= best_weight {
                continue;
            }
            best_weight = w;
            across = -o.x * f.tangent_y + o.y * f.tangent_x;
        }
    }
    if best_weight <= 0.0 {
        return 1.0;
    }
    let pi = std::f64::consts::PI;
    let wavelength_units = (TECTONICS_TUNING.fold_wavelength_km * 1000.0) / domain.metres_per_unit;
    let window = (pi * spacing_units) / wavelength_units;
    let mean = if window > 0.0 {
        det_sin(window) / window
    } else {
        1.0
    };
    1.0 + TECTONICS_TUNING.fold_amplitude * mean * det_cos((2.0 * pi * across) / wavelength_units)
}
