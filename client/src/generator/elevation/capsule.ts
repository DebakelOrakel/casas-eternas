// THE CAPSULE FALLOFF — the one footprint a terrain feature has, shared by
// the three kernels that stack something on it: the elevation deck
// (elevationField.computeElevation), the uplift forcing (upliftField) and
// the erodibility field. It was written three times (BUG_BOUNTY 33), the
// first two with "CHANGE THE TWO TOGETHER" over them; merged 2026-09-22
// with the outputs hashed before and after on a real world.
//
// A feature is an oriented segment (± `halfLength` along its tangent);
// within it the nearest point is straight across, so the distance is the
// perpendicular offset — a narrow crest. Past an end the nearest point is
// that endpoint, so the distance grows radially — a rounded cap that stops
// the feature overshooting into open ocean. Smoothstep (3t² − 2t³) rather
// than a plain square: both have zero slope at the radius edge (no seam
// where the influence cuts off), but smoothstep also flattens near the
// crest, a rounder ridge profile.
export function capsuleWeight(
  offX: number,
  offY: number,
  tangentX: number,
  tangentY: number,
  halfLength: number,
  perpRadius: number,
): number {
  const along = offX * tangentX + offY * tangentY
  const across = -offX * tangentY + offY * tangentX
  const clamped = along < -halfLength ? -halfLength : along > halfLength ? halfLength : along
  const overshoot = along - clamped
  const distance = Math.sqrt(overshoot * overshoot + across * across)
  if (distance >= perpRadius) return 0
  const falloff = 1 - distance / perpRadius
  return falloff * falloff * (3 - 2 * falloff)
}
