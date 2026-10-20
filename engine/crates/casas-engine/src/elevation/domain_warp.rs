//! `elevation/domainWarp.ts`: the query point displaced before the
//! elevation field is sampled, so every contour ripples. A chart offset on
//! the torus, a tangent offset along the globe on the sphere.

use crate::core::domain::{Domain, GlobeFrame, Vec2};
use crate::core::field::wrap_value;
use crate::core::interpolation::smoothstep;
use crate::core::js::{imul, to_int32, to_uint32};

use super::elevation_tune_params::ELEVATION_TUNING;
use super::globe_noise::globe_octave_on;

fn hash_lattice_point(ix: f64, iy: f64, warp_seed: f64, axis_salt: f64) -> f64 {
    let mut h = to_uint32(
        ix * 374761393.0 + iy * 668265263.0 + warp_seed * 2246822519.0 + axis_salt * 3266489917.0,
    );
    h = (h ^ (h >> 13)).wrapping_mul(1274126177);
    h ^= h >> 16;
    h as f64 / 4294967296.0
}

fn periodic_value_noise_2d(
    x: f64,
    y: f64,
    period_x: f64,
    period_y: f64,
    warp_seed: f64,
    axis_salt: f64,
) -> f64 {
    let x0 = x.floor();
    let y0 = y.floor();
    let fx = x - x0;
    let fy = y - y0;
    let x0m = to_int32(wrap_value(x0, period_x)) as f64;
    let y0m = to_int32(wrap_value(y0, period_y)) as f64;
    let x1m = (x0m + 1.0) % period_x;
    let y1m = (y0m + 1.0) % period_y;
    let v00 = hash_lattice_point(x0m, y0m, warp_seed, axis_salt);
    let v10 = hash_lattice_point(x1m, y0m, warp_seed, axis_salt);
    let v01 = hash_lattice_point(x0m, y1m, warp_seed, axis_salt);
    let v11 = hash_lattice_point(x1m, y1m, warp_seed, axis_salt);
    let sx = smoothstep(fx);
    let sy = smoothstep(fy);
    let top = v00 + (v10 - v00) * sx;
    let bottom = v01 + (v11 - v01) * sx;
    top + (bottom - top) * sy
}

const WARP_OCTAVES: [(f64, f64, f64); 3] = [(8.0, 4.0, 1.0), (16.0, 8.0, 0.5), (32.0, 16.0, 0.25)];

fn fbm_noise(x: f64, y: f64, width: f64, height: f64, warp_seed: f64, axis_salt: f64) -> f64 {
    let (mut sum, mut amplitude_sum) = (0.0, 0.0);
    for (cx, cy, amp) in WARP_OCTAVES {
        let n = periodic_value_noise_2d(
            (x / width) * cx,
            (y / height) * cy,
            cx,
            cy,
            warp_seed,
            axis_salt,
        );
        sum += (n * 2.0 - 1.0) * amp;
        amplitude_sum += amp;
    }
    sum / amplitude_sum
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Axis {
    X,
    Y,
}

/// The x or y offset of the torus's warp at (x, y), domain units.
pub fn domain_warp_delta(x: f64, y: f64, domain: &Domain, warp_seed: f64, axis: Axis) -> f64 {
    let salt = match axis {
        Axis::X => ELEVATION_TUNING.axis_salt_x,
        Axis::Y => ELEVATION_TUNING.axis_salt_y,
    };
    fbm_noise(x, y, domain.width, domain.height, warp_seed, salt)
        * (ELEVATION_TUNING.warp_amplitude_m / domain.metres_per_unit)
}

/// The point (x, y) warped: unwrapped on the torus, advanced along the
/// globe on the sphere.
pub fn domain_warp_point(x: f64, y: f64, domain: &Domain, warp_seed: f64) -> Vec2 {
    if !domain.is_sphere() {
        return Vec2 {
            x: x + domain_warp_delta(x, y, domain, warp_seed, Axis::X),
            y: y + domain_warp_delta(x, y, domain, warp_seed, Axis::Y),
        };
    }
    let frame = domain.globe_frame(x, y);
    let amplitude = ELEVATION_TUNING.warp_amplitude_m / domain.metres_per_unit;
    let vx = globe_fbm(&frame, domain, warp_seed, ELEVATION_TUNING.axis_salt_x) * amplitude;
    let vy = globe_fbm(&frame, domain, warp_seed, ELEVATION_TUNING.axis_salt_y) * amplitude;
    let vz = globe_fbm(&frame, domain, warp_seed, ELEVATION_TUNING.axis_salt_z) * amplitude;
    let east = vx * frame.ex + vy * frame.ey + vz * frame.ez;
    let south = vx * frame.sx + vy * frame.sy + vz * frame.sz;
    domain.advance(x, y, east, south)
}

fn globe_fbm(frame: &GlobeFrame, domain: &Domain, warp_seed: f64, axis_salt: f64) -> f64 {
    let seed = to_int32(warp_seed + imul(axis_salt, 0x9e3779b9u32 as f64) as f64) as f64;
    let (mut sum, mut amplitude_sum) = (0.0, 0.0);
    for (cx, _, amp) in WARP_OCTAVES {
        sum += (globe_octave_on(frame, cx, domain, seed) * 2.0 - 1.0) * amp;
        amplitude_sum += amp;
    }
    sum / amplitude_sum
}
