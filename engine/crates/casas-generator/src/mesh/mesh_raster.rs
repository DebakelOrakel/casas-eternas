//! Node fields sampled on a regular grid, linearly within each triangle
//! (cell px holds the field at world x = px), a field one part of the nodes
//! holds rasterised without a blend with the other part, and two coarse
//! rasters read at the nodes. `client/src/generator/mesh/meshRaster.ts`
//! explains the convention.

use crate::core::domain::DomainGrid;
use crate::core::js;

use super::periodic_delaunay::PeriodicTriangulation;

/// The field at every pixel of a `width` × `height` raster over the domain.
pub fn rasterise_node_field<T: Copy + Into<f64>>(
    mesh: &mut PeriodicTriangulation,
    field: &[T],
    width: usize,
    height: usize,
) -> Vec<f32> {
    let mut result = vec![0f32; width * height];
    let sx = mesh.domain.width / width as f64;
    let sy = mesh.domain.height / height as f64;
    let mut hint = mesh.last_tri as usize;
    let mut row_start = hint;
    for py in 0..height {
        let y = py as f64 * sy;
        hint = row_start;
        for px in 0..width {
            let x = px as f64 * sx;
            let t = mesh.locate(x, y, Some(hint));
            hint = t;
            if px == 0 {
                row_start = t;
            }
            let b = mesh.barycentric(t, x, y);
            let [a, bb, c] =
                [mesh.tris[3 * t], mesh.tris[3 * t + 1], mesh.tris[3 * t + 2]].map(|v| v as usize);
            result[py * width + px] =
                (b[0] * field[a].into() + b[1] * field[bb].into() + b[2] * field[c].into()) as f32;
        }
    }
    result
}

/// Every pixel's triangle and its first two barycentric weights.
pub struct TriangleRaster {
    pub width: usize,
    pub height: usize,
    pub tri: Vec<i32>,
    pub w0: Vec<f32>,
    pub w1: Vec<f32>,
}

pub fn triangle_raster(
    mesh: &mut PeriodicTriangulation,
    width: usize,
    height: usize,
) -> TriangleRaster {
    let n = width * height;
    let mut tri = vec![0i32; n];
    let mut w0 = vec![0f32; n];
    let mut w1 = vec![0f32; n];
    let sx = mesh.domain.width / width as f64;
    let sy = mesh.domain.height / height as f64;
    let mut hint = mesh.last_tri as usize;
    let mut row_start = hint;
    for py in 0..height {
        let y = py as f64 * sy;
        hint = row_start;
        for px in 0..width {
            let x = px as f64 * sx;
            let t = mesh.locate(x, y, Some(hint));
            hint = t;
            if px == 0 {
                row_start = t;
            }
            let b = mesh.barycentric(t, x, y);
            let p = py * width + px;
            tri[p] = t as i32;
            w0[p] = b[0] as f32;
            w1[p] = b[1] as f32;
        }
    }
    TriangleRaster {
        width,
        height,
        tri,
        w0,
        w1,
    }
}

/// A field one part of the nodes (`node_in`) holds, rasterised over the
/// pixels `pixel_in` admits; `nearest` takes the heaviest admitted corner
/// (an id field). `plan`: the pixels' triangles of this mesh and size.
#[allow(clippy::too_many_arguments)]
pub fn rasterise_node_part<T: Copy + Into<f64>>(
    mesh: &mut PeriodicTriangulation,
    field: &[T],
    node_in: &[u8],
    pixel_in: Option<&[u8]>,
    outside: f64,
    width: usize,
    height: usize,
    nearest: bool,
    plan: Option<&TriangleRaster>,
) -> Vec<f32> {
    let made;
    let where_ = match plan {
        Some(p) if p.width == width && p.height == height => p,
        _ => {
            made = triangle_raster(mesh, width, height);
            &made
        }
    };
    let mut result = vec![0f32; width * height];
    let sx = mesh.domain.width / width as f64;
    let sy = mesh.domain.height / height as f64;
    let mut star: Vec<u32> = Vec::new();
    for p in 0..width * height {
        if let Some(pin) = pixel_in
            && pin[p] == 0
        {
            result[p] = outside as f32;
            continue;
        }
        let t = where_.tri[p] as usize;
        let w0 = where_.w0[p] as f64;
        let w1 = where_.w1[p] as f64;
        let w = [w0, w1, 1.0 - w0 - w1];
        let (mut sum, mut weight) = (0.0, 0.0);
        let mut best: i64 = -1;
        let mut best_w = -1.0;
        for k in 0..3 {
            let v = mesh.tris[3 * t + k] as usize;
            if node_in[v] == 0 {
                continue;
            }
            sum += w[k] * field[v].into();
            weight += w[k];
            if w[k] > best_w {
                best_w = w[k];
                best = v as i64;
            }
        }
        if best >= 0 {
            let fb: f64 = field[best as usize].into();
            result[p] = if nearest {
                fb
            } else if weight > 0.0 {
                sum / weight
            } else {
                fb
            } as f32;
            continue;
        }
        let x = (p % width) as f64 * sx;
        let y = (p / width) as f64 * sy;
        let mut near: i64 = -1;
        let mut near_sq = f64::INFINITY;
        for k in 0..3 {
            mesh.neighbours(mesh.tris[3 * t + k] as usize, &mut star);
            for &v in &star {
                let v = v as usize;
                if node_in[v] == 0 {
                    continue;
                }
                let d = mesh.domain.delta(mesh.vx[v], mesh.vy[v], x, y);
                let dd = d.x * d.x + d.y * d.y;
                if dd < near_sq {
                    near_sq = dd;
                    near = v as i64;
                }
            }
        }
        result[p] = if near >= 0 {
            field[near as usize].into()
        } else {
            outside
        } as f32;
    }
    result
}

/// A coarse raster's value at each node: the nearest cell.
pub fn nearest_cell_at_nodes(
    field: &[f32],
    res_x: usize,
    res_y: usize,
    mesh: &PeriodicTriangulation,
) -> Vec<f32> {
    let (width, height) = (mesh.domain.width, mesh.domain.height);
    (0..mesh.vertex_slots())
        .map(|v| {
            if mesh.v_alive[v] == 0 {
                return 0.0;
            }
            let cx = js::min(
                (res_x - 1) as f64,
                js::max(0.0, ((mesh.vx[v] / width) * res_x as f64).floor()),
            ) as usize;
            let cy = js::min(
                (res_y - 1) as f64,
                js::max(0.0, ((mesh.vy[v] / height) * res_y as f64).floor()),
            ) as usize;
            field[cy * res_x + cx]
        })
        .collect()
}

/// A coarse field that marks the sea below 0 at each node: bilinear over
/// its non-negative corners, renormalised; −1 with none.
pub fn land_bilinear_at_nodes(
    field: &[f32],
    grid: &DomainGrid,
    mesh: &PeriodicTriangulation,
) -> Vec<f32> {
    let (width, height) = (mesh.domain.width, mesh.domain.height);
    (0..mesh.vertex_slots())
        .map(|v| {
            if mesh.v_alive[v] == 0 {
                return -1.0;
            }
            let gx = (mesh.vx[v] / width) * grid.res_x as f64 - 0.5;
            let gy = (mesh.vy[v] / height) * grid.res_y as f64 - 0.5;
            let x0 = gx.floor() as i64;
            let y0 = gy.floor() as i64;
            let fx = gx - x0 as f64;
            let fy = gy - y0 as f64;
            let (mut sum, mut weight) = (0.0, 0.0);
            let mut add = |i: usize, w: f64| {
                let f = field[i] as f64;
                if f < 0.0 {
                    return;
                }
                sum += f * w;
                weight += w;
            };
            add(grid.index(x0, y0), (1.0 - fx) * (1.0 - fy));
            add(grid.index(x0 + 1, y0), fx * (1.0 - fy));
            add(grid.index(x0, y0 + 1), (1.0 - fx) * fy);
            add(grid.index(x0 + 1, y0 + 1), fx * fy);
            if weight > 0.0 {
                (sum / weight) as f32
            } else {
                -1.0
            }
        })
        .collect()
}
