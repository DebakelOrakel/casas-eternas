// Interpolation and easing shared across generator. `smoothstep` had five
// independent definitions (domainWarp, rafts, elevationScale, ridgedNoise,
// ecologyField) in two signatures — the same four characters of arithmetic
// rewritten each time a module needed it.
//
// Both signatures are kept rather than collapsed into one: the bare `smoothstep`
// is the ease applied to an already-normalised 0..1 fraction (noise cell
// interpolation, profile segments), and `smoothstepBetween` is the threshold-band
// form (map a value across two edges, then ease). Forcing every caller through
// the three-argument version would just make the common case noisier.

export function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t
}

// The classic 3t² − 2t³ ease. Zero derivative at both ends, which is what makes
// it seamless where cells or segments meet — and, as elevationScale.marginProfile
// found out the hard way, also what makes it a poor choice for a control point
// you need a non-zero slope through.
export function smoothstep(t: number): number {
  return t * t * (3 - 2 * t)
}

// Eased transition across a threshold band: 0 at or below `edge0`, 1 at or above
// `edge1`, smoothstepped between.
export function smoothstepBetween(edge0: number, edge1: number, x: number): number {
  return smoothstep(Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0))))
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}
