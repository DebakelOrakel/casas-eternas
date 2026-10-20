//! `tectonics/plateMotion.ts`: a plate's rigid motion. On the torus a drift
//! plus a spin about the plate's own centroid, on the sphere one rotation
//! about an Euler pole; the velocity at a point, a point moved forward and
//! back, a motion fitted to the mantle flow, relaxed toward one, or made to
//! move with a velocity at a point. Velocities are domain units per Ma,
//! turns radians per Ma (DEC-0036 phase 8f). The reasoning is in the
//! TypeScript file.

use crate::core::det_math::{det_acos, det_cos, det_sin};
use crate::core::domain::{Domain, Vec2};
use crate::core::js;
use crate::mantle::mantle_field::{MantleFlow, MantleMesh};

use super::plate_seeds::PlateSeed;

/// The torus's drift + spin, about (centroid_x, centroid_y).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RigidMotion {
    pub drift_x: f64,
    pub drift_y: f64,
    pub spin: f64,
    pub centroid_x: f64,
    pub centroid_y: f64,
}

/// The sphere's rotation about the unit axis (pole_x, pole_y, pole_z) at
/// `rate` radians per Ma, rate ≥ 0.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EulerMotion {
    pub pole_x: f64,
    pub pole_y: f64,
    pub pole_z: f64,
    pub rate: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PlateMotion {
    Rigid(RigidMotion),
    Euler(EulerMotion),
}

/// ω = (wx, wy, wz) as an Euler motion, the pole kept from `previous` when
/// ω is 0.
fn euler_of(wx: f64, wy: f64, wz: f64, previous: Option<&EulerMotion>) -> EulerMotion {
    let rate = (wx * wx + wy * wy + wz * wz).sqrt();
    if rate == 0.0 {
        return EulerMotion {
            pole_x: previous.map_or(0.0, |p| p.pole_x),
            pole_y: previous.map_or(0.0, |p| p.pole_y),
            pole_z: previous.map_or(1.0, |p| p.pole_z),
            rate: 0.0,
        };
    }
    EulerMotion {
        pole_x: wx / rate,
        pole_y: wy / rate,
        pole_z: wz / rate,
        rate,
    }
}

/// (x, y) turned by `angle` about the unit axis k (Rodrigues), named in the
/// chart again.
fn rotate_on_globe(x: f64, y: f64, kx: f64, ky: f64, kz: f64, angle: f64, domain: &Domain) -> Vec2 {
    let f = domain.globe_frame(x, y);
    let (vx, vy, vz) = (f.px, f.py, f.pz);
    let c = det_cos(angle);
    let s = det_sin(angle);
    let kv = (kx * vx + ky * vy + kz * vz) * (1.0 - c);
    let rx = vx * c + (ky * vz - kz * vy) * s + kx * kv;
    let ry = vy * c + (kz * vx - kx * vz) * s + ky * kv;
    let rz = vz * c + (kx * vy - ky * vx) * s + kz * kv;
    domain.globe_locate(rx, ry, rz)
}

const EULER_POLE_ARC_MIN: f64 = std::f64::consts::PI / 6.0;
const EULER_POLE_ARC_MAX: f64 = std::f64::consts::PI / 2.0;

fn generate_euler_motion(
    seed: &PlateSeed,
    domain: &Domain,
    random: &mut dyn FnMut() -> f64,
) -> EulerMotion {
    let f = domain.globe_frame(seed.x, seed.y);
    let arc = EULER_POLE_ARC_MIN + random() * (EULER_POLE_ARC_MAX - EULER_POLE_ARC_MIN);
    let azimuth = random() * std::f64::consts::PI * 2.0;
    let target_speed = fresh_speed(random(), domain);
    let direction = if random() < 0.5 { 1.0 } else { -1.0 };
    let r = domain.radius();
    let ca = det_cos(arc);
    let sa = det_sin(arc);
    let ce = det_cos(azimuth);
    let se = det_sin(azimuth);
    let tx = ce * f.ex + se * f.sx;
    let ty = ce * f.ey + se * f.sy;
    let tz = ce * f.ez + se * f.sz;
    let kx = (f.px / r) * ca + tx * sa;
    let ky = (f.py / r) * ca + ty * sa;
    let kz = (f.pz / r) * ca + tz * sa;
    let rate = target_speed / (r * sa);
    euler_of(
        direction * rate * kx,
        direction * rate * ky,
        direction * rate * kz,
        None,
    )
}

const ROTATION_RADIUS_MIN_FACTOR: f64 = 0.5;
const ROTATION_RADIUS_MAX_FACTOR: f64 = 2.5;
const FRESH_SPEED_MIN_KM_PER_MYR: f64 = 11.7;
const FRESH_SPEED_MAX_KM_PER_MYR: f64 = 35.1;

/// A fresh speed drawn from u in [0, 1), domain units per Ma.
fn fresh_speed(u: f64, domain: &Domain) -> f64 {
    ((FRESH_SPEED_MIN_KM_PER_MYR + u * (FRESH_SPEED_MAX_KM_PER_MYR - FRESH_SPEED_MIN_KM_PER_MYR))
        * 1000.0)
        / domain.metres_per_unit
}

/// A velocity in domain units per Ma, as km/Myr.
pub fn km_per_myr(units_per_ma: f64, domain: &Domain) -> f64 {
    (units_per_ma * domain.metres_per_unit) / 1000.0
}

pub fn generate_plate_motions(
    seeds: &[PlateSeed],
    domain: &Domain,
    random: &mut dyn FnMut() -> f64,
) -> Vec<PlateMotion> {
    if domain.is_sphere() {
        return seeds
            .iter()
            .map(|s| PlateMotion::Euler(generate_euler_motion(s, domain, random)))
            .collect();
    }
    let typical_spacing = ((domain.width * domain.height) / seeds.len() as f64).sqrt();
    seeds
        .iter()
        .map(|seed| {
            let radius = (ROTATION_RADIUS_MIN_FACTOR
                + random() * (ROTATION_RADIUS_MAX_FACTOR - ROTATION_RADIUS_MIN_FACTOR))
                * typical_spacing;
            let angle = random() * std::f64::consts::PI * 2.0;
            let center_x = seed.x + det_cos(angle) * radius;
            let center_y = seed.y + det_sin(angle) * radius;
            let target_speed = fresh_speed(random(), domain);
            let direction = if random() < 0.5 { 1.0 } else { -1.0 };
            let spin = (direction * target_speed) / radius;
            let o = domain.delta(seed.x, seed.y, center_x, center_y);
            PlateMotion::Rigid(RigidMotion {
                drift_x: -o.y * spin,
                drift_y: o.x * spin,
                spin,
                centroid_x: seed.x,
                centroid_y: seed.y,
            })
        })
        .collect()
}

/// The velocity at (x, y), domain units per Ma, in the point's frame.
pub fn get_velocity_at(x: f64, y: f64, motion: &PlateMotion, domain: &Domain) -> Vec2 {
    match motion {
        PlateMotion::Euler(m) => {
            let f = domain.globe_frame(x, y);
            let wx = m.pole_x * m.rate;
            let wy = m.pole_y * m.rate;
            let wz = m.pole_z * m.rate;
            let vx = wy * f.pz - wz * f.py;
            let vy = wz * f.px - wx * f.pz;
            let vz = wx * f.py - wy * f.px;
            Vec2 {
                x: vx * f.ex + vy * f.ey + vz * f.ez,
                y: vx * f.sx + vy * f.sy + vz * f.sz,
            }
        }
        PlateMotion::Rigid(m) => {
            let o = domain.delta(x, y, m.centroid_x, m.centroid_y);
            Vec2 {
                x: m.drift_x - o.y * m.spin,
                y: m.drift_y + o.x * m.spin,
            }
        }
    }
}

/// A point advanced by one motion step of `step` Ma.
pub fn advance_point_by_motion(
    x: f64,
    y: f64,
    motion: &PlateMotion,
    step: f64,
    domain: &Domain,
) -> Vec2 {
    match motion {
        PlateMotion::Euler(m) => {
            rotate_on_globe(x, y, m.pole_x, m.pole_y, m.pole_z, m.rate * step, domain)
        }
        PlateMotion::Rigid(m) => {
            let r = domain.rotate_around(x, y, m.centroid_x, m.centroid_y, m.spin * step);
            domain.advance(r.x, r.y, m.drift_x * step, m.drift_y * step)
        }
    }
}

/// The inverse of `advance_point_by_motion`.
pub fn reverse_point_by_motion(
    x: f64,
    y: f64,
    motion: &PlateMotion,
    step: f64,
    domain: &Domain,
) -> Vec2 {
    match motion {
        PlateMotion::Euler(m) => {
            rotate_on_globe(x, y, m.pole_x, m.pole_y, m.pole_z, -m.rate * step, domain)
        }
        PlateMotion::Rigid(m) => {
            let ux = x - m.drift_x * step;
            let uy = y - m.drift_y * step;
            domain.rotate_around(ux, uy, m.centroid_x, m.centroid_y, -m.spin * step)
        }
    }
}

/// The seed nearest (x, y), the first of equals.
fn nearest_seed(seeds: &[PlateSeed], x: f64, y: f64, domain: &Domain) -> usize {
    let mut best = 0;
    let mut best_sq = f64::INFINITY;
    for (p, s) in seeds.iter().enumerate() {
        let d = domain.distance_sq(x, y, s.x, s.y);
        if d < best_sq {
            best_sq = d;
            best = p;
        }
    }
    best
}

/// Each plate's rigid motion fitted to the mantle flow under its footprint
/// (the mantle's cells assigned to their nearest seed), the spin held at
/// one mantle cell's arm.
pub fn fit_motions_to_flow(
    seeds: &[PlateSeed],
    flow: &MantleFlow,
    mm: &MantleMesh,
    domain: &Domain,
) -> Vec<PlateMotion> {
    if domain.is_sphere() {
        return fit_euler_motions_to_flow(seeds, flow, mm, domain);
    }
    let mesh = &mm.mesh;
    let arm_sq = mm.cell_units * mm.cell_units;
    let unit = mesh.count as f64 / mm.total_area;
    let n = seeds.len();
    let mut sum_ux = vec![0.0; n];
    let mut sum_uy = vec![0.0; n];
    let mut sum_cross = vec![0.0; n];
    let mut sum_rsq = vec![0.0; n];
    let mut weight = vec![0.0; n];
    for i in 0..mesh.count {
        let (wx, wy) = (mesh.x[i], mesh.y[i]);
        let best = nearest_seed(seeds, wx, wy, domain);
        let w = mesh.area[i] * unit;
        let ux = flow.east[i];
        let uy = flow.south[i];
        let o = domain.delta(wx, wy, seeds[best].x, seeds[best].y);
        let (rx, ry) = (o.x, o.y);
        sum_ux[best] += w * ux;
        sum_uy[best] += w * uy;
        sum_cross[best] += w * (rx * uy - ry * ux);
        sum_rsq[best] += w * (rx * rx + ry * ry);
        weight[best] += w;
    }
    for v in sum_rsq.iter_mut() {
        *v += arm_sq;
    }
    seeds
        .iter()
        .enumerate()
        .map(|(p, seed)| {
            PlateMotion::Rigid(RigidMotion {
                drift_x: if weight[p] > 0.0 {
                    sum_ux[p] / weight[p]
                } else {
                    0.0
                },
                drift_y: if weight[p] > 0.0 {
                    sum_uy[p] / weight[p]
                } else {
                    0.0
                },
                spin: if sum_rsq[p] > 1e-6 {
                    sum_cross[p] / sum_rsq[p]
                } else {
                    0.0
                },
                centroid_x: seed.x,
                centroid_y: seed.y,
            })
        })
        .collect()
}

fn fit_euler_motions_to_flow(
    seeds: &[PlateSeed],
    flow: &MantleFlow,
    mm: &MantleMesh,
    domain: &Domain,
) -> Vec<PlateMotion> {
    let mesh = &mm.mesh;
    let arm_sq = mm.cell_units * mm.cell_units;
    let n = seeds.len();
    let mut m = vec![0.0; n * 6];
    let mut b = vec![0.0; n * 3];
    for i in 0..mesh.count {
        let (wx, wy) = (mesh.x[i], mesh.y[i]);
        let w = mesh.area[i];
        let best = nearest_seed(seeds, wx, wy, domain);
        let (ue, us) = (flow.east[i], flow.south[i]);
        let f = domain.globe_frame(wx, wy);
        let ux = ue * f.ex + us * f.sx;
        let uy = ue * f.ey + us * f.sy;
        let uz = ue * f.ez + us * f.sz;
        let (rx, ry, rz) = (f.px, f.py, f.pz);
        let rr = rx * rx + ry * ry + rz * rz;
        let o = best * 6;
        m[o] += w * (rr - rx * rx);
        m[o + 1] += w * (rr - ry * ry);
        m[o + 2] += w * (rr - rz * rz);
        m[o + 3] -= w * rx * ry;
        m[o + 4] -= w * rx * rz;
        m[o + 5] -= w * ry * rz;
        b[best * 3] += w * (ry * uz - rz * uy);
        b[best * 3 + 1] += w * (rz * ux - rx * uz);
        b[best * 3 + 2] += w * (rx * uy - ry * ux);
    }
    let rest_arm = (mm.total_area / mesh.count as f64) * arm_sq;
    for (p, seed) in seeds.iter().enumerate() {
        let f = domain.globe_frame(seed.x, seed.y);
        let r = domain.radius();
        let (sx, sy, sz) = (f.px / r, f.py / r, f.pz / r);
        let o = p * 6;
        m[o] += rest_arm * sx * sx;
        m[o + 1] += rest_arm * sy * sy;
        m[o + 2] += rest_arm * sz * sz;
        m[o + 3] += rest_arm * sx * sy;
        m[o + 4] += rest_arm * sx * sz;
        m[o + 5] += rest_arm * sy * sz;
    }
    (0..n)
        .map(|p| {
            let o = p * 6;
            let ridge = (m[o] + m[o + 1] + m[o + 2]) * 1e-6;
            let a = m[o] + ridge;
            let d = m[o + 1] + ridge;
            let f = m[o + 2] + ridge;
            let (bb, c, e) = (m[o + 3], m[o + 4], m[o + 5]);
            let c00 = d * f - e * e;
            let c01 = c * e - bb * f;
            let c02 = bb * e - c * d;
            let c11 = a * f - c * c;
            let c12 = bb * c - a * e;
            let c22 = a * d - bb * bb;
            let det = a * c00 + bb * c01 + c * c02;
            // `!(|det| > 0)`: a zero or NaN determinant.
            if det.is_nan() || det.abs() == 0.0 {
                return PlateMotion::Euler(euler_of(0.0, 0.0, 0.0, None));
            }
            let (b0, b1, b2) = (b[p * 3], b[p * 3 + 1], b[p * 3 + 2]);
            PlateMotion::Euler(euler_of(
                (c00 * b0 + c01 * b1 + c02 * b2) / det,
                (c01 * b0 + c11 * b1 + c12 * b2) / det,
                (c02 * b0 + c12 * b1 + c22 * b2) / det,
                None,
            ))
        })
        .collect()
}

/// A plate's motion relaxed toward the fitted one by `fraction`, in place.
/// Panics on a torus motion and a sphere motion together.
pub fn relax_motion_toward(motion: &mut PlateMotion, target: &PlateMotion, fraction: f64) {
    match (motion, target) {
        (PlateMotion::Euler(m), PlateMotion::Euler(t)) => {
            let wx = m.pole_x * m.rate;
            let wy = m.pole_y * m.rate;
            let wz = m.pole_z * m.rate;
            *m = euler_of(
                wx + (t.pole_x * t.rate - wx) * fraction,
                wy + (t.pole_y * t.rate - wy) * fraction,
                wz + (t.pole_z * t.rate - wz) * fraction,
                Some(m),
            );
        }
        (PlateMotion::Rigid(m), PlateMotion::Rigid(t)) => {
            m.drift_x += (t.drift_x - m.drift_x) * fraction;
            m.drift_y += (t.drift_y - m.drift_y) * fraction;
            m.spin += (t.spin - m.spin) * fraction;
            m.centroid_x = t.centroid_x;
            m.centroid_y = t.centroid_y;
        }
        _ => panic!("a torus motion and a sphere motion cannot be blended"),
    }
}

/// The motion that moves (x, y) with velocity (vx, vy) and does not turn
/// about it.
pub fn motion_moving_at(x: f64, y: f64, vx: f64, vy: f64, domain: &Domain) -> PlateMotion {
    if !domain.is_sphere() {
        return PlateMotion::Rigid(RigidMotion {
            drift_x: vx,
            drift_y: vy,
            spin: 0.0,
            centroid_x: x,
            centroid_y: y,
        });
    }
    let f = domain.globe_frame(x, y);
    let ux = vx * f.ex + vy * f.sx;
    let uy = vx * f.ey + vy * f.sy;
    let uz = vx * f.ez + vy * f.sz;
    let (rx, ry, rz) = (f.px, f.py, f.pz);
    let rr = rx * rx + ry * ry + rz * rz;
    PlateMotion::Euler(euler_of(
        (ry * uz - rz * uy) / rr,
        (rz * ux - rx * uz) / rr,
        (rx * uy - ry * ux) / rr,
        None,
    ))
}

/// The arc, radians, from a point to a motion's Euler pole.
pub fn arc_to_euler_pole(x: f64, y: f64, motion: &EulerMotion, domain: &Domain) -> f64 {
    let f = domain.globe_frame(x, y);
    let r = domain.radius();
    let dot = (f.px * motion.pole_x + f.py * motion.pole_y + f.pz * motion.pole_z) / r;
    det_acos(js::max(-1.0, js::min(1.0, dot)))
}
