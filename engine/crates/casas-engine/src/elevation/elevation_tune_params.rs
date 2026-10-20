//! `elevation/elevationTuneParams.ts`. The reasoning behind each value is
//! in the TypeScript file.

use super::elevation_scale::ELEVATION_METERS;

pub struct ElevationTuning {
    pub range_perp_radius_m: f64,
    pub range_segment_half_length_m: f64,
    pub trench_perp_radius_m: f64,
    pub trench_segment_half_length_m: f64,
    pub thickness_to_elevation_scale: f64,
    pub ridge_relative_strength: f64,
    pub gdh1_young_max_age: f64,
    pub gdh1_young_coeff: f64,
    pub gdh1_old_coeff: f64,
    pub gdh1_old_decay: f64,
    pub plain_detail_max: f64,
    pub plain_detail_height_fraction: f64,
    pub mountain_redistribution_gamma: f64,
    pub hypsometry_range_m: f64,
    pub hypsometry_t_in: f64,
    pub hypsometry_t_full: f64,
    pub warp_amplitude_m: f64,
    pub axis_salt_x: f64,
    pub axis_salt_y: f64,
    pub axis_salt_z: f64,
    pub dynamic_topography_per_unit: f64,
}

pub const ELEVATION_TUNING: ElevationTuning = ElevationTuning {
    range_perp_radius_m: 234_000.0,
    range_segment_half_length_m: 273_000.0,
    trench_perp_radius_m: 117_000.0,
    trench_segment_half_length_m: 195_000.0,
    thickness_to_elevation_scale: 0.035,
    ridge_relative_strength: 0.5,
    gdh1_young_max_age: 20.0,
    gdh1_young_coeff: 365.0 / (5651.0 - 2600.0),
    gdh1_old_coeff: 2473.0 / (5651.0 - 2600.0),
    gdh1_old_decay: 0.0278,
    plain_detail_max: 20.0 / ELEVATION_METERS,
    plain_detail_height_fraction: 0.5,
    mountain_redistribution_gamma: 2.5,
    hypsometry_range_m: 320.0,
    hypsometry_t_in: 0.5,
    hypsometry_t_full: 0.85,
    warp_amplitude_m: 202_800.0,
    axis_salt_x: 0.0,
    axis_salt_y: 97.0,
    axis_salt_z: 193.0,
    dynamic_topography_per_unit: 400.0 / ELEVATION_METERS,
};
