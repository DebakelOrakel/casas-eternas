//! A fine level's tiles on the sphere — the six faces of a turned cube,
//! each split into n × n tiles on an equiangular grid, with exact shared
//! corners. Geometry only, on unit vectors.
//! `client/src/generator/mesh/cubeAtlas.ts` explains the exactness rules.

use std::f64::consts::PI;

use crate::core::det_math::{det_atan, det_cos, det_sin, det_tan};

pub type Vec3 = [f64; 3];
/// A rotation, row-major: world = M · cube.
pub type Mat3 = [f64; 9];

pub const IDENTITY: Mat3 = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];

/// The rotation about the unit axis (x, y, z) by `angle` radians.
pub fn rotation_about(x: f64, y: f64, z: f64, angle: f64) -> Mat3 {
    let c = det_cos(angle);
    let s = det_sin(angle);
    let t = 1.0 - c;
    [
        t * x * x + c,
        t * x * y - s * z,
        t * x * z + s * y,
        t * x * y + s * z,
        t * y * y + c,
        t * y * z - s * x,
        t * x * z - s * y,
        t * y * z + s * x,
        t * z * z + c,
    ]
}

struct Face {
    c: Vec3,
    u: Vec3,
    v: Vec3,
}

const FACES: [Face; 6] = [
    Face {
        c: [1.0, 0.0, 0.0],
        u: [0.0, 1.0, 0.0],
        v: [0.0, 0.0, 1.0],
    },
    Face {
        c: [-1.0, 0.0, 0.0],
        u: [0.0, -1.0, 0.0],
        v: [0.0, 0.0, 1.0],
    },
    Face {
        c: [0.0, 1.0, 0.0],
        u: [-1.0, 0.0, 0.0],
        v: [0.0, 0.0, 1.0],
    },
    Face {
        c: [0.0, -1.0, 0.0],
        u: [1.0, 0.0, 0.0],
        v: [0.0, 0.0, 1.0],
    },
    Face {
        c: [0.0, 0.0, 1.0],
        u: [0.0, 1.0, 0.0],
        v: [-1.0, 0.0, 0.0],
    },
    Face {
        c: [0.0, 0.0, -1.0],
        u: [0.0, 1.0, 0.0],
        v: [1.0, 0.0, 0.0],
    },
];
pub const FACE_COUNT: usize = 6;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct CubeTileId {
    pub face: usize,
    pub i: usize,
    pub j: usize,
}

pub const SIDE_I_LOW: usize = 0;
pub const SIDE_J_LOW: usize = 1;
pub const SIDE_I_HIGH: usize = 2;
pub const SIDE_J_HIGH: usize = 3;

/// The gnomonic plane of one tile, tangent at its centre.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TileFrame {
    pub centre: Vec3,
    pub e1: Vec3,
    pub e2: Vec3,
    pub radius: f64,
}

fn dot(a: &Vec3, b: &Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: &Vec3, b: &Vec3) -> Vec3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn normalise(a: Vec3) -> Vec3 {
    let l = dot(&a, &a).sqrt();
    [a[0] / l, a[1] / l, a[2] / l]
}

fn turn(m: &Mat3, a: &Vec3) -> Vec3 {
    [
        m[0] * a[0] + m[1] * a[1] + m[2] * a[2],
        m[3] * a[0] + m[4] * a[1] + m[5] * a[2],
        m[6] * a[0] + m[7] * a[1] + m[8] * a[2],
    ]
}

fn turn_back(m: &Mat3, a: &Vec3) -> Vec3 {
    [
        m[0] * a[0] + m[3] * a[1] + m[6] * a[2],
        m[1] * a[0] + m[4] * a[1] + m[7] * a[2],
        m[2] * a[0] + m[5] * a[1] + m[8] * a[2],
    ]
}

/// c + s·u + t·v.
fn on_face(f: &Face, s: f64, t: f64) -> Vec3 {
    [
        f.c[0] + s * f.u[0] + t * f.v[0],
        f.c[1] + s * f.u[1] + t * f.v[1],
        f.c[2] + s * f.u[2] + t * f.v[2],
    ]
}

#[derive(Clone, Debug)]
pub struct CubeAtlas {
    pub n: usize,
    pub rotation: Mat3,
    tans: Vec<f64>,
}

impl CubeAtlas {
    pub fn new(n: usize, rotation: Mat3) -> Self {
        assert!(
            n >= 1,
            "a cube atlas needs n ≥ 1 tiles a face side, got {n}"
        );
        let tans = (0..=n)
            .map(|k| {
                let m = k.min(n - k);
                let value = if m == 0 {
                    1.0
                } else {
                    det_tan(PI / 4.0 - (m as f64 * PI) / (2.0 * n as f64))
                };
                match (k * 2).cmp(&n) {
                    std::cmp::Ordering::Less => -value,
                    std::cmp::Ordering::Equal => 0.0,
                    std::cmp::Ordering::Greater => value,
                }
            })
            .collect();
        CubeAtlas { n, rotation, tans }
    }

    pub fn tile_count(&self) -> usize {
        FACE_COUNT * self.n * self.n
    }

    pub fn index_of(&self, tile: &CubeTileId) -> usize {
        (tile.face * self.n + tile.j) * self.n + tile.i
    }

    pub fn tile_of_index(&self, index: usize) -> CubeTileId {
        let n = self.n;
        CubeTileId {
            face: index / (n * n),
            j: (index / n) % n,
            i: index % n,
        }
    }

    /// The tile that holds a direction; a point on a side goes to the tile
    /// with the higher grid index there.
    pub fn tile_at(&self, p: &Vec3) -> CubeTileId {
        let q = turn_back(&self.rotation, p);
        let face = face_of(&q);
        let f = &FACES[face];
        let along = dot(&q, &f.c);
        let xi = det_atan(dot(&q, &f.u) / along);
        let eta = det_atan(dot(&q, &f.v) / along);
        let step = PI / (2.0 * self.n as f64);
        let clamp = |k: f64| -> usize { (self.n as f64 - 1.0).min(0f64.max(k)) as usize };
        CubeTileId {
            face,
            i: clamp(((xi + PI / 4.0) / step).floor()),
            j: clamp(((eta + PI / 4.0) / step).floor()),
        }
    }

    /// A tile corner as a cube point, every component from the table.
    pub fn cube_corner(&self, tile: &CubeTileId, a: usize, b: usize) -> Vec3 {
        let s = self.tans[tile.i + a];
        let t = self.tans[tile.j + b];
        on_face(&FACES[tile.face], s, t)
    }

    pub fn corner(&self, tile: &CubeTileId, a: usize, b: usize) -> Vec3 {
        turn(&self.rotation, &normalise(self.cube_corner(tile, a, b)))
    }

    /// The four corners counter-clockwise seen from outside.
    pub fn corners(&self, tile: &CubeTileId) -> [Vec3; 4] {
        [
            self.corner(tile, 0, 0),
            self.corner(tile, 1, 0),
            self.corner(tile, 1, 1),
            self.corner(tile, 0, 1),
        ]
    }

    pub fn centre(&self, tile: &CubeTileId) -> Vec3 {
        let step = PI / (2.0 * self.n as f64);
        let s = det_tan(-PI / 4.0 + (tile.i as f64 + 0.5) * step);
        let t = det_tan(-PI / 4.0 + (tile.j as f64 + 0.5) * step);
        turn(&self.rotation, &normalise(on_face(&FACES[tile.face], s, t)))
    }

    /// The inward normals of the four sides' planes.
    pub fn side_normals(&self, tile: &CubeTileId) -> [Vec3; 4] {
        let [p00, p10, p11, p01] = self.corners(tile);
        [
            normalise(cross(&p01, &p00)),
            normalise(cross(&p00, &p10)),
            normalise(cross(&p10, &p11)),
            normalise(cross(&p11, &p01)),
        ]
    }

    pub fn inside(&self, tile: &CubeTileId, p: &Vec3) -> bool {
        self.side_normals(tile).iter().all(|nrm| dot(p, nrm) >= 0.0)
    }

    /// The tile across a side, and which of its sides that is.
    pub fn neighbour(&self, tile: &CubeTileId, side: usize) -> (CubeTileId, usize) {
        let corners = self.corners(tile);
        let a = corners[(side + 3) % 4];
        let b = corners[side];
        let mid = normalise([a[0] + b[0], a[1] + b[1], a[2] + b[2]]);
        let nrm = self.side_normals(tile)[side];
        let eps = 1e-6 / self.n as f64;
        let across = self.tile_at(&[
            mid[0] - eps * nrm[0],
            mid[1] - eps * nrm[1],
            mid[2] - eps * nrm[2],
        ]);
        let theirs = self.side_normals(&across);
        let mut best = 0;
        for k in 1..4 {
            if dot(&theirs[k], &nrm) < dot(&theirs[best], &nrm) {
                best = k;
            }
        }
        (across, best)
    }

    /// The tiles that share only a corner with this one, in the order a
    /// Map keeps them (first seen first).
    pub fn corner_neighbours(&self, tile: &CubeTileId) -> Vec<CubeTileId> {
        let own = self.index_of(tile);
        let sides: Vec<usize> = (0..4)
            .map(|s| self.index_of(&self.neighbour(tile, s).0))
            .collect();
        let mut out: Vec<(usize, CubeTileId)> = Vec::new();
        let eps = 1e-6 / self.n as f64;
        for corner in self.corners(tile) {
            let axis = if corner[0].abs() < 0.9 {
                [1.0, 0.0, 0.0]
            } else {
                [0.0, 1.0, 0.0]
            };
            let e1 = normalise(cross(&corner, &axis));
            let e2 = cross(&corner, &e1);
            for k in 0..24 {
                let angle = (k as f64 + 0.5) * (PI / 12.0);
                let c = det_cos(angle) * eps;
                let s = det_sin(angle) * eps;
                let at = self.tile_at(&[
                    corner[0] + c * e1[0] + s * e2[0],
                    corner[1] + c * e1[1] + s * e2[1],
                    corner[2] + c * e1[2] + s * e2[2],
                ]);
                let index = self.index_of(&at);
                if index != own && !sides.contains(&index) {
                    match out.iter_mut().find(|(i, _)| *i == index) {
                        Some(e) => e.1 = at,
                        None => out.push((index, at)),
                    }
                }
            }
        }
        out.into_iter().map(|(_, t)| t).collect()
    }

    pub fn to_cube(&self, p: &Vec3) -> Vec3 {
        turn_back(&self.rotation, p)
    }

    pub fn face_point(&self, face: usize, xi: f64, eta: f64) -> Vec3 {
        let s = det_tan(xi);
        let t = det_tan(eta);
        turn(&self.rotation, &normalise(on_face(&FACES[face], s, t)))
    }

    pub fn face_direction(&self, face: usize, s: f64, t: f64) -> Vec3 {
        turn(&self.rotation, &normalise(on_face(&FACES[face], s, t)))
    }

    /// A cube-frame direction's gnomonic coordinates on a face, or None
    /// where it is not in front of the face's plane.
    pub fn face_tangents(&self, face: usize, q: &Vec3) -> Option<(f64, f64)> {
        let f = &FACES[face];
        let along = dot(q, &f.c);
        if along <= 0.0 {
            return None;
        }
        Some((dot(q, &f.u) / along, dot(q, &f.v) / along))
    }

    pub fn frame(&self, tile: &CubeTileId, radius: f64) -> TileFrame {
        let centre = self.centre(tile);
        let p00 = self.corner(tile, 0, 0);
        let p10 = self.corner(tile, 1, 0);
        let d = [p10[0] - p00[0], p10[1] - p00[1], p10[2] - p00[2]];
        let e1 = normalise([
            d[0] - dot(&d, &centre) * centre[0],
            d[1] - dot(&d, &centre) * centre[1],
            d[2] - dot(&d, &centre) * centre[2],
        ]);
        let e2 = cross(&centre, &e1);
        TileFrame {
            centre,
            e1,
            e2,
            radius,
        }
    }
}

fn face_of(q: &Vec3) -> usize {
    let ax = q[0].abs();
    let ay = q[1].abs();
    let az = q[2].abs();
    if ax >= ay && ax >= az {
        return if q[0] >= 0.0 { 0 } else { 1 };
    }
    if ay >= az {
        return if q[1] >= 0.0 { 2 } else { 3 };
    }
    if q[2] >= 0.0 { 4 } else { 5 }
}

/// A direction into a tile's plane; None behind its horizon.
pub fn project(frame: &TileFrame, p: &Vec3) -> Option<(f64, f64)> {
    let along = dot(p, &frame.centre);
    if along <= 0.0 {
        return None;
    }
    Some((
        (frame.radius * dot(p, &frame.e1)) / along,
        (frame.radius * dot(p, &frame.e2)) / along,
    ))
}

/// A point of a tile's plane back to a unit direction.
pub fn unproject(frame: &TileFrame, x: f64, y: f64) -> Vec3 {
    let s = x / frame.radius;
    let t = y / frame.radius;
    let (c, e1, e2) = (&frame.centre, &frame.e1, &frame.e2);
    normalise([
        c[0] + s * e1[0] + t * e2[0],
        c[1] + s * e1[1] + t * e2[1],
        c[2] + s * e1[2] + t * e2[2],
    ])
}

/// A side's point at fraction f along the cube segment from a to b, as a
/// world direction; the corners themselves at 0 and 1.
pub fn side_point(atlas: &CubeAtlas, a: &Vec3, b: &Vec3, f: f64) -> Vec3 {
    let q = if f == 0.0 {
        *a
    } else if f == 1.0 {
        *b
    } else {
        [
            a[0] + f * (b[0] - a[0]),
            a[1] + f * (b[1] - a[1]),
            a[2] + f * (b[2] - a[2]),
        ]
    };
    turn(&atlas.rotation, &normalise(q))
}

/// A side's two cube corners in the canonical order, and whether that is
/// against the tile's own.
pub fn side_ends(atlas: &CubeAtlas, tile: &CubeTileId, side: usize) -> (Vec3, Vec3, bool) {
    let cube = [
        atlas.cube_corner(tile, 0, 0),
        atlas.cube_corner(tile, 1, 0),
        atlas.cube_corner(tile, 1, 1),
        atlas.cube_corner(tile, 0, 1),
    ];
    let from = cube[(side + 3) % 4];
    let to = cube[side];
    // `d0 || d1 || d2`: the first nonzero difference (NaN counts as zero).
    let nonzero = |d: f64| d != 0.0 && !d.is_nan();
    let d = [from[0] - to[0], from[1] - to[1], from[2] - to[2]];
    let before = if nonzero(d[0]) {
        d[0]
    } else if nonzero(d[1]) {
        d[1]
    } else {
        d[2]
    };
    if before < 0.0 {
        (from, to, false)
    } else {
        (to, from, true)
    }
}
