//! `mesh/meshSampler.ts`. This port holds the hint grid the field mesh
//! locates through; the terrain mesh's sampler comes with its readers.

use super::periodic_delaunay::PeriodicTriangulation;

/// A hint grid of cols × rows cells of sx × sy from (x0, y0), each the
/// triangle under its corner, found by a scanline walk.
#[allow(clippy::too_many_arguments)]
pub fn hint_grid(
    mesh: &mut PeriodicTriangulation,
    x0: f64,
    y0: f64,
    cols: usize,
    rows: usize,
    sx: f64,
    sy: f64,
) -> Vec<u32> {
    let mut hints = vec![0u32; cols * rows];
    let mut hint = mesh.last_tri as usize;
    let mut row_start = hint;
    for r in 0..rows {
        hint = row_start;
        for c in 0..cols {
            let x = mesh.domain.wrap_x(x0 + c as f64 * sx);
            let y = mesh.domain.wrap_y(y0 + r as f64 * sy);
            hint = mesh.locate(x, y, Some(hint));
            if c == 0 {
                row_start = hint;
            }
            hints[r * cols + c] = hint as u32;
        }
    }
    hints
}
