import { Vector3 } from '@babylonjs/core'
import { randomUnitVector } from './sphere'

// Cheap domain-warp noise (a handful of sine "octaves" with random
// directions/frequencies/phases, summed per axis) applied to the query
// point before every Voronoi/elevation lookup in texture.ts. Without
// this, coastlines are literally raw Voronoi cell edges — straight
// geodesic polygon lines, since continental/oceanic assignment comes
// straight from the A2 substrate's nearest-seed partition with no
// organic detail added to the boundary itself (confirmed directly: saved
// checkpoint renders at epoch 0/10/50/150/300 all showed dead-straight
// polygon edges, never softening into anything coastline-like). A few
// sine terms is enough to break that up without a full lattice-based
// Perlin/value noise implementation.
interface NoiseOctave {
  direction: Vector3
  frequency: number
  phase: number
  amplitude: number
}

export interface CoastlineNoiseField {
  axisX: NoiseOctave[]
  axisY: NoiseOctave[]
  axisZ: NoiseOctave[]
}

const OCTAVE_COUNT = 4
// "Frequency" is the number of sine half-cycles across the sphere along
// the octave's own random direction (dot(point, direction) ranges over
// [-1, 1]) — not tied to texel count, so this stays a fixed geographic
// detail scale independent of texture resolution.
const BASE_FREQUENCY = 2.5
const FREQUENCY_MULTIPLIER = 2.2
const AMPLITUDE_MULTIPLIER = 0.5

function buildAxisOctaves(rng: () => number, baseAmplitude: number): NoiseOctave[] {
  const octaves: NoiseOctave[] = []
  let frequency = BASE_FREQUENCY
  let amplitude = baseAmplitude
  for (let i = 0; i < OCTAVE_COUNT; i++) {
    octaves.push({ direction: randomUnitVector(rng), frequency, phase: rng() * Math.PI * 2, amplitude })
    frequency *= FREQUENCY_MULTIPLIER
    amplitude *= AMPLITUDE_MULTIPLIER
  }
  return octaves
}

// baseAmplitude is tuned relative to average plate spacing by the caller
// (see crust.ts) — a fixed constant here wouldn't scale with continent
// count/land-ocean ratio the way the rest of generation does.
export function buildCoastlineNoiseField(rng: () => number, baseAmplitude: number): CoastlineNoiseField {
  return {
    axisX: buildAxisOctaves(rng, baseAmplitude),
    axisY: buildAxisOctaves(rng, baseAmplitude),
    axisZ: buildAxisOctaves(rng, baseAmplitude),
  }
}

function sampleAxis(point: Vector3, octaves: NoiseOctave[]): number {
  let sum = 0
  for (const octave of octaves) {
    sum += Math.sin(Vector3.Dot(point, octave.direction) * octave.frequency + octave.phase) * octave.amplitude
  }
  return sum
}

// Displaces `point` by the noise field and renormalizes back onto the
// unit sphere, writing into `out` (a scratch vector reused by callers to
// avoid allocating per texel).
export function warpPoint(point: Vector3, field: CoastlineNoiseField, out: Vector3): void {
  out.set(
    point.x + sampleAxis(point, field.axisX),
    point.y + sampleAxis(point, field.axisY),
    point.z + sampleAxis(point, field.axisZ),
  )
  out.normalize()
}
