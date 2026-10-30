//! The relative plate velocity at a boundary point split into its normal and
//! tangential parts.

use crate::core::domain::Domain;

use super::plate_motion::{PlateMotion, get_velocity_at};
use super::plate_seeds::PlateSeed;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BoundaryMotionClass {
    Convergent,
    Divergent,
    Transform,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BoundaryConvergence {
    /// The rate the gap closes: positive convergent, negative divergent.
    pub normal: f64,
    pub tangential: f64,
    pub motion_class: BoundaryMotionClass,
}

const TRANSFORM_DOMINANCE_RATIO: f64 = 2.0;

pub fn classify_boundary_motion(
    point: &PlateSeed,
    seed_a: &PlateSeed,
    motion_a: &PlateMotion,
    seed_b: &PlateSeed,
    motion_b: &PlateMotion,
    domain: &Domain,
) -> BoundaryConvergence {
    let va = get_velocity_at(point.x, point.y, motion_a, domain);
    let vb = get_velocity_at(point.x, point.y, motion_b, domain);
    let rel_vx = va.x - vb.x;
    let rel_vy = va.y - vb.y;
    let o = domain.delta(seed_a.x, seed_a.y, seed_b.x, seed_b.y);
    let o = domain.transport(o.x, o.y, seed_b.x, seed_b.y, point.x, point.y);
    let (dir_x, dir_y) = (o.x, o.y);
    // `|| 1`: a zero or NaN length reads as 1.
    let len = (dir_x * dir_x + dir_y * dir_y).sqrt();
    let len = if len == 0.0 || len.is_nan() { 1.0 } else { len };
    let normal_x = dir_x / len;
    let normal_y = dir_y / len;
    let tangent_x = -normal_y;
    let tangent_y = normal_x;
    let normal = -(rel_vx * normal_x + rel_vy * normal_y);
    let tangential = rel_vx * tangent_x + rel_vy * tangent_y;
    let motion_class = if tangential.abs() > normal.abs() * TRANSFORM_DOMINANCE_RATIO {
        BoundaryMotionClass::Transform
    } else if normal > 0.0 {
        BoundaryMotionClass::Convergent
    } else {
        BoundaryMotionClass::Divergent
    };
    BoundaryConvergence {
        normal,
        tangential,
        motion_class,
    }
}
