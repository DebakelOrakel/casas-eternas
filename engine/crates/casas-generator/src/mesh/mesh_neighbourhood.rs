//! NEIGHBOURHOODS IN METRES ON A TERRAIN MESH (DEC-0036 phase 7). A
//! neighbourhood is the cells the disc of radius r about a node reaches,
//! each cell the disc of its own area, weighed by the lens the two discs
//! share; gathered by a walk over the triangulation. The reasoning is in
//! the TypeScript port (`client/src/generator/mesh/meshNeighbourhood.ts`,
//! git history).
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
/// The table grows with the radius over the node spacing squared (at level
/// 1, 30 km: some 190 members a node, 12 GB): `max_within` and
/// `mean_within` gather one neighbourhood at a time instead, in the same
/// order, to the same values.
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
    let blocks: Vec<std::ops::Range<usize>> = (0..slots)
        .step_by(NEIGHBOURHOOD_BLOCK)
        .map(|b| b..(b + NEIGHBOURHOOD_BLOCK).min(slots))
        .collect();
    #[cfg(feature = "parallel")]
    let parts: Vec<Block> = {
        use rayon::prelude::*;
        blocks
            .into_par_iter()
            .map_init(
                || Gather::new(slots),
                |g, range| neighbourhood_block(geo, mesh, radius_m, centre, range, g),
            )
            .collect()
    };
    #[cfg(not(feature = "parallel"))]
    let parts: Vec<Block> = {
        let mut g = Gather::new(slots);
        blocks
            .into_iter()
            .map(|range| neighbourhood_block(geo, mesh, radius_m, centre, range, &mut g))
            .collect()
    };
    // The blocks in their order: the table one pass over the slots makes.
    let total: usize = parts.iter().map(|p| p.member.len()).sum();
    let mut start = Vec::with_capacity(slots + 1);
    let mut member = Vec::with_capacity(total);
    let mut weight = Vec::with_capacity(total);
    for p in parts {
        let base = member.len() as u32;
        start.extend(p.start.iter().map(|&s| base + s));
        member.extend_from_slice(&p.member);
        weight.extend_from_slice(&p.weight);
    }
    start.push(member.len() as u32);
    Neighbourhoods {
        start,
        member,
        weight,
    }
}

/// Slots per block of the neighbourhoods: the unit of the work, fixed, so
/// the table does not depend on the number of threads.
const NEIGHBOURHOOD_BLOCK: usize = 4096;

/// One block of the table, its `start` relative to the block.
struct Block {
    start: Vec<u32>,
    member: Vec<u32>,
    weight: Vec<f32>,
}

/// The neighbourhoods of the centres in `range`.
fn neighbourhood_block(
    geo: &MeshStar,
    mesh: &PeriodicTriangulation,
    radius_m: f64,
    centre: Option<&[u8]>,
    range: std::ops::Range<usize>,
    g: &mut Gather,
) -> Block {
    let mut block = Block {
        start: Vec::with_capacity(range.len()),
        member: Vec::with_capacity(range.len() * 8),
        weight: Vec::with_capacity(range.len() * 8),
    };
    for i in range {
        block.start.push(block.member.len() as u32);
        if mesh.v_alive[i] == 0 || centre.is_some_and(|c| c[i] == 0) {
            continue;
        }
        g.gather(geo, mesh, radius_m, i);
        block.member.extend_from_slice(&g.member);
        block.weight.extend_from_slice(&g.weight);
    }
    block
}

/// The scratch of one thread's walks. `stamp` holds, per slot, the last
/// centre that reached it (`u32::MAX`: none); the walks of one thread can
/// share it, as their centres are distinct.
struct Gather {
    stamp: Vec<u32>,
    queue: Vec<usize>,
    member: Vec<u32>,
    weight: Vec<f32>,
}

impl Gather {
    fn new(slots: usize) -> Self {
        Gather {
            stamp: vec![u32::MAX; slots],
            queue: Vec::new(),
            member: Vec::new(),
            weight: Vec::new(),
        }
    }

    /// The neighbourhood of `i` into `member` and `weight`, in the order
    /// of the walk.
    fn gather(&mut self, geo: &MeshStar, mesh: &PeriodicTriangulation, radius_m: f64, i: usize) {
        let Gather {
            stamp,
            queue,
            member,
            weight,
        } = self;
        member.clear();
        weight.clear();
        queue.clear();
        queue.push(i);
        stamp[i] = i as u32;
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
                if stamp[k] == i as u32 {
                    continue;
                }
                stamp[k] = i as u32;
                queue.push(k);
            }
        }
    }
}

/// A value per admitted node from its neighbourhood (`reduce(centre,
/// member, weight)`), gathered one node at a time; 0 where a slot is not
/// admitted.
fn reduce_within(
    geo: &MeshStar,
    mesh: &PeriodicTriangulation,
    radius_m: f64,
    centre: Option<&[u8]>,
    reduce: impl Fn(usize, &[u32], &[f32]) -> f32 + Sync,
) -> Vec<f32> {
    let slots = mesh.vertex_slots();
    let mut out = vec![0f32; slots];
    let run = |g: &mut Gather, base: usize, chunk: &mut [f32]| {
        for (k, o) in chunk.iter_mut().enumerate() {
            let i = base + k;
            if mesh.v_alive[i] == 0 || centre.is_some_and(|c| c[i] == 0) {
                continue;
            }
            g.gather(geo, mesh, radius_m, i);
            *o = reduce(i, &g.member, &g.weight);
        }
    };
    #[cfg(feature = "parallel")]
    {
        use rayon::prelude::*;
        out.par_chunks_mut(NEIGHBOURHOOD_BLOCK)
            .enumerate()
            .for_each_init(
                || Gather::new(slots),
                |g, (b, chunk)| run(g, b * NEIGHBOURHOOD_BLOCK, chunk),
            );
    }
    #[cfg(not(feature = "parallel"))]
    {
        let mut g = Gather::new(slots);
        for (b, chunk) in out.chunks_mut(NEIGHBOURHOOD_BLOCK).enumerate() {
            run(&mut g, b * NEIGHBOURHOOD_BLOCK, chunk);
        }
    }
    out
}

/// The largest value over each neighbourhood of `radius_m` about the
/// admitted nodes; 0 where a slot has none.
pub fn max_within<T: Copy + Into<f64> + Sync>(
    geo: &MeshStar,
    mesh: &PeriodicTriangulation,
    radius_m: f64,
    centre: Option<&[u8]>,
    field: &[T],
) -> Vec<f32> {
    reduce_within(geo, mesh, radius_m, centre, |_, member, _| {
        let mut m = f64::NEG_INFINITY;
        for &j in member {
            let v: f64 = field[j as usize].into();
            if v > m {
                m = v;
            }
        }
        if m == f64::NEG_INFINITY {
            0.0
        } else {
            m as f32
        }
    })
}

/// The lens-weighted mean over each neighbourhood of `radius_m` about the
/// admitted nodes; 0 where a slot has none.
pub fn mean_within<T: Copy + Into<f64> + Sync>(
    geo: &MeshStar,
    mesh: &PeriodicTriangulation,
    radius_m: f64,
    centre: Option<&[u8]>,
    field: &[T],
) -> Vec<f32> {
    reduce_within(geo, mesh, radius_m, centre, |_, member, weight| {
        let mut sum = 0.0;
        let mut total = 0.0;
        for (&j, &w) in member.iter().zip(weight) {
            let w = w as f64;
            let v: f64 = field[j as usize].into();
            sum += w * v;
            total += w;
        }
        if total > 0.0 {
            (sum / total) as f32
        } else {
            0.0
        }
    })
}

/// The largest `score(centre, member)` over each neighbourhood of
/// `radius_m` about the admitted nodes, 0 at least; 0 where a slot is not
/// admitted. For a value that depends on the pair, as a node's height over
/// a river near it.
pub fn max_pair_within(
    geo: &MeshStar,
    mesh: &PeriodicTriangulation,
    radius_m: f64,
    centre: Option<&[u8]>,
    score: impl Fn(usize, usize) -> f64 + Sync,
) -> Vec<f32> {
    reduce_within(geo, mesh, radius_m, centre, |i, member, _| {
        let mut m = 0.0;
        for &j in member {
            let v = score(i, j as usize);
            if v > m {
                m = v;
            }
        }
        m as f32
    })
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
