//! `elevation/upliftField.ts`: U(x), the tectonic uplift-rate field the
//! erosion solver is forced by — the features' capsules weighted by their
//! boundary's shortening rate, as mm/yr of crustal thickening. The
//! TypeScript file explains the scale and its history.

use crate::core::domain::Domain;
use crate::core::js;
use crate::tectonics::tectonics_tune_params::TECTONICS_TUNING;
use crate::tectonics::terrain_features::{FeatureKind, TerrainFeature};

use super::capsule::capsule_weight;
use super::elevation_field::{
    build_feature_buckets, range_half_length, range_perp_radius, trench_half_length,
    trench_perp_radius,
};
use super::elevation_tune_params::ELEVATION_TUNING;

/// U at `out_width` × `out_height` over features in world coordinates on
/// `domain`, mm/yr; all zero when no feature shortens.
pub fn compute_uplift_field(
    features: &[TerrainFeature],
    domain: &Domain,
    out_width: usize,
    out_height: usize,
) -> Vec<f32> {
    let mut result = vec![0f32; out_width * out_height];
    if features.is_empty() {
        return result;
    }
    let buckets = build_feature_buckets(features, domain);
    // mm/yr of thickening per km/Myr of shortening: Hc / W.
    let thickening_per_shortening =
        TECTONICS_TUNING.orogen_crust_m / ELEVATION_TUNING.range_perp_radius_m;
    let scale_x = domain.width / out_width as f64;
    let scale_y = domain.height / out_height as f64;
    let range_perp = range_perp_radius(domain);
    let trench_perp = trench_perp_radius(domain);
    let range_half = range_half_length(domain);
    let trench_half = trench_half_length(domain);
    let mut near = Vec::new();
    for py in 0..out_height {
        let wy = py as f64 * scale_y;
        for px in 0..out_width {
            let wx = px as f64 * scale_x;
            buckets.near(wx, wy, &mut near);
            let mut uplift_sum = 0.0;
            let mut weight_sum = 0.0;
            for &b in &near {
                for &fi in &buckets.buckets[b as usize] {
                    let feature = &features[fi as usize];
                    // A hotspot's or a flood basalt's feature has no boundary.
                    if feature.plate_b < 0 {
                        continue;
                    }
                    let is_trench = feature.kind == FeatureKind::Trench;
                    let half_length = if is_trench { trench_half } else { range_half };
                    let perp_radius = if is_trench { trench_perp } else { range_perp };
                    let offset = domain.delta(wx, wy, feature.x, feature.y);
                    let weight = capsule_weight(
                        offset.x,
                        offset.y,
                        feature.tangent_x,
                        feature.tangent_y,
                        half_length,
                        perp_radius,
                    );
                    if weight <= 0.0 {
                        continue;
                    }
                    uplift_sum += feature.shortening_km_per_myr.unwrap_or(0.0) * weight;
                    weight_sum += weight;
                }
            }
            result[py * out_width + px] = if weight_sum > 0.0 {
                ((uplift_sum / js::max(1.0, weight_sum)) * thickening_per_shortening) as f32
            } else {
                0.0
            };
        }
    }
    result
}
