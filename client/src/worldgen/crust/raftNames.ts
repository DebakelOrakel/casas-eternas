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

// Gives each raft a unique name from the shared pool — same shuffle-then-
// take pattern as assignContinentNames, but keyed to rafts (continents)
// rather than plates.
export function assignRaftNames(rafts: Raft[], random: () => number): Raft[] {
  const pool = [...CONTINENT_NAME_POOL]
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return rafts.map((raft, i) => ({ ...raft, name: i < pool.length ? pool[i] : null }))
}
