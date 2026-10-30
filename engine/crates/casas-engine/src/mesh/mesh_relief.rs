//! Slope and curvature of a height field at a node, from its star. Slope
//! is the steepest descent over the neighbours (rise over run); curvature
//! the mean second difference along the incident edges, 2·Σ(z_j − z_i)/ℓ²
//! over the degree.

use super::periodic_delaunay::PeriodicTriangulation;

/// (slope in m/m, curvature in 1/m).
pub fn relief_at(
    mesh: &PeriodicTriangulation,
    z: &[f32],
    v: usize,
    units_to_m: f64,
    z_to_m: f64,
) -> (f64, f64) {
    let zi = z[v] as f64 * z_to_m;
    let start = mesh.v_edge[v] as usize;
    let mut e = start;
    let mut slope = 0.0;
    let mut lapl = 0.0;
    let mut n = 0;
    loop {
        let u = mesh.to(e);
        let l = mesh.edge_length(e) * units_to_m;
        let dz = z[u] as f64 * z_to_m - zi;
        let s = dz.abs() / l;
        if s > slope {
            slope = s;
        }
        lapl += dz / (l * l);
        n += 1;
        e = mesh.rotate_ccw(e);
        if e == start {
            break;
        }
    }
    (slope, if n > 0 { (2.0 * lapl) / n as f64 } else { 0.0 })
}
