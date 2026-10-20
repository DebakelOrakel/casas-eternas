// Writes the module test fixture for the engine's det_math: the values the
// TypeScript engine's core/detMath.ts computes, which the Rust port must
// give bit for bit (docs/decisions/rust-engine.md, fork 5).
//
//   node engine/scripts/detMathFixture.mjs           write the fixture
//   node engine/scripts/detMathFixture.mjs --check   fail if it is stale
//                                                    (make lint)
//
// The fixture has two parts. `case` lines hold the special arguments with
// their results, so a failure names the argument. `bulk` lines hold a hash of
// many results per sample set; the argument generator below is written the
// same way in crates/casas-engine/tests/det_math.rs, so both sides make the
// same arguments. Change one, change the other.
//
// A NaN is written as `nan` and hashed as the canonical NaN: the bits of a
// NaN differ between JS runtimes, and only that it is a NaN is the result.

import { readFileSync, writeFileSync } from 'node:fs'
import * as D from '../../client/src/generator/core/detMath.ts'

const OUT = new URL('../crates/casas-engine/tests/fixtures/det_math.txt', import.meta.url)
const BULK = 100000

const f = new Float64Array(1)
const w = new Uint32Array(f.buffer)
const hex = (v) => {
  if (v !== v) return 'nan'
  f[0] = v
  return w[1].toString(16).padStart(8, '0') + w[0].toString(16).padStart(8, '0')
}
const fromWords = (hi, lo) => {
  w[1] = hi >>> 0
  w[0] = lo >>> 0
  return f[0]
}

// The argument generator: a 32-bit LCG and three ways to make a double.
let state = 0
const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0)
const uniform = (lo, hi) => lo + (hi - lo) * (next() / 4294967296)
const anyBits = () => {
  const hi = next()
  return fromWords(hi, next())
}
const positiveBits = () => {
  const hi = next() & 0x7fffffff
  return fromWords(hi, next())
}

// One sample set: a name, the function, the arguments. The seed is the set's
// index, so a set added at the end does not move the others.
const SETS = [
  ['exp uniform', (a) => D.detExp(a[0]), () => [uniform(-760, 760)]],
  ['exp bits', (a) => D.detExp(a[0]), () => [anyBits()]],
  ['log uniform', (a) => D.detLog(a[0]), () => [uniform(0, 50)]],
  ['log bits', (a) => D.detLog(a[0]), () => [anyBits()]],
  ['sin small', (a) => D.detSin(a[0]), () => [uniform(-20, 20)]],
  ['sin large', (a) => D.detSin(a[0]), () => [uniform(-8e5, 8e5)]],
  ['sin bits', (a) => D.detSin(a[0]), () => [anyBits()]],
  ['cos small', (a) => D.detCos(a[0]), () => [uniform(-20, 20)]],
  ['cos large', (a) => D.detCos(a[0]), () => [uniform(-8e5, 8e5)]],
  ['cos bits', (a) => D.detCos(a[0]), () => [anyBits()]],
  ['tan small', (a) => D.detTan(a[0]), () => [uniform(-20, 20)]],
  ['atan uniform', (a) => D.detAtan(a[0]), () => [uniform(-5, 5)]],
  ['atan bits', (a) => D.detAtan(a[0]), () => [anyBits()]],
  ['atan2 uniform', (a) => D.detAtan2(a[0], a[1]), () => [uniform(-20, 20), uniform(-20, 20)]],
  ['atan2 bits', (a) => D.detAtan2(a[0], a[1]), () => [anyBits(), anyBits()]],
  ['asin uniform', (a) => D.detAsin(a[0]), () => [uniform(-1.2, 1.2)]],
  ['acos uniform', (a) => D.detAcos(a[0]), () => [uniform(-1.2, 1.2)]],
  ['pow uniform', (a) => D.detPow(a[0], a[1]), () => [uniform(0, 50), uniform(-5, 5)]],
  ['pow integer', (a) => D.detPow(a[0], a[1]), () => [uniform(-10, 10), Math.floor(uniform(-20, 21))]],
  ['pow bits', (a) => D.detPow(a[0], a[1]), () => [anyBits(), anyBits()]],
  ['log2 bits', (a) => D.detLog2(a[0]), () => [positiveBits()]],
  ['hypot2 uniform', (a) => D.detHypot(a[0], a[1]), () => [uniform(-1e3, 1e3), uniform(-1e3, 1e3)]],
  ['hypot3 uniform', (a) => D.detHypot(a[0], a[1], a[2]), () => [uniform(-1e3, 1e3), uniform(-1e3, 1e3), uniform(-1e3, 1e3)]],
]

const SPECIAL = [
  0, -0, 1, -1, 0.5, -0.5, 2, 3, 10, 0.1, 1e-300, -1e-300, 5e-324, -5e-324, 2.2250738585072014e-308,
  1.7976931348623157e308, -1.7976931348623157e308, Infinity, -Infinity, NaN,
  Math.PI, -Math.PI, Math.PI / 2, -Math.PI / 2, Math.PI / 4, 3 * Math.PI / 4, 2 * Math.PI, 1e6, -1e6, 1e22,
  709.782712893384, 709.79, -745.1332191019411, -745.14, 1e-8, 0.34657359027997264, 1.0397207708399179,
]
// The pairs for the two-argument functions: the signs, the zeros, the
// infinities, NaN and a few ordinary values.
const SPECIAL2 = [0, -0, 1, -1, 0.5, -2, 3, 1e-300, 5e-324, 1e300, Infinity, -Infinity, NaN, Math.PI, 1e22, -0.75]
const CASES = [
  ['exp', (a) => D.detExp(a[0]), 1],
  ['log', (a) => D.detLog(a[0]), 1],
  ['sin', (a) => D.detSin(a[0]), 1],
  ['cos', (a) => D.detCos(a[0]), 1],
  ['tan', (a) => D.detTan(a[0]), 1],
  ['atan', (a) => D.detAtan(a[0]), 1],
  ['asin', (a) => D.detAsin(a[0]), 1],
  ['acos', (a) => D.detAcos(a[0]), 1],
  ['log2', (a) => D.detLog2(a[0]), 1],
  ['atan2', (a) => D.detAtan2(a[0], a[1]), 2],
  ['pow', (a) => D.detPow(a[0], a[1]), 2],
  ['hypot2', (a) => D.detHypot(a[0], a[1]), 2],
]

const lines = [
  '# The values of client/src/generator/core/detMath.ts, for crates/casas-engine/tests/det_math.rs.',
  '# Written by engine/scripts/detMathFixture.mjs; do not edit.',
]
for (const [name, fn, arity] of CASES) {
  if (arity === 1) {
    for (const x of SPECIAL) lines.push(`case ${name} ${hex(x)} = ${hex(fn([x]))}`)
  } else {
    for (const x of SPECIAL2) for (const y of SPECIAL2) lines.push(`case ${name} ${hex(x)} ${hex(y)} = ${hex(fn([x, y]))}`)
  }
}
SETS.forEach(([name, fn, args], index) => {
  state = index + 1
  let h = 0x811c9dc5
  for (let i = 0; i < BULK; i++) {
    const v = fn(args())
    if (v !== v) fromWords(0x7ff80000, 0)
    else f[0] = v
    h = Math.imul(h ^ w[0], 0x01000193) >>> 0
    h = Math.imul(h ^ w[1], 0x01000193) >>> 0
  }
  lines.push(`bulk ${name.replace(' ', '_')} ${BULK} ${h.toString(16).padStart(8, '0')}`)
})
const text = lines.join('\n') + '\n'
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('engine/crates/casas-engine/tests/fixtures/det_math.txt is stale — run node engine/scripts/detMathFixture.mjs')
    process.exit(1)
  }
} else {
  writeFileSync(OUT, text)
  console.log(`det_math fixture: ${lines.length - 2} lines → ${OUT.pathname}`)
}
