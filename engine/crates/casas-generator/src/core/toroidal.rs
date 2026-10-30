//! The torus domain's own arithmetic. Only the domain reads it (DEC-0035,
//! fork 1).

use super::det_math::{det_cos, det_sin};
use super::field::wrap_value;
use super::js;

/// The shortest signed offset from b to a on a line of the given period.
#[inline]
pub fn wrapped_delta(a: f64, b: f64, period: f64) -> f64 {
    let delta = a - b;
    delta - period * js::round(delta / period)
}

/// (x, y) turned by `angle` about (cx, cy) in the centre's unwrapped frame,
/// wrapped back.
#[allow(clippy::too_many_arguments)]
pub fn rotate_around_center(
    x: f64,
    y: f64,
    cx: f64,
    cy: f64,
    angle: f64,
    width: f64,
    height: f64,
) -> (f64, f64) {
    let rx = wrapped_delta(x, cx, width);
    let ry = wrapped_delta(y, cy, height);
    let cos = det_cos(angle);
    let sin = det_sin(angle);
    let rotated_x = rx * cos - ry * sin;
    let rotated_y = rx * sin + ry * cos;
    (
        wrap_value(cx + rotated_x, width),
        wrap_value(cy + rotated_y, height),
    )
}
