//! `elevation/hypsometry.ts`: relief across the continental interior, the
//! distribution of heights the margin profile does not have.

use crate::core::domain::Domain;
use crate::core::field::wrap_value;
use crate::core::interpolation::smoothstep;
use crate::core::js::{self, to_int32, to_uint32};

use super::elevation_scale::meters_to_elevation;
use super::elevation_tune_params::ELEVATION_TUNING;
use super::globe_noise::globe_octave_on;

fn hash_lattice_point(ix: f64, iy: f64, seed: f64) -> f64 {
    let mut h = to_uint32(ix * 2654435761.0 + iy * 40503.0 + seed * 1013904223.0);
    h = (h ^ (h >> 15)).wrapping_mul(2246822519);
    h ^= h >> 13;
    h as f64 / 4294967296.0
}

fn periodic_value_noise(x: f64, y: f64, cells_x: f64, cells_y: f64, seed: f64) -> f64 {
    let x0 = x.floor();
    let y0 = y.floor();
    let fx = smoothstep(x - x0);
    let fy = smoothstep(y - y0);
    let (x0w, x1w) = (wrap_value(x0, cells_x), wrap_value(x0 + 1.0, cells_x));
    let (y0w, y1w) = (wrap_value(y0, cells_y), wrap_value(y0 + 1.0, cells_y));
    let n00 = hash_lattice_point(x0w, y0w, seed);
    let n10 = hash_lattice_point(x1w, y0w, seed);
    let n01 = hash_lattice_point(x0w, y1w, seed);
    let n11 = hash_lattice_point(x1w, y1w, seed);
    let top = n00 + (n10 - n00) * fx;
    let bottom = n01 + (n11 - n01) * fx;
    top + (bottom - top) * fy
}

const HYPSOMETRY_OCTAVES: [(f64, f64, f64); 3] =
    [(5.0, 3.0, 1.0), (11.0, 6.0, 0.45), (23.0, 12.0, 0.2)];

/// The signed offset added to the margin profile at a warped point.
pub fn continental_hypsometry(wx: f64, wy: f64, t: f64, domain: &Domain, seed: f64) -> f64 {
    if t <= ELEVATION_TUNING.hypsometry_t_in {
        return 0.0;
    }
    hypsometry_relief(wx, wy, domain, seed) * hypsometry_weight(t)
}

/// How much of the relief a point carries by its t.
pub fn hypsometry_weight(t: f64) -> f64 {
    smoothstep(js::min(
        1.0,
        (t - ELEVATION_TUNING.hypsometry_t_in)
            / (ELEVATION_TUNING.hypsometry_t_full - ELEVATION_TUNING.hypsometry_t_in),
    ))
}

/// The relief by place and seed alone.
pub fn hypsometry_relief(wx: f64, wy: f64, domain: &Domain, seed: f64) -> f64 {
    let frame = if domain.is_sphere() {
        Some(domain.globe_frame(wx, wy))
    } else {
        None
    };
    let (mut sum, mut amplitude_sum) = (0.0, 0.0);
    let mut octave_seed = (to_int32(seed) ^ 0x5f3759df) as f64;
    for (cx, cy, amp) in HYPSOMETRY_OCTAVES {
        let n = match &frame {
            None => periodic_value_noise(
                (wx / domain.width) * cx,
                (wy / domain.height) * cy,
                cx,
                cy,
                octave_seed,
            ),
            Some(f) => globe_octave_on(f, cx, domain, octave_seed),
        };
        sum += (n - 0.5) * 2.0 * amp;
        amplitude_sum += amp;
        octave_seed = to_uint32(octave_seed * 1664525.0 + 1013904223.0) as f64;
    }
    meters_to_elevation((sum / amplitude_sum) * (ELEVATION_TUNING.hypsometry_range_m / 2.0))
}
