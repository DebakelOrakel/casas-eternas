//! `mesh/meshSampler.ts`: sampling the mesh at a point — a hint grid of
//! triangles (a second one over a dense region), the triangulation's walk
//! from the hint, heights and fields linear in the triangle, the nearest
//! corner, and vertex normals in metres. The TypeScript file explains the
//! frames the normals are carried in.

use crate::core::det_math::det_hypot3;
use crate::core::js;
use crate::elevation::elevation_scale::ELEVATION_METERS;

use super::periodic_delaunay::PeriodicTriangulation;

/// Hint grid resolution: about one cell per 4 world cells.
const HINT_CELLS_PER_UNIT: f64 = 0.25;
const HINT_NODES_PER_CELL: f64 = 4.0;

/// A region the mesh is dense in, and how many nodes it holds.
#[derive(Clone, Copy, Debug)]
pub struct DenseRegion {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub nodes: f64,
}

struct FineHints {
    hints: Vec<u32>,
    cols: usize,
    rows: usize,
    s: f64,
    region: DenseRegion,
}

/// A mesh with its heights, read at points. Owns the mesh: its walk moves.
pub struct MeshSampler {
    pub mesh: PeriodicTriangulation,
    pub z: Vec<f32>,
    cols: usize,
    rows: usize,
    sx: f64,
    sy: f64,
    hints: Vec<u32>,
    fine: Option<FineHints>,
    normals: Vec<f32>,
    last: (f64, f64, usize),
}

pub fn create_mesh_sampler(
    mut mesh: PeriodicTriangulation,
    z: &[f32],
    dense: Option<DenseRegion>,
) -> MeshSampler {
    let domain = mesh.domain.clone();
    let cols = js::max(4.0, js::round(domain.width * HINT_CELLS_PER_UNIT)) as usize;
    let rows = js::max(4.0, js::round(domain.height * HINT_CELLS_PER_UNIT)) as usize;
    let sx = domain.width / cols as f64;
    let sy = domain.height / rows as f64;
    let hints = hint_grid(&mut mesh, 0.0, 0.0, cols, rows, sx, sy);
    let fine = dense.filter(|d| d.nodes > 0.0).map(|d| {
        let s = js::min(
            sx,
            ((d.width * d.height * HINT_NODES_PER_CELL) / d.nodes).sqrt(),
        );
        let fine_cols = js::max(1.0, (d.width / s).ceil()) as usize;
        let fine_rows = js::max(1.0, (d.height / s).ceil()) as usize;
        FineHints {
            hints: hint_grid(&mut mesh, d.x, d.y, fine_cols, fine_rows, s, s),
            cols: fine_cols,
            rows: fine_rows,
            s,
            region: d,
        }
    });
    let unit_m = domain.metres_per_unit;
    let mut normals = vec![0f32; mesh.vertex_slots() * 3];
    for t in 0..mesh.tri_slots() {
        if mesh.t_alive[t] == 0 {
            continue;
        }
        let f = mesh.frame(t);
        let a = mesh.tris[3 * t] as usize;
        let b = mesh.tris[3 * t + 1] as usize;
        let c = mesh.tris[3 * t + 2] as usize;
        let abx = (f[2] - f[0]) * unit_m;
        let abz = (f[3] - f[1]) * unit_m;
        let aby = (z[b] as f64 - z[a] as f64) * ELEVATION_METERS;
        let acx = (f[4] - f[0]) * unit_m;
        let acz = (f[5] - f[1]) * unit_m;
        let acy = (z[c] as f64 - z[a] as f64) * ELEVATION_METERS;
        let mut nx = aby * acz - abz * acy;
        let mut ny = abz * acx - abx * acz;
        let mut nz = abx * acy - aby * acx;
        if ny < 0.0 {
            nx = -nx;
            ny = -ny;
            nz = -nz;
        }
        for v in [a, b, c] {
            let carried = domain.transport(nx, nz, mesh.vx[a], mesh.vy[a], mesh.vx[v], mesh.vy[v]);
            normals[3 * v] = (normals[3 * v] as f64 + carried.x) as f32;
            normals[3 * v + 1] = (normals[3 * v + 1] as f64 + ny) as f32;
            normals[3 * v + 2] = (normals[3 * v + 2] as f64 + carried.y) as f32;
        }
    }
    for v in 0..mesh.vertex_slots() {
        let l = det_hypot3(
            normals[3 * v] as f64,
            normals[3 * v + 1] as f64,
            normals[3 * v + 2] as f64,
        );
        if l > 0.0 {
            for k in 0..3 {
                normals[3 * v + k] = (normals[3 * v + k] as f64 / l) as f32;
            }
        } else {
            normals[3 * v + 1] = 1.0;
        }
    }
    MeshSampler {
        z: z.to_vec(),
        mesh,
        cols,
        rows,
        sx,
        sy,
        hints,
        fine,
        normals,
        last: (f64::NAN, f64::NAN, 0),
    }
}

impl MeshSampler {
    fn hint_at(&self, x: f64, y: f64) -> usize {
        let domain = &self.mesh.domain;
        if let Some(f) = &self.fine {
            let c = (domain.wrap_x(x - f.region.x) / f.s).floor();
            let r = (domain.wrap_y(y - f.region.y) / f.s).floor();
            if c < f.cols as f64 && r < f.rows as f64 {
                return f.hints[r as usize * f.cols + c as usize] as usize;
            }
        }
        let c = js::min(
            (self.cols - 1) as f64,
            js::max(0.0, (domain.wrap_x(x) / self.sx).floor()),
        ) as usize;
        let r = js::min(
            (self.rows - 1) as f64,
            js::max(0.0, (domain.wrap_y(y) / self.sy).floor()),
        ) as usize;
        self.hints[r * self.cols + c] as usize
    }

    /// The triangle under (x, y); the same point asked twice in a row is
    /// located once.
    pub fn triangle_at(&mut self, x: f64, y: f64) -> usize {
        if x == self.last.0 && y == self.last.1 {
            return self.last.2;
        }
        let hint = self.hint_at(x, y);
        let t = self.mesh.locate(x, y, Some(hint));
        self.last = (x, y, t);
        t
    }

    /// Any per-vertex field interpolated at (x, y).
    pub fn sample_at<T: Copy + Into<f64>>(&mut self, field: &[T], x: f64, y: f64) -> f64 {
        let t = self.triangle_at(x, y);
        let b = self.mesh.barycentric(t, x, y);
        let m = &self.mesh;
        b[0] * field[m.tris[3 * t] as usize].into()
            + b[1] * field[m.tris[3 * t + 1] as usize].into()
            + b[2] * field[m.tris[3 * t + 2] as usize].into()
    }

    /// The height field interpolated at (x, y), elevation units.
    pub fn height_at(&mut self, x: f64, y: f64) -> f64 {
        let t = self.triangle_at(x, y);
        let b = self.mesh.barycentric(t, x, y);
        let m = &self.mesh;
        let z = &self.z;
        b[0] * z[m.tris[3 * t] as usize] as f64
            + b[1] * z[m.tris[3 * t + 1] as usize] as f64
            + b[2] * z[m.tris[3 * t + 2] as usize] as f64
    }

    /// The corner of the triangle under (x, y) nearest the point.
    pub fn nearest_node_at(&mut self, x: f64, y: f64) -> usize {
        let t = self.triangle_at(x, y);
        let b = self.mesh.barycentric(t, x, y);
        let mut corner = 0;
        if b[1] > b[corner] {
            corner = 1;
        }
        if b[2] > b[corner] {
            corner = 2;
        }
        self.mesh.tris[3 * t + corner] as usize
    }

    /// The unit normal at (x, y), metre-true, (nx, ny, nz) with y up.
    pub fn normal_at(&mut self, x: f64, y: f64) -> [f64; 3] {
        let t = self.triangle_at(x, y);
        let b = self.mesh.barycentric(t, x, y);
        let m = &self.mesh;
        let (mut nx, mut ny, mut nz) = (0.0, 0.0, 0.0);
        for k in 0..3 {
            let v = m.tris[3 * t + k] as usize;
            let c = m.domain.transport(
                self.normals[3 * v] as f64,
                self.normals[3 * v + 2] as f64,
                m.vx[v],
                m.vy[v],
                x,
                y,
            );
            nx += b[k] * c.x;
            ny += b[k] * self.normals[3 * v + 1] as f64;
            nz += b[k] * c.y;
        }
        let l = det_hypot3(nx, ny, nz);
        let l = if l == 0.0 || l.is_nan() { 1.0 } else { l };
        [nx / l, ny / l, nz / l]
    }
}

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
