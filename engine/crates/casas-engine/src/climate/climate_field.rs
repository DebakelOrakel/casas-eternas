//! `climate/climateField.ts`: the climate's chart size, the calendar and
//! the latitude a cell's row position reads. The TypeScript file explains
//! the calendar's direction and the belts' shift.

use crate::core::det_math::det_cos;
use crate::core::js;

use super::climate_tune_params::CLIMATE_TUNING;

pub const CLIMATE_RES_X: usize = 256;
pub const CLIMATE_RES_Y: usize = 128;

/// The top hemisphere's warmest month.
pub const TOP_SUMMER_MONTH: f64 = 0.0;

/// 1 in the top hemisphere's warmest month, −1 six months later.
pub fn top_summer_cos(month: f64) -> f64 {
    det_cos(((month - TOP_SUMMER_MONTH) / 12.0) * 2.0 * std::f64::consts::PI)
}

/// Whether a month lies in the top hemisphere's summer half.
pub fn in_top_summer_half(month: f64) -> bool {
    (((month - TOP_SUMMER_MONTH + 3.0) % 12.0) + 12.0) % 12.0 < 6.0
}

/// A row position y / height (0..1) shifted by `equator_offset`, wrapped.
pub fn shifted_norm(y_norm: f64, equator_offset: f64) -> f64 {
    let y = y_norm - equator_offset;
    y - y.floor()
}

/// The shifted row position of a row of a `res_y` grid.
pub fn shifted_y_norm(grid_y: f64, res_y: f64, equator_offset: f64) -> f64 {
    shifted_norm((grid_y + 0.5) / res_y, equator_offset)
}

/// Latitude 0..1 (0 the equator, 1 a pole) of a shifted row position.
pub fn latitude_of_norm(shifted: f64) -> f64 {
    (shifted - 0.5).abs() * 2.0
}

/// Where a row sits in the zonal bands when they follow the season (see the
/// TypeScript file); `sphere` ends the shift at the pole.
pub fn belt_y_norm(true_norm: f64, belt_shift: f64, sphere: bool) -> f64 {
    if belt_shift == 0.0 {
        return true_norm;
    }
    let t = &CLIMATE_TUNING;
    let lat = (true_norm - 0.5).abs() * 2.0;
    let mut reach = t.precip_belt_shift_floor
        + (1.0 - t.precip_belt_shift_floor)
            * js::max(0.0, 1.0 - (lat * 90.0) / t.precip_belt_taper_deg);
    if sphere {
        reach *= js::min(1.0, ((1.0 - lat) * 90.0) / t.belt_shift_pole_taper_deg);
    }
    let shifted = true_norm + belt_shift * reach;
    shifted - shifted.floor()
}
