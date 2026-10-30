//! The fixed grid of sample points boundary detection runs against every
//! epoch; on the sphere a row keeps the columns its length can hold.

use crate::core::domain::Domain;
use crate::core::js;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LatticePoint {
    pub x: f64,
    pub y: f64,
}

pub fn generate_detection_lattice(
    domain: &Domain,
    resolution_x: usize,
    resolution_y: usize,
) -> Vec<LatticePoint> {
    let grid = domain.grid(resolution_x, resolution_y);
    let mut points = Vec::new();
    for row in 0..resolution_y {
        let cols = js::max(
            1.0,
            js::round(resolution_x as f64 * grid.row_scale(row as f64)),
        ) as usize;
        for col in 0..cols {
            points.push(LatticePoint {
                x: ((col as f64 + 0.5) / cols as f64) * domain.width,
                y: ((row as f64 + 0.5) / resolution_y as f64) * domain.height,
            });
        }
    }
    points
}
