//! THE CAPSULE FALLOFF, the one footprint a terrain feature has: an
//! oriented segment, a smoothstep across it, rounded caps.

pub fn capsule_weight(
    off_x: f64,
    off_y: f64,
    tangent_x: f64,
    tangent_y: f64,
    half_length: f64,
    perp_radius: f64,
) -> f64 {
    let along = off_x * tangent_x + off_y * tangent_y;
    let across = -off_x * tangent_y + off_y * tangent_x;
    let clamped = if along < -half_length {
        -half_length
    } else if along > half_length {
        half_length
    } else {
        along
    };
    let overshoot = along - clamped;
    let distance = (overshoot * overshoot + across * across).sqrt();
    if distance >= perp_radius {
        return 0.0;
    }
    let falloff = 1.0 - distance / perp_radius;
    falloff * falloff * (3.0 - 2.0 * falloff)
}
