//! THE SHELF'S FILL (docs/decisions/shelf-and-sea.md): a continental
//! shelf is a surface of sediment, built out from the coast by what the
//! land sheds and kept near the waves' base. In the history nothing did
//! that: the plate's flexure under the ranges and beside the ice takes a
//! shelf some 50 m down in an epoch, and the marine deposits stay at the
//! river mouths. Measured 2026-10-27 (12 worlds at the real size, 40
//! epochs): right after the hand-over the shelf (0–200 m) is 5.7 % of the
//! ocean, after five epochs 2.2 %; Earth's is 7.3 %.
//!
//! The fill: the sediment the epoch carries out of the erosion's active
//! band and off the coast (its export, 20 to 100 times what the shelf
//! takes) is laid on the shelf instead, from the coast outward, up to
//! `shelf_fill_depth_m` below the sea and no farther out than
//! `shelf_fill_reach_km` along the sea floor. It builds the shelf out over
//! the upper slope, as a delta's front does, down to a baseline of
//! `shelf_fill_slope_m`: the profile's slope below that and the deep sea
//! stay as they are, and a basin inland below the sea is no shelf. The fill
//! loads the plate as any deposit, so a part of it sinks again by the next
//! epoch; 20 m keeps the shelf at some 140–170 m at the median, 40 to
//! 120 km out. What the shelf cannot take stays exported.

use crate::core::min_heap::MinHeap;
use crate::elevation::elevation_scale::ELEVATION_METERS;
use crate::mesh::periodic_delaunay::PeriodicTriangulation;

use super::surface_tune_params::SURFACE_TUNING;

pub struct ShelfFill {
    /// The fill at each slot, metres.
    pub fill_m: Vec<f32>,
    /// The volume laid down, m³; at most the budget.
    pub filled_m3: f64,
}

/// `z` and `baseline` in elevation units against the sea; `areas` in
/// domain units², `cell_m2` the m² of one; `budget_m3` the sediment to lay.
pub fn fill_shelf(
    mesh: &PeriodicTriangulation,
    z: &[f32],
    baseline: &[f32],
    areas: &[f32],
    cell_m2: f64,
    budget_m3: f64,
) -> ShelfFill {
    let slots = z.len();
    let depth_floor = -SURFACE_TUNING.shelf_fill_depth_m / ELEVATION_METERS;
    let top = -SURFACE_TUNING.shelf_fill_slope_m / ELEVATION_METERS;
    let reach = SURFACE_TUNING.shelf_fill_reach_km * 1000.0 / mesh.domain.metres_per_unit;
    let shelf = |v: usize| {
        let b = baseline[v] as f64;
        mesh.v_alive[v] != 0 && z[v] <= 0.0 && (top..=0.0).contains(&b)
    };
    let mut fill_m = vec![0f32; slots];
    // From the coast outward over the shelf: the nearest first.
    let mut dist = vec![f64::INFINITY; slots];
    let mut heap = MinHeap::new(1 << 12);
    for v in 0..slots {
        if mesh.v_alive[v] != 0 && z[v] > 0.0 {
            dist[v] = 0.0;
            heap.push(0.0, v as i32);
        }
    }
    let mut left = budget_m3;
    let mut filled_m3 = 0.0;
    while !heap.is_empty() && left > 0.0 {
        heap.pop();
        let v = heap.popped_index as usize;
        let d = heap.popped_key;
        if d > dist[v] {
            continue;
        }
        if shelf(v) && (z[v] as f64) < depth_floor {
            let area_m2 = areas[v] as f64 * cell_m2;
            let room = (depth_floor - z[v] as f64) * ELEVATION_METERS * area_m2;
            let laid = room.min(left);
            fill_m[v] = (laid / area_m2) as f32;
            left -= laid;
            filled_m3 += laid;
        }
        let start = mesh.v_edge[v] as usize;
        let mut e = start;
        loop {
            let u = mesh.to(e);
            let nd = d + mesh.edge_length(e);
            if shelf(u) && nd <= reach && nd < dist[u] {
                dist[u] = nd;
                heap.push(nd, u as i32);
            }
            e = mesh.rotate_ccw(e);
            if e == start {
                break;
            }
        }
    }
    ShelfFill { fill_m, filled_m3 }
}
