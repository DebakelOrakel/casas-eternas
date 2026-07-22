export type PlateType = 'oceanic' | 'continental'

export const PlateType = {
  Oceanic: 'oceanic',
  Continental: 'continental',
} as const

// Randomly designates `continentalCount` of the plates as continental
// (the rest oceanic), via the same seeded random stream as the rest of
// generation — so a given seed + continental-plate count always
// reproduces the same assignment. Plain Fisher-Yates shuffle of plate
// indices, first continentalCount win continental status: a random
// subset, no spatial preference (size, position, etc.) factored in yet.
export function assignPlateTypes(plateCount: number, continentalCount: number, random: () => number): PlateType[] {
  const indices = Array.from({ length: plateCount }, (_, i) => i)
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[indices[i], indices[j]] = [indices[j], indices[i]]
  }
  const continentalIndices = new Set(indices.slice(0, continentalCount))
  return Array.from({ length: plateCount }, (_, i) => (continentalIndices.has(i) ? PlateType.Continental : PlateType.Oceanic))
}
