//! The bootstrap of a domain's mesh at one spacing, the torus's hex lattice
//! or the sphere's geodesic one, and the field mesh's centroidal geodesic
//! lattice (DEC-0036 phase 3). The reasoning is in
//! `client/src/generator/mesh/lattice.ts`.

use crate::core::det_math::{det_cos, det_sin};
use crate::core::domain::Domain;
use crate::core::js;

use super::periodic_delaunay::PeriodicTriangulation;

pub fn bootstrap_lattice(domain: &Domain, spacing: f64) -> PeriodicTriangulation {
    if domain.is_sphere() {
        geodesic_lattice(domain, spacing)
    } else {
        hex_lattice(domain, spacing)
    }
}

/// A hexagonal lattice over the whole torus at one spacing, legalised.
pub fn hex_lattice(domain: &Domain, spacing: f64) -> PeriodicTriangulation {
    assert!(
        !domain.is_sphere(),
        "hexLattice tiles a torus; a sphere starts from geodesicLattice (bootstrapLattice)"
    );
    let cols = js::max(8.0, js::round(domain.width / spacing)) as i64;
    let mut rows = js::max(
        8.0,
        js::round(domain.height / (spacing * 3f64.sqrt() / 2.0)),
    ) as i64;
    if rows % 2 == 1 {
        rows += 1;
    }
    let dx = domain.width / cols as f64;
    let dy = domain.height / rows as f64;
    let count = (cols * rows) as usize;
    let mut xs = vec![0.0; count];
    let mut ys = vec![0.0; count];
    for j in 0..rows {
        let offset = if j % 2 == 0 { 0.0 } else { 0.5 };
        for i in 0..cols {
            xs[(j * cols + i) as usize] = (i as f64 + offset) * dx;
            ys[(j * cols + i) as usize] = (j as f64 + 0.5) * dy;
        }
    }
    let id = |i: i64, j: i64| (((j + rows) % rows) * cols + ((i + cols) % cols)) as u32;
    let mut tris = Vec::with_capacity(count * 6);
    for j in 0..rows {
        for i in 0..cols {
            if j % 2 == 0 {
                tris.extend_from_slice(&[id(i, j), id(i + 1, j), id(i, j + 1)]);
                tris.extend_from_slice(&[id(i + 1, j), id(i + 1, j + 1), id(i, j + 1)]);
            } else {
                tris.extend_from_slice(&[id(i, j), id(i + 1, j), id(i + 1, j + 1)]);
                tris.extend_from_slice(&[id(i, j), id(i + 1, j + 1), id(i, j + 1)]);
            }
        }
    }
    let mut mesh = PeriodicTriangulation::from_triangles(domain.clone(), &xs, &ys, &tris)
        .expect("the hex lattice");
    mesh.legalise_all();
    mesh
}

const TILT: f64 = 0.4;
const SPIN: f64 = 0.3;

struct GeodesicPoints {
    count: usize,
    px: Vec<f64>,
    py: Vec<f64>,
    pz: Vec<f64>,
    tris: Vec<u32>,
}

/// The geodesic points as they are made: the twelve corners, then each
/// point Σ w_i · corner_i normalised, numbered in the order emitted.
struct Emitter {
    corner: [f64; 36],
    px: Vec<f64>,
    py: Vec<f64>,
    pz: Vec<f64>,
}

impl Emitter {
    fn emit(&mut self, weights: &[(usize, f64)]) -> usize {
        let (mut x, mut y, mut z) = (0.0, 0.0, 0.0);
        for &(k, w) in weights {
            x += self.corner[3 * k] * w;
            y += self.corner[3 * k + 1] * w;
            z += self.corner[3 * k + 2] * w;
        }
        let l = (x * x + y * y + z * z).sqrt();
        self.px.push(x / l);
        self.py.push(y / l);
        self.pz.push(z / l);
        self.px.len() - 1
    }
}

fn geodesic_points(domain: &Domain, spacing: f64) -> GeodesicPoints {
    assert!(domain.is_sphere(), "geodesicLattice needs a sphere domain");
    let pi = std::f64::consts::PI;
    let radius = domain.radius();
    let sphere_area = 4.0 * pi * radius * radius;
    let n = js::max(
        4.0,
        js::round((sphere_area / ((3f64.sqrt() / 2.0) * spacing * spacing) / 10.0).sqrt()),
    ) as usize;
    // The twelve corners: the poles and two rings of five at z = ±1/√5, the
    // lower ring turned by 36°, then tilted about x and spun about z.
    let mut corner = [0.0f64; 36];
    let z5 = 1.0 / 5f64.sqrt();
    let r5 = 2.0 / 5f64.sqrt();
    let mut put = |k: usize, x: f64, y: f64, z: f64| {
        let ct = det_cos(TILT);
        let st = det_sin(TILT);
        let y1 = y * ct - z * st;
        let z1 = y * st + z * ct;
        let cs = det_cos(SPIN);
        let ss = det_sin(SPIN);
        corner[3 * k] = x * cs - y1 * ss;
        corner[3 * k + 1] = x * ss + y1 * cs;
        corner[3 * k + 2] = z1;
    };
    put(0, 0.0, 0.0, 1.0);
    for k in 0..5 {
        let up = (2.0 * pi * k as f64) / 5.0;
        let down = up + pi / 5.0;
        put(1 + k, r5 * det_cos(up), r5 * det_sin(up), z5);
        put(6 + k, r5 * det_cos(down), r5 * det_sin(down), -z5);
    }
    put(11, 0.0, 0.0, -1.0);
    let mut faces: Vec<usize> = Vec::with_capacity(60);
    for k in 0..5 {
        let k1 = (k + 1) % 5;
        faces.extend_from_slice(&[0, 1 + k, 1 + k1]);
        faces.extend_from_slice(&[1 + k, 6 + k, 1 + k1]);
        faces.extend_from_slice(&[1 + k1, 6 + k, 6 + k1]);
        faces.extend_from_slice(&[11, 6 + k1, 6 + k]);
    }
    let count = 10 * n * n + 2;
    let mut em = Emitter {
        corner,
        px: Vec::with_capacity(count),
        py: Vec::with_capacity(count),
        pz: Vec::with_capacity(count),
    };
    for k in 0..12 {
        em.emit(&[(k, 1.0)]);
    }
    // Edge points, t = 1..n − 1 from the lower corner.
    let mut edge_base = [usize::MAX; 144];
    for f in 0..20 {
        for s in 0..3 {
            let a = faces[3 * f + s].min(faces[3 * f + (s + 1) % 3]);
            let b = faces[3 * f + s].max(faces[3 * f + (s + 1) % 3]);
            if edge_base[a * 12 + b] != usize::MAX {
                continue;
            }
            edge_base[a * 12 + b] = em.px.len();
            for t in 1..n {
                em.emit(&[(a, (n - t) as f64), (b, t as f64)]);
            }
        }
    }
    // The point t steps from corner p toward corner q along their edge.
    let on_edge = |p: usize, q: usize, t: usize| -> usize {
        if t == 0 {
            return p;
        }
        if t == n {
            return q;
        }
        let base = edge_base[p.min(q) * 12 + p.max(q)];
        if p < q {
            base + t - 1
        } else {
            base + (n - t) - 1
        }
    };
    let mut tris: Vec<u32> = Vec::new();
    let mut id = vec![0usize; (n + 1) * (n + 1)];
    for f in 0..20 {
        let (fa, fb, fc) = (faces[3 * f], faces[3 * f + 1], faces[3 * f + 2]);
        // Node of grid point (i, j): A · (n − i − j) + B · i + C · j.
        for i in 0..=n {
            for j in 0..=(n - i) {
                let v = if j == 0 {
                    on_edge(fa, fb, i)
                } else if i == 0 {
                    on_edge(fa, fc, j)
                } else if i + j == n {
                    on_edge(fb, fc, j)
                } else {
                    em.emit(&[(fa, (n - i - j) as f64), (fb, i as f64), (fc, j as f64)])
                };
                id[i * (n + 1) + j] = v;
            }
        }
        let at = |i: usize, j: usize| id[i * (n + 1) + j] as u32;
        for i in 0..n {
            for j in 0..(n - i) {
                tris.extend_from_slice(&[at(i, j), at(i + 1, j), at(i, j + 1)]);
                if i + j < n - 1 {
                    tris.extend_from_slice(&[at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]);
                }
            }
        }
    }
    assert!(
        em.px.len() == count,
        "geodesicLattice: {} nodes, expected {count}",
        em.px.len()
    );
    GeodesicPoints {
        count,
        px: em.px,
        py: em.py,
        pz: em.pz,
        tris,
    }
}

pub fn geodesic_lattice(domain: &Domain, spacing: f64) -> PeriodicTriangulation {
    lattice_on_globe(domain, geodesic_points(domain, spacing))
}

/// The geodesic points in the chart, triangulated as the lattice's faces
/// say and legalised into the Delaunay triangulation.
fn lattice_on_globe(domain: &Domain, g: GeodesicPoints) -> PeriodicTriangulation {
    let mut xs = vec![0.0; g.count];
    let mut ys = vec![0.0; g.count];
    for v in 0..g.count {
        let p = domain.globe_locate(g.px[v], g.py[v], g.pz[v]);
        xs[v] = p.x;
        ys[v] = p.y;
    }
    let mut mesh = PeriodicTriangulation::from_triangles(domain.clone(), &xs, &ys, &g.tris)
        .expect("the geodesic lattice");
    mesh.legalise_all();
    mesh
}

const CENTROIDAL_ITERATIONS: usize = 300;
const CENTROIDAL_OVERRELAX: f64 = 1.8;

/// The field mesh's sphere: the geodesic lattice relaxed toward a
/// centroidal Voronoi tessellation by Lloyd's iteration.
pub fn centroidal_geodesic_lattice(domain: &Domain, spacing: f64) -> PeriodicTriangulation {
    let mut g = geodesic_points(domain, spacing);
    relax_centroidal(&mut g, CENTROIDAL_ITERATIONS, CENTROIDAL_OVERRELAX);
    lattice_on_globe(domain, g)
}

/// Lloyd's iteration on the globe, in place, each move × `omega`; returns
/// the largest centroid offset of the last iteration (radians).
fn relax_centroidal(g: &mut GeodesicPoints, iterations: usize, omega: f64) -> f64 {
    let count = g.count;
    let mut sx = vec![0.0; count];
    let mut sy = vec![0.0; count];
    let mut sz = vec![0.0; count];
    let tri_count = g.tris.len() / 3;
    let mut last_move = 0.0;
    // The signed area × centroid of the planar triangle (a, b, c), added to
    // node k's sums.
    #[allow(clippy::too_many_arguments)]
    fn piece(
        s: (&mut [f64], &mut [f64], &mut [f64]),
        k: usize,
        ax: f64,
        ay: f64,
        az: f64,
        bx: f64,
        by: f64,
        bz: f64,
        cx: f64,
        cy: f64,
        cz: f64,
    ) {
        let ux = bx - ax;
        let uy = by - ay;
        let uz = bz - az;
        let vx = cx - ax;
        let vy = cy - ay;
        let vz = cz - az;
        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        let area2 = nx * ax + ny * ay + nz * az;
        s.0[k] += area2 * (ax + bx + cx);
        s.1[k] += area2 * (ay + by + cy);
        s.2[k] += area2 * (az + bz + cz);
    }
    let (px, py, pz) = (&mut g.px, &mut g.py, &mut g.pz);
    for _ in 0..iterations {
        sx.fill(0.0);
        sy.fill(0.0);
        sz.fill(0.0);
        for t in 0..tri_count {
            let a = g.tris[3 * t] as usize;
            let mut b = g.tris[3 * t + 1] as usize;
            let mut c = g.tris[3 * t + 2] as usize;
            {
                let ux = px[b] - px[a];
                let uy = py[b] - py[a];
                let uz = pz[b] - pz[a];
                let vx = px[c] - px[a];
                let vy = py[c] - py[a];
                let vz = pz[c] - pz[a];
                let turn = (uy * vz - uz * vy) * px[a]
                    + (uz * vx - ux * vz) * py[a]
                    + (ux * vy - uy * vx) * pz[a];
                if turn < 0.0 {
                    std::mem::swap(&mut b, &mut c);
                }
            }
            let (ax, ay, az) = (px[a], py[a], pz[a]);
            let (bx, by, bz) = (px[b], py[b], pz[b]);
            let (cx, cy, cz) = (px[c], py[c], pz[c]);
            let mut ox = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
            let mut oy = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
            let mut oz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
            let mut ol = (ox * ox + oy * oy + oz * oz).sqrt();
            if ox * (ax + bx + cx) + oy * (ay + by + cy) + oz * (az + bz + cz) < 0.0 {
                ol = -ol;
            }
            ox /= ol;
            oy /= ol;
            oz /= ol;
            let (mut mx, mut my, mut mz) = (ax + bx, ay + by, az + bz);
            let mut ml = (mx * mx + my * my + mz * mz).sqrt();
            let (abx, aby, abz) = (mx / ml, my / ml, mz / ml);
            (mx, my, mz) = (bx + cx, by + cy, bz + cz);
            ml = (mx * mx + my * my + mz * mz).sqrt();
            let (bcx, bcy, bcz) = (mx / ml, my / ml, mz / ml);
            (mx, my, mz) = (cx + ax, cy + ay, cz + az);
            ml = (mx * mx + my * my + mz * mz).sqrt();
            let (cax, cay, caz) = (mx / ml, my / ml, mz / ml);
            piece(
                (&mut sx, &mut sy, &mut sz),
                a,
                ax,
                ay,
                az,
                abx,
                aby,
                abz,
                ox,
                oy,
                oz,
            );
            piece(
                (&mut sx, &mut sy, &mut sz),
                a,
                ax,
                ay,
                az,
                ox,
                oy,
                oz,
                cax,
                cay,
                caz,
            );
            piece(
                (&mut sx, &mut sy, &mut sz),
                b,
                bx,
                by,
                bz,
                bcx,
                bcy,
                bcz,
                ox,
                oy,
                oz,
            );
            piece(
                (&mut sx, &mut sy, &mut sz),
                b,
                bx,
                by,
                bz,
                ox,
                oy,
                oz,
                abx,
                aby,
                abz,
            );
            piece(
                (&mut sx, &mut sy, &mut sz),
                c,
                cx,
                cy,
                cz,
                cax,
                cay,
                caz,
                ox,
                oy,
                oz,
            );
            piece(
                (&mut sx, &mut sy, &mut sz),
                c,
                cx,
                cy,
                cz,
                ox,
                oy,
                oz,
                bcx,
                bcy,
                bcz,
            );
        }
        last_move = 0.0;
        for k in 0..count {
            let l = (sx[k] * sx[k] + sy[k] * sy[k] + sz[k] * sz[k]).sqrt();
            let dx = sx[k] / l - px[k];
            let dy = sy[k] / l - py[k];
            let dz = sz[k] / l - pz[k];
            let mv = (dx * dx + dy * dy + dz * dz).sqrt();
            if mv > last_move {
                last_move = mv;
            }
            let nx = px[k] + omega * dx;
            let ny = py[k] + omega * dy;
            let nz = pz[k] + omega * dz;
            let nl = (nx * nx + ny * ny + nz * nz).sqrt();
            px[k] = nx / nl;
            py[k] = ny / nl;
            pz[k] = nz / nl;
        }
    }
    last_move
}
