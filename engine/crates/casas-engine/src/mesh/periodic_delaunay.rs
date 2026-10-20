//! PERIODIC DELAUNAY TRIANGULATION on a domain: the TypeScript engine's
//! `mesh/periodicDelaunay.ts`, ported operation for operation. Its header
//! holds the reasoning (the halfedge layout, `frame`, the one-sheet margin,
//! the globe's exact 3D predicates, the float32 positions); this port keeps
//! the same order of every floating-point operation, so the same operations
//! in the same order give the same arrays, bit for bit, as the TypeScript
//! code (tests/periodic_delaunay.rs).
//!
//! Not ported, because they change the time and nothing else: the globe's
//! table of query unit vectors (a hit copies the bits a miss computes) and
//! the sphere domain's trig cache. A walk that does not terminate or a
//! broken link polygon panics where the TypeScript code throws.

use std::cell::Cell;

use crate::core::det_math::{det_asin, det_atan2, det_cos, det_sin, sq};
use crate::core::domain::Domain;
use crate::core::js;

/// Edges longer than this fraction of the shorter period are refused.
pub const MAX_EDGE_FRACTION: f64 = 0.25;
const INCIRCLE_EPS: f64 = 1e-12;
const ON_EDGE_EPS: f64 = 1e-10;
const ORIENT_EPS: f64 = 1e-12;
const GLOBE_RADIAL_EPS: f64 = 1e-14;

/// asin of a half chord: its Taylor series to x⁷ below 0.01, `det_asin`
/// above.
fn half_chord_asin(x: f64) -> f64 {
    if x >= 0.01 {
        return det_asin(x);
    }
    let x2 = x * x;
    x + x * x2 * (1.0 / 6.0 + x2 * (3.0 / 40.0 + x2 * (15.0 / 336.0)))
}

#[inline]
fn next(e: usize) -> usize {
    if e % 3 == 2 { e - 2 } else { e + 1 }
}

#[inline]
fn prev(e: usize) -> usize {
    if e.is_multiple_of(3) { e + 2 } else { e - 1 }
}

#[inline]
fn tri_of(e: usize) -> usize {
    e / 3
}

type V3 = [f64; 3];

/// The orientation of three unit vectors, chart-positive: −det[a, b, c].
#[inline]
fn orient_g(a: V3, b: V3, c: V3) -> f64 {
    let ux = b[0] - a[0];
    let uy = b[1] - a[1];
    let uz = b[2] - a[2];
    let wx = c[0] - a[0];
    let wy = c[1] - a[1];
    let wz = c[2] - a[2];
    -(a[0] * (uy * wz - uz * wy) + a[1] * (uz * wx - ux * wz) + a[2] * (ux * wy - uy * wx))
}

/// True when d lies strictly inside the circumcircle of the chart-counter-
/// clockwise spherical triangle abc.
#[inline]
fn in_circle_g(a: V3, b: V3, c: V3, d: V3) -> bool {
    let ux = b[0] - a[0];
    let uy = b[1] - a[1];
    let uz = b[2] - a[2];
    let wx = c[0] - a[0];
    let wy = c[1] - a[1];
    let wz = c[2] - a[2];
    let nx = uy * wz - uz * wy;
    let ny = uz * wx - ux * wz;
    let nz = ux * wy - uy * wx;
    let det = -((d[0] - a[0]) * nx + (d[1] - a[1]) * ny + (d[2] - a[2]) * nz);
    let ad = sq(a[0] - d[0]) + sq(a[1] - d[1]) + sq(a[2] - d[2]);
    let bd = sq(b[0] - d[0]) + sq(b[1] - d[1]) + sq(b[2] - d[2]);
    let cd = sq(c[0] - d[0]) + sq(c[1] - d[1]) + sq(c[2] - d[2]);
    let scale = ad * bd + bd * cd + cd * ad;
    det > INCIRCLE_EPS * scale + GLOBE_RADIAL_EPS * (nx.abs() + ny.abs() + nz.abs())
}

#[inline]
fn orient(ax: f64, ay: f64, bx: f64, by: f64, px: f64, py: f64) -> f64 {
    (bx - ax) * (py - ay) - (by - ay) * (px - ax)
}

/// True when d lies strictly inside the circumcircle of the counter-
/// clockwise triangle abc, all in one frame.
#[allow(clippy::too_many_arguments)]
#[inline]
fn in_circle(ax: f64, ay: f64, bx: f64, by: f64, cx: f64, cy: f64, dx: f64, dy: f64) -> bool {
    let adx = ax - dx;
    let ady = ay - dy;
    let bdx = bx - dx;
    let bdy = by - dy;
    let cdx = cx - dx;
    let cdy = cy - dy;
    let ad = adx * adx + ady * ady;
    let bd = bdx * bdx + bdy * bdy;
    let cd = cdx * cdx + cdy * cdy;
    let det =
        ad * (bdx * cdy - cdx * bdy) - bd * (adx * cdy - cdx * ady) + cd * (adx * bdy - bdx * ady);
    let scale = ad * bd + bd * cd + cd * ad;
    det > INCIRCLE_EPS * scale
}

pub struct PeriodicTriangulation {
    pub domain: Domain,
    /// Vertices: position (wrapped, float32 values), one outgoing halfedge
    /// (-1 when dead), alive. The length is the high-water mark of slots.
    pub vx: Vec<f64>,
    pub vy: Vec<f64>,
    pub v_edge: Vec<i32>,
    pub v_alive: Vec<u8>,
    pub alive_vertices: u32,
    free_vertices: Vec<u32>,
    /// Triangles: three vertex ids each, one twin per halfedge. The length
    /// of `t_alive` is the high-water mark of slots.
    pub tris: Vec<i32>,
    pub twin: Vec<i32>,
    pub t_alive: Vec<u8>,
    pub alive_triangles: u32,
    free_tris: Vec<u32>,
    /// The last triangle touched, the default walk start.
    pub last_tri: u32,
    pub walk_steps: u64,
    pub flips: u64,
    pub walk_fallbacks: u64,
    stack: Vec<u32>,
    pub globe: bool,
    /// Each slot's unit vector on the globe (x, y, z interleaved); empty on
    /// the torus.
    pub vu: Vec<f64>,
    to_lon: f64,
    to_colat: f64,
    radius: f64,
    version: u64,
    /// What the last `locate` found: the edge (0..2) the point lies on, or
    /// the corner (0..2) it coincides with; -1 for neither.
    pub on_edge: i32,
    pub at_vertex: i32,
    keeps_areas: bool,
    area_version: Vec<u64>,
    area_value: Vec<f64>,
    /// The planar Voronoi area's circumcentre scratch. A degenerate
    /// triangle leaves it as the last circumcentre wrote it, and the
    /// TypeScript engine reads it all the same; so does this port.
    last_cc: Cell<(f64, f64)>,
}

const NEVER: u64 = u64::MAX;

impl Clone for PeriodicTriangulation {
    /// An independent copy in the same state; the derived area cache starts
    /// empty and is not kept, as `clone()` in the TypeScript engine.
    fn clone(&self) -> Self {
        PeriodicTriangulation {
            domain: self.domain.clone(),
            vx: self.vx.clone(),
            vy: self.vy.clone(),
            v_edge: self.v_edge.clone(),
            v_alive: self.v_alive.clone(),
            alive_vertices: self.alive_vertices,
            free_vertices: self.free_vertices.clone(),
            tris: self.tris.clone(),
            twin: self.twin.clone(),
            t_alive: self.t_alive.clone(),
            alive_triangles: self.alive_triangles,
            free_tris: self.free_tris.clone(),
            last_tri: self.last_tri,
            walk_steps: self.walk_steps,
            flips: self.flips,
            walk_fallbacks: self.walk_fallbacks,
            stack: self.stack.clone(),
            globe: self.globe,
            vu: self.vu.clone(),
            to_lon: self.to_lon,
            to_colat: self.to_colat,
            radius: self.radius,
            version: 0,
            on_edge: self.on_edge,
            at_vertex: self.at_vertex,
            keeps_areas: false,
            area_version: Vec::new(),
            area_value: Vec::new(),
            last_cc: Cell::new((0.0, 0.0)),
        }
    }
}

impl PeriodicTriangulation {
    pub fn new(domain: Domain) -> Self {
        let globe = domain.is_sphere();
        let to_lon = (2.0 * std::f64::consts::PI) / domain.width;
        let to_colat = std::f64::consts::PI / domain.height;
        let radius = domain.width / (2.0 * std::f64::consts::PI);
        PeriodicTriangulation {
            domain,
            vx: Vec::new(),
            vy: Vec::new(),
            v_edge: Vec::new(),
            v_alive: Vec::new(),
            alive_vertices: 0,
            free_vertices: Vec::new(),
            tris: Vec::new(),
            twin: Vec::new(),
            t_alive: Vec::new(),
            alive_triangles: 0,
            free_tris: Vec::new(),
            last_tri: 0,
            walk_steps: 0,
            flips: 0,
            walk_fallbacks: 0,
            stack: Vec::new(),
            globe,
            vu: Vec::new(),
            to_lon,
            to_colat,
            radius,
            version: 0,
            on_edge: -1,
            at_vertex: -1,
            keeps_areas: false,
            area_version: Vec::new(),
            area_value: Vec::new(),
            last_cc: Cell::new((0.0, 0.0)),
        }
    }

    pub fn vertex_slots(&self) -> usize {
        self.vx.len()
    }

    pub fn tri_slots(&self) -> usize {
        self.t_alive.len()
    }

    /// Goes up with every change of a triangle, a twin, a vertex's edge or a
    /// vertex.
    pub fn geometry_version(&self) -> u64 {
        self.version
    }

    #[inline]
    fn t(&self, e: usize) -> usize {
        self.tris[e] as usize
    }

    #[inline]
    fn u(&self, v: usize) -> V3 {
        [self.vu[3 * v], self.vu[3 * v + 1], self.vu[3 * v + 2]]
    }

    // ---------------------------------------------------------------- frames

    /// The triangle's three corners unwrapped into the frame of its first:
    /// ax ay bx by cx cy.
    pub fn frame(&self, t: usize) -> [f64; 6] {
        let a = self.t(3 * t);
        let b = self.t(3 * t + 1);
        let c = self.t(3 * t + 2);
        let ax = self.vx[a];
        let ay = self.vy[a];
        let db = self.domain.delta(self.vx[b], self.vy[b], ax, ay);
        let dc = self.domain.delta(self.vx[c], self.vy[c], ax, ay);
        [ax, ay, ax + db.x, ay + db.y, ax + dc.x, ay + dc.y]
    }

    /// Squared length of halfedge e.
    pub fn edge_length_sq(&self, e: usize) -> f64 {
        let a = self.t(e);
        let b = self.t(next(e));
        if self.globe {
            let arc = self.radius * 2.0 * half_chord_asin(self.chord_sq(a, b).sqrt() / 2.0);
            return arc * arc;
        }
        self.domain
            .distance_sq(self.vx[a], self.vy[a], self.vx[b], self.vy[b])
    }

    pub fn edge_length(&self, e: usize) -> f64 {
        self.edge_length_sq(e).sqrt()
    }

    pub fn triangle_of(&self, e: usize) -> usize {
        tri_of(e)
    }

    /// The halfedge after e around the same origin, counter-clockwise.
    #[inline]
    pub fn rotate_ccw(&self, e: usize) -> usize {
        self.twin[prev(e)] as usize
    }

    pub fn from(&self, e: usize) -> usize {
        self.t(e)
    }

    pub fn to(&self, e: usize) -> usize {
        self.t(next(e))
    }

    /// The vertex of e's triangle that is not on e.
    pub fn apex(&self, e: usize) -> usize {
        self.t(prev(e))
    }

    pub fn degree(&self, v: usize) -> usize {
        let start = self.v_edge[v] as usize;
        let mut e = start;
        let mut n = 0;
        loop {
            n += 1;
            e = self.rotate_ccw(e);
            if e == start {
                return n;
            }
        }
    }

    /// Neighbour vertex ids of v, counter-clockwise, into `out` (cleared).
    pub fn neighbours(&self, v: usize, out: &mut Vec<u32>) {
        out.clear();
        let start = self.v_edge[v] as usize;
        let mut e = start;
        loop {
            out.push(self.to(e) as u32);
            e = self.rotate_ccw(e);
            if e == start {
                return;
            }
        }
    }

    /// Outgoing halfedges of v, counter-clockwise, into `out` (cleared).
    pub fn outgoing(&self, v: usize, out: &mut Vec<u32>) {
        out.clear();
        let start = self.v_edge[v] as usize;
        let mut e = start;
        loop {
            out.push(e as u32);
            e = self.rotate_ccw(e);
            if e == start {
                return;
            }
        }
    }

    /// Circumcentre of triangle t relative to its first corner; None for a
    /// degenerate triangle. The torus's: panics on the globe, where the
    /// circumcentre is [`PeriodicTriangulation::circumcentre_on_globe`].
    pub fn circumcentre(&self, t: usize) -> Option<(f64, f64)> {
        assert!(
            !self.globe,
            "PeriodicTriangulation.circumcentre: a plane offset; on the globe use circumcentre_on_globe"
        );
        let f = self.frame(t);
        let bx = f[2] - f[0];
        let by = f[3] - f[1];
        let cx = f[4] - f[0];
        let cy = f[5] - f[1];
        let d = 2.0 * (bx * cy - by * cx);
        if d == 0.0 {
            return None;
        }
        let b2 = bx * bx + by * by;
        let c2 = cx * cx + cy * cy;
        Some(((cy * b2 - by * c2) / d, (bx * c2 - cx * b2) / d))
    }

    /// Keep each slot's Voronoi area between changes of the geometry.
    pub fn keep_areas(&mut self) {
        self.keeps_areas = true;
    }

    /// Voronoi cell area of v. Sums to the domain's area over all vertices.
    pub fn voronoi_area(&mut self, v: usize) -> f64 {
        if !self.keeps_areas {
            return self.voronoi_area_uncached(v);
        }
        if v < self.area_version.len() && self.area_version[v] == self.version {
            return self.area_value[v];
        }
        let area = self.voronoi_area_uncached(v);
        if v >= self.area_version.len() {
            let size = (v + 1).max(self.vx.len());
            self.area_version.resize(size, NEVER);
            self.area_value.resize(size, 0.0);
        }
        self.area_version[v] = self.version;
        self.area_value[v] = area;
        area
    }

    fn voronoi_area_uncached(&self, v: usize) -> f64 {
        if self.globe {
            self.voronoi_area_on_globe(v)
        } else {
            self.voronoi_area_planar(v)
        }
    }

    fn voronoi_area_planar(&self, v: usize) -> f64 {
        let vx = self.vx[v];
        let vy = self.vy[v];
        let start = self.v_edge[v] as usize;
        let mut e = start;
        let mut area = 0.0;
        let mut first_x = 0.0;
        let mut first_y = 0.0;
        let mut prev_x = 0.0;
        let mut prev_y = 0.0;
        let mut first = true;
        loop {
            let t = tri_of(e);
            let a = self.t(3 * t);
            if let Some(c) = self.circumcentre(t) {
                self.last_cc.set(c);
            }
            let (ccx, ccy) = self.last_cc.get();
            let d = self.domain.delta(self.vx[a], self.vy[a], vx, vy);
            let ax = vx + d.x;
            let ay = vy + d.y;
            let x = ax + ccx - vx;
            let y = ay + ccy - vy;
            if first {
                first_x = x;
                first_y = y;
                first = false;
            } else {
                area += prev_x * y - x * prev_y;
            }
            prev_x = x;
            prev_y = y;
            e = self.rotate_ccw(e);
            if e == start {
                break;
            }
        }
        area += prev_x * first_y - first_x * prev_y;
        area / 2.0
    }

    /// Barycentric weights of (x, y) in triangle t, clamped to the simplex.
    pub fn barycentric(&self, t: usize, x: f64, y: f64) -> [f64; 3] {
        if self.globe {
            return self.barycentric_on_globe(t, x, y);
        }
        let f = self.frame(t);
        let bd = self.domain.delta(x, y, f[0], f[1]);
        let px = f[0] + bd.x;
        let py = f[1] + bd.y;
        let v0x = f[2] - f[0];
        let v0y = f[3] - f[1];
        let v1x = f[4] - f[0];
        let v1y = f[5] - f[1];
        let v2x = px - f[0];
        let v2y = py - f[1];
        let den = v0x * v1y - v1x * v0y;
        let mut wb = (v2x * v1y - v1x * v2y) / den;
        let mut wc = (v0x * v2y - v2x * v0y) / den;
        wb = js::min(1.0, js::max(0.0, wb));
        wc = js::min(1.0, js::max(0.0, wc));
        let wa = js::max(0.0, 1.0 - wb - wc);
        let s = wa + wb + wc;
        [wa / s, wb / s, wc / s]
    }

    // ---------------------------------------------------------- the globe

    /// The unit vector of chart point (x, y): (sin θ cos λ, sin θ sin λ,
    /// cos θ).
    fn unit_of(&self, x: f64, y: f64) -> V3 {
        let t = y * self.to_colat;
        let l = x * self.to_lon;
        let st = det_sin(t);
        [st * det_cos(l), st * det_sin(l), det_cos(t)]
    }

    /// The chart point a vertex is stored at, from any (x, y).
    fn chart_point(&self, x: f64, y: f64) -> (f64, f64) {
        let p = self.domain.wrap_point(x, y);
        (self.domain.wrap_x(js::fround(p.x)), js::fround(p.y))
    }

    fn orient_ids(&self, a: usize, b: usize, c: usize) -> f64 {
        orient_g(self.u(a), self.u(b), self.u(c))
    }

    fn in_circle_ids(&self, a: usize, b: usize, c: usize, d: usize) -> bool {
        in_circle_g(self.u(a), self.u(b), self.u(c), self.u(d))
    }

    /// Squared chord between two vertices on the unit sphere.
    fn chord_sq(&self, a: usize, b: usize) -> f64 {
        let i = 3 * a;
        let j = 3 * b;
        let dx = self.vu[i] - self.vu[j];
        let dy = self.vu[i + 1] - self.vu[j + 1];
        let dz = self.vu[i + 2] - self.vu[j + 2];
        dx * dx + dy * dy + dz * dz
    }

    fn orient_margin_ids(&self, a: usize, d: usize, p: usize) -> f64 {
        ORIENT_EPS * (self.chord_sq(d, a) + self.chord_sq(p, a))
    }

    /// Circumcentre of triangle t on the unit sphere: the outward normal of
    /// the plane through its corners. None when degenerate.
    pub fn circumcentre_on_globe(&self, t: usize) -> Option<V3> {
        let a = self.u(self.t(3 * t));
        let b = self.u(self.t(3 * t + 1));
        let c = self.u(self.t(3 * t + 2));
        let ux = b[0] - a[0];
        let uy = b[1] - a[1];
        let uz = b[2] - a[2];
        let wx = c[0] - a[0];
        let wy = c[1] - a[1];
        let wz = c[2] - a[2];
        let nx = uz * wy - uy * wz;
        let ny = ux * wz - uz * wx;
        let nz = uy * wx - ux * wy;
        let l = (nx * nx + ny * ny + nz * nz).sqrt();
        if l == 0.0 {
            return None;
        }
        Some([nx / l, ny / l, nz / l])
    }

    fn voronoi_area_on_globe(&self, v: usize) -> f64 {
        let vv = self.u(v);
        let slice = |p: V3, q: V3| -> f64 {
            let num = orient_g(vv, p, q);
            let den = 1.0
                + (vv[0] * p[0] + vv[1] * p[1] + vv[2] * p[2])
                + (p[0] * q[0] + p[1] * q[1] + p[2] * q[2])
                + (q[0] * vv[0] + q[1] * vv[1] + q[2] * vv[2]);
            2.0 * det_atan2(num, den)
        };
        let start = self.v_edge[v] as usize;
        let mut e = start;
        let mut prev_c = [0.0; 3];
        let mut first_c = [0.0; 3];
        let mut first = true;
        let mut excess = 0.0;
        loop {
            let cur = self.circumcentre_on_globe(tri_of(e)).unwrap_or(vv);
            if first {
                first_c = cur;
                first = false;
            } else {
                excess += slice(prev_c, cur);
            }
            prev_c = cur;
            e = self.rotate_ccw(e);
            if e == start {
                break;
            }
        }
        excess += slice(prev_c, first_c);
        excess * self.radius * self.radius
    }

    fn barycentric_on_globe(&self, t: usize, x: f64, y: f64) -> [f64; 3] {
        let q = self.unit_of(x, y);
        let a = self.u(self.t(3 * t));
        let b = self.u(self.t(3 * t + 1));
        let c = self.u(self.t(3 * t + 2));
        let wa = js::max(0.0, orient_g(b, c, q));
        let wb = js::max(0.0, orient_g(c, a, q));
        let wc = js::max(0.0, orient_g(a, b, q));
        let s = wa + wb + wc;
        if s == 0.0 {
            return [1.0 / 3.0; 3];
        }
        [wa / s, wb / s, wc / s]
    }

    fn hint_or_any(&self, hint: usize) -> usize {
        if hint < self.tri_slots() && self.t_alive[hint] != 0 {
            hint
        } else {
            self.any_alive_triangle()
        }
    }

    fn locate_on_globe(&mut self, x: f64, y: f64, hint: usize) -> usize {
        let mut t = self.hint_or_any(hint);
        let q = self.unit_of(x, y);
        let max_steps = self.tri_slots() * 2 + 16;
        let mut steps = 0;
        loop {
            let a = self.u(self.t(3 * t));
            let b = self.u(self.t(3 * t + 1));
            let c = self.u(self.t(3 * t + 2));
            let o0 = orient_g(a, b, q);
            let o1 = orient_g(b, c, q);
            let o2 = orient_g(c, a, q);
            let mut cross = usize::MAX;
            let mut worst = 0.0;
            if o0 < worst {
                worst = o0;
                cross = 0;
            }
            if o1 < worst {
                worst = o1;
                cross = 1;
            }
            if o2 < worst {
                cross = 2;
            }
            if cross == usize::MAX {
                self.classify_on_globe(t, o0, o1, o2);
                self.walk_steps += steps as u64;
                self.last_tri = t as u32;
                return t;
            }
            t = tri_of(self.twin[3 * t + cross] as usize);
            steps += 1;
            if steps > max_steps {
                self.walk_fallbacks += 1;
                return self.scan_on_globe(q);
            }
        }
    }

    /// Every triangle, the one whose least orientation toward the query is
    /// largest, the first of equals.
    fn scan_on_globe(&mut self, q: V3) -> usize {
        let mut best = usize::MAX;
        let mut best_min = f64::NEG_INFINITY;
        let (mut b0, mut b1, mut b2) = (0.0, 0.0, 0.0);
        for t in 0..self.tri_slots() {
            if self.t_alive[t] == 0 {
                continue;
            }
            let a = self.u(self.t(3 * t));
            let b = self.u(self.t(3 * t + 1));
            let c = self.u(self.t(3 * t + 2));
            let o0 = orient_g(a, b, q);
            let o1 = orient_g(b, c, q);
            let o2 = orient_g(c, a, q);
            let m = js::min(js::min(o0, o1), o2);
            if m > best_min {
                best_min = m;
                best = t;
                b0 = o0;
                b1 = o1;
                b2 = o2;
            }
        }
        assert!(best != usize::MAX, "PeriodicTriangulation: no triangles");
        self.classify_on_globe(best, b0, b1, b2);
        self.last_tri = best as u32;
        best
    }

    fn classify_on_globe(&mut self, t: usize, o0: f64, o1: f64, o2: f64) {
        let a = self.t(3 * t);
        let b = self.t(3 * t + 1);
        let c = self.t(3 * t + 2);
        let e0 = o0 <= ON_EDGE_EPS * self.chord_sq(a, b);
        let e1 = o1 <= ON_EDGE_EPS * self.chord_sq(b, c);
        let e2 = o2 <= ON_EDGE_EPS * self.chord_sq(c, a);
        self.set_classification(e0, e1, e2);
    }

    fn set_classification(&mut self, e0: bool, e1: bool, e2: bool) {
        self.on_edge = -1;
        self.at_vertex = -1;
        if e0 && e2 {
            self.at_vertex = 0;
        } else if e0 && e1 {
            self.at_vertex = 1;
        } else if e1 && e2 {
            self.at_vertex = 2;
        } else if e0 {
            self.on_edge = 0;
        } else if e1 {
            self.on_edge = 1;
        } else if e2 {
            self.on_edge = 2;
        }
    }

    // -------------------------------------------------------------- location

    /// The triangle containing (x, y), by a straight walk from `hint` (the
    /// last triangle touched when None). `on_edge` and `at_vertex` tell
    /// where on it the point lies.
    pub fn locate(&mut self, x: f64, y: f64, hint: Option<usize>) -> usize {
        let hint = hint.unwrap_or(self.last_tri as usize);
        if self.globe {
            return self.locate_on_globe(x, y, hint);
        }
        let mut t = self.hint_or_any(hint);
        let max_steps = self.tri_slots() * 2 + 16;
        let mut steps = 0;
        let width = self.domain.width;
        let height = self.domain.height;
        let mut f = self.frame(t);
        let d = self.domain.delta(x, y, f[0], f[1]);
        let mut carried_x = f[0] + d.x;
        let mut carried_y = f[1] + d.y;
        loop {
            let d = self.domain.delta(x, y, f[0], f[1]);
            let mut px = f[0] + d.x;
            let mut py = f[1] + d.y;
            if (px - carried_x).abs() > width / 2.0 {
                px = carried_x;
            }
            if (py - carried_y).abs() > height / 2.0 {
                py = carried_y;
            }
            let o0 = orient(f[0], f[1], f[2], f[3], px, py);
            let o1 = orient(f[2], f[3], f[4], f[5], px, py);
            let o2 = orient(f[4], f[5], f[0], f[1], px, py);
            let mut cross = usize::MAX;
            let mut worst = 0.0;
            if o0 < worst {
                worst = o0;
                cross = 0;
            }
            if o1 < worst {
                worst = o1;
                cross = 1;
            }
            if o2 < worst {
                cross = 2;
            }
            if cross == usize::MAX {
                self.classify(&f, o0, o1, o2);
                self.walk_steps += steps as u64;
                self.last_tri = t as u32;
                return t;
            }
            let end = 2 * ((cross + 1) % 3);
            let old_x = f[end];
            let old_y = f[end + 1];
            let e2 = self.twin[3 * t + cross] as usize;
            t = tri_of(e2);
            let j = 2 * (e2 - 3 * t);
            f = self.frame(t);
            carried_x = px + (f[j] - old_x);
            carried_y = py + (f[j + 1] - old_y);
            steps += 1;
            assert!(
                steps <= max_steps,
                "PeriodicTriangulation.locate: walk did not terminate"
            );
        }
    }

    fn classify(&mut self, f: &[f64; 6], o0: f64, o1: f64, o2: f64) {
        let l0 = sq(f[2] - f[0]) + sq(f[3] - f[1]);
        let l1 = sq(f[4] - f[2]) + sq(f[5] - f[3]);
        let l2 = sq(f[0] - f[4]) + sq(f[1] - f[5]);
        self.set_classification(
            o0 <= ON_EDGE_EPS * l0,
            o1 <= ON_EDGE_EPS * l1,
            o2 <= ON_EDGE_EPS * l2,
        );
    }

    fn any_alive_triangle(&self) -> usize {
        self.t_alive
            .iter()
            .position(|&a| a != 0)
            .expect("PeriodicTriangulation: no triangles")
    }

    // -------------------------------------------------------------- capacity

    fn new_vertex(&mut self, x: f64, y: f64) -> usize {
        let v = match self.free_vertices.pop() {
            Some(v) => v as usize,
            None => {
                self.vx.push(0.0);
                self.vy.push(0.0);
                self.v_edge.push(-1);
                self.v_alive.push(0);
                if self.globe {
                    self.vu.extend_from_slice(&[0.0; 3]);
                }
                self.vx.len() - 1
            }
        };
        if self.globe {
            let (cx, cy) = self.chart_point(x, y);
            self.vx[v] = cx;
            self.vy[v] = cy;
            let u = self.unit_of(cx, cy);
            self.vu[3 * v..3 * v + 3].copy_from_slice(&u);
        } else {
            self.vx[v] = self.domain.wrap_x(js::fround(self.domain.wrap_x(x)));
            self.vy[v] = self.domain.wrap_y(js::fround(self.domain.wrap_y(y)));
        }
        self.v_alive[v] = 1;
        self.alive_vertices += 1;
        self.version += 1;
        v
    }

    fn new_triangle(&mut self) -> usize {
        let t = match self.free_tris.pop() {
            Some(t) => t as usize,
            None => {
                self.tris.extend_from_slice(&[-1; 3]);
                self.twin.extend_from_slice(&[-1; 3]);
                self.t_alive.push(0);
                self.t_alive.len() - 1
            }
        };
        self.t_alive[t] = 1;
        self.alive_triangles += 1;
        t
    }

    fn free_triangle(&mut self, t: usize) {
        self.version += 1;
        self.t_alive[t] = 0;
        self.alive_triangles -= 1;
        self.tris[3 * t..3 * t + 3].fill(-1);
        self.twin[3 * t..3 * t + 3].fill(-1);
        self.free_tris.push(t as u32);
    }

    fn set_triangle(&mut self, t: usize, a: usize, b: usize, c: usize) {
        self.version += 1;
        let base = 3 * t;
        self.tris[base] = a as i32;
        self.tris[base + 1] = b as i32;
        self.tris[base + 2] = c as i32;
        self.v_edge[a] = base as i32;
        self.v_edge[b] = base as i32 + 1;
        self.v_edge[c] = base as i32 + 2;
    }

    fn pair(&mut self, e1: usize, e2: usize) {
        self.version += 1;
        self.twin[e1] = e2 as i32;
        self.twin[e2] = e1 as i32;
    }

    // ------------------------------------------------------------- insertion

    /// Inserts a point and returns its vertex id. A point coinciding with an
    /// existing vertex returns that vertex and inserts nothing.
    pub fn insert(&mut self, mut x: f64, mut y: f64, hint: Option<usize>) -> usize {
        if self.globe {
            (x, y) = self.chart_point(x, y);
        }
        let t = self.locate(x, y, hint);
        if self.at_vertex >= 0 {
            return self.t(3 * t + self.at_vertex as usize);
        }
        let p = self.new_vertex(x, y);
        if self.on_edge >= 0 {
            self.split_edge(3 * t + self.on_edge as usize, p);
        } else {
            self.split_triangle(t, p);
        }
        self.legalise();
        self.last_tri = tri_of(self.v_edge[p] as usize) as u32;
        p
    }

    fn split_triangle(&mut self, t: usize, p: usize) {
        let a = self.t(3 * t);
        let b = self.t(3 * t + 1);
        let c = self.t(3 * t + 2);
        let tab = self.twin[3 * t] as usize;
        let tbc = self.twin[3 * t + 1] as usize;
        let tca = self.twin[3 * t + 2] as usize;
        let t1 = self.new_triangle();
        let t2 = self.new_triangle();
        self.set_triangle(t, a, b, p);
        self.set_triangle(t1, b, c, p);
        self.set_triangle(t2, c, a, p);
        self.pair(3 * t, tab);
        self.pair(3 * t1, tbc);
        self.pair(3 * t2, tca);
        self.pair(3 * t + 1, 3 * t1 + 2);
        self.pair(3 * t1 + 1, 3 * t2 + 2);
        self.pair(3 * t2 + 1, 3 * t + 2);
        self.stack
            .extend_from_slice(&[3 * t as u32, 3 * t1 as u32, 3 * t2 as u32]);
    }

    fn split_edge(&mut self, e: usize, p: usize) {
        let t = tri_of(e);
        let e2 = self.twin[e] as usize;
        let t2 = tri_of(e2);
        let a = self.t(e);
        let b = self.to(e);
        let c = self.apex(e);
        let d = self.apex(e2);
        let tca = self.twin[prev(e)] as usize;
        let tbc = self.twin[next(e)] as usize;
        let tdb = self.twin[prev(e2)] as usize;
        let tad = self.twin[next(e2)] as usize;
        let t3 = self.new_triangle();
        let t4 = self.new_triangle();
        self.set_triangle(t, a, p, c);
        self.set_triangle(t2, b, p, d);
        self.set_triangle(t3, p, b, c);
        self.set_triangle(t4, p, a, d);
        self.pair(3 * t + 2, tca);
        self.pair(3 * t2 + 2, tdb);
        self.pair(3 * t3 + 1, tbc);
        self.pair(3 * t4 + 1, tad);
        self.pair(3 * t, 3 * t4);
        self.pair(3 * t + 1, 3 * t3 + 2);
        self.pair(3 * t3, 3 * t2);
        self.pair(3 * t2 + 1, 3 * t4 + 2);
        self.stack.extend_from_slice(&[
            (3 * t + 2) as u32,
            (3 * t2 + 2) as u32,
            (3 * t3 + 1) as u32,
            (3 * t4 + 1) as u32,
        ]);
    }

    /// Flips halfedge e (a→b, apex p; twin b→a, apex d) into p–d.
    fn flip(&mut self, e: usize) {
        let t = tri_of(e);
        let e2 = self.twin[e] as usize;
        let t2 = tri_of(e2);
        let a = self.t(e);
        let b = self.to(e);
        let p = self.apex(e);
        let d = self.apex(e2);
        let tbp = self.twin[next(e)] as usize;
        let tpa = self.twin[prev(e)] as usize;
        let tad = self.twin[next(e2)] as usize;
        let tdb = self.twin[prev(e2)] as usize;
        self.set_triangle(t, a, d, p);
        self.set_triangle(t2, d, b, p);
        self.pair(3 * t, tad);
        self.pair(3 * t + 2, tpa);
        self.pair(3 * t2, tdb);
        self.pair(3 * t2 + 1, tbp);
        self.pair(3 * t + 1, 3 * t2 + 2);
        self.flips += 1;
    }

    /// Lawson legalisation over the stack.
    fn legalise(&mut self) {
        if self.globe {
            self.legalise_on_globe();
            return;
        }
        while let Some(e) = self.stack.pop() {
            let e = e as usize;
            let t = tri_of(e);
            if self.t_alive[t] == 0 {
                continue;
            }
            let i = e - 3 * t;
            let f = self.frame(t);
            let ax = f[(2 * i) % 6];
            let ay = f[(2 * i + 1) % 6];
            let bx = f[(2 * i + 2) % 6];
            let by = f[(2 * i + 3) % 6];
            let px = f[(2 * i + 4) % 6];
            let py = f[(2 * i + 5) % 6];
            let dv = self.apex(self.twin[e] as usize);
            let d = self.domain.delta(self.vx[dv], self.vy[dv], ax, ay);
            let dx = ax + d.x;
            let dy = ay + d.y;
            if !in_circle(ax, ay, bx, by, px, py, dx, dy) {
                continue;
            }
            let scale = sq(dx - ax) + sq(dy - ay) + sq(px - ax) + sq(py - ay);
            if orient(ax, ay, dx, dy, px, py) <= ORIENT_EPS * scale {
                continue;
            }
            if orient(dx, dy, bx, by, px, py) <= ORIENT_EPS * scale {
                continue;
            }
            let t2 = tri_of(self.twin[e] as usize);
            self.flip(e);
            self.stack.extend_from_slice(&[
                3 * t as u32,
                (3 * t + 2) as u32,
                3 * t2 as u32,
                (3 * t2 + 1) as u32,
            ]);
        }
    }

    fn legalise_on_globe(&mut self) {
        while let Some(e) = self.stack.pop() {
            let e = e as usize;
            let t = tri_of(e);
            if self.t_alive[t] == 0 {
                continue;
            }
            let a = self.t(e);
            let b = self.to(e);
            let p = self.apex(e);
            let dv = self.apex(self.twin[e] as usize);
            if !self.in_circle_ids(a, b, p, dv) {
                continue;
            }
            let margin = self.orient_margin_ids(a, dv, p);
            if self.orient_ids(a, dv, p) <= margin {
                continue;
            }
            if self.orient_ids(dv, b, p) <= margin {
                continue;
            }
            let t2 = tri_of(self.twin[e] as usize);
            self.flip(e);
            self.stack.extend_from_slice(&[
                3 * t as u32,
                (3 * t + 2) as u32,
                3 * t2 as u32,
                (3 * t2 + 1) as u32,
            ]);
        }
    }

    /// Legalises every edge of the triangulation.
    pub fn legalise_all(&mut self) {
        for t in 0..self.tri_slots() {
            if self.t_alive[t] == 0 {
                continue;
            }
            self.stack
                .extend_from_slice(&[3 * t as u32, (3 * t + 1) as u32, (3 * t + 2) as u32]);
        }
        self.legalise();
    }

    // --------------------------------------------------------------- removal

    /// Removes vertex v. Returns false, and changes nothing, when the removal
    /// would leave an edge longer than the one-sheet margin or the mesh has
    /// too few vertices to stay a triangulation.
    pub fn remove(&mut self, v: usize) -> bool {
        if v >= self.vertex_slots() || self.v_alive[v] == 0 || self.alive_vertices <= 4 {
            return false;
        }
        let max_len_sq = sq(js::min(self.domain.width, self.domain.height) * MAX_EDGE_FRACTION);
        let mut star = Vec::with_capacity(16);
        self.outgoing(v, &mut star);
        let chord_below = if self.globe {
            max_len_sq / (sq(self.radius * std::f64::consts::PI / 2.0) * (1.0 + 1e-9))
        } else {
            -1.0
        };
        let n = star.len();
        for i in 0..n {
            let a = self.to(star[i] as usize);
            for &sj in &star[i + 1..n] {
                let b = self.to(sj as usize);
                if self.globe && self.chord_sq(a, b) < chord_below {
                    continue;
                }
                if self
                    .domain
                    .distance_sq(self.vx[a], self.vy[a], self.vx[b], self.vy[b])
                    > max_len_sq
                {
                    return false;
                }
            }
        }
        let mut touched: Vec<usize> = Vec::new();
        while star.len() > 3 {
            let n = star.len();
            let mut chosen = usize::MAX;
            let mut fallback = usize::MAX;
            for i in 0..n {
                if !self.is_ear(&star, i) {
                    continue;
                }
                if fallback == usize::MAX {
                    fallback = i;
                }
                if self.ear_is_delaunay(&star, star[i] as usize) {
                    chosen = i;
                    break;
                }
            }
            if chosen == usize::MAX {
                chosen = fallback;
            }
            assert!(
                chosen != usize::MAX,
                "PeriodicTriangulation.remove: the link polygon has no ear"
            );
            let e = star[chosen] as usize;
            let t2 = tri_of(self.twin[e] as usize);
            self.flip(e);
            touched.push(tri_of(e));
            touched.push(t2);
            self.outgoing(v, &mut star);
        }
        let e0 = star[0] as usize;
        let e1 = star[1] as usize;
        let e2 = star[2] as usize;
        let t0 = tri_of(e0);
        let t1 = tri_of(e1);
        let t2 = tri_of(e2);
        let u0 = self.to(e0);
        let u1 = self.to(e1);
        let u2 = self.to(e2);
        let t01 = self.twin[next(e0)] as usize;
        let t12 = self.twin[next(e1)] as usize;
        let t20 = self.twin[next(e2)] as usize;
        self.free_triangle(t1);
        self.free_triangle(t2);
        self.set_triangle(t0, u0, u1, u2);
        self.pair(3 * t0, t01);
        self.pair(3 * t0 + 1, t12);
        self.pair(3 * t0 + 2, t20);
        self.v_alive[v] = 0;
        self.v_edge[v] = -1;
        self.version += 1;
        self.alive_vertices -= 1;
        self.free_vertices.push(v as u32);
        self.stack
            .extend_from_slice(&[3 * t0 as u32, (3 * t0 + 1) as u32, (3 * t0 + 2) as u32]);
        for t in touched {
            if self.t_alive[t] != 0 {
                self.stack.extend_from_slice(&[
                    3 * t as u32,
                    (3 * t + 1) as u32,
                    (3 * t + 2) as u32,
                ]);
            }
        }
        self.legalise();
        self.last_tri = t0 as u32;
        true
    }

    /// Whether link vertex i of the star is an ear of the link polygon.
    fn is_ear(&self, star: &[u32], i: usize) -> bool {
        let n = star.len();
        let u = self.to(star[i] as usize);
        let r = self.to(star[(i + n - 1) % n] as usize);
        let l = self.to(star[(i + 1) % n] as usize);
        if self.globe {
            if self.orient_ids(r, u, l) <= self.orient_margin_ids(r, u, l) {
                return false;
            }
            for &s in star {
                let w = self.to(s as usize);
                if w == u || w == r || w == l {
                    continue;
                }
                if self.orient_ids(r, u, w) >= 0.0
                    && self.orient_ids(u, l, w) >= 0.0
                    && self.orient_ids(l, r, w) >= 0.0
                {
                    return false;
                }
            }
            return true;
        }
        let rx = self.vx[r];
        let ry = self.vy[r];
        let d = self.domain.delta(self.vx[u], self.vy[u], rx, ry);
        let ux = rx + d.x;
        let uy = ry + d.y;
        let d = self.domain.delta(self.vx[l], self.vy[l], rx, ry);
        let lx = rx + d.x;
        let ly = ry + d.y;
        let area = orient(rx, ry, ux, uy, lx, ly);
        let scale = sq(ux - rx) + sq(uy - ry) + sq(lx - rx) + sq(ly - ry);
        if area <= ORIENT_EPS * scale {
            return false;
        }
        for &s in star {
            let w = self.to(s as usize);
            if w == u || w == r || w == l {
                continue;
            }
            let d = self.domain.delta(self.vx[w], self.vy[w], rx, ry);
            let wx = rx + d.x;
            let wy = ry + d.y;
            if orient(rx, ry, ux, uy, wx, wy) >= 0.0
                && orient(ux, uy, lx, ly, wx, wy) >= 0.0
                && orient(lx, ly, rx, ry, wx, wy) >= 0.0
            {
                return false;
            }
        }
        true
    }

    /// Whether the triangle a flip of star edge e would create outside v has
    /// none of the other link vertices in its circumcircle.
    fn ear_is_delaunay(&self, star: &[u32], e: usize) -> bool {
        let u = self.to(e);
        let l = self.apex(e);
        let r = self.apex(self.twin[e] as usize);
        if self.globe {
            for &s in star {
                let w = self.to(s as usize);
                if w == u || w == l || w == r {
                    continue;
                }
                if self.in_circle_ids(r, u, l, w) {
                    return false;
                }
            }
            return true;
        }
        let rx = self.vx[r];
        let ry = self.vy[r];
        let d = self.domain.delta(self.vx[u], self.vy[u], rx, ry);
        let ux = rx + d.x;
        let uy = ry + d.y;
        let d = self.domain.delta(self.vx[l], self.vy[l], rx, ry);
        let lx = rx + d.x;
        let ly = ry + d.y;
        for &s in star {
            let w = self.to(s as usize);
            if w == u || w == l || w == r {
                continue;
            }
            let d = self.domain.delta(self.vx[w], self.vy[w], rx, ry);
            if in_circle(rx, ry, ux, uy, lx, ly, rx + d.x, ry + d.y) {
                return false;
            }
        }
        true
    }

    /// The orientation of triangle t as stored, chart-positive.
    pub fn orient_of(&self, t: usize) -> f64 {
        if self.globe {
            return self.orient_ids(self.t(3 * t), self.t(3 * t + 1), self.t(3 * t + 2));
        }
        let f = self.frame(t);
        (f[2] - f[0]) * (f[5] - f[1]) - (f[3] - f[1]) * (f[4] - f[0])
    }

    // ------------------------------------------------------------ validation

    /// Structural check: twins, winding, vertex edges, Euler's formula, the
    /// edge margin, the empty-circumcircle property, and on the sphere the
    /// Voronoi cells summing to 4πR². Returns the violations.
    pub fn validate(&mut self, check_delaunay: bool) -> Vec<String> {
        let mut errors = Vec::new();
        let mut alive_t = 0u32;
        let max_len_sq = sq(js::min(self.domain.width, self.domain.height) * MAX_EDGE_FRACTION);
        let mut max_edge_sq = 0.0;
        let mut non_delaunay = 0;
        for t in 0..self.tri_slots() {
            if self.t_alive[t] == 0 {
                continue;
            }
            alive_t += 1;
            for i in 0..3 {
                let e = 3 * t + i;
                let v = self.tris[e];
                if v < 0 || self.v_alive[v as usize] == 0 {
                    errors.push(format!("triangle {t} references dead vertex {v}"));
                }
                let w = self.twin[e];
                if w < 0 || self.t_alive[tri_of(w as usize)] == 0 {
                    errors.push(format!("halfedge {e} has no live twin"));
                } else if self.twin[w as usize] != e as i32 {
                    errors.push(format!("halfedge {e} twin mismatch"));
                } else if self.t(w as usize) != self.to(e) || self.to(w as usize) != self.t(e) {
                    errors.push(format!("halfedge {e} twin runs the wrong way"));
                }
                let lsq = self.edge_length_sq(e);
                if lsq > max_edge_sq {
                    max_edge_sq = lsq;
                }
            }
            if self.globe {
                let (a, b, c) = (self.t(3 * t), self.t(3 * t + 1), self.t(3 * t + 2));
                if self.orient_ids(a, b, c) <= 0.0 {
                    errors.push(format!("triangle {t} not counter-clockwise on the globe"));
                }
                if check_delaunay {
                    for i in 0..3 {
                        let e = 3 * t + i;
                        if self.in_circle_ids(
                            self.t(e),
                            self.to(e),
                            self.apex(e),
                            self.apex(self.twin[e] as usize),
                        ) {
                            non_delaunay += 1;
                        }
                    }
                }
                continue;
            }
            let f = self.frame(t);
            if orient(f[0], f[1], f[2], f[3], f[4], f[5]) <= 0.0 {
                errors.push(format!("triangle {t} not counter-clockwise"));
            }
            if check_delaunay {
                for i in 0..3 {
                    let e = 3 * t + i;
                    let dv = self.apex(self.twin[e] as usize);
                    let d = self.domain.delta(self.vx[dv], self.vy[dv], f[0], f[1]);
                    if in_circle(f[0], f[1], f[2], f[3], f[4], f[5], f[0] + d.x, f[1] + d.y) {
                        non_delaunay += 1;
                    }
                }
            }
        }
        if non_delaunay > 0 {
            errors.push(format!(
                "{non_delaunay} halfedges violate the empty-circumcircle property"
            ));
        }
        if max_edge_sq > max_len_sq {
            errors.push(format!(
                "longest edge {:.2} exceeds the one-sheet margin {:.2}",
                max_edge_sq.sqrt(),
                max_len_sq.sqrt()
            ));
        }
        let mut alive_v = 0u32;
        for v in 0..self.vertex_slots() {
            if self.v_alive[v] == 0 {
                continue;
            }
            alive_v += 1;
            let e = self.v_edge[v];
            if e < 0 || self.t_alive[tri_of(e as usize)] == 0 || self.tris[e as usize] != v as i32 {
                errors.push(format!("vertex {v} edge pointer stale"));
            } else if self.degree(v) < 3 {
                errors.push(format!("vertex {v} has degree {}", self.degree(v)));
            }
        }
        if alive_t != self.alive_triangles {
            errors.push(format!(
                "triangle count {} vs {alive_t} alive",
                self.alive_triangles
            ));
        }
        if alive_v != self.alive_vertices {
            errors.push(format!(
                "vertex count {} vs {alive_v} alive",
                self.alive_vertices
            ));
        }
        if self.globe {
            if alive_t as i64 != 2 * alive_v as i64 - 4 {
                errors.push(format!(
                    "Euler: {alive_t} triangles for {alive_v} vertices (the sphere needs 2V − 4)"
                ));
            }
            let mut area = 0.0;
            for v in 0..self.vertex_slots() {
                if self.v_alive[v] != 0 {
                    area += self.voronoi_area(v);
                }
            }
            let sphere = (self.domain.width * self.domain.width) / std::f64::consts::PI;
            // A NaN sum fails too.
            if (area - sphere).abs().is_nan() || (area - sphere).abs() > 1e-9 * sphere {
                errors.push(format!(
                    "Voronoi areas sum to {area} against the sphere's {sphere}"
                ));
            }
        } else if alive_t != 2 * alive_v {
            errors.push(format!(
                "Euler: {alive_t} triangles for {alive_v} vertices (torus needs 2V)"
            ));
        }
        errors
    }

    /// A triangulation from an explicit triangle list: the bootstrap
    /// lattice, and a mesh read back from a save. Triangles may come in either
    /// orientation; they are stored counter-clockwise. Every edge must have
    /// exactly two sides and no two distinct edges may join the same pair.
    pub fn from_triangles(
        domain: Domain,
        xs: &[f64],
        ys: &[f64],
        triangles: &[u32],
    ) -> Result<Self, String> {
        let count = xs.len();
        let mut mesh = PeriodicTriangulation::new(domain);
        mesh.vx = vec![0.0; count];
        mesh.vy = vec![0.0; count];
        mesh.v_edge = vec![-1; count];
        mesh.v_alive = vec![1; count];
        mesh.alive_vertices = count as u32;
        for v in 0..count {
            if mesh.globe {
                let p = mesh.domain.wrap_point(xs[v], ys[v]);
                mesh.vx[v] = mesh.domain.wrap_x(js::fround(p.x));
                mesh.vy[v] = js::fround(p.y);
            } else {
                mesh.vx[v] = mesh.domain.wrap_x(js::fround(mesh.domain.wrap_x(xs[v])));
                mesh.vy[v] = mesh.domain.wrap_y(js::fround(mesh.domain.wrap_y(ys[v])));
            }
        }
        if mesh.globe {
            mesh.vu = vec![0.0; 3 * count];
            for v in 0..count {
                let u = mesh.unit_of(mesh.vx[v], mesh.vy[v]);
                mesh.vu[3 * v..3 * v + 3].copy_from_slice(&u);
            }
        }
        let tri_count = triangles.len() / 3;
        mesh.tris = triangles[..3 * tri_count]
            .iter()
            .map(|&v| v as i32)
            .collect();
        mesh.twin = vec![-1; 3 * tri_count];
        mesh.t_alive = vec![1; tri_count];
        for t in 0..tri_count {
            let o = mesh.orient_of(t);
            if o == 0.0 {
                return Err(format!("buildFromTriangles: degenerate triangle {t}"));
            }
            if o < 0.0 {
                mesh.tris.swap(3 * t, 3 * t + 1);
            }
            let (a, b, c) = (mesh.t(3 * t), mesh.t(3 * t + 1), mesh.t(3 * t + 2));
            mesh.v_edge[a] = 3 * t as i32;
            mesh.v_edge[b] = 3 * t as i32 + 1;
            mesh.v_edge[c] = 3 * t as i32 + 2;
        }
        mesh.alive_triangles = tri_count as u32;
        // Twins by a per-vertex table of outgoing halfedges (counting sort).
        let edge_count = tri_count * 3;
        let mut out_start = vec![0u32; count + 1];
        for e in 0..edge_count {
            out_start[mesh.t(e) + 1] += 1;
        }
        for v in 0..count {
            out_start[v + 1] += out_start[v];
        }
        let mut out_edges = vec![0u32; edge_count];
        let mut cursor = out_start[..count].to_vec();
        for e in 0..edge_count {
            let from = mesh.t(e);
            out_edges[cursor[from] as usize] = e as u32;
            cursor[from] += 1;
        }
        for e in 0..edge_count {
            let from = mesh.t(e);
            let to = mesh.t(next(e));
            let mut w = -1i32;
            for &k in &out_edges[out_start[to] as usize..out_start[to + 1] as usize] {
                if mesh.t(next(k as usize)) == from {
                    if w >= 0 {
                        return Err(format!(
                            "buildFromTriangles: edge {to}→{from} appears twice"
                        ));
                    }
                    w = k as i32;
                }
            }
            if w < 0 {
                return Err(format!("buildFromTriangles: edge {from}→{to} has no twin"));
            }
            mesh.twin[e] = w;
        }
        mesh.last_tri = 0;
        mesh.keep_areas();
        Ok(mesh)
    }
}
