//! `mesh/meshNeighbourhood.ts`: NEIGHBOURHOODS IN METRES ON A TERRAIN MESH
//! (DEC-0036 phase 7). A neighbourhood is the cells the disc of radius r
//! about a node reaches, each cell the disc of its own area, weighed by the
//! lens the two discs share; gathered by a walk over the triangulation. The
//! reasoning is in the TypeScript file.
//!
//! The tables do not hold the mesh: a function that reads it takes it, and
//! one that locates a point takes it mutably, because the walk moves the
//! mesh's last triangle as in TypeScript.

use crate::core::det_math::{det_asin, det_exp};
use crate::core::js;

use super::mesh_erosion::apex_cotangents;
use super::periodic_delaunay::PeriodicTriangulation;

/// The mesh's cells and stars in metres: what a neighbourhood walks.
pub struct MeshStar {
    /// Metres per domain unit.
    pub unit_m: f64,
    /// Per slot: the Voronoi area, m², and the radius of a disc of that
    /// area, m.
    pub area_m2: Vec<f64>,
    pub rho: Vec<f64>,
    /// The Delaunay star per slot as a CSR table.
    pub star_start: Vec<u32>,
    pub star: Vec<u32>,
    globe: bool,
    radius_m: f64,
}

/// The star with its edges measured: per entry, the edge's length and its
/// Voronoi wall, m.
pub struct MeshGeometry {
    pub cells: MeshStar,
    pub length_m: Vec<f64>,
    pub wall_m: Vec<f64>,
}

pub fn mesh_star(mesh: &mut PeriodicTriangulation, unit_m: f64) -> MeshStar {
    let slots = mesh.vertex_slots();
    let mut area_m2 = vec![0.0; slots];
    let mut rho = vec![0.0; slots];
    for v in 0..slots {
        if mesh.v_alive[v] == 0 {
            continue;
        }
        area_m2[v] = mesh.voronoi_area(v) * unit_m * unit_m;
        rho[v] = (area_m2[v] / std::f64::consts::PI).sqrt();
    }
    let mut star_start = vec![0u32; slots + 1];
    let mut edges = 0u32;
    for v in 0..slots {
        star_start[v] = edges;
        if mesh.v_alive[v] != 0 {
            edges += mesh.degree(v) as u32;
        }
    }
    star_start[slots] = edges;
    let mut star = vec![0u32; edges as usize];
    let mut out = Vec::with_capacity(16);
    for v in 0..slots {
        if mesh.v_alive[v] == 0 {
            continue;
        }
        mesh.outgoing(v, &mut out);
        let base = star_start[v] as usize;
        for (k, &e) in out.iter().enumerate() {
            star[base + k] = mesh.to(e as usize) as u32;
        }
    }
    MeshStar {
        unit_m,
        area_m2,
        rho,
        star_start,
        star,
        globe: mesh.globe,
        radius_m: (mesh.domain.width / (2.0 * std::f64::consts::PI)) * unit_m,
    }
}

impl MeshStar {
    /// The tables from their parts, as `mesh_star` makes them (a saved or
    /// dumped geometry); `radius_m` is the globe's radius in metres, unused
    /// on the torus.
    pub fn from_parts(
        unit_m: f64,
        area_m2: Vec<f64>,
        rho: Vec<f64>,
        star_start: Vec<u32>,
        star: Vec<u32>,
        globe: bool,
        radius_m: f64,
    ) -> Self {
        MeshStar {
            unit_m,
            area_m2,
            rho,
            star_start,
            star,
            globe,
            radius_m,
        }
    }

    fn arc_of(&self, dx: f64, dy: f64, dz: f64) -> f64 {
        self.radius_m * 2.0 * det_asin(js::min(1.0, (dx * dx + dy * dy + dz * dz).sqrt() / 2.0))
    }

    /// The distance between two slots, metres.
    pub fn distance_m(&self, mesh: &PeriodicTriangulation, a: usize, b: usize) -> f64 {
        if self.globe {
            let u = &mesh.vu;
            return self.arc_of(
                u[3 * a] - u[3 * b],
                u[3 * a + 1] - u[3 * b + 1],
                u[3 * a + 2] - u[3 * b + 2],
            );
        }
        mesh.domain
            .distance_sq(mesh.vx[a], mesh.vy[a], mesh.vx[b], mesh.vy[b])
            .sqrt()
            * self.unit_m
    }

    /// The distance from a slot to a point, metres.
    pub fn distance_to_point_m(
        &self,
        mesh: &PeriodicTriangulation,
        v: usize,
        x: f64,
        y: f64,
    ) -> f64 {
        if self.globe {
            let frame = mesh.domain.globe_frame(x, y);
            let r = mesh.domain.radius();
            let u = &mesh.vu;
            return self.arc_of(
                u[3 * v] - frame.px / r,
                u[3 * v + 1] - frame.py / r,
                u[3 * v + 2] - frame.pz / r,
            );
        }
        mesh.domain.distance_sq(mesh.vx[v], mesh.vy[v], x, y).sqrt() * self.unit_m
    }
}

pub fn mesh_geometry(mesh: &mut PeriodicTriangulation, unit_m: f64) -> MeshGeometry {
    let cells = mesh_star(mesh, unit_m);
    let edges = cells.star_start[mesh.vertex_slots()] as usize;
    let mut length_m = vec![0.0; edges];
    let mut wall_m = vec![0.0; edges];
    let cot = apex_cotangents(mesh);
    let mut out = Vec::with_capacity(16);
    for v in 0..mesh.vertex_slots() {
        if mesh.v_alive[v] == 0 {
            continue;
        }
        mesh.outgoing(v, &mut out);
        let base = cells.star_start[v] as usize;
        for (k, &e) in out.iter().enumerate() {
            let e = e as usize;
            let len = mesh.edge_length(e);
            length_m[base + k] = len * unit_m;
            wall_m[base + k] =
                len * unit_m * js::max(0.0, (cot[e] + cot[mesh.twin[e] as usize]) / 2.0);
        }
    }
    MeshGeometry {
        cells,
        length_m,
        wall_m,
    }
}

/// The area of the lens two discs of radii r and R share at distance d.
#[allow(non_snake_case)]
fn lens_area(r: f64, R: f64, d: f64) -> f64 {
    let pi = std::f64::consts::PI;
    if d >= r + R {
        return 0.0;
    }
    if d <= (r - R).abs() {
        let m = js::min(r, R);
        return pi * m * m;
    }
    let acos = |x: f64| pi / 2.0 - det_asin(js::max(-1.0, js::min(1.0, x)));
    let a = r * r * acos((d * d + r * r - R * R) / (2.0 * d * r));
    let b = R * R * acos((d * d + R * R - r * r) / (2.0 * d * R));
    let c = 0.5 * js::max(0.0, (-d + r + R) * (d + r - R) * (d - r + R) * (d + r + R)).sqrt();
    a + b - c
}

/// The cells within a radius of each admitted node, with their lens
/// weights (m²), as a CSR table per slot. Every centre holds itself.
pub struct Neighbourhoods {
    pub start: Vec<u32>,
    pub member: Vec<u32>,
    pub weight: Vec<f32>,
}

pub fn neighbourhoods(
    geo: &MeshStar,
    mesh: &PeriodicTriangulation,
    radius_m: f64,
    centre: Option<&[u8]>,
) -> Neighbourhoods {
    let slots = mesh.vertex_slots();
    let mut start = vec![0u32; slots + 1];
    let mut member: Vec<u32> = Vec::with_capacity((slots * 8).max(16));
    let mut weight: Vec<f32> = Vec::with_capacity((slots * 8).max(16));
    let mut stamp = vec![-1i64; slots];
    let mut queue: Vec<usize> = Vec::new();
    for i in 0..slots {
        start[i] = member.len() as u32;
        if mesh.v_alive[i] == 0 || centre.is_some_and(|c| c[i] == 0) {
            continue;
        }
        queue.clear();
        queue.push(i);
        stamp[i] = i as i64;
        let mut q = 0;
        while q < queue.len() {
            let j = queue[q];
            q += 1;
            let d = if j == i {
                0.0
            } else {
                geo.distance_m(mesh, i, j)
            };
            let w = lens_area(radius_m, geo.rho[j], d);
            if w <= 0.0 && j != i {
                continue;
            }
            member.push(j as u32);
            weight.push(w as f32);
            for &k in &geo.star[geo.star_start[j] as usize..geo.star_start[j + 1] as usize] {
                let k = k as usize;
                if stamp[k] == i as i64 {
                    continue;
                }
                stamp[k] = i as i64;
                queue.push(k);
            }
        }
    }
    start[slots] = member.len() as u32;
    Neighbourhoods {
        start,
        member,
        weight,
    }
}

/// The largest value over each neighbourhood; 0 where a slot has none.
pub fn max_within<T: Copy + Into<f64>>(nb: &Neighbourhoods, field: &[T]) -> Vec<f32> {
    let slots = nb.start.len() - 1;
    let mut out = vec![0f32; slots];
    for i in 0..slots {
        let mut m = f64::NEG_INFINITY;
        for k in nb.start[i] as usize..nb.start[i + 1] as usize {
            let v: f64 = field[nb.member[k] as usize].into();
            if v > m {
                m = v;
            }
        }
        out[i] = if m == f64::NEG_INFINITY {
            0.0
        } else {
            m as f32
        };
    }
    out
}

/// The lens-weighted mean over each neighbourhood; 0 where a slot has none.
pub fn mean_within<T: Copy + Into<f64>>(nb: &Neighbourhoods, field: &[T]) -> Vec<f32> {
    let slots = nb.start.len() - 1;
    let mut out = vec![0f32; slots];
    for i in 0..slots {
        let mut sum = 0.0;
        let mut total = 0.0;
        for k in nb.start[i] as usize..nb.start[i + 1] as usize {
            let w = nb.weight[k] as f64;
            let v: f64 = field[nb.member[k] as usize].into();
            sum += w * v;
            total += w;
        }
        out[i] = if total > 0.0 {
            (sum / total) as f32
        } else {
            0.0
        };
    }
    out
}

/// The node under a point: the heaviest corner of the triangle it lies in.
pub fn node_at(mesh: &mut PeriodicTriangulation, x: f64, y: f64) -> usize {
    let t = mesh.locate(x, y, None);
    let w = mesh.barycentric(t, x, y);
    let k = if w[0] >= w[1] && w[0] >= w[2] {
        0
    } else if w[1] >= w[2] {
        1
    } else {
        2
    };
    mesh.from(3 * t + k)
}

/// The nodes whose cells a disc of `reach_m` about a point reaches, each
/// with its distance to the point (metres), from the node under the point
/// outward: `visit(v, d)`.
#[allow(clippy::too_many_arguments)]
pub fn around_point(
    geo: &MeshStar,
    mesh: &mut PeriodicTriangulation,
    x: f64,
    y: f64,
    reach_m: f64,
    visit: &mut dyn FnMut(usize, f64),
    stamp: &mut [i64],
    mark: i64,
) {
    let first = node_at(mesh, x, y);
    let mut queue = vec![first];
    stamp[first] = mark;
    let mut q = 0;
    while q < queue.len() {
        let j = queue[q];
        q += 1;
        let d = geo.distance_to_point_m(mesh, j, x, y);
        if d - geo.rho[j] > reach_m && j != first {
            continue;
        }
        visit(j, d);
        for &k in &geo.star[geo.star_start[j] as usize..geo.star_start[j + 1] as usize] {
            let k = k as usize;
            if stamp[k] == mark {
                continue;
            }
            stamp[k] = mark;
            queue.push(k);
        }
    }
}

/// A soft Gaussian halo (0..1, union-max) about each point, σ `sigma_m`,
/// out to three σ. Per slot.
pub fn gaussian_halos(
    geo: &MeshGeometry,
    mesh: &mut PeriodicTriangulation,
    points: &[(f64, f64)],
    sigma_m: f64,
) -> Vec<f32> {
    let slots = mesh.vertex_slots();
    let mut field = vec![0f32; slots];
    if points.is_empty() || sigma_m <= 0.0 {
        return field;
    }
    let reach = 3.0 * sigma_m;
    let inv2s2 = 1.0 / (2.0 * sigma_m * sigma_m);
    let mut stamp = vec![-1i64; slots];
    for (p, &(x, y)) in points.iter().enumerate() {
        let mut visit = |v: usize, d: f64| {
            if d > reach {
                return;
            }
            let bump = det_exp(-(d * d) * inv2s2);
            if bump > field[v] as f64 {
                field[v] = bump as f32;
            }
        };
        around_point(
            &geo.cells, mesh, x, y, reach, &mut visit, &mut stamp, p as i64,
        );
    }
    field
}

/// 1 on the cells a disc of `reach_m` about each point reaches. Per slot.
pub fn discs_around(
    geo: &MeshGeometry,
    mesh: &mut PeriodicTriangulation,
    points: &[(f64, f64)],
    reach_m: f64,
) -> Vec<f32> {
    let slots = mesh.vertex_slots();
    let mut field = vec![0f32; slots];
    let mut stamp = vec![-1i64; slots];
    for (p, &(x, y)) in points.iter().enumerate() {
        let mut visit = |v: usize, _: f64| field[v] = 1.0;
        around_point(
            &geo.cells, mesh, x, y, reach_m, &mut visit, &mut stamp, p as i64,
        );
    }
    field
}

/// The slope per node, |∇z| in z's units per metre: Green–Gauss over the
/// Voronoi cell.
pub fn slope_of<T: Copy + Into<f64>>(
    geo: &MeshGeometry,
    mesh: &PeriodicTriangulation,
    z: &[T],
) -> Vec<f32> {
    let c = &geo.cells;
    let slots = mesh.vertex_slots();
    let mut out = vec![0f32; slots];
    for v in 0..slots {
        if mesh.v_alive[v] == 0 || c.area_m2[v] <= 0.0 {
            continue;
        }
        let (mut gx, mut gy) = (0.0, 0.0);
        for e in c.star_start[v] as usize..c.star_start[v + 1] as usize {
            let u = c.star[e] as usize;
            let d = mesh
                .domain
                .delta(mesh.vx[u], mesh.vy[u], mesh.vx[v], mesh.vy[v]);
            let len = (d.x * d.x + d.y * d.y).sqrt();
            if len == 0.0 {
                continue;
            }
            let zu: f64 = z[u].into();
            let zv: f64 = z[v].into();
            let k = (geo.wall_m[e] * (zu - zv)) / 2.0 / len;
            gx += k * d.x;
            gy += k * d.y;
        }
        out[v] = ((gx * gx + gy * gy).sqrt() / c.area_m2[v]) as f32;
    }
    out
}

/// The share of a node's Voronoi boundary that faces a neighbour `differs`
/// from, per unit of its area and scaled by `length_m` / 4. 0 off `use_`.
pub fn boundary_density(
    geo: &MeshGeometry,
    mesh: &PeriodicTriangulation,
    use_: &[u8],
    differs: &dyn Fn(usize, usize) -> bool,
    length_m: f64,
) -> Vec<f32> {
    let c = &geo.cells;
    let slots = mesh.vertex_slots();
    let mut out = vec![0f32; slots];
    for v in 0..slots {
        if use_[v] == 0 || c.area_m2[v] <= 0.0 {
            continue;
        }
        let mut wall = 0.0;
        for e in c.star_start[v] as usize..c.star_start[v + 1] as usize {
            if differs(v, c.star[e] as usize) {
                wall += geo.wall_m[e];
            }
        }
        out[v] = ((wall * length_m) / (4.0 * c.area_m2[v])) as f32;
    }
    out
}
