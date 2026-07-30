import type { Raft } from './raftTypes'
import { CONTINENT_NAME_POOL } from './continentNames'

// Naming continents. Rafts, not plates, are the continents, so this is keyed to
// them — see continentNames.ts for the pool itself.

export function pickUnusedRaftName(rafts: Raft[], random: () => number): string | null {
  const used = new Set(rafts.map((raft) => raft.name).filter((name): name is string => name !== null))
  const available = CONTINENT_NAME_POOL.filter((name) => !used.has(name))
  if (available.length === 0) return null
  return available[Math.floor(random() * available.length)]
}

// A raft must hold at least this share of all continental crust to be called a
// continent and given a name.
//
// It used to name every raft in the list, which is why a world read as having
// seventeen continents: measured at a typical stopping point, twelve of those
// seventeen landmasses held between 1% and 5% of the land each. They are islands, and
// naming them made the map — and the collision events, which quote the names — claim
// otherwise.
//
// 5% is Australia's share of Earth's land (5.2%), so "continent" here means "Australia
// or bigger", and Greenland (1.5%) comes out an island exactly as it does on a real
// map. At the stopping point above this leaves five names instead of seventeen, and
// later in the run two or three.
const CONTINENT_MIN_LAND_SHARE = 0.05

// Summed blob area, which over-counts a raft whose blobs overlap heavily — but it
// over-counts every raft the same way, and this is only ever used as a RATIO against
// the total. Rasterising the real coastline would be exact and would drag the
// elevation model into what should be a bookkeeping decision.
function raftArea(raft: Raft): number {
  return raft.blobs.reduce((sum, blob) => sum + blob.radius * blob.radius, 0)
}

// Names the continents: every raft big enough to be one, from the shared pool.
// The largest is always named even if it falls under the bar, because a world with no
// named continent at all reads as a bug rather than as a world of islands.
export function assignRaftNames(rafts: Raft[], random: () => number): Raft[] {
  const areas = rafts.map(raftArea)
  const total = areas.reduce((a, b) => a + b, 0)
  const largest = areas.reduce((best, area, i) => (area > areas[best] ? i : best), 0)
  const deserves = (i: number): boolean => i === largest || (total > 0 && areas[i] / total >= CONTINENT_MIN_LAND_SHARE)

  const pool = [...CONTINENT_NAME_POOL]
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  let next = 0
  return rafts.map((raft, i) => ({ ...raft, name: deserves(i) && next < pool.length ? pool[next++] : null }))
}
