//! `elevation/erodibilityField.ts`: the smooth K-factor field from the
//! crust's history — hard cratons, soft young sutures, hard old ones,
//! flood-basalt caprock. The TypeScript file explains each story.

use crate::core::domain::Domain;
use crate::core::js;
use crate::core::world_time::world_epoch_ma;
use crate::crust::raft_field::compute_craton_oldness_field;
use crate::crust::raft_types::{Raft, Suture};
use crate::tectonics::terrain_features::TerrainFeature;
use serde::Serialize;

use super::capsule::capsule_weight;
use super::elevation_tune_params::ELEVATION_TUNING;

/// `ErodibilityFieldParams` in TypeScript, which explains each.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErodibilityFieldParams {
    pub craton_hardness: f64,
    pub young_suture_softness: f64,
    pub fresh_suture_ma: f64,
    pub old_suture_hardness: f64,
    pub old_suture_ma: f64,
    pub flood_basalt_hardness: f64,
    pub suture_radius_m: f64,
    pub suture_half_length_m: f64,
    pub flood_radius_min_m: f64,
    pub flood_radius_max_m: f64,
    pub flood_radius_per_thickness_m: f64,
}

pub const DEFAULT_ERODIBILITY_FIELD_PARAMS: ErodibilityFieldParams = ErodibilityFieldParams {
    craton_hardness: 0.45,
    young_suture_softness: 1.5,
    fresh_suture_ma: 80.0,
    old_suture_hardness: 0.8,
    old_suture_ma: 240.0,
    flood_basalt_hardness: 0.55,
    suture_radius_m: 351_000.0,
    suture_half_length_m: ELEVATION_TUNING.range_segment_half_length_m,
    flood_radius_min_m: 156_000.0,
    flood_radius_max_m: 468_000.0,
    flood_radius_per_thickness_m: 15_600.0,
};

/// The K-factor field at `out_width` × `out_height` over `domain`, 1 where
/// no story applies. `current_epoch` is the continuous world epoch.
#[allow(clippy::too_many_arguments)]
pub fn compute_erodibility_field(
    rafts: &[Raft],
    sutures: &[Suture],
    features: &[TerrainFeature],
    current_epoch: f64,
    archean_epochs: f64,
    domain: &Domain,
    out_width: usize,
    out_height: usize,
    params: &ErodibilityFieldParams,
) -> Vec<f32> {
    let mut result = vec![1f32; out_width * out_height];
    let cell_w = domain.width / out_width as f64;
    let cell_h = domain.height / out_height as f64;

    let oldness = compute_craton_oldness_field(
        rafts,
        current_epoch,
        archean_epochs,
        out_width,
        out_height,
        domain,
    );
    for (r, &o) in result.iter_mut().zip(&oldness) {
        if o >= 0.0 {
            *r = (*r as f64 * (1.0 + (params.craton_hardness - 1.0) * o as f64)) as f32;
        }
    }

    // Sutures: the strongest single influence per cell.
    if !sutures.is_empty() {
        let suture_half_length = params.suture_half_length_m / domain.metres_per_unit;
        let suture_radius = params.suture_radius_m / domain.metres_per_unit;
        let now_ma = world_epoch_ma(current_epoch, archean_epochs);
        for py in 0..out_height {
            let wy = (py as f64 + 0.5) * cell_h;
            for px in 0..out_width {
                let wx = (px as f64 + 0.5) * cell_w;
                let mut strongest = 1.0;
                let mut strongest_deviation = 0.0;
                for suture in sutures {
                    let offset = domain.delta(wx, wy, suture.x, suture.y);
                    let weight = capsule_weight(
                        offset.x,
                        offset.y,
                        suture.tangent_x,
                        suture.tangent_y,
                        suture_half_length,
                        suture_radius,
                    );
                    if weight <= 0.0 {
                        continue;
                    }
                    let age_ma = now_ma - world_epoch_ma(suture.epoch, archean_epochs);
                    let old_fraction = js::min(
                        1.0,
                        js::max(
                            0.0,
                            (age_ma - params.fresh_suture_ma)
                                / (params.old_suture_ma - params.fresh_suture_ma),
                        ),
                    );
                    let target = params.young_suture_softness * (1.0 - old_fraction)
                        + params.old_suture_hardness * old_fraction;
                    let factor = 1.0 + (target - 1.0) * weight;
                    let deviation = (factor - 1.0).abs();
                    if deviation > strongest_deviation {
                        strongest_deviation = deviation;
                        strongest = factor;
                    }
                }
                let i = py * out_width + px;
                result[i] = (result[i] as f64 * strongest) as f32;
            }
        }
    }

    // Flood-basalt caprock: the strongest province per cell.
    let floods: Vec<&TerrainFeature> = features.iter().filter(|f| f.plate_b == -2).collect();
    if !floods.is_empty() {
        let flood_radius_min = params.flood_radius_min_m / domain.metres_per_unit;
        let flood_radius_max = params.flood_radius_max_m / domain.metres_per_unit;
        let flood_radius_per_thickness =
            params.flood_radius_per_thickness_m / domain.metres_per_unit;
        for py in 0..out_height {
            let wy = (py as f64 + 0.5) * cell_h;
            for px in 0..out_width {
                let wx = (px as f64 + 0.5) * cell_w;
                let mut strongest_weight = 0.0;
                for flood in &floods {
                    let radius = js::min(
                        flood_radius_max,
                        js::max(
                            flood_radius_min,
                            flood.thickness.abs() * flood_radius_per_thickness,
                        ),
                    );
                    let distance_sq = domain.distance_sq(wx, wy, flood.x, flood.y);
                    if distance_sq >= radius * radius {
                        continue;
                    }
                    let falloff = 1.0 - distance_sq.sqrt() / radius;
                    let weight = falloff * falloff * (3.0 - 2.0 * falloff);
                    if weight > strongest_weight {
                        strongest_weight = weight;
                    }
                }
                if strongest_weight > 0.0 {
                    let i = py * out_width + px;
                    result[i] = (result[i] as f64
                        * (1.0 + (params.flood_basalt_hardness - 1.0) * strongest_weight))
                        as f32;
                }
            }
        }
    }
    result
}
