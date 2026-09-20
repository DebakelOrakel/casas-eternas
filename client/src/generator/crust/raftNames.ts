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
export const CONTINENT_MIN_LAND_SHARE = 0.05

// The one rule for "is this big enough to be called a continent". Callers supply the
// areas in whatever unit they can afford — only the ratio is used. finalizeArchean
// measures real land off the coastline, because it runs once; splitDisconnectedRafts
// runs every epoch and uses summed blob area instead. That asymmetry is deliberate and
// the reason this predicate is shared: the THRESHOLD must not drift even where the
// measurement has to be cheaper.
export function deservesContinentName(area: number, totalArea: number): boolean {
  return totalArea > 0 && area / totalArea >= CONTINENT_MIN_LAND_SHARE
}

// Names the continents: every raft big enough to be one, from the shared pool.
// The largest is always named even if it falls under the bar, because a world with no
// named continent at all reads as a bug rather than as a world of islands.
//
// `areas` are LAND areas, measured off the rendered coastline by the caller. They used
// to be computed here as the sum of blob radii squared, which is not land area at all:
// a lone blob's coastline sits at 0.458 of its radius, so r² over-counts it about
// fivefold — and unevenly, because overlapping blobs push their shared coastline
// outward and lose less. The bias therefore depended on how many blobs a raft had, and
// it ran the wrong way, favouring small single-blob rafts over large clusters.
export function assignRaftNames(rafts: Raft[], random: () => number, areas: number[]): Raft[] {
  const total = areas.reduce((a, b) => a + b, 0)
  const largest = areas.reduce((best, area, i) => (area > areas[best] ? i : best), 0)
  const deserves = (i: number): boolean => i === largest || deservesContinentName(areas[i], total)

  const pool = [...CONTINENT_NAME_POOL]
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  let next = 0
  return rafts.map((raft, i) => ({ ...raft, name: deserves(i) && next < pool.length ? pool[next++] : null }))
}
