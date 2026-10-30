//! JavaScript's number operations where Rust's differ, so that a port of the
//! TypeScript engine gives its bits (docs/decisions/rust-engine.md, fork 5).
//!
//! - `x | 0` truncates and wraps; Rust's `as i32` saturates.
//! - `Math.round` rounds a half toward +∞ and keeps the sign of a zero;
//!   `f64::round` rounds a half away from zero.
//! - `Math.min` and `Math.max` return NaN when an argument is NaN and order
//!   −0 below +0; `f64::min` and `f64::max` ignore a NaN.
//! - `Math.fround` is `as f32`; written here so that a port names it.

/// JavaScript's ToInt32 (`x | 0`): truncate, then wrap modulo 2^32. NaN and
/// the infinities give 0.
#[inline]
pub fn to_int32(x: f64) -> i32 {
    if !x.is_finite() {
        return 0;
    }
    let t = x.trunc() % 4294967296.0;
    let t = if t < 0.0 { t + 4294967296.0 } else { t };
    t as u32 as i32
}

/// JavaScript's ToUint32 (`x >>> 0`): ToInt32's bits, unsigned.
#[inline]
pub fn to_uint32(x: f64) -> u32 {
    to_int32(x) as u32
}

/// `Math.imul`: the low 32 bits of the product of two ToInt32 values.
#[inline]
pub fn imul(a: f64, b: f64) -> i32 {
    (to_int32(a) as u32).wrapping_mul(to_int32(b) as u32) as i32
}

/// `Math.round`.
#[inline]
pub fn round(x: f64) -> f64 {
    if !x.is_finite() || x == 0.0 {
        return x;
    }
    let r = x.floor();
    let r = if x - r >= 0.5 { r + 1.0 } else { r };
    if r == 0.0 && x < 0.0 { -0.0 } else { r }
}

/// `Math.min(a, b)`.
#[inline]
pub fn min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a < b || (a == b && a.is_sign_negative()) {
        a
    } else {
        b
    }
}

/// `Math.max(a, b)`.
#[inline]
pub fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a > b || (a == b && a.is_sign_positive()) {
        a
    } else {
        b
    }
}

/// `Math.fround`.
#[inline]
pub fn fround(x: f64) -> f64 {
    x as f32 as f64
}
