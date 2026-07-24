import type { PlateType } from './plateTypes'

// Curated name pool for this world's continents — plain data, kept
// separate from the assignment logic below so the list itself can be
// edited/extended without touching any simulation code.
export const CONTINENT_NAME_POOL: readonly string[] = [
  'Vaeloria',
  'Thrennach',
  'Kaldrun',
  'Ossenmire',
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
  'Quorvanth',
  'Nissendral',
  'Harkovane',
  'Embrilis',
  'Talvorune',
  'Cindrathal',
  'Mosqueval',
  'Rethnadir',
  'Ulvangrim',
  'Serendayl',
  'Athkarune',
  'Pellisar',
  'Vhorenna',
  'Drakaneth',
  'Ithlorune',
  'Cassivane',
  'Bornethral',
  'Myrkovane',
  'Quellisar',
  'Nardrethal',
  'Ashendrune',
  'Velkorath',
  'Sarumendi',
  'Ithracoril',
  'Kovendrash',
  'Trelvanor',
  'Anduvellis',
  'Krissandel',
  'Ombrathil',
  'Vaskarune',
]

// Randomly gives each continental plate a unique name from the pool
// (oceanic plates get none) via the same seeded random stream as the
// rest of generation, so a given seed always reproduces the same names —
// a Fisher-Yates shuffle of the pool, then take names in order for the
// continental plates.
//
// This is a compat shim from the pre-raft model (names belong to rafts
// now — see assignRaftNames in rafts.ts); it survives only while the
// per-plate continentNames bridge does. The pool has finitely many names
// (30); if more continental plates than that ever exist, the extras come
// back unnamed rather than erroring or repeating a name.
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
