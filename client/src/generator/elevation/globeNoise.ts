import { smoothstep } from '../core/interpolation'
import { CALIBRATION_METRES_AROUND, type Domain, type GlobeFrame } from '../core/domain'

// THE COORDINATE NOISE ON THE SPHERE (DEC-0035, fork 1): the 3D analogue of
// the periodic 2D value noise in ridgedNoise.ts (and the engine's
// domain_warp.rs and hypsometry.rs). A sphere world samples its noise at the point's position
// on the globe (Domain.noise, a GlobeNoise), not at its chart coordinates:
// in the chart the 2D lattice is stretched east-west by 1 / cos φ toward a
// pole, and at a pole every x names the same point but met a different
// lattice cell. In 3D the field is isotropic, has no seam at the longitude
// wrap, and has one value at each pole.
//
// The same construction as the 2D lattices: an integer hash at each lattice
// corner, interpolated with smoothstep, here trilinearly over the eight
// corners of a cube. No period: the globe is closed, so the lattice needs
// none. Integer arithmetic only (Math.imul), the same bits in every engine.

// A lattice corner's value in [0, 1). The corners are combined by
// multiply and xor and then avalanched (murmur3's finaliser), so
// neighbouring corners and neighbouring seeds look unrelated.
function hashLatticePoint3(ix: number, iy: number, iz: number, seed: number): number {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ Math.imul(iz, 0x85ebca77) ^ seed
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

// The deviation from 0.5 is scaled by this to give the 3D noise the 2D
// noise's spread. Trilinear interpolation averages over three axes where
// bilinear averages over two, and each smoothstep-weighted axis keeps
// E[(1 − s)² + s²] = 52 / 70 of the corners' variance; the 3D noise's
// variance is therefore 52 / 70 of the 2D noise's, its standard deviation
// 0.862 of it. 1 / √(52 / 70) brings it back. The result is clamped to
// [0, 1], which the gain can rarely exceed (only beside a corner of extreme
// value). Measured (2026-10-10, 400 000 points): standard deviation 0.2131
// against the 2D noise's 0.2147, mean 0.5001, 0.7 % of the samples clamped.
const SPREAD_GAIN = 1 / Math.sqrt(52 / 70)

// Value noise in [0, 1] at lattice coordinates (x, y, z).
export function valueNoise3D(x: number, y: number, z: number, seed: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const z0 = Math.floor(z)
  const sx = smoothstep(x - x0)
  const sy = smoothstep(y - y0)
  const sz = smoothstep(z - z0)
  const x1 = x0 + 1
  const y1 = y0 + 1
  const z1 = z0 + 1
  const v000 = hashLatticePoint3(x0, y0, z0, seed)
  const v100 = hashLatticePoint3(x1, y0, z0, seed)
  const v010 = hashLatticePoint3(x0, y1, z0, seed)
  const v110 = hashLatticePoint3(x1, y1, z0, seed)
  const v001 = hashLatticePoint3(x0, y0, z1, seed)
  const v101 = hashLatticePoint3(x1, y0, z1, seed)
  const v011 = hashLatticePoint3(x0, y1, z1, seed)
  const v111 = hashLatticePoint3(x1, y1, z1, seed)
  const a0 = v000 + (v100 - v000) * sx
  const b0 = v010 + (v110 - v010) * sx
  const a1 = v001 + (v101 - v001) * sx
  const b1 = v011 + (v111 - v011) * sx
  const c0 = a0 + (b0 - a0) * sy
  const c1 = a1 + (b1 - a1) * sy
  const v = 0.5 + (c0 + (c1 - c0) * sz - 0.5) * SPREAD_GAIN
  return v < 0 ? 0 : v > 1 ? 1 : v
}

// The lattice turned against the globe by one fixed rotation. A value
// noise is not quite isotropic: it varies more along a lattice axis than
// along a diagonal. With the lattice's z axis on the globe's pole axis
// every latitude circle meets the lattice the same way, and at 60° the
// noise was 26 % rougher east-west than north-south (mean |difference|,
// measured 2026-10-10); turned off every axis of the globe, the directions
// mix along a circle and the two came within 2 %. The rotation is the unit
// quaternion (0.8, 0.3, 0.5, 0.2) normalised — no particular choice, only
// none of its axes near the pole's or the chart's — its matrix from exact
// operations.
const ROTATION = ((): number[] => {
  const n = Math.sqrt(0.8 * 0.8 + 0.3 * 0.3 + 0.5 * 0.5 + 0.2 * 0.2)
  const a = 0.8 / n
  const b = 0.3 / n
  const c = 0.5 / n
  const d = 0.2 / n
  return [
    a * a + b * b - c * c - d * d, 2 * (b * c - a * d), 2 * (b * d + a * c),
    2 * (b * c + a * d), a * a - b * b + c * c - d * d, 2 * (c * d - a * b),
    2 * (b * d - a * c), 2 * (c * d + a * b), a * a - b * b - c * c + d * d,
  ]
})()
const [R00, R01, R02, R10, R11, R12, R20, R21, R22] = ROTATION

// The noise of one octave at a point of the globe: the octave's lattice
// has `cellsX` cells across the chart's `width`, the same cell size in
// domain units as the 2D lattice's along the equator (its cells are square
// in the chart: width / cellsX = height / cellsY for every 2:1 table).
// The octave read at the torus's length in metres (DEC-0036 phase 8a): an
// octave table counts cells across the map, which on the torus meant
// CALIBRATION_METRES_AROUND / cellsX metres a cell; the sphere's lattice
// takes that length, not the count across its own equator (20 000 km,
// where the count made every noise feature 25 % larger). What every
// sphere sampler of a cells-across table calls.
export function globeOctaveOn(frame: GlobeFrame, cellsX: number, domain: Domain, seed: number): number {
  return globeOctave(frame, cellsX, (domain.width * CALIBRATION_METRES_AROUND) / domain.metresAround, seed)
}

export function globeOctave(frame: GlobeFrame, cellsX: number, width: number, seed: number): number {
  const scale = cellsX / width
  const x = frame.px * scale
  const y = frame.py * scale
  const z = frame.pz * scale
  return valueNoise3D(R00 * x + R01 * y + R02 * z, R10 * x + R11 * y + R12 * z, R20 * x + R21 * y + R22 * z, seed)
}
