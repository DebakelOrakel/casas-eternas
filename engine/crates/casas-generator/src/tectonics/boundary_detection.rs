//! The lattice points whose two nearest plate seeds are about equally
//! near.

use crate::core::domain::Domain;
use crate::core::js;

use super::boundary_lattice::LatticePoint;
use super::plate_seeds::PlateSeed;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BoundaryPoint {
    pub lattice_index: u32,
    pub x: f64,
    pub y: f64,
    pub plate_a: i32,
    pub plate_b: i32,
}

const BOUNDARY_GAP_THRESHOLD: f64 = 0.15;

pub fn detect_boundaries(
    lattice: &[LatticePoint],
    seeds: &[PlateSeed],
    domain: &Domain,
) -> Vec<BoundaryPoint> {
    let mut boundaries = Vec::new();
    for (i, point) in lattice.iter().enumerate() {
        let mut nearest_index = -1i32;
        let mut nearest_dist_sq = f64::INFINITY;
        let mut second_index = -1i32;
        let mut second_dist_sq = f64::INFINITY;
        for (p, seed) in seeds.iter().enumerate() {
            let dist_sq = domain.distance_sq(point.x, point.y, seed.x, seed.y);
            if dist_sq < nearest_dist_sq {
                second_dist_sq = nearest_dist_sq;
                second_index = nearest_index;
                nearest_dist_sq = dist_sq;
                nearest_index = p as i32;
            } else if dist_sq < second_dist_sq {
                second_dist_sq = dist_sq;
                second_index = p as i32;
            }
        }
        let nearest_dist = nearest_dist_sq.sqrt();
        let second_dist = second_dist_sq.sqrt();
        let gap = (second_dist - nearest_dist) / js::max(nearest_dist, 1e-6);
        if gap < BOUNDARY_GAP_THRESHOLD {
            boundaries.push(BoundaryPoint {
                lattice_index: i as u32,
                x: point.x,
                y: point.y,
                plate_a: nearest_index,
                plate_b: second_index,
            });
        }
    }
    boundaries
}
