//! The tolerances of `periodic_delaunay`'s predicates (TEG-101). The
//! fixture test (tests/periodic_delaunay.rs) uses random points, and random
//! points do not reach the tolerances: a change of them goes unseen there
//! (docs/decisions/rust-engine.md, phase 3). The scenarios below put points
//! on the cases that the tolerances decide: cocircular points, collinear
//! points, points on the periodic seam, duplicate points and points very
//! near a vertex or an edge.
//!
//! The predicates and their constants are private. This test holds a copy
//! of each predicate with the same order of operations (the `replica_*`
//! functions) and counts the cases in the band that only the tolerance
//! decides: `0 < det <= eps · scale`. A count above zero is the evidence
//! that a scenario reaches the tolerance. Each scenario then checks that the
//! result is a valid periodic Delaunay triangulation and that a second run
//! gives the same arrays, bit for bit.
//!
//! Not reached: ORIENT_EPS on the torus (see `collinear`), and the convexity
//! test in `legalise` on either shape, which only acts when an in-circle
//! test has already passed its tolerance.

use std::collections::HashSet;

use casas_generator::core::domain::Domain;
use casas_generator::core::js::fround;
use casas_generator::mesh::periodic_delaunay::PeriodicTriangulation;

// Copies of the private constants in src/mesh/periodic_delaunay.rs.
const INCIRCLE_EPS: f64 = 1e-12;
const ON_EDGE_EPS: f64 = 1e-10;
const ORIENT_EPS: f64 = 1e-12;
const GLOBE_RADIAL_EPS: f64 = 1e-14;

// ------------------------------------------------------------- replicas

fn orient(ax: f64, ay: f64, bx: f64, by: f64, px: f64, py: f64) -> f64 {
    (bx - ax) * (py - ay) - (by - ay) * (px - ax)
}

/// The planar in-circle determinant and its scale, as `in_circle`.
#[allow(clippy::too_many_arguments)]
fn replica_in_circle(
    ax: f64,
    ay: f64,
    bx: f64,
    by: f64,
    cx: f64,
    cy: f64,
    dx: f64,
    dy: f64,
) -> (f64, f64) {
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
    (det, ad * bd + bd * cd + cd * ad)
}

type V3 = [f64; 3];

fn sq(x: f64) -> f64 {
    x * x
}

fn orient_g(a: V3, b: V3, c: V3) -> f64 {
    let ux = b[0] - a[0];
    let uy = b[1] - a[1];
    let uz = b[2] - a[2];
    let wx = c[0] - a[0];
    let wy = c[1] - a[1];
    let wz = c[2] - a[2];
    -(a[0] * (uy * wz - uz * wy) + a[1] * (uz * wx - ux * wz) + a[2] * (ux * wy - uy * wx))
}

/// The globe's in-circle determinant and its margin, as `in_circle_g`.
fn replica_in_circle_g(a: V3, b: V3, c: V3, d: V3) -> (f64, f64) {
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
    (
        det,
        INCIRCLE_EPS * scale + GLOBE_RADIAL_EPS * (nx.abs() + ny.abs() + nz.abs()),
    )
}

fn unit(m: &PeriodicTriangulation, v: usize) -> V3 {
    [m.vu[3 * v], m.vu[3 * v + 1], m.vu[3 * v + 2]]
}

fn chord_sq(a: V3, b: V3) -> f64 {
    sq(a[0] - b[0]) + sq(a[1] - b[1]) + sq(a[2] - b[2])
}

/// How often each tolerance decides a case.
#[derive(Default, Debug)]
struct Band {
    /// In-circle tests with 0 < det <= margin: a flip the tolerance refuses.
    in_circle: usize,
    /// In-circle tests with det == 0 exactly: cocircular in f64.
    in_circle_zero: usize,
    /// In-circle tests with -margin <= det < 0: cocircular within the
    /// tolerance, decided the same way without it.
    in_circle_below: usize,
    /// Location tests with 0 < o <= ON_EDGE_EPS · l: on an edge or a vertex
    /// only by the tolerance.
    on_edge: usize,
    /// Ear tests with 0 < area <= ORIENT_EPS · scale: an ear the tolerance
    /// refuses.
    ear: usize,
    /// Ear tests with area == 0 exactly.
    ear_zero: usize,
}

impl Band {
    fn count_in_circle(&mut self, det: f64, margin: f64) {
        if det == 0.0 {
            self.in_circle_zero += 1;
        } else if det > 0.0 && det <= margin {
            self.in_circle += 1;
        } else if det < 0.0 && det >= -margin {
            self.in_circle_below += 1;
        }
    }
}

/// Counts the in-circle test of halfedge e as `legalise` makes it, in the
/// frame of e's triangle.
fn count_in_circle_of(m: &PeriodicTriangulation, e: usize, band: &mut Band) {
    let t = e / 3;
    let i = e - 3 * t;
    let dv = m.apex(m.twin[e] as usize);
    if m.globe {
        let (det, margin) = replica_in_circle_g(
            unit(m, m.from(e)),
            unit(m, m.to(e)),
            unit(m, m.apex(e)),
            unit(m, dv),
        );
        band.count_in_circle(det, margin);
        return;
    }
    let f = m.frame(t);
    let ax = f[(2 * i) % 6];
    let ay = f[(2 * i + 1) % 6];
    let bx = f[(2 * i + 2) % 6];
    let by = f[(2 * i + 3) % 6];
    let px = f[(2 * i + 4) % 6];
    let py = f[(2 * i + 5) % 6];
    let d = m.domain.delta(m.vx[dv], m.vy[dv], ax, ay);
    let (det, scale) = replica_in_circle(ax, ay, bx, by, px, py, ax + d.x, ay + d.y);
    band.count_in_circle(det, INCIRCLE_EPS * scale);
}

/// Counts the in-circle tests of every halfedge of the mesh.
fn count_in_circle(m: &PeriodicTriangulation, band: &mut Band) {
    for t in 0..m.tri_slots() {
        if m.t_alive[t] != 0 {
            for e in 3 * t..3 * t + 3 {
                count_in_circle_of(m, e, band);
            }
        }
    }
}

/// Inserts (x, y) and counts the in-circle tests of the edges opposite the
/// new vertex: `legalise` made these tests last and kept each edge.
fn insert_counted(m: &mut PeriodicTriangulation, x: f64, y: f64, band: &mut Band) -> usize {
    let v = m.insert(x, y, None);
    let mut star = Vec::new();
    m.outgoing(v, &mut star);
    for &e in &star {
        let e = e as usize;
        let opposite = if e % 3 == 2 { e - 2 } else { e + 1 };
        count_in_circle_of(m, opposite, band);
    }
    v
}

/// Locates (x, y) as `insert` does and counts the location tests that only
/// the tolerance puts on an edge. The torus only.
fn count_locate(m: &mut PeriodicTriangulation, x: f64, y: f64, band: &mut Band) {
    let t = m.locate(x, y, None);
    let f = m.frame(t);
    let d = m.domain.delta(x, y, f[0], f[1]);
    let px = f[0] + d.x;
    let py = f[1] + d.y;
    let o = [
        orient(f[0], f[1], f[2], f[3], px, py),
        orient(f[2], f[3], f[4], f[5], px, py),
        orient(f[4], f[5], f[0], f[1], px, py),
    ];
    let l = [
        sq(f[2] - f[0]) + sq(f[3] - f[1]),
        sq(f[4] - f[2]) + sq(f[5] - f[3]),
        sq(f[0] - f[4]) + sq(f[1] - f[5]),
    ];
    for k in 0..3 {
        if o[k] > 0.0 && o[k] <= ON_EDGE_EPS * l[k] {
            band.on_edge += 1;
        }
    }
}

/// Counts the area tests of `is_ear` on the link polygon of v, before a
/// removal of v.
fn count_ears(m: &PeriodicTriangulation, v: usize, band: &mut Band) {
    let mut star = Vec::new();
    m.outgoing(v, &mut star);
    let n = star.len();
    for i in 0..n {
        let u = m.to(star[i] as usize);
        let r = m.to(star[(i + n - 1) % n] as usize);
        let l = m.to(star[(i + 1) % n] as usize);
        if m.globe {
            let (ur, uu, ul) = (unit(m, r), unit(m, u), unit(m, l));
            let area = orient_g(ur, uu, ul);
            let margin = ORIENT_EPS * (chord_sq(uu, ur) + chord_sq(ul, ur));
            if area == 0.0 {
                band.ear_zero += 1;
            } else if area > 0.0 && area <= margin {
                band.ear += 1;
            }
            continue;
        }
        let (rx, ry) = (m.vx[r], m.vy[r]);
        let d = m.domain.delta(m.vx[u], m.vy[u], rx, ry);
        let (ux, uy) = (rx + d.x, ry + d.y);
        let d = m.domain.delta(m.vx[l], m.vy[l], rx, ry);
        let (lx, ly) = (rx + d.x, ry + d.y);
        let area = orient(rx, ry, ux, uy, lx, ly);
        let scale = sq(ux - rx) + sq(uy - ry) + sq(lx - rx) + sq(ly - ry);
        if area == 0.0 {
            band.ear_zero += 1;
        } else if area > 0.0 && area <= ORIENT_EPS * scale {
            band.ear += 1;
        }
    }
}

// ---------------------------------------------------------- the checks

/// Asserts that m is a valid periodic Delaunay triangulation: the engine's
/// own `validate` (twins, winding, Euler, the edge margin, the local
/// empty-circumcircle test), no two triangles on the same three vertices, no
/// two live vertices at the same position, and, by brute force, no live
/// vertex strictly inside a circumcircle beyond the tolerance.
fn assert_valid(name: &str, m: &mut PeriodicTriangulation) {
    let errors = m.validate(true);
    assert!(
        errors.is_empty(),
        "{name}: validate: {:?}",
        &errors[..errors.len().min(4)]
    );
    let euler = if m.globe {
        2 * m.alive_vertices as i64 - 4
    } else {
        2 * m.alive_vertices as i64
    };
    assert_eq!(m.alive_triangles as i64, euler, "{name}: Euler count");

    let mut triples = HashSet::new();
    let mut alive: Vec<usize> = Vec::new();
    for t in 0..m.tri_slots() {
        if m.t_alive[t] == 0 {
            continue;
        }
        let mut k = [m.tris[3 * t], m.tris[3 * t + 1], m.tris[3 * t + 2]];
        k.sort_unstable();
        assert!(triples.insert(k), "{name}: triangle {t} twice: {k:?}");
        alive.push(t);
    }

    let mut positions = HashSet::new();
    let vertices: Vec<usize> = (0..m.vertex_slots())
        .filter(|&v| m.v_alive[v] != 0)
        .collect();
    for &v in &vertices {
        assert!(
            positions.insert((m.vx[v].to_bits(), m.vy[v].to_bits())),
            "{name}: vertex {v} shares its position ({}, {}) with another vertex",
            m.vx[v],
            m.vy[v]
        );
    }

    // Brute force: every vertex against every circumcircle. A vertex may
    // only be inside by less than the tolerance.
    for &t in &alive {
        let corners = [m.tris[3 * t], m.tris[3 * t + 1], m.tris[3 * t + 2]];
        let f = if m.globe { [0.0; 6] } else { m.frame(t) };
        for &v in &vertices {
            if corners.contains(&(v as i32)) {
                continue;
            }
            let inside = if m.globe {
                let (det, margin) = replica_in_circle_g(
                    unit(m, corners[0] as usize),
                    unit(m, corners[1] as usize),
                    unit(m, corners[2] as usize),
                    unit(m, v),
                );
                det > margin
            } else {
                let d = m.domain.delta(m.vx[v], m.vy[v], f[0], f[1]);
                let (det, scale) =
                    replica_in_circle(f[0], f[1], f[2], f[3], f[4], f[5], f[0] + d.x, f[1] + d.y);
                det > INCIRCLE_EPS * scale
            };
            assert!(!inside, "{name}: vertex {v} inside the circumcircle of {t}");
        }
    }
}

/// Asserts that every inserted point has a live vertex at most `tol` away.
fn assert_used(name: &str, m: &PeriodicTriangulation, used: &[(f64, f64, usize)], tol: f64) {
    for &(x, y, v) in used {
        assert!(m.v_alive[v] != 0, "{name}: point ({x}, {y}) has no vertex");
        let p = m.domain.wrap_point(x, y);
        let d = m.domain.distance_sq(p.x, p.y, m.vx[v], m.vy[v]);
        assert!(
            d <= tol * tol,
            "{name}: point ({x}, {y}) has vertex {v} at ({}, {}), {} away",
            m.vx[v],
            m.vy[v],
            d.sqrt()
        );
    }
}

/// The arrays that make the state, as bits.
fn state(m: &PeriodicTriangulation) -> Vec<u64> {
    let mut s = Vec::new();
    s.extend(m.vx.iter().map(|v| v.to_bits()));
    s.extend(m.vy.iter().map(|v| v.to_bits()));
    s.extend(m.vu.iter().map(|v| v.to_bits()));
    s.extend(m.tris.iter().map(|&v| v as u64));
    s.extend(m.twin.iter().map(|&v| v as u64));
    s.extend(m.v_edge.iter().map(|&v| v as u64));
    s.extend(m.t_alive.iter().map(|&v| v as u64));
    s.push(m.flips);
    s
}

/// Runs a scenario twice and asserts the same state, bit for bit.
fn assert_deterministic(name: &str, run: impl Fn(&mut Band) -> PeriodicTriangulation) {
    let a = state(&run(&mut Band::default()));
    let b = state(&run(&mut Band::default()));
    assert!(a == b, "{name}: a second run gives a different state");
}

// ----------------------------------------------------------- the meshes

/// A square lattice of nx × ny cells of size s on a torus of exactly that
/// size, each cell cut on its diagonal. Every cell's four corners are
/// cocircular.
fn square_lattice(s: f64, nx: i64, ny: i64) -> PeriodicTriangulation {
    let domain = Domain::torus(s * nx as f64, s * ny as f64);
    let mut xs = Vec::new();
    let mut ys = Vec::new();
    for j in 0..ny {
        for i in 0..nx {
            xs.push(i as f64 * s);
            ys.push(j as f64 * s);
        }
    }
    let id = |i: i64, j: i64| (j.rem_euclid(ny) * nx + i.rem_euclid(nx)) as u32;
    let mut tris = Vec::new();
    for j in 0..ny {
        for i in 0..nx {
            tris.extend_from_slice(&[
                id(i, j),
                id(i + 1, j),
                id(i + 1, j + 1),
                id(i, j),
                id(i + 1, j + 1),
                id(i, j + 1),
            ]);
        }
    }
    let mut m = PeriodicTriangulation::from_triangles(domain, &xs, &ys, &tris).unwrap();
    m.legalise_all();
    m
}

/// A cell size with 18 significant bits: every lattice point i · s with
/// i < 64 is exact in float32, and the in-circle products of the cell's
/// cocircular corners need more than the 53 bits of a float64. So the
/// determinant of four cocircular corners is rounded, not exactly zero.
const S18: f64 = 262_139.0 / 8192.0;

/// The 12 lattice points on the circle of radius 5 about the origin.
const PYTHAGOREAN: [(f64, f64); 12] = [
    (5.0, 0.0),
    (4.0, 3.0),
    (3.0, 4.0),
    (0.0, 5.0),
    (-3.0, 4.0),
    (-4.0, 3.0),
    (-5.0, 0.0),
    (-4.0, -3.0),
    (-3.0, -4.0),
    (0.0, -5.0),
    (3.0, -4.0),
    (4.0, -3.0),
];

// ------------------------------------------------------------ scenarios

/// Cocircular points: the square lattice, rings of 12 exactly cocircular
/// float32 points (Pythagorean, scaled by a 16-bit factor), and two pairs
/// of rows that make isosceles trapezoids (cocircular too). The rings give
/// determinants of zero or just below it; the trapezoids give determinants
/// just above zero, the band that only the tolerance decides.
fn cocircular(band: &mut Band) -> PeriodicTriangulation {
    let mut m = square_lattice(S18, 32, 16);
    count_in_circle(&m, band);
    // Ring scales with 16 significant bits: (c + p) · k is exact in
    // float32 for c + p < 256, and the in-circle products need about 80
    // bits. A ring's centre c · k lies near the centre of a lattice cell, and
    // no two rings are in adjacent cells, so no vertex is inside a ring.
    const KS: [f64; 4] = [
        65_521.0 / 16_384.0,
        65_497.0 / 16_384.0,
        64_513.0 / 16_384.0,
        63_997.0 / 16_384.0,
    ];
    let mut used = Vec::new();
    let mut n = 0;
    for j in (1..16).step_by(3) {
        for i in (1..30).step_by(3) {
            let k = KS[n % KS.len()];
            n += 1;
            let ci = ((i as f64 + 0.5) * S18 / k).round();
            let cj = ((j as f64 + 0.5) * S18 / k).round();
            for &(px, py) in &PYTHAGOREAN {
                let (x, y) = ((ci + px) * k, (cj + py) * k);
                assert_eq!(fround(x), x, "the ring point is float32");
                assert_eq!(fround(y), y, "the ring point is float32");
                let v = insert_counted(&mut m, x, y, band);
                used.push((x, y, v));
            }
        }
    }
    // The rows lie in the cell rows 3 and 9, which hold no ring.
    for j in [3, 9] {
        let y = j as f64 * S18;
        for i in 0..(32 * 4) {
            let x = i as f64 * S18 / 4.0;
            let v = insert_counted(&mut m, x, y, band);
            used.push((x, y, v));
        }
        let y = (j as f64 + 0.5) * S18;
        for i in 0..(32 * 2) {
            let x = (i as f64 + 0.25) * S18 / 2.0;
            let v = insert_counted(&mut m, x, y, band);
            used.push((x, y, v));
        }
    }
    count_in_circle(&m, band);
    assert_used("cocircular", &m, &used, 1e-4);
    assert_valid("cocircular", &mut m);
    m
}

/// Duplicates and near-duplicates: every lattice vertex again, then at
/// offsets within the location tolerance (for offsets above it, but within
/// float32 resolution, see the last test).
fn duplicates(band: &mut Band) -> PeriodicTriangulation {
    let mut m = square_lattice(S18, 32, 16);
    let before = m.alive_vertices;
    let mut used = Vec::new();
    for v in 0..m.vertex_slots() {
        let (x, y) = (m.vx[v], m.vy[v]);
        count_locate(&mut m, x, y, band);
        let w = m.insert(x, y, None);
        assert_eq!(w, v, "a duplicate returns the vertex");
        used.push((x, y, w));
    }
    assert_eq!(m.alive_vertices, before, "duplicates insert nothing");
    // Offsets relative to the cell, all within the location tolerance:
    // a vertex takes a point closer than ON_EDGE_EPS · edge ≈ 3e-9.
    for (n, off) in [1e-13, 1e-12, 1e-11].iter().enumerate() {
        for j in 0..16 {
            for i in 0..32 {
                if (i + j + n) % 3 != 0 {
                    continue;
                }
                let (x, y) = (i as f64 * S18 + off * S18, j as f64 * S18 - off * S18 * 0.5);
                count_locate(&mut m, x, y, band);
                let w = m.insert(x, y, None);
                used.push((x, y, w));
            }
        }
    }
    assert_eq!(m.alive_vertices, before, "near-duplicates insert nothing");
    assert_used("duplicates", &m, &used, 1e-6);
    assert_valid("duplicates", &mut m);
    m
}

/// Points on an edge: the midpoint of every lattice edge (exact in float32),
/// and points a little off the diagonals, within the location tolerance.
fn on_edges(band: &mut Band) -> PeriodicTriangulation {
    let mut m = square_lattice(S18, 32, 16);
    let mut used = Vec::new();
    for j in 0..16 {
        for i in 0..32 {
            let (x0, y0) = (i as f64 * S18, j as f64 * S18);
            for (x, y) in [
                (x0 + S18 / 2.0, y0),
                (x0, y0 + S18 / 2.0),
                // A quarter of the diagonal, off it by 1e-12 of the cell.
                (x0 + S18 / 4.0 + 1e-12 * S18, y0 + S18 / 4.0),
            ] {
                count_locate(&mut m, x, y, band);
                let v = insert_counted(&mut m, x, y, band);
                used.push((x, y, v));
            }
        }
    }
    count_in_circle(&m, band);
    assert_used("on_edges", &m, &used, 1e-4);
    assert_valid("on_edges", &mut m);
    m
}

/// Points on the periodic seam: on x = 0 and y = 0, at the far side of the
/// period, and a hair off it on either side.
fn seam(band: &mut Band) -> PeriodicTriangulation {
    let mut m = square_lattice(S18, 32, 16);
    let (w, h) = (m.domain.width, m.domain.height);
    let mut used = Vec::new();
    for j in 0..16 {
        let y = (j as f64 + 0.5) * S18;
        for x in [0.0, w, -0.0, 1e-13, -1e-13, w - 1e-13, w + 1e-13, 1e-30] {
            count_locate(&mut m, x, y, band);
            let v = m.insert(x, y, None);
            used.push((x, y, v));
        }
    }
    for i in 0..32 {
        let x = (i as f64 + 0.5) * S18;
        for y in [0.0, h, -1e-13, h + 1e-13, 1e-30] {
            count_locate(&mut m, x, y, band);
            let v = m.insert(x, y, None);
            used.push((x, y, v));
        }
    }
    count_in_circle(&m, band);
    for v in 0..m.vertex_slots() {
        if m.v_alive[v] != 0 {
            assert!(m.vx[v] >= 0.0 && m.vx[v] < w, "x {} not wrapped", m.vx[v]);
            assert!(m.vy[v] >= 0.0 && m.vy[v] < h, "y {} not wrapped", m.vy[v]);
        }
    }
    assert_used("seam", &m, &used, 1e-4);
    assert_valid("seam", &mut m);
    m
}

/// Collinear points: rows of points along y = const (a lattice row, which
/// makes the link polygons of the vertices beside it collinear), then the
/// removal of every second inserted point and of lattice vertices.
///
/// On the torus, the ear test's tolerance (ORIENT_EPS) is not reached: the
/// vertices are float32 values, so the differences and the products of the
/// orientation are exact in float64, and a flat ear has an area of exactly
/// zero. The scenario reaches the flat ears (`ear_zero`) and, through the
/// rows, the in-circle tolerance.
fn collinear(band: &mut Band) -> PeriodicTriangulation {
    let mut m = square_lattice(S18, 32, 16);
    let mut inserted = Vec::new();
    for j in [2, 7, 11] {
        let y = j as f64 * S18;
        for i in 0..(32 * 4) {
            let x = i as f64 * S18 / 4.0;
            inserted.push(m.insert(x, y, None));
        }
        // A row half a cell above: with the row below, isosceles
        // trapezoids, which are cocircular.
        let y2 = fround(y + S18 / 2.0);
        for i in 0..(32 * 2) {
            let x = (i as f64 + 0.25) * S18 / 2.0;
            inserted.push(m.insert(x, y2, None));
        }
    }
    count_in_circle(&m, band);
    let mut removed = 0;
    for (k, &v) in inserted.iter().enumerate() {
        if k % 2 == 1 && m.v_alive[v] != 0 {
            count_ears(&m, v, band);
            if m.remove(v) {
                removed += 1;
            }
        }
    }
    for v in (0..512).step_by(5) {
        if m.v_alive[v] != 0 {
            count_ears(&m, v, band);
            if m.remove(v) {
                removed += 1;
            }
        }
    }
    assert!(removed > 0, "collinear: no removal");
    count_in_circle(&m, band);
    assert_valid("collinear", &mut m);
    m
}

/// The globe: latitude rings (each ring is cocircular on the sphere),
/// points on meridians (great circles), the poles again, and points on the
/// x seam.
fn globe(band: &mut Band) -> PeriodicTriangulation {
    let domain = Domain::sphere(2048.0, 1024.0);
    let (w, h) = (domain.width, domain.height);
    let xs = [0.0, 0.0, 0.0, w / 4.0, w / 2.0, 3.0 * w / 4.0];
    let ys = [0.0, h, h / 2.0, h / 2.0, h / 2.0, h / 2.0];
    let mut tris = Vec::new();
    for k in 0..4u32 {
        let a = 2 + k;
        let b = 2 + (k + 1) % 4;
        tris.extend_from_slice(&[0, a, b, 1, b, a]);
    }
    let mut m = PeriodicTriangulation::from_triangles(domain, &xs, &ys, &tris).unwrap();
    let mut used = Vec::new();
    for r in 1..24 {
        let y = r as f64 * h / 24.0;
        for i in 0..48 {
            let x = i as f64 * w / 48.0;
            let v = m.insert(x, y, None);
            used.push((x, y, v));
        }
    }
    for (x, y) in [(0.0, 0.0), (w / 3.0, 0.0), (0.0, h), (w, h / 2.0), (w, h)] {
        let v = m.insert(x, y, None);
        used.push((x, y, v));
    }
    count_in_circle(&m, band);
    assert_used("globe", &m, &used, 1e-3);
    assert_valid("globe", &mut m);
    // Removals: the link polygons hold points of one ring and of one
    // meridian; the equator and the meridians are great circles.
    let mut removed = 0;
    for &(_, _, v) in used.iter().step_by(7) {
        if m.v_alive[v] != 0 {
            count_ears(&m, v, band);
            if m.remove(v) {
                removed += 1;
            }
        }
    }
    assert!(removed > 0, "globe: no removal");
    count_in_circle(&m, band);
    assert_valid("globe", &mut m);
    m
}

// ---------------------------------------------------------------- tests

fn run(name: &str, scenario: fn(&mut Band) -> PeriodicTriangulation) -> Band {
    let mut band = Band::default();
    scenario(&mut band);
    eprintln!("{name}: {band:?}");
    assert_deterministic(name, scenario);
    band
}

#[test]
fn cocircular_points_reach_the_in_circle_tolerance() {
    let band = run("cocircular", cocircular);
    assert!(band.in_circle > 0, "{band:?}");
}

#[test]
fn duplicate_points_reach_the_location_tolerance() {
    let band = run("duplicates", duplicates);
    assert!(band.on_edge > 0, "{band:?}");
}

#[test]
fn points_on_edges_reach_the_location_tolerance() {
    let band = run("on_edges", on_edges);
    assert!(band.on_edge > 0, "{band:?}");
}

#[test]
fn points_on_the_seam_reach_the_location_tolerance() {
    let band = run("seam", seam);
    assert!(band.on_edge > 0, "{band:?}");
}

#[test]
fn collinear_points_give_flat_ears_and_reach_the_in_circle_tolerance() {
    let band = run("collinear", collinear);
    assert!(band.ear_zero > 0, "{band:?}");
    assert!(band.in_circle > 0, "{band:?}");
}

#[test]
fn globe_rings_and_meridians_reach_the_in_circle_and_ear_tolerances() {
    let band = run("globe", globe);
    assert!(band.in_circle > 0, "{band:?}");
    assert!(band.ear > 0, "{band:?}");
}

/// TEG-115: `insert` rounds the point to the float32 position that a
/// vertex stores before it locates it. A point nearer a vertex than float32
/// resolution, but farther than the location tolerance (ON_EDGE_EPS · edge,
/// about 3e-9 here), has the vertex's position and thus is that vertex: the
/// insert returns it and adds nothing. Before the fix, the point was located
/// as float64 and stored as float32, which gave a second vertex at the same
/// position and two triangles that were not counter-clockwise. At the seam,
/// -1e-7 wraps to the width, rounds to it in float32, and wraps to 0 again.
#[test]
fn a_point_nearer_a_vertex_than_float32_resolution_is_that_vertex() {
    // Lattice vertex 175 is (15 · S18, 5 · S18), about (479.99, 159.997);
    // vertex 160 is (0, 5 · S18).
    for (x, y, want) in [
        (15.0 * S18 + 1e-5, 5.0 * S18, 175),
        (15.0 * S18 + 1e-6, 5.0 * S18, 175),
        (-1e-7, 5.0 * S18, 160),
    ] {
        let mut m = square_lattice(S18, 32, 16);
        let v = m.insert(x, y, None);
        assert_eq!(v, want, "({x}, {y}) is vertex {want}");
        assert_eq!(m.alive_vertices, 512, "({x}, {y}) adds no vertex");
        assert_valid(&format!("({x}, {y}) as vertex {v}"), &mut m);
    }
}
