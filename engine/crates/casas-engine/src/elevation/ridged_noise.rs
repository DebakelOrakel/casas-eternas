//! The periodic ridged multifractal that textures uplifted terrain, the
//! plains' fine detail noise, and their samplers on the globe. The octave
//! tables and the measured means are explained in
//! `client/src/generator/elevation/ridgedNoise.ts`.
//!
//! The lattice hash sums its products in doubles before the cut to 32
//! bits, as JavaScript does; `seed * 2246822519` is past 2^53 and rounds.

use crate::core::domain::Domain;
use crate::core::field::wrap_value;
use crate::core::interpolation::smoothstep;
use crate::core::js::{to_int32, to_uint32};

use super::globe_noise::globe_octave_on;

fn hash_lattice_point(ix: f64, iy: f64, seed: f64) -> f64 {
    let mut h = to_uint32(ix * 374761393.0 + iy * 668265263.0 + seed * 2246822519.0);
    h = (h ^ (h >> 13)).wrapping_mul(1274126177);
    h ^= h >> 16;
    h as f64 / 4294967296.0
}

/// Bilinear value noise over a lattice that repeats every (cells_x,
/// cells_y) units, in lattice coordinates.
pub fn periodic_value_noise_2d(x: f64, y: f64, cells_x: f64, cells_y: f64, seed: f64) -> f64 {
    let x0 = x.floor();
    let y0 = y.floor();
    let fx = x - x0;
    let fy = y - y0;
    let x0m = to_int32(wrap_value(x0, cells_x)) as f64;
    let y0m = to_int32(wrap_value(y0, cells_y)) as f64;
    let x1m = (x0m + 1.0) % cells_x;
    let y1m = (y0m + 1.0) % cells_y;
    let v00 = hash_lattice_point(x0m, y0m, seed);
    let v10 = hash_lattice_point(x1m, y0m, seed);
    let v01 = hash_lattice_point(x0m, y1m, seed);
    let v11 = hash_lattice_point(x1m, y1m, seed);
    let sx = smoothstep(fx);
    let sy = smoothstep(fy);
    let top = v00 + (v10 - v00) * sx;
    let bottom = v01 + (v11 - v01) * sx;
    top + (bottom - top) * sy
}

/// (cells_x, cells_y, amplitude) per octave.
const RIDGE_OCTAVES: [(f64, f64, f64); 5] = [
    (32.0, 16.0, 0.15),
    (64.0, 32.0, 0.2),
    (128.0, 64.0, 0.3),
    (256.0, 128.0, 0.7),
    (512.0, 256.0, 1.0),
];

/// The ridged field's mean, measured.
pub const RIDGE_MEAN: f64 = 0.47;
const GLOBE_RIDGE_MEAN: f64 = 0.4805;

/// The next octave's salt.
#[inline]
fn next_seed(seed: f64) -> f64 {
    to_uint32(seed * 1664525.0 + 1013904223.0) as f64
}

/// Ridged fBm in [0, 1) on the torus chart.
pub fn ridged_multifractal(x: f64, y: f64, width: f64, height: f64, seed: f64) -> f64 {
    let (mut sum, mut amplitude_sum, mut octave_seed) = (0.0, 0.0, seed);
    for (cx, cy, amp) in RIDGE_OCTAVES {
        let lx = (x / width) * cx;
        let ly = (y / height) * cy;
        let n = periodic_value_noise_2d(lx, ly, cx, cy, octave_seed);
        let ridge = 1.0 - (2.0 * n - 1.0).abs();
        sum += ridge * ridge * amp;
        amplitude_sum += amp;
        octave_seed = next_seed(octave_seed);
    }
    sum / amplitude_sum
}

/// The ridged fBm at a domain point, sampled where the domain says.
pub fn ridged_multifractal_on(domain: &Domain, x: f64, y: f64, seed: f64) -> f64 {
    if !domain.is_sphere() {
        return ridged_multifractal(x, y, domain.width, domain.height, seed);
    }
    let frame = domain.globe_frame(x, y);
    let (mut sum, mut amplitude_sum, mut octave_seed) = (0.0, 0.0, seed);
    for (cx, _, amp) in RIDGE_OCTAVES {
        let n = globe_octave_on(&frame, cx, domain, octave_seed);
        let ridge = 1.0 - (2.0 * n - 1.0).abs();
        sum += ridge * ridge * amp;
        amplitude_sum += amp;
        octave_seed = next_seed(octave_seed);
    }
    sum / amplitude_sum - (GLOBE_RIDGE_MEAN - RIDGE_MEAN)
}

const DETAIL_OCTAVES: [(f64, f64, f64); 2] = [(512.0, 256.0, 1.0), (1024.0, 512.0, 0.5)];

/// The seed salt every consumer of the fine detail noise as terrain shares.
pub const FINE_DETAIL_SEED_SALT: u32 = 0x11a7e5;

/// Plain value-noise fBm, roughly [−0.5, 0.5], zero mean.
pub fn fine_detail_noise(x: f64, y: f64, width: f64, height: f64, seed: f64) -> f64 {
    let (mut sum, mut amplitude_sum, mut octave_seed) = (0.0, 0.0, seed);
    for (cx, cy, amp) in DETAIL_OCTAVES {
        let n = periodic_value_noise_2d((x / width) * cx, (y / height) * cy, cx, cy, octave_seed);
        sum += (n - 0.5) * amp;
        amplitude_sum += amp;
        octave_seed = next_seed(octave_seed);
    }
    sum / amplitude_sum
}

/// `fine_detail_noise` on the globe with every octave's cells times
/// `scale`. Panics on the torus.
pub fn fine_detail_noise_scaled_on(domain: &Domain, x: f64, y: f64, scale: f64, seed: f64) -> f64 {
    assert!(
        domain.is_sphere(),
        "fineDetailNoiseScaledOn samples the globe"
    );
    let frame = domain.globe_frame(x, y);
    let (mut sum, mut amplitude_sum, mut octave_seed) = (0.0, 0.0, seed);
    for (cx, _, amp) in DETAIL_OCTAVES {
        sum += (globe_octave_on(&frame, cx * scale, domain, octave_seed) - 0.5) * amp;
        amplitude_sum += amp;
        octave_seed = next_seed(octave_seed);
    }
    sum / amplitude_sum
}

/// `fine_detail_noise` at a domain point, sampled where the domain says.
pub fn fine_detail_noise_on(domain: &Domain, x: f64, y: f64, seed: f64) -> f64 {
    if !domain.is_sphere() {
        return fine_detail_noise(x, y, domain.width, domain.height, seed);
    }
    let frame = domain.globe_frame(x, y);
    let (mut sum, mut amplitude_sum, mut octave_seed) = (0.0, 0.0, seed);
    for (cx, _, amp) in DETAIL_OCTAVES {
        sum += (globe_octave_on(&frame, cx, domain, octave_seed) - 0.5) * amp;
        amplitude_sum += amp;
        octave_seed = next_seed(octave_seed);
    }
    sum / amplitude_sum
}
