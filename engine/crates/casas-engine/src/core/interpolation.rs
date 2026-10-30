//! The shared easing.

use super::js;

pub fn clamp01(t: f64) -> f64 {
    // The bits of `t < 0 ? 0 : t > 1 ? 1 : t`: a NaN and a −0 pass through.
    t.clamp(0.0, 1.0)
}

/// The classic 3t² − 2t³ ease of a 0..1 fraction.
pub fn smoothstep(t: f64) -> f64 {
    t * t * (3.0 - 2.0 * t)
}

/// Eased transition across a threshold band: 0 at or below `edge0`, 1 at or
/// above `edge1`.
pub fn smoothstep_between(edge0: f64, edge1: f64, x: f64) -> f64 {
    smoothstep(js::max(0.0, js::min(1.0, (x - edge0) / (edge1 - edge0))))
}

pub fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}
