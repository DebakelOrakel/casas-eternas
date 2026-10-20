//! The module test of `det_math` against the TypeScript engine's
//! `core/detMath.ts`: every value bit-equal (docs/decisions/rust-engine.md,
//! fork 5). The fixture is written by `engine/scripts/detMathFixture.mjs`;
//! the argument generator below is that script's, line for line.

use casas_engine::core::det_math::*;
use casas_engine::core::js::to_int32;

const FIXTURE: &str = include_str!("fixtures/det_math.txt");
const CANONICAL_NAN: u64 = 0x7ff8_0000_0000_0000;

fn bits(v: f64) -> u64 {
    if v.is_nan() {
        CANONICAL_NAN
    } else {
        v.to_bits()
    }
}

fn parse(word: &str) -> f64 {
    if word == "nan" {
        return f64::NAN;
    }
    f64::from_bits(u64::from_str_radix(word, 16).expect("a hex word"))
}

fn same(a: f64, b: f64) -> bool {
    bits(a) == bits(b)
}

/// The script's argument generator: a 32-bit LCG.
struct Args(u32);

impl Args {
    fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_mul(1664525).wrapping_add(1013904223);
        self.0
    }
    fn uniform(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * (self.next() as f64 / 4294967296.0)
    }
    fn any_bits(&mut self) -> f64 {
        let hi = self.next() as u64;
        f64::from_bits((hi << 32) | self.next() as u64)
    }
    fn positive_bits(&mut self) -> f64 {
        let hi = (self.next() & 0x7fff_ffff) as u64;
        f64::from_bits((hi << 32) | self.next() as u64)
    }
}

type Sample = fn(&mut Args) -> f64;

/// The script's SETS, in its order: the index is the seed.
const SETS: &[(&str, Sample)] = &[
    ("exp_uniform", |a| det_exp(a.uniform(-760.0, 760.0))),
    ("exp_bits", |a| det_exp(a.any_bits())),
    ("log_uniform", |a| det_log(a.uniform(0.0, 50.0))),
    ("log_bits", |a| det_log(a.any_bits())),
    ("sin_small", |a| det_sin(a.uniform(-20.0, 20.0))),
    ("sin_large", |a| det_sin(a.uniform(-8e5, 8e5))),
    ("sin_bits", |a| det_sin(a.any_bits())),
    ("cos_small", |a| det_cos(a.uniform(-20.0, 20.0))),
    ("cos_large", |a| det_cos(a.uniform(-8e5, 8e5))),
    ("cos_bits", |a| det_cos(a.any_bits())),
    ("tan_small", |a| det_tan(a.uniform(-20.0, 20.0))),
    ("atan_uniform", |a| det_atan(a.uniform(-5.0, 5.0))),
    ("atan_bits", |a| det_atan(a.any_bits())),
    ("atan2_uniform", |a| {
        let y = a.uniform(-20.0, 20.0);
        det_atan2(y, a.uniform(-20.0, 20.0))
    }),
    ("atan2_bits", |a| {
        let y = a.any_bits();
        det_atan2(y, a.any_bits())
    }),
    ("asin_uniform", |a| det_asin(a.uniform(-1.2, 1.2))),
    ("acos_uniform", |a| det_acos(a.uniform(-1.2, 1.2))),
    ("pow_uniform", |a| {
        let x = a.uniform(0.0, 50.0);
        det_pow(x, a.uniform(-5.0, 5.0))
    }),
    ("pow_integer", |a| {
        let x = a.uniform(-10.0, 10.0);
        det_pow(x, a.uniform(-20.0, 21.0).floor())
    }),
    ("pow_bits", |a| {
        let x = a.any_bits();
        det_pow(x, a.any_bits())
    }),
    ("log2_bits", |a| det_log2(a.positive_bits())),
    ("hypot2_uniform", |a| {
        let x = a.uniform(-1e3, 1e3);
        det_hypot(x, a.uniform(-1e3, 1e3))
    }),
    ("hypot3_uniform", |a| {
        let x = a.uniform(-1e3, 1e3);
        let y = a.uniform(-1e3, 1e3);
        det_hypot3(x, y, a.uniform(-1e3, 1e3))
    }),
];

fn fnv(mut h: u32, v: f64) -> u32 {
    let b = bits(v);
    h = (h ^ b as u32).wrapping_mul(0x0100_0193);
    (h ^ (b >> 32) as u32).wrapping_mul(0x0100_0193)
}

#[test]
fn special_arguments_give_the_typescript_bits() {
    let mut failures = Vec::new();
    let mut count = 0;
    for line in FIXTURE.lines().filter(|l| l.starts_with("case ")) {
        let words: Vec<&str> = line.split_whitespace().collect();
        let eq = words.iter().position(|w| *w == "=").expect("a case has =");
        let args: Vec<f64> = words[2..eq].iter().map(|w| parse(w)).collect();
        let want = parse(words[eq + 1]);
        let got = match (words[1], args.as_slice()) {
            ("exp", [x]) => det_exp(*x),
            ("log", [x]) => det_log(*x),
            ("sin", [x]) => det_sin(*x),
            ("cos", [x]) => det_cos(*x),
            ("tan", [x]) => det_tan(*x),
            ("atan", [x]) => det_atan(*x),
            ("asin", [x]) => det_asin(*x),
            ("acos", [x]) => det_acos(*x),
            ("log2", [x]) => det_log2(*x),
            ("atan2", [y, x]) => det_atan2(*y, *x),
            ("pow", [x, y]) => det_pow(*x, *y),
            ("hypot2", [x, y]) => det_hypot(*x, *y),
            _ => panic!("unknown case: {line}"),
        };
        count += 1;
        if !same(got, want) {
            failures.push(format!("{line}, got {:016x}", bits(got)));
        }
    }
    assert!(count > 1000, "the fixture has {count} cases");
    assert!(
        failures.is_empty(),
        "{} of {count} differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn sample_sets_give_the_typescript_hashes() {
    let mut failures = Vec::new();
    let bulk: Vec<&str> = FIXTURE.lines().filter(|l| l.starts_with("bulk ")).collect();
    assert_eq!(
        bulk.len(),
        SETS.len(),
        "the fixture and the test list other sets"
    );
    for (index, ((name, sample), line)) in SETS.iter().zip(bulk).enumerate() {
        let words: Vec<&str> = line.split_whitespace().collect();
        assert_eq!(words[1], *name, "the sets are in another order");
        let n: u32 = words[2].parse().unwrap();
        let mut args = Args(index as u32 + 1);
        let mut h = 0x811c_9dc5;
        for _ in 0..n {
            h = fnv(h, sample(&mut args));
        }
        if format!("{h:08x}") != words[3] {
            failures.push(format!("{name}: {h:08x}, TypeScript {}", words[3]));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// The hash `npm run harness:mesh` holds (scripts/mesh.mjs, DET_MATH_HASH),
/// made the harness's way: its own generator, in double arithmetic.
#[test]
fn the_harness_hash() {
    let mut seed = 7.0_f64;
    let mut rnd = || {
        seed = (seed * 1103515245.0 + 12345.0) % 2147483648.0;
        seed / 2147483648.0
    };
    let mut h = 0x811c_9dc5;
    for _ in 0..20000 {
        let mut u = |lo: f64, hi: f64| lo + (hi - lo) * rnd();
        let (a, b, p, q) = (u(-20.0, 20.0), u(-20.0, 20.0), u(0.0, 50.0), u(-1.0, 1.0));
        for v in [
            det_exp(a),
            det_log(p),
            det_sin(a),
            det_cos(a),
            det_tan(q),
            det_atan2(a, b),
            det_asin(q),
            det_acos(q),
            det_pow(p, b / 10.0),
            det_hypot(a, b),
        ] {
            h = fnv(h, v);
        }
    }
    assert_eq!(format!("{h:08x}"), "dadf96b6");
}

#[test]
fn to_int32_wraps_as_javascript_does() {
    assert_eq!(to_int32(2147483648.0), -2147483648);
    assert_eq!(to_int32(4294967297.5), 1);
    assert_eq!(to_int32(-1.9), -1);
    assert_eq!(to_int32(-4294967297.0), -1);
    assert_eq!(to_int32(f64::NAN), 0);
    assert_eq!(to_int32(f64::INFINITY), 0);
}
