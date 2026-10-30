//! `mantle/mantleTuneParams.ts`. The reasoning behind each value is in the
//! TypeScript port (`client/src/generator/mantle/mantleTuneParams.ts`, git
//! history).

use serde::Serialize;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MantleTuning {
    pub insulation_rate: f64,
    pub ocean_cool_rate: f64,
    pub diffusion_passes: f64,
    pub diffusion_weight: f64,
    pub decay_keep: f64,
    pub clamp: f64,
    pub flow_speed_scale: f64,
}

pub const MANTLE_TUNING: MantleTuning = MantleTuning {
    insulation_rate: 0.05,
    ocean_cool_rate: 0.025,
    diffusion_passes: 1.0,
    diffusion_weight: 0.5,
    decay_keep: 0.955,
    clamp: 2.5,
    flow_speed_scale: 110.0,
};
