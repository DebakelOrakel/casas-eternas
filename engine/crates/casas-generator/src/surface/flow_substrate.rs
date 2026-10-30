//! What the hydrology reads of the thing water flows over — elements with
//! a receiver each, the flood's filled height and pop order, a position,
//! an area and the neighbours. Its one instance is the mesh's
//! (mesh/mesh_hydrology.rs). Positions are world units.

use crate::core::domain::Domain;

pub trait FlowSubstrate {
    fn domain(&self) -> &Domain;
    fn count(&self) -> usize;
    fn filled(&self) -> &[f32];
    fn flow_target(&self) -> &[i32];
    fn pop_order(&self) -> &[i32];
    fn popped_count(&self) -> usize;
    /// Where an element is drawn, and where its climate is sampled.
    fn x(&self, c: usize) -> f64;
    fn y(&self, c: usize) -> f64;
    fn px(&self, c: usize) -> f64;
    fn py(&self, c: usize) -> f64;
    /// The element's area in domain units².
    fn area(&self, c: usize) -> f64;
    /// Distance from a to b in domain units, across the seam.
    fn step(&self, a: usize, b: usize) -> f64;
    /// Neighbours that share a facet, into `out`.
    fn facet_neighbours(&self, c: usize, out: &mut Vec<u32>);
    /// Every neighbour, into `out`.
    fn rim_neighbours(&self, c: usize, out: &mut Vec<u32>);
}
