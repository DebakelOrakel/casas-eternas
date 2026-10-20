//! The world's topology: the TypeScript engine's `core/domain.ts`, for the
//! torus and the sphere (DEC-0035, docs/decisions/two-shapes.md). Distance,
//! offset and wrap between points go through a [`Domain`], never through
//! the chart's arithmetic.
//!
//! The noise space is the globe's frame and locate on the sphere; the
//! torus's chart noise is the lattices' own. The sphere's trig cache and its
//! per-size grid cache are not ported: a hit gives the bits a miss
//! computes, so they change the time and nothing else.

use super::det_math::{det_asin, det_atan2, det_cos, det_sin};
use super::field::{
    sample_bilinear_grid, sample_bilinear_world, sample_nearest_world, upscale_bilinear_toroidal,
};
use super::js;
use super::toroidal::rotate_around_center;

/// An offset or a point in domain units.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Vec2 {
    pub x: f64,
    pub y: f64,
}

/// A point of the globe and its east and south axes.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GlobeFrame {
    pub px: f64,
    pub py: f64,
    pub pz: f64,
    pub ex: f64,
    pub ey: f64,
    pub ez: f64,
    pub sx: f64,
    pub sy: f64,
    pub sz: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Torus,
    Sphere,
}

#[derive(Clone, Debug)]
pub struct Domain {
    pub kind: Kind,
    pub width: f64,
    pub height: f64,
    /// Metres per domain unit: the torus's macro cell, or the sphere's arc
    /// of one unit at the equator (DEC-0035 fork 6).
    pub metres_per_unit: f64,
    /// The world's extent east-west at the equator, metres, fixed for the
    /// shape.
    pub metres_around: f64,
    /// The torus's thermal equator slid by this fraction of the height,
    /// positive toward the bottom (0 on the sphere).
    pub equator_offset: f64,
    /// The sphere's radius, W / 2π (0 on the torus).
    radius: f64,
    to_lon: f64,
    to_colat: f64,
}

pub use super::field::wrap_value;
pub use super::toroidal::wrapped_delta;

/// `core/mapConfig.ts`: the torus's metres per macro cell.
pub const TORUS_METERS_PER_CELL: f64 = 7800.0;
/// `core/mapConfig.ts`: the sphere's equator, and the map's width in cells.
pub const SPHERE_EQUATOR_METERS: f64 = 20_000_000.0;
pub const MAP_WIDTH: f64 = 2048.0;

impl Domain {
    /// The torus at the default scale, `torusDomain(width, height)`.
    pub fn torus(width: f64, height: f64) -> Self {
        Self::torus_with(width, height, 0.0, TORUS_METERS_PER_CELL)
    }

    /// `torusDomain(width, height, equatorOffset, metresPerUnit)`.
    pub fn torus_with(width: f64, height: f64, equator_offset: f64, metres_per_unit: f64) -> Self {
        Domain {
            kind: Kind::Torus,
            width,
            height,
            metres_per_unit,
            metres_around: MAP_WIDTH * TORUS_METERS_PER_CELL,
            equator_offset,
            radius: 0.0,
            to_lon: 0.0,
            to_colat: 0.0,
        }
    }

    /// The sphere: a 2:1 chart, x the longitude (λ = 2π·x/W), y the
    /// colatitude from the north pole (θ = π·y/H). Panics on another ratio,
    /// as `sphereDomain` throws.
    pub fn sphere(width: f64, height: f64) -> Self {
        Self::sphere_with(width, height, SPHERE_EQUATOR_METERS / MAP_WIDTH)
    }

    /// `sphereDomain(width, height, _, metresPerUnit)`.
    pub fn sphere_with(width: f64, height: f64, metres_per_unit: f64) -> Self {
        assert!(
            (width - 2.0 * height).abs() <= 1e-9 * width,
            "a sphere domain is a 2:1 chart (longitude × colatitude), got {width} × {height}"
        );
        Domain {
            kind: Kind::Sphere,
            width,
            height,
            metres_per_unit,
            metres_around: SPHERE_EQUATOR_METERS,
            equator_offset: 0.0,
            radius: width / (2.0 * std::f64::consts::PI),
            to_lon: (2.0 * std::f64::consts::PI) / width,
            to_colat: std::f64::consts::PI / height,
        }
    }

    /// The same domain at another scale.
    pub fn with_metres_per_unit(mut self, metres_per_unit: f64) -> Self {
        self.metres_per_unit = metres_per_unit;
        self
    }

    /// The globe's radius in domain units, W / 2π (0 on the torus).
    pub fn radius(&self) -> f64 {
        self.radius
    }

    pub fn is_sphere(&self) -> bool {
        self.kind == Kind::Sphere
    }

    /// The same domain measured in other units: width × height of them.
    pub fn scaled_to(&self, width: f64, height: f64) -> Domain {
        let metres = (self.metres_per_unit * self.width) / width;
        match self.kind {
            Kind::Torus => Domain::torus_with(width, height, self.equator_offset, metres),
            Kind::Sphere => Domain::sphere_with(width, height, metres),
        }
    }

    /// Latitude 0..1 of a normalised row position: 0 at the equator, 1 at
    /// the pole.
    pub fn latitude(&self, y_norm: f64) -> f64 {
        match self.kind {
            Kind::Torus => (self.shifted(y_norm) - 0.5).abs() * 2.0,
            Kind::Sphere => (y_norm - 0.5).abs() * 2.0,
        }
    }

    /// Whether a row lies in the top ("north") hemisphere.
    pub fn north(&self, y_norm: f64) -> bool {
        match self.kind {
            Kind::Torus => self.shifted(y_norm) < 0.5,
            Kind::Sphere => y_norm < 0.5,
        }
    }

    fn shifted(&self, y_norm: f64) -> f64 {
        let y = y_norm - self.equator_offset;
        y - y.floor()
    }

    /// A point of the plane about a reference point brought back to the
    /// domain: the torus wraps it, the sphere advances from the reference.
    pub fn from_plane(&self, px: f64, py: f64, ref_x: f64, ref_y: f64) -> Vec2 {
        match self.kind {
            Kind::Torus => Vec2 {
                x: wrap_value(px, self.width),
                y: wrap_value(py, self.height),
            },
            Kind::Sphere => self.advance(ref_x, ref_y, px - ref_x, py - ref_y),
        }
    }

    /// (x, y) turned by `angle` radians about (cx, cy), wrapped: on the
    /// sphere an Euler rotation about the centre's axis (Rodrigues).
    pub fn rotate_around(&self, x: f64, y: f64, cx: f64, cy: f64, angle: f64) -> Vec2 {
        if self.kind == Kind::Torus {
            let (rx, ry) = rotate_around_center(x, y, cx, cy, angle, self.width, self.height);
            return Vec2 { x: rx, y: ry };
        }
        let tp = y * self.to_colat;
        let lp = x * self.to_lon;
        let sp = det_sin(tp);
        let vx = sp * det_cos(lp);
        let vy = sp * det_sin(lp);
        let vz = det_cos(tp);
        let tc = cy * self.to_colat;
        let lc = cx * self.to_lon;
        let sc = det_sin(tc);
        let kx = sc * det_cos(lc);
        let ky = sc * det_sin(lc);
        let kz = det_cos(tc);
        let c = det_cos(angle);
        let s = -det_sin(angle);
        let kv = (kx * vx + ky * vy + kz * vz) * (1.0 - c);
        let rx = vx * c + (ky * vz - kz * vy) * s + kx * kv;
        let ry = vy * c + (kz * vx - kx * vz) * s + ky * kv;
        let rz = vz * c + (kx * vy - ky * vx) * s + kz * kv;
        Vec2 {
            x: wrap_value(det_atan2(ry, rx) / self.to_lon, self.width),
            y: det_atan2((rx * rx + ry * ry).sqrt(), rz) / self.to_colat,
        }
    }

    /// A raster of res_x × res_y cells over the whole domain.
    pub fn grid(&self, res_x: usize, res_y: usize) -> DomainGrid {
        DomainGrid::new(self.clone(), res_x, res_y)
    }

    /// Point a seen from b on the sphere: its components along b's east and
    /// south axes and the arc's cosine, in `sphereDomain`'s haversine form.
    fn project(&self, ax: f64, ay: f64, bx: f64, by: f64) -> (f64, f64, f64) {
        let ta = ay * self.to_colat;
        let ha = (ax * self.to_lon) / 2.0;
        let (sa, ca, sha, cha) = (det_sin(ta), det_cos(ta), det_sin(ha), det_cos(ha));
        let tb = by * self.to_colat;
        let hb = (bx * self.to_lon) / 2.0;
        let (sb, cb, shb, chb) = (det_sin(tb), det_cos(tb), det_sin(hb), det_cos(hb));
        let h = sha * chb - cha * shb;
        let h2 = 2.0 * h * h;
        let pe = sa * (2.0 * h * (cha * chb + sha * shb));
        let ps = (sa * cb - ca * sb) - cb * sa * h2;
        let pc = (ca * cb + sa * sb) - sa * sb * h2;
        (pe, ps, pc)
    }

    /// The offset of a seen from b: on the torus the shortest wrapped one, on
    /// the sphere the log map into b's east/south tangent plane.
    pub fn delta(&self, ax: f64, ay: f64, bx: f64, by: f64) -> Vec2 {
        match self.kind {
            Kind::Torus => Vec2 {
                x: wrapped_delta(ax, bx, self.width),
                y: wrapped_delta(ay, by, self.height),
            },
            Kind::Sphere => {
                let (pe, ps, pc) = self.project(ax, ay, bx, by);
                let st = (pe * pe + ps * ps).sqrt();
                if st == 0.0 {
                    return Vec2 {
                        x: 0.0,
                        y: if pc < 0.0 {
                            std::f64::consts::PI * self.radius
                        } else {
                            0.0
                        },
                    };
                }
                let scale = (self.radius * det_atan2(st, pc)) / st;
                Vec2 {
                    x: pe * scale,
                    y: ps * scale,
                }
            }
        }
    }

    /// The point reached from (x, y) by the offset (dx, dy) in its frame,
    /// wrapped: on the sphere the exp map along the great circle.
    pub fn advance(&self, x: f64, y: f64, dx: f64, dy: f64) -> Vec2 {
        match self.kind {
            Kind::Torus => Vec2 {
                x: wrap_value(x + dx, self.width),
                y: wrap_value(y + dy, self.height),
            },
            Kind::Sphere => {
                let d = (dx * dx + dy * dy).sqrt();
                if d == 0.0 {
                    return self.wrap_point(x, y);
                }
                let t = y * self.to_colat;
                let l = x * self.to_lon;
                let st = det_sin(t);
                let ct = det_cos(t);
                let sl = det_sin(l);
                let cl = det_cos(l);
                let ue = dx / d;
                let us = dy / d;
                let tx = -sl * ue + ct * cl * us;
                let ty = cl * ue + ct * sl * us;
                let tz = -st * us;
                let a = d / self.radius;
                let ca = det_cos(a);
                let sa = det_sin(a);
                let qx = st * cl * ca + tx * sa;
                let qy = st * sl * ca + ty * sa;
                let qz = ct * ca + tz * sa;
                self.wrap_point(
                    det_atan2(qy, qx) / self.to_lon,
                    det_atan2((qx * qx + qy * qy).sqrt(), qz) / self.to_colat,
                )
            }
        }
    }

    /// As [`Domain::advance`], but unwrapped on the torus (the point in the
    /// frame of the start).
    pub fn displace(&self, x: f64, y: f64, dx: f64, dy: f64) -> Vec2 {
        match self.kind {
            Kind::Torus => Vec2 {
                x: x + dx,
                y: y + dy,
            },
            Kind::Sphere => self.advance(x, y, dx, dy),
        }
    }

    /// The vector (vx, vy) in the east/south frame of `from`, carried along
    /// the great circle to `to` and read in its frame. The identity on the
    /// torus.
    #[allow(clippy::too_many_arguments)]
    pub fn transport(
        &self,
        vx: f64,
        vy: f64,
        from_x: f64,
        from_y: f64,
        to_x: f64,
        to_y: f64,
    ) -> Vec2 {
        if self.kind == Kind::Torus {
            return Vec2 { x: vx, y: vy };
        }
        let ta = from_y * self.to_colat;
        let la = from_x * self.to_lon;
        let sta = det_sin(ta);
        let cta = det_cos(ta);
        let sla = det_sin(la);
        let cla = det_cos(la);
        let tb = to_y * self.to_colat;
        let lb = to_x * self.to_lon;
        let stb = det_sin(tb);
        let ctb = det_cos(tb);
        let slb = det_sin(lb);
        let clb = det_cos(lb);
        let tx = -sla * vx + cta * cla * vy;
        let ty = cla * vx + cta * sla * vy;
        let tz = -sta * vy;
        let ax = sta * cla;
        let ay = sta * sla;
        let az = cta;
        let bx = stb * clb;
        let by = stb * slb;
        let bz = ctb;
        let c = ax * bx + ay * by + az * bz;
        let (mut rx, mut ry, mut rz) = (tx, ty, tz);
        if c > -1.0 + 1e-12 {
            let wx = ay * bz - az * by;
            let wy = az * bx - ax * bz;
            let wz = ax * by - ay * bx;
            let k = (wx * tx + wy * ty + wz * tz) / (1.0 + c);
            rx = c * tx + (wy * tz - wz * ty) + wx * k;
            ry = c * ty + (wz * tx - wx * tz) + wy * k;
            rz = c * tz + (wx * ty - wy * tx) + wz * k;
        }
        Vec2 {
            x: -slb * rx + clb * ry,
            y: ctb * clb * rx + ctb * slb * ry - stb * rz,
        }
    }

    /// The point of chart point (x, y) on the globe of radius R, with its
    /// east and south axes (`noise.frame` of the sphere domain).
    pub fn globe_frame(&self, x: f64, y: f64) -> GlobeFrame {
        let t = y * self.to_colat;
        let l = x * self.to_lon;
        let st = det_sin(t);
        let ct = det_cos(t);
        let sl = det_sin(l);
        let cl = det_cos(l);
        GlobeFrame {
            px: self.radius * st * cl,
            py: self.radius * st * sl,
            pz: self.radius * ct,
            ex: -sl,
            ey: cl,
            ez: 0.0,
            sx: ct * cl,
            sy: ct * sl,
            sz: -st,
        }
    }

    /// The chart point of a point (px, py, pz) of the globe, in any length
    /// (`noise.locate` of the sphere domain).
    pub fn globe_locate(&self, px: f64, py: f64, pz: f64) -> Vec2 {
        Vec2 {
            x: wrap_value(det_atan2(py, px) / self.to_lon, self.width),
            y: det_atan2((px * px + py * py).sqrt(), pz) / self.to_colat,
        }
    }

    pub fn wrap_x(&self, x: f64) -> f64 {
        wrap_value(x, self.width)
    }

    /// The row wrapped: on the torus by the period, on the sphere reflected
    /// over the pole (the row alone; a moved point goes through
    /// [`Domain::wrap_point`]).
    pub fn wrap_y(&self, y: f64) -> f64 {
        match self.kind {
            Kind::Torus => wrap_value(y, self.height),
            Kind::Sphere => {
                let folded = wrap_value(y, 2.0 * self.height);
                if folded > self.height {
                    2.0 * self.height - folded
                } else {
                    folded
                }
            }
        }
    }

    pub fn wrap_point(&self, x: f64, y: f64) -> Vec2 {
        match self.kind {
            Kind::Torus => Vec2 {
                x: wrap_value(x, self.width),
                y: wrap_value(y, self.height),
            },
            Kind::Sphere => {
                let folded = wrap_value(y, 2.0 * self.height);
                if folded > self.height {
                    Vec2 {
                        x: wrap_value(x + self.width / 2.0, self.width),
                        y: 2.0 * self.height - folded,
                    }
                } else {
                    Vec2 {
                        x: wrap_value(x, self.width),
                        y: folded,
                    }
                }
            }
        }
    }

    pub fn distance_sq(&self, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
        match self.kind {
            Kind::Torus => {
                let dx = wrapped_delta(ax, bx, self.width);
                let dy = wrapped_delta(ay, by, self.height);
                dx * dx + dy * dy
            }
            Kind::Sphere => {
                let (pe, ps, pc) = self.project(ax, ay, bx, by);
                let arc = self.radius * det_atan2((pe * pe + ps * ps).sqrt(), pc);
                arc * arc
            }
        }
    }
}

/// The world's area in domain units²: W · H on the torus, 4πR² on the
/// sphere.
pub fn domain_area(domain: &Domain) -> f64 {
    if domain.is_sphere() {
        (domain.width * domain.width) / std::f64::consts::PI
    } else {
        domain.width * domain.height
    }
}

// ----------------------------------------------------------------- the grid

/// The bilinear taps of many points, one per slot: per slot the four cells
/// (i00, i10 of the first row, i01, i11 of the second) and the fractions
/// (tx of the first row, tx of the second, ty).
pub struct BilinearTaps {
    pub cells: Vec<u32>,
    pub weights: Vec<f64>,
}

pub fn bilinear_taps(count: usize) -> BilinearTaps {
    BilinearTaps {
        cells: vec![0; 4 * count],
        weights: vec![0.0; 3 * count],
    }
}

/// A field sampled through the taps of slot `at`.
pub fn sample_taps(field: &[f32], taps: &BilinearTaps, at: usize) -> f64 {
    let c = &taps.cells;
    let w = &taps.weights;
    let (i, k) = (4 * at, 3 * at);
    let (tx0, tx1, ty) = (w[k], w[k + 1], w[k + 2]);
    let f = |j: usize| field[c[j] as usize] as f64;
    let top = f(i) * (1.0 - tx0) + f(i + 1) * tx0;
    let bottom = f(i + 2) * (1.0 - tx1) + f(i + 3) * tx1;
    top * (1.0 - ty) + bottom * ty
}

/// A range of grid cells, both ends included, unwrapped.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CellBox {
    pub x0: i64,
    pub x1: i64,
    pub y0: i64,
    pub y1: i64,
}

/// A raster over the domain (`DomainGrid` in TypeScript, which explains
/// each method): the torus's both axes wrap; the sphere's columns wrap in
/// longitude, its rows reflect over a pole with the column turned by half,
/// and its rows narrow as sin θ.
#[derive(Clone, Debug)]
pub struct DomainGrid {
    pub domain: Domain,
    pub res_x: usize,
    pub res_y: usize,
    half_cols: f64,
    row_scales: Vec<f64>,
    cell_areas: Vec<f64>,
    edge_scales: Vec<f64>,
}

impl DomainGrid {
    pub fn new(domain: Domain, res_x: usize, res_y: usize) -> Self {
        let mut grid = DomainGrid {
            domain,
            res_x,
            res_y,
            half_cols: res_x as f64 / 2.0,
            row_scales: Vec::new(),
            cell_areas: Vec::new(),
            edge_scales: Vec::new(),
        };
        if grid.domain.is_sphere() {
            assert!(
                res_x.is_multiple_of(2),
                "a sphere grid needs an even column count (across a pole is column + resX / 2), got {res_x}"
            );
            let pi = std::f64::consts::PI;
            let band = (2.0 * det_sin(pi / (2.0 * res_y as f64)) * res_y as f64) / pi;
            for j in 0..res_y {
                let scale = det_sin(((j as f64 + 0.5) * pi) / res_y as f64);
                grid.row_scales.push(scale);
                grid.cell_areas.push(scale * band);
            }
            grid.edge_scales = vec![0.0; res_y + 1];
            for j in 1..res_y {
                grid.edge_scales[j] = det_sin((j as f64 * pi) / res_y as f64);
            }
        }
        grid
    }

    fn sphere(&self) -> bool {
        self.domain.is_sphere()
    }

    fn cell_w(&self) -> f64 {
        self.domain.width / self.res_x as f64
    }

    fn cell_h(&self) -> f64 {
        self.domain.height / self.res_y as f64
    }

    pub fn wrap_col(&self, x: f64) -> f64 {
        wrap_value(x, self.res_x as f64)
    }

    /// The torus wraps; the sphere reflects over the poles (cell centres at
    /// integers, the poles at −0.5 and resY − 0.5).
    pub fn wrap_row(&self, y: f64) -> f64 {
        if !self.sphere() {
            return wrap_value(y, self.res_y as f64);
        }
        let n = self.res_y as f64;
        let folded = wrap_value(y + 0.5, 2.0 * n) - 0.5;
        if folded <= n - 0.5 {
            folded
        } else {
            2.0 * n - 1.0 - folded
        }
    }

    /// Whether the integer row r lies an odd number of poles away.
    fn crossed(&self, r: f64) -> bool {
        ((r / self.res_y as f64).floor() as i64) & 1 == 1
    }

    /// The cell index of integer (x, y), wrapped first.
    pub fn index(&self, x: i64, y: i64) -> usize {
        self.neighbour(x, y, 0, 0)
    }

    /// The cell index (dx, dy) steps from cell (x, y).
    pub fn neighbour(&self, x: i64, y: i64, dx: i64, dy: i64) -> usize {
        let rx = self.res_x as f64;
        if !self.sphere() {
            return wrap_value((y + dy) as f64, self.res_y as f64) as usize * self.res_x
                + wrap_value((x + dx) as f64, rx) as usize;
        }
        let r = (y + dy) as f64;
        let c = if self.crossed(r) {
            (x + dx) as f64 + self.half_cols
        } else {
            (x + dx) as f64
        };
        self.wrap_row(r) as usize * self.res_x + wrap_value(c, rx) as usize
    }

    pub fn col_table(&self, margin: usize) -> Vec<u32> {
        (0..self.res_x + 2 * margin)
            .map(|k| wrap_value(k as f64 - margin as f64, self.res_x as f64) as u32)
            .collect()
    }

    /// Panics on a margin on the sphere, where a row table cannot express
    /// the column shift across a pole.
    pub fn row_table(&self, margin: usize) -> Vec<u32> {
        if self.sphere() {
            assert!(
                margin == 0,
                "a row table cannot express the column shift across a pole: on the sphere use DomainGrid.neighbour (DEC-0035, fork 5)"
            );
            return (0..self.res_y).map(|k| (k * self.res_x) as u32).collect();
        }
        (0..self.res_y + 2 * margin)
            .map(|k| {
                (wrap_value(k as f64 - margin as f64, self.res_y as f64) as usize * self.res_x)
                    as u32
            })
            .collect()
    }

    /// A row's cell width against the equator's.
    pub fn row_scale(&self, y: f64) -> f64 {
        if !self.sphere() {
            return 1.0;
        }
        self.row_scales[self.wrap_row(y.floor()) as usize]
    }

    /// A cell's area against a chart cell's.
    pub fn cell_area(&self, y: f64) -> f64 {
        if !self.sphere() {
            return 1.0;
        }
        self.cell_areas[self.wrap_row(y.floor()) as usize]
    }

    /// The width of the edge between row y − 1 and row y.
    pub fn edge_scale(&self, y: f64) -> f64 {
        if !self.sphere() {
            return 1.0;
        }
        self.edge_scales[js::max(0.0, js::min(self.res_y as f64, js::round(y))) as usize]
    }

    /// The cells a disc of `radius` (domain units) about (x, y) can reach.
    pub fn disc_box(&self, x: f64, y: f64, radius: f64) -> CellBox {
        let cell_w = self.cell_w();
        let cell_h = self.cell_h();
        let (rx, ry) = (self.res_x as i64, self.res_y as i64);
        if !self.sphere() {
            let mut out = CellBox {
                x0: ((x - radius) / cell_w).floor() as i64,
                x1: ((x + radius) / cell_w).ceil() as i64,
                y0: ((y - radius) / cell_h).floor() as i64,
                y1: ((y + radius) / cell_h).ceil() as i64,
            };
            if out.x1 - out.x0 + 1 > rx {
                out.x0 = 0;
                out.x1 = rx - 1;
            }
            if out.y1 - out.y0 + 1 > ry {
                out.y0 = 0;
                out.y1 = ry - 1;
            }
            return out;
        }
        let p = self.domain.wrap_point(x, y);
        let yc = p.y;
        let mut out = CellBox {
            y0: js::max(0.0, ((yc - radius) / cell_h).floor()) as i64,
            y1: js::min((ry - 1) as f64, ((yc + radius) / cell_h).ceil()) as i64,
            x0: 0,
            x1: rx - 1,
        };
        if yc - radius <= 0.0 || yc + radius >= self.domain.height {
            return out;
        }
        let big_r = self.domain.width / (2.0 * std::f64::consts::PI);
        let ratio = det_sin(radius / big_r) / det_sin(yc / big_r);
        // A NaN ratio returns too, as `!(ratio < 1)` does.
        if ratio.is_nan() || ratio >= 1.0 {
            return out;
        }
        let span = det_asin(ratio) * big_r * (1.0 + 1e-9) + 1e-6;
        let x0 = ((p.x - span) / cell_w).floor() as i64;
        let x1 = ((p.x + span) / cell_w).ceil() as i64;
        if x1 - x0 + 1 > rx {
            return out;
        }
        out.x0 = x0;
        out.x1 = x1;
        out
    }

    /// Each pole row made one value, its mean, in place (only the cells
    /// `mask` marks, when given). Nothing on the torus.
    pub fn average_pole_rows(&self, field: &mut [f32], mask: Option<&[u8]>) {
        if !self.sphere() {
            return;
        }
        let rows: Vec<usize> = if self.res_y == 1 {
            vec![0]
        } else {
            vec![0, self.res_y - 1]
        };
        for row in rows {
            let base = row * self.res_x;
            let Some(mask) = mask else {
                let mut sum = 0.0;
                for i in 0..self.res_x {
                    sum += field[base + i] as f64;
                }
                field[base..base + self.res_x].fill((sum / self.res_x as f64) as f32);
                continue;
            };
            let mut sum = 0.0;
            let mut count = 0;
            for i in 0..self.res_x {
                if mask[base + i] != 0 {
                    sum += field[base + i] as f64;
                    count += 1;
                }
            }
            if count == 0 {
                continue;
            }
            let mean = (sum / count as f64) as f32;
            for i in 0..self.res_x {
                if mask[base + i] != 0 {
                    field[base + i] = mean;
                }
            }
        }
    }

    /// Row r (any integer) of the sphere sampled linearly at column gx.
    fn row_sample(&self, field: &[f32], r: f64, gx: f64) -> f64 {
        let rx = self.res_x as f64;
        let x = wrap_value(
            if self.crossed(r) {
                gx + self.half_cols
            } else {
                gx
            },
            rx,
        );
        let x0 = x.floor();
        let x1 = if x0 + 1.0 < rx { x0 + 1.0 } else { 0.0 };
        let tx = x - x0;
        let base = self.wrap_row(r) as usize * self.res_x;
        field[base + x0 as usize] as f64 * (1.0 - tx) + field[base + x1 as usize] as f64 * tx
    }

    /// Bilinear sample at fractional GRID coordinates, cell centres at
    /// integers.
    pub fn sample_bilinear(&self, field: &[f32], gx: f64, gy: f64) -> f64 {
        if !self.sphere() {
            return sample_bilinear_grid(field, self.res_x, self.res_y, gx, gy);
        }
        let y0 = gy.floor();
        let ty = gy - y0;
        let top = self.row_sample(field, y0, gx);
        let bottom = self.row_sample(field, y0 + 1.0, gx);
        top * (1.0 - ty) + bottom * ty
    }

    /// The sample in the form the erosion forcing's reader was written in:
    /// the fraction taken from the coordinate as given.
    pub fn interpolate(&self, field: &[f32], gx: f64, gy: f64) -> f64 {
        if self.sphere() {
            return self.sample_bilinear(field, gx, gy);
        }
        let rx = self.res_x as f64;
        let x0 = gx.floor();
        let y0 = gy.floor();
        let fx = gx - x0;
        let fy = gy - y0;
        let c0 = wrap_value(x0, rx) as usize;
        let c1 = wrap_value(x0 + 1.0, rx) as usize;
        let r0 = wrap_value(y0, self.res_y as f64) as usize * self.res_x;
        let r1 = wrap_value(y0 + 1.0, self.res_y as f64) as usize * self.res_x;
        let f = |i: usize| field[i] as f64;
        (f(r0 + c0) * (1.0 - fx) + f(r0 + c1) * fx) * (1.0 - fy)
            + (f(r1 + c0) * (1.0 - fx) + f(r1 + c1) * fx) * fy
    }

    /// A semi-Lagrangian departure: the bilinear taps of the point reached
    /// from cell (gx, gy)'s centre by (dx, dy) cells in its frame, into slot
    /// `at`.
    pub fn taps_at(&self, gx: f64, gy: f64, dx: f64, dy: f64, out: &mut BilinearTaps, at: usize) {
        let (i, k) = (4 * at, 3 * at);
        if !self.sphere() {
            let (rx, ry) = (self.res_x, self.res_y);
            let x = wrap_value(gx + dx, rx as f64);
            let y = wrap_value(gy + dy, ry as f64);
            let x0 = x.floor();
            let y0 = y.floor();
            let (x0i, y0i) = (x0 as usize, y0 as usize);
            let x1 = (x0i + 1) % rx;
            let y1 = (y0i + 1) % ry;
            let tx = x - x0;
            out.cells[i] = (y0i * rx + x0i) as u32;
            out.cells[i + 1] = (y0i * rx + x1) as u32;
            out.cells[i + 2] = (y1 * rx + x0i) as u32;
            out.cells[i + 3] = (y1 * rx + x1) as u32;
            out.weights[k] = tx;
            out.weights[k + 1] = tx;
            out.weights[k + 2] = y - y0;
            return;
        }
        let cell_w = self.cell_w();
        let cell_h = self.cell_h();
        let p = self.domain.advance(
            (gx + 0.5) * cell_w,
            (gy + 0.5) * cell_h,
            dx * cell_w,
            dy * cell_h,
        );
        let sx = p.x / cell_w - 0.5;
        let sy = p.y / cell_h - 0.5;
        let y0 = sy.floor();
        let rx = self.res_x as f64;
        for r in 0..2 {
            let row = y0 + r as f64;
            let x = wrap_value(
                if self.crossed(row) {
                    sx + self.half_cols
                } else {
                    sx
                },
                rx,
            );
            let x0 = x.floor();
            let x1 = if x0 + 1.0 < rx { x0 + 1.0 } else { 0.0 };
            let base = self.wrap_row(row) as usize * self.res_x;
            out.cells[i + 2 * r] = (base + x0 as usize) as u32;
            out.cells[i + 2 * r + 1] = (base + x1 as usize) as u32;
            out.weights[k + r] = x - x0;
        }
        out.weights[k + 2] = sy - y0;
    }

    /// The cell reached from cell (gx, gy)'s centre by (dx, dy) cells.
    pub fn cell_displaced(&self, gx: f64, gy: f64, dx: f64, dy: f64) -> usize {
        if !self.sphere() {
            return self.index(js::round(gx + dx) as i64, js::round(gy + dy) as i64);
        }
        let cell_w = self.cell_w();
        let cell_h = self.cell_h();
        let p = self.domain.advance(
            (gx + 0.5) * cell_w,
            (gy + 0.5) * cell_h,
            dx * cell_w,
            dy * cell_h,
        );
        self.cell_at(p.x, p.y)
    }

    /// The fractional grid point reached from (gx, gy) by (dx, dy) cells:
    /// unwrapped on the torus, along the great circle on the sphere.
    pub fn displaced(&self, gx: f64, gy: f64, dx: f64, dy: f64) -> Vec2 {
        if !self.sphere() {
            return Vec2 {
                x: gx + dx,
                y: gy + dy,
            };
        }
        let cell_w = self.cell_w();
        let cell_h = self.cell_h();
        let p = self.domain.advance(
            (gx + 0.5) * cell_w,
            (gy + 0.5) * cell_h,
            dx * cell_w,
            dy * cell_h,
        );
        Vec2 {
            x: p.x / cell_w - 0.5,
            y: p.y / cell_h - 0.5,
        }
    }

    /// Bilinear sample at DOMAIN coordinates, cell centres at (i + 0.5).
    pub fn sample_bilinear_at(&self, field: &[f32], x: f64, y: f64) -> f64 {
        let (w, h) = (self.domain.width, self.domain.height);
        if !self.sphere() {
            return sample_bilinear_world(field, self.res_x, self.res_y, x, y, w, h);
        }
        self.sample_bilinear(
            field,
            (x / w) * self.res_x as f64 - 0.5,
            (y / h) * self.res_y as f64 - 0.5,
        )
    }

    /// The cell that holds domain point (x, y).
    pub fn cell_at(&self, x: f64, y: f64) -> usize {
        let (w, h) = (self.domain.width, self.domain.height);
        let (px, py) = if self.sphere() {
            let p = self.domain.wrap_point(x, y);
            (p.x, p.y)
        } else {
            (wrap_value(x, w), wrap_value(y, h))
        };
        let gx = js::min(
            (self.res_x - 1) as f64,
            ((px / w) * self.res_x as f64).floor(),
        );
        let gy = js::min(
            (self.res_y - 1) as f64,
            ((py / h) * self.res_y as f64).floor(),
        );
        gy as usize * self.res_x + gx as usize
    }

    pub fn sample_nearest_at(&self, field: &[f32], x: f64, y: f64) -> f64 {
        if !self.sphere() {
            let (w, h) = (self.domain.width, self.domain.height);
            return sample_nearest_world(field, self.res_x, self.res_y, x, y, w, h);
        }
        field[self.cell_at(x, y)] as f64
    }

    /// The whole raster resampled bilinearly onto a finer grid: the torus
    /// samples the target cell's corner, the sphere its centre.
    pub fn upscale(&self, field: &[f32], to_res_x: usize, to_res_y: usize) -> Vec<f32> {
        if !self.sphere() {
            return upscale_bilinear_toroidal(field, self.res_x, self.res_y, to_res_x, to_res_y);
        }
        let mut out = vec![0f32; to_res_x * to_res_y];
        let fx = self.res_x as f64 / to_res_x as f64;
        let fy = self.res_y as f64 / to_res_y as f64;
        for y in 0..to_res_y {
            let gy = (y as f64 + 0.5) * fy - 0.5;
            for x in 0..to_res_x {
                out[y * to_res_x + x] =
                    self.sample_bilinear(field, (x as f64 + 0.5) * fx - 0.5, gy) as f32;
            }
        }
        out
    }
}
