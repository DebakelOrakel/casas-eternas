// Flat-torus analog of a real tectonic plate's Euler-pole rotation, stored in a
// RIGID-BODY form: a drift (translation) plus a spin (rotation about the plate's
// own centroid). This is equivalent to a single Euler pole — a rotation about an
// offset center decomposes exactly into rotation-about-centroid + a constant
// drift — but it's the form the future mantle-field coupling needs (a net flow
// under a plate fits cleanly to drift+spin, whereas migrating a single pole does
// not). See docs/decisions/evolving-euler-poles.md. For now the motion is still
// generated once and fixed for the plate's life; the field-driven update comes in
// Phase M2. Rotating about a *shared* center was considered and rejected (only
// concentric shear, not independent convergent/divergent/transform boundaries).
//
// ON THE SPHERE (DEC-0035, step 4d3) a rigid motion of the surface IS one
// rotation about an axis through the centre, and the plates move as such:
// `EulerMotion`, an Euler pole (a unit vector in the globe's frame,
// Domain.noise.frame) and an angular rate about it. The torus keeps the
// drift + spin form above (`RigidMotion`), its data and its arithmetic
// untouched. One type for both, `PlateMotion`; the functions below are the
// interface the rest of tectonics uses (the velocity at a point, a point
// moved forward and back, a motion fitted to the mantle flow, relaxed
// toward one, or made to move with a velocity at a point), and each one
// tells the two forms apart by the motion's own fields (isEulerMotion) —
// a sphere world holds only Euler motions, a torus world only rigid ones.
export type PlateMotion = RigidMotion | EulerMotion

// THE UNITS (DEC-0036 phase 8f): a velocity is in domain units per Ma
// (the tectonic epoch is TECTONIC_MA_PER_EPOCH Ma), and a turn in radians
// per Ma. The speeds the tuning states are km/Myr (= mm/yr) and are read
// through `domain.metresPerUnit`, so a plate moves as far in metres on the
// sphere as on the torus. Until 8f a velocity was per "unit of spin
// angle", an abstract time an epoch took 0.05 of, in domain units — 25 %
// further in metres on the sphere.
export interface RigidMotion {
  // Translation, domain units per Ma — the velocity a point AT the
  // centroid has.
  driftX: number
  driftY: number
  // Signed angular speed about (centroidX, centroidY), radians per Ma:
  // direction (sign) + rate.
  spin: number
  // The plate's reference point the spin turns about (its seed at generation).
  // Fixed — velocity is invariant to this choice since drift compensates.
  centroidX: number
  centroidY: number
}

// A plate's motion on the sphere: the rotation about the unit axis
// (poleX, poleY, poleZ) — the Euler pole, in the globe's frame, where
// Domain.noise.frame puts a point — at `rate` radians per Ma (so a
// velocity ω × r is in domain units per Ma, like the torus's drift, and
// an epoch is a turn by rate · its Ma). Right-handed about the pole,
// rate ≥ 0: a motion at rest keeps its last pole and has rate 0.
export interface EulerMotion {
  poleX: number
  poleY: number
  poleZ: number
  rate: number
}
