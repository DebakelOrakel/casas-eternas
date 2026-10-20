//! `fields/fieldMesh.ts`: THE FIELD MESH (DEC-0036,
//! docs/decisions/fields-on-meshes.md): a uniform mesh over a domain at one
//! spacing in metres for the coarse global fields, its geometry in metres
//! (centres, areas, walls, offsets, turns, gradient weights), its sampler,
//! and its rasters. The reasoning is in the TypeScript file.
//!
//! Not ported: the per-domain cache of shared meshes, which changes the
//! time and nothing else.
//!
//! The sampler and the rasters locate through the triangulation, and a walk
//! moves its last triangle, which is the next walk's start; so they take the
//! mesh mutably, as the TypeScript code mutates it.

use crate::core::det_math::det_atan2;
use crate::core::domain::Domain;
use crate::core::js;
use crate::mesh::lattice::{centroidal_geodesic_lattice, hex_lattice};
use crate::mesh::mesh_sampler::hint_grid;
use crate::mesh::periodic_delaunay::PeriodicTriangulation;

pub struct FieldMesh {
    pub domain: Domain,
    pub tri: PeriodicTriangulation,
    /// The spacing asked for, metres, and the cells the lattice made.
    pub spacing_m: f64,
    pub count: usize,
    /// Metres per domain unit and, on the sphere, the globe's radius in
    /// metres (0 on the torus).
    pub unit_m: f64,
    pub radius_m: f64,
    pub globe: bool,
    /// Per cell: the chart point; on the sphere the unit vector, the east
    /// and the south axis (3D, interleaved).
    pub x: Vec<f64>,
    pub y: Vec<f64>,
    pub u: Vec<f64>,
    pub east: Vec<f64>,
    pub south: Vec<f64>,
    pub area: Vec<f64>,
    /// Per directed edge, CSR.
    pub nbr_start: Vec<u32>,
    pub nbr: Vec<u32>,
    pub rev: Vec<u32>,
    pub wall: Vec<f64>,
    pub dist: Vec<f64>,
    pub coupling: Vec<f64>,
    pub off_e: Vec<f64>,
    pub off_s: Vec<f64>,
    pub turn_c: Vec<f64>,
    pub turn_s: Vec<f64>,
    pub grad_e: Vec<f64>,
    pub grad_s: Vec<f64>,
    pub pentagons: u32,
    pub max_degree: u32,
}

impl FieldMesh {
    /// The edges of cell i.
    #[inline]
    pub fn edges(&self, i: usize) -> std::ops::Range<usize> {
        self.nbr_start[i] as usize..self.nbr_start[i + 1] as usize
    }
}

pub fn create_field_mesh(domain: &Domain, spacing_m: f64) -> FieldMesh {
    let unit_m = domain.metres_per_unit;
    let mut tri = if domain.is_sphere() {
        centroidal_geodesic_lattice(domain, spacing_m / unit_m)
    } else {
        hex_lattice(domain, spacing_m / unit_m)
    };
    let count = tri.vertex_slots();
    assert!(
        tri.alive_vertices as usize == count,
        "createFieldMesh: the lattice has dead vertex slots"
    );
    let globe = tri.globe;
    let radius_units = domain.width / (2.0 * std::f64::consts::PI);
    let radius_m = if globe { radius_units * unit_m } else { 0.0 };
    let x = tri.vx.clone();
    let y = tri.vy.clone();
    let n3 = if globe { 3 * count } else { 0 };
    let mut u = vec![0.0; n3];
    let mut east = vec![0.0; n3];
    let mut south = vec![0.0; n3];
    if globe {
        for i in 0..count {
            u[3 * i..3 * i + 3].copy_from_slice(&tri.vu[3 * i..3 * i + 3]);
            let gf = domain.globe_frame(x[i], y[i]);
            east[3 * i..3 * i + 3].copy_from_slice(&[gf.ex, gf.ey, gf.ez]);
            south[3 * i..3 * i + 3].copy_from_slice(&[gf.sx, gf.sy, gf.sz]);
        }
    }
    let area_unit = unit_m * unit_m;
    let area: Vec<f64> = (0..count)
        .map(|i| tri.voronoi_area(i) * area_unit)
        .collect();

    // The CSR table: each cell's outgoing halfedges, counter-clockwise,
    // rotated to start at the lowest neighbour id.
    let mut nbr_start = vec![0u32; count + 1];
    let mut pentagons = 0;
    let mut max_degree = 0;
    for i in 0..count {
        let n = tri.degree(i) as u32;
        nbr_start[i + 1] = nbr_start[i] + n;
        if n == 5 {
            pentagons += 1;
        }
        if n > max_degree {
            max_degree = n;
        }
    }
    let edges = nbr_start[count] as usize;
    let mut halfedge = vec![0usize; edges];
    let mut nbr = vec![0u32; edges];
    let mut scratch = Vec::with_capacity(16);
    for i in 0..count {
        tri.outgoing(i, &mut scratch);
        let n = scratch.len();
        let mut first = 0;
        for k in 1..n {
            if tri.to(scratch[k] as usize) < tri.to(scratch[first] as usize) {
                first = k;
            }
        }
        let base = nbr_start[i] as usize;
        for k in 0..n {
            let e = scratch[(first + k) % n] as usize;
            halfedge[base + k] = e;
            nbr[base + k] = tri.to(e) as u32;
        }
    }
    let mut rev = vec![0u32; edges];
    for i in 0..count {
        for e in nbr_start[i] as usize..nbr_start[i + 1] as usize {
            let j = nbr[e] as usize;
            let mut back = usize::MAX;
            for f in nbr_start[j] as usize..nbr_start[j + 1] as usize {
                if nbr[f] as usize == i {
                    back = f;
                }
            }
            assert!(
                back != usize::MAX,
                "createFieldMesh: edge {i}→{j} has no reverse"
            );
            rev[e] = back as u32;
        }
    }

    let mut wall = vec![0.0; edges];
    let mut dist = vec![0.0; edges];
    let mut off_e = vec![0.0; edges];
    let mut off_s = vec![0.0; edges];
    let mut turn_c = vec![1.0; edges];
    let mut turn_s = vec![0.0; edges];
    // The circumcentres' scratch: a degenerate triangle on the globe leaves
    // the last values, as the TypeScript scratch does.
    let mut c_l = [0.0f64; 3];
    let mut c_r = [0.0f64; 3];
    for i in 0..count {
        for e in nbr_start[i] as usize..nbr_start[i + 1] as usize {
            let h = halfedge[e];
            let j = nbr[e] as usize;
            let t_l = tri.triangle_of(h);
            let t_r = tri.triangle_of(tri.twin[h] as usize);
            dist[e] = tri.edge_length(h) * unit_m;
            if globe {
                if let Some(c) = tri.circumcentre_on_globe(t_l) {
                    c_l = c;
                }
                if let Some(c) = tri.circumcentre_on_globe(t_r) {
                    c_r = c;
                }
                let cx = c_l[1] * c_r[2] - c_l[2] * c_r[1];
                let cy = c_l[2] * c_r[0] - c_l[0] * c_r[2];
                let cz = c_l[0] * c_r[1] - c_l[1] * c_r[0];
                let arc = det_atan2(
                    (cx * cx + cy * cy + cz * cz).sqrt(),
                    c_l[0] * c_r[0] + c_l[1] * c_r[1] + c_l[2] * c_r[2],
                );
                let (ui, uj) = (3 * i, 3 * j);
                let nx = -(u[ui + 1] * u[uj + 2] - u[ui + 2] * u[uj + 1]);
                let ny = -(u[ui + 2] * u[uj] - u[ui] * u[uj + 2]);
                let nz = -(u[ui] * u[uj + 1] - u[ui + 1] * u[uj]);
                let side = (c_l[0] - c_r[0]) * nx + (c_l[1] - c_r[1]) * ny + (c_l[2] - c_r[2]) * nz;
                wall[e] = (if side >= 0.0 { arc } else { -arc }) * radius_m;
                let dot = u[uj] * u[ui] + u[uj + 1] * u[ui + 1] + u[uj + 2] * u[ui + 2];
                let tx = u[uj] - dot * u[ui];
                let ty = u[uj + 1] - dot * u[ui + 1];
                let tz = u[uj + 2] - dot * u[ui + 2];
                let tl = (tx * tx + ty * ty + tz * tz).sqrt();
                let k = dist[e] / tl;
                off_e[e] = (tx * east[ui] + ty * east[ui + 1] + tz * east[ui + 2]) * k;
                off_s[e] = (tx * south[ui] + ty * south[ui + 1] + tz * south[ui + 2]) * k;
                let wx = u[uj + 1] * u[ui + 2] - u[uj + 2] * u[ui + 1];
                let wy = u[uj + 2] * u[ui] - u[uj] * u[ui + 2];
                let wz = u[uj] * u[ui + 1] - u[uj + 1] * u[ui];
                let (ex, ey, ez) = (east[uj], east[uj + 1], east[uj + 2]);
                let q = (wx * ex + wy * ey + wz * ez) / (1.0 + dot);
                let rx = dot * ex + (wy * ez - wz * ey) + wx * q;
                let ry = dot * ey + (wz * ex - wx * ez) + wy * q;
                let rz = dot * ez + (wx * ey - wy * ex) + wz * q;
                turn_c[e] = rx * east[ui] + ry * east[ui + 1] + rz * east[ui + 2];
                turn_s[e] = rx * south[ui] + ry * south[ui + 1] + rz * south[ui + 2];
            } else {
                let l = circumcentre_near(&tri, t_l, x[i], y[i]);
                let r = circumcentre_near(&tri, t_r, x[i], y[i]);
                let d = domain.delta(x[j], y[j], x[i], y[i]);
                let len = (d.x * d.x + d.y * d.y).sqrt();
                wall[e] = (((l.0 - r.0) * -d.y + (l.1 - r.1) * d.x) / len) * unit_m;
                off_e[e] = d.x * unit_m;
                off_s[e] = d.y * unit_m;
            }
        }
    }
    let coupling: Vec<f64> = (0..edges).map(|e| wall[e] / dist[e]).collect();

    // Least-squares gradient weights.
    let mut grad_e = vec![0.0; edges];
    let mut grad_s = vec![0.0; edges];
    for i in 0..count {
        let (mut mee, mut mes, mut mss) = (0.0, 0.0, 0.0);
        let range = nbr_start[i] as usize..nbr_start[i + 1] as usize;
        for e in range.clone() {
            let w = 1.0 / (off_e[e] * off_e[e] + off_s[e] * off_s[e]);
            mee += w * off_e[e] * off_e[e];
            mes += w * off_e[e] * off_s[e];
            mss += w * off_s[e] * off_s[e];
        }
        let det = mee * mss - mes * mes;
        for e in range {
            let w = 1.0 / (off_e[e] * off_e[e] + off_s[e] * off_s[e]);
            grad_e[e] = (w * (mss * off_e[e] - mes * off_s[e])) / det;
            grad_s[e] = (w * (mee * off_s[e] - mes * off_e[e])) / det;
        }
    }

    FieldMesh {
        domain: domain.clone(),
        tri,
        spacing_m,
        count,
        unit_m,
        radius_m,
        globe,
        x,
        y,
        u,
        east,
        south,
        area,
        nbr_start,
        nbr,
        rev,
        wall,
        dist,
        coupling,
        off_e,
        off_s,
        turn_c,
        turn_s,
        grad_e,
        grad_s,
        pentagons,
        max_degree,
    }
}

/// The circumcentre of torus triangle t in the frame of the point (px, py).
fn circumcentre_near(tri: &PeriodicTriangulation, t: usize, px: f64, py: f64) -> (f64, f64) {
    let a = tri.from(3 * t);
    let d = tri.domain.delta(tri.vx[a], tri.vy[a], px, py);
    let cc = tri
        .circumcentre(t)
        .unwrap_or_else(|| panic!("createFieldMesh: degenerate triangle {t}"));
    (d.x + cc.0, d.y + cc.1)
}

// ------------------------------------------------------------- the sampler

/// Hint cells per mesh spacing in each direction.
const HINTS_PER_SPACING: f64 = 2.0;

/// A field mesh read at any chart point, through a hint grid at the mesh's
/// own spacing and the triangulation's walk.
pub struct FieldSampler {
    cols: usize,
    rows: usize,
    sx: f64,
    sy: f64,
    hints: Vec<u32>,
}

/// A point's taps: its triangle, the three corners and their weights.
#[derive(Clone, Copy, Debug)]
pub struct Taps {
    pub triangle: usize,
    pub corners: [usize; 3],
    pub weights: [f64; 3],
}

pub fn create_field_sampler(fm: &mut FieldMesh) -> FieldSampler {
    let domain = &fm.domain;
    let step = fm.spacing_m / fm.unit_m / HINTS_PER_SPACING;
    let cols = js::max(4.0, js::round(domain.width / step)) as usize;
    let rows = js::max(4.0, js::round(domain.height / step)) as usize;
    let sx = domain.width / cols as f64;
    let sy = domain.height / rows as f64;
    let hints = hint_grid(&mut fm.tri, 0.0, 0.0, cols, rows, sx, sy);
    FieldSampler {
        cols,
        rows,
        sx,
        sy,
        hints,
    }
}

impl FieldSampler {
    fn hint_at(&self, fm: &FieldMesh, x: f64, y: f64) -> Option<usize> {
        let c = js::min(
            (self.cols - 1) as f64,
            js::max(0.0, (fm.domain.wrap_x(x) / self.sx).floor()),
        );
        let r = js::min(
            (self.rows - 1) as f64,
            js::max(0.0, (fm.domain.wrap_y(y) / self.sy).floor()),
        );
        // A NaN point reads no hint; the walk starts at the last triangle,
        // as the TypeScript lookup's undefined does.
        if c.is_nan() || r.is_nan() {
            return None;
        }
        Some(self.hints[r as usize * self.cols + c as usize] as usize)
    }

    /// The triangle under (x, y) with its corners and weights.
    pub fn taps(&self, fm: &mut FieldMesh, x: f64, y: f64) -> Taps {
        let hint = self.hint_at(fm, x, y);
        let t = fm.tri.locate(x, y, hint);
        let weights = fm.tri.barycentric(t, x, y);
        Taps {
            triangle: t,
            corners: [
                fm.tri.from(3 * t),
                fm.tri.from(3 * t + 1),
                fm.tri.from(3 * t + 2),
            ],
            weights,
        }
    }

    pub fn sample<T: Copy + Into<f64>>(
        &self,
        fm: &mut FieldMesh,
        field: &[T],
        x: f64,
        y: f64,
    ) -> f64 {
        let t = self.taps(fm, x, y);
        let f = |k: usize| -> f64 { field[t.corners[k]].into() };
        t.weights[0] * f(0) + t.weights[1] * f(1) + t.weights[2] * f(2)
    }

    /// A vector field (east, south per cell, each in its own frame) at
    /// (x, y), read in the frame of cell `to_cell`, or in (x, y)'s own frame
    /// when None.
    pub fn sample_vector(
        &self,
        fm: &mut FieldMesh,
        fe: &[f64],
        fs: &[f64],
        x: f64,
        y: f64,
        to_cell: Option<usize>,
    ) -> (f64, f64) {
        let t = self.taps(fm, x, y);
        let (c, b) = (t.corners, t.weights);
        if !fm.globe {
            return (
                b[0] * fe[c[0]] + b[1] * fe[c[1]] + b[2] * fe[c[2]],
                b[0] * fs[c[0]] + b[1] * fs[c[1]] + b[2] * fs[c[2]],
            );
        }
        let (mut vx, mut vy, mut vz) = (0.0, 0.0, 0.0);
        for k in 0..3 {
            let ck = c[k];
            let w = b[k];
            let a = fe[ck] * w;
            let s = fs[ck] * w;
            vx += a * fm.east[3 * ck] + s * fm.south[3 * ck];
            vy += a * fm.east[3 * ck + 1] + s * fm.south[3 * ck + 1];
            vz += a * fm.east[3 * ck + 2] + s * fm.south[3 * ck + 2];
        }
        let gf = fm.domain.globe_frame(x, y);
        let r = fm.domain.radius();
        let q = [gf.px / r, gf.py / r, gf.pz / r];
        let Some(to) = to_cell else {
            return (
                vx * gf.ex + vy * gf.ey + vz * gf.ez,
                vx * gf.sx + vy * gf.sy + vz * gf.sz,
            );
        };
        let rr = vx * q[0] + vy * q[1] + vz * q[2];
        vx -= rr * q[0];
        vy -= rr * q[1];
        vz -= rr * q[2];
        let o = 3 * to;
        let (ux, uy, uz) = (fm.u[o], fm.u[o + 1], fm.u[o + 2]);
        let cc = q[0] * ux + q[1] * uy + q[2] * uz;
        let (mut rx, mut ry, mut rz) = (vx, vy, vz);
        if cc > -1.0 + 1e-12 {
            let wx = q[1] * uz - q[2] * uy;
            let wy = q[2] * ux - q[0] * uz;
            let wz = q[0] * uy - q[1] * ux;
            let k = (wx * vx + wy * vy + wz * vz) / (1.0 + cc);
            rx = cc * vx + (wy * vz - wz * vy) + wx * k;
            ry = cc * vy + (wz * vx - wx * vz) + wy * k;
            rz = cc * vz + (wx * vy - wy * vx) + wz * k;
        }
        (
            rx * fm.east[o] + ry * fm.east[o + 1] + rz * fm.east[o + 2],
            rx * fm.south[o] + ry * fm.south[o + 1] + rz * fm.south[o + 2],
        )
    }

    /// The cell whose Voronoi cell holds (x, y), by a greedy descent from
    /// the nearest triangle corner.
    pub fn nearest_cell(&self, fm: &mut FieldMesh, x: f64, y: f64) -> usize {
        let t = self.taps(fm, x, y);
        let q = if fm.globe {
            let gf = fm.domain.globe_frame(x, y);
            let r = fm.domain.radius();
            [gf.px / r, gf.py / r, gf.pz / r]
        } else {
            [0.0; 3]
        };
        let closeness = |fm: &FieldMesh, i: usize| -> f64 {
            if fm.globe {
                return fm.u[3 * i] * q[0] + fm.u[3 * i + 1] * q[1] + fm.u[3 * i + 2] * q[2];
            }
            -fm.domain.distance_sq(fm.x[i], fm.y[i], x, y)
        };
        let mut best = t.corners[0];
        let mut best_c = closeness(fm, best);
        for k in 1..3 {
            let c = closeness(fm, t.corners[k]);
            if c > best_c {
                best_c = c;
                best = t.corners[k];
            }
        }
        loop {
            let mut moved = false;
            for e in fm.edges(best) {
                let n = fm.nbr[e] as usize;
                let c = closeness(fm, n);
                if c > best_c {
                    best_c = c;
                    best = n;
                    moved = true;
                }
            }
            if !moved {
                return best;
            }
        }
    }
}

// ------------------------------------------------------- chart rasters

/// A field rasterised onto a res_x × res_y chart raster, cell centres, by a
/// scanline walk from the triangulation's last triangle.
pub fn rasterise_field<T: Copy + Into<f64>>(
    fm: &mut FieldMesh,
    field: &[T],
    res_x: usize,
    res_y: usize,
) -> Vec<f32> {
    let mut result = vec![0f32; res_x * res_y];
    let sx = fm.domain.width / res_x as f64;
    let sy = fm.domain.height / res_y as f64;
    let mut hint = fm.tri.last_tri as usize;
    let mut row_start = hint;
    for py in 0..res_y {
        let y = (py as f64 + 0.5) * sy;
        hint = row_start;
        for px in 0..res_x {
            let x = (px as f64 + 0.5) * sx;
            let t = fm.tri.locate(x, y, Some(hint));
            hint = t;
            if px == 0 {
                row_start = t;
            }
            let b = fm.tri.barycentric(t, x, y);
            let f = |k: usize| -> f64 { field[fm.tri.from(3 * t + k)].into() };
            result[py * res_x + px] = (b[0] * f(0) + b[1] * f(1) + b[2] * f(2)) as f32;
        }
    }
    result
}

/// A vector field on a res_x × res_y chart raster, cell centres,
/// interleaved [east, south], each pixel's vector in the pixel's own frame.
pub fn rasterise_vector_field(
    sampler: &FieldSampler,
    fm: &mut FieldMesh,
    fe: &[f64],
    fs: &[f64],
    res_x: usize,
    res_y: usize,
) -> Vec<f32> {
    let mut result = vec![0f32; res_x * res_y * 2];
    let sx = fm.domain.width / res_x as f64;
    let sy = fm.domain.height / res_y as f64;
    for py in 0..res_y {
        let y = (py as f64 + 0.5) * sy;
        for px in 0..res_x {
            let (e, s) = sampler.sample_vector(fm, fe, fs, (px as f64 + 0.5) * sx, y, None);
            let k = (py * res_x + px) * 2;
            result[k] = e as f32;
            result[k + 1] = s as f32;
        }
    }
    result
}

/// The cell of the field mesh that owns each raster cell of a res_x × res_y
/// chart raster.
pub fn raster_owners(
    sampler: &FieldSampler,
    fm: &mut FieldMesh,
    res_x: usize,
    res_y: usize,
) -> Vec<u32> {
    let mut owners = vec![0u32; res_x * res_y];
    let sx = fm.domain.width / res_x as f64;
    let sy = fm.domain.height / res_y as f64;
    for py in 0..res_y {
        let y = (py as f64 + 0.5) * sy;
        for px in 0..res_x {
            owners[py * res_x + px] = sampler.nearest_cell(fm, (px as f64 + 0.5) * sx, y) as u32;
        }
    }
    owners
}

/// A chart raster (cell centres at +0.5) onto the field mesh, sampled
/// bilinearly at each cell's centre: for a smooth field about as coarse as
/// the mesh or coarser.
pub fn field_from_raster_at_centres(
    fm: &FieldMesh,
    raster: &[f32],
    res_x: usize,
    res_y: usize,
) -> Vec<f64> {
    let grid = fm.domain.grid(res_x, res_y);
    (0..fm.count)
        .map(|i| grid.sample_bilinear_at(raster, fm.x[i], fm.y[i]))
        .collect()
}

/// A chart raster onto the field mesh as the area-weighted mean of the
/// raster cells whose centres lie in each Voronoi cell; a mesh cell no
/// raster centre falls in takes the centre sample. `owners`: raster_owners
/// of the same raster size, when the caller has them.
pub fn field_from_raster_area_weighted(
    fm: &mut FieldMesh,
    sampler: &FieldSampler,
    raster: &[f32],
    res_x: usize,
    res_y: usize,
    owners: Option<&[u32]>,
) -> Vec<f64> {
    let mut weight = vec![0.0; fm.count];
    let mut sum = vec![0.0; fm.count];
    let grid = fm.domain.grid(res_x, res_y);
    let sx = fm.domain.width / res_x as f64;
    let sy = fm.domain.height / res_y as f64;
    for py in 0..res_y {
        let w = grid.cell_area(py as f64);
        let y = (py as f64 + 0.5) * sy;
        for px in 0..res_x {
            let i = match owners {
                Some(o) => o[py * res_x + px] as usize,
                None => sampler.nearest_cell(fm, (px as f64 + 0.5) * sx, y),
            };
            sum[i] += w * raster[py * res_x + px] as f64;
            weight[i] += w;
        }
    }
    (0..fm.count)
        .map(|i| {
            if weight[i] > 0.0 {
                sum[i] / weight[i]
            } else {
                grid.sample_bilinear_at(raster, fm.x[i], fm.y[i])
            }
        })
        .collect()
}

/// The maximum of the raster cells whose centres lie in each Voronoi cell;
/// a mesh cell no raster centre falls in takes the centre sample.
pub fn field_max_from_raster(
    fm: &FieldMesh,
    raster: &[f32],
    res_x: usize,
    res_y: usize,
    owners: &[u32],
) -> Vec<f64> {
    let mut result = vec![f64::NEG_INFINITY; fm.count];
    for (p, &o) in owners.iter().enumerate() {
        let i = o as usize;
        if raster[p] as f64 > result[i] {
            result[i] = raster[p] as f64;
        }
    }
    let grid = fm.domain.grid(res_x, res_y);
    for i in 0..fm.count {
        if result[i] == f64::NEG_INFINITY {
            result[i] = grid.sample_bilinear_at(raster, fm.x[i], fm.y[i]);
        }
    }
    result
}
