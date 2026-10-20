//! `elevation/globeNoise.ts`: THE COORDINATE NOISE ON THE SPHERE, value
//! noise on a 3D lattice turned against the globe, sampled at a point's
//! place on it. Integer arithmetic as `Math.imul` does it.

use std::sync::OnceLock;

use crate::core::domain::{Domain, GlobeFrame, MAP_WIDTH, TORUS_METERS_PER_CELL};
use crate::core::interpolation::smoothstep;
use crate::core::js::{imul, to_int32};

/// The calibration's reference extent: the torus's east-west metres.
pub const CALIBRATION_METRES_AROUND: f64 = MAP_WIDTH * TORUS_METERS_PER_CELL;

fn hash_lattice_point3(ix: f64, iy: f64, iz: f64, seed: f64) -> f64 {
    let mut h = (imul(ix, 0x27d4eb2d as f64)
        ^ imul(iy, 0x165667b1 as f64)
        ^ imul(iz, 0x85ebca77u32 as f64)
        ^ to_int32(seed)) as u32;
    h = (h ^ (h >> 16)).wrapping_mul(0x85ebca6b);
    h = (h ^ (h >> 13)).wrapping_mul(0xc2b2ae35);
    h ^= h >> 16;
    h as f64 / 4294967296.0
}

fn spread_gain() -> f64 {
    static G: OnceLock<f64> = OnceLock::new();
    *G.get_or_init(|| 1.0 / (52.0f64 / 70.0).sqrt())
}

/// Value noise in [0, 1] at lattice coordinates (x, y, z).
pub fn value_noise_3d(x: f64, y: f64, z: f64, seed: f64) -> f64 {
    let x0 = x.floor();
    let y0 = y.floor();
    let z0 = z.floor();
    let sx = smoothstep(x - x0);
    let sy = smoothstep(y - y0);
    let sz = smoothstep(z - z0);
    let (x1, y1, z1) = (x0 + 1.0, y0 + 1.0, z0 + 1.0);
    let v000 = hash_lattice_point3(x0, y0, z0, seed);
    let v100 = hash_lattice_point3(x1, y0, z0, seed);
    let v010 = hash_lattice_point3(x0, y1, z0, seed);
    let v110 = hash_lattice_point3(x1, y1, z0, seed);
    let v001 = hash_lattice_point3(x0, y0, z1, seed);
    let v101 = hash_lattice_point3(x1, y0, z1, seed);
    let v011 = hash_lattice_point3(x0, y1, z1, seed);
    let v111 = hash_lattice_point3(x1, y1, z1, seed);
    let a0 = v000 + (v100 - v000) * sx;
    let b0 = v010 + (v110 - v010) * sx;
    let a1 = v001 + (v101 - v001) * sx;
    let b1 = v011 + (v111 - v011) * sx;
    let c0 = a0 + (b0 - a0) * sy;
    let c1 = a1 + (b1 - a1) * sy;
    let v = 0.5 + (c0 + (c1 - c0) * sz - 0.5) * spread_gain();
    // `v < 0 ? 0 : v > 1 ? 1 : v`: the same bits, a NaN passing through.
    v.clamp(0.0, 1.0)
}

/// The lattice's fixed rotation against the globe: the unit quaternion
/// (0.8, 0.3, 0.5, 0.2) normalised.
fn rotation() -> &'static [f64; 9] {
    static R: OnceLock<[f64; 9]> = OnceLock::new();
    R.get_or_init(|| {
        let n = (0.8f64 * 0.8 + 0.3 * 0.3 + 0.5 * 0.5 + 0.2 * 0.2).sqrt();
        let (a, b, c, d) = (0.8 / n, 0.3 / n, 0.5 / n, 0.2 / n);
        [
            a * a + b * b - c * c - d * d,
            2.0 * (b * c - a * d),
            2.0 * (b * d + a * c),
            2.0 * (b * c + a * d),
            a * a - b * b + c * c - d * d,
            2.0 * (c * d - a * b),
            2.0 * (b * d - a * c),
            2.0 * (c * d + a * b),
            a * a - b * b - c * c + d * d,
        ]
    })
}

/// One octave of `cells_x` cells across the chart at a globe point, read
/// at the torus's length in metres.
pub fn globe_octave_on(frame: &GlobeFrame, cells_x: f64, domain: &Domain, seed: f64) -> f64 {
    globe_octave(
        frame,
        cells_x,
        (domain.width * CALIBRATION_METRES_AROUND) / domain.metres_around,
        seed,
    )
}

pub fn globe_octave(frame: &GlobeFrame, cells_x: f64, width: f64, seed: f64) -> f64 {
    let scale = cells_x / width;
    let x = frame.px * scale;
    let y = frame.py * scale;
    let z = frame.pz * scale;
    let r = rotation();
    value_noise_3d(
        r[0] * x + r[1] * y + r[2] * z,
        r[3] * x + r[4] * y + r[5] * z,
        r[6] * x + r[7] * y + r[8] * z,
        seed,
    )
}
