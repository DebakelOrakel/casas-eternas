import type { PlateType } from './plateTypes'

// Curated name pool for this world's continents — plain data, kept
// separate from the assignment logic below so the list itself can be
// edited/extended without touching any simulation code.
export const CONTINENT_NAME_POOL: readonly string[] = [
  'Vaeloria',
  'Thrennach',
  'Kaldrun',
  'Ossenmire',
  "Thal'Ryn",
  'Vhaelor',
  'Drenmoor',
  'Sylvaneth',
  'Korveth',
  'Ashkaram',
  'Meridask',
  'Voltheris',
  'Brennacor',
  'Ithralon',
  'Zephyrun',
  'Calduvane',
  'Morvethiel',
  'Tanraeth',
  'Ecliphar',
  'Drossenheim',
  'Auravik',
  'Kesmarune',
  'Velmirath',
  'Thornagul',
  'Malvorn',
  'Ostrellun',
  'Faerundun',
  'Grimwathe',
  'Solenkar',
  'Nythrivane',
]

// Randomly gives each continental plate a unique name from the pool
// (oceanic plates get none) via the same seeded random stream as the
// rest of generation, so a given seed always reproduces the same names —
// same Fisher-Yates-then-take-first pattern as assignPlateTypes.
//
// The pool only has finitely many names (30). CONTINENTAL_COUNT_MAX in
// WorldGenScreen.ts is 17, comfortably under that, but this doesn't
// defend against a future continental count exceeding the pool size —
// plates beyond the 30th simply come back unnamed rather than erroring
// or repeating a name.
export function assignContinentNames(types: PlateType[], random: () => number): (string | null)[] {
  const pool = [...CONTINENT_NAME_POOL]
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  let nextNameIndex = 0
  return types.map((type) => {
    if (type !== 'continental') return null
    if (nextNameIndex >= pool.length) return null
    return pool[nextNameIndex++]
  })
}
