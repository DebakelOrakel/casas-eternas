//! The world's topology: the TypeScript engine's `core/domain.ts`, for the
//! torus and the sphere (DEC-0035, docs/decisions/two-shapes.md). Distance,
//! offset and wrap between points go through a [`Domain`], never through
//! the chart's arithmetic.
//!
//! This port holds what the mesh needs so far; the rest of `domain.ts`
//! (latitude, advance, transport, the grids, the noise space) comes with the
//! modules that read it. The sphere's trig cache is not ported: a hit gives
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

impl Domain {
    pub fn torus(width: f64, height: f64) -> Self {
        Domain {
            kind: Kind::Torus,
            width,
            height,
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
            radius: width / (2.0 * std::f64::consts::PI),
            to_lon: (2.0 * std::f64::consts::PI) / width,
            to_colat: std::f64::consts::PI / height,
        }
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
