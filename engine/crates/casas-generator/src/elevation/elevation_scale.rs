//! What a height means. Elevation is signed with 0 at sea level and 1.0 =
//! ELEVATION_METERS; the reference heights, the continental margin's
//! profile and the shoreline's raft field. The reasoning and the
//! measurements are in `client/src/generator/elevation/elevationScale.ts`.

use std::sync::OnceLock;

use crate::core::interpolation::smoothstep;
use crate::core::js;

/// Metres per elevation unit: 1.0 is 9000 m.
pub const ELEVATION_METERS: f64 = 9000.0;

pub fn meters_to_elevation(m: f64) -> f64 {
    m / ELEVATION_METERS
}

pub fn elevation_to_meters(e: f64) -> f64 {
    e * ELEVATION_METERS
}

pub const SEA_LEVEL: f64 = 0.0;

/// Is this cell land: above the sea, or a dry basin below it.
pub fn is_land_at(elevation: f64, dry_land: bool) -> bool {
    elevation > SEA_LEVEL || dry_land
}

pub const LAND_BASE: f64 = 360.0 / ELEVATION_METERS;
pub const COASTAL_PLAIN: f64 = 60.0 / ELEVATION_METERS;
pub const SHELF_BREAK: f64 = -140.0 / ELEVATION_METERS;
pub const INNER_SHELF: f64 = -60.0 / ELEVATION_METERS;
pub const SLOPE_FOOT: f64 = -3000.0 / ELEVATION_METERS;
pub const RIDGE_CREST: f64 = -2600.0 / ELEVATION_METERS;
pub const ABYSSAL_FLOOR: f64 = -5700.0 / ELEVATION_METERS;

/// The margin parameter at the foot of the continental slope. The stops
/// moved seaward on 2026-10-27 with a stop on the inner shelf, the
/// shoreline's t (0.6729) kept: the shelf twice as wide in t, the slope
/// steeper (docs/decisions/shelf-and-sea.md).
pub const SLOPE_FOOT_T: f64 = 0.10;
const MARGIN_STOPS: [(f64, f64); 5] = [
    (SLOPE_FOOT_T, SLOPE_FOOT),
    (0.25, SHELF_BREAK),
    (0.55, INNER_SHELF),
    (0.795_719_756_236_602_6, COASTAL_PLAIN),
    (1.0, LAND_BASE),
];

/// Elevation at margin parameter t (0 open ocean, 1 continental interior)
/// over an ocean floor of `abyssal_floor`.
pub fn margin_profile(t: f64, abyssal_floor: f64) -> f64 {
    if t <= 0.0 {
        return abyssal_floor;
    }
    if t >= 1.0 {
        return LAND_BASE;
    }
    let mut from_t = 0.0;
    let mut from_e = abyssal_floor;
    for (stop_t, stop_e) in MARGIN_STOPS {
        if t <= stop_t {
            return from_e + (stop_e - from_e) * smoothstep((t - from_t) / (stop_t - from_t));
        }
        from_t = stop_t;
        from_e = stop_e;
    }
    LAND_BASE
}

pub const MARGIN_FIELD_LO: f64 = 0.08;
pub const MARGIN_FIELD_HI: f64 = 1.0;
pub const SLOPE_RECALIBRATION: f64 = 2.0;

pub fn margin_parameter(field: f64) -> f64 {
    let t = js::max(
        0.0,
        js::min(
            1.0,
            (field - MARGIN_FIELD_LO) / (MARGIN_FIELD_HI - MARGIN_FIELD_LO),
        ),
    );
    smoothstep(t)
}

/// The raft-field value at which land begins, solved by bisection.
pub fn shoreline_field() -> f64 {
    static FIELD: OnceLock<f64> = OnceLock::new();
    *FIELD.get_or_init(|| {
        let mut lo = MARGIN_FIELD_LO;
        let mut hi = MARGIN_FIELD_HI;
        for _ in 0..40 {
            let mid = (lo + hi) / 2.0;
            if margin_profile(margin_parameter(mid), ABYSSAL_FLOOR) > 0.0 {
                hi = mid;
            } else {
                lo = mid;
            }
        }
        (lo + hi) / 2.0
    })
}
