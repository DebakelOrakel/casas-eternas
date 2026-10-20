//! The world's topology: the TypeScript engine's `core/domain.ts`, for the
//! torus and the sphere (DEC-0035, docs/decisions/two-shapes.md). Distance,
//! offset and wrap between points go through a [`Domain`], never through
//! the chart's arithmetic.
//!
//! This port holds what the mesh needs so far; the rest of `domain.ts`
//! (latitude, the grids, the noise space's frame) comes with the modules
//! that read it. The sphere's trig cache is not ported: a hit gives
//! the bits a miss computes, so it changes the time and nothing else.

use super::det_math::{det_atan2, det_cos, det_sin};
use super::js;

/// An offset or a point in domain units.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Vec2 {
    pub x: f64,
    pub y: f64,
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
    /// The sphere's radius, W / 2π (0 on the torus).
    radius: f64,
    to_lon: f64,
    to_colat: f64,
}

/// `core/field.ts` `wrapValue`: v into [0, n).
#[inline]
pub fn wrap_value(v: f64, n: f64) -> f64 {
    let m = if v >= 0.0 {
        if v < n {
            v
        } else if v < 2.0 * n {
            v - n
        } else {
            v % n
        }
    } else if v > -n {
        v
    } else {
        v % n
    };
    let t = m + n;
    if t < n {
        t
    } else if t < 2.0 * n {
        t - n
    } else {
        t % n
    }
}

/// `core/toroidal.ts` `wrappedDelta`: the shortest signed offset from b to
/// a on a line of the given period.
#[inline]
pub fn wrapped_delta(a: f64, b: f64, period: f64) -> f64 {
    let delta = a - b;
    delta - period * js::round(delta / period)
}

/// `core/mapConfig.ts`: the torus's metres per macro cell.
pub const TORUS_METERS_PER_CELL: f64 = 7800.0;
/// `core/mapConfig.ts`: the sphere's equator, and the map's width in cells.
pub const SPHERE_EQUATOR_METERS: f64 = 20_000_000.0;
pub const MAP_WIDTH: f64 = 2048.0;

impl Domain {
    /// The torus at the default scale, `torusDomain(width, height)`.
    pub fn torus(width: f64, height: f64) -> Self {
        Domain {
            kind: Kind::Torus,
            width,
            height,
            metres_per_unit: TORUS_METERS_PER_CELL,
            radius: 0.0,
            to_lon: 0.0,
            to_colat: 0.0,
        }
    }

    /// The sphere: a 2:1 chart, x the longitude (λ = 2π·x/W), y the
    /// colatitude from the north pole (θ = π·y/H). Panics on another ratio,
    /// as `sphereDomain` throws.
    pub fn sphere(width: f64, height: f64) -> Self {
        assert!(
            (width - 2.0 * height).abs() <= 1e-9 * width,
            "a sphere domain is a 2:1 chart (longitude × colatitude), got {width} × {height}"
        );
        Domain {
            kind: Kind::Sphere,
            width,
            height,
            metres_per_unit: SPHERE_EQUATOR_METERS / MAP_WIDTH,
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
