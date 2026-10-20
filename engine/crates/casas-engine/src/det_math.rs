//! DETERMINISTIC MATH: the transcendental functions of the engine, made only
//! of the operations IEEE 754 defines exactly (+ − × ÷, sqrt, and bit
//! access), so the native build and the WASM build compute the same bits.
//!
//! A port of the TypeScript engine's `client/src/generator/core/detMath.ts`,
//! line for line: the same fdlibm 5.3 code (Sun Microsystems, 1993:
//! "Permission to use, copy, modify, and distribute this software is freely
//! granted, provided that this notice is preserved."), the same derived
//! functions, the same bits. `tests/det_math.rs` holds it against the
//! TypeScript values (docs/decisions/rust-engine.md, fork 5).
//!
//! RULE: the engine calls these, never `f64::exp`, `sin`, `powf` … or a
//! `libm` crate; their last bit differs between platforms. `sqrt`, `abs`,
//! `floor`, `round`, `min`, `max` and the casts are exact and stay.
//!
//! Where the TypeScript code writes `x | 0`, the port calls [`to_int32`],
//! which wraps as JavaScript does; a Rust `as i32` saturates instead.

// The constants are fdlibm's, written as fdlibm writes them, with more
// digits than a double holds and with names of their own where a std
// constant has the same value: the port reads like its source.
#![allow(clippy::excessive_precision, clippy::approx_constant)]

/// JavaScript's ToInt32: truncate, then wrap modulo 2^32. NaN and the
/// infinities give 0.
#[inline]
pub fn to_int32(x: f64) -> i32 {
    if !x.is_finite() {
        return 0;
    }
    let t = x.trunc() % 4294967296.0;
    let t = if t < 0.0 { t + 4294967296.0 } else { t };
    t as u32 as i32
}

#[inline]
fn high(x: f64) -> i32 {
    (x.to_bits() >> 32) as u32 as i32
}

#[inline]
fn low(x: f64) -> i32 {
    x.to_bits() as u32 as i32
}

/// `x` with its high word replaced. `hi` is taken modulo 2^32, as
/// JavaScript's `>>> 0` takes it.
#[inline]
fn with_high(x: f64, hi: i64) -> f64 {
    f64::from_bits(((hi as u32 as u64) << 32) | (x.to_bits() & 0xffff_ffff))
}

#[inline]
fn from_words(hi: i64, lo: i64) -> f64 {
    f64::from_bits(((hi as u32 as u64) << 32) | lo as u32 as u64)
}

// --- exp (e_exp.c) ----------------------------------------------------------

const O_THRESHOLD: f64 = 7.09782712893383973096e+02;
const U_THRESHOLD: f64 = -7.45133219101941108420e+02;
const LN2_HI: f64 = 6.93147180369123816490e-01;
const LN2_LO: f64 = 1.90821492927058770002e-10;
const INV_LN2: f64 = 1.44269504088896338700e+00;
const P1: f64 = 1.66666666666666019037e-01;
const P2: f64 = -2.77777777770155933842e-03;
const P3: f64 = 6.61375632143793436117e-05;
const P4: f64 = -1.65339022054652515390e-06;
const P5: f64 = 4.13813679705723846039e-08;
const TWO_M1000: f64 = 9.33263618503218878990e-302;

pub fn det_exp(mut x: f64) -> f64 {
    let mut hx = high(x);
    let xsb = ((hx as u32) >> 31) & 1;
    hx &= 0x7fffffff;
    let mut hi = 0.0;
    let mut lo = 0.0;
    let mut k: i32 = 0;
    if hx >= 0x40862e42 {
        if hx >= 0x7ff00000 {
            if ((hx & 0xfffff) | low(x)) != 0 {
                return x + x;
            }
            return if xsb == 0 { x } else { 0.0 };
        }
        if x > O_THRESHOLD {
            return f64::INFINITY;
        }
        if x < U_THRESHOLD {
            return 0.0;
        }
    }
    if hx > 0x3fd62e42 {
        if hx < 0x3ff0a2b2 {
            hi = if xsb == 0 { x - LN2_HI } else { x + LN2_HI };
            lo = if xsb == 0 { LN2_LO } else { -LN2_LO };
            k = 1 - xsb as i32 - xsb as i32;
        } else {
            k = to_int32(INV_LN2 * x + if xsb == 0 { 0.5 } else { -0.5 });
            hi = x - k as f64 * LN2_HI;
            lo = k as f64 * LN2_LO;
        }
        x = hi - lo;
    } else if hx < 0x3e300000 {
        return 1.0 + x;
    }
    let t = x * x;
    let c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
    if k == 0 {
        return 1.0 - ((x * c) / (c - 2.0) - x);
    }
    let y = 1.0 - ((lo - (x * c) / (2.0 - c)) - hi);
    if k >= -1021 {
        return with_high(y, high(y) as i64 + (k.wrapping_shl(20)) as i64);
    }
    with_high(y, high(y) as i64 + ((k + 1000).wrapping_shl(20)) as i64) * TWO_M1000
}

// --- log (e_log.c) ----------------------------------------------------------

const TWO54: f64 = 1.80143985094819840000e+16;
const LG1: f64 = 6.666666666666735130e-01;
const LG2: f64 = 3.999999999940941908e-01;
const LG3: f64 = 2.857142874366239149e-01;
const LG4: f64 = 2.222219843214978396e-01;
const LG5: f64 = 1.818357216161805012e-01;
const LG6: f64 = 1.531383769920937332e-01;
const LG7: f64 = 1.479819860511658591e-01;

pub fn det_log(mut x: f64) -> f64 {
    let mut hx = high(x);
    let lx = low(x);
    let mut k: i32 = 0;
    if hx < 0x00100000 {
        if ((hx & 0x7fffffff) | lx) == 0 {
            return f64::NEG_INFINITY;
        }
        if hx < 0 {
            return f64::NAN;
        }
        k -= 54;
        x *= TWO54;
        hx = high(x);
    }
    if hx >= 0x7ff00000 {
        return x + x;
    }
    k += (hx >> 20) - 1023;
    hx &= 0x000fffff;
    let mut i = (hx + 0x95f64) & 0x100000;
    x = with_high(x, (hx | (i ^ 0x3ff00000)) as i64);
    k += i >> 20;
    let f = x - 1.0;
    if (0x000fffff & (2 + hx)) < 3 {
        if f == 0.0 {
            if k == 0 {
                return 0.0;
            }
            return k as f64 * LN2_HI + k as f64 * LN2_LO;
        }
        let r = f * f * (0.5 - 0.33333333333333333 * f);
        if k == 0 {
            return f - r;
        }
        return k as f64 * LN2_HI - ((r - k as f64 * LN2_LO) - f);
    }
    let s = f / (2.0 + f);
    let dk = k as f64;
    let z = s * s;
    i = hx - 0x6147a;
    let w = z * z;
    let j = 0x6b851 - hx;
    let t1 = w * (LG2 + w * (LG4 + w * LG6));
    let t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
    i |= j;
    let r = t2 + t1;
    if i > 0 {
        let hfsq = 0.5 * f * f;
        if k == 0 {
            return f - (hfsq - s * (hfsq + r));
        }
        return dk * LN2_HI - ((hfsq - (s * (hfsq + r) + dk * LN2_LO)) - f);
    }
    if k == 0 {
        return f - s * (f - r);
    }
    dk * LN2_HI - ((s * (f - r) - dk * LN2_LO) - f)
}

// --- sin, cos (k_sin.c, k_cos.c, e_rem_pio2.c, s_sin.c, s_cos.c) ------------

const S1: f64 = -1.66666666666666324348e-01;
const S2: f64 = 8.33333333332248946124e-03;
const S3: f64 = -1.98412698298579493134e-04;
const S4: f64 = 2.75573137070700676789e-06;
const S5: f64 = -2.50507602534068634195e-08;
const S6: f64 = 1.58969099521155010221e-10;

fn kernel_sin(x: f64, y: f64, iy: i32) -> f64 {
    let ix = high(x) & 0x7fffffff;
    if ix < 0x3e400000 && to_int32(x) == 0 {
        return x;
    }
    let z = x * x;
    let v = z * x;
    let r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
    if iy == 0 {
        return x + v * (S1 + z * r);
    }
    x - ((z * (0.5 * y - v * r) - y) - v * S1)
}

const C1: f64 = 4.16666666666666019037e-02;
const C2: f64 = -1.38888888888741095749e-03;
const C3: f64 = 2.48015872894767294178e-05;
const C4: f64 = -2.75573143513906633035e-07;
const C5: f64 = 2.08757232129817482790e-09;
const C6: f64 = -1.13596475577881948265e-11;

fn kernel_cos(x: f64, y: f64) -> f64 {
    let ix = high(x) & 0x7fffffff;
    if ix < 0x3e400000 && to_int32(x) == 0 {
        return 1.0;
    }
    let z = x * x;
    let r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
    if ix < 0x3fd33333 {
        return 1.0 - (0.5 * z - (z * r - x * y));
    }
    let qx = if ix > 0x3fe90000 {
        0.28125
    } else {
        from_words((ix - 0x00200000) as i64, 0)
    };
    let hz = 0.5 * z - qx;
    let a = 1.0 - qx;
    a - (hz - (z * r - x * y))
}

const INV_PIO2: f64 = 6.36619772367581382433e-01;
const PIO2_1: f64 = 1.57079632673412561417e+00;
const PIO2_1T: f64 = 6.07710050650619224932e-11;
const PIO2_2: f64 = 6.07710050630396597660e-11;
const PIO2_2T: f64 = 2.02226624879595063154e-21;
const PIO2_3: f64 = 2.02226624871116645580e-21;
const PIO2_3T: f64 = 8.47842766036889956997e-32;

/// x reduced by n·π/2 into y0 + y1, |y0 + y1| ≤ π/4; returns (n, y0, y1).
/// fdlibm's medium-argument path, used for every |x| > 3π/4: past 2^19·π/2
/// it loses accuracy (fdlibm switches to a 1584-bit π there), but gives the
/// TypeScript engine's bits all the same.
fn rem_pio2(x: f64) -> (i32, f64, f64) {
    let hx = high(x);
    let ix = hx & 0x7fffffff;
    if ix <= 0x3fe921fb {
        return (0, x, 0.0);
    }
    if ix < 0x4002d97c {
        if hx > 0 {
            let mut z = x - PIO2_1;
            if ix != 0x3ff921fb {
                let y0 = z - PIO2_1T;
                return (1, y0, (z - y0) - PIO2_1T);
            }
            z -= PIO2_2;
            let y0 = z - PIO2_2T;
            return (1, y0, (z - y0) - PIO2_2T);
        }
        let mut z = x + PIO2_1;
        if ix != 0x3ff921fb {
            let y0 = z + PIO2_1T;
            return (-1, y0, (z - y0) + PIO2_1T);
        }
        z += PIO2_2;
        let y0 = z + PIO2_2T;
        return (-1, y0, (z - y0) + PIO2_2T);
    }
    let t0 = x.abs();
    let n = to_int32(t0 * INV_PIO2 + 0.5);
    let fn_ = n as f64;
    let mut r = t0 - fn_ * PIO2_1;
    let mut w = fn_ * PIO2_1T;
    let j = ix >> 20;
    let mut y0 = r - w;
    let mut i = j - ((high(y0) >> 20) & 0x7ff);
    if i > 16 {
        let mut t = r;
        w = fn_ * PIO2_2;
        r = t - w;
        w = fn_ * PIO2_2T - ((t - r) - w);
        y0 = r - w;
        i = j - ((high(y0) >> 20) & 0x7ff);
        if i > 49 {
            t = r;
            w = fn_ * PIO2_3;
            r = t - w;
            w = fn_ * PIO2_3T - ((t - r) - w);
            y0 = r - w;
        }
    }
    let y1 = (r - y0) - w;
    if hx < 0 {
        return (n.wrapping_neg(), -y0, -y1);
    }
    (n, y0, y1)
}

pub fn det_sin(x: f64) -> f64 {
    let ix = high(x) & 0x7fffffff;
    if ix <= 0x3fe921fb {
        return kernel_sin(x, 0.0, 0);
    }
    if ix >= 0x7ff00000 {
        return f64::NAN;
    }
    let (n, y0, y1) = rem_pio2(x);
    match n & 3 {
        0 => kernel_sin(y0, y1, 1),
        1 => kernel_cos(y0, y1),
        2 => -kernel_sin(y0, y1, 1),
        _ => -kernel_cos(y0, y1),
    }
}

pub fn det_cos(x: f64) -> f64 {
    let ix = high(x) & 0x7fffffff;
    if ix <= 0x3fe921fb {
        return kernel_cos(x, 0.0);
    }
    if ix >= 0x7ff00000 {
        return f64::NAN;
    }
    let (n, y0, y1) = rem_pio2(x);
    match n & 3 {
        0 => kernel_cos(y0, y1),
        1 => -kernel_sin(y0, y1, 1),
        2 => -kernel_cos(y0, y1),
        _ => kernel_sin(y0, y1, 1),
    }
}

pub fn det_tan(x: f64) -> f64 {
    det_sin(x) / det_cos(x)
}

// --- atan, atan2 (s_atan.c, e_atan2.c) --------------------------------------

const ATAN_HI: [f64; 4] = [
    4.63647609000806093515e-01,
    7.85398163397448278999e-01,
    9.82793723247329054082e-01,
    1.57079632679489655800e+00,
];
const ATAN_LO: [f64; 4] = [
    2.26987774529616870924e-17,
    3.06161699786838301793e-17,
    1.39033110312309984516e-17,
    6.12323399573676603587e-17,
];
const AT0: f64 = 3.33333333333329318027e-01;
const AT1: f64 = -1.99999999998764832476e-01;
const AT2: f64 = 1.42857142725034663711e-01;
const AT3: f64 = -1.11111104054623557880e-01;
const AT4: f64 = 9.09088713343650656196e-02;
const AT5: f64 = -7.69187620504482999495e-02;
const AT6: f64 = 6.66107313738753120669e-02;
const AT7: f64 = -5.83357013379057348645e-02;
const AT8: f64 = 4.97687799461593236017e-02;
const AT9: f64 = -3.65315727442169155270e-02;
const AT10: f64 = 1.62858201153657823623e-02;

pub fn det_atan(mut x: f64) -> f64 {
    let hx = high(x);
    let ix = hx & 0x7fffffff;
    let id: i32;
    if ix >= 0x44100000 {
        if ix > 0x7ff00000 || (ix == 0x7ff00000 && low(x) != 0) {
            return x + x;
        }
        return if hx > 0 {
            ATAN_HI[3] + ATAN_LO[3]
        } else {
            -ATAN_HI[3] - ATAN_LO[3]
        };
    }
    if ix < 0x3fdc0000 {
        if ix < 0x3e200000 {
            return x;
        }
        id = -1;
    } else {
        x = x.abs();
        if ix < 0x3ff30000 {
            if ix < 0x3fe60000 {
                id = 0;
                x = (2.0 * x - 1.0) / (2.0 + x);
            } else {
                id = 1;
                x = (x - 1.0) / (x + 1.0);
            }
        } else if ix < 0x40038000 {
            id = 2;
            x = (x - 1.5) / (1.0 + 1.5 * x);
        } else {
            id = 3;
            x = -1.0 / x;
        }
    }
    let z = x * x;
    let w = z * z;
    let s1 = z * (AT0 + w * (AT2 + w * (AT4 + w * (AT6 + w * (AT8 + w * AT10)))));
    let s2 = w * (AT1 + w * (AT3 + w * (AT5 + w * (AT7 + w * AT9))));
    if id < 0 {
        return x - x * (s1 + s2);
    }
    let id = id as usize;
    let r = ATAN_HI[id] - ((x * (s1 + s2) - ATAN_LO[id]) - x);
    if hx < 0 { -r } else { r }
}

const TINY: f64 = 1.0e-300;
const PI_O_4: f64 = 7.8539816339744827900e-01;
const PI_O_2: f64 = 1.5707963267948965580e+00;
const PI: f64 = 3.1415926535897931160e+00;
const PI_LO: f64 = 1.2246467991473531772e-16;

pub fn det_atan2(y: f64, x: f64) -> f64 {
    let hx = high(x);
    let ix = hx & 0x7fffffff;
    let lx = low(x);
    let hy = high(y);
    let iy = hy & 0x7fffffff;
    let ly = low(y);
    if x.is_nan() || y.is_nan() {
        return x + y;
    }
    if (hx.wrapping_sub(0x3ff00000) | lx) == 0 {
        return det_atan(y);
    }
    let m = (((hy as u32) >> 31) & 1) | (((hx as u32) >> 30) & 2);
    if (iy | ly) == 0 {
        if m <= 1 {
            return y;
        }
        return if m == 2 { PI + TINY } else { -PI - TINY };
    }
    if (ix | lx) == 0 {
        return if hy < 0 {
            -PI_O_2 - TINY
        } else {
            PI_O_2 + TINY
        };
    }
    if ix == 0x7ff00000 {
        if iy == 0x7ff00000 {
            return match m {
                0 => PI_O_4 + TINY,
                1 => -PI_O_4 - TINY,
                2 => 3.0 * PI_O_4 + TINY,
                _ => -3.0 * PI_O_4 - TINY,
            };
        }
        return match m {
            0 => 0.0,
            1 => -0.0,
            2 => PI + TINY,
            _ => -PI - TINY,
        };
    }
    if iy == 0x7ff00000 {
        return if hy < 0 {
            -PI_O_2 - TINY
        } else {
            PI_O_2 + TINY
        };
    }
    let k = (iy - ix) >> 20;
    let z = if k > 60 {
        PI_O_2 + 0.5 * PI_LO
    } else if hx < 0 && k < -60 {
        0.0
    } else {
        det_atan((y / x).abs())
    };
    match m {
        0 => z,
        1 => -z,
        2 => PI - (z - PI_LO),
        _ => (z - PI_LO) - PI,
    }
}

pub fn det_asin(x: f64) -> f64 {
    if x > 1.0 || x < -1.0 {
        return f64::NAN;
    }
    det_atan2(x, ((1.0 - x) * (1.0 + x)).sqrt())
}

pub fn det_acos(x: f64) -> f64 {
    if x > 1.0 || x < -1.0 {
        return f64::NAN;
    }
    det_atan2(((1.0 - x) * (1.0 + x)).sqrt(), x)
}

// --- derived ------------------------------------------------------------------

/// x^y. Integer exponents by repeated squaring (exact for 0, ±1 and 2, the
/// common ones), 0.5 as sqrt, any other as exp(y · log x).
pub fn det_pow(x: f64, y: f64) -> f64 {
    if y == 0.0 {
        return 1.0;
    }
    if y == 0.5 && x >= 0.0 {
        return x.sqrt();
    }
    if y.is_finite() && y.trunc() == y && y.abs() <= 1024.0 {
        let mut n = y.abs();
        let mut base = x;
        let mut r = 1.0;
        while n > 0.0 {
            if (n as i64) & 1 == 1 {
                r *= base;
            }
            n = (n / 2.0).floor();
            if n > 0.0 {
                base *= base;
            }
        }
        return if y < 0.0 { 1.0 / r } else { r };
    }
    if x.is_nan() || y.is_nan() {
        return f64::NAN;
    }
    if x == 0.0 {
        return if y > 0.0 { 0.0 } else { f64::INFINITY };
    }
    if x < 0.0 {
        return f64::NAN;
    }
    if x == f64::INFINITY {
        return if y > 0.0 { f64::INFINITY } else { 0.0 };
    }
    det_exp(y * det_log(x))
}

pub fn det_log2(x: f64) -> f64 {
    det_log(x) * std::f64::consts::LOG2_E
}

/// The length of (x, y): `det_hypot3(x, y, 0)`, as the TypeScript engine's
/// `detHypot(x, y)` computes it.
pub fn det_hypot(x: f64, y: f64) -> f64 {
    det_hypot3(x, y, 0.0)
}

pub fn det_hypot3(x: f64, y: f64, z: f64) -> f64 {
    (x * x + y * y + z * z).sqrt()
}

pub fn sq(x: f64) -> f64 {
    x * x
}
