// DETERMINISTIC MATH: the transcendental functions the generator uses, made
// only of the operations IEEE 754 defines exactly (+ − × ÷, sqrt, and bit
// access), so every JavaScript engine computes the same bits.
//
// WHY. ECMAScript leaves Math.exp, log, sin, cos, tan, atan2, pow, hypot …
// "implementation-approximated". V8 (Chrome, Node) and JavaScriptCore
// (Safari) differ in the last bit for some per cent of the arguments
// (measured 2026-10-02: exp 9.5 %, hypot 43 %, cos 2.7 %, log 2.6 %). The
// float32 storage hides most of it, but not all: a world made in Safari and
// made again by the server's Node worker were the same up to epoch 93 of
// 151 and then went apart (Calvessor, the level-1 job's check). A save is
// the authority only if every engine makes the same world from it.
//
// HOW. A port of fdlibm 5.3 (Sun Microsystems, 1993: "Permission to use,
// copy, modify, and distribute this software is freely granted, provided
// that this notice is preserved."): e_exp, e_log, k_sin, k_cos,
// e_rem_pio2 (without the large-argument kernel), s_atan, e_atan2. Each is
// within 1 ulp of the true value; not always correctly rounded, so the
// values differ from an engine's Math in some last bits — on purpose: the
// same everywhere is the property, not equal to Math.
//
// The rest from those: tan = sin / cos, asin and acos by atan2, pow by
// squaring for integer exponents and by exp(y · log x) otherwise, hypot by
// sqrt. Less accurate than the C library's own, deterministic all the same.
//
// RULE: in generator/ (render/ excepted — pictures, not the world), the
// Math functions above are not called and `**` is not written; `make lint`
// checks it. Math.sqrt, abs, floor, round, min, max, fround and sign are
// exact and stay.

const f64 = new Float64Array(1)
const u32 = new Uint32Array(f64.buffer)
// Little-endian: the high word (sign, exponent, top of the mantissa) is the
// second. Every platform this runs on is; a big-endian one would get wrong
// numbers silently, so it is refused.
if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) throw new Error('detMath: big-endian platforms are not supported')

function high(x: number): number {
  f64[0] = x
  return u32[1] | 0
}
function low(x: number): number {
  f64[0] = x
  return u32[0] | 0
}
function withHigh(x: number, hi: number): number {
  f64[0] = x
  u32[1] = hi >>> 0
  return f64[0]
}
function fromWords(hi: number, lo: number): number {
  u32[1] = hi >>> 0
  u32[0] = lo >>> 0
  return f64[0]
}

// --- exp (e_exp.c) ----------------------------------------------------------

const O_THRESHOLD = 7.09782712893383973096e+02
const U_THRESHOLD = -7.45133219101941108420e+02
const LN2_HI = 6.93147180369123816490e-01
const LN2_LO = 1.90821492927058770002e-10
const INV_LN2 = 1.44269504088896338700e+00
const P1 = 1.66666666666666019037e-01
const P2 = -2.77777777770155933842e-03
const P3 = 6.61375632143793436117e-05
const P4 = -1.65339022054652515390e-06
const P5 = 4.13813679705723846039e-08
const TWO_M1000 = 9.33263618503218878990e-302

export function detExp(x: number): number {
  let hx = high(x)
  const xsb = (hx >>> 31) & 1
  hx &= 0x7fffffff
  let hi = 0
  let lo = 0
  let k = 0
  if (hx >= 0x40862e42) {
    if (hx >= 0x7ff00000) {
      if (((hx & 0xfffff) | low(x)) !== 0) return x + x
      return xsb === 0 ? x : 0
    }
    if (x > O_THRESHOLD) return Infinity
    if (x < U_THRESHOLD) return 0
  }
  if (hx > 0x3fd62e42) {
    if (hx < 0x3ff0a2b2) {
      hi = xsb === 0 ? x - LN2_HI : x + LN2_HI
      lo = xsb === 0 ? LN2_LO : -LN2_LO
      k = 1 - xsb - xsb
    } else {
      k = (INV_LN2 * x + (xsb === 0 ? 0.5 : -0.5)) | 0
      hi = x - k * LN2_HI
      lo = k * LN2_LO
    }
    x = hi - lo
  } else if (hx < 0x3e300000) {
    return 1 + x
  }
  const t = x * x
  const c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))))
  if (k === 0) return 1 - ((x * c) / (c - 2) - x)
  const y = 1 - ((lo - (x * c) / (2 - c)) - hi)
  if (k >= -1021) return withHigh(y, high(y) + (k << 20))
  return withHigh(y, high(y) + ((k + 1000) << 20)) * TWO_M1000
}

// --- log (e_log.c) ----------------------------------------------------------

const TWO54 = 1.80143985094819840000e+16
const LG1 = 6.666666666666735130e-01
const LG2 = 3.999999999940941908e-01
const LG3 = 2.857142874366239149e-01
const LG4 = 2.222219843214978396e-01
const LG5 = 1.818357216161805012e-01
const LG6 = 1.531383769920937332e-01
const LG7 = 1.479819860511658591e-01

export function detLog(x: number): number {
  let hx = high(x)
  const lx = low(x)
  let k = 0
  if (hx < 0x00100000) {
    if (((hx & 0x7fffffff) | lx) === 0) return -Infinity
    if (hx < 0) return NaN
    k -= 54
    x *= TWO54
    hx = high(x)
  }
  if (hx >= 0x7ff00000) return x + x
  k += (hx >> 20) - 1023
  hx &= 0x000fffff
  let i = (hx + 0x95f64) & 0x100000
  x = withHigh(x, hx | (i ^ 0x3ff00000))
  k += i >> 20
  const f = x - 1
  if ((0x000fffff & (2 + hx)) < 3) {
    if (f === 0) {
      if (k === 0) return 0
      return k * LN2_HI + k * LN2_LO
    }
    const r = f * f * (0.5 - 0.33333333333333333 * f)
    if (k === 0) return f - r
    return k * LN2_HI - ((r - k * LN2_LO) - f)
  }
  const s = f / (2 + f)
  const dk = k
  const z = s * s
  i = hx - 0x6147a
  const w = z * z
  const j = 0x6b851 - hx
  const t1 = w * (LG2 + w * (LG4 + w * LG6))
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)))
  i |= j
  const r = t2 + t1
  if (i > 0) {
    const hfsq = 0.5 * f * f
    if (k === 0) return f - (hfsq - s * (hfsq + r))
    return dk * LN2_HI - ((hfsq - (s * (hfsq + r) + dk * LN2_LO)) - f)
  }
  if (k === 0) return f - s * (f - r)
  return dk * LN2_HI - ((s * (f - r) - dk * LN2_LO) - f)
}

// --- sin, cos (k_sin.c, k_cos.c, e_rem_pio2.c, s_sin.c, s_cos.c) ------------

const S1 = -1.66666666666666324348e-01
const S2 = 8.33333333332248946124e-03
const S3 = -1.98412698298579493134e-04
const S4 = 2.75573137070700676789e-06
const S5 = -2.50507602534068634195e-08
const S6 = 1.58969099521155010221e-10

function kernelSin(x: number, y: number, iy: number): number {
  const ix = high(x) & 0x7fffffff
  if (ix < 0x3e400000 && (x | 0) === 0) return x
  const z = x * x
  const v = z * x
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)))
  if (iy === 0) return x + v * (S1 + z * r)
  return x - ((z * (0.5 * y - v * r) - y) - v * S1)
}

const C1 = 4.16666666666666019037e-02
const C2 = -1.38888888888741095749e-03
const C3 = 2.48015872894767294178e-05
const C4 = -2.75573143513906633035e-07
const C5 = 2.08757232129817482790e-09
const C6 = -1.13596475577881948265e-11

function kernelCos(x: number, y: number): number {
  const ix = high(x) & 0x7fffffff
  if (ix < 0x3e400000 && (x | 0) === 0) return 1
  const z = x * x
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))))
  if (ix < 0x3fd33333) return 1 - (0.5 * z - (z * r - x * y))
  const qx = ix > 0x3fe90000 ? 0.28125 : fromWords(ix - 0x00200000, 0)
  const hz = 0.5 * z - qx
  const a = 1 - qx
  return a - (hz - (z * r - x * y))
}

const INV_PIO2 = 6.36619772367581382433e-01
const PIO2_1 = 1.57079632673412561417e+00
const PIO2_1T = 6.07710050650619224932e-11
const PIO2_2 = 6.07710050630396597660e-11
const PIO2_2T = 2.02226624879595063154e-21
const PIO2_3 = 2.02226624871116645580e-21
const PIO2_3T = 8.47842766036889956997e-32

// x reduced by n·π/2 into y0 + y1, |y0 + y1| ≤ π/4; returns n. fdlibm's
// medium-argument path, used for every |x| > 3π/4: past 2^19·π/2 it loses
// accuracy (fdlibm switches to a 1584-bit π there), but stays the same on
// every engine — and no angle in the generator comes near.
let y0 = 0
let y1 = 0
function remPio2(x: number): number {
  const hx = high(x)
  const ix = hx & 0x7fffffff
  if (ix <= 0x3fe921fb) {
    y0 = x
    y1 = 0
    return 0
  }
  if (ix < 0x4002d97c) {
    if (hx > 0) {
      let z = x - PIO2_1
      if (ix !== 0x3ff921fb) {
        y0 = z - PIO2_1T
        y1 = (z - y0) - PIO2_1T
      } else {
        z -= PIO2_2
        y0 = z - PIO2_2T
        y1 = (z - y0) - PIO2_2T
      }
      return 1
    }
    let z = x + PIO2_1
    if (ix !== 0x3ff921fb) {
      y0 = z + PIO2_1T
      y1 = (z - y0) + PIO2_1T
    } else {
      z += PIO2_2
      y0 = z + PIO2_2T
      y1 = (z - y0) + PIO2_2T
    }
    return -1
  }
  const t0 = Math.abs(x)
  const n = (t0 * INV_PIO2 + 0.5) | 0
  const fn = n
  let r = t0 - fn * PIO2_1
  let w = fn * PIO2_1T
  const j = ix >> 20
  y0 = r - w
  let i = j - ((high(y0) >> 20) & 0x7ff)
  if (i > 16) {
    let t = r
    w = fn * PIO2_2
    r = t - w
    w = fn * PIO2_2T - ((t - r) - w)
    y0 = r - w
    i = j - ((high(y0) >> 20) & 0x7ff)
    if (i > 49) {
      t = r
      w = fn * PIO2_3
      r = t - w
      w = fn * PIO2_3T - ((t - r) - w)
      y0 = r - w
    }
  }
  y1 = (r - y0) - w
  if (hx < 0) {
    y0 = -y0
    y1 = -y1
    return -n
  }
  return n
}

export function detSin(x: number): number {
  const ix = high(x) & 0x7fffffff
  if (ix <= 0x3fe921fb) return kernelSin(x, 0, 0)
  if (ix >= 0x7ff00000) return NaN
  switch (remPio2(x) & 3) {
    case 0: return kernelSin(y0, y1, 1)
    case 1: return kernelCos(y0, y1)
    case 2: return -kernelSin(y0, y1, 1)
    default: return -kernelCos(y0, y1)
  }
}

export function detCos(x: number): number {
  const ix = high(x) & 0x7fffffff
  if (ix <= 0x3fe921fb) return kernelCos(x, 0)
  if (ix >= 0x7ff00000) return NaN
  switch (remPio2(x) & 3) {
    case 0: return kernelCos(y0, y1)
    case 1: return -kernelSin(y0, y1, 1)
    case 2: return -kernelCos(y0, y1)
    default: return kernelSin(y0, y1, 1)
  }
}

export function detTan(x: number): number {
  return detSin(x) / detCos(x)
}

// --- atan, atan2 (s_atan.c, e_atan2.c) --------------------------------------

const ATAN_HI = [4.63647609000806093515e-01, 7.85398163397448278999e-01, 9.82793723247329054082e-01, 1.57079632679489655800e+00]
const ATAN_LO = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17]
const AT0 = 3.33333333333329318027e-01
const AT1 = -1.99999999998764832476e-01
const AT2 = 1.42857142725034663711e-01
const AT3 = -1.11111104054623557880e-01
const AT4 = 9.09088713343650656196e-02
const AT5 = -7.69187620504482999495e-02
const AT6 = 6.66107313738753120669e-02
const AT7 = -5.83357013379057348645e-02
const AT8 = 4.97687799461593236017e-02
const AT9 = -3.65315727442169155270e-02
const AT10 = 1.62858201153657823623e-02

export function detAtan(x: number): number {
  const hx = high(x)
  const ix = hx & 0x7fffffff
  let id: number
  if (ix >= 0x44100000) {
    if (ix > 0x7ff00000 || (ix === 0x7ff00000 && low(x) !== 0)) return x + x
    return hx > 0 ? ATAN_HI[3] + ATAN_LO[3] : -ATAN_HI[3] - ATAN_LO[3]
  }
  if (ix < 0x3fdc0000) {
    if (ix < 0x3e200000) return x
    id = -1
  } else {
    x = Math.abs(x)
    if (ix < 0x3ff30000) {
      if (ix < 0x3fe60000) {
        id = 0
        x = (2 * x - 1) / (2 + x)
      } else {
        id = 1
        x = (x - 1) / (x + 1)
      }
    } else if (ix < 0x40038000) {
      id = 2
      x = (x - 1.5) / (1 + 1.5 * x)
    } else {
      id = 3
      x = -1 / x
    }
  }
  const z = x * x
  const w = z * z
  const s1 = z * (AT0 + w * (AT2 + w * (AT4 + w * (AT6 + w * (AT8 + w * AT10)))))
  const s2 = w * (AT1 + w * (AT3 + w * (AT5 + w * (AT7 + w * AT9))))
  if (id < 0) return x - x * (s1 + s2)
  const r = ATAN_HI[id] - ((x * (s1 + s2) - ATAN_LO[id]) - x)
  return hx < 0 ? -r : r
}

const TINY = 1.0e-300
const PI_O_4 = 7.8539816339744827900e-01
const PI_O_2 = 1.5707963267948965580e+00
const PI = 3.1415926535897931160e+00
const PI_LO = 1.2246467991473531772e-16

export function detAtan2(y: number, x: number): number {
  const hx = high(x)
  const ix = hx & 0x7fffffff
  const lx = low(x)
  const hy = high(y)
  const iy = hy & 0x7fffffff
  const ly = low(y)
  if (x !== x || y !== y) return x + y
  if (((hx - 0x3ff00000) | lx) === 0) return detAtan(y)
  const m = ((hy >>> 31) & 1) | ((hx >>> 30) & 2)
  if ((iy | ly) === 0) {
    if (m <= 1) return y
    return m === 2 ? PI + TINY : -PI - TINY
  }
  if ((ix | lx) === 0) return hy < 0 ? -PI_O_2 - TINY : PI_O_2 + TINY
  if (ix === 0x7ff00000) {
    if (iy === 0x7ff00000) {
      switch (m) {
        case 0: return PI_O_4 + TINY
        case 1: return -PI_O_4 - TINY
        case 2: return 3 * PI_O_4 + TINY
        default: return -3 * PI_O_4 - TINY
      }
    }
    switch (m) {
      case 0: return 0
      case 1: return -0
      case 2: return PI + TINY
      default: return -PI - TINY
    }
  }
  if (iy === 0x7ff00000) return hy < 0 ? -PI_O_2 - TINY : PI_O_2 + TINY
  const k = (iy - ix) >> 20
  let z: number
  if (k > 60) z = PI_O_2 + 0.5 * PI_LO
  else if (hx < 0 && k < -60) z = 0
  else z = detAtan(Math.abs(y / x))
  switch (m) {
    case 0: return z
    case 1: return -z
    case 2: return PI - (z - PI_LO)
    default: return (z - PI_LO) - PI
  }
}

export function detAsin(x: number): number {
  if (x > 1 || x < -1) return NaN
  return detAtan2(x, Math.sqrt((1 - x) * (1 + x)))
}

export function detAcos(x: number): number {
  if (x > 1 || x < -1) return NaN
  return detAtan2(Math.sqrt((1 - x) * (1 + x)), x)
}

// --- derived ------------------------------------------------------------------

// x^y. Integer exponents by repeated squaring (exact for 0, ±1 and 2, the
// common ones), 0.5 as sqrt, any other as exp(y · log x).
export function detPow(x: number, y: number): number {
  if (y === 0) return 1
  if (y === 0.5 && x >= 0) return Math.sqrt(x)
  if (Number.isInteger(y) && Math.abs(y) <= 1024) {
    let n = Math.abs(y)
    let base = x
    let r = 1
    while (n > 0) {
      if (n & 1) r *= base
      n = Math.floor(n / 2)
      if (n > 0) base *= base
    }
    return y < 0 ? 1 / r : r
  }
  if (x !== x || y !== y) return NaN
  if (x === 0) return y > 0 ? 0 : Infinity
  if (x < 0) return NaN
  if (x === Infinity) return y > 0 ? Infinity : 0
  return detExp(y * detLog(x))
}

export function detLog2(x: number): number {
  return detLog(x) * Math.LOG2E
}

export function detHypot(x: number, y: number, z = 0): number {
  return Math.sqrt(x * x + y * y + z * z)
}

export function sq(x: number): number {
  return x * x
}
